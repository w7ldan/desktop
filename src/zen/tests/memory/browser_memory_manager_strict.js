/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

function manager() {
  return window.gZenMemoryManager;
}

async function openBackgroundTab(url = "data:text/html,<title>idle</title>") {
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
      ["zen.memory.early-unload-enabled", false],
      ["zen.memory.include-pinned", true],
      ["zen.memory.include-essentials", true],
      ["zen.memory.exempt-hosts", ""],
      ["zen.memory.ram-budget-mb", 0],
      ["zen.memory.reopen-cooldown-seconds", 0],
      ["zen.memory.max-discards-per-sweep", 5],
    ],
  });
  manager()._testResetCounters();
  registerCleanupFunction(async () => {
    manager()._testResetCounters();
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_recent_background_tab_stays_loaded() {
  const tab = await openBackgroundTab();
  try {
    await manager()._testSweep();
    ok(!tab.hasAttribute("pending"), "Recent background tab stays loaded");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_idle_background_tab_unloads_after_deadline() {
  const tab = await openBackgroundTab();
  try {
    backdate(tab);
    const result = await manager()._testSweep();
    ok(result.discarded >= 1, "Sweep discarded at least one tab");
    ok(tab.hasAttribute("pending"), "Idle background tab is unloaded");
    const diagnostics = manager().getDiagnostics();
    ok(diagnostics.totalAutoDiscards >= 1, "Auto-discard counter increased");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_selected_tab_never_discards() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>selected</title>",
    true,
    { skipAnimation: true }
  );
  try {
    backdate(tab);
    await manager()._testSweep();
    ok(!tab.hasAttribute("pending"), "Selected tab is never auto-discarded");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_revisit_resets_inactivity_timer() {
  const tab = await openBackgroundTab();
  const other = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>other</title>",
    true,
    { skipAnimation: true }
  );
  try {
    backdate(tab);
    gBrowser.selectedTab = tab;
    await manager()._testSweep();
    ok(!tab.hasAttribute("pending"), "Revisited tab stays loaded");
  } finally {
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_pinned_tabs_follow_policy() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.include-pinned", false]],
  });
  try {
    const tab = await openBackgroundTab();
    try {
      gBrowser.pinTab(tab);
      backdate(tab);
      await manager()._testSweep();
      ok(
        !tab.hasAttribute("pending"),
        "Pinned tab is kept when excluded by policy"
      );
      await SpecialPowers.pushPrefEnv({
        set: [["zen.memory.include-pinned", true]],
      });
      try {
        await manager()._testSweep();
        ok(
          tab.hasAttribute("pending"),
          "Pinned tab unloads when included by policy"
        );
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    } finally {
      gBrowser.removeTab(tab);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_essentials_follow_policy() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.include-essentials", false]],
  });
  try {
    const tab = await openBackgroundTab();
    try {
      tab.setAttribute("zen-essential", "true");
      backdate(tab);
      await manager()._testSweep();
      ok(
        !tab.hasAttribute("pending"),
        "Essential is kept when excluded by policy"
      );
      await SpecialPowers.pushPrefEnv({
        set: [["zen.memory.include-essentials", true]],
      });
      try {
        await manager()._testSweep();
        ok(
          tab.hasAttribute("pending"),
          "Essential unloads when included by policy"
        );
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    } finally {
      tab.removeAttribute("zen-essential");
      gBrowser.removeTab(tab);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_inactive_workspace_tabs_unload() {
  const active = await gZenWorkspaces.createAndSaveWorkspace("MM Active");
  const inactive = await gZenWorkspaces.createAndSaveWorkspace("MM Inactive");
  try {
    await gZenWorkspaces.changeWorkspace(active);
    const tab = await openBackgroundTab();
    try {
      tab.setAttribute("zen-workspace-id", inactive.uuid);
      backdate(tab);
      await manager()._testSweep();
      ok(tab.hasAttribute("pending"), "Tab in inactive workspace unloads");
    } finally {
      gBrowser.removeTab(tab);
    }
  } finally {
    await gZenWorkspaces.removeWorkspace(inactive.uuid);
    await gZenWorkspaces.removeWorkspace(active.uuid);
  }
});

add_task(async function test_exempt_hosts_are_protected() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.exempt-hosts", "example.com"]],
  });
  try {
    const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/", {
      skipAnimation: true,
    });
    try {
      await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
      backdate(tab);
      await manager()._testSweep();
      ok(!tab.hasAttribute("pending"), "Exempt host is never auto-discarded");
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_workspace_switch_does_not_restore_discarded() {
  const first = await gZenWorkspaces.createAndSaveWorkspace("MM First");
  const second = await gZenWorkspaces.createAndSaveWorkspace("MM Second");
  try {
    await gZenWorkspaces.changeWorkspace(first);
    const tab = await openBackgroundTab();
    try {
      backdate(tab);
      await manager()._testSweep();
      ok(tab.hasAttribute("pending"), "Tab is discarded before switching");
      await gZenWorkspaces.changeWorkspace(second);
      await gZenWorkspaces.changeWorkspace(first);
      ok(
        tab.hasAttribute("pending"),
        "Workspace switch does not restore discarded tabs"
      );
    } finally {
      gBrowser.removeTab(tab);
    }
  } finally {
    await gZenWorkspaces.removeWorkspace(second.uuid);
    await gZenWorkspaces.removeWorkspace(first.uuid);
  }
});

add_task(async function test_disabling_manager_stops_unloading() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.enabled", false]],
  });
  try {
    const tab = await openBackgroundTab();
    try {
      backdate(tab);
      const result = await manager()._testSweep();
      is(result.discarded, 0, "No discards while disabled");
      ok(!tab.hasAttribute("pending"), "Tab stays loaded while disabled");
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
