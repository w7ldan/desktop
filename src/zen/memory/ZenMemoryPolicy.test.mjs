// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Pure-logic tests for the Zen Adaptive Memory Manager policy core.
// Runs without a browser: `node --test src/zen/memory/ZenMemoryPolicy.test.mjs`

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_THRESHOLDS,
  DEFAULTS,
  LIMITS,
  MODES,
  PRESSURE,
  blankSnapshot,
  budgetPressureLevel,
  hostIsExempt,
  isEligible,
  normalizeConfig,
  parseExemptHosts,
  presetForMode,
  scoreCandidate,
  selectForEarlyUnload,
  snapshotWith,
  sortCandidates,
} from "./ZenMemoryPolicy.mjs";

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

function idleTab(overrides = {}) {
  return snapshotWith({ lastActiveMs: NOW - 11 * MIN, ...overrides });
}

describe("normalizeConfig", () => {
  it("defaults to Strict 10-minute mode", () => {
    const cfg = normalizeConfig();
    assert.equal(cfg.mode, MODES.STRICT);
    assert.equal(cfg.idleTimeoutMinutes, 10);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.includePinned, true);
    assert.equal(cfg.includeEssentials, true);
    assert.equal(cfg.earlyUnloadEnabled, true);
    assert.equal(cfg.ramBudgetMB, 0);
  });

  it("applies Balanced and Performance presets", () => {
    const balanced = normalizeConfig({ mode: "balanced" });
    assert.equal(balanced.idleTimeoutMinutes, 45);
    assert.equal(balanced.includePinned, false);
    assert.equal(balanced.includeEssentials, false);

    const perf = normalizeConfig({ mode: "performance" });
    assert.equal(perf.idleTimeoutMinutes, 0);
    assert.equal(perf.earlyUnloadEnabled, false);
  });

  it("falls back to Strict for unknown modes", () => {
    assert.equal(normalizeConfig({ mode: "turbo" }).mode, MODES.STRICT);
    assert.equal(presetForMode("nope").idleTimeoutMinutes, 10);
  });

  it("clamps numeric inputs", () => {
    const cfg = normalizeConfig({
      idleTimeoutMinutes: 99999,
      reopenCooldownSeconds: -5,
      maxDiscardsPerSweep: 0,
      ramBudgetMB: -10,
    });
    assert.equal(cfg.idleTimeoutMinutes, LIMITS.idleTimeoutMinutes.max);
    assert.equal(cfg.reopenCooldownSeconds, LIMITS.reopenCooldownSeconds.min);
    assert.equal(cfg.maxDiscardsPerSweep, LIMITS.maxDiscardsPerSweep.min);
    assert.equal(cfg.ramBudgetMB, 0);
  });

  it("parses exempt hosts", () => {
    assert.deepEqual(parseExemptHosts("Example.com, sub.test.org ,, "), [
      "example.com",
      "sub.test.org",
    ]);
    assert.deepEqual(parseExemptHosts(["A.com", "b.com"]), ["a.com", "b.com"]);
  });
});

describe("isEligible deadline behavior", () => {
  const strict = normalizeConfig();

  it("keeps a recent background tab loaded", () => {
    const tab = snapshotWith({ lastActiveMs: NOW - 2 * MIN });
    const result = isEligible(tab, strict, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "recently-active");
  });

  it("discards an idle background tab at the 10-minute deadline", () => {
    const result = isEligible(idleTab(), strict, NOW);
    assert.equal(result.eligible, true);
    assert.equal(result.kind, "deadline");
    assert.equal(result.reason, "idle-deadline");
  });

  it("treats the deadline as exact at 10 minutes", () => {
    const atDeadline = snapshotWith({ lastActiveMs: NOW - 10 * MIN });
    assert.equal(isEligible(atDeadline, strict, NOW).eligible, true);
    const justBefore = snapshotWith({ lastActiveMs: NOW - 10 * MIN + 1000 });
    assert.equal(isEligible(justBefore, strict, NOW).eligible, false);
  });

  it("never auto-discards the selected tab", () => {
    const tab = idleTab({ selected: true });
    const result = isEligible(tab, strict, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "selected");
  });

  it("restarts the timer when the tab becomes active", () => {
    const tab = idleTab({ lastActiveMs: NOW - 30 * 1000 });
    assert.equal(isEligible(tab, strict, NOW).eligible, false);
  });

  it("still applies the deadline to frequently revisited tabs", () => {
    const tab = idleTab({ revisitCount: 50 });
    const result = isEligible(tab, strict, NOW);
    assert.equal(result.eligible, true);
    assert.equal(result.kind, "deadline");
  });

  it("skips already-discarded tabs", () => {
    assert.equal(
      isEligible(idleTab({ discarded: true }), strict, NOW).reason,
      "already-discarded"
    );
  });

  it("stops when the manager is disabled", () => {
    const cfg = normalizeConfig({ enabled: false });
    assert.equal(isEligible(idleTab(), cfg, NOW).eligible, false);
  });

  it("disables time-based unloading in Performance mode", () => {
    const perf = normalizeConfig({ mode: "performance" });
    const result = isEligible(idleTab(), perf, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "time-unload-disabled");
  });
});

describe("isEligible protections", () => {
  const strict = normalizeConfig();

  const cases = [
    ["media", { soundPlaying: true }],
    ["media", { pictureInPicture: true }],
    ["webrtc", { webrtc: true }],
    ["glance", { glance: true }],
    ["active-content", { splitActive: true }],
    ["active-content", { zenModeActive: true }],
    ["exempted", { exempted: true }],
    ["empty-tab", { emptyTab: true }],
    ["private-window", { privateWindow: true }],
    ["reopened-cooldown", { reopenedAtMs: NOW - 10 * 1000 }],
    ["discard-cooldown", { lastDiscardMs: NOW - 10 * 1000 }],
  ];

  for (const [reason, override] of cases) {
    it(`protects tabs with reason ${reason}`, () => {
      const result = isEligible(idleTab(override), strict, NOW);
      assert.equal(result.eligible, false);
      assert.equal(result.reason, reason);
    });
  }

  it("follows the pinned policy", () => {
    const tab = idleTab({ pinned: true });
    assert.equal(isEligible(tab, strict, NOW).eligible, true);
    const noPinned = normalizeConfig({ includePinned: false });
    assert.equal(isEligible(tab, noPinned, NOW).reason, "pinned-excluded");
  });

  it("follows the Essentials policy", () => {
    const tab = idleTab({ essential: true, pinned: true });
    assert.equal(isEligible(tab, strict, NOW).eligible, true);
    const noEssentials = normalizeConfig({ includeEssentials: false });
    assert.equal(
      isEligible(tab, noEssentials, NOW).reason,
      "essential-excluded"
    );
  });

  it("expires the reopen cooldown", () => {
    const tab = idleTab({ reopenedAtMs: NOW - 121 * 1000 });
    assert.equal(isEligible(tab, strict, NOW).eligible, true);
  });

  it("keeps loading tabs deadline-eligible but deprioritized", () => {
    const loading = idleTab({ loading: true });
    const result = isEligible(loading, strict, NOW);
    assert.equal(result.eligible, true);
    assert.equal(result.kind, "deadline");
    const settled = idleTab({ loading: false });
    assert.ok(
      scoreCandidate(loading, NOW) > scoreCandidate(settled, NOW),
      "loading tabs sort after settled tabs for early discards"
    );
  });
});

describe("early unloading", () => {
  const strict = normalizeConfig();

  it("unloads a recent tab early when pressure is armed", () => {
    const tab = snapshotWith({ lastActiveMs: NOW - 3 * MIN });
    const armed = { armed: true, reason: "memory-pressure" };
    const result = isEligible(tab, strict, NOW, armed);
    assert.equal(result.eligible, true);
    assert.equal(result.kind, "early");
  });

  it("keeps recent tabs loaded without pressure", () => {
    const tab = snapshotWith({ lastActiveMs: NOW - 3 * MIN });
    assert.equal(isEligible(tab, strict, NOW, null).eligible, false);
    assert.equal(
      isEligible(tab, strict, NOW, { armed: false }).eligible,
      false
    );
  });

  it("does not unload early when early unloading is disabled", () => {
    const cfg = normalizeConfig({ earlyUnloadEnabled: false });
    const tab = snapshotWith({ lastActiveMs: NOW - 3 * MIN });
    const result = isEligible(tab, cfg, NOW, { armed: true });
    assert.equal(result.eligible, false);
  });

  it("prioritizes older, rarely revisited tabs in inactive workspaces", () => {
    const candidates = [
      {
        index: 0,
        snapshot: snapshotWith({
          lastActiveMs: NOW - 3 * MIN,
          revisitCount: 15,
        }),
      },
      {
        index: 1,
        snapshot: snapshotWith({
          lastActiveMs: NOW - 9 * MIN,
          revisitCount: 0,
          inactiveWorkspace: true,
        }),
      },
      {
        index: 2,
        snapshot: snapshotWith({
          lastActiveMs: NOW - 5 * MIN,
          revisitCount: 1,
        }),
      },
    ];
    const sorted = sortCandidates(candidates, NOW);
    assert.equal(sorted[0].index, 1);
    assert.equal(sorted[sorted.length - 1].index, 0);
  });

  it("deprioritizes pinned tabs for early discards without exempting them", () => {
    const plain = snapshotWith({ lastActiveMs: NOW - 5 * MIN });
    const pinned = snapshotWith({ lastActiveMs: NOW - 5 * MIN, pinned: true });
    assert.ok(scoreCandidate(pinned, NOW) > scoreCandidate(plain, NOW));
  });

  it("limits early discards per sweep", () => {
    const sorted = [0, 1, 2, 3].map(index => ({ index, snapshot: idleTab() }));
    assert.equal(selectForEarlyUnload(sorted, 2).length, 2);
    assert.deepEqual(selectForEarlyUnload(sorted, 0), []);
  });

  it("sorts deterministically", () => {
    const a = {
      index: 0,
      snapshot: snapshotWith({ lastActiveMs: NOW - 5 * MIN }),
    };
    const b = {
      index: 1,
      snapshot: snapshotWith({ lastActiveMs: NOW - 5 * MIN }),
    };
    const sorted = sortCandidates([b, a], NOW);
    assert.equal(sorted[0].index, 0);
    assert.equal(sorted[1].index, 1);
  });
});

describe("budget hysteresis", () => {
  it("escalates approaching the target and releases below exit levels", () => {
    assert.equal(budgetPressureLevel(100, 0, PRESSURE.NORMAL), PRESSURE.NORMAL);
    assert.equal(
      budgetPressureLevel(
        BUDGET_THRESHOLDS.elevatedEnter * 4096,
        4096,
        PRESSURE.NORMAL
      ),
      PRESSURE.ELEVATED
    );
    assert.equal(
      budgetPressureLevel(
        BUDGET_THRESHOLDS.criticalEnter * 4096,
        4096,
        PRESSURE.NORMAL
      ),
      PRESSURE.CRITICAL
    );
    assert.equal(
      budgetPressureLevel(
        BUDGET_THRESHOLDS.criticalExit * 4096 - 1,
        4096,
        PRESSURE.CRITICAL
      ),
      PRESSURE.ELEVATED
    );
    assert.equal(
      budgetPressureLevel(
        BUDGET_THRESHOLDS.elevatedExit * 4096 - 1,
        4096,
        PRESSURE.ELEVATED
      ),
      PRESSURE.NORMAL
    );
  });
});

describe("hostIsExempt", () => {
  it("matches exact hosts and subdomains", () => {
    assert.equal(
      hostIsExempt("https://mail.example.com/inbox", ["example.com"]),
      true
    );
    assert.equal(hostIsExempt("example.com:443", ["example.com"]), true);
    assert.equal(hostIsExempt("https://other.org/", ["example.com"]), false);
    assert.equal(
      hostIsExempt("https://notexample.com/", ["example.com"]),
      false
    );
    assert.equal(hostIsExempt("", ["example.com"]), false);
    assert.equal(hostIsExempt("https://example.com/", []), false);
  });
});

describe("blankSnapshot", () => {
  it("is ineligible-neutral and serializable", () => {
    const snap = blankSnapshot();
    assert.deepEqual({ ...snap }, JSON.parse(JSON.stringify(snap)));
    assert.deepEqual(
      Object.keys(snap).sort(),
      Object.keys(blankSnapshot()).sort()
    );
  });

  it("keeps DEFAULTS immutable across normalization", () => {
    normalizeConfig({ mode: "balanced", exemptHosts: "a.com" });
    assert.equal(DEFAULTS.mode, MODES.STRICT);
    assert.deepEqual(DEFAULTS.exemptHosts, []);
  });
});
