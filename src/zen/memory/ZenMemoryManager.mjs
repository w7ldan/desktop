// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as ZenMemoryPolicy from "resource:///modules/zen/memory/ZenMemoryPolicy.mjs";

if (!ZenMemoryPolicy || !ZenMemoryPolicy.DEFAULTS) {
  throw new Error("gZenMemoryManager: ZenMemoryPolicy module failed to load.");
}

const PREF_BRANCH = "zen.memory.";
const LEGACY_TIMEOUT_PREF = "zen.tab-unloader.timeout-minutes";

const PREFS = {
  enabled: `${PREF_BRANCH}enabled`,
  mode: `${PREF_BRANCH}mode`,
  idleTimeoutMinutes: `${PREF_BRANCH}idle-timeout-minutes`,
  earlyUnloadEnabled: `${PREF_BRANCH}early-unload-enabled`,
  includePinned: `${PREF_BRANCH}include-pinned`,
  includeEssentials: `${PREF_BRANCH}include-essentials`,
  exemptHosts: `${PREF_BRANCH}exempt-hosts`,
  ramBudgetMB: `${PREF_BRANCH}ram-budget-mb`,
  reopenCooldownSeconds: `${PREF_BRANCH}reopen-cooldown-seconds`,
  maxDiscardsPerSweep: `${PREF_BRANCH}max-discards-per-sweep`,
  sweepIntervalSeconds: `${PREF_BRANCH}sweep-interval-seconds`,
  experimentalSleep: `${PREF_BRANCH}experimental-sleep`,
};

const ELEVATED_HOLD_MS = 5 * 60 * 1000;
const MAX_RECENT_DECISIONS = 25;
const MAX_REVISIT_COUNT = 50;

class nsZenMemoryManager {
  #started = false;
  #disposed = false;
  #sweepTimer = null;
  #sweepInFlight = false;
  #pressure = "normal";
  #elevatedUntil = 0;
  #tabState = new WeakMap();
  #totalAutoDiscards = 0;
  #deadlineDiscards = 0;
  #earlyDiscards = 0;
  #lastSweepAt = 0;
  #recentDecisions = [];
  #residentMB = null;
  #nowOverride = null;

  constructor() {
    this._onTabSelect = this._onTabSelect.bind(this);
    this._onTabOpen = this._onTabOpen.bind(this);
    this._onTabClose = this._onTabClose.bind(this);
    this._onTabRestored = this._onTabRestored.bind(this);
    this._onWindowUnload = this._onWindowUnload.bind(this);
    this._onSweepTimer = this._onSweepTimer.bind(this);
    this._onPrefChanged = this._onPrefChanged.bind(this);
    this._deferredStart = this._deferredStart.bind(this);

    if (typeof window !== "undefined" && window && window.addEventListener) {
      window.addEventListener("unload", this._onWindowUnload, { once: true });
    }
    this._deferredStart();
  }

  _deferredStart() {
    try {
      if (
        typeof window !== "undefined" &&
        window.gZenStartup &&
        window.gZenStartup.promiseInitialized
      ) {
        window.gZenStartup.promiseInitialized.then(() => {
          this.start();
        });
        return;
      }
    } catch {}
    try {
      if (
        typeof Services !== "undefined" &&
        Services.obs &&
        typeof window !== "undefined"
      ) {
        const observer = (subject, topic) => {
          if (
            topic === "browser-delayed-startup-finished" &&
            subject === window
          ) {
            Services.obs.removeObserver(observer, topic);
            this.start();
          }
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
        return;
      }
    } catch {}
    this.start();
  }

  get started() {
    return this.#started;
  }

  _now() {
    if (this.#nowOverride !== null) {
      return this.#nowOverride;
    }
    return Date.now();
  }

  readConfig() {
    const policy = ZenMemoryPolicy;
    if (!policy || !policy.DEFAULTS) {
      throw new Error(
        "gZenMemoryManager: ZenMemoryPolicy module failed to load."
      );
    }
    const getBool = (prefName, fallback) => {
      try {
        return Services.prefs.getBoolPref(prefName, fallback);
      } catch {
        return fallback;
      }
    };
    const getInt = (prefName, fallback) => {
      try {
        return Services.prefs.getIntPref(prefName, fallback);
      } catch {
        return fallback;
      }
    };
    const getString = (prefName, fallback) => {
      try {
        return Services.prefs.getStringPref(prefName, fallback);
      } catch {
        return fallback;
      }
    };
    let idleTimeoutMinutes = getInt(
      PREFS.idleTimeoutMinutes,
      policy.DEFAULTS.idleTimeoutMinutes
    );
    try {
      if (
        Services.prefs.getPrefType(PREFS.idleTimeoutMinutes) ===
          Services.prefs.PREF_INVALID &&
        Services.prefs.getPrefType(LEGACY_TIMEOUT_PREF) !==
          Services.prefs.PREF_INVALID
      ) {
        idleTimeoutMinutes = Services.prefs.getIntPref(
          LEGACY_TIMEOUT_PREF,
          idleTimeoutMinutes
        );
      }
    } catch {}
    return policy.normalizeConfig({
      enabled: getBool(PREFS.enabled, policy.DEFAULTS.enabled),
      mode: getString(PREFS.mode, policy.DEFAULTS.mode),
      idleTimeoutMinutes,
      earlyUnloadEnabled: getBool(
        PREFS.earlyUnloadEnabled,
        policy.presetForMode(
          policy.normalizeMode(getString(PREFS.mode, policy.DEFAULTS.mode))
        ).earlyUnloadEnabled
      ),
      includePinned: getBool(
        PREFS.includePinned,
        policy.presetForMode(
          policy.normalizeMode(getString(PREFS.mode, policy.DEFAULTS.mode))
        ).includePinned
      ),
      includeEssentials: getBool(
        PREFS.includeEssentials,
        policy.presetForMode(
          policy.normalizeMode(getString(PREFS.mode, policy.DEFAULTS.mode))
        ).includeEssentials
      ),
      exemptHosts: getString(PREFS.exemptHosts, ""),
      ramBudgetMB: getInt(PREFS.ramBudgetMB, policy.DEFAULTS.ramBudgetMB),
      reopenCooldownSeconds: getInt(
        PREFS.reopenCooldownSeconds,
        policy.DEFAULTS.reopenCooldownSeconds
      ),
      maxDiscardsPerSweep: getInt(
        PREFS.maxDiscardsPerSweep,
        policy.DEFAULTS.maxDiscardsPerSweep
      ),
      sweepIntervalSeconds: getInt(
        PREFS.sweepIntervalSeconds,
        policy.DEFAULTS.sweepIntervalSeconds
      ),
      experimentalSleep: getBool(
        PREFS.experimentalSleep,
        policy.DEFAULTS.experimentalSleep
      ),
    });
  }

  start() {
    if (this.#started || this.#disposed) {
      return;
    }
    if (typeof window === "undefined" || !window.gBrowser) {
      return;
    }
    this.#started = true;
    try {
      Services.prefs.addObserver(PREF_BRANCH, this._onPrefChanged);
      Services.obs.addObserver(this, "memory-pressure");
    } catch (ex) {
      console.error("gZenMemoryManager: failed to register observers", ex);
    }
    window.addEventListener("TabSelect", this._onTabSelect);
    window.addEventListener("TabOpen", this._onTabOpen);
    window.addEventListener("TabClose", this._onTabClose);
    window.addEventListener("SSTabRestored", this._onTabRestored);
    this._seedAllTabs();
    this._scheduleNextSweep();
  }

  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#started = false;
    if (this.#sweepTimer !== null) {
      clearTimeout(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    try {
      Services.prefs.removeObserver(PREF_BRANCH, this._onPrefChanged);
    } catch {}
    try {
      Services.obs.removeObserver(this, "memory-pressure");
    } catch {}
    try {
      window.removeEventListener("TabSelect", this._onTabSelect);
      window.removeEventListener("TabOpen", this._onTabOpen);
      window.removeEventListener("TabClose", this._onTabClose);
      window.removeEventListener("SSTabRestored", this._onTabRestored);
      window.removeEventListener("unload", this._onWindowUnload);
    } catch {}
  }

  observe(subject, topic, data) {
    if (topic !== "memory-pressure" || this.#disposed) {
      return;
    }
    const now = this._now();
    if (typeof data === "string" && data.startsWith("low-memory")) {
      this.#pressure = "critical";
      this.#elevatedUntil = now + ELEVATED_HOLD_MS;
      this.sweep({ reason: "memory-pressure-critical" });
      return;
    }
    this.#pressure = "elevated";
    this.#elevatedUntil = now + ELEVATED_HOLD_MS;
    this.sweep({ reason: "memory-pressure" });
  }

  _onWindowUnload() {
    this.dispose();
  }

  _onPrefChanged() {
    if (this.#disposed) {
      return;
    }
    this._scheduleNextSweep();
    const config = this.readConfig();
    if (!config.enabled && this.#sweepTimer !== null) {
      clearTimeout(this.#sweepTimer);
      this.#sweepTimer = null;
    }
  }

  _stateFor(tab) {
    let state = this.#tabState.get(tab);
    if (!state) {
      state = {
        lastActiveMs: this._now(),
        revisitCount: 0,
        reopenedAtMs: 0,
        lastDiscardMs: 0,
      };
      this.#tabState.set(tab, state);
    }
    return state;
  }

  _seedAllTabs() {
    const now = this._now();
    for (const tab of this._windowTabs()) {
      const state = this._stateFor(tab);
      state.lastActiveMs = now;
      if (tab.selected) {
        state.reopenedAtMs = now;
      }
    }
  }

  _windowTabs() {
    try {
      if (window.gZenWorkspaces && window.gZenWorkspaces.allStoredTabs) {
        return [...window.gZenWorkspaces.allStoredTabs];
      }
    } catch {}
    try {
      if (window.gBrowser && window.gBrowser.tabs) {
        return [...window.gBrowser.tabs];
      }
    } catch {}
    return [];
  }

  _onTabSelect(event) {
    const tab = event.target;
    if (!tab || tab.localName !== "tab") {
      return;
    }
    const now = this._now();
    const state = this._stateFor(tab);
    state.lastActiveMs = now;
    state.reopenedAtMs = now;
    state.revisitCount = Math.min(state.revisitCount + 1, MAX_REVISIT_COUNT);
  }

  _onTabOpen(event) {
    const tab = event.target;
    if (!tab || tab.localName !== "tab") {
      return;
    }
    const now = this._now();
    const state = this._stateFor(tab);
    state.lastActiveMs = now;
    state.reopenedAtMs = now;
  }

  _onTabClose(event) {
    const tab = event.target;
    if (!tab) {
      return;
    }
    this.#tabState.delete(tab);
  }

  _onTabRestored(event) {
    const tab = event.target;
    if (!tab || tab.localName !== "tab") {
      return;
    }
    const now = this._now();
    const state = this._stateFor(tab);
    if (tab.selected) {
      state.lastActiveMs = now;
      state.reopenedAtMs = now;
    }
  }

  _scheduleNextSweep() {
    if (this.#disposed) {
      return;
    }
    if (this.#sweepTimer !== null) {
      clearTimeout(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    let delayMs = 60 * 1000;
    try {
      const config = this.readConfig();
      delayMs = Math.max(15, config.sweepIntervalSeconds) * 1000;
      if (!config.enabled) {
        return;
      }
    } catch {}
    this.#sweepTimer = setTimeout(this._onSweepTimer, delayMs);
  }

  _onSweepTimer() {
    this.#sweepTimer = null;
    this.sweep({ reason: "interval" }).finally(() => {
      this._scheduleNextSweep();
    });
  }

  _isDiscarded(tab) {
    try {
      return !!(tab.discarded || tab.hasAttribute("pending"));
    } catch {
      return false;
    }
  }

  _snapshotTab(tab, config) {
    const state = this._stateFor(tab);
    const discarded = this._isDiscarded(tab);
    let host = "";
    let loading = false;
    let webrtc = false;
    let zenModeActive = false;
    if (!discarded) {
      try {
        host = tab.linkedBrowser?.currentURI?.host ?? "";
      } catch {
        host = "";
      }
      try {
        loading = tab.linkedBrowser?.webProgress?.isLoadingDocument === true;
      } catch {
        loading = false;
      }
      webrtc = this._tabHasWebRTC(tab);
      try {
        zenModeActive = !!tab.linkedBrowser?.zenModeActive;
      } catch {
        zenModeActive = false;
      }
    }
    const exempted = discarded
      ? false
      : ZenMemoryPolicy.hostIsExempt(
          host || this._tabSpec(tab),
          config.exemptHosts
        );
    return ZenMemoryPolicy.snapshotWith({
      selected: !!tab.selected,
      discarded,
      emptyTab: tab.hasAttribute("zen-empty-tab"),
      privateWindow: this._isPrivateWindow(),
      loading,
      soundPlaying: !!(tab.soundPlaying || tab.hasAttribute("soundplaying")),
      pictureInPicture: tab.hasAttribute("pictureinpicture"),
      webrtc,
      glance: this._tabIsGlance(tab),
      splitActive: this._tabInActiveSplit(tab),
      zenModeActive,
      pinned: !!tab.pinned,
      essential: tab.hasAttribute("zen-essential"),
      exempted,
      lastActiveMs: state.lastActiveMs,
      revisitCount: state.revisitCount,
      inactiveWorkspace: this._tabInInactiveWorkspace(tab),
      reopenedAtMs: state.reopenedAtMs,
      lastDiscardMs: state.lastDiscardMs,
    });
  }

  _tabSpec(tab) {
    if (this._isDiscarded(tab)) {
      return "";
    }
    try {
      return tab.linkedBrowser?.currentURI?.spec ?? "";
    } catch {
      return "";
    }
  }

  _isPrivateWindow() {
    try {
      return !!window.PrivateBrowsingUtils?.isWindowPrivate(window);
    } catch {
      return false;
    }
  }

  _tabHasWebRTC(tab) {
    if (this._isDiscarded(tab)) {
      return false;
    }
    try {
      const browser = tab.linkedBrowser;
      if (!browser) {
        return false;
      }
      if (window.webrtcUI?.browserHasStreams?.(browser)) {
        return true;
      }
      return !!browser.browsingContext?.currentWindowGlobal?.hasActivePeerConnections?.();
    } catch {
      return false;
    }
  }

  _tabIsGlance(tab) {
    try {
      if (tab.hasAttribute("zen-glance-tab") || tab.hasAttribute("glance-id")) {
        return true;
      }
      if (tab.getAttribute("glance-id")) {
        return true;
      }
      const manager = window.gZenGlanceManager;
      if (manager && manager.getTabOrGlanceParent) {
        const glanceParent = manager.getTabOrGlanceParent(tab);
        if (glanceParent && glanceParent !== tab) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  _tabInActiveSplit(tab) {
    try {
      const group = tab.group;
      if (group?.hasAttribute("split-view-group")) {
        return true;
      }
      if (tab.hasAttribute("split-view")) {
        return true;
      }
    } catch {}
    return false;
  }

  _tabInInactiveWorkspace(tab) {
    try {
      const workspaces = window.gZenWorkspaces;
      if (!workspaces || !workspaces.workspaceEnabled) {
        return false;
      }
      const id = tab.getAttribute("zen-workspace-id");
      if (!id) {
        return false;
      }
      return id !== workspaces.activeWorkspace;
    } catch {
      return false;
    }
  }

  _readResidentMB() {
    try {
      const manager = Services.appinfo?.QueryInterface
        ? Cc["@mozilla.org/memory-reporter-manager;1"].getService(
            Ci.nsIMemoryReporterManager
          )
        : null;
      if (manager && typeof manager.residentFast === "number") {
        return manager.residentFast / 1048576;
      }
    } catch {}
    return null;
  }

  _effectivePressure(config, now) {
    let level = "normal";
    if (now < this.#elevatedUntil) {
      level = this.#pressure === "critical" ? "critical" : "elevated";
    } else if (this.#pressure !== "normal") {
      this.#pressure = "normal";
    }
    if (config.ramBudgetMB > 0) {
      this.#residentMB = this._readResidentMB();
      if (this.#residentMB !== null) {
        const budgetLevel = ZenMemoryPolicy.budgetPressureLevel(
          this.#residentMB,
          config.ramBudgetMB,
          level === "critical" || level === "elevated" ? level : "normal"
        );
        if (budgetLevel === "critical") {
          return "critical";
        }
        if (budgetLevel === "elevated") {
          return "elevated";
        }
      }
    }
    return level;
  }

  async sweep(_options = {}) {
    if (this.#sweepInFlight || this.#disposed) {
      return { swept: false, discarded: 0 };
    }
    this.#sweepInFlight = true;
    try {
      return await this._sweepInner(_options);
    } finally {
      this.#sweepInFlight = false;
    }
  }

  async _sweepInner(_options = {}) {
    const now = this._now();
    const config = this.readConfig();
    this.#lastSweepAt = now;
    if (!config.enabled) {
      return { swept: true, discarded: 0, reason: "disabled" };
    }
    if (typeof window === "undefined" || !window.gBrowser) {
      return { swept: false, discarded: 0 };
    }

    const pressure = this._effectivePressure(config, now);
    const earlyArmed =
      config.earlyUnloadEnabled &&
      (pressure === "elevated" || pressure === "critical");
    const earlyContext = earlyArmed
      ? {
          armed: true,
          reason:
            pressure === "critical"
              ? "memory-pressure-critical"
              : "memory-pressure",
        }
      : null;

    const tabs = this._windowTabs();
    const deadline = [];
    const early = [];
    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index];
      if (!tab || tab.closing) {
        continue;
      }
      const snapshot = this._snapshotTab(tab, config);
      const verdict = ZenMemoryPolicy.isEligible(
        snapshot,
        config,
        now,
        earlyContext
      );
      if (!verdict.eligible) {
        continue;
      }
      if (verdict.kind === "deadline") {
        deadline.push({ index, tab, snapshot });
      } else {
        early.push({ index, tab, snapshot });
      }
    }

    let discarded = 0;
    if (deadline.length) {
      const batch = deadline.slice(0, config.maxDiscardsPerSweep);
      discarded += await this._discardBatch(batch, "idle-deadline", now);
    }
    if (early.length && earlyContext) {
      const sorted = ZenMemoryPolicy.sortCandidates(early, now);
      const batch = ZenMemoryPolicy.selectForEarlyUnload(
        sorted,
        pressure === "critical"
          ? config.maxDiscardsPerSweep
          : Math.max(1, Math.floor(config.maxDiscardsPerSweep / 2))
      );
      discarded += await this._discardBatch(batch, earlyContext.reason, now);
      if (pressure === "critical") {
        this.#pressure = "elevated";
      }
    }
    return {
      swept: true,
      discarded,
      deadlineCandidates: deadline.length,
      earlyCandidates: early.length,
      pressure,
    };
  }

  async _discardBatch(candidates, reason, now) {
    const live = candidates
      .map(entry => entry.tab)
      .filter(tab => tab && !tab.closing && !tab.selected);
    if (live.length === 0) {
      return 0;
    }
    const hosts = new Map();
    for (const tab of live) {
      hosts.set(tab, this._tabSpec(tab));
    }
    let confirmed = 0;
    try {
      await window.gBrowser.explicitUnloadTabs(live);
      for (const tab of live) {
        const unloaded = this._isDiscarded(tab);
        if (unloaded) {
          confirmed += 1;
          const state = this._stateFor(tab);
          state.lastDiscardMs = now;
        }
        this._recordDecision(
          tab,
          hosts.get(tab),
          reason,
          unloaded ? "discarded" : "blocked",
          now
        );
      }
    } catch (ex) {
      console.error("gZenMemoryManager: discard batch failed", ex);
      for (const tab of live) {
        this._recordDecision(tab, hosts.get(tab), reason, "error", now);
      }
    }
    this.#totalAutoDiscards += confirmed;
    if (reason === "idle-deadline") {
      this.#deadlineDiscards += confirmed;
    } else {
      this.#earlyDiscards += confirmed;
    }
    return confirmed;
  }

  summarizeSweep(earlyContext = null) {
    const now = this._now();
    const config = this.readConfig();
    const pressure = this._effectivePressure(config, now);
    const armed =
      config.earlyUnloadEnabled &&
      (pressure === "elevated" || pressure === "critical");
    const early =
      earlyContext ??
      (armed
        ? {
            armed: true,
            reason:
              pressure === "critical"
                ? "memory-pressure-critical"
                : "memory-pressure",
          }
        : null);
    const tabs = [];
    for (const tab of this._windowTabs()) {
      let snapshot = null;
      let verdict = { eligible: false, reason: "snapshot-failed" };
      try {
        snapshot = this._snapshotTab(tab, config);
        verdict = ZenMemoryPolicy.isEligible(snapshot, config, now, early);
      } catch (ex) {
        verdict = {
          eligible: false,
          reason: `snapshot-error:${ex?.message ?? ex}`,
        };
      }
      let host = "";
      let selected = false;
      let pending = false;
      try {
        pending = this._isDiscarded(tab);
        if (!pending) {
          host = tab.linkedBrowser?.currentURI?.spec ?? "";
        }
        selected = !!tab.selected;
      } catch {}
      tabs.push({
        host,
        selected,
        pending,
        pinned: snapshot?.pinned ?? null,
        essential: snapshot?.essential ?? null,
        loading: snapshot?.loading ?? null,
        emptyTab: snapshot?.emptyTab ?? null,
        lastActiveMs: snapshot?.lastActiveMs ?? null,
        eligible: verdict.eligible,
        reason: verdict.reason,
        kind: verdict.kind ?? null,
      });
    }
    return { pressure, earlyArmed: armed, tabCount: tabs.length, tabs };
  }

  _recordDecision(tab, host, reason, outcome, now) {
    let shortHost = "";
    try {
      const spec = String(host ?? "");
      const withoutScheme = spec.includes("://")
        ? spec.slice(spec.indexOf("://") + 3)
        : spec;
      shortHost = withoutScheme.split("/")[0] ?? "";
    } catch {
      shortHost = "";
    }
    this.#recentDecisions.unshift({
      at: now,
      host: shortHost,
      reason,
      outcome,
    });
    if (this.#recentDecisions.length > MAX_RECENT_DECISIONS) {
      this.#recentDecisions.length = MAX_RECENT_DECISIONS;
    }
  }

  getDiagnostics() {
    const config = this.readConfig();
    let loadedTabs = 0;
    let discardedTabs = 0;
    try {
      for (const tab of this._windowTabs()) {
        if (this._isDiscarded(tab)) {
          discardedTabs += 1;
        } else {
          loadedTabs += 1;
        }
      }
    } catch {}
    return {
      enabled: config.enabled,
      mode: config.mode,
      idleTimeoutMinutes: config.idleTimeoutMinutes,
      earlyUnloadEnabled: config.earlyUnloadEnabled,
      pressure: this.#pressure,
      residentParentMB:
        this.#residentMB === null
          ? null
          : Math.round(this.#residentMB * 10) / 10,
      residentNote:
        "Parent-process resident only (lower bound). Per-tab bytes cannot be " +
        "precisely attributed because tabs share content processes.",
      loadedTabs,
      discardedTabs,
      totalAutoDiscards: this.#totalAutoDiscards,
      deadlineDiscards: this.#deadlineDiscards,
      earlyDiscards: this.#earlyDiscards,
      approxBytesReclaimed: null,
      reclaimedNote:
        "Memory reclaimed is only reported when reliably measured; " +
        "discard counts are exact but byte savings are not claimed.",
      lastSweepAt: this.#lastSweepAt,
      recentDecisions: [...this.#recentDecisions],
      sleepSupported: false,
      sleepNote:
        "No supported Gecko content-freezing backend was found; tabs stay " +
        "loaded until discard. The scheduler keeps a hook for a future " +
        "genuine sleep backend.",
    };
  }

  maybeSleepTabs() {
    return { slept: 0, supported: false };
  }

  _testSetNow(ms) {
    this.#nowOverride = ms;
  }

  _testClearNow() {
    this.#nowOverride = null;
  }

  _testSetLastActive(tab, ms) {
    this._stateFor(tab).lastActiveMs = ms;
  }

  _testSetReopened(tab, ms) {
    this._stateFor(tab).reopenedAtMs = ms;
  }

  async _testSweep() {
    return this.sweep({ reason: "test" });
  }

  _testResetCounters() {
    this.#totalAutoDiscards = 0;
    this.#deadlineDiscards = 0;
    this.#earlyDiscards = 0;
    this.#recentDecisions = [];
    this.#pressure = "normal";
    this.#elevatedUntil = 0;
  }
}

window.gZenMemoryManager = new nsZenMemoryManager();
