import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import type { TerminalSettings, KeywordHighlight } from "../types";
import { t as i18nT, useT } from "../i18n";

const TERM_THEME_DARK = {
  background: "#1e2230", foreground: "#cdd6f4", cursor: "#89b4fa", cursorAccent: "#1e2230",
  selectionBackground: "rgba(137,180,250,0.25)",
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
  blue: "#89b4fa", magenta: "#cba6f7", cyan: "#89dceb", white: "#bac2de",
  brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#cba6f7",
  brightCyan: "#89dceb", brightWhite: "#a6adc8",
};
const TERM_THEME_LIGHT = {
  background: "#eff1f5", foreground: "#4c4f69", cursor: "#1e66f5", cursorAccent: "#eff1f5",
  selectionBackground: "rgba(30,102,245,0.20)",
  black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
  blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
  brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
  brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb",
  brightCyan: "#179299", brightWhite: "#bcc0cc",
};

interface Props {
  sessionId: string;
  settings?: TerminalSettings;
  highlights?: KeywordHighlight[];
  onRegister?: (api: { write: (data: string) => void }) => void;
  uiTheme?: "dark" | "light";
  /** Saved Local host: multi-line KEY=value env applied to the shell. */
  env?: string;
  /** Saved Local host: command typed into the shell once it starts. */
  startupCmd?: string;
  /** Shell charset (e.g. "GBK"); defaults to UTF-8. */
  encoding?: string;
  /** "Local" | "WSL" — selects the shell to launch. */
  protocol?: string;
  /** WSL distribution name (for protocol "WSL"). */
  wslDistro?: string;
  /** Shell ID from settings (e.g. "pwsh", "git-bash") or empty for system default. */
  localShell?: string;
}

async function writeClipboard(text: string) {
  try { await writeText(text); } catch { /**/ }
}

async function readClipboard(): Promise<string> {
  try { return await readText(); } catch { return ""; }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hexToAnsi(hex: string, bg = false): string {
  if (!hex || hex.length < 7) return "";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return bg ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[38;2;${r};${g};${b}m`;
}

function applyHighlights(text: string, rules: KeywordHighlight[]): string {
  if (!rules.length) return text;
  let result = text;
  for (const r of rules) {
    if (!r.enabled || !r.keyword) continue;
    try {
      const flags = r.matchCase ? "g" : "gi";
      const pat = new RegExp(r.regex ? r.keyword : escapeRegExp(r.keyword), flags);
      const fg = hexToAnsi(r.textColor);
      const bg = r.bgColor ? hexToAnsi(r.bgColor, true) : "";
      const bold = r.bold ? "\x1b[1m" : "";
      result = result.replace(pat, `${fg}${bg}${bold}$&\x1b[0m`);
    } catch { /* invalid regex */ }
  }
  return result;
}

export default function TerminalView({ sessionId, settings, highlights = [], onRegister, uiTheme = "dark", env, startupCmd, encoding, protocol, wslDistro, localShell }: Props) {
  useT();
  const envRef = useRef(env);
  const startupCmdRef = useRef(startupCmd);
  const encodingRef = useRef(encoding);
  const protocolRef = useRef(protocol);
  const localShellRef = useRef(localShell);
  const wslDistroRef = useRef(wslDistro);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fontSizeRef = useRef(settings?.fontSize ?? 14);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const highlightsRef = useRef(highlights);
  const isLoggingRef = useRef(false);
  const logBufferRef = useRef<string[]>([]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = uiTheme === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK;
  }, [uiTheme]);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLogging, setIsLogging] = useState(false);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ctxMenuRef.current;
    if (!el || !ctxMenu) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(4, ctxMenu.x + width > window.innerWidth ? ctxMenu.x - width : ctxMenu.x);
    const top  = Math.max(4, ctxMenu.y + height > window.innerHeight ? ctxMenu.y - height : ctxMenu.y);
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
    el.style.opacity = "1";
  }, [ctxMenu]);

  useEffect(() => { highlightsRef.current = highlights; }, [highlights]);
  useEffect(() => { isLoggingRef.current = isLogging; }, [isLogging]);

  const focus = useCallback(() => { termRef.current?.focus(); }, []);

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fontSize = settings?.fontSize ?? 14;
    fontSizeRef.current = fontSize;

    // Preferred CJK fallback order for the automatic fallback-font option.
    const SMART_CJK = [
      "Microsoft YaHei Mono",
      "Microsoft YaHei",
      "PingFang SC",
      "Noto Sans Mono CJK SC",
      "Noto Sans CJK SC",
      "Source Han Sans CN",
      "WenQuanYi Micro Hei Mono",
      "WenQuanYi Micro Hei",
      "SimSun",
    ].map((f) => `"${f}"`).join(", ");

    const fallback = settings?.fallbackFont
      ? `"${settings.fallbackFont}"`
      : SMART_CJK;

    const font = settings?.font
      ? `"${settings.font}", ${fallback}, Menlo, Monaco, Consolas, monospace`
      : `Menlo, Monaco, "Cascadia Code", ${fallback}, "DejaVu Sans Mono", Consolas, monospace`;

    const cursorStyle = (settings?.cursorStyle?.toLowerCase() ?? "block") as
      "block" | "bar" | "underline";

    const term = new Terminal({
      fontFamily: font,
      fontSize,
      cursorBlink: settings?.cursorBlink ?? true,
      cursorStyle,
      theme: uiTheme === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK,
      scrollback: settings?.maxRows ?? 5000,
      rightClickSelectsWord: false,
      macOptionIsMeta: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(search);

    if (settings?.hyperlink ?? true) {
      term.loadAddon(new WebLinksAddon((_e, uri) => {
        shellOpen(uri).catch(() => {});
      }));
    }

    term.open(container);
    // Small delay to let xterm measure the container
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /**/ }
    });

    // Intercept Ctrl+F inside xterm to open find bar
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "f" && e.type === "keydown") {
        setShowSearch((v) => !v);
        return false;
      }
      return true;
    });

    onRegister?.({ write: (data: string) => term.write(data) });

    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    (async () => {
      unlistenOutput = await listen<string>(`terminal://output/${sessionId}`, (event) => {
        const bytes = base64ToBytes(event.payload);
        const h = highlightsRef.current;
        if (h.length) {
          const text = new TextDecoder().decode(bytes);
          const processed = applyHighlights(text, h);
          term.write(processed);
          if (isLoggingRef.current) logBufferRef.current.push(text);
        } else {
          term.write(bytes);
          if (isLoggingRef.current) {
            logBufferRef.current.push(new TextDecoder().decode(bytes));
          }
        }
      });
      unlistenExit = await listen(`terminal://exit/${sessionId}`, () => {
        term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      });

      // Fit before measuring rows/cols so PTY gets the right initial size
      try { fitRef.current?.fit(); } catch { /**/ }

      try {
        await invoke("terminal_create", {
          sessionId,
          rows: term.rows,
          cols: term.cols,
          env: envRef.current || undefined,
          startupCmd: startupCmdRef.current || undefined,
          encoding: encodingRef.current || undefined,
          protocol: protocolRef.current || undefined,
          wslDistro: wslDistroRef.current || undefined,
          localShell: localShellRef.current || undefined,
        });
      } catch (e) {
        term.write(`\r\n\x1b[1;31m[${i18nT("term.startFailed", { error: String(e) })}]\x1b[0m\r\n`);
        return;
      }

      term.focus();
      // WebView2 sometimes needs a second nudge to honour focus()
      setTimeout(() => { termRef.current?.focus(); }, 80);
    })();

    // Select-to-copy
    const selSub = term.onSelectionChange(() => {
      if (!settingsRef.current?.selectCopy) return;
      const sel = termRef.current?.getSelection();
      if (sel) writeClipboard(sel);
    });

    // Input → backend PTY
    const dataSub = term.onData((data) => {
      invoke("terminal_write", { sessionId, data }).catch((e) => {
        termRef.current?.write(`\r\n\x1b[1;31m[write error: ${e}]\x1b[0m\r\n`);
      });
    });

    // Right-click — behavior driven by settings.rightClick
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      const mode = settingsRef.current?.rightClick ?? "Menu";
      if (mode === "Nothing") return;
      if (mode === "Copy") {
        const sel = termRef.current?.getSelection();
        if (sel) writeClipboard(sel);
        return;
      }
      if (mode === "CopyAndPaste") {
        const sel = termRef.current?.getSelection();
        if (sel) {
          writeClipboard(sel);
        } else {
          readClipboard().then((text) => {
            if (text) invoke("terminal_write", { sessionId, data: text }).catch(() => {});
          });
        }
        return;
      }
      // "Menu"
      setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    container.addEventListener("contextmenu", onCtx);

    // Ctrl+wheel zoom
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const next = Math.max(8, Math.min(36, fontSizeRef.current + (e.deltaY < 0 ? 1 : -1)));
      fontSizeRef.current = next;
      term.options.fontSize = next;
      try { fit.fit(); } catch { /**/ }
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    // Resize observer — skip when container is hidden (display:none → width 0)
    const doResize = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      try { fit.fit(); } catch { /**/ }
      invoke("terminal_resize", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);

    // Re-fit when the slot becomes visible again (parent display flips to flex)
    const slot = container.closest(".terminal-slot") as HTMLElement | null;
    let mo: MutationObserver | undefined;
    if (slot) {
      mo = new MutationObserver(() => {
        if (slot.style.display !== "none") doResize();
      });
      mo.observe(slot, { attributes: true, attributeFilter: ["style"] });
    }

    return () => {
      ro.disconnect();
      mo?.disconnect();
      selSub.dispose();
      dataSub.dispose();
      container.removeEventListener("contextmenu", onCtx);
      container.removeEventListener("wheel", onWheel);
      unlistenOutput?.();
      unlistenExit?.();
      invoke("terminal_close", { sessionId }).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, []); // only once

  const handleCopy = async () => {
    const sel = termRef.current?.getSelection();
    if (sel) await writeClipboard(sel);
    closeCtx();
    focus();
  };

  const handlePaste = async () => {
    closeCtx();
    const text = await readClipboard();
    if (text) invoke("terminal_write", { sessionId, data: text }).catch(() => {});
    focus();
  };

  const handleFind = (forward = true) => {
    if (!searchQuery) return;
    const opts = { caseSensitive: false, regex: false };
    if (forward) searchRef.current?.findNext(searchQuery, opts);
    else searchRef.current?.findPrevious(searchQuery, opts);
  };

  const handleCloseSearch = () => {
    setShowSearch(false);
    focus();
  };

  const downloadLog = () => {
    const blob = new Blob([logBufferRef.current.join("")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `terminal-log-${Date.now()}.txt`;
    a.click();
    logBufferRef.current = [];
    setIsLogging(false);
    focus();
  };

  return (
    <div
      ref={wrapperRef}
      className="terminal-wrapper"
      onMouseDown={(e) => {
        // Close ctx menu when clicking outside it
        if (ctxMenu && !(e.target as HTMLElement).closest(".ctx-menu")) {
          closeCtx();
        }
      }}
    >
      {/* Find bar */}
      {showSearch && (
        <div className="find-bar" onMouseDown={(e) => e.stopPropagation()}>
          <input
            className="find-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleFind(!e.shiftKey); }
              if (e.key === "Escape") handleCloseSearch();
            }}
            placeholder={i18nT("term.findPlaceholder")}
            autoFocus
          />
          <button onClick={() => handleFind(false)} data-tooltip={i18nT("term.findPrev")}>▲</button>
          <button onClick={() => handleFind(true)} data-tooltip={i18nT("term.findNext")}>▼</button>
          <button onClick={handleCloseSearch} data-tooltip={i18nT("term.findClose")}>✕</button>
          {isLogging
            ? <button className="log-btn log-stop" onClick={downloadLog}>{i18nT("term.saveLog")}</button>
            : <button className="log-btn" onClick={() => setIsLogging(true)}>{i18nT("term.record")}</button>
          }
        </div>
      )}

      {/* xterm canvas */}
      <div
        className="terminal"
        ref={containerRef}
        tabIndex={-1}
        onMouseDown={() => { setTimeout(() => termRef.current?.focus(), 0); }}
      />

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y, opacity: 0 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="ctx-item" onClick={handleCopy}>{i18nT("term.copy")}</div>
          <div className="ctx-item" onClick={handlePaste}>{i18nT("term.paste")}</div>
          <div className="ctx-divider" />
          <div className="ctx-item" onClick={() => { termRef.current?.selectAll(); closeCtx(); }}>{i18nT("term.selectAll")}</div>
          <div className="ctx-item" onClick={() => { setShowSearch(true); closeCtx(); }}>{i18nT("term.find")}</div>
          <div className="ctx-divider" />
          <div className="ctx-item" onClick={() => { termRef.current?.clear(); closeCtx(); focus(); }}>{i18nT("term.clear")}</div>
        </div>
      )}
    </div>
  );
}
