/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

function manager() {
  return window.gZenMemoryManager;
}

async function openBackgroundTab(
  url = "data:text/html,<title>pressure</title>"
) {
  const tab = BrowserTestUtils.addTab(gBrowser, url, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

function backdate(tab, ageMs = ELEVEN_MINUTES_MS) {
  manager()._testSetLastActive(tab, Date.now() - ageMs);
  manager()._testSetReopened(tab, 0);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.memory.enabled", true],
      ["zen.memory.idle-timeout-minutes", 10],
      ["zen.memory.early-unload-enabled", true],
      ["zen.memory.include-pinned", true],
      ["zen.memory.include-essentials", true],
      ["zen.memory.exempt-hosts", ""],
      ["zen.memory.ram-budget-mb", 0],
      ["zen.memory.reopen-cooldown-seconds", 120],
      ["zen.memory.max-discards-per-sweep", 5],
    ],
  });
  manager()._testResetCounters();
  registerCleanupFunction(async () => {
    manager()._testResetCounters();
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_memory_pressure_unloads_recent_tabs_early() {
  const recent = await openBackgroundTab();
  try {
    manager()._testSetLastActive(recent, Date.now() - 3 * 60 * 1000);
    manager()._testSetReopened(recent, 0);
    manager().observe(null, "memory-pressure", "low-memory");
    await TestUtils.waitForCondition(
      () => recent.hasAttribute("pending"),
      "Recent tab unloads early under critical memory pressure"
    );
    const diagnostics = manager().getDiagnostics();
    ok(diagnostics.earlyDiscards >= 1, "Early-discard counter increased");
  } finally {
    BrowserTestUtils.removeTab(recent);
  }
});

add_task(async function test_no_early_unload_without_pressure_signal() {
  const recent = await openBackgroundTab();
  try {
    manager()._testResetCounters();
    manager()._testSetLastActive(recent, Date.now() - 3 * 60 * 1000);
    manager()._testSetReopened(recent, 0);
    await manager()._testSweep();
    ok(
      !recent.hasAttribute("pending"),
      "Recent tab stays loaded without pressure"
    );
    const diagnostics = manager().getDiagnostics();
    is(diagnostics.earlyDiscards, 0, "No early discards recorded");
  } finally {
    BrowserTestUtils.removeTab(recent);
  }
});

add_task(async function test_early_unload_disabled_by_pref() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.early-unload-enabled", false]],
  });
  try {
    const recent = await openBackgroundTab();
    try {
      manager()._testSetLastActive(recent, Date.now() - 3 * 60 * 1000);
      manager()._testSetReopened(recent, 0);
      manager().observe(null, "memory-pressure", "low-memory");
      await manager()._testSweep();
      ok(
        !recent.hasAttribute("pending"),
        "Recent tab stays loaded when early unloading is disabled"
      );
    } finally {
      BrowserTestUtils.removeTab(recent);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_max_discards_per_sweep_caps_pressure_unloads() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.memory.max-discards-per-sweep", 2],
      ["zen.memory.reopen-cooldown-seconds", 0],
    ],
  });
  try {
    const tabs = [];
    try {
      for (let i = 0; i < 4; i++) {
        const tab = await openBackgroundTab();
        manager()._testSetLastActive(tab, Date.now() - 3 * 60 * 1000);
        manager()._testSetReopened(tab, 0);
        tabs.push(tab);
      }
      manager().observe(null, "memory-pressure", "heap-minimize");
      const result = await manager()._testSweep();
      ok(
        result.discarded <= 2,
        "Early unloads respect the per-sweep discard cap"
      );
    } finally {
      for (const tab of tabs) {
        if (tab && !tab.closing) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_strict_deadline_ignores_pressure_cap() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.memory.max-discards-per-sweep", 2],
      ["zen.memory.reopen-cooldown-seconds", 0],
      ["zen.memory.early-unload-enabled", false],
    ],
  });
  try {
    const tabs = [];
    try {
      for (let i = 0; i < 6; i++) {
        const tab = await openBackgroundTab();
        backdate(tab);
        tabs.push(tab);
      }
      const result = await manager()._testSweep();
      is(
        result.discarded,
        6,
        "Strict deadline clears all overdue tabs despite the pressure cap"
      );
      ok(
        (result.deadlineBatches ?? 0) >= 1,
        "Deadline processes in bounded batches"
      );
    } finally {
      for (const tab of tabs) {
        if (tab && !tab.closing) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_large_overdue_backlog_clears_promptly() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.memory.max-discards-per-sweep", 5],
      ["zen.memory.reopen-cooldown-seconds", 0],
      ["zen.memory.early-unload-enabled", false],
    ],
  });
  try {
    const tabs = [];
    try {
      for (let i = 0; i < 55; i++) {
        const tab = await openBackgroundTab();
        backdate(tab);
        tabs.push(tab);
      }
      const result = await manager()._testSweep();
      is(
        result.deadlineCandidates,
        55,
        "All 55 overdue tabs are candidates"
      );
      is(result.discarded, 55, "Large backlog clears in a single sweep");
      for (const tab of tabs) {
        ok(tab.hasAttribute("pending"), "Each overdue tab unloads");
      }
      const resweep = await manager()._testSweep();
      is(resweep.discarded, 0, "No duplicate unloading on resweep");
    } finally {
      for (const tab of tabs) {
        if (tab && !tab.closing) {
          BrowserTestUtils.removeTab(tab);
        }
      }
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_restored_tab_is_not_immediately_rediscarded() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.reopen-cooldown-seconds", 600]],
  });
  try {
    const tab = await openBackgroundTab();
    try {
      backdate(tab);
      await manager()._testSweep();
      ok(tab.hasAttribute("pending"), "Tab is discarded first");

      gBrowser.selectedTab = tab;
      await BrowserTestUtils.waitForEvent(tab, "SSTabRestored");
      manager()._testSetLastActive(tab, Date.now() - ELEVEN_MINUTES_MS);
      await manager()._testSweep();
      ok(
        !tab.hasAttribute("pending"),
        "Just-restored tab is protected by the reopen cooldown"
      );
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_multi_window_sweep_covers_all_windows() {
  // Disable live tab sync so the second window stays independent: otherwise
  // Zen replicates the new tab back into this window as portal tabs.
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await win.gZenStartup.promiseInitialized;
    await TestUtils.waitForCondition(
      () => win.gZenMemoryManager && win.gZenMemoryManager.started,
      "Second window memory manager starts"
    );
    const otherManager = win.gZenMemoryManager;
    ok(
      otherManager && otherManager.started,
      "Second window has a running manager"
    );
    const tab = BrowserTestUtils.addTab(
      win.gBrowser,
      "data:text/html,<title>other-window</title>",
      { skipAnimation: true }
    );
    await BrowserTestUtils.browserLoaded(win.gBrowser.getBrowserForTab(tab));
    otherManager._testSetLastActive(tab, Date.now() - ELEVEN_MINUTES_MS);
    otherManager._testSetReopened(tab, 0);
    await otherManager._testSweep();
    ok(tab.hasAttribute("pending"), "Second window unloads its own idle tabs");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_diagnostics_never_claim_unmeasured_bytes() {
  const tab = await openBackgroundTab();
  try {
    backdate(tab);
    await manager()._testSweep();
    const diagnostics = manager().getDiagnostics();
    is(
      diagnostics.approxBytesReclaimed,
      null,
      "Reclaimed bytes stay null when not reliably measured"
    );
    ok(
      diagnostics.residentNote.includes("lower bound"),
      "Memory attribution limits are documented"
    );
    ok(
      diagnostics.sleepSupported === false,
      "Sleeping is reported as unsupported"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
