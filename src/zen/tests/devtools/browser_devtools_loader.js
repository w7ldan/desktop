/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_devtools_loader_resolves_builtin_modules() {
  const { DevToolsLoader } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  ok(DevToolsLoader, "DevToolsLoader is available");
  let loader = null;
  try {
    loader = new DevToolsLoader();
    const builtin = loader.require(
      "resource://devtools/shared/loader/builtin-modules.js"
    );
    ok(builtin, "builtin-modules.js resolves via resource://devtools");
    ok(
      builtin.modules && builtin.globals,
      "builtin-modules exposes modules and globals"
    );
  } catch (ex) {
    ok(
      false,
      `builtin-modules.js must load without "not found" error: ${ex.message}`
    );
  } finally {
    if (loader) {
      try {
        loader.destroy("test");
      } catch {}
    }
  }
});

add_task(async function test_devtools_panels_load() {
  const { DevToolsLoader } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  const loader = new DevToolsLoader();
  try {
    const panels = [
      "resource://devtools/client/framework/toolbox",
      "resource://devtools/shared/protocol/Front",
      "resource://devtools/client/inspector/inspector",
      "resource://devtools/client/webconsole/webconsole",
      "resource://devtools/client/netmonitor/panel",
      "resource://devtools/client/debugger/panel",
    ];
    for (const id of panels) {
      let resolved = null;
      try {
        resolved = loader.require.resolve(id);
      } catch (ex) {
        ok(false, `Panel module resolves: ${id}: ${ex.message}`);
        continue;
      }
      ok(resolved, `Panel module resolves: ${id}`);
    }
  } finally {
    try {
      loader.destroy("test");
    } catch {}
  }
});
