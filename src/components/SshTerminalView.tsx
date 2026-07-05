import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  sessionId: string | undefined;
  settings?: TerminalSettings;
  highlights?: KeywordHighlight[];
  onRegister?: (api: { write: (data: string) => void }) => void;
  onCwdChange?: (cwd: string) => void;
  uiTheme?: "dark" | "light";
  /** Backend transport: selects event names + write/resize commands. */
  transport?: "ssh" | "telnet";
  /** Fired when the session ends (the backend emits the exit event). */
  onDisconnect?: () => void;
  /** Called when Ctrl+F is pressed inside the terminal. */
  onToggleSearch?: () => void;
  /** Called once after the terminal is ready — exposes find methods. */
  onRegisterFind?: (api: {
    findNext: (q: string) => void;
    findPrev: (q: string) => void;
    clearHighlight: () => void;
  }) => void;
  /** When provided, enables Ctrl+R and the right-click reconnect action. */
  onReconnect?: () => void;
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

export default function SshTerminalView({
  sessionId,
  settings,
  highlights = [],
  onRegister,
  onCwdChange,
  uiTheme = "dark",
  transport = "ssh",
  onDisconnect,
  onToggleSearch,
  onRegisterFind,
  onReconnect,
}: Props) {
  useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fontSizeRef = useRef(settings?.fontSize ?? 14);
  const highlightsRef = useRef(highlights);
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  // Stable refs so Effect 1 closures always read latest values
  const sessionIdRef    = useRef(sessionId);
  const transportRef    = useRef(transport);
  const onToggleSearchRef = useRef(onToggleSearch);
  const onReconnectRef    = useRef(onReconnect);
  useEffect(() => { sessionIdRef.current    = sessionId;    }, [sessionId]);
  useEffect(() => { transportRef.current    = transport;    }, [transport]);
  useEffect(() => { onToggleSearchRef.current = onToggleSearch; }, [onToggleSearch]);
  useEffect(() => { onReconnectRef.current    = onReconnect;   }, [onReconnect]);

  // Sync xterm theme when uiTheme prop changes (terminal already mounted)
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = uiTheme === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK;
  }, [uiTheme]);

  const [ctxMenu,       setCtxMenu]       = useState<{ x: number; y: number } | null>(null);
  const [isDisconnected, setIsDisconnected] = useState(false);
  // Ref version for use inside Effect 1 closures (attachCustomKeyEventHandler)
  const isDisconnectedRef = useRef(false);
  // (search UI now lives in ServerStatsBar; terminal only exposes find API)
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  // Flip menu above/left when it would overflow the viewport
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

  const focus = useCallback(() => { termRef.current?.focus(); }, []);
  const closeCtx = useCallback(() => setCtxMenu(null), []);

  // Custom scrollbar state (replaces xterm's built-in one so it can start at y=0)
  const [scrollThumb, setScrollThumb] = useState({ top: 0, height: 100 });
  const scrollTrackRef = useRef<HTMLDivElement>(null);

  // Prevent WebView's native Ctrl+F find bar from appearing
  useEffect(() => {
    const block = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") e.preventDefault();
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, []);

  // ── Effect 1: create xterm terminal (runs once on mount) ──────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fontSize = settings?.fontSize ?? 14;
    fontSizeRef.current = fontSize;

    const font = settings?.font
      ? `"${settings.font}", Menlo, Monaco, Consolas, monospace`
      : 'Menlo, Monaco, "Cascadia Code", "DejaVu Sans Mono", Consolas, monospace';

    const cursorStyle = (settings?.cursorStyle?.toLowerCase() ?? "block") as
      "block" | "bar" | "underline";

    const term = new Terminal({
      fontFamily: font,
      fontSize,
      cursorBlink: settings?.cursorBlink ?? true,
      cursorStyle,
      theme: uiTheme === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK,
      scrollback: 5000,
      rightClickSelectsWord: false,
      macOptionIsMeta: true,
    });
    termRef.current = term;

    // ── CWD tracking ──────────────────────────────────────────────────────────
    const osc7 = term.parser.registerOscHandler(7, (data: string) => {
      const m = data.match(/^file:\/\/[^/]*(\/[^\x07\x1b\r\n]*)/);
      if (m) {
        try {
          const path = decodeURIComponent(m[1]).replace(/\/*$/, "") || "/";
          onCwdChange?.(path);
        } catch { /* ignore */ }
      }
      return true;
    });

    let inputBuf = "";
    let inputDirty = false;
    const inputSub = term.onData((data) => {
      if (data === "\r") {
        if (!inputDirty) {
          const m = inputBuf.trim().match(/(?:^|[;&|])\s*cd\s+(\/\S*)/);
          if (m) onCwdChange?.(m[1].replace(/\/+$/, "") || "/");
        }
        inputBuf = "";
        inputDirty = false;
      } else if (data.startsWith("\x1b")) {
        inputDirty = true;
      } else if (data === "\x7f" || data === "\x08") {
        if (!inputDirty) inputBuf = inputBuf.slice(0, -1);
      } else if (data === "\x15" || data === "\x0b") {
        inputBuf = ""; inputDirty = false;
      } else {
        inputBuf += data;
      }
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(search);

    const FIND_OPTS = { caseSensitive: false, regex: false };
    onRegisterFind?.({
      findNext:      (q) => { if (q) search.findNext(q, FIND_OPTS); },
      findPrev:      (q) => { if (q) search.findPrevious(q, FIND_OPTS); },
      clearHighlight: () => { try { (search as unknown as { clearDecorations?: () => void }).clearDecorations?.(); } catch { /**/ } },
    });

    term.open(container);
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /**/ }
    });

    const updateThumb = () => {
      const buf = term.buffer.active;
      const total = buf.length;
      const view  = term.rows;
      if (total <= view) { setScrollThumb({ top: 0, height: 100 }); return; }
      const h = Math.max(8, view / total * 100);
      const t = (buf.viewportY / Math.max(1, total - view)) * (100 - h);
      setScrollThumb({ top: t, height: h });
    };
    // term.onScroll fires when new content grows the buffer; DOM scroll fires when
    // the user scrolls through existing scrollback — both are needed.
    const scrollSub = term.onScroll(updateThumb);
    const viewport = container.querySelector(".xterm-viewport");
    viewport?.addEventListener("scroll", updateThumb);
    requestAnimationFrame(updateThumb);

    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.type === "keydown") {
        if (e.key === "f") { onToggleSearchRef.current?.(); return false; }
        // Ctrl+R: reconnect only when disconnected (don't swallow bash reverse-search)
        if (e.key === "r" && isDisconnectedRef.current) {
          onReconnectRef.current?.();
          return false;
        }
      }
      return true;
    });

    onRegister?.({ write: (data: string) => term.write(data) });

    // User keystrokes → SSH/telnet write (uses refs so sessionId can change)
    const dataSub = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      invoke(`${transportRef.current}_write`, { sessionId: sid, data }).catch((e) => {
        termRef.current?.write(`\r\n\x1b[1;31m[write error: ${e}]\x1b[0m\r\n`);
      });
    });

    // Context menu
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
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

    // Resize observer (uses refs so sessionId can change without remounting)
    const doResize = () => {
      const sid = sessionIdRef.current;
      if (!container.clientWidth || !container.clientHeight || !sid) return;
      try { fit.fit(); } catch { /**/ }
      updateThumb();
      invoke(`${transportRef.current}_resize`, { sessionId: sid, rows: term.rows, cols: term.cols }).catch(() => {});
    };
    const ro = new ResizeObserver(doResize);
    ro.observe(container);

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
      scrollSub.dispose();
      viewport?.removeEventListener("scroll", updateThumb);
      dataSub.dispose();
      osc7.dispose();
      inputSub.dispose();
      container.removeEventListener("contextmenu", onCtx);
      container.removeEventListener("wheel", onWheel);
      term.dispose();
      termRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect 2: SSH/telnet session listeners (re-runs when sessionId changes) ─
  useEffect(() => {
    if (!sessionId) return;

    // New session → no longer in disconnected state
    setIsDisconnected(false);
    isDisconnectedRef.current = false;

    const outEvent  = `${transport}://output/${sessionId}`;
    const exitEvent = `${transport}://exit/${sessionId}`;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      unlistenOutput = await listen<string>(outEvent, (event) => {
        const term = termRef.current;
        if (!term) return;
        const bytes = base64ToBytes(event.payload);
        const text = new TextDecoder().decode(bytes);
        const h = highlightsRef.current;
        if (h.length) {
          term.write(applyHighlights(text, h));
        } else {
          term.write(bytes);
        }
      });
      if (cancelled) { unlistenOutput?.(); return; }

      unlistenExit = await listen(exitEvent, () => {
        const hint = onReconnectRef.current ? i18nT("term.reconnectHint") : "";
        termRef.current?.write(`\r\n\x1b[2m[${i18nT("term.sessionClosed", { hint })}]\x1b[0m\r\n`);
        setIsDisconnected(true);
        isDisconnectedRef.current = true;
        onDisconnectRef.current?.();
      });
      if (cancelled) { unlistenExit?.(); return; }

      // Send current terminal size to the new session and focus
      const term = termRef.current;
      if (term) {
        try { fitRef.current?.fit(); } catch { /**/ }
        invoke(`${transport}_resize`, { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
        term.focus();
        setTimeout(() => { termRef.current?.focus(); }, 80);
      }
    })();

    return () => {
      cancelled = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, [sessionId, transport]);

  const handleCopy = async () => {
    const sel = termRef.current?.getSelection();
    if (sel) await writeClipboard(sel);
    closeCtx();
    focus();
  };

  const handlePaste = async () => {
    closeCtx();
    const text = await readClipboard();
    if (text) {
      const sid = sessionIdRef.current;
      if (sid) invoke(`${transportRef.current}_write`, { sessionId: sid, data: text }).catch(() => {});
    }
    focus();
  };

  return (
    <div
      className="terminal-wrapper"
      style={{ paddingTop: 24 }}
      onMouseDown={(e) => {
        if (ctxMenu && !(e.target as HTMLElement).closest(".ctx-menu")) {
          closeCtx();
        }
      }}
    >
      {/* xterm canvas */}
      <div
        className="terminal"
        ref={containerRef}
        tabIndex={-1}
        onMouseDown={() => { setTimeout(() => termRef.current?.focus(), 0); }}
      />

      {/* Custom scrollbar — position:absolute bypasses paddingTop, starts at y=0 */}
      <div
        ref={scrollTrackRef}
        className="term-sb-track"
        onWheel={(e) => { e.preventDefault(); termRef.current?.scrollLines(e.deltaY > 0 ? 3 : -3); }}
      >
        {scrollThumb.height < 99 && (
          <div
            className="term-sb-thumb"
            style={{ top: `${scrollThumb.top}%`, height: `${scrollThumb.height}%` }}
            onMouseDown={(e) => {
              e.preventDefault();
              const term = termRef.current;
              const track = scrollTrackRef.current;
              if (!term || !track) return;
              const startY = e.clientY;
              const startTop = scrollThumb.top;
              const thumbH   = scrollThumb.height;
              const onMove = (ev: MouseEvent) => {
                const trackH = track.clientHeight;
                const pct = Math.max(0, Math.min(100 - thumbH, startTop + (ev.clientY - startY) / trackH * 100));
                const buf = term.buffer.active;
                const maxLine = Math.max(0, buf.length - term.rows);
                term.scrollToLine(Math.round((pct / (100 - thumbH)) * maxLine));
              };
              const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
              };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            }}
          />
        )}
      </div>

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
          <div className="ctx-item" onClick={() => { onToggleSearchRef.current?.(); closeCtx(); }}>{i18nT("term.find")}</div>
          <div className="ctx-divider" />
          <div className="ctx-item" onClick={() => { termRef.current?.clear(); closeCtx(); focus(); }}>{i18nT("term.clear")}</div>
          {isDisconnected && onReconnect && (
            <>
              <div className="ctx-divider" />
              <div className="ctx-item" onClick={() => { onReconnectRef.current?.(); closeCtx(); }}>{i18nT("term.reconnect")}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
