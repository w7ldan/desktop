// Node harness: loads the REAL ZenMemoryManager.mjs + ZenMemoryPolicy.mjs
// with faithful browser stubs, to validate manager logic end-to-end.
// Usage: node src/zen/memory/ZenMemoryManager.harness.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path
  .dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Z]:)/, "$1");
const SRC = HERE;

function makePrefs(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getBoolPref: (n, fb) => (store.has(n) ? !!store.get(n) : fb),
    getIntPref: (n, fb) => (store.has(n) ? Number(store.get(n)) : fb),
    getStringPref: (n, fb) => (store.has(n) ? String(store.get(n)) : fb),
    getPrefType: () => 0,
    PREF_INVALID: 0,
    setBoolPref: (n, v) => store.set(n, !!v),
    setIntPref: (n, v) => store.set(n, Number(v)),
    setStringPref: (n, v) => store.set(n, String(v)),
    addObserver: () => {},
    removeObserver: () => {},
    _store: store,
  };
}

function makeTab(attrs = {}) {
  const attrSet = new Set(attrs.attrs ?? []);
  return {
    localName: "tab",
    selected: !!attrs.selected,
    pinned: !!attrs.pinned,
    closing: false,
    discarded: !!attrs.discarded,
    soundPlaying: !!attrs.soundPlaying,
    group: null,
    linkedBrowser: {
      currentURI: { host: attrs.host ?? "", spec: attrs.spec ?? "" },
      zenModeActive: !!attrs.zenModeActive,
    },
    hasAttribute: n => attrSet.has(n),
    getAttribute: n => attrs.get?.[n] ?? null,
    setAttribute: n => attrSet.add(n),
    removeAttribute: n => attrSet.delete(n),
    _attrs: attrSet,
  };
}

const policyUrl = pathToFileURL(path.join(SRC, "ZenMemoryPolicy.mjs")).href;

const StubChromeUtils = {
  defineESModuleGetters(obj, dict) {
    for (const [key, moduleUrl] of Object.entries(dict)) {
      let cached = null;
      let loaded = false;
      Object.defineProperty(obj, key, {
        configurable: true,
        enumerable: true,
        get() {
          if (!loaded) {
            throw new Error(
              `harness: sync ESM import not supported for ${moduleUrl} (use async path)`
            );
          }
          return cached;
        },
      });
      void cached;
      void loaded;
    }
  },
};

const listeners = {};
const windowStub = {
  addEventListener: (t, f) => {
    (listeners[t] ??= []).push(f);
  },
  removeEventListener: () => {},
  gBrowser: null,
  gZenWorkspaces: null,
  gZenStartup: null,
  PrivateBrowsingUtils: { isWindowPrivate: () => false },
  webrtcUI: { browserHasStreams: () => false },
  gZenGlanceManager: null,
  gZenViewSplitter: null,
};

const StubServices = {
  prefs: makePrefs({
    "zen.memory.enabled": true,
    "zen.memory.mode": "strict",
    "zen.memory.idle-timeout-minutes": 10,
    "zen.memory.early-unload-enabled": true,
    "zen.memory.include-pinned": true,
    "zen.memory.include-essentials": true,
    "zen.memory.exempt-hosts": "",
    "zen.memory.ram-budget-mb": 0,
    "zen.memory.reopen-cooldown-seconds": 0,
    "zen.memory.max-discards-per-sweep": 5,
    "zen.memory.sweep-interval-seconds": 3600,
    "zen.memory.experimental-sleep": false,
  }),
  obs: { addObserver: () => {}, removeObserver: () => {} },
};

const sandbox = {
  console,
  ChromeUtils: StubChromeUtils,
  Services: StubServices,
  window: windowStub,
  Cc: {},
  Ci: {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  Date,
  Math,
  JSON,
  Object,
  Array,
  Number,
  String,
  Boolean,
  Map,
  Set,
  WeakMap,
  Promise,
  URL,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const managerSrc = readFileSync(path.join(SRC, "ZenMemoryManager.mjs"), "utf8");

// eslint-disable-next-line no-unsanitized/method
const policy = await import(policyUrl);
const lazyBridge = { ZenMemoryPolicy: policy };

// Evaluate manager source with the static policy import bridged to Node.
const patched = managerSrc.replace(
  'import * as ZenMemoryPolicy from "resource:///modules/zen/memory/ZenMemoryPolicy.mjs";',
  "const ZenMemoryPolicy = globalThis.__lazyBridge.ZenMemoryPolicy;"
);
const wrapped = patched;
sandbox.__lazyBridge = lazyBridge;
try {
  vm.runInContext(wrapped, sandbox, { filename: "ZenMemoryManager.mjs" });
} catch (e) {
  console.error("manager eval failed:", e.message);
  throw e;
}

const manager = sandbox.window.gZenMemoryManager;
assert.ok(manager, "gZenMemoryManager created");
assert.equal(manager.started, false, "not started without gBrowser");

const selected = makeTab({ selected: true });
const bgRecent = makeTab({ host: "example.org" });
const bgIdle = makeTab({ host: "idle.example" });
const tabs = [selected, bgRecent, bgIdle];
windowStub.gBrowser = {
  tabs,
  explicitUnloadTabs: async batch => {
    for (const t of batch) {
      t.setAttribute("pending");
      t.discarded = true;
    }
    return true;
  },
};
windowStub.gZenWorkspaces = { allStoredTabs: tabs };
windowStub.gZenStartup = { promiseInitialized: Promise.resolve() };
await Promise.resolve();
manager.start();
assert.equal(manager.started, true, "manager starts");

const cfg = manager.readConfig();
assert.equal(cfg.mode, "strict", "strict mode read");
assert.equal(cfg.idleTimeoutMinutes, 10, "timeout read");

const now = Date.now();
manager._testSetLastActive(bgIdle, now - 11 * 60 * 1000);
manager._testSetLastActive(bgRecent, now - 60 * 1000);
manager._testSetLastActive(selected, now - 11 * 60 * 1000);
const result = await manager._testSweep();
assert.equal(result.discarded, 1, "exactly the idle tab discarded");
assert.ok(bgIdle.hasAttribute("pending"), "idle tab pending");
assert.ok(!bgRecent.hasAttribute("pending"), "recent tab kept");
assert.ok(!selected.hasAttribute("pending"), "selected tab kept");

const diag = manager.getDiagnostics();
assert.equal(diag.totalAutoDiscards, 1);
assert.equal(diag.approxBytesReclaimed, null);
assert.equal(diag.sleepSupported, false);
manager.dispose();
// eslint-disable-next-line no-console
console.log("HARNESS-OK: manager logic validated end-to-end in Node");
