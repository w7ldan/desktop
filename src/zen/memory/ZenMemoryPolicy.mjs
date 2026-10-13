// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

export const MODES = {
  STRICT: "strict",
  BALANCED: "balanced",
  PERFORMANCE: "performance",
};

export const PRESSURE = {
  NORMAL: "normal",
  ELEVATED: "elevated",
  CRITICAL: "critical",
};

export const DEFAULTS = {
  enabled: true,
  mode: MODES.STRICT,
  idleTimeoutMinutes: 10,
  earlyUnloadEnabled: true,
  includePinned: true,
  includeEssentials: true,
  exemptHosts: [],
  ramBudgetMB: 0,
  reopenCooldownSeconds: 120,
  maxDiscardsPerSweep: 5,
  sweepIntervalSeconds: 60,
  experimentalSleep: false,
};

export const LIMITS = {
  idleTimeoutMinutes: { min: 0, max: 1440 },
  reopenCooldownSeconds: { min: 0, max: 3600 },
  maxDiscardsPerSweep: { min: 1, max: 50 },
  sweepIntervalSeconds: { min: 15, max: 3600 },
  ramBudgetMB: { min: 0, max: 131072 },
  maxExemptHosts: 100,
};

export function presetForMode(mode) {
  switch (mode) {
    case MODES.BALANCED:
      return {
        idleTimeoutMinutes: 45,
        earlyUnloadEnabled: true,
        includePinned: false,
        includeEssentials: false,
        ramBudgetMB: 0,
      };
    case MODES.PERFORMANCE:
      return {
        idleTimeoutMinutes: 0,
        earlyUnloadEnabled: false,
        includePinned: false,
        includeEssentials: false,
        ramBudgetMB: 0,
      };
    case MODES.STRICT:
    default:
      return {
        idleTimeoutMinutes: 10,
        earlyUnloadEnabled: true,
        includePinned: true,
        includeEssentials: true,
        ramBudgetMB: 0,
      };
  }
}

function clampInt(value, fallback, min, max) {
  const num = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const int = Math.floor(num);
  if (int < min) {
    return min;
  }
  if (int > max) {
    return max;
  }
  return int;
}

function toBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    if (lower === "true" || lower === "1") {
      return true;
    }
    if (lower === "false" || lower === "0") {
      return false;
    }
    return fallback;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return fallback;
}

export function parseExemptHosts(value) {
  const source = Array.isArray(value) ? value.join(",") : (value ?? "");
  return String(source)
    .split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length)
    .slice(0, LIMITS.maxExemptHosts);
}

export function normalizeMode(mode) {
  if (
    mode === MODES.STRICT ||
    mode === MODES.BALANCED ||
    mode === MODES.PERFORMANCE
  ) {
    return mode;
  }
  return MODES.STRICT;
}

export function normalizeConfig(raw = {}) {
  const mode = normalizeMode(raw.mode ?? DEFAULTS.mode);
  const preset = presetForMode(mode);
  return {
    enabled: toBool(raw.enabled, DEFAULTS.enabled),
    mode,
    idleTimeoutMinutes: clampInt(
      raw.idleTimeoutMinutes ?? preset.idleTimeoutMinutes,
      preset.idleTimeoutMinutes,
      LIMITS.idleTimeoutMinutes.min,
      LIMITS.idleTimeoutMinutes.max
    ),
    earlyUnloadEnabled: toBool(
      raw.earlyUnloadEnabled ?? preset.earlyUnloadEnabled,
      preset.earlyUnloadEnabled
    ),
    includePinned: toBool(
      raw.includePinned ?? preset.includePinned,
      preset.includePinned
    ),
    includeEssentials: toBool(
      raw.includeEssentials ?? preset.includeEssentials,
      preset.includeEssentials
    ),
    exemptHosts: parseExemptHosts(raw.exemptHosts ?? DEFAULTS.exemptHosts),
    ramBudgetMB: clampInt(
      raw.ramBudgetMB ?? DEFAULTS.ramBudgetMB,
      DEFAULTS.ramBudgetMB,
      LIMITS.ramBudgetMB.min,
      LIMITS.ramBudgetMB.max
    ),
    reopenCooldownSeconds: clampInt(
      raw.reopenCooldownSeconds ?? DEFAULTS.reopenCooldownSeconds,
      DEFAULTS.reopenCooldownSeconds,
      LIMITS.reopenCooldownSeconds.min,
      LIMITS.reopenCooldownSeconds.max
    ),
    maxDiscardsPerSweep: clampInt(
      raw.maxDiscardsPerSweep ?? DEFAULTS.maxDiscardsPerSweep,
      DEFAULTS.maxDiscardsPerSweep,
      LIMITS.maxDiscardsPerSweep.min,
      LIMITS.maxDiscardsPerSweep.max
    ),
    sweepIntervalSeconds: clampInt(
      raw.sweepIntervalSeconds ?? DEFAULTS.sweepIntervalSeconds,
      DEFAULTS.sweepIntervalSeconds,
      LIMITS.sweepIntervalSeconds.min,
      LIMITS.sweepIntervalSeconds.max
    ),
    experimentalSleep: toBool(
      raw.experimentalSleep,
      DEFAULTS.experimentalSleep
    ),
  };
}

export function blankSnapshot() {
  return {
    selected: false,
    discarded: false,
    emptyTab: false,
    privateWindow: false,
    loading: false,
    soundPlaying: false,
    pictureInPicture: false,
    webrtc: false,
    glance: false,
    splitActive: false,
    zenModeActive: false,
    pinned: false,
    essential: false,
    exempted: false,
    lastActiveMs: 0,
    revisitCount: 0,
    inactiveWorkspace: false,
    reopenedAtMs: 0,
    lastDiscardMs: 0,
  };
}

export function snapshotWith(overrides = {}) {
  return { ...blankSnapshot(), ...overrides };
}

export function idleMs(snapshot, nowMs) {
  const lastActive = Number(snapshot.lastActiveMs) || 0;
  return Math.max(0, nowMs - lastActive);
}

export function isEligible(snapshot, config, nowMs, earlyContext = null) {
  const tab = { ...blankSnapshot(), ...(snapshot ?? {}) };
  const cfg = config ?? normalizeConfig();

  if (!cfg.enabled) {
    return { eligible: false, reason: "manager-disabled" };
  }
  if (tab.selected) {
    return { eligible: false, reason: "selected" };
  }
  if (tab.discarded) {
    return { eligible: false, reason: "already-discarded" };
  }
  if (tab.emptyTab) {
    return { eligible: false, reason: "empty-tab" };
  }
  if (tab.privateWindow) {
    return { eligible: false, reason: "private-window" };
  }
  if (tab.soundPlaying || tab.pictureInPicture) {
    return { eligible: false, reason: "media" };
  }
  if (tab.webrtc) {
    return { eligible: false, reason: "webrtc" };
  }
  if (tab.glance) {
    return { eligible: false, reason: "glance" };
  }
  if (tab.splitActive || tab.zenModeActive) {
    return { eligible: false, reason: "active-content" };
  }
  if (tab.exempted) {
    return { eligible: false, reason: "exempted" };
  }
  if (tab.pinned && !cfg.includePinned) {
    return { eligible: false, reason: "pinned-excluded" };
  }
  if (tab.essential && !cfg.includeEssentials) {
    return { eligible: false, reason: "essential-excluded" };
  }

  const cooldownMs = cfg.reopenCooldownSeconds * 1000;
  if (
    cooldownMs > 0 &&
    Number(tab.reopenedAtMs) > 0 &&
    nowMs - Number(tab.reopenedAtMs) < cooldownMs
  ) {
    return { eligible: false, reason: "reopened-cooldown" };
  }
  if (
    cooldownMs > 0 &&
    Number(tab.lastDiscardMs) > 0 &&
    nowMs - Number(tab.lastDiscardMs) < cooldownMs
  ) {
    return { eligible: false, reason: "discard-cooldown" };
  }

  const timeoutMs = cfg.idleTimeoutMinutes * 60 * 1000;
  const idle = idleMs(tab, nowMs);
  if (timeoutMs > 0 && idle >= timeoutMs) {
    return { eligible: true, reason: "idle-deadline", kind: "deadline" };
  }

  if (
    cfg.earlyUnloadEnabled &&
    earlyContext &&
    earlyContext.armed === true &&
    idle > 0
  ) {
    return {
      eligible: true,
      reason: earlyContext.reason ?? "memory-pressure",
      kind: "early",
    };
  }

  if (timeoutMs <= 0) {
    return { eligible: false, reason: "time-unload-disabled" };
  }
  return { eligible: false, reason: "recently-active" };
}

export function scoreCandidate(snapshot, nowMs) {
  const tab = { ...blankSnapshot(), ...(snapshot ?? {}) };
  const idleMinutes = idleMs(tab, nowMs) / 60000;
  let score = 0;
  score -= idleMinutes;
  score += Math.min(Math.max(0, Number(tab.revisitCount) || 0), 20) * 2;
  if (tab.loading) {
    score += 8;
  }
  if (tab.inactiveWorkspace) {
    score -= 10;
  }
  if (tab.pinned) {
    score += 5;
  }
  if (tab.essential) {
    score += 5;
  }
  return score;
}

export function sortCandidates(snapshots, nowMs) {
  return [...snapshots].sort((a, b) => {
    const scoreDiff =
      scoreCandidate(a.snapshot, nowMs) - scoreCandidate(b.snapshot, nowMs);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    const idleDiff = idleMs(b.snapshot, nowMs) - idleMs(a.snapshot, nowMs);
    if (idleDiff !== 0) {
      return idleDiff;
    }
    return (a.index ?? 0) - (b.index ?? 0);
  });
}

export function selectForEarlyUnload(sortedCandidates, maxCount) {
  if (!Array.isArray(sortedCandidates) || maxCount <= 0) {
    return [];
  }
  return sortedCandidates.slice(0, maxCount);
}

export const BUDGET_THRESHOLDS = {
  elevatedEnter: 0.8,
  criticalEnter: 0.92,
  elevatedExit: 0.7,
  criticalExit: 0.85,
};

export function budgetPressureLevel(residentMB, budgetMB, current) {
  if (
    !Number.isFinite(residentMB) ||
    !Number.isFinite(budgetMB) ||
    budgetMB <= 0
  ) {
    return PRESSURE.NORMAL;
  }
  const ratio = residentMB / budgetMB;
  const level = current ?? PRESSURE.NORMAL;
  if (
    ratio >= BUDGET_THRESHOLDS.criticalEnter ||
    (level === PRESSURE.CRITICAL && ratio >= BUDGET_THRESHOLDS.criticalExit)
  ) {
    return PRESSURE.CRITICAL;
  }
  if (
    ratio >= BUDGET_THRESHOLDS.elevatedEnter ||
    (level === PRESSURE.ELEVATED && ratio >= BUDGET_THRESHOLDS.elevatedExit)
  ) {
    return PRESSURE.ELEVATED;
  }
  return PRESSURE.NORMAL;
}

export function hostIsExempt(urlOrHost, exemptHosts) {
  if (!urlOrHost || !Array.isArray(exemptHosts)) {
    return false;
  }
  let host = String(urlOrHost).trim().toLowerCase();
  const schemeEnd = host.indexOf("://");
  if (schemeEnd >= 0) {
    host = host.slice(schemeEnd + 3);
  }
  const pathStart = host.indexOf("/");
  if (pathStart >= 0) {
    host = host.slice(0, pathStart);
  }
  const portStart = host.indexOf(":");
  if (portStart >= 0) {
    host = host.slice(0, portStart);
  }
  if (!host) {
    return false;
  }
  for (const exempt of exemptHosts) {
    if (host === exempt || host.endsWith(`.${exempt}`)) {
      return true;
    }
  }
  return false;
}
