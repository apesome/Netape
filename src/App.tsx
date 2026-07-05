import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { windowReady } from "./windowInit";
import { loadTreeExpanded } from "./store/treeStore";

import Sidebar from "./components/Sidebar";
import TerminalView from "./components/TerminalView";
import SshTerminalView from "./components/SshTerminalView";
import ServerStatsBar from "./components/ServerStatsBar";
import SystemSidebar from "./components/SystemSidebar";
import SshConnectingOverlay from "./components/SshConnectingOverlay";
import SftpView from "./components/SftpView";
import WelcomeTab from "./components/WelcomeTab";
import HostDialog from "./components/HostDialog";
import NewGroupDialog from "./components/NewGroupDialog";
import NewTerminalDialog from "./components/NewTerminalDialog";
import KeyboardInteractiveDialog from "./components/KeyboardInteractiveDialog";
import KeyManagerDialog from "./components/KeyManagerDialog";
import SettingsDialog from "./components/SettingsDialog";
import NoteDialog from "./components/NoteDialog";
import KeyHighlightDialog from "./components/KeyHighlightDialog";
import GlobalTooltip from "./components/Tooltip";
import GlobalToast, { toast } from "./components/Toast";
import ConfirmDialog, { useConfirm } from "./components/ConfirmDialog";
import type { Host, TerminalSettings, SftpSettings, KeywordHighlight } from "./types";
import { getProtocol, setInstalledPluginProtocols } from "./protocols";
import { setLang, useT } from "./i18n";

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------

type TabKind = "welcome" | "local" | "ssh" | "sftp";

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  titleKey?: string;
  pinned?: boolean;      // cannot be closed; rendered in fixed right slot
  sessionId?: string;
  protocol?: string;
  host?: Host;           // for reconnect
  sshError?: string;     // non-empty = connection failed
  sshCompleting?: boolean; // connection succeeded, animating to 100% before switching
  disconnected?: boolean;  // session dropped after a successful connect
  transport?: "ssh" | "telnet"; // for "ssh"-kind tabs: which backend transport
}

let _seq = 0;
const uid = () => `tab-${++_seq}`;
const WELCOME_ID  = "welcome";
const SFTP_PIN_ID = "sftp-pinned";

const translatedTabTitle = (tab: Tab, translate: typeof import("./i18n").t) =>
  tab.titleKey ? translate(tab.titleKey) : tab.title;

const dispatchInputEvent = (el: HTMLInputElement | HTMLTextAreaElement) => {
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const handleEditableShortcut = async (e: KeyboardEvent, target: HTMLElement) => {
  const key = e.key.toLowerCase();
  const isInput =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  if ((e.metaKey || e.ctrlKey) && key === "a") {
    e.preventDefault();
    if (isInput) target.select();
    else document.execCommand("selectAll");
    return;
  }

  if ((e.metaKey || e.ctrlKey) && key === "c") {
    e.preventDefault();
    if (isInput) {
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      await writeText(target.value.slice(start, end));
    } else {
      document.execCommand("copy");
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && key === "x") {
    e.preventDefault();
    if (isInput) {
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      await writeText(target.value.slice(start, end));
      target.setRangeText("", start, end, "start");
      dispatchInputEvent(target);
    } else {
      document.execCommand("cut");
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && key === "v") {
    e.preventDefault();
    if (isInput) {
      const text = await readText();
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      target.setRangeText(text, start, end, "end");
      dispatchInputEvent(target);
    } else {
      document.execCommand("paste");
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === "z") {
    e.preventDefault();
    document.execCommand("undo");
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "z") {
    e.preventDefault();
    document.execCommand("redo");
  }
};


// ── Toolbar SVG icons (stroke-based, transparent background) ─────────────

const TbNote = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 3.5h3.2c.92 0 1.78.36 2.3 1 .52-.64 1.38-1 2.3-1h3.2v8.2h-3.2c-.92 0-1.78.36-2.3 1-.52-.64-1.38-1-2.3-1H2.5z"/>
    <path d="M8 4.5v8.1"/>
  </svg>
);
const TbSftp = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 10.5V3M2.5 5.5L5 3L7.5 5.5"/><path d="M11 5.5V13M8.5 10.5L11 13L13.5 10.5"/>
  </svg>
);
const TbKeyword = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 1.5a4 4 0 0 1 2.5 7.1V10a.5.5 0 0 1-.5.5h-4A.5.5 0 0 1 5.5 10V8.6A4 4 0 0 1 8 1.5z"/>
    <path d="M6 11.5h4M6.5 13h3"/>
  </svg>
);
const TbKey = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="5" r="3"/>
    <path d="M9 7L3 13"/>
    <path d="M6.5 9.5l1.5 1.5M5 11l1.5 1.5"/>
  </svg>
);
const TbSettings = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path fillRule="evenodd" clipRule="evenodd" d="M3.22655 4.36961C2.92233 4.76924 2.66735 5.20781 2.47037 5.67626L3.30992 7.0943C3.6406 7.65283 3.6406 8.34718 3.30992 8.9057L2.47037 10.3237C2.66736 10.7922 2.92233 11.2308 3.22656 11.6304L4.87261 11.6124C5.52165 11.6053 6.12297 11.9524 6.44133 12.5181L7.24899 13.953C7.49593 13.984 7.74792 14 8.00408 14C8.2602 14 8.51214 13.984 8.75904 13.9531L9.56671 12.5181C9.88507 11.9524 10.4864 11.6053 11.1354 11.6124L12.7816 11.6304C13.0858 11.2308 13.3408 10.7923 13.5377 10.3239L12.6981 8.9057C12.3674 8.34718 12.3674 7.65283 12.6981 7.0943L13.5377 5.67613C13.3408 5.20773 13.0858 4.76921 12.7816 4.36961L11.1354 4.38764C10.4864 4.39475 9.88507 4.04758 9.56671 3.48194L8.75904 2.04693C8.51214 2.01599 8.2602 2 8.00408 2C7.74792 2 7.49594 2.016 7.24899 2.04695L6.44133 3.48194C6.12297 4.04758 5.52165 4.39475 4.87261 4.38764L3.22655 4.36961ZM10.655 8.00001C10.655 9.46412 9.46811 10.651 8.004 10.651C6.5399 10.651 5.353 9.46412 5.353 8.00001C5.353 6.53591 6.5399 5.34902 8.004 5.34902C9.46811 5.34902 10.655 6.53591 10.655 8.00001ZM4.88356 3.3877C5.16752 3.39081 5.4306 3.23892 5.56988 2.99146L6.43817 1.44875C6.54914 1.25159 6.7401 1.1101 6.96387 1.07676C7.30327 1.0262 7.65062 1 8.00408 1C8.3575 1 8.7048 1.02619 9.04414 1.07674C9.26792 1.11007 9.45889 1.25157 9.56986 1.44873L10.4382 2.99146C10.5774 3.23892 10.8405 3.39081 11.1245 3.3877L12.8938 3.36832C13.1196 3.36585 13.3372 3.46012 13.4781 3.63661C13.9099 4.17766 14.2632 4.78416 14.5207 5.43884C14.6034 5.6491 14.5763 5.88489 14.4612 6.07931L13.5586 7.60376C13.4139 7.84811 13.4139 8.15189 13.5586 8.39625L14.4612 9.92069C14.5763 10.1151 14.6034 10.3509 14.5207 10.5612C14.2632 11.2158 13.9099 11.8223 13.4781 12.3634C13.3372 12.5399 13.1196 12.6342 12.8938 12.6317L11.1245 12.6123C10.8405 12.6092 10.5774 12.7611 10.4382 13.0085L9.56986 14.5513C9.45889 14.7484 9.26792 14.8899 9.04414 14.9233C8.7048 14.9738 8.3575 15 8.00408 15C7.65062 15 7.30327 14.9738 6.96387 14.9232C6.7401 14.8899 6.54914 14.7484 6.43817 14.5512L5.56988 13.0085C5.4306 12.7611 5.16752 12.6092 4.88356 12.6123L3.1144 12.6317C2.8886 12.6342 2.67096 12.5399 2.5301 12.3634C2.09822 11.8223 1.74489 11.2158 1.48738 10.561C1.40469 10.3508 1.43184 10.115 1.54695 9.92057L2.44942 8.39625C2.5941 8.15189 2.5941 7.84811 2.44942 7.60376L1.54695 6.07944C1.43184 5.88502 1.40469 5.64924 1.48738 5.43898C1.74489 4.78425 2.09822 4.1777 2.53009 3.63661C2.67096 3.46012 2.8886 3.36585 3.1144 3.36832L4.88356 3.3877ZM9.655 8.00001C9.655 8.91183 8.91582 9.65101 8.004 9.65101C7.09218 9.65101 6.353 8.91183 6.353 8.00001C6.353 7.08819 7.09218 6.34902 8.004 6.34902C8.91582 6.34902 9.655 7.08819 9.655 8.00001Z"/>
  </svg>
);

// Window control SVG icons — stroke-based, same style as toolbar icons
const WcMin = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="3.5" y1="8" x2="12.5" y2="8"/>
  </svg>
);
const WcMax = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="10" height="10" rx="1.5"/>
  </svg>
);
const WcRestore = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {/* Back rect: only top + right edges visible above the front rect */}
    <path d="M5.5 4a1.5 1.5 0 0 1 1.5-1.5h4.5a1.5 1.5 0 0 1 1.5 1.5v5.5"/>
    {/* Front rect */}
    <rect x="2.5" y="5.5" width="7.5" height="7.5" rx="1.5"/>
  </svg>
);
const WcClose = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="4" y1="4" x2="12" y2="12"/>
    <line x1="12" y1="4" x2="4" y2="12"/>
  </svg>
);

// Tab terminal icon: >_
const TabTermIcon = () => (
  <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1.5 2L5.5 5.5L1.5 9"/>
    <path d="M7 9h4.5"/>
  </svg>
);
// Tab SFTP icon: transfer arrows
const TabSftpIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8.5V2M2 4L4 2L6 4"/><path d="M9 4.5V11M7 9L9 11L11 9"/>
  </svg>
);

interface ToolAction {
  id: string;
  icon: React.ReactNode;
  title: string;
  disabled?: boolean;
  toggle?: boolean;
}

interface TerminalAPI {
  write: (data: string) => void;
}

const DEFAULT_TERM_SETTINGS: TerminalSettings = {
  font: "",
  fallbackFont: "",
  fontSize: 14,
  maxRows: 5000,
  startupLogs: false,
  cursorBlink: true,
  cursorStyle: "block",
  selectCopy: false,
  rightClick: "Menu",
  hyperlink: true,
  localShell: "",
  autoReconnect: false,
};

const DEFAULT_SFTP_SETTINGS: SftpSettings = {
  doubleClick:   "Transfer",
  editCommand:   "",
  preserveMtime: true,
  pinTab:        false,
  defaultDir:    "",
  clearDone:     false,
};

// ---------------------------------------------------------------------------
// Sysbar drag-resize handle
// ---------------------------------------------------------------------------

function SysbarResizer({
  sysbarWidth,
  onWidthChange,
}: {
  sysbarWidth: number;
  onWidthChange: (w: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sysbarWidth;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // drag left = widen sidebar
      onWidthChange(Math.max(220, Math.min(700, startW + delta)));
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`sysbar-resizer${dragging ? " sysbar-resizer--active" : ""}`}
      onMouseDown={onMouseDown}
    />
  );
}

// ---------------------------------------------------------------------------
// Note drawer drag-resize handle
// ---------------------------------------------------------------------------

function NoteDrawerResizer({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (w: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // drag left = widen panel
      onWidthChange(Math.max(320, Math.min(900, startW + delta)));
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`note-drawer-resizer${dragging ? " note-drawer-resizer--active" : ""}`}
      onMouseDown={onMouseDown}
    />
  );
}

function HostDrawerResizer({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (w: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      onWidthChange(Math.max(360, Math.min(960, startW + delta)));
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`host-drawer-resizer${dragging ? " host-drawer-resizer--active" : ""}`}
      onMouseDown={onMouseDown}
    />
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const t = useT();
  const appWindow = getCurrentWindow();
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || "");

  // Tab bar — refs & state (effects registered after activeId below)
  const tabsScrollRef   = useRef<HTMLDivElement>(null);
  const dropdownBtnRef  = useRef<HTMLButtonElement>(null);
  const dropdownPanelRef = useRef<HTMLDivElement>(null);
  const dragTabId       = useRef<string | null>(null);

  const [hasOverflow,   setHasOverflow]   = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight,setCanScrollRight]= useState(false);
  const [hiddenTabIds,  setHiddenTabIds]  = useState<Set<string>>(new Set());
  const [dropdownOpen,  setDropdownOpen]  = useState(false);
  const [dropdownPos,   setDropdownPos]   = useState({ top: 0, right: 0 });
  const [dragOverId,    setDragOverId]    = useState<string | null>(null);
  const [dragSrcId,     setDragSrcId]     = useState<string | null>(null);

  const { confirmState, confirm, handleOk, handleCancel } = useConfirm();

  const updateTabScroll = useCallback(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;

    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);

    // Measure only .tab elements (not .tab-add) to avoid circular dependency.
    let totalTabW = 0;
    el.querySelectorAll<HTMLElement>(".tab").forEach(t => { totalTabW += t.offsetWidth; });
    setHasOverflow(totalTabW > clientWidth);

    const hidden = new Set<string>();
    el.querySelectorAll<HTMLElement>("[data-tabid]").forEach(tabEl => {
      const l = tabEl.offsetLeft;
      const r = l + tabEl.offsetWidth;
      if (r <= scrollLeft + 4 || l >= scrollLeft + clientWidth - 4)
        hidden.add(tabEl.dataset.tabid!);
    });
    setHiddenTabIds(hidden);
  }, []);

  const onTabsWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    tabsScrollRef.current?.scrollBy({ left: e.deltaY || e.deltaX, behavior: "auto" });
  };

  const openTabDropdown = () => {
    const rect = dropdownBtnRef.current?.getBoundingClientRect();
    if (rect) setDropdownPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
    setDropdownOpen(o => !o);
  };

  // Pointer-based tab drag with ghost element for visual feedback
  const startTabDrag = useCallback((e: React.PointerEvent, tabId: string) => {
    if (tabId === WELCOME_ID) return;
    // Ignore clicks on buttons inside the tab (e.g. close ×) — they handle their own events.
    // Also: calling preventDefault() on pointerdown suppresses mousedown per spec,
    // so we must not call it for button targets.
    if ((e.target as Element).closest("button")) return;
    dragTabId.current = tabId;
    setDragSrcId(tabId);

    e.preventDefault(); // prevent text-selection / native drag on tab body only

    const srcEl  = e.currentTarget as HTMLElement;
    const rect   = srcEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    // Clone the tab node as a drag ghost
    const ghost = srcEl.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-tooltip");
    Object.assign(ghost.style, {
      position:        "fixed",
      pointerEvents:   "none",
      zIndex:          "99999",
      width:           `${rect.width}px`,
      height:          `${rect.height}px`,
      top:             `${rect.top}px`,
      left:            `${rect.left}px`,
      opacity:         "0.88",
      borderRadius:    "6px 6px 0 0",
      boxShadow:       "0 6px 24px rgba(0,0,0,0.55)",
      transform:       "scale(1.05)",
      transformOrigin: "center bottom",
      transition:      "none",
      cursor:          "grabbing",
      background:      "var(--panel)",
    });
    document.body.appendChild(ghost);
    document.body.style.cursor = "grabbing";

    const onMove = (ev: PointerEvent) => {
      ghost.style.left = `${ev.clientX - offsetX}px`;
      ghost.style.top  = `${ev.clientY - offsetY}px`;
      // ghost has pointer-events:none so elementFromPoint sees through it
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const overEl = under?.closest<HTMLElement>("[data-tabid]");
      const overId = overEl?.dataset.tabid ?? null;
      setDragOverId(prev => prev === overId ? prev : overId);
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      ghost.remove();
      document.body.style.cursor = "";

      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const overEl = under?.closest<HTMLElement>("[data-tabid]");
      const toId   = overEl?.dataset.tabid ?? null;
      const fromId = dragTabId.current;

      if (fromId && toId && fromId !== toId) {
        setTabs(prev => {
          const arr = [...prev];
          const fi = arr.findIndex(t => t.id === fromId);
          const ti = arr.findIndex(t => t.id === toId);
          if (fi === -1 || ti === -1) return prev;
          const [item] = arr.splice(fi, 1);
          arr.splice(ti, 0, item);
          return arr;
        });
      }
      dragTabId.current = null;
      setDragSrcId(null);
      setDragOverId(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // Explicit horizontal scroll — scrollIntoView(inline:nearest) is unreliable here.
  const scrollTabIntoView = useCallback((tabId: string) => {
    const c = tabsScrollRef.current;
    if (!c) return;
    const el = c.querySelector<HTMLElement>(`[data-tabid="${tabId}"]`);
    if (!el) return;
    const { offsetLeft: l, offsetWidth: w } = el;
    if (l < c.scrollLeft) {
      c.scrollLeft = l - 4;
    } else if (l + w > c.scrollLeft + c.clientWidth) {
      c.scrollLeft = l + w - c.clientWidth + 4;
    }
  }, []);

  // System sidebar (process / docker) per SSH tab
  const [sysTabId,      setSysTabId]     = useState<string | null>(null);
  const [sysbarWidth,   setSysbarWidth]  = useState(420);

  // Per-tab search state
  type FindApi = { findNext: (q: string) => void; findPrev: (q: string) => void; clearHighlight: () => void };
  const findApisRef                        = useRef(new Map<string, FindApi>());
  const [tabSearchOpen,  setTabSearchOpen]  = useState<Record<string, boolean>>({});
  const [tabSearchQuery, setTabSearchQuery] = useState<Record<string, string>>({});

  // Sidebar
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth]     = useState(220);
  const [layoutMode, setLayoutMode] = useState<"Fence" | "Screen" | "Grid">("Fence");

  // Appearance behaviour
  const [backgroundRunning, setBackgroundRunning] = useState(true);
  const [confirmClose,       setConfirmClose]      = useState(true);
  const backgroundRunningRef = useRef(true);

  // Tabs
  const [tabs, setTabs] = useState<Tab[]>([
    { id: WELCOME_ID, kind: "welcome", title: "Home", titleKey: "app.tab.home" },
  ]);
  const [activeId, setActiveId] = useState(WELCOME_ID);

  // Recently-active tab stack (MRU) so closing the active tab jumps back to the
  // previously-viewed one, like browsers/IDEs do. Maintained by the effect below.
  const [recentActive, setRecentActive] = useState<string[]>([WELCOME_ID]);

  // Tab bar effects (after activeId)
  useEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateTabScroll, { passive: true });
    const ro = new ResizeObserver(updateTabScroll);
    ro.observe(el);
    updateTabScroll();
    return () => { el.removeEventListener("scroll", updateTabScroll); ro.disconnect(); };
  }, [updateTabScroll]);

  useEffect(() => {
    scrollTabIntoView(activeId);
    updateTabScroll();
  }, [activeId, scrollTabIntoView, updateTabScroll]);

  // Track recently-active tabs (MRU stack) whenever the active tab changes.
  useEffect(() => {
    setRecentActive((prev) => {
      const filtered = prev.filter((id) => id !== activeId);
      return [activeId, ...filtered].slice(0, 16);
    });
  }, [activeId]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownBtnRef.current?.contains(e.target as Node) ||
        dropdownPanelRef.current?.contains(e.target as Node)
      ) return;
      setDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // Re-check overflow after tabs list changes (DOM not yet updated → wait a frame).
  useEffect(() => {
    const id = requestAnimationFrame(updateTabScroll);
    return () => cancelAnimationFrame(id);
  }, [tabs, updateTabScroll]);

  // Hosts
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsVersion, setHostsVersion] = useState(0);

  // Terminal settings (loaded from store)
  const [termSettings, setTermSettings] = useState<TerminalSettings>(DEFAULT_TERM_SETTINGS);

  // SFTP / transfer settings (loaded from store)
  const [sftpSettings, setSftpSettings] = useState<SftpSettings>(DEFAULT_SFTP_SETTINGS);

  // Keyword highlights (loaded from store)
  const [highlights, setHighlights] = useState<KeywordHighlight[]>([]);


  // Fullscreen
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Maximized state (tracked for icon/tooltip switching on the max/restore button)
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  // Split terminal: tabId → "H" (horizontal, two columns) | "V" (vertical, two rows)
  const [splitMap, setSplitMap] = useState<Record<string, "H" | "V">>({});
  // Split sizes: tabId → primary pane % (default 50)
  const splitSizes = useRef<Record<string, number>>({});

  // Terminal write API map (tab id → API)
  const termApis = useRef<Map<string, TerminalAPI>>(new Map());
  const termCwds = useRef<Map<string, string>>(new Map());

  // Media query listener for "follow system" theme
  const sysMQ = useRef<MediaQueryList | null>(null);
  const sysMQFn = useRef<((e: MediaQueryListEvent) => void) | null>(null);

  const applyOpacity = useCallback((opacity: number) => {
    invoke("window_set_opacity", { opacity }).catch(() => {});
  }, []);

  const applyTheme = useCallback((theme: string) => {
    if (sysMQ.current && sysMQFn.current) {
      sysMQ.current.removeEventListener("change", sysMQFn.current);
      sysMQ.current = null; sysMQFn.current = null;
    }
    const set = (t: "dark" | "light") => {
      document.documentElement.dataset.theme = t;
      setUiTheme(t);
    };
    if (theme === "System") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const fn = (e: MediaQueryListEvent) => set(e.matches ? "light" : "dark");
      sysMQ.current = mq; sysMQFn.current = fn;
      mq.addEventListener("change", fn);
      set(mq.matches ? "light" : "dark");
    } else {
      set(theme === "Light" ? "light" : "dark");
    }
  }, []);

  // Dialogs
  const [hostDialogSeed, setHostDialogSeed] = useState<Host | undefined>();
  const [showHostDialog, setShowHostDialog] = useState(false);
  const [hostDialogMode, setHostDialogMode] = useState<"dialog" | "drawer">("dialog");
  const [hostDrawerWidth, setHostDrawerWidth] = useState(460);
  const [showNewGroupDialog, setShowNewGroupDialog] = useState(false);
  const [newTermOpen, setNewTermOpen] = useState(false);
  const [showKeyMgr, setShowKeyMgr] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [uiTheme, setUiTheme] = useState<"dark" | "light">("dark");
  const [showNote, setShowNote] = useState(false);
  const [noteDrawerWidth, setNoteDrawerWidth] = useState(700);
  // Panel mode only for terminal tabs (ssh/local/telnet); sftp and welcome use dialog
  const isNotePanel = showNote && ["ssh", "local", "telnet"].includes(tabs.find(t => t.id === activeId)?.kind ?? "");
  const [showHighlight, setShowHighlight] = useState(false);

  // Connection error toast (for unsupported protocols, etc.)
  const [connectError, setConnectError] = useState<string | null>(null);

  // SFTP auto-connect (triggered when switching to transfer tab from a terminal)
  const [sftpAutoConnect, setSftpAutoConnect] = useState<{
    host: Host; sessionId: string; startDir: string; nonce: number;
  } | null>(null);
  // FTP (and other transfer-protocol) host to connect into the pinned transfer tab.
  const [transferConnectHost, setTransferConnectHost] = useState<{ host: Host; nonce: number } | null>(null);
  // Stable callback so React.memo(SftpView) is not broken by a new function on every render.
  const onAutoConnectDoneCb = useCallback(() => setSftpAutoConnect(null), []);

  // ---------------------------------------------------------------------------
  // Load hosts
  // ---------------------------------------------------------------------------

  const reloadHosts = useCallback(async () => {
    try {
      const list = await invoke<Host[]>("host_list");
      setHosts(list);
    } catch { /**/ }
  }, []);

  useEffect(() => { reloadHosts(); }, [reloadHosts, hostsVersion]);

  // ---------------------------------------------------------------------------
  // Load appearance settings on startup
  // ---------------------------------------------------------------------------

  // Persist the maximized state so windowInit can restore it on the next launch.
  // Keep `ready` false until windowReady finishes so startup maximize/resize
  // does not overwrite the saved value with a stale `false`.
  useEffect(() => {
    const win = getCurrentWindow();
    let ready = false;
    windowReady.finally(() => {
      ready = true;
      // Initialize icon state once the window is in its final position
      win.isMaximized().then(setIsWindowMaximized).catch(() => {});
      // Restore host tree expanded state from DB
      void loadTreeExpanded();
    });

    const onResize = () => {
      if (!ready) return;
      win.isMaximized().then(v => {
        invoke("settings_set", { key: "app.wasMaximized", value: String(v) }).catch(() => {});
        setIsWindowMaximized(v);
      }).catch(() => {});
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Fade out the loading screen once React has mounted and window state is restored.
  useEffect(() => {
    const ls = document.getElementById("loading-screen");
    if (!ls) return;
    windowReady.finally(() => {
      ls.classList.add("fade-out");
      setTimeout(() => ls.remove(), 280);
    });
  }, []);

  useEffect(() => {
    // Language
    invoke<string | null>("settings_get", { key: "Setting.Appearance.language" })
      .then(val => { if (val) setLang(val); })
      .catch(() => {});

    // Layout
    invoke<string | null>("settings_get", { key: "Setting.Appearance.layout" })
      .then((val) => {
        const mode = val === "Screen" || val === "Grid" ? val : "Fence";
        setLayoutMode(mode);
        setSidebarVisible(mode === "Fence");
      })
      .catch(() => {});

    // Theme
    invoke<string>("settings_get", { key: "Setting.Appearance.theme" })
      .then((t) => applyTheme(t || "Dark"))
      .catch(() => applyTheme("Dark"));

    // Opacity
    invoke<string | null>("settings_get", { key: "Setting.Appearance.opacity" })
      .then(val => { const n = parseFloat(val ?? ""); if (!isNaN(n)) applyOpacity(n); })
      .catch(() => {});

    // Background running / confirm close
    invoke<string | null>("settings_get", { key: "Setting.Appearance.backgroundRunning" })
      .then(val => { if (val !== null) { const v = val !== "false"; backgroundRunningRef.current = v; setBackgroundRunning(v); } })
      .catch(() => {});
    invoke<string | null>("settings_get", { key: "Setting.Appearance.confirmClose" })
      .then(val => { if (val !== null) setConfirmClose(val !== "false"); })
      .catch(() => {});

    // Initial fullscreen state
    appWindow.isFullscreen().then(setIsFullscreen).catch(() => {});
  }, [applyTheme, applyOpacity]);

  // ---------------------------------------------------------------------------
  // Background running — intercept window close
  // ---------------------------------------------------------------------------

  // Keep ref in sync so onCloseRequested always reads the latest value.
  backgroundRunningRef.current = backgroundRunning;

  // Single permanent handler — reads from ref, never stale.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    win.onCloseRequested(async (event) => {
      if (backgroundRunningRef.current) {
        event.preventDefault();
        await win.hide();
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // register once; state is read via ref

  // Custom close button uses an explicit path because `close()` can feel
  // unreliable in `tauri dev` when the close-request event chain is involved.
  const handleWindowClose = useCallback(async () => {
    if (backgroundRunningRef.current) {
      await appWindow.hide();
      toast("Netape is still running in the background.");
      return;
    }
    await appWindow.destroy();
  }, []);

  // ---------------------------------------------------------------------------
  // Load terminal settings & highlights on start
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const KEYS: Array<[keyof TerminalSettings, string]> = [
      ["font",        "Setting.Terminal.font"],
      ["fontSize",    "Setting.Terminal.fontSize"],
      ["maxRows",     "Setting.Terminal.maxRows"],
      ["startupLogs", "Setting.Terminal.startupLogs"],
      ["cursorBlink",    "Setting.Terminal.cursorBlink"],
      ["cursorStyle",    "Setting.Terminal.cursorStyle"],
      ["hyperlink",      "Setting.Terminal.hyperlink"],
      ["localShell",     "Setting.Terminal.localShell"],
      ["autoReconnect",  "Setting.Terminal.autoReconnect"],
    ];
    Promise.all(KEYS.map(([, k]) => invoke<string>("settings_get", { key: k }).catch(() => "")))
      .then((vals) => {
        setTermSettings((prev) => {
          const next = { ...prev };
          KEYS.forEach(([field], i) => {
            const v = vals[i];
            if (!v) return;
            if (field === "fontSize") (next as Record<string, unknown>)[field] = parseInt(v, 10) || 14;
            else if (field === "maxRows") (next as Record<string, unknown>)[field] = parseInt(v, 10) || 5000;
            else if (field === "startupLogs" || field === "cursorBlink" || field === "autoReconnect") (next as Record<string, unknown>)[field] = v === "true";
            else (next as Record<string, unknown>)[field] = v;
          });
          return next;
        });
      });
  }, []);

  useEffect(() => {
    const SFTP_KEYS: Array<[keyof SftpSettings, string]> = [
      ["doubleClick",   "Setting.SFTP.doubleClick"],
      ["editCommand",   "Setting.SFTP.editCommand"],
      ["preserveMtime", "Setting.SFTP.preserveMtime"],
      ["pinTab",        "Setting.SFTP.pinTab"],
      ["defaultDir",    "Setting.SFTP.defaultDir"],
      ["clearDone",     "Setting.SFTP.clearDone"],
    ];
    Promise.all(SFTP_KEYS.map(([, k]) => invoke<string>("settings_get", { key: k }).catch(() => "")))
      .then((vals) => {
        setSftpSettings((prev) => {
          const next = { ...prev };
          SFTP_KEYS.forEach(([field], i) => {
            const v = vals[i];
            if (!v) return;
            if (field === "preserveMtime" || field === "pinTab" || field === "clearDone")
              (next as Record<string, unknown>)[field] = v === "true";
            else
              (next as Record<string, unknown>)[field] = v;
          });
          return next;
        });
      });
  }, []);

  // Keep the transfer tab pinned on the right when the setting is enabled.
  useEffect(() => {
    if (sftpSettings.pinTab) {
      setTabs(prev => {
        if (prev.find(t => t.id === SFTP_PIN_ID)) return prev;
        return [...prev, { id: SFTP_PIN_ID, kind: "sftp", title: "Transfer", titleKey: "app.tab.transfer", pinned: true }];
      });
    } else {
      // Unpin the tab when the setting is disabled, but keep the tab open.
      setTabs(prev => prev.map(t => t.id === SFTP_PIN_ID ? { ...t, pinned: false } : t));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpSettings.pinTab]);

  const reloadHighlights = useCallback(async () => {
    try {
      const list = await invoke<KeywordHighlight[]>("highlight_list");
      setHighlights(list.filter((h) => h.enabled));
    } catch { /**/ }
  }, []);

  useEffect(() => { reloadHighlights(); }, [reloadHighlights]);

  // Load installed plugins so plugin-provided protocols (e.g. FTP) only appear
  // in the pickers once their plugin is installed.
  useEffect(() => {
    invoke<{ protocol?: string }[]>("plugins_list")
      .then(setInstalledPluginProtocols)
      .catch(() => { /* none */ });
  }, []);

  // ---------------------------------------------------------------------------
  // React to settings changes in real-time (callback from SettingsDialog)
  // ---------------------------------------------------------------------------

  const handleSettingApply = useCallback((key: string, value: string) => {
    if (key === "Setting.Appearance.language") {
      setLang(value);
    }
    if (key === "Setting.Appearance.theme") {
      applyTheme(value);
    }
    // Layout: Fence keeps the sidebar visible; Screen hides it.
    if (key === "Setting.Appearance.opacity") {
      const n = parseFloat(value);
      if (!isNaN(n)) applyOpacity(n);
    }
    if (key === "Setting.Appearance.backgroundRunning") {
      const v = value !== "false";
      backgroundRunningRef.current = v;
      setBackgroundRunning(v);
    }
    if (key === "Setting.Appearance.confirmClose") {
      setConfirmClose(value !== "false");
    }
    if (key === "Setting.Appearance.layout") {
      const mode = value === "Screen" || value === "Grid" ? value : "Fence";
      setLayoutMode(mode);
      setSidebarVisible(mode === "Fence");
    }
    // Terminal font/size/cursor → update live
    if (key === "Setting.Terminal.font") {
      setTermSettings((p) => ({ ...p, font: value }));
    }
    if (key === "Setting.Terminal.fontSize") {
      const n = parseInt(value, 10);
      if (n > 0) setTermSettings((p) => ({ ...p, fontSize: n }));
    }
    if (key === "Setting.Terminal.maxRows") {
      const n = parseInt(value, 10);
      if (n > 0) setTermSettings((p) => ({ ...p, maxRows: n }));
    }
    if (key === "Setting.Terminal.startupLogs") {
      setTermSettings((p) => ({ ...p, startupLogs: value === "true" }));
    }
    if (key === "Setting.Terminal.cursorBlink") {
      setTermSettings((p) => ({ ...p, cursorBlink: value === "true" }));
    }
    if (key === "Setting.Terminal.cursorStyle") {
      setTermSettings((p) => ({ ...p, cursorStyle: value }));
    }
    if (key === "Setting.Terminal.localShell") {
      setTermSettings((p) => ({ ...p, localShell: value }));
    }
    if (key === "Setting.Terminal.autoReconnect") {
      setTermSettings((p) => ({ ...p, autoReconnect: value === "true" }));
    }
    if (key === "Setting.SFTP.doubleClick") {
      setSftpSettings((p) => ({ ...p, doubleClick: value }));
    }
    if (key === "Setting.SFTP.editCommand") {
      setSftpSettings((p) => ({ ...p, editCommand: value }));
    }
    if (key === "Setting.SFTP.preserveMtime") {
      setSftpSettings((p) => ({ ...p, preserveMtime: value === "true" }));
    }
    if (key === "Setting.SFTP.pinTab") {
      setSftpSettings((p) => ({ ...p, pinTab: value === "true" }));
    }
    if (key === "Setting.SFTP.defaultDir") {
      setSftpSettings((p) => ({ ...p, defaultDir: value }));
    }
    if (key === "Setting.SFTP.clearDone") {
      setSftpSettings((p) => ({ ...p, clearDone: value === "true" }));
    }
  }, [applyTheme, applyOpacity]);

  // ---------------------------------------------------------------------------
  // Sidebar resize
  // ---------------------------------------------------------------------------

  const onSidebarResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(140, Math.min(480, startW + ev.clientX - startX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    document.body.style.cursor = "col-resize";
  }, [sidebarWidth]);

  const toggleSidebar = useCallback(async () => {
    const next = !sidebarVisible;
    setSidebarVisible(next);
    if (next && isFullscreen) {
      // Exit fullscreen when the sidebar becomes visible.
      try {
        await appWindow.setFullscreen(false);
        setIsFullscreen(false);
      } catch { /**/ }
    }
  }, [sidebarVisible, isFullscreen]);

  // ---------------------------------------------------------------------------
  // Fullscreen
  // ---------------------------------------------------------------------------

  // Remembers whether sidebar was visible before entering fullscreen
  const sidebarBeforeFullscreen = useRef(true);

  const toggleFullscreen = useCallback(async () => {
    try {
      const full = await appWindow.isFullscreen();
      const entering = !full;
      await appWindow.setFullscreen(entering);
      setIsFullscreen(entering);
      if (entering) {
        // Save sidebar state and hide it; also close any active split
        sidebarBeforeFullscreen.current = sidebarVisible;
        setSidebarVisible(false);
        setSplitMap((prev) => {
          if (Object.keys(prev).length === 0) return prev;
          const next = { ...prev };
          Object.keys(next).forEach((id) => termApis.current.delete(`${id}:split`));
          return {};
        });
      } else {
        // Restore sidebar
        setSidebarVisible(sidebarBeforeFullscreen.current);
      }
    } catch { /**/ }
  }, [sidebarVisible]);

  // ---------------------------------------------------------------------------
  // Split terminal
  // ---------------------------------------------------------------------------

  const handleSplit = useCallback((dir: "H" | "V" = "H") => {
    const activeTab = tabs.find((t) => t.id === activeId);
    if (!activeTab || activeTab.kind === "welcome") return;

    setSplitMap((prev) => {
      const next = { ...prev };
      if (next[activeId]) {
        // Already split → close it
        delete next[activeId];
        termApis.current.delete(`${activeId}:split`);
      } else {
        next[activeId] = dir;
      }
      return next;
    });
  }, [activeId, tabs]);

  const closeSplit = useCallback((tabId: string) => {
    setSplitMap((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    termApis.current.delete(`${tabId}:split`);
  }, []);

  // Never keep the welcome page active while a split pane is open.
  useEffect(() => {
    if (activeId !== WELCOME_ID) return;
    const splitTab = tabs.find((t) => splitMap[t.id]);
    if (splitTab) setActiveId(splitTab.id);
  }, [splitMap, activeId, tabs]);

  const onSplitDividerMouseDown = (tabId: string, dir: "H" | "V") => (e: React.MouseEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement!;
    const startPos = dir === "H" ? e.clientX : e.clientY;
    const containerPx = dir === "H" ? container.offsetWidth : container.offsetHeight;
    const startPct = splitSizes.current[tabId] ?? 50;

    const onMove = (ev: MouseEvent) => {
      const delta = (dir === "H" ? ev.clientX : ev.clientY) - startPos;
      const pct = Math.max(20, Math.min(80, startPct + (delta / containerPx) * 100));
      splitSizes.current[tabId] = pct;
      const el = document.querySelector<HTMLElement>(`[data-split="${tabId}"]`);
      if (el) el.style.setProperty("--split-size", `${pct}%`);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = dir === "H" ? "col-resize" : "row-resize";
  };

  // ---------------------------------------------------------------------------
  // Window drag via startDragging()
  // ---------------------------------------------------------------------------

  const handleTabbarMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".tab, button, .winctrls, .wctrl, .tabbar-actions, .tbaction, .tabbar-new")) return;
    appWindow.startDragging().catch(() => {});
  };

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  // Refs so the keydown handler can call functions defined later in the file
  const removeTabRef = useRef<(id: string) => void>(() => {});
  const activateSftpTabRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const reconnectCurrentRef = useRef<() => void>(() => {});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = (document.activeElement as HTMLElement | null) ?? (e.target as HTMLElement | null);
      const isEditable = !!target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );
      if (isEditable) {
        if (e.metaKey || e.ctrlKey) {
          void handleEditableShortcut(e, target);
          return;
        }
        if (e.key === "F11") {
          e.preventDefault();
          toggleFullscreen();
        }
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      // Ctrl+N: create a new host
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const proto = "SSH";
        const defaultPort = getProtocol(proto)?.defaultPort ?? 22;
        setNewHostProtocol(proto);
        setHostDialogSeed({ id: crypto.randomUUID(), name: "", protocol: proto, host: "", port: defaultPort, username: "", remark: "",
          authentication: { type: "Password", password: "" },
          proxy: { type: "NO", host: "", port: 7890, authenticationType: "No", username: "", password: "" },
          options: { encoding: "UTF-8", heartbeatInterval: 30, tags: [], extras: {}, startupCommand: "", env: "", jumpHosts: [], sftpDefaultDirectory: "" },
          tunnelings: [], sort: 0, parentId: "0", ownerId: "0", creatorId: "0", ownerType: "", deleted: false, createDate: 0, updateDate: 0 });
        setHostDialogMode("dialog");
        setShowHostDialog(true);
      }
      // Ctrl+W: close the current tab
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeId === WELCOME_ID) return;
        const tab = tabs.find((t) => t.id === activeId);
        if (!tab || tab.pinned) return;
        (async () => {
          if (confirmClose) {
            const ok = await confirm(t("app.confirm.closeTab"));
            if (!ok) return;
          }
          removeTabRef.current(activeId);
        })();
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: switch tabs
      if (ctrl && e.key === "Tab") {
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (e.shiftKey) {
          const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
          if (prev) setActiveId(prev.id);
        } else {
          const next = tabs[(idx + 1) % tabs.length];
          if (next) setActiveId(next.id);
        }
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "g") { e.preventDefault(); activateSftpTabRef.current(); }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); setShowKeyMgr(true); }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); setShowSettings(true); }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); setShowNote(true); }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); setShowHighlight(true); }
      if (ctrl && e.key.toLowerCase() === "t") { e.preventDefault(); openLocalTerminal(); }
      // Ctrl+R: reconnect the current SSH / Telnet tab
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        reconnectCurrentRef.current();
      }
      // F11: toggle fullscreen
      if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
      // Alt+\ for horizontal split / Alt+- for vertical split
      if (e.altKey && e.key === "\\") { e.preventDefault(); handleSplit("H"); }
      if (e.altKey && e.key === "-") { e.preventDefault(); handleSplit("V"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, toggleFullscreen, handleSplit, tabs, activeId, confirmClose, confirm]);

  // ---------------------------------------------------------------------------
  // Terminal API registration
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // SSH connection helper (shared by openHost & reconnect)
  // ---------------------------------------------------------------------------

  const buildSshParams = (host: Host) => ({
    host: host.host,
    port: host.port,
    username: host.username,
    authType: host.authentication.type,
    password: host.authentication.password || undefined,
    rows: 24,
    cols: 80,
    heartbeat: host.options.heartbeatInterval || undefined,
    env: host.options.env || undefined,
    startupCmd: host.options.startupCommand || undefined,
    encoding: host.options.encoding || undefined,
    proxyType: host.proxy.type !== "NO" ? host.proxy.type : undefined,
    proxyHost: host.proxy.host || undefined,
    proxyPort: host.proxy.port || undefined,
    proxyUser: host.proxy.username || undefined,
    proxyPass: host.proxy.password || undefined,
    jumpHostIds: host.options.jumpHosts.length > 0 ? host.options.jumpHosts : undefined,
    tunnelings: host.tunnelings.length > 0 ? host.tunnelings : undefined,
  });

  const buildTelnetParams = (host: Host) => ({
    host: host.host,
    port: host.port,
    rows: 24,
    cols: 80,
    encoding: host.options.encoding || undefined,
    proxyType: host.proxy.type !== "NO" ? host.proxy.type : undefined,
    proxyHost: host.proxy.host || undefined,
    proxyPort: host.proxy.port || undefined,
    proxyUser: host.proxy.username || undefined,
    proxyPass: host.proxy.password || undefined,
  });

  // Shared connect flow for ssh/telnet: invoke backend, animate overlay, then
  // switch the tab to its terminal once the session id is ready.
  const connectTransport = useCallback(async (
    tabId: string,
    command: string,
    params: Record<string, unknown>,
    closeCmd: string,
  ) => {
    try {
      const sessionId = await invoke<string>(command, { params });
      setTabs((prev) => {
        if (!prev.some((t) => t.id === tabId)) {
          invoke(closeCmd, { sessionId }).catch(() => {});
          return prev;
        }
        return prev.map((t) => t.id === tabId ? { ...t, sshCompleting: true } : t);
      });
      await new Promise<void>((r) => setTimeout(r, 450));
      setTabs((prev) => {
        if (!prev.some((t) => t.id === tabId)) return prev;
        return prev.map((t) => t.id === tabId
          ? { ...t, sessionId, sshError: undefined, sshCompleting: false, disconnected: false }
          : t
        );
      });
      return true;
    } catch (e) {
      setTabs((prev) => prev.map((t) =>
        t.id === tabId ? { ...t, sshError: String(e), sessionId: undefined, sshCompleting: false } : t
      ));
      return false;
    }
  }, []);

  const connectTelnet = useCallback((tabId: string, host: Host) =>
    connectTransport(tabId, "telnet_connect", buildTelnetParams(host), "telnet_close"),
    [connectTransport]);

  const connectSsh = useCallback(async (tabId: string, host: Host) => {
    try {
      const sessionId = await invoke<string>("ssh_connect", { params: buildSshParams(host) });
      // Signal overlay to animate to 100% first
      setTabs((prev) => {
        if (!prev.some((t) => t.id === tabId)) {
          invoke("ssh_close", { sessionId }).catch(() => {});
          return prev;
        }
        return prev.map((t) => t.id === tabId ? { ...t, sshCompleting: true } : t);
      });
      // Wait for the fill animation to finish, then switch to terminal
      await new Promise<void>((r) => setTimeout(r, 450));
      setTabs((prev) => {
        if (!prev.some((t) => t.id === tabId)) return prev;
        return prev.map((t) => t.id === tabId
          ? { ...t, sessionId, sshError: undefined, sshCompleting: false, disconnected: false }
          : t
        );
      });
      return true;
    } catch (e) {
      setTabs((prev) => prev.map((t) =>
        t.id === tabId ? { ...t, sshError: String(e), sessionId: undefined, sshCompleting: false } : t
      ));
      return false;
    }
  }, []);

  // Auto-reconnect on session drop: up to 3 attempts with 1 s / 2 s / 3 s
  // delays.  Shows the connecting overlay while retrying; after 3 failures the
  // overlay stays on the error state with the manual reconnect button.
  const autoReconnect = useCallback(async (
    tabId: string, host: Host, transport: "ssh" | "telnet",
  ) => {
    for (let i = 1; i <= 3; i++) {
      await new Promise<void>(r => setTimeout(r, 1000 * i));
      // Reset to connecting overlay before each attempt
      setTabs(prev => prev.map(t => t.id === tabId
        ? { ...t, sessionId: undefined, sshError: undefined, sshCompleting: false, disconnected: false }
        : t
      ));
      const ok = transport === "telnet"
        ? await connectTelnet(tabId, host)
        : await connectSsh(tabId, host);
      if (ok) return;
      // Brief pause to let the user read the error before the next attempt
      if (i < 3) await new Promise<void>(r => setTimeout(r, 800));
    }
    // All 3 attempts failed — the overlay already shows sshError + manual reconnect button
  }, [connectSsh, connectTelnet]);

  reconnectCurrentRef.current = () => {
    const tab = tabs.find(t => t.id === activeId);
    if (!tab || tab.kind !== "ssh" || !tab.host) return;
    if (tab.sessionId) {
      const cmd = tab.transport === "telnet" ? "telnet_close" : "ssh_close";
      invoke(cmd, { sessionId: tab.sessionId }).catch(() => {});
    }
    setTabs(prev => prev.map(t => t.id === activeId
      ? { ...t, sessionId: undefined, sshError: undefined, sshCompleting: false, disconnected: false }
      : t
    ));
    if (tab.transport === "telnet") connectTelnet(tab.id, tab.host!);
    else connectSsh(tab.id, tab.host!);
  };

  // ---------------------------------------------------------------------------
  // Open host
  // ---------------------------------------------------------------------------

  const openHost = useCallback(async (host: Host) => {
    if (host.protocol.toUpperCase() === "FOLDER") return;

    const def = getProtocol(host.protocol);
    if (!def || def.tab.kind === "unsupported") {
      setConnectError(t("app.protocol.unsupported", { protocol: host.protocol }));
      return;
    }

    const id = uid();
    if (def.tab.kind === "local") {
      setTabs((prev) => [...prev, { id, kind: "local", title: host.name, protocol: host.protocol, host }]);
      setActiveId(id);
      return;
    }

    // Transfer protocol (FTP plugin) -> connect into the shared transfer tab's
    // right (remote) pane instead of opening a new tab.
    if (def.tab.kind === "transfer") {
      setTabs((prev) =>
        prev.find((t) => t.id === SFTP_PIN_ID)
          ? prev
          : [...prev, { id: SFTP_PIN_ID, kind: "sftp", title: "Transfer", titleKey: "app.tab.transfer", pinned: sftpSettings.pinTab }]);
      setActiveId(SFTP_PIN_ID);
      setTransferConnectHost({ host, nonce: Date.now() });
      return;
    }

    // Network terminal (ssh / telnet)
    const transport = def.tab.transport;
    setTabs((prev) => [...prev, {
      id, kind: "ssh", title: host.name, protocol: host.protocol, host, transport,
    }]);
    setActiveId(id);
    if (transport === "telnet") connectTelnet(id, host);
    else connectSsh(id, host);
  }, [connectSsh, connectTelnet, sftpSettings.pinTab]);

  // ---------------------------------------------------------------------------
  // Local terminal
  // ---------------------------------------------------------------------------

  const openLocalTerminal = () => {
    const id = uid();
    setTabs((prev) => [...prev, { id, kind: "local", title: "Local Terminal", titleKey: "app.tab.localTerminal", protocol: "Local" }]);
    setActiveId(id);
  };

  // ---------------------------------------------------------------------------
  // Close tab
  // ---------------------------------------------------------------------------

  const removeTab = useCallback((id: string) => {
    if (id === WELCOME_ID) return;
    const closing = tabs.find((t) => t.id === id);
    if (closing?.pinned) return;
    const closingTab = tabs.find((t) => t.id === id);
    if (closingTab?.kind === "ssh" && closingTab.sessionId) {
      const cmd = closingTab.transport === "telnet" ? "telnet_close" : "ssh_close";
      invoke(cmd, { sessionId: closingTab.sessionId }).catch(() => {});
    }
    termApis.current.delete(id);
    termApis.current.delete(`${id}:split`);
    setSplitMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // Drop the closed tab from the MRU history.
    setRecentActive((prev) => prev.filter((rid) => rid !== id));
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        // Prefer the most-recently-viewed surviving tab; fall back to the
        // left neighbour, then the welcome page.
        const survivorIds = new Set(next.map((t) => t.id));
        const mru = recentActive.find((rid) => rid !== id && (survivorIds.has(rid) || rid === WELCOME_ID));
        const fallback = mru
          ? mru
          : next[Math.max(0, idx - 1)]?.id ?? WELCOME_ID;
        setActiveId(fallback);
      }
      return next;
    });
  }, [tabs, activeId, recentActive]);
  removeTabRef.current = removeTab;

  const closeTab = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmClose) {
      const ok = await confirm(t("app.confirm.closeTab"));
      if (!ok) return;
    }
    removeTab(id);
  }, [confirmClose, confirm, removeTab]);

  // ---------------------------------------------------------------------------
  // Host dialog
  // ---------------------------------------------------------------------------

  const [newHostProtocol, setNewHostProtocol] = useState("SSH");
  const openNewHost = (parentId = "0", protocol?: string, mode: "dialog" | "drawer" = "dialog") => {
    const proto = protocol || "SSH";
    const defaultPort = getProtocol(proto)?.defaultPort ?? 22;
    setNewHostProtocol(proto);
    setHostDialogSeed({ id: crypto.randomUUID(), name: "", protocol: proto, host: "", port: defaultPort, username: "", remark: "",
      authentication: { type: "Password", password: "" },
      proxy: { type: "NO", host: "", port: 7890, authenticationType: "No", username: "", password: "" },
      options: { encoding: "UTF-8", heartbeatInterval: 30, tags: [], extras: {}, startupCommand: "", env: "", jumpHosts: [], sftpDefaultDirectory: "" },
      tunnelings: [], sort: 0, parentId, ownerId: "0", creatorId: "0", ownerType: "", deleted: false,
      createDate: 0, updateDate: 0 });
    setHostDialogMode(mode);
    setShowHostDialog(true);
  };
  const openNewFolder = async (parentId: string, name: string, protocol = "SSH") => {
    if (!name.trim()) return;
    try {
      await invoke("host_save", { host: { id: crypto.randomUUID(), name: name.trim(), protocol: "Folder", host: "", port: 0, username: "", remark: "",
        authentication: { type: "No", password: "" },
        proxy: { type: "NO", host: "", port: 0, authenticationType: "No", username: "", password: "" },
        options: { encoding: "UTF-8", heartbeatInterval: 0, tags: [], extras: {}, startupCommand: "", env: "", jumpHosts: [], sftpDefaultDirectory: "" },
        tunnelings: [], sort: 0, parentId, ownerId: "0", creatorId: "0", ownerType: protocol, deleted: false,
        createDate: Date.now(), updateDate: Date.now() } });
      setHostsVersion((n) => n + 1);
    } catch (e) { toast(String(e)); }
  };
  const openEditHost = (host: Host) => { setHostDialogSeed(host); setHostDialogMode("dialog"); setShowHostDialog(true); };
  const openEditHostDrawer = (host: Host) => { setHostDialogSeed(host); setHostDialogMode("drawer"); setShowHostDialog(true); };
  const handleHostSaved = () => { setShowHostDialog(false); setHostDialogMode("dialog"); setHostsVersion((n) => n + 1); };
  const handleHostDeleted = () => setHostsVersion((n) => n + 1);

  // ---------------------------------------------------------------------------
  // Toolbar action dispatch
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Activate the single transfer tab (create if absent), auto-connect when
  // the currently active tab is an SSH terminal.
  // ---------------------------------------------------------------------------

  const activateSftpTab = useCallback(async () => {
    // Capture the current terminal tab BEFORE switching
    const current = tabs.find(t => t.id === activeId);

    // Ensure the pinned SFTP tab exists and switch to it
    setTabs(prev => {
      if (prev.find(t => t.id === SFTP_PIN_ID)) return prev;
      return [...prev, { id: SFTP_PIN_ID, kind: "sftp", title: "Transfer", titleKey: "app.tab.transfer", pinned: sftpSettings.pinTab }];
    });
    setActiveId(SFTP_PIN_ID);

    // Auto-connect only when coming from a connected SSH terminal (not telnet)
    if (current?.kind === "ssh" && current.transport !== "telnet" && current.host && current.sessionId) {
      // Priority: OSC-7 / input-parsed CWD > exec-pwd (HOME) > ""
      let startDir = termCwds.current.get(current.id) ?? "";
      if (!startDir) {
        try { startDir = await invoke<string>("ssh_get_cwd", { sessionId: current.sessionId }); }
        catch { /* leave empty — handleAutoConnect will use defaultDir or "/" */ }
      }
      setSftpAutoConnect({ host: current.host, sessionId: current.sessionId, startDir, nonce: Date.now() });
    }
  }, [activeId, tabs, sftpSettings.pinTab]);
  activateSftpTabRef.current = activateSftpTab;

  const handleToolbarAction = (id: string) => {
    if (id === "note")       { setShowNote(true); return; }
    if (id === "keymgr")     { setShowKeyMgr(true); return; }
    if (id === "keyword")    { setShowHighlight(true); return; }
    if (id === "settings")   { setShowSettings(true); return; }
    if (id === "fullscreen") { toggleFullscreen(); return; }
    if (id === "split-h")    { handleSplit("H"); return; }
    if (id === "split-v")    { handleSplit("V"); return; }
    if (id === "sftp") {
      activateSftpTab();
      return;
    }
  };

  const TOOLBAR_ACTIONS: ToolAction[] = [
    { id: "sftp",     icon: <TbSftp />,     title: t("app.toolbar.sftp") },
    { id: "note",     icon: <TbNote />,     title: t("app.toolbar.notes") },
    { id: "keyword",  icon: <TbKeyword />,  title: t("app.toolbar.highlight") },
    { id: "keymgr",   icon: <TbKey />,      title: t("app.toolbar.keyManager") },
    { id: "settings", icon: <TbSettings />, title: t("app.toolbar.settings") },
  ];

  // ---------------------------------------------------------------------------
  // Terminal slot content helper
  // ---------------------------------------------------------------------------

  function renderTerminal(tab: Tab) {
    if (tab.kind === "welcome") {
      // Fence layout: blank logo page instead of full WelcomeTab
      if (layoutMode === "Fence") {
        return (
          <div className="blank-logo-page">
            <img src="/icons/128x128.png" alt="Netape" className="blank-logo-img" draggable={false} />
            <div className="blank-logo-name">Netape</div>
          </div>
        );
      }
      return (
              <WelcomeTab
                hosts={hosts}
                layoutMode={layoutMode}
                onOpenHost={openHost}
                onNewHost={openNewHost}
                onNewHostDrawer={(pid, proto) => openNewHost(pid, proto, "drawer")}
                onNewRootGroup={() => setShowNewGroupDialog(true)}
                onEditHost={openEditHost}
                onEditHostDrawer={openEditHostDrawer}
                onDeleteHost={handleHostDeleted}
                onNewFolder={openNewFolder}
          onRename={async (id, name) => {
            const host = hosts.find((h) => h.id === id);
            if (!host) return;
            try {
              await invoke("host_save", { host: { ...host, name, updateDate: Date.now() } });
              reloadHosts();
            } catch (e) { toast(String(e)); }
          }}
          onOpenKeyManager={() => setShowKeyMgr(true)}
          onOpenSettings={() => setShowSettings(true)}
        />
      );
    }
    if (tab.kind === "local") {
      return (
        <TerminalView
          sessionId={tab.id}
          settings={termSettings}
          highlights={highlights}
          onRegister={(api) => termApis.current.set(tab.id, api)}
          uiTheme={uiTheme}
          env={tab.host?.options?.env}
          startupCmd={tab.host?.options?.startupCommand}
          encoding={tab.host?.options?.encoding}
          protocol={tab.protocol}
          wslDistro={tab.host?.host}
          localShell={tab.protocol === "Local" ? termSettings.localShell : undefined}
        />
      );
    }
    if (tab.kind === "sftp") {
      return <SftpView
        sessionId={tab.sessionId}
        hostname={tab.host?.name || tab.host?.host}
        hosts={hosts}
        sftpSettings={sftpSettings}
        autoConnect={tab.id === SFTP_PIN_ID ? sftpAutoConnect : null}
        onAutoConnectDone={onAutoConnectDoneCb}
        connectHost={tab.id === SFTP_PIN_ID
          ? transferConnectHost
          : (tab.host ? { host: tab.host, nonce: 1 } : null)}
      />;
    }
    if (tab.kind === "ssh") {
      const onDisconnect = () => {
        if (!tab.host || !termSettings.autoReconnect) {
          setTabs(prev => prev.map(t =>
            t.id === tab.id ? { ...t, disconnected: true } : t));
          return;
        }
        setTabs(prev => prev.map(t => t.id === tab.id
          ? { ...t, sessionId: undefined, sshError: undefined, sshCompleting: false, disconnected: false }
          : t
        ));
        autoReconnect(tab.id, tab.host, tab.transport ?? "ssh");
      };
      const sysOpen = sysTabId === tab.id && tab.transport !== "telnet";
      return (
        <div style={{ display: "flex", width: "100%", height: "100%" }}>
          {/* Main column: terminal fills full height, stats bar floats on top */}
          <div style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
            <SshTerminalView
              sessionId={tab.sessionId}
              settings={termSettings}
              highlights={highlights}
              onRegister={(api) => termApis.current.set(tab.id, api)}
              onCwdChange={(cwd) => termCwds.current.set(tab.id, cwd)}
              uiTheme={uiTheme}
              transport={tab.transport ?? "ssh"}
              onDisconnect={onDisconnect}
              onToggleSearch={() => setTabSearchOpen(p => ({ ...p, [tab.id]: !p[tab.id] }))}
              onRegisterFind={(api) => findApisRef.current.set(tab.id, api)}
              onReconnect={tab.host && !termSettings.autoReconnect ? () => {
                setTabs(prev => prev.map(t =>
                  t.id === tab.id ? { ...t, disconnected: false } : t
                ));
                if (tab.transport === "telnet") connectTelnet(tab.id, tab.host!);
                else connectSsh(tab.id, tab.host!);
              } : undefined}
            />
            {/* Status bar floats over terminal (position:absolute in CSS) */}
            <ServerStatsBar
              sessionId={tab.sessionId}
              host={tab.host}
              transport={tab.transport}
              onSystem={tab.transport !== "telnet" ? () => setSysTabId(p => p === tab.id ? null : tab.id) : undefined}
              systemOpen={sysOpen}
              searchOpen={tabSearchOpen[tab.id] ?? false}
              searchQuery={tabSearchQuery[tab.id] ?? ""}
              onSearchToggle={tab.transport !== "telnet" ? () => {
                const wasOpen = tabSearchOpen[tab.id];
                if (wasOpen) { findApisRef.current.get(tab.id)?.clearHighlight(); setTabSearchQuery(p => ({ ...p, [tab.id]: "" })); }
                setTabSearchOpen(p => ({ ...p, [tab.id]: !p[tab.id] }));
              } : undefined}
              onSearchQueryChange={(q) => setTabSearchQuery(p => ({ ...p, [tab.id]: q }))}
              onFindNext={(q) => findApisRef.current.get(tab.id)?.findNext(q)}
              onFindPrev={(q) => findApisRef.current.get(tab.id)?.findPrev(q)}
              onSearchClose={() => {
                findApisRef.current.get(tab.id)?.clearHighlight();
                setTabSearchOpen(p => ({ ...p, [tab.id]: false }));
                setTabSearchQuery(p => ({ ...p, [tab.id]: "" }));
              }}
            />
            {!tab.sessionId && (
              <div style={{ position: "absolute", inset: 0 }}>
                <SshConnectingOverlay
                  host={tab.host!}
                  error={tab.sshError}
                  completed={tab.sshCompleting}
                  defaultShowLogs={termSettings.startupLogs}
                  onReconnect={() => {
                    setTabs((prev) => prev.map((t) =>
                      t.id === tab.id ? { ...t, sshError: undefined, sessionId: undefined, sshCompleting: false } : t
                    ));
                    if (tab.transport === "telnet") connectTelnet(tab.id, tab.host!);
                    else connectSsh(tab.id, tab.host!);
                  }}
                  onClose={() => removeTab(tab.id)}
                />
              </div>
            )}
          </div>
          {/* System sidebar + drag handle */}
          {sysOpen && (
            <>
              <SysbarResizer sysbarWidth={sysbarWidth} onWidthChange={setSysbarWidth} />
              <SystemSidebar
                sessionId={tab.sessionId}
                onClose={() => setSysTabId(null)}
                width={sysbarWidth}
              />
            </>
          )}
        </div>
      );
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={`netape-app${isFullscreen ? " app-fullscreen" : ""}${isMac ? " app-macos" : ""}`}>
      <GlobalTooltip />
      <GlobalToast />

      {/* ── Sidebar (Fence layout) ─────────────────────── */}
      {sidebarVisible && (
        <>
          <Sidebar
            hosts={hosts}
            onToggle={toggleSidebar}
            onOpenHost={openHost}
            onEditHost={openEditHost}
            onDeleteHost={handleHostDeleted}
            onNewHost={openNewHost}
            onNewFolder={openNewFolder}
            onRefresh={reloadHosts}
            width={sidebarWidth}
          />
          <div className="split-handle" onMouseDown={onSidebarResizerMouseDown} />
        </>
      )}

      {/* ── Right ─────────────────────────────────────────────── */}
      <div className="fence-main">

        {/* ── Tab bar with integrated window controls ── */}
        <div
          className={[
            "tabbar",
            isMac ? "tabbar--macos" : "",
            layoutMode === "Fence" ? "tabbar--fence" : "",
            isWindowMaximized ? "tabbar--maximized" : "",
            layoutMode === "Fence" && !sidebarVisible ? "tabbar--sidebar-collapsed" : "",
          ].filter(Boolean).join(" ")}
          onMouseDown={handleTabbarMouseDown}
        >

          {/* Show the sidebar expand button only in Fence layout. */}
          {layoutMode === "Fence" && !sidebarVisible && !isFullscreen && (
            <button
              className="sidebar-toggle-inline"
              onClick={toggleSidebar}
              data-tooltip={t("app.sidebar.show")}
            >
              ☰
            </button>
          )}

          {/* Fixed home tab — always visible, never scrolls away */}
          {layoutMode !== "Fence" && (
            <div
              className={`tab tab-home tab-home--fixed${activeId === WELCOME_ID ? " active" : ""}`}
              onClick={() => setActiveId(WELCOME_ID)}
              data-tooltip={t("app.tab.home")}
            >
              <span className="tab-icon">⌂</span>
              <span className="tab-title">{t("app.tab.home")}</span>
            </div>
          )}

          {/* In fullscreen mode, keep the pinned transfer tab next to Home. */}
          {layoutMode !== "Fence" && tabs.filter(t => t.pinned && t.kind === "sftp").map(tab => (
            <div
              key={tab.id}
              className={`tab tab--pinned tab-sftp-pinned${activeId === tab.id ? " active" : ""}`}
              onClick={() => setActiveId(SFTP_PIN_ID)}
              data-tooltip={translatedTabTitle(tab, t)}
            >
              <span className="tab-icon"><TabSftpIcon /></span>
              <span className="tab-title">{translatedTabTitle(tab, t)}</span>
            </div>
          ))}

          {/* Left scroll arrow */}
          {canScrollLeft && (
            <button className="tab-scroll-btn tab-scroll-btn--l"
              onClick={() => tabsScrollRef.current?.scrollBy({ left: -160, behavior: "smooth" })}>‹</button>
          )}

          {/* Scrollable tabs (home tab and pinned tabs excluded from fixed rendering) */}
          <div className="tabbar-tabs" ref={tabsScrollRef} onWheel={onTabsWheel}>
            {/* In Fence layout, render the pinned transfer tab first in the scroll area. */}
            {layoutMode === "Fence" && tabs.filter(t => t.pinned && t.kind === "sftp").map(tab => (
              <div
                key={tab.id}
                data-tabid={tab.id}
                className={`tab tab--pinned${activeId === tab.id ? " active" : ""}`}
                onClick={() => setActiveId(SFTP_PIN_ID)}
                data-tooltip={translatedTabTitle(tab, t)}
              >
                <span className="tab-icon"><TabSftpIcon /></span>
                <span className="tab-title">{translatedTabTitle(tab, t)}</span>
              </div>
            ))}
            {tabs.filter(tab => tab.id !== WELCOME_ID && !tab.pinned).map((tab) => (
              <div
                key={tab.id}
                data-tabid={tab.id}
                className={[
                  "tab",
                  tab.id === activeId   ? "active"         : "",
                  tab.id === WELCOME_ID ? "tab-home"        : "",
                  splitMap[tab.id]      ? "tab-split"       : "",
                  dragOverId === tab.id ? "tab--drag-over"  : "",
                  dragSrcId  === tab.id ? "tab--dragging"   : "",
                ].filter(Boolean).join(" ")}
                onClick={() => setActiveId(tab.id)}
                onPointerDown={e => startTabDrag(e, tab.id)}
                data-tooltip={translatedTabTitle(tab, t)}
              >
                <span className="tab-icon">
                  {tab.id === WELCOME_ID ? "⌂" : tab.kind === "sftp" ? <TabSftpIcon /> : <TabTermIcon />}
                </span>
                <span className="tab-title">{translatedTabTitle(tab, t)}</span>
                {splitMap[tab.id] && (
                  <span className="tab-split-indicator" data-tooltip={splitMap[tab.id] === "H" ? t("app.split.h") : t("app.split.v")}>
                    {splitMap[tab.id] === "H" ? "⬓" : "⬒"}
                  </span>
                )}
                {(tab.kind === "ssh" || tab.kind === "local") && (
                  <span className={`tab-status-dot tab-status-dot--${
                    tab.kind === "local"               ? "green"
                    : tab.sshError || tab.disconnected ? "red"
                    : tab.sessionId                    ? "green"
                    : "yellow"
                  }`}/>
                )}
                {tab.id !== WELCOME_ID && (
                  <button className="tab-close" onClick={(e) => closeTab(tab.id, e)} data-tooltip={t("app.tabClose")}>×</button>
                )}
              </div>
            ))}
            {/* + inside scroll area when no overflow */}
            {!hasOverflow && (
              <button className="tab-add" onClick={() => setNewTermOpen(true)} data-tooltip={t("terminal.new")}>+</button>
            )}
          </div>

          {/* Right scroll arrow */}
          {canScrollRight && (
            <button className="tab-scroll-btn tab-scroll-btn--r"
              onClick={() => tabsScrollRef.current?.scrollBy({ left: 160, behavior: "smooth" })}>›</button>
          )}

          {/* Overflow controls: dropdown ▾ and + appear only when tabs overflow */}
          {hasOverflow && (<>
            <button
              ref={dropdownBtnRef}
              className={`tab-dropdown-btn${dropdownOpen ? " open" : ""}`}
              onClick={openTabDropdown}
              data-tooltip={t("app.tabList")}
            >▾</button>
            <button className="tab-add tab-add--fixed" onClick={() => setNewTermOpen(true)} data-tooltip={t("terminal.new")}>+</button>
          </>)}

          {dropdownOpen && createPortal(
            <div
              ref={dropdownPanelRef}
              className="tab-dropdown-panel"
              style={{ top: dropdownPos.top, right: dropdownPos.right }}
              onMouseDown={e => e.stopPropagation()}
            >
              {tabs.filter(t => !(t.id === WELCOME_ID && layoutMode === "Fence") && !t.pinned).map(tab => (
                <div
                  key={tab.id}
                  className={[
                    "tab-dropdown-item",
                    tab.id === activeId      ? "active"    : "",
                    hiddenTabIds.has(tab.id) ? "is-hidden" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => {
                    setActiveId(tab.id);
                    setDropdownOpen(false);
                    // Wait one frame for React to apply the new activeId before scrolling
                    requestAnimationFrame(() => scrollTabIntoView(tab.id));
                  }}
                >
                  <span className="tab-icon">
                    {tab.id === WELCOME_ID ? "⌂" : tab.kind === "sftp" ? <TabSftpIcon /> : <TabTermIcon />}
                  </span>
                  <span className="tab-dropdown-title">{translatedTabTitle(tab, t)}</span>
                  {hiddenTabIds.has(tab.id) && <span className="tab-hidden-dot" />}
                </div>
              ))}
            </div>,
            document.body
          )}

          {/* Trailing: feature actions */}
          <div className="tabbar-actions">
            {TOOLBAR_ACTIONS.map((a) => (
              <button
                key={a.id}
                className={[
                  "tbaction",
                  a.disabled ? "tbaction-disabled" : "",
                  a.toggle && isFullscreen && a.id === "fullscreen" ? "tbaction-active" : "",
                ].filter(Boolean).join(" ")}
                data-tooltip={a.disabled ? `${a.title}` : a.title}
                onClick={() => !a.disabled && handleToolbarAction(a.id)}
                tabIndex={a.disabled ? -1 : 0}
              >
                {a.icon}
              </button>
            ))}
          </div>

          {/* Window controls (Windows/Linux custom titlebar only) */}
          {!isMac && (
            <div className="winctrls">
              <>
                <button className="wctrl wctrl-min" onMouseDown={(e) => e.stopPropagation()} onClick={() => appWindow.minimize()} data-tooltip={t("app.window.minimize")}>
                  <WcMin />
                </button>
                <button className="wctrl wctrl-max" onMouseDown={(e) => e.stopPropagation()} onClick={async () => {
                  if (isWindowMaximized) {
                    await appWindow.unmaximize();
                    await appWindow.setSize(new LogicalSize(1024, 720));
                    await appWindow.center();
                  } else {
                    await appWindow.maximize();
                  }
                }} data-tooltip={isWindowMaximized ? t("app.window.restore") : t("app.window.maximize")}>
                  {isWindowMaximized ? <WcRestore /> : <WcMax />}
                </button>
                <button className="wctrl wctrl-close" onMouseDown={(e) => e.stopPropagation()} onClick={handleWindowClose} data-tooltip={t("app.window.close")}>
                  <WcClose />
                </button>
              </>
            </div>
          )}
        </div>

        {/* ── Content ─────────────────────────────────────────── */}
        <div className="content-with-note">
        <main className="content">
          {tabs.map((tab) => {
            const dir = splitMap[tab.id];
            return (
              <div
                key={tab.id}
                className={`terminal-slot${dir ? ` split-active split-${dir}` : ""}`}
                style={{ display: tab.id === activeId ? "flex" : "none" }}
                data-split={tab.id}
              >
                {/* Primary terminal pane */}
                <div
                  className="terminal-pane terminal-pane--primary"
                  style={dir ? { [dir === "H" ? "width" : "height"]: `${splitSizes.current[tab.id] ?? 50}%` } : {}}
                >
                  {renderTerminal(tab)}
                </div>

                {/* Split divider + secondary pane */}
                {dir && (
                  <>
                    <div
                      className={`split-divider split-divider--${dir}`}
                      onMouseDown={onSplitDividerMouseDown(tab.id, dir)}
                    />
                    <div className="terminal-pane terminal-pane--split">
                      <div className="split-pane-header">
                        <span className="split-pane-title">
                          {dir === "H" ? t("app.split.horizontal") : t("app.split.vertical")}
                        </span>
                        <button
                          className="split-pane-close"
                          onClick={() => closeSplit(tab.id)}
                          data-tooltip={t("app.split.closeTip")}
                        >
                          ✕
                        </button>
                      </div>
                      <TerminalView
                        key={`${tab.id}:split`}
                        sessionId={`${tab.id}:split`}
                        settings={termSettings}
                        highlights={highlights}
                        onRegister={(api) => termApis.current.set(`${tab.id}:split`, api)}
                        uiTheme={uiTheme}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </main>
        {showHostDialog && hostDialogMode === "drawer" && (
          <>
            <HostDrawerResizer width={hostDrawerWidth} onWidthChange={setHostDrawerWidth} />
            <HostDialog
              host={hostDialogSeed}
              hosts={hosts}
              mode="drawer"
              drawerWidth={hostDrawerWidth}
              initialProtocol={!hostDialogSeed?.createDate ? newHostProtocol : undefined}
              onSave={handleHostSaved}
              onClose={() => {
                setShowHostDialog(false);
                setHostDialogMode("dialog");
              }}
            />
          </>
        )}
        {/* Note panel: visible when a non-welcome tab is active */}
        {isNotePanel && (
          <>
            <NoteDrawerResizer width={noteDrawerWidth} onWidthChange={setNoteDrawerWidth} />
            <NoteDialog mode="panel" width={noteDrawerWidth} onClose={() => setShowNote(false)} />
          </>
        )}
        </div>
      </div>

      {/* ── Dialogs ─────────────────────────────────────────── */}
      {showHostDialog && hostDialogMode !== "drawer" && (
        <HostDialog
          host={hostDialogSeed}
          hosts={hosts}
          mode={hostDialogMode}
          initialProtocol={!hostDialogSeed?.createDate ? newHostProtocol : undefined}
          onSave={handleHostSaved}
          onClose={() => {
            setShowHostDialog(false);
            setHostDialogMode("dialog");
          }}
        />
      )}
      {showNewGroupDialog && (
        <NewGroupDialog
          onClose={() => setShowNewGroupDialog(false)}
          onConfirm={(name) => {
            void openNewFolder("0", name);
            setShowNewGroupDialog(false);
          }}
        />
      )}
      {newTermOpen && (
        <NewTerminalDialog
          hosts={hosts}
          onPickHost={(h) => { setNewTermOpen(false); openHost(h); }}
          onNewHost={() => { setNewTermOpen(false); openNewHost(undefined, "SSH"); }}
          onLocalTerminal={() => { setNewTermOpen(false); openLocalTerminal(); }}
          onClose={() => setNewTermOpen(false)}
        />
      )}
      {showKeyMgr && <KeyManagerDialog onClose={() => setShowKeyMgr(false)} />}
      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onApply={handleSettingApply}
        />
      )}
      {showNote && !isNotePanel && (
        <NoteDialog mode="dialog" onClose={() => setShowNote(false)} />
      )}
      {showHighlight && (
        <KeyHighlightDialog
          onClose={() => setShowHighlight(false)}
          onChange={reloadHighlights}
        />
      )}
      {/* Global SSH keyboard-interactive prompt (self-listening) */}
      <KeyboardInteractiveDialog />
      {/* ── Connection error toast ───────────────────────────── */}
      {connectError && (
        <div
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: "#c0392b", color: "#fff", padding: "10px 20px", borderRadius: 6,
            zIndex: 9999, maxWidth: 480, boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", gap: 12,
          }}
          onClick={() => setConnectError(null)}
        >
          <span style={{ flex: 1 }}>{connectError}</span>
          <span style={{ cursor: "pointer", opacity: 0.8 }}>✕</span>
        </div>
      )}

      {confirmState && (
        <ConfirmDialog
          message={confirmState.message}
          onOk={handleOk}
          onCancel={handleCancel}
          okText={t("app.window.close")}
          okDanger={false}
        />
      )}
    </div>
  );
}
