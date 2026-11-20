import { getCurrentWindow } from "@tauri-apps/api/window";
import { restoreStateCurrent, StateFlags } from "@tauri-apps/plugin-window-state";
import { invoke } from "@tauri-apps/api/core";

export const windowReady: Promise<void> = (async () => {
  const win = getCurrentWindow();
  if (/win/i.test(navigator.platform || navigator.userAgent || "")) {
    // Native placement restores normal bounds and maximization atomically.
    // Do not also restore the plugin cache or maximize again from JavaScript.
    try {
      await invoke("window_restore_state");
    } catch (error) {
      console.error("Failed to restore window placement", error);
      await win.center().catch(() => {});
      await win.show().catch(() => {});
    }
    return;
  }
  const raw = await invoke<string | null>("settings_get", { key: "app.wasMaximized" }).catch(() => null);
  const wasMaximized = raw === "true";

  if (!wasMaximized) {
    if (raw === null) {
      // First launch with no saved DB state: restore only the size and recenter.
      await restoreStateCurrent(StateFlags.SIZE as StateFlags).catch(() => {});
      await win.center().catch(() => {});
    } else {
      // Subsequent launches restore both the saved size and position.
      await restoreStateCurrent(
        (StateFlags.SIZE | StateFlags.POSITION) as StateFlags
      ).catch(() => {});
    }
  }
  // When starting maximized, skip restoring the normal window size so the
  // plugin does not write the maximized bounds back as a regular size.

  await win.show().catch(() => {});

  if (wasMaximized) {
    await win.maximize().catch(() => {});

    // win.maximize() uses the async Windows message queue, so poll until the
    // native maximized flag is actually applied.
    for (let i = 0; i < 30; i++) {
      if (await win.isMaximized().catch(() => true)) break;
      await new Promise(r => setTimeout(r, 20)); // Wait up to 600 ms.
    }

    // Give WebView2 a moment to reflow at the new size.
    await new Promise(r => setTimeout(r, 150));
  }
})();
