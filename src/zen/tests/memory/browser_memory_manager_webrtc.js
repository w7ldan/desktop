/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ELEVEN_MINUTES_MS = 11 * 60 * 1000;

function manager() {
  return window.gZenMemoryManager;
}

function backdate(tab, ageMs = ELEVEN_MINUTES_MS) {
  manager()._testSetLastActive(tab, Date.now() - ageMs);
  manager()._testSetReopened(tab, 0);
}

async function openTabWithPeerConnection() {
  const tab = BrowserTestUtils.addTab(
    gBrowser,
    "data:text/html,<title>webrtc</title>",
    { skipAnimation: true }
  );
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content._peer = new content.RTCPeerConnection();
  });
  return tab;
}

async function closePeerConnection(tab) {
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content._peer?.close();
      content._peer = null;
    });
  } catch {}
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
      ["zen.memory.unload-idle-peer-connections", true],
    ],
  });
  manager()._testResetCounters();
  registerCleanupFunction(async () => {
    manager()._testResetCounters();
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_idle_peer_connection_tab_unloads_in_strict() {
  const tab = await openTabWithPeerConnection();
  try {
    const windowGlobal = tab.linkedBrowser.browsingContext.currentWindowGlobal;
    ok(
      windowGlobal.hasActivePeerConnections(),
      "Content created an active peer connection"
    );
    backdate(tab);
    const result = await manager()._testSweep();
    ok(result.discarded >= 1, "Sweep discarded the idle peer-only tab");
    ok(tab.hasAttribute("pending"), "Idle peer-only tab is unloaded");
  } finally {
    await closePeerConnection(tab);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_peer_connection_tab_protected_when_opted_out() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.memory.unload-idle-peer-connections", false]],
  });
  const tab = await openTabWithPeerConnection();
  try {
    backdate(tab);
    const result = await manager()._testSweep();
    is(result.discarded, 0, "Opt-out prevents discarding peer tabs");
    ok(
      !tab.hasAttribute("pending"),
      "Idle peer tab stays loaded when opted out"
    );
  } finally {
    await closePeerConnection(tab);
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_media_capture_tab_is_protected() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      ["permissions.default.camera", 1],
      ["permissions.default.microphone", 1],
    ],
  });
  const tab = BrowserTestUtils.addTab(
    gBrowser,
    "data:text/html,<title>capture</title>",
    { skipAnimation: true }
  );
  try {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    const capturing = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      async () => {
        try {
          const stream = await content.navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
          });
          content._stream = stream;
          content._peer = new content.RTCPeerConnection();
          return stream.getTracks().length > 0;
        } catch (ex) {
          return false;
        }
      }
    );
    if (!capturing) {
      ok(true, "getUserMedia unavailable here; capture assertion skipped");
      return;
    }
    backdate(tab);
    await manager()._testSweep();
    ok(!tab.hasAttribute("pending"), "Tab with active capture is protected");
  } finally {
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        content._stream?.getTracks().forEach(track => track.stop());
        content._peer?.close();
      });
    } catch {}
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_peer_connection_scoped_to_its_tab() {
  const peerTab = await openTabWithPeerConnection();
  const plainTab = BrowserTestUtils.addTab(
    gBrowser,
    "data:text/html,<title>plain</title>",
    { skipAnimation: true }
  );
  try {
    await BrowserTestUtils.browserLoaded(plainTab.linkedBrowser);
    backdate(peerTab);
    backdate(plainTab);
    await manager()._testSweep();
    ok(peerTab.hasAttribute("pending"), "Peer tab unloads after the deadline");
    ok(
      plainTab.hasAttribute("pending"),
      "Unrelated idle tab is unaffected by the peer policy"
    );
  } finally {
    await closePeerConnection(peerTab);
    BrowserTestUtils.removeTab(plainTab);
    BrowserTestUtils.removeTab(peerTab);
  }
});
