import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Host, SftpSettings } from "../types";
import { PROTOCOLS, useAvailableProtocols, isTransferProtocol } from "../protocols";
import { t as i18nT, useT } from "../i18n";
import { FtpFolderIcon, SmbFolderIcon, SshIcon, InboxEmptyIcon } from "./icons";
import { toast } from "./Toast";
import { ROOT_ID as TREE_ROOT, useTreeExpanded, toggleExpanded } from "../store/treeStore";
import CustomSelect from "./CustomSelect";

// ---------------------------------------------------------------------------
// Native shell icon cache
// ---------------------------------------------------------------------------

const _iconCache    = new Map<string, string | null>();
const _iconInflight = new Map<string, Promise<string | null>>();
const _isMac = /mac/i.test(navigator.platform || navigator.userAgent || "");

function _iconKey(name: string, path: string): string {
  if (_isMac) return path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ["lnk", "exe", "msi", "url"].includes(ext) ? path : `ext:${ext}`;
}

async function _fetchNativeIcon(key: string, path: string): Promise<string | null> {
  if (_iconCache.has(key))    return _iconCache.get(key)!;
  if (_iconInflight.has(key)) return _iconInflight.get(key)!;
  const p = invoke<string>("get_file_icon", { path })
    .then(b64 => `data:image/png;base64,${b64}` as string | null)
    .catch(() => null as string | null)
    .then(r  => { _iconCache.set(key, r); _iconInflight.delete(key); return r; });
  _iconInflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// SVG fallback icons
// ---------------------------------------------------------------------------

type FileCategory =
  | "folder" | "symlink" | "image" | "video" | "audio"
  | "pdf" | "word" | "excel" | "ppt" | "code" | "archive"
  | "data" | "shortcut" | "executable" | "generic";

function _cat(name: string, isDir: boolean, isSymlink: boolean): FileCategory {
  if (isDir)     return "folder";
  if (isSymlink) return "symlink";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (["jpg","jpeg","png","gif","svg","webp","bmp","ico","tiff","heic","avif"].includes(ext)) return "image";
  if (["mp4","mkv","avi","mov","wmv","flv","webm","m4v"].includes(ext))                      return "video";
  if (["mp3","wav","flac","ogg","aac","m4a","wma","opus"].includes(ext))                     return "audio";
  if (ext === "pdf")                                                                           return "pdf";
  if (["doc","docx","odt","rtf"].includes(ext))                                               return "word";
  if (["xls","xlsx","csv","ods"].includes(ext))                                               return "excel";
  if (["ppt","pptx","odp"].includes(ext))                                                     return "ppt";
  if (["js","ts","jsx","tsx","py","rs","go","java","c","cpp","h","cs","rb","php",
       "swift","kt","vue","html","htm","css","scss","less","sh","bat","cmd"].includes(ext))   return "code";
  if (["zip","rar","7z","tar","gz","bz2","xz","tgz"].includes(ext))                          return "archive";
  if (["json","yaml","yml","toml","xml","ini","cfg","env","sql","log","md","txt"].includes(ext)) return "data";
  if (["lnk","url","webloc"].includes(ext))                                                   return "shortcut";
  if (["exe","msi","app","deb","rpm","apk"].includes(ext))                                   return "executable";
  return "generic";
}

const _COLOR: Record<FileCategory, [string, string]> = {
  folder:     ["#f9c74f","#f4a61d"], symlink:    ["#90e0ef","#48cae4"],
  image:      ["#c77dff","#9d4edd"], video:      ["#ff9e64","#f77f00"],
  audio:      ["#06d6a0","#05a87e"], pdf:        ["#ff6b6b","#e63946"],
  word:       ["#4895ef","#1d6fbf"], excel:      ["#52b788","#2d6a4f"],
  ppt:        ["#f4a261","#e76f51"], code:       ["#4cc9f0","#0096c7"],
  archive:    ["#ff8c94","#d62839"], data:       ["#ffd166","#f5a623"],
  shortcut:   ["#a0c4ff","#6699cc"], executable: ["#95d5b2","#52b788"],
  generic:    ["#adb5bd","#868e96"],
};

function SvgFileIcon({ name, isDir, isSymlink }: { name: string; isDir: boolean; isSymlink: boolean }) {
  const cat = _cat(name, isDir, isSymlink);
  const [fill, stroke] = _COLOR[cat];
  if (_isMac) {
    if (cat === "folder") return (
      <svg width="18" height="15" viewBox="0 0 18 15" fill="none" style={{ flexShrink: 0 }}>
        <path d="M1.25 4.2c0-1.52 1.23-2.75 2.75-2.75h2.6c.6 0 1.17.24 1.58.67l.88.92h4.97c1.52 0 2.75 1.23 2.75 2.75v5.9c0 1.52-1.23 2.75-2.75 2.75H4c-1.52 0-2.75-1.23-2.75-2.75V4.2Z" fill="#6fb2ff" fillOpacity="0.24" stroke="#8cc0ff" strokeWidth="1"/>
        <path d="M1.9 5.4h14.2" stroke="#8cc0ff" strokeOpacity="0.55" strokeWidth="0.9"/>
      </svg>
    );
    const arrow = cat === "shortcut" || cat === "symlink";
    return (
      <svg width="15" height="17" viewBox="0 0 15 17" fill="none" style={{ flexShrink: 0 }}>
        <path d="M3.1 1.25h5.9l3.15 3.2v9.4A1.9 1.9 0 0 1 10.25 15.75h-7.1a1.9 1.9 0 0 1-1.9-1.9v-10.7a1.9 1.9 0 0 1 1.85-1.9Z" fill="#ffffff" fillOpacity="0.08" stroke="#b8c0d4" strokeWidth="0.95"/>
        <path d="M9 1.25v2.4c0 .5.4.9.9.9h2.25" stroke="#b8c0d4" strokeWidth="0.9" strokeLinecap="round"/>
        <line x1="3.6" y1="7.1" x2="10.9" y2="7.1" stroke={stroke} strokeWidth="0.85" strokeOpacity="0.55"/>
        <line x1="3.6" y1="9.15" x2="10.9" y2="9.15" stroke={stroke} strokeWidth="0.85" strokeOpacity="0.55"/>
        <line x1="3.6" y1="11.2" x2="8.4" y2="11.2" stroke={stroke} strokeWidth="0.85" strokeOpacity="0.55"/>
        {arrow && (
          <>
            <rect x="1.2" y="11.1" width="5.2" height="4.5" rx="0.8" fill="var(--bg)"/>
            <path d="M2.45 14.7v-2.25h2.2M4.65 14.7h-2.2" stroke={stroke} strokeWidth="0.95" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M3.2 13.9l1.45-1.45" stroke={stroke} strokeWidth="0.8" strokeLinecap="round"/>
          </>
        )}
      </svg>
    );
  }
  if (cat === "folder") return (
    <svg width="17" height="14" viewBox="0 0 17 14" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1 2.5C1 1.67 1.67 1 2.5 1H6.5L8 3H14.5C15.33 3 16 3.67 16 4.5V11.5C16 12.33 15.33 13 14.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z"
        fill={fill} fillOpacity="0.22" stroke={stroke} strokeWidth="1"/>
      <path d="M1 5H16" stroke={stroke} strokeWidth="0.8" strokeOpacity="0.5"/>
    </svg>
  );
  const arrow = cat === "shortcut" || cat === "symlink";
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1.5 1H9L13 5V14.5C13 14.78 12.78 15 12.5 15H1.5C1.22 15 1 14.78 1 14.5V1.5C1 1.22 1.22 1 1.5 1Z"
        fill={fill} fillOpacity="0.15" stroke={stroke} strokeWidth="1"/>
      <path d="M9 1L13 5H9.5C9.22 5 9 4.78 9 4.5V1Z" fill={stroke} fillOpacity="0.35" stroke={stroke} strokeWidth="0.8"/>
      <line x1="3" y1="7.5"  x2="11" y2="7.5"  stroke={stroke} strokeWidth="0.9" strokeOpacity="0.55"/>
      <line x1="3" y1="9.5"  x2="11" y2="9.5"  stroke={stroke} strokeWidth="0.9" strokeOpacity="0.55"/>
      <line x1="3" y1="11.5" x2="8"  y2="11.5" stroke={stroke} strokeWidth="0.9" strokeOpacity="0.55"/>
      {arrow && (<>
        <rect x="1" y="10" width="6" height="5.5" rx="0.5" fill="var(--bg)"/>
        <path d="M2.5 14.5V11.5H5.5M5.5 14.5H2.5" stroke={stroke} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M3.5 13.5L5.5 11.5" stroke={stroke} strokeWidth="0.8" strokeLinecap="round"/>
      </>)}
    </svg>
  );
}

function FileTypeIcon({ path, name, isDir, isSymlink, nativeIcons }: {
  path: string; name: string; isDir: boolean; isSymlink: boolean; nativeIcons: boolean;
}) {
  const key = (nativeIcons && (_isMac || !isDir)) ? _iconKey(name, path) : null;
  const [imgUrl, setImgUrl] = useState<string | null>(() =>
    key ? (_iconCache.get(key) ?? null) : null
  );
  useEffect(() => {
    if (!key) return;
    if (_iconCache.has(key)) { setImgUrl(_iconCache.get(key)!); return; }
    _fetchNativeIcon(key, path).then(setImgUrl);
  }, [key, path]);
  if (imgUrl) return (
    <img src={imgUrl} width={16} height={16}
      style={{ flexShrink: 0, imageRendering: "pixelated" }} draggable={false}/>
  );
  return <SvgFileIcon name={name} isDir={isDir} isSymlink={isSymlink}/>;
}

// ---------------------------------------------------------------------------
// Host picker tree — mirrors HostTree.tsx structure exactly
// ---------------------------------------------------------------------------

const SFTP_PICKER_PROTOS = PROTOCOLS.map((p) => ({
  value: p.id,
  icon: p.icon,
  label: p.filterLabel,
  labelKey: p.filterLabelKey,
}));
const protocolFilterLabel = (p: { label: string; labelKey?: string } | undefined) =>
  p ? i18nT(p.labelKey ?? p.label) : "";

function isFolder(h: Host): boolean {
  return h.protocol === "Folder";
}

/** Return the direct children of a parent, with folders sorted first. */
function getChildren(hosts: Host[], parentId: string): Host[] {
  return hosts
    .filter(h => (h.parentId ?? "0") === parentId && !h.deleted)
    .sort((a, b) => {
      const af = isFolder(a) ? 0 : 1;
      const bf = isFolder(b) ? 0 : 1;
      if (af !== bf) return af - bf;
      if (a.sort !== b.sort) return a.sort - b.sort;
      return a.name.localeCompare(b.name);
    });
}

/** Recursively count non-folder hosts. */
function countHosts(hosts: Host[], parentId: string): number {
  return hosts
    .filter(h => (h.parentId ?? "0") === parentId && !h.deleted)
    .reduce((n, h) => n + (isFolder(h) ? countHosts(hosts, h.id) : 1), 0);
}

/* SVG icons */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, transition: "transform 0.12s", transform: open ? "rotate(90deg)" : "none" }}>
      <path d="M3 1.5L7.5 5L3 8.5"/>
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, opacity: 0.75 }}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

function FolderPickerIcon({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {open ? (
        <path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2A2 2 0 0 0 12.11 6H18a2 2 0 0 1 2 2v2"/>
      ) : (
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      )}
    </svg>
  );
}

function HostPickerIcon() {
  return (
    <svg width="15" height="13" viewBox="0 0 16 14" fill="none"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, opacity: 0.55 }}>
      <rect x="0.7" y="0.7" width="14.6" height="5.2" rx="1.3"/>
      <rect x="0.7" y="8.1" width="14.6" height="5.2" rx="1.3"/>
      <circle cx="13.2" cy="3.3"  r="0.9" fill="currentColor" stroke="none"/>
      <circle cx="13.2" cy="10.7" r="0.9" fill="currentColor" stroke="none"/>
    </svg>
  );
}

/** Recursively render folder and host nodes. Depth 0 is reserved for the synthetic root. */
function PickerNode({
  host, allHosts, depth, onConnect, connecting, expanded,
}: {
  host: Host; allHosts: Host[]; depth: number;
  onConnect: (h: Host) => void; connecting: string | null;
  expanded: Set<string>;
}) {
  const indent = depth * 16 + 8;

  if (isFolder(host)) {
    const open = expanded.has(host.id);
    const children = getChildren(allHosts, host.id);
    const cnt = countHosts(allHosts, host.id);
    return (
      <div>
        <div className="sftp-picker-row sftp-picker-folder"
          style={{ paddingLeft: indent }}
          onClick={() => toggleExpanded(host.id)}>
          <ChevronIcon open={open}/>
          <FolderPickerIcon open={open}/>
          <span className="sftp-picker-folder-name">{host.name || i18nT("sftp.unnamed")}</span>
          {cnt > 0 && <span className="sftp-picker-count">{cnt}</span>}
        </div>
        {open && children.map(c =>
          <PickerNode key={c.id} host={c} allHosts={allHosts} depth={depth + 1}
            onConnect={onConnect} connecting={connecting} expanded={expanded}/>
        )}
      </div>
    );
  }

  const busy = connecting === host.id;
  return (
    <div className={`sftp-picker-row sftp-picker-host${busy ? " sftp-picker-host-busy" : ""}`}
      style={{ paddingLeft: indent }}
      onClick={() => !busy && onConnect(host)}>
      <HostPickerIcon/>
      <div className="sftp-picker-host-info">
        <span className="sftp-picker-host-name">{host.name || host.host}</span>
        <span className="sftp-picker-host-sub">{host.username}@{host.host}:{host.port}</span>
      </div>
      {busy && <span className="sftp-picker-busy">{i18nT("sftp.connecting")}</span>}
    </div>
  );
}

/** Render the synthetic "My Hosts" root plus its descendants. */
function HostPickerTree({
  hosts, search, protoFilter, onConnect, connecting,
}: {
  hosts: Host[]; search: string; protoFilter: string;
  onConnect: (h: Host) => void; connecting: string | null;
}) {
  const expanded = useTreeExpanded();
  const rootOpen = expanded.has(TREE_ROOT);

  // When a transfer-capable protocol is selected, filter by that protocol.
  // Otherwise, show all transfer-capable hosts and prune empty folder branches.
  const matchHost = (h: Host) =>
    !isFolder(h) && !h.deleted &&
    ((protoFilter && isTransferProtocol(protoFilter))
      ? h.protocol === protoFilter
      : isTransferProtocol(h.protocol));

  const hostsById = new Map(hosts.map(h => [h.id, h]));
  const neededFolders = new Set<string>();
  for (const h of hosts) {
    if (!matchHost(h)) continue;
    let pid = h.parentId;
    while (pid && pid !== "0" && !neededFolders.has(pid)) {
      const folder = hostsById.get(pid);
      if (!folder) break;
      neededFolders.add(pid);
      pid = folder.parentId;
    }
  }
  const visibleHosts = hosts.filter(h => isFolder(h) ? neededFolders.has(h.id) : matchHost(h));

  const lf = search.toLowerCase();

  // Search mode flattens matching non-folder hosts.
  if (lf) {
    const matched = visibleHosts.filter(h =>
      !h.deleted && !isFolder(h) &&
      (h.name.toLowerCase().includes(lf) ||
       h.host.toLowerCase().includes(lf) ||
       h.username.toLowerCase().includes(lf))
    );
    if (matched.length === 0) return <div className="sftp-picker-empty">{i18nT("sftp.noMatchedHosts")}</div>;
    return (
      <>
        {matched.map(h =>
          <PickerNode key={h.id} host={h} allHosts={visibleHosts} depth={0}
            onConnect={onConnect} connecting={connecting} expanded={expanded}/>
        )}
      </>
    );
  }

  // Normal mode expands the synthetic root and shows all top-level entries.
  const rootChildren = getChildren(visibleHosts, "0");
  const total = countHosts(visibleHosts, "0");

  if (total === 0 && protoFilter) {
    return (
      <div className="sftp-picker-empty">
        {i18nT("sftp.noProtocolHosts", { protocol: protocolFilterLabel(SFTP_PICKER_PROTOS.find(p => p.value === protoFilter)) || protoFilter })}
      </div>
    );
  }

  return (
    <>
      <div className="sftp-picker-row sftp-picker-folder sftp-picker-root"
        onClick={() => toggleExpanded(TREE_ROOT)}>
        <ChevronIcon open={rootOpen}/>
        <PersonIcon/>
        <span className="sftp-picker-folder-name">{i18nT("sftp.myHosts")}</span>
        {total > 0 && <span className="sftp-picker-count">{total}</span>}
      </div>
      {rootOpen && rootChildren.map(h =>
        <PickerNode key={h.id} host={h} allHosts={visibleHosts} depth={1}
          onConnect={onConnect} connecting={connecting} expanded={expanded}/>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb path parser
// ---------------------------------------------------------------------------

function parseBreadcrumb(path: string): Array<{ label: string; path: string }> {
  if (!path) return [];
  const isWin = /^[A-Za-z]:/.test(path);
  if (isWin) {
    const norm = path.replace(/\//g, "\\").replace(/\\+$/, "");
    const parts = norm.split("\\").filter(Boolean);
    const segs: Array<{ label: string; path: string }> = [];
    let accum = "";
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) { accum = parts[0] + "\\"; segs.push({ label: parts[0], path: accum }); }
      else { accum += parts[i]; segs.push({ label: parts[i], path: accum }); if (i < parts.length - 1) accum += "\\"; }
    }
    return segs;
  } else {
    const noTrail = path.replace(/\/+$/, "") || "/";
    if (noTrail === "/") return [{ label: "/", path: "/" }];
    const parts = noTrail.split("/").filter(Boolean);
    const segs: Array<{ label: string; path: string }> = [];
    let accum = "";
    for (const p of parts) { accum += "/" + p; segs.push({ label: p, path: accum }); }
    return segs;
  }
}

function getFileType(name: string, isDir: boolean, isSymlink: boolean): string {
  if (isDir)     return i18nT("sftp.type.folder");
  if (isSymlink) return i18nT("sftp.type.symlink");
  const dot = name.lastIndexOf(".");
  if (dot <= 0)  return "";
  return name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  name: string; path: string;
  isDir: boolean; isFile: boolean; isSymlink: boolean;
  size: number; modified: number;
  permissions: string; owner: string;
}

// Transfer backend behind a remote pane tab. "sftp" is built-in; "ftp" is the
// installable plugin. Commands/events are derived from this so the same UI
// drives either backend (see rcmd/revt).
type TransferProvider = "sftp" | "ftp" | "smb";

/** Remote command name for a provider, e.g. ("ftp","list_dir") → "ftp_list_dir". */
const rcmd = (p: TransferProvider | undefined, op: string) => `${p ?? "sftp"}_${op}`;
/** Remote event channel, e.g. ("ftp","progress","tid") → "ftp://progress/tid". */
const revt = (p: TransferProvider | undefined, evt: string, id: string) => `${p ?? "sftp"}://${evt}/${id}`;
/** Features the built-in SFTP backend has that the FTP plugin does not. */
const providerCaps = (p: TransferProvider | undefined) => ({
  chmod:     (p ?? "sftp") === "sftp",
  edit:      (p ?? "sftp") === "sftp",
  exec:      (p ?? "sftp") === "sftp",
  dirXfer:   ["sftp", "smb"].includes(p ?? "sftp"),   // recursive directory upload/download
  conflict:  (p ?? "sftp") === "sftp",   // pre-transfer conflict resolution
  pause:     (p ?? "sftp") === "sftp",   // pause/resume transfers
});

const providerUnsupportedLabel = (p: TransferProvider | undefined) => (p ?? "sftp").toUpperCase();

interface PaneTab {
  id:           string;
  path:         string;
  input:        string;
  editingInput: boolean;
  entries:      FileEntry[];
  loading:      boolean;
  selected:     Set<string>;
  label:        string;
  labelKey?:    string;
  sftpId?:      string;
  provider?:    TransferProvider;  // remote backend (undefined for local tabs)
  history:      string[];
  histIdx:      number;
  homePath:     string;
  pinned?:      boolean;   // cannot be closed
  connected?:   boolean;   // undefined=local, true=sftp ok, false=sftp dropped
  hostId?:      string;    // host.id for reconnect
}

interface ColWidths { name: number; type: number; size: number; date: number; perms: number; owner: number; }
type SortCol = "name" | "type" | "size" | "date" | "perms" | "owner";

interface SubFile {
  relPath:  string;          // relative path, e.g. "subfolder/file.txt"
  name:     string;
  status:   "pending" | "running" | "done";
  transferred: number;
  total:    number;
  startedAt: number;
  elapsedMs?: number;
  speed:    number;
  lastAt?:  number;
  lastXfer?: number;
  paused?:  boolean;
}

interface SubCtxMenu {
  x: number; y: number;
  tid: string;
  parentPaused?: boolean;
  subFile?: SubFile;
  folderName?: string;
  folderFiles?: SubFile[];
}

interface Transfer {
  id: string; name: string; direction: "up" | "down";
  status: "pending" | "running" | "done" | "error";
  transferred: number; total: number; error?: string;
  srcPath:   string;
  dstPath:   string;
  speed:     number;   // bytes/sec (rolling)
  lastAt?:   number;   // timestamp of last progress event
  lastXfer?: number;   // transferred bytes at last event
  startedAt: number;   // Date.now() when transfer was enqueued
  elapsedMs?: number;  // frozen at done/error for static display
  isDir?:     boolean;
  subFiles?:  SubFile[];
  paused?:    boolean;
  provider?:  TransferProvider;  // transfer backend (gates pause/resume etc.)
}

interface XferCtxMenu { x: number; y: number; transfer: Transfer; }

interface CtxMenu {
  x: number; y: number;
  pane: "left" | "right";
  entries: FileEntry[];
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

let _tabSeq = 0;
const _tid    = () => `pt${++_tabSeq}`;
const makeTab = (path: string, label: string, sftpId?: string, labelKey?: string): PaneTab => ({
  id: _tid(), path, input: path, editingInput: false,
  entries: [], loading: false, selected: new Set(), label, labelKey, sftpId,
  history: [path], histIdx: 0, homePath: path,
});

const paneTabLabel = (tab: PaneTab) => tab.labelKey ? i18nT(tab.labelKey) : tab.label;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parentPath(p: string): string {
  p = p.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i <= 0) return /^[A-Za-z]:$/.test(p) ? p + "\\" : "/";
  const parent = p.substring(0, i);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

function permsToOctal(perms: string): string {
  if (!perms || perms.length < 9) return "644";
  const s = perms.length === 10 ? perms.slice(1) : perms;
  const b = (r: string, w: string, x: string) =>
    ((r === "r" ? 4 : 0) + (w === "w" ? 2 : 0) + (["x","s","t"].includes(x) ? 1 : 0));
  return `${b(s[0],s[1],s[2])}${b(s[3],s[4],s[5])}${b(s[6],s[7],s[8])}`;
}

function isRoot(path: string): boolean {
  return path === "/" || /^[A-Za-z]:\\?$/.test(path);
}

function fmtSize(size: number): string {
  if (size < 1024)       return `${size} B`;
  if (size < 1048576)    return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1073741824) return `${(size / 1048576).toFixed(1)} MB`;
  return `${(size / 1073741824).toFixed(2)} GB`;
}

function fmtDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return "—";
  if (bps < 1024)       return `${bps.toFixed(0)} B/s`;
  if (bps < 1048576)    return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

function fmtRemain(bytes: number, bps: number): string {
  if (bps <= 0 || bytes <= 0) return "—";
  const s = Math.ceil(bytes / bps);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 > 0 ? `${s % 60}s` : ""}`.trim();
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 > 0 ? `${s % 60}s` : ""}`.trim();
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------------------
// FilePane
// ---------------------------------------------------------------------------

interface FilePaneProps {
  tabs:           PaneTab[];
  activeTabId:    string;
  colWidths:      ColWidths;
  onTabActivate:  (id: string) => void;
  onTabClose:     (id: string) => void;
  onTabAdd:       (e: React.MouseEvent) => void;
  onInputChange:  (tabId: string, v: string) => void;
  onNavigate:     (tabId: string, path: string) => void;
  onBack:         (tabId: string) => void;
  onForward:      (tabId: string) => void;
  onHome:         (tabId: string) => void;
  onUp:           (tabId: string) => void;
  onRefresh:      (tabId: string) => void;
  onEditPath:     (tabId: string, editing: boolean) => void;
  onShowDrives:   (tabId: string, btn: HTMLElement) => void;
  onToggleHidden: () => void;
  showHidden:     boolean;
  onSelect:       (tabId: string, fn: (prev: Set<string>) => Set<string>) => void;
  onContextMenu:  (e: React.MouseEvent, entries: FileEntry[]) => void;
  onBgContextMenu:(e: React.MouseEvent) => void;
  onColResize:    (col: keyof ColWidths, e: React.MouseEvent) => void;
  onTransfer?:    (entry: FileEntry) => void;
  onEdit?:        (entry: FileEntry) => void;
  onPaste?:       () => void;
  isDragOver?:    boolean;
  containerRef?:  React.RefObject<HTMLDivElement>;
  nativeIcons?:   boolean;
  style?:         React.CSSProperties;
}

function FilePane({
  tabs, activeTabId, colWidths,
  onTabActivate, onTabClose, onTabAdd,
  onInputChange, onNavigate, onBack, onForward, onHome, onUp, onRefresh, onEditPath,
  onShowDrives, onToggleHidden, showHidden,
  onSelect, onContextMenu, onBgContextMenu, onColResize,
  onTransfer, onEdit, onPaste, isDragOver = false, containerRef,
  nativeIcons = false, style,
}: FilePaneProps) {
  useT();
  const active = tabs.find(t => t.id === activeTabId) ?? tabs[0] ?? null;
  const isSftp = !!active?.sftpId;

  const handleClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (!active) return;
    onSelect(active.id, prev => {
      const next = new Set(prev);
      if (e.ctrlKey || e.metaKey) {
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
      } else { next.clear(); next.add(entry.path); }
      return next;
    });
  };

  const handleRowCtx = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault(); e.stopPropagation();
    if (!active) return;
    let sel: FileEntry[];
    if (active.selected.has(entry.path)) {
      sel = active.entries.filter(en => active.selected.has(en.path));
    } else {
      onSelect(active.id, () => new Set([entry.path]));
      sel = [entry];
    }
    onContextMenu(e, sel);
  };

  // ── Sort ──────────────────────────────────────────────────────────────────
  const [sortCol, setSortCol] = useState<SortCol | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // ── Search ────────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      if (sortDir === "asc") { setSortDir("desc"); }
      else { setSortCol(null); setSortDir("asc"); }   // 3rd click: clear
    } else { setSortCol(col); setSortDir("asc"); }
  };

  const Arrow = ({ col }: { col: SortCol }) =>
    sortCol !== col ? null : (
      <span className="sftp-sort-arrow">{sortDir === "asc" ? " ▴" : " ▾"}</span>
    );

  // ── Visible / displayed entries (hoisted for Ctrl+A and header checkbox) ──
  const { displayed, baseLength } = useMemo(() => {
    const entries = active?.entries ?? [];
    const base = showHidden ? entries : entries.filter(e => !e.name.startsWith("."));
    const vis  = search
      ? base.filter(e => e.name.toLowerCase().includes(search.toLowerCase()))
      : base;
    const sorted = sortCol ? [...vis].sort((a, b) => {
      const dc = Number(b.isDir) - Number(a.isDir);
      if (dc !== 0) return dc;
      let va: string | number, vb: string | number;
      switch (sortCol) {
        case "name":  va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case "type":  va = getFileType(a.name, a.isDir, a.isSymlink); vb = getFileType(b.name, b.isDir, b.isSymlink); break;
        case "size":  va = a.size; vb = b.size; break;
        case "date":  va = a.modified; vb = b.modified; break;
        case "perms": va = a.permissions; vb = b.permissions; break;
        case "owner": va = a.owner; vb = b.owner; break;
        default: va = ""; vb = "";
      }
      const c = typeof va === "number" ? va - (vb as number) : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? c : -c;
    }) : vis;
    return { displayed: sorted, baseLength: base.length };
  }, [active, showHidden, search, sortCol, sortDir]);
  const visible = displayed; // alias used by selAll / handleSelectAll / stats bar
  const selAll = visible.length > 0 && visible.every(e => active?.selected.has(e.path));

  const handleSelectAll = () => {
    if (!active) return;
    onSelect(active.id, () => selAll ? new Set() : new Set(visible.map(e => e.path)));
  };

  return (
    <div ref={containerRef} className="sftp-pane" style={style}>
      {/* ── Section header ── */}
      <div className="sftp-pane-section">
        <div className="sftp-tabs-row">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`sftp-tab${tab.id === activeTabId ? " sftp-tab-active" : ""}`}
              onClick={() => onTabActivate(tab.id)}
              data-tooltip={tab.path || paneTabLabel(tab)}>
              {tab.sftpId && (
                <span className="sftp-tab-proto">
                  {tab.provider === "ftp"
                    ? <FtpFolderIcon size={12} />
                    : tab.provider === "smb"
                      ? <SmbFolderIcon size={12} />
                      : <SshIcon size={12} />}
                </span>
              )}
              <span className="sftp-tab-name">{paneTabLabel(tab)}</span>
              <span className={`sftp-tab-dot sftp-tab-dot--${tab.connected === false ? "red" : "green"}`}/>
              {!tab.pinned && (
                <span className="sftp-tab-close"
                  onClick={ev => { ev.stopPropagation(); onTabClose(tab.id); }}>×</span>
              )}
            </button>
          ))}
          <button className="sftp-tab-add" onClick={onTabAdd} data-tooltip={i18nT("sftp.connectHost")}>+</button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="sftp-pane-toolbar">
        <button className="sftp-nav-btn" data-tooltip={i18nT("sftp.nav.back")}
          disabled={!active || active.histIdx === 0}
          onClick={() => active && onBack(active.id)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2L4 6L8 10"/></svg>
        </button>
        <button className="sftp-nav-btn" data-tooltip={i18nT("sftp.nav.forward")}
          disabled={!active || active.histIdx >= active.history.length - 1}
          onClick={() => active && onForward(active.id)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2L8 6L4 10"/></svg>
        </button>
        <span className="sftp-toolbar-sep"/>
        <button className="sftp-nav-btn" data-tooltip={i18nT("sftp.nav.home")}
          disabled={!active}
          onClick={() => active && onHome(active.id)}>
          <svg width="14" height="13" viewBox="0 0 14 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 6.5L7 1L13 6.5"/><path d="M2.5 5.5V12H5.5V8.5H8.5V12H11.5V5.5"/></svg>
        </button>
        <button className="sftp-nav-btn" data-tooltip={i18nT("sftp.nav.up")}
          disabled={!active}
          onClick={() => active && onUp(active.id)}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 11V2M3 5.5L6.5 2L10 5.5"/></svg>
        </button>
        <button className="sftp-nav-btn" data-tooltip={i18nT("sftp.nav.drives")}
          disabled={!active}
          onClick={e => active && onShowDrives(active.id, e.currentTarget)}>
          <svg width="14" height="13" viewBox="0 0 14 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="1" width="12" height="7.5" rx="1.2"/>
            <path d="M4 11.5h6M7 8.5v3"/>
          </svg>
        </button>

        {/* Breadcrumb or path input */}
        {active?.editingInput ? (
          <input className="sftp-path-input"
            autoFocus
            value={active.input}
            onChange={e => onInputChange(active.id, e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { onNavigate(active.id, active.input); onEditPath(active.id, false); }
              if (e.key === "Escape") onEditPath(active.id, false);
            }}
            onBlur={() => active && onEditPath(active.id, false)}
          />
        ) : (
          <div className="sftp-breadcrumb" onClick={() => active && onEditPath(active.id, true)}>
            {active ? parseBreadcrumb(active.path).map((seg, i, arr) => (
              <span key={i} style={{ display: "contents" }}>
                <button className="sftp-bc-seg"
                  onClick={e => { e.stopPropagation(); onNavigate(active.id, seg.path); }}>
                  {seg.label}
                </button>
                {i < arr.length - 1 && <span className="sftp-bc-sep">›</span>}
              </span>
            )) : <span className="sftp-bc-placeholder">—</span>}
          </div>
        )}

        <span className="sftp-toolbar-sep"/>
        <button className={`sftp-nav-btn${!showHidden ? " sftp-nav-btn--active" : ""}`}
          data-tooltip={showHidden ? i18nT("sftp.hidden.hide") : i18nT("sftp.hidden.show")}
          onClick={onToggleHidden}>
          <svg width="14" height="11" viewBox="0 0 14 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 1.5C4 1.5 1.5 5.5 1.5 5.5S4 9.5 7 9.5 12.5 5.5 12.5 5.5 10 1.5 7 1.5Z"/>
            <circle cx="7" cy="5.5" r="1.8"/>
            {!showHidden && <line x1="1.5" y1="1" x2="12.5" y2="10" stroke="currentColor" strokeWidth="1.4"/>}
          </svg>
        </button>
        <button className="sftp-nav-btn" data-tooltip={i18nT("sftp.refresh")}
          disabled={!active}
          onClick={() => active && onRefresh(active.id)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.5 2.5v4h-4"/><path d="M11.5 9.5A5 5 0 1 1 9.5 4L12.5 6.5"/></svg>
        </button>
      </div>

      {/* ── Search bar ── */}
      <div className="sftp-search-bar">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="sftp-search-icon">
          <circle cx="5" cy="5" r="3.5"/><line x1="8" y1="8" x2="11" y2="11"/>
        </svg>
        <input className="sftp-search-input" placeholder={i18nT("sftp.searchFiles")}
          value={search}
          onChange={e => { setSearch(e.target.value); }}
          onKeyDown={e => e.key === "Escape" && setSearch("")}/>
        {search && <span className="sftp-search-clear" onClick={() => setSearch("")}>×</span>}
      </div>

      {/* ── File list ── */}
      <div className={`sftp-file-list${active?.connected === false ? " sftp-file-list--offline" : ""}`}
        tabIndex={0}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === "a") {
            e.preventDefault();
            handleSelectAll();
          }
          if ((e.ctrlKey || e.metaKey) && e.key === "v") {
            if (isSftp && onPaste) { e.preventDefault(); onPaste(); }
          }
        }}
        onContextMenu={onBgContextMenu}
        onPointerDown={e => {
          // Deselect when clicking blank area (not on a file row)
          if (!(e.target as Element).closest('.sftp-row:not(.sftp-row-header)') && active) {
            onSelect(active.id, () => new Set());
          }
        }}>
        {!active ? (
          <div className="sftp-no-tabs">
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"
              style={{ opacity: 0.3 }}>
              <ellipse cx="12" cy="23.5" rx="7" ry="0.8" fill="currentColor" stroke="none"/>
              <path d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M2.25 13.838V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 8.5a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.1 13.177a2.25 2.25 0 0 0-.1.661z"/>
            </svg>
            <span>{i18nT("sftp.noTabs")}</span>
          </div>
        ) : (<>
          {/* Header with resize handles + sort */}
          <div className="sftp-row sftp-row-header">
            <span className="sftp-col sftp-col-hdr sftp-col-name"
              style={{ flex: "none", width: colWidths.name, minWidth: 0 }}
              onClick={() => handleSort("name")}>
              {i18nT("sftp.col.name")}<Arrow col="name"/>
              <span className="sftp-rz" onMouseDown={e => { e.stopPropagation(); onColResize("name", e); }} onClick={e => e.stopPropagation()}/>
            </span>
            <span className="sftp-col sftp-col-hdr" style={{ width: colWidths.type, flexShrink: 0 }}
              onClick={() => handleSort("type")}>
              {i18nT("sftp.col.type")}<Arrow col="type"/>
              <span className="sftp-rz" onMouseDown={e => { e.stopPropagation(); onColResize("type", e); }} onClick={e => e.stopPropagation()}/>
            </span>
            <span className="sftp-col sftp-col-hdr" style={{ width: colWidths.size, textAlign: "center", flexShrink: 0 }}
              onClick={() => handleSort("size")}>
              {i18nT("sftp.col.size")}<Arrow col="size"/>
              <span className="sftp-rz" onMouseDown={e => { e.stopPropagation(); onColResize("size", e); }} onClick={e => e.stopPropagation()}/>
            </span>
            <span className="sftp-col sftp-col-hdr" style={{ width: colWidths.date, textAlign: "center", flexShrink: 0 }}
              onClick={() => handleSort("date")}>
              {i18nT("sftp.col.date")}<Arrow col="date"/>
              <span className="sftp-rz" onMouseDown={e => { e.stopPropagation(); onColResize("date", e); }} onClick={e => e.stopPropagation()}/>
            </span>
            <span className="sftp-col sftp-col-hdr" style={{ width: colWidths.perms, flexShrink: 0 }}
              onClick={() => handleSort("perms")}>
              {i18nT("sftp.col.perms")}<Arrow col="perms"/>
              <span className="sftp-rz" onMouseDown={e => { e.stopPropagation(); onColResize("perms", e); }} onClick={e => e.stopPropagation()}/>
            </span>
            <span className="sftp-col sftp-col-hdr" style={{ width: colWidths.owner, flexShrink: 0 }}
              onClick={() => handleSort("owner")}>
              {i18nT("sftp.col.owner")}<Arrow col="owner"/>
              <span className="sftp-rz" onMouseDown={e => { e.stopPropagation(); onColResize("owner", e); }} onClick={e => e.stopPropagation()}/>
            </span>
          </div>

          {active.loading && <div className="sftp-loading">{i18nT("sftp.loading")}</div>}

          {/* .. parent directory shortcut */}
          {!active.loading && !isRoot(active.path) && (
            <div className="sftp-row sftp-row-dotdot"
              onDoubleClick={() => onUp(active.id)}>
              <span className="sftp-col sftp-col-name" style={{ flex: "none", width: colWidths.name, minWidth: 0 }}>
                <SvgFileIcon name=".." isDir={true} isSymlink={false}/>
                <span className="sftp-name">..</span>
              </span>
              <span className="sftp-col sftp-muted" style={{ width: colWidths.type, flexShrink: 0 }}/>
              <span className="sftp-col sftp-muted" style={{ width: colWidths.size, flexShrink: 0 }}/>
              <span className="sftp-col sftp-muted" style={{ width: colWidths.date, flexShrink: 0 }}/>
              <span className="sftp-col sftp-muted" style={{ width: colWidths.perms, flexShrink: 0 }}/>
              <span className="sftp-col sftp-muted" style={{ width: colWidths.owner, flexShrink: 0 }}/>
            </div>
          )}

          {!active.loading && displayed.map(entry => (
              <div key={entry.path}
                className={`sftp-row${active.selected.has(entry.path) ? " sftp-row-sel" : ""}`}
                onClick={e => handleClick(e, entry)}
                onDoubleClick={() => {
                  if (entry.isDir) { onNavigate(active.id, entry.path); return; }
                  if (isSftp && onEdit) onEdit(entry);
                  else onTransfer?.(entry);
                }}
                onContextMenu={e => handleRowCtx(e, entry)}>
                <span className="sftp-col sftp-col-name" style={{ flex: "none", width: colWidths.name, minWidth: 0 }}>
                  <FileTypeIcon path={entry.path} name={entry.name}
                    isDir={entry.isDir} isSymlink={entry.isSymlink}
                    nativeIcons={nativeIcons && !active.sftpId}/>
                  <span className="sftp-name">{entry.name}</span>
                </span>
                <span className="sftp-col sftp-muted" style={{ width: colWidths.type, flexShrink: 0 }}>
                  {getFileType(entry.name, entry.isDir, entry.isSymlink)}
                </span>
                <span className="sftp-col sftp-muted" style={{ width: colWidths.size, flexShrink: 0 }}>
                  {entry.isDir ? "" : fmtSize(entry.size)}
                </span>
                <span className="sftp-col sftp-muted" style={{ width: colWidths.date, flexShrink: 0 }}>
                  {fmtDate(entry.modified)}
                </span>
                <span className="sftp-col sftp-muted sftp-mono" style={{ width: colWidths.perms, flexShrink: 0 }}>
                  {entry.permissions}
                </span>
                <span className="sftp-col sftp-muted" style={{ width: colWidths.owner, flexShrink: 0 }}>
                  {entry.owner === "0" ? "" : entry.owner}
                </span>
              </div>
          ))}

          {!active.loading && active.entries.length === 0 && (
            <div className="sftp-empty">{i18nT("sftp.emptyDir")}</div>
          )}
          {!active.loading && active.entries.length > 0 &&
            !showHidden && active.entries.every(e => e.name.startsWith(".")) && (
            <div className="sftp-empty">{i18nT("sftp.onlyHidden")}</div>
          )}
        </>)}

        {/* Drag-drop upload overlay (only for SFTP panes) */}
        {isDragOver && isSftp && (
          <div className="sftp-drag-overlay">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>{i18nT("sftp.dropUpload")}</span>
          </div>
        )}

        {/* Disconnected overlay */}
        {active?.connected === false && (
          <div className="sftp-offline-overlay">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23"/>
              <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
              <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
              <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
              <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
              <line x1="12" y1="20" x2="12.01" y2="20"/>
            </svg>
            <span className="sftp-offline-overlay-title">{i18nT("sftp.disconnected")}</span>
            <span className="sftp-offline-overlay-hint">
              {i18nT("sftp.clickReconnect")}
              <span className="sftp-offline-icon-chip"
                onClick={() => active && onRefresh(active.id)}>
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.5 2.5v4h-4"/><path d="M11.5 9.5A5 5 0 1 1 9.5 4L12.5 6.5"/>
                </svg>
              </span>
              {i18nT("sftp.reconnect")}
            </span>
          </div>
        )}
      </div>

      {/* ── Stats bar ── */}
      {active && (() => {
        const dirs  = visible.filter(e =>  e.isDir).length;
        const files = visible.filter(e => !e.isDir).length;
        const sel   = visible.filter(e => active.selected.has(e.path));
        const selSize = sel.reduce((s, e) => s + e.size, 0);

        let text: string;
        if (sel.length > 0) {
          text = `${i18nT("sftp.stats.selected", { count: sel.length })}${selSize > 0 ? `（${fmtSize(selSize)}）` : ""}`;
        } else if (search) {
          text = i18nT("sftp.stats.matches", { visible: visible.length, total: baseLength });
        } else {
          const parts: string[] = [];
          if (dirs  > 0) parts.push(i18nT("sftp.stats.folders", { count: dirs }));
          if (files > 0) parts.push(i18nT("sftp.stats.files", { count: files }));
          text = parts.join("，") || i18nT("sftp.stats.empty");
        }
        return <div className="sftp-stats-bar">{text}</div>;
      })()}
    </div>
  );
}

// Only re-render a pane when its own data changes, not when the other pane's
// state changes.  Callbacks are intentionally excluded from the comparison
// because they close over refs / functional updaters and remain correct even
// when "stale" between the data-driven re-renders.
const MemoFilePane = React.memo(FilePane, (a, b) =>
  a.tabs         === b.tabs         &&
  a.activeTabId  === b.activeTabId  &&
  a.colWidths    === b.colWidths    &&
  a.showHidden   === b.showHidden   &&
  a.isDragOver   === b.isDragOver   &&
  a.nativeIcons  === b.nativeIcons  &&
  a.style        === b.style
);

// ---------------------------------------------------------------------------
// SftpView
// ---------------------------------------------------------------------------

const DEFAULT_SFTP_SETTINGS: SftpSettings = {
  doubleClick: "Transfer", editCommand: "", preserveMtime: true, pinTab: false, defaultDir: "", clearDone: false,
};

function SftpView({ sessionId: _sessionId, hostname: _hostname, hosts: propHosts = [], sftpSettings = DEFAULT_SFTP_SETTINGS, autoConnect = null, onAutoConnectDone, connectHost = null }: {
  sessionId?:    string;
  hostname?:     string;
  hosts?:        Host[];
  sftpSettings?: SftpSettings;
  autoConnect?:  { host: Host; sessionId: string; startDir: string; nonce: number } | null;
  onAutoConnectDone?: () => void;
  /** Directly connect to a host (e.g. an FTP host) on mount, no SSH session. */
  connectHost?:  { host: Host; nonce: number } | null;
}) {
  useT();

  // ── Pane state ────────────────────────────────────────────────────────────
  const [leftTabs,    setLeftTabs]    = useState<PaneTab[]>([]);
  const [leftActive,  setLeftActive]  = useState<string>("");
  const leftActiveRef  = useRef("");
  const rightActiveRef = useRef("");
  const [rightTabs,   setRightTabs]   = useState<PaneTab[]>([]);
  const [rightActive, setRightActive] = useState<string>("");

  const leftTabsRef  = useRef<PaneTab[]>([]);
  const rightTabsRef = useRef<PaneTab[]>([]);
  useEffect(() => { leftTabsRef.current  = leftTabs;  }, [leftTabs]);
  useEffect(() => { rightTabsRef.current = rightTabs; }, [rightTabs]);
  useEffect(() => { leftActiveRef.current  = leftActive;  }, [leftActive]);
  useEffect(() => { rightActiveRef.current = rightActive; }, [rightActive]);

  const leftTab  = leftTabs.find(t  => t.id === leftActive)  ?? leftTabs[0]  ?? null;
  const rightTab = rightTabs.find(t => t.id === rightActive) ?? rightTabs[0] ?? null;

  // Maps a remote session id → its transfer backend, so remote commands/events
  // can be routed without threading the provider through every call site.
  const providerById = useRef<Map<string, TransferProvider>>(new Map());
  const providerOf = (sftpId: string | undefined): TransferProvider =>
    (sftpId ? providerById.current.get(sftpId) : undefined) ?? "sftp";

  // Protocol filter options for the host picker (hides uninstalled-plugin protocols).
  // Only transfer-capable protocols (SSH/SFTP, FTP) make sense in the picker.
  const pickerProtos = useAvailableProtocols()
    .filter((p) => p.canTransfer)
    .map((p) => ({ value: p.id, icon: p.icon, label: i18nT(p.filterLabelKey ?? p.filterLabel) }));

  // ── Drag-drop refs (used by Tauri onDragDropEvent listener) ──────────────
  const leftPaneRef    = useRef<HTMLDivElement>(null);
  const rightPaneRef   = useRef<HTMLDivElement>(null);
  const [dragHoverPane, setDragHoverPane] = useState<"left" | "right" | null>(null);
  // Stable ref to handleExternalUpload so the Tauri event listener (empty deps) always calls the fresh version.
  const externalUploadRef = useRef<(paths: string[], pane: "left" | "right") => void>(() => {});

  // ── Column widths (per pane) ──────────────────────────────────────────────
  const DEF_COL: ColWidths = { name: 200, type: 80, size: 68, date: 128, perms: 78, owner: 62 };
  const [leftColWidths,  setLeftColWidths]  = useState<ColWidths>(DEF_COL);
  const [rightColWidths, setRightColWidths] = useState<ColWidths>(DEF_COL);

  // ── Transfer panel column widths ─────────────────────────────────────────
  interface XferColW { name: number; status: number; progress: number; size: number; path: number; speed: number; remain: number; elapsed: number; }
  const DEF_XFER_COL: XferColW = { name: 160, status: 62, progress: 148, size: 130, path: 170, speed: 80, remain: 68, elapsed: 68 };
  const [xferCols, setXferCols] = useState<XferColW>(DEF_XFER_COL);
  const [xferColDragging, setXferColDragging] = useState<keyof XferColW | null>(null);
  const startXferColResize = (col: keyof XferColW, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = xferCols[col];
    setXferColDragging(col);
    const onMove = (me: MouseEvent) => setXferCols(prev => ({ ...prev, [col]: Math.max(40, startW + me.clientX - startX) }));
    const onUp = () => { setXferColDragging(null); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Conflict resolution ───────────────────────────────────────────────────
  interface ConflictReq {
    requestId: string; tid: string; relPath: string; name: string;
    isDir: boolean;
    existingSize: number; incomingSize: number; canResume: boolean;
    existingModified: number | null;  // Unix seconds
    incomingModified: number | null;
  }
  // Pre-transfer conflict (shown before the transfer starts)
  interface PreConflict {
    name: string; relPath: string; isDir: boolean;
    existingModified: number | null; incomingModified: number | null;
  }
  const [preConflict, setPreConflict] = useState<PreConflict | null>(null);
  const preConflictResolveRef = useRef<((r: { action: "overwrite" | "skip" | null; applyAll: boolean }) => void) | null>(null);

  const [conflictQueue, setConflictQueue] = useState<ConflictReq[]>([]);
  const [conflictApplyAll, setConflictApplyAll] = useState(false);
  const [conflictAction, setConflictAction] = useState<"overwrite" | "skip">("overwrite");
  // tid → action applied to all future conflicts for that transfer
  const applyAllRef = useRef(new Map<string, string>());

  // ── Transfer queue ────────────────────────────────────────────────────────
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const clearDoneRef = useRef(sftpSettings.clearDone);
  useEffect(() => { clearDoneRef.current = sftpSettings.clearDone; }, [sftpSettings.clearDone]);
  const [expandedXfers, setExpandedXfers] = useState<Set<string>>(new Set());
  // transferId -> Set<folderName> of folders the user has expanded (all collapsed by default)
  const [expandedSubFolders, setExpandedSubFolders] = useState<Map<string, Set<string>>>(new Map());
  const toggleSubFolder = useCallback((tid: string, folder: string) => {
    setExpandedSubFolders(prev => {
      const next = new Map(prev);
      const s = new Set(next.get(tid) ?? []);
      s.has(folder) ? s.delete(folder) : s.add(folder);
      next.set(tid, s);
      return next;
    });
  }, []);
  const [xferCtxMenu, setXferCtxMenu] = useState<XferCtxMenu | null>(null);
  const xferCtxRef        = useRef<HTMLDivElement>(null);
  const subCtxRef         = useRef<HTMLDivElement>(null);
  const [subCtxMenu, setSubCtxMenu] = useState<SubCtxMenu | null>(null);
  // relPaths to hide in the transfer panel (deleted sub-items)
  const hiddenSubPathsRef = useRef<Map<string, Set<string>>>(new Map());

  // ── Context menu ──────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  // ── Custom dialog ─────────────────────────────────────────────────────────
  const [dialog, setDialog] = useState<{
    type: "confirm" | "input";
    message: string;
    defaultValue?: string;
    danger?: boolean;
    resolve: (v: string | boolean | null) => void;
  } | null>(null);
  const dlgInputRef = useRef<HTMLInputElement>(null);

  const showConfirm = (message: string, danger = false): Promise<boolean> =>
    new Promise(resolve => setDialog({ type: "confirm", message, danger, resolve: v => resolve(v as boolean) }));

  const showInput = (message: string, defaultValue = ""): Promise<string | null> =>
    new Promise(resolve =>
      setDialog({ type: "input", message, defaultValue, resolve: v => resolve(v as string | null) }));

  const dlgConfirm = () => {
    if (!dialog) return;
    dialog.resolve(dialog.type === "input" ? (dlgInputRef.current?.value ?? "") : true);
    setDialog(null);
  };
  const dlgCancel = () => { dialog?.resolve(dialog.type === "input" ? null : false); setDialog(null); };

  // ── In-app file clipboard ─────────────────────────────────────────────────
  const fileClipboard = useRef<{ entries: FileEntry[]; srcSftpId?: string } | null>(null);
  const [clipboardFilled, setClipboardFilled] = useState(false);

  // ── SFTP sessions ─────────────────────────────────────────────────────────
  const sftpSessions       = useRef<Set<string>>(new Set());
  const sftpStatusUnlisten = useRef<Map<string, UnlistenFn>>(new Map());

  // ── Show hidden files (per pane) ─────────────────────────────────────────
  const [leftShowHidden,  setLeftShowHidden]  = useState(true);
  const [rightShowHidden, setRightShowHidden] = useState(true);

  // ── Drives popup ──────────────────────────────────────────────────────────
  const [localDrives, setLocalDrives] = useState<string[]>([]);
  const [drivesMenu, setDrivesMenu] = useState<{
    x: number; y: number;
    pane: "left" | "right";
    tabId: string;
    paths: string[];
  } | null>(null);
  const drivesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<string[]>("local_list_drives").then(setLocalDrives).catch(() => {});
  }, []);

  const showDrives = useCallback((
    pane: "left" | "right",
    tabId: string,
    btn: HTMLElement,
  ) => {
    const tabsRef = pane === "left" ? leftTabsRef : rightTabsRef;
    const tab = tabsRef.current.find(t => t.id === tabId);
    const paths = tab?.sftpId
      ? ["/", "/home", "/root", "/tmp", "/var", "/etc", "/opt", "/srv"]
      : localDrives;
    const rect = btn.getBoundingClientRect();
    setDrivesMenu({ x: rect.left, y: rect.bottom + 4, pane, tabId, paths });
  }, [localDrives]);

  useEffect(() => {
    if (!drivesMenu) return;
    const h = (e: MouseEvent) => {
      if (!drivesRef.current?.contains(e.target as Node)) setDrivesMenu(null);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [!!drivesMenu]);

  // ── Divider ───────────────────────────────────────────────────────────────
  const [dividerPct, setDividerPct] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const panesRef = useRef<HTMLDivElement>(null);

  // ── Host picker ───────────────────────────────────────────────────────────
  const [picker,            setPicker]           = useState<{ x: number; y: number } | null>(null);
  const [pickerPane,        setPickerPane]        = useState<"left" | "right">("right");
  const [pickerSearch,      setPickerSearch]      = useState("");
  const [pickerProtoFilter, setPickerProtoFilter] = useState("SSH");
  const [pickerProtoDropOpen, setPickerProtoDropOpen] = useState(false);
  const [connecting,        setConnecting]        = useState<string | null>(null);
  const pickerRef      = useRef<HTMLDivElement>(null);
  const pickerProtoRef = useRef<HTMLDivElement>(null);
  // Use the live host list from App.tsx and drop soft-deleted entries.
  const pickerHosts = propHosts.filter(h => !h.deleted);

  useEffect(() => {
    if (pickerProtos.length > 0 && !pickerProtos.some((p) => p.value === pickerProtoFilter)) {
      setPickerProtoFilter(pickerProtos[0].value);
    }
  }, [pickerProtoFilter, pickerProtos]);

  // ── Init: left pane = Desktop, right pane = empty ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = await invoke<string>("local_home_dir");
        if (cancelled) return;
        const sep  = home.includes("\\") ? "\\" : "/";
        const lt   = { ...makeTab(`${home}${sep}Desktop`, "Local", undefined, "sftp.localTab"), pinned: true };
        setLeftTabs([lt]);
        setLeftActive(lt.id);
        leftTabsRef.current = [lt];
        loadDir(lt.id, lt.path, undefined, setLeftTabs);
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
      for (const id of sftpSessions.current) {
        invoke(rcmd(providerOf(id), "close"), { sftpId: id }).catch(() => {});
        sftpStatusUnlisten.current.get(id)?.();
      }
      sftpStatusUnlisten.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Directory loader (unified: local or remote) ───────────────────────────
  const loadDir = useCallback(async (
    tabId:   string,
    path:    string,
    sftpId:  string | undefined,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
  ) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: true } : t));
    try {
      const entries = sftpId
        ? await invoke<FileEntry[]>(rcmd(providerOf(sftpId), "list_dir"), { sftpId, path })
        : await invoke<FileEntry[]>("local_list_dir", { path });
      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, loading: false, entries, path, input: path, selected: new Set() }
          : t
      ));
    } catch (err) {
      if (sftpId) toast(i18nT("sftp.error.loadDir", { error: String(err) }), "error");
      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, loading: false, ...(sftpId ? { connected: false } : {}) }
          : t
      ));
    }
  }, []);

  // ── History navigation ────────────────────────────────────────────────────

  const navigateTo = useCallback((
    tabId:   string,
    path:    string,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
    tabsRef: React.MutableRefObject<PaneTab[]>,
  ) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;
    const newHist = [...tab.history.slice(0, tab.histIdx + 1), path];
    setTabs(prev => prev.map(t => t.id === tabId
      ? { ...t, history: newHist, histIdx: newHist.length - 1, input: path, editingInput: false }
      : t));
    loadDir(tabId, path, tab.sftpId, setTabs);
  }, [loadDir]);

  const goBack = useCallback((
    tabId:   string,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
    tabsRef: React.MutableRefObject<PaneTab[]>,
  ) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab || tab.histIdx === 0) return;
    const newIdx = tab.histIdx - 1;
    const path   = tab.history[newIdx];
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, histIdx: newIdx, input: path } : t));
    loadDir(tabId, path, tab.sftpId, setTabs);
  }, [loadDir]);

  const goForward = useCallback((
    tabId:   string,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
    tabsRef: React.MutableRefObject<PaneTab[]>,
  ) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab || tab.histIdx >= tab.history.length - 1) return;
    const newIdx = tab.histIdx + 1;
    const path   = tab.history[newIdx];
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, histIdx: newIdx, input: path } : t));
    loadDir(tabId, path, tab.sftpId, setTabs);
  }, [loadDir]);

  const goHome = useCallback((
    tabId:   string,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
    tabsRef: React.MutableRefObject<PaneTab[]>,
  ) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;
    navigateTo(tabId, tab.homePath, setTabs, tabsRef);
  }, [navigateTo]);

  // ── Column resize (per pane) ──────────────────────────────────────────────
  const makeColResize = useCallback((
    colWidths: ColWidths,
    setWidths: React.Dispatch<React.SetStateAction<ColWidths>>,
  ) => (col: keyof ColWidths, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidths[col];
    const onMove = (me: MouseEvent) =>
      setWidths(prev => ({ ...prev, [col]: Math.max(44, startW + me.clientX - startX) }));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, []);

  // ── Transfer-panel vertical resize ───────────────────────────────────────
  const [xferHeight,    setXferHeight]    = useState(140);
  const [xferDragging,  setXferDragging]  = useState(false);

  const onXferDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = xferHeight;
    setXferDragging(true);
    const onMove = (me: MouseEvent) =>
      setXferHeight(Math.max(72, Math.min(480, startH - (me.clientY - startY))));
    const onUp = () => {
      setXferDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  // ── Divider drag ──────────────────────────────────────────────────────────
  const onDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const container = panesRef.current;
    const onMove = (me: MouseEvent) => {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setDividerPct(Math.max(20, Math.min(80, (me.clientX - rect.left) / rect.width * 100)));
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  // ── Tab close ─────────────────────────────────────────────────────────────
  const closeTab = (
    tabId:    string,
    tabs:     PaneTab[],
    setTabs:  React.Dispatch<React.SetStateAction<PaneTab[]>>,
    activeId: string,
    setActive:(id: string) => void,
  ) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab?.pinned) return;
    if (tab?.sftpId) {
      sftpStatusUnlisten.current.get(tab.sftpId)?.();
      sftpStatusUnlisten.current.delete(tab.sftpId);
      sftpSessions.current.delete(tab.sftpId);
      invoke(rcmd(providerOf(tab.sftpId), "close"), { sftpId: tab.sftpId }).catch(() => {});
      providerById.current.delete(tab.sftpId);
    }
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (next.length === 0) { setActive(""); return []; }
      if (activeId === tabId) {
        const idx = prev.findIndex(t => t.id === tabId);
        setActive(next[Math.min(idx, next.length - 1)].id);
      }
      return next;
    });
  };

  // ── Host picker ───────────────────────────────────────────────────────────
  const showHostPicker = (pane: "left" | "right", e: React.MouseEvent) => {
    e.stopPropagation();
    setPickerPane(pane);
    setPickerSearch("");
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPicker({ x: rect.left, y: rect.bottom + 4 });
  };

  const handleHostConnect = async (host: Host, targetPane?: "left" | "right") => {
    setConnecting(host.id);
    const pane: "left" | "right" = targetPane ?? pickerPane ?? "left";
    const proto = host.protocol.toUpperCase();
    const provider: TransferProvider = proto === "FTP" ? "ftp" : proto === "SMB" ? "smb" : "sftp";
    try {
      const { sftp_id: sftpId, home_dir: homeDir } = provider === "ftp"
        ? await invoke<{ sftp_id: string; home_dir: string }>("ftp_open_host", {
            params: {
              host:       host.host,
              port:       host.port,
              username:   host.username || undefined,
              password:   host.authentication.password || undefined,
              passive:    true,
              encoding:   host.options?.encoding || undefined,
              defaultDir:  host.options?.sftpDefaultDirectory || undefined,
              jumpHostIds: host.options?.jumpHosts?.length ? host.options.jumpHosts : undefined,
            },
          })
        : provider === "smb"
          ? await invoke<{ sftp_id: string; home_dir: string }>("smb_open_host", {
              params: {
                host: host.host,
                share: host.options?.extras?.smbShare || "",
                username: host.username || undefined,
                password: host.authentication.password || undefined,
                domain: host.options?.extras?.smbDomain || undefined,
                defaultDir: host.options?.sftpDefaultDirectory || undefined,
              },
            })
        : await invoke<{ sftp_id: string; home_dir: string }>("sftp_open_host", {
            params: {
              host:        host.host,
              port:        host.port,
              username:    host.username,
              authType:    host.authentication.type,
              password:    (host.authentication.type === "Password" || host.authentication.type === "PublicKey") ? host.authentication.password : undefined,
              proxyType:   host.proxy.type !== "NO" ? host.proxy.type : undefined,
              proxyHost:   host.proxy.host      || undefined,
              proxyPort:   host.proxy.port      || undefined,
              proxyUser:   host.proxy.username  || undefined,
              proxyPass:   host.proxy.password  || undefined,
              jumpHostIds: host.options?.jumpHosts?.length ? host.options.jumpHosts : undefined,
            },
          });
      providerById.current.set(sftpId, provider);
      sftpSessions.current.add(sftpId);
      void (async () => {
        const ref_ = { fn: null as UnlistenFn | null };
        // SFTP emits sftp://status (disconnected); the FTP plugin emits ftp://exit.
        const chan = provider === "ftp"
          ? `ftp://exit/${sftpId}`
          : provider === "smb"
            ? `smb://exit/${sftpId}`
            : `sftp://status/${sftpId}`;
        const ul = await listen<string>(chan, ev => {
          if (provider !== "sftp" || ev.payload === "disconnected") {
            setLeftTabs(prev  => prev.map(t  => t.sftpId  === sftpId ? { ...t, connected: false } : t));
            setRightTabs(prev => prev.map(t  => t.sftpId  === sftpId ? { ...t, connected: false } : t));
            sftpStatusUnlisten.current.delete(sftpId);
            ref_.fn?.();
          }
        });
        ref_.fn = ul;
        sftpStatusUnlisten.current.set(sftpId, ul);
      })();

      const startPath = host.options?.sftpDefaultDirectory || sftpSettings.defaultDir || homeDir;
      const label     = host.name || host.host;
      const tab       = { ...makeTab(startPath, label, sftpId), provider, connected: true, hostId: host.id };

      if (pane === "left") {
        setLeftTabs(prev => [...prev, tab]);
        setLeftActive(tab.id);
        leftTabsRef.current = [...leftTabsRef.current, tab];
        loadDir(tab.id, startPath, sftpId, setLeftTabs);
      } else {
        setRightTabs(prev => [...prev, tab]);
        setRightActive(tab.id);
        rightTabsRef.current = [...rightTabsRef.current, tab];
        loadDir(tab.id, startPath, sftpId, setRightTabs);
      }
      setPicker(null);
    } catch (err) {
      toast(i18nT("sftp.error.connect", { error: String(err) }), "error", `${host.name || host.host}`);
    } finally {
      setConnecting(null);
    }
  };

  // Directly open a host (e.g. an FTP host) into the left pane on mount.
  const connectHostNonce = useRef<number | null>(null);
  useEffect(() => {
    if (connectHost?.host && connectHostNonce.current !== connectHost.nonce) {
      connectHostNonce.current = connectHost.nonce;
      void handleHostConnect(connectHost.host, "right");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectHost?.nonce]);

  // ── Auto-connect from active SSH terminal (reuses existing SSH session) ──
  const handleAutoConnect = useCallback(async (host: Host, sessionId: string, startDir: string) => {
    try {
      const sftpId = await invoke<string>("sftp_open", { sessionId });
      sftpSessions.current.add(sftpId);
      const ref_ = { fn: null as UnlistenFn | null };
      const ul = await listen<string>(`sftp://status/${sftpId}`, ev => {
        if (ev.payload === "disconnected") {
          setLeftTabs(prev  => prev.map(t => t.sftpId === sftpId ? { ...t, connected: false } : t));
          setRightTabs(prev => prev.map(t => t.sftpId === sftpId ? { ...t, connected: false } : t));
          sftpStatusUnlisten.current.delete(sftpId);
          ref_.fn?.();
        }
      });
      ref_.fn = ul;
      sftpStatusUnlisten.current.set(sftpId, ul);
      // exec channel starts at HOME — use that as the canonical home path
      let homeDir = "/";
      try { homeDir = await invoke<string>("ssh_get_cwd", { sessionId }); } catch { /* stay at "/" */ }
      const startPath = startDir || sftpSettings.defaultDir || homeDir;
      const label     = host.name || host.host;
      const tab       = { ...makeTab(startPath, label, sftpId), connected: true, hostId: host.id, homePath: homeDir };
      setRightTabs(prev => [...prev, tab]);
      setRightActive(tab.id);
      rightTabsRef.current = [...rightTabsRef.current, tab];
      loadDir(tab.id, startPath, sftpId, setRightTabs);
    } catch (err) {
      toast(i18nT("sftp.error.autoConnect", { error: String(err) }), "error", `${host.name || host.host}`);
    }
  }, [sftpSettings.defaultDir, loadDir]);

  useEffect(() => {
    if (!autoConnect) return;
    handleAutoConnect(autoConnect.host, autoConnect.sessionId, autoConnect.startDir);
    onAutoConnectDone?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect?.nonce]);

  // ── Reconnect disconnected SFTP tab ──────────────────────────────────────
  const reconnectTab = useCallback(async (
    tabId: string,
    host:  Host,
    pane:  "left" | "right",
  ) => {
    const setTabs = pane === "left" ? setLeftTabs : setRightTabs;
    const tabsRef = pane === "left" ? leftTabsRef : rightTabsRef;
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, loading: true } : t));
    try {
      const { sftp_id: newSftpId } = await invoke<{ sftp_id: string; home_dir: string }>("sftp_open_host", {
        params: {
          host:        host.host,
          port:        host.port,
          username:    host.username,
          authType:    host.authentication.type,
          password:    (host.authentication.type === "Password" || host.authentication.type === "PublicKey") ? host.authentication.password : undefined,
          proxyType:   host.proxy.type !== "NO" ? host.proxy.type : undefined,
          proxyHost:   host.proxy.host      || undefined,
          proxyPort:   host.proxy.port      || undefined,
          proxyUser:   host.proxy.username  || undefined,
          proxyPass:   host.proxy.password  || undefined,
          jumpHostIds: host.options?.jumpHosts?.length ? host.options.jumpHosts : undefined,
        },
      });
      const oldTab = tabsRef.current.find(t => t.id === tabId);
      if (oldTab?.sftpId) {
        sftpStatusUnlisten.current.get(oldTab.sftpId)?.();
        sftpStatusUnlisten.current.delete(oldTab.sftpId);
        sftpSessions.current.delete(oldTab.sftpId);
        invoke(rcmd(providerOf(oldTab.sftpId), "close"), { sftpId: oldTab.sftpId }).catch(() => {});
        providerById.current.delete(oldTab.sftpId);
      }
      sftpSessions.current.add(newSftpId);
      void (async () => {
        const ref_ = { fn: null as UnlistenFn | null };
        const ul = await listen<string>(`sftp://status/${newSftpId}`, ev => {
          if (ev.payload === "disconnected") {
            setLeftTabs(prev  => prev.map(t => t.sftpId === newSftpId ? { ...t, connected: false } : t));
            setRightTabs(prev => prev.map(t => t.sftpId === newSftpId ? { ...t, connected: false } : t));
            sftpStatusUnlisten.current.delete(newSftpId);
            ref_.fn?.();
          }
        });
        ref_.fn = ul;
        sftpStatusUnlisten.current.set(newSftpId, ul);
      })();
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, sftpId: newSftpId, connected: true, loading: false } : t
      ));
      const path = oldTab?.path ?? "/";
      loadDir(tabId, path, newSftpId, setTabs);
    } catch (err) {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, loading: false } : t
      ));
      toast(i18nT("sftp.error.reconnect", { error: String(err) }), "error");
    }
  }, [loadDir]);

  // Picker: outside-click dismiss
  useEffect(() => {
    if (!picker) return;
    const h = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicker(null);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [!!picker]);

  // Picker proto dropdown: outside-click dismiss
  useEffect(() => {
    if (!pickerProtoDropOpen) return;
    const h = (e: MouseEvent) => {
      if (!pickerProtoRef.current?.contains(e.target as Node)) setPickerProtoDropOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [pickerProtoDropOpen]);

  // Picker: auto-position inside viewport
  useLayoutEffect(() => {
    const el = pickerRef.current;
    if (!el || !picker) return;
    const { width, height } = el.getBoundingClientRect();
    const x = picker.x + width  > window.innerWidth  ? picker.x - width  : picker.x;
    const y = picker.y + height > window.innerHeight ? picker.y - height - 44 : picker.y;
    el.style.left = `${Math.max(4, x)}px`;
    el.style.top  = `${Math.max(4, y)}px`;
  }, [picker, pickerHosts.length]);

  // ── Selection ─────────────────────────────────────────────────────────────
  const selectLeft  = (tabId: string, fn: (p: Set<string>) => Set<string>) =>
    setLeftTabs(prev  => prev.map(t => t.id === tabId ? { ...t, selected: fn(t.selected) } : t));
  const selectRight = (tabId: string, fn: (p: Set<string>) => Set<string>) =>
    setRightTabs(prev => prev.map(t => t.id === tabId ? { ...t, selected: fn(t.selected) } : t));

  // ── Transfer tracking ─────────────────────────────────────────────────────
  const trackTransfer = useCallback((
    id: string, name: string, direction: "up" | "down",
    srcPath: string, dstPath: string,
    onDone: () => void,
    isDir = false,
    provider: TransferProvider = "sftp",
  ): Promise<void> => {
    setTransfers(prev => [...prev, {
      id, name, direction, status: "pending",
      transferred: 0, total: 0, srcPath, dstPath, speed: 0,
      startedAt: Date.now(), isDir, subFiles: isDir ? [] : undefined, provider,
    }]);
    const unsubs: Promise<UnlistenFn>[] = [];
    const cleanup = () => Promise.all(unsubs).then(fns => fns.forEach(fn => fn()));
    unsubs.push(listen<{ transferred: number; total: number }>(revt(provider, "progress", id), ev => {
      const now = Date.now();
      setTransfers(prev => prev.map(t => {
        if (t.id !== id) return t;
        const dt = now - (t.lastAt ?? now);
        const dx = ev.payload.transferred - (t.lastXfer ?? 0);
        const speed = dt > 80 && dx > 0 ? dx / (dt / 1000) : t.speed;
        return {
          ...t, status: "running",
          transferred: ev.payload.transferred, total: ev.payload.total,
          speed, lastAt: now, lastXfer: ev.payload.transferred,
        };
      }));
    }));
    unsubs.push(listen<{ transferred: number; total: number } | null>(revt(provider, "done", id), ev => {
      const p = ev.payload;
      setTransfers(prev => prev.map(t => {
        if (t.id !== id) return t;
        // Use payload values (from sftp_upload/sftp_download) when available; fall back to
        // accumulated state (from dir transfers or if events were missed for small files).
        const finalTotal = (p?.total ?? 0) || t.total;
        const finalXfer  = (p?.transferred ?? 0) || t.transferred || finalTotal;
        return { ...t, status: "done", transferred: finalXfer, total: finalTotal, speed: 0,
          elapsedMs: Date.now() - t.startedAt,
          subFiles: t.subFiles?.map(f => ({ ...f, status: "done" as const })) };
      }));
      if (clearDoneRef.current) {
        setTimeout(() => setTransfers(prev => prev.filter(t => t.id !== id)), 1000);
      }
      cleanup(); onDone();
    }));
    unsubs.push(listen<string>(revt(provider, "error", id), ev => {
      const msg = ev.payload || i18nT("sftp.xfer.unknownError");
      setTransfers(prev => prev.map(t => t.id === id
        ? { ...t, status: "error", error: msg, speed: 0,
            elapsedMs: Date.now() - t.startedAt } : t));
      toast(msg, "error", i18nT("sftp.error.transferTitle", { name }));
      cleanup();
    }));
    unsubs.push(listen<{
      requestId: string; relPath: string; name: string;
      isDir: boolean;
      existingSize: number; incomingSize: number; canResume: boolean;
      existingModified: number | null; incomingModified: number | null;
    }>(revt(provider, "conflict", id), ev => {
      const req: ConflictReq = {
        requestId: ev.payload.requestId, tid: id,
        relPath: ev.payload.relPath, name: ev.payload.name,
        isDir: ev.payload.isDir,
        existingSize: ev.payload.existingSize, incomingSize: ev.payload.incomingSize,
        canResume: ev.payload.canResume,
        existingModified: ev.payload.existingModified,
        incomingModified: ev.payload.incomingModified,
      };
      // If "apply to all" was set for this transfer, resolve immediately
      const saved = applyAllRef.current.get(id);
      if (saved) {
        invoke("sftp_resolve_conflict", { requestId: req.requestId, action: saved });
        return;
      }
      setConflictQueue(q => [...q, req]);
    }));
    if (isDir) {
      unsubs.push(listen<{ rel_path: string; name: string; done: boolean; transferred: number; total: number }>(revt(provider, "file", id), ev => {
        const { rel_path: relPath, name: fname, done, transferred: xf, total: tot } = ev.payload;
        if (hiddenSubPathsRef.current.get(id)?.has(relPath)) return;
        const now = Date.now();
        setTransfers(prev => prev.map(t => {
          if (t.id !== id) return t;
          const subs = [...(t.subFiles ?? [])];
          const idx = subs.findIndex(f => f.relPath === relPath);
          if (idx === -1) {
            subs.push({ relPath, name: fname,
              status: done ? "done" : xf > 0 ? "running" : "pending",
              transferred: xf, total: tot, speed: 0, startedAt: now });
          } else {
            const f = subs[idx];
            const dt = now - (f.lastAt ?? now);
            const dx = xf - (f.lastXfer ?? 0);
            const speed = !done && dt > 80 && dx > 0 ? dx / (dt / 1000) : done ? 0 : f.speed;
            subs[idx] = { ...f, status: done ? "done" : "running",
              transferred: done ? tot : xf, total: tot, speed, lastAt: now, lastXfer: xf,
              ...(done ? { elapsedMs: now - f.startedAt } : {}) };
          }
          return { ...t, subFiles: subs };
        }));
      }));
    }
    // Resolves when all event listeners are registered with the Tauri backend.
    // Callers that need to start the transfer only after listeners are ready
    // should await this return value before invoking the backend command.
    return Promise.all(unsubs).then(() => {});
  }, []);

  // ── File operations ───────────────────────────────────────────────────────
  const otherPaneOf = (pane: "left" | "right"): "left" | "right" => pane === "left" ? "right" : "left";

  const handleCopyToOther = async (fromPane: "left" | "right", fileEntries: FileEntry[]) => {
    const srcTab  = fromPane === "left" ? leftTab  : rightTab;
    const destTab = fromPane === "left" ? rightTab : leftTab;
    if (!destTab || fileEntries.length === 0) return;
    // Require one side to be local and the other to be SFTP
    const isUpload   = !srcTab?.sftpId && !!destTab.sftpId;
    const isDownload = !!srcTab?.sftpId && !destTab.sftpId;
    if (!isUpload && !isDownload) return;
    setCtxMenu(null);

    const toPane       = otherPaneOf(fromPane);
    const destSetT     = toPane === "left" ? setLeftTabs : setRightTabs;
    const destTabsRef  = toPane === "left" ? leftTabsRef : rightTabsRef;
    const destActRef   = toPane === "left" ? leftActiveRef : rightActiveRef;
    const refresh = () => {
      // Only refresh the destination panel — the source hasn't changed.
      const dt = destTabsRef.current.find(x => x.id === destActRef.current);
      if (dt) loadDir(dt.id, dt.path, dt.sftpId, destSetT);
    };

    let preApplyAll = false;
    let preApplyAction: string | null = null;

    for (const entry of fileEntries) {
      const destPath = joinPath(destTab.path, entry.name);

      // ── Pre-transfer conflict check (using current directory listing) ────────
      const clash = destTab.entries.find(f => f.name === entry.name);
      let resolvedAction: string | null = null; // the overwrite/skip choice for this entry

      if (clash) {
        if (preApplyAll) {
          if (preApplyAction === "skip") continue;
          resolvedAction = preApplyAction; // "overwrite"
        } else {
          // Show dialog and wait for user decision
          const result = await new Promise<{ action: "overwrite" | "skip" | null; applyAll: boolean }>(resolve => {
            preConflictResolveRef.current = resolve;
            setPreConflict({
              name: entry.name, relPath: entry.path, isDir: entry.isDir,
              existingModified: clash.modified,
              incomingModified: entry.modified,
            });
            setConflictAction("overwrite");
            setConflictApplyAll(false);
          });
          setPreConflict(null);

          if (result.action === null) break;      // Cancel → stop all transfers
          if (result.action === "skip") continue;  // Skip this entry only
          resolvedAction = result.action;          // "overwrite"
          if (result.applyAll) {
            preApplyAll = true;
            preApplyAction = result.action;
          }
        }
      }

      const remoteProvider = providerOf(isUpload ? destTab.sftpId : srcTab?.sftpId);
      if (entry.isDir && !providerCaps(remoteProvider).dirXfer) {
        toast(i18nT("sftp.error.dirTransferUnsupported", { provider: remoteProvider.toUpperCase(), name: entry.name }));
        continue;
      }
      try {
        const direction = isUpload ? "up" as const : "down" as const;
        // For FTP: register event listeners BEFORE starting the transfer so that
        // progress/done events emitted immediately after the command is sent are
        // not lost (the listen() IPC is async and takes ~20ms to register).
        if (!entry.isDir && (remoteProvider === "ftp" || remoteProvider === "smb")) {
          const tid = crypto.randomUUID();
          await trackTransfer(tid, entry.name, direction, entry.path, destPath, refresh, false, remoteProvider);
          if (resolvedAction === "overwrite") applyAllRef.current.set(tid, "overwrite");
          if (isUpload) {
            invoke(rcmd(remoteProvider, "upload"), {
              sftpId: destTab.sftpId, localPath: entry.path, remotePath: destPath,
              transferId: tid,
            }).catch(e => toast(i18nT("sftp.error.transfer", { name: entry.name, error: String(e) })));
          } else {
            invoke(rcmd(remoteProvider, "download"), {
              sftpId: srcTab!.sftpId!, remotePath: entry.path, localPath: destPath,
              transferId: tid,
            }).catch(e => toast(i18nT("sftp.error.transfer", { name: entry.name, error: String(e) })));
          }
          continue;
        }

        // SFTP / dir transfers: backend generates tid and returns it before events arrive.
        let tid: string;
        if (isUpload) {
          tid = entry.isDir
            ? await invoke<string>(
                remoteProvider === "smb" ? "smb_upload_dir" : "sftp_upload_dir",
                remoteProvider === "smb"
                  ? { sftpId: destTab.sftpId, localDir: entry.path, remoteBase: destTab.path }
                  : {
                      sftpId: destTab.sftpId, localDir: entry.path, remoteBase: destTab.path,
                      preserveMtime: sftpSettings.preserveMtime,
                    },
              )
            : await invoke<string>(rcmd(remoteProvider, "upload"), {
                sftpId: destTab.sftpId, localPath: entry.path, remotePath: destPath,
                preserveMtime: sftpSettings.preserveMtime,
              });
        } else {
          tid = entry.isDir
            ? await invoke<string>(
                remoteProvider === "smb" ? "smb_download_dir" : "sftp_download_dir",
                { sftpId: srcTab!.sftpId!, remoteDir: entry.path, localBase: destTab.path },
              )
            : await invoke<string>(rcmd(remoteProvider, "download"), {
                sftpId: srcTab!.sftpId!, remotePath: entry.path, localPath: destPath,
              });
        }
        // Pre-approved "overwrite": auto-resolve any backend conflict event for this tid
        // so the backend's own conflict check doesn't show a second dialog.
        if (resolvedAction === "overwrite") {
          applyAllRef.current.set(tid, "overwrite");
        }
        trackTransfer(tid, entry.name, direction, entry.path, destPath, refresh, entry.isDir, remoteProvider);
      } catch (err) { toast(i18nT("sftp.error.transfer", { name: entry.name, error: String(err) })); }
    }
  };

  // Upload arbitrary local paths (from OS drag-drop or clipboard paste) to an SFTP pane.
  const handleExternalUpload = async (localPaths: string[], toPane: "left" | "right") => {
    const destTab    = toPane === "left" ? leftTab  : rightTab;
    if (!destTab?.sftpId || localPaths.length === 0) return;

    const destSetT    = toPane === "left" ? setLeftTabs   : setRightTabs;
    const destTabsRef = toPane === "left" ? leftTabsRef   : rightTabsRef;
    const destActRef  = toPane === "left" ? leftActiveRef : rightActiveRef;

    const refresh = () => {
      const dt = destTabsRef.current.find(x => x.id === destActRef.current);
      if (dt) loadDir(dt.id, dt.path, dt.sftpId, destSetT);
    };

    type StatEntry = { path: string; name: string; isDir: boolean; size: number };
    let stats: StatEntry[];
    try {
      stats = await invoke<StatEntry[]>("local_stat_paths", { paths: localPaths });
    } catch (err) { toast(i18nT("sftp.error.stat", { error: String(err) })); return; }

    const remoteProvider = providerOf(destTab.sftpId);
    for (const s of stats) {
      if (s.isDir && !providerCaps(remoteProvider).dirXfer) {
        toast(i18nT("sftp.error.dirTransferUnsupported", { provider: remoteProvider.toUpperCase(), name: s.name }));
        continue;
      }
      try {
        const destPath = joinPath(destTab.path, s.name);
        if (!s.isDir && (remoteProvider === "ftp" || remoteProvider === "smb")) {
          const tid = crypto.randomUUID();
          await trackTransfer(tid, s.name, "up", s.path, destPath, refresh, false, remoteProvider);
          invoke(rcmd(remoteProvider, "upload"), {
            sftpId: destTab.sftpId, localPath: s.path, remotePath: destPath,
            transferId: tid,
          }).catch(e => toast(i18nT("sftp.error.upload", { name: s.name, error: String(e) })));
        } else {
          const tid = s.isDir
            ? await invoke<string>(
                remoteProvider === "smb" ? "smb_upload_dir" : "sftp_upload_dir",
                remoteProvider === "smb"
                  ? { sftpId: destTab.sftpId, localDir: s.path, remoteBase: destTab.path }
                  : {
                      sftpId: destTab.sftpId, localDir: s.path, remoteBase: destTab.path,
                      preserveMtime: sftpSettings.preserveMtime,
                    },
              )
            : await invoke<string>(rcmd(remoteProvider, "upload"), {
                sftpId: destTab.sftpId, localPath: s.path, remotePath: destPath,
                preserveMtime: sftpSettings.preserveMtime,
              });
          trackTransfer(tid, s.name, "up", s.path, destPath, refresh, s.isDir, remoteProvider);
        }
      } catch (err) { toast(i18nT("sftp.error.upload", { name: s.name, error: String(err) })); }
    }
  };

  const handlePasteUpload = async (toPane: "left" | "right") => {
    const destTab = toPane === "left" ? leftTab : rightTab;
    if (!destTab?.sftpId) return;
    try {
      const paths = await invoke<string[]>("local_clipboard_files");
      if (paths.length > 0) await handleExternalUpload(paths, toPane);
      else toast(i18nT("sftp.error.clipboardEmpty"));
    } catch (err) { toast(i18nT("sftp.error.clipboardRead", { error: String(err) })); }
  };

  // Keep ref in sync with the latest version so the stable Tauri listener can call it.
  externalUploadRef.current = handleExternalUpload;

  // ── Tauri OS drag-drop listener ───────────────────────────────────────────
  useEffect(() => {
    const hitPane = (x: number, y: number): "left" | "right" | null => {
      const l = leftPaneRef.current?.getBoundingClientRect();
      if (l && x >= l.left && x <= l.right && y >= l.top && y <= l.bottom) return "left";
      const r = rightPaneRef.current?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return "right";
      return null;
    };

    const unlistenP = getCurrentWebviewWindow().onDragDropEvent(event => {
      const payload = event.payload as any;
      const type: string = payload.type;
      if (type === "hover" || type === "drag") {
        const pos: { x: number; y: number } = payload.position ?? { x: 0, y: 0 };
        const dpr = window.devicePixelRatio || 1;
        setDragHoverPane(hitPane(pos.x / dpr, pos.y / dpr));
      } else if (type === "drop") {
        const pos: { x: number; y: number } = payload.position ?? { x: 0, y: 0 };
        const paths: string[] = payload.paths ?? [];
        const dpr = window.devicePixelRatio || 1;
        const pane = hitPane(pos.x / dpr, pos.y / dpr);
        setDragHoverPane(null);
        if (pane && paths.length > 0) externalUploadRef.current(paths, pane);
      } else {
        // "cancel" | "leave"
        setDragHoverPane(null);
      }
    });
    return () => { unlistenP.then(fn => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRemoteDelete = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>, entries: FileEntry[]) => {
    if (!tab.sftpId) return;
    setCtxMenu(null);
    if (!await showConfirm(i18nT("sftp.confirm.deleteEntries", { count: entries.length }), true)) return;
    for (const entry of entries) {
      try { await invoke(rcmd(providerOf(tab.sftpId), "remove"), { sftpId: tab.sftpId, path: entry.path, isDir: entry.isDir }); }
      catch (err) { toast(i18nT("sftp.error.delete", { error: String(err) })); }
    }
    loadDir(tab.id, tab.path, tab.sftpId, setTabs);
  };

  const handleRemoteMkdir = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>) => {
    if (!tab.sftpId) return;
    setCtxMenu(null);
    const name = await showInput(i18nT("sftp.input.newFolder"));
    if (!name?.trim()) return;
    try {
      await invoke(rcmd(providerOf(tab.sftpId), "mkdir"), { sftpId: tab.sftpId, path: joinPath(tab.path, name.trim()) });
      loadDir(tab.id, tab.path, tab.sftpId, setTabs);
    } catch (err) { toast(i18nT("sftp.error.create", { error: String(err) })); }
  };

  const handleRemoteRename = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>, entry: FileEntry) => {
    if (!tab.sftpId) return;
    setCtxMenu(null);
    const newName = await showInput(i18nT("sftp.input.rename"), entry.name);
    if (!newName?.trim() || newName === entry.name) return;
    const dir = entry.path.replace(/\/[^/]+$/, "");
    try {
      await invoke(rcmd(providerOf(tab.sftpId), "rename"), { sftpId: tab.sftpId, src: entry.path, dst: `${dir}/${newName.trim()}` });
      loadDir(tab.id, tab.path, tab.sftpId, setTabs);
    } catch (err) { toast(i18nT("sftp.error.rename", { error: String(err) })); }
  };

  const handleLocalRename = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>, entry: FileEntry) => {
    setCtxMenu(null);
    const newName = await showInput(i18nT("sftp.input.rename"), entry.name);
    if (!newName?.trim() || newName === entry.name) return;
    const lastSep = Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\"));
    const dir = entry.path.substring(0, lastSep);
    const sep = entry.path.includes("\\") ? "\\" : "/";
    try {
      await invoke("local_rename", { src: entry.path, dst: `${dir}${sep}${newName.trim()}` });
      loadDir(tab.id, tab.path, undefined, setTabs);
    } catch (err) { toast(i18nT("sftp.error.rename", { error: String(err) })); }
  };

  const handleLocalDelete = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>, entries: FileEntry[]) => {
    setCtxMenu(null);
    if (!await showConfirm(i18nT("sftp.confirm.deleteEntries", { count: entries.length }), true)) return;
    for (const entry of entries) {
      try { await invoke("local_delete", { path: entry.path, isDir: entry.isDir }); }
      catch (err) { toast(i18nT("sftp.error.deleteEntry", { name: entry.name, error: String(err) })); }
    }
    loadDir(tab.id, tab.path, undefined, setTabs);
  };

  const handleLocalMkdir = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>) => {
    setCtxMenu(null);
    const name = await showInput(i18nT("sftp.input.newFolder"));
    if (!name?.trim()) return;
    try {
      await invoke("local_mkdir", { path: joinPath(tab.path, name.trim()) });
      loadDir(tab.id, tab.path, undefined, setTabs);
    } catch (err) { toast(i18nT("sftp.error.create", { error: String(err) })); }
  };

  const handleLocalCreateFile = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>) => {
    setCtxMenu(null);
    const name = await showInput(i18nT("sftp.input.newFile"));
    if (!name?.trim()) return;
    try {
      await invoke("local_create_file", { path: joinPath(tab.path, name.trim()) });
      loadDir(tab.id, tab.path, undefined, setTabs);
    } catch (err) { toast(i18nT("sftp.error.create", { error: String(err) })); }
  };

  const handleRemoteCreateFile = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>) => {
    if (!tab.sftpId) return;
    if (providerOf(tab.sftpId) !== "sftp") {
      toast(i18nT("sftp.error.createFileUnsupported", { provider: providerUnsupportedLabel(providerOf(tab.sftpId)) }));
      return;
    }
    setCtxMenu(null);
    const name = await showInput(i18nT("sftp.input.newFile"));
    if (!name?.trim()) return;
    try {
      await invoke("sftp_create_file", { sftpId: tab.sftpId, path: joinPath(tab.path, name.trim()) });
      loadDir(tab.id, tab.path, tab.sftpId, setTabs);
    } catch (err) { toast(i18nT("sftp.error.create", { error: String(err) })); }
  };

  const handleChmod = async (tab: PaneTab, setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>, entry: FileEntry) => {
    if (!tab.sftpId) return;
    if (!providerCaps(providerOf(tab.sftpId)).chmod) {
      toast(i18nT("sftp.error.chmodUnsupported", { provider: providerUnsupportedLabel(providerOf(tab.sftpId)) }));
      return;
    }
    setCtxMenu(null);
    const currentOctal = permsToOctal(entry.permissions);
    const input = await showInput(i18nT("sftp.input.chmod"), currentOctal);
    if (!input?.trim()) return;
    const mode = parseInt(input.trim(), 8);
    if (isNaN(mode) || mode < 0 || mode > 0o7777) {
      toast(i18nT("sftp.error.chmodInvalid"));
      return;
    }
    try {
      await invoke("sftp_chmod", { sftpId: tab.sftpId, path: entry.path, mode });
      loadDir(tab.id, tab.path, tab.sftpId, setTabs);
    } catch (err) { toast(i18nT("sftp.error.chmod", { error: String(err) })); }
  };

  const handleCopyPath = async (entries: FileEntry[]) => {
    setCtxMenu(null);
    try { await navigator.clipboard.writeText(entries.map(e => e.path).join("\n")); }
    catch { toast(i18nT("sftp.error.copyPath")); }
  };

  const handleOpenInExplorer = async (entries: FileEntry[], tab: PaneTab) => {
    setCtxMenu(null);
    const target = entries.length === 1 ? entries[0].path : tab.path;
    try { await invoke("local_open_in_explorer", { path: target }); }
    catch (err) { toast(i18nT("sftp.error.open", { error: String(err) })); }
  };

  const handleEdit = async (tab: PaneTab, entries: FileEntry[]) => {
    setCtxMenu(null);
    for (const entry of entries.filter(e => e.isFile)) {
      try {
        if (tab.sftpId) {
          if (!providerCaps(providerOf(tab.sftpId)).edit) {
            toast(i18nT("sftp.error.remoteEditUnsupported", { provider: providerUnsupportedLabel(providerOf(tab.sftpId)) }));
            continue;
          }
          const cmd = sftpSettings.editCommand.trim() || undefined;
          await invoke("sftp_edit", { sftpId: tab.sftpId, remotePath: entry.path, editCommand: cmd });
        } else {
          await invoke("local_open_file", { path: entry.path });
        }
      } catch (err) { toast(i18nT("sftp.error.open", { error: String(err) })); }
    }
  };

  const handleCopy = (tab: PaneTab, entries: FileEntry[]) => {
    setCtxMenu(null);
    fileClipboard.current = { entries, srcSftpId: tab.sftpId };
    setClipboardFilled(true);
  };

  const handlePaste = async (
    tab: PaneTab,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
  ) => {
    setCtxMenu(null);
    const clip = fileClipboard.current;
    if (!clip || clip.entries.length === 0) return;
    const filesToPaste = clip.entries.filter(e => e.isFile);
    let localCount = 0;
    for (const entry of filesToPaste) {
      const dst = joinPath(tab.path, entry.name);
      try {
        if (!clip.srcSftpId && !tab.sftpId) {
          await invoke("local_copy_file", { src: entry.path, dst });
          localCount++;
        } else if (!clip.srcSftpId && tab.sftpId) {
          const prov = providerOf(tab.sftpId);
          if (prov === "ftp") {
            const tid = crypto.randomUUID();
            await trackTransfer(tid, entry.name, "up", entry.path, dst, () => {
              loadDir(tab.id, tab.path, tab.sftpId, setTabs);
            }, false, prov);
            invoke("ftp_upload", { sftpId: tab.sftpId, localPath: entry.path, remotePath: dst, transferId: tid })
              .catch(e => toast(i18nT("sftp.error.paste", { name: entry.name, error: String(e) })));
          } else {
            const tid = await invoke<string>(rcmd(prov, "upload"), {
              sftpId: tab.sftpId, localPath: entry.path, remotePath: dst,
              preserveMtime: sftpSettings.preserveMtime,
            });
            trackTransfer(tid, entry.name, "up", entry.path, dst, () => {
              loadDir(tab.id, tab.path, tab.sftpId, setTabs);
            }, false, prov);
          }
        } else if (clip.srcSftpId && !tab.sftpId) {
          const prov = providerOf(clip.srcSftpId);
          if (prov === "ftp") {
            const tid = crypto.randomUUID();
            await trackTransfer(tid, entry.name, "down", entry.path, dst, () => {
              loadDir(tab.id, tab.path, tab.sftpId, setTabs);
            }, false, prov);
            invoke("ftp_download", { sftpId: clip.srcSftpId, remotePath: entry.path, localPath: dst, transferId: tid })
              .catch(e => toast(i18nT("sftp.error.paste", { name: entry.name, error: String(e) })));
          } else {
            const tid = await invoke<string>(rcmd(prov, "download"), {
              sftpId: clip.srcSftpId, remotePath: entry.path, localPath: dst,
            });
            trackTransfer(tid, entry.name, "down", entry.path, dst, () => {
              loadDir(tab.id, tab.path, tab.sftpId, setTabs);
            }, false, prov);
          }
        } else {
          toast(i18nT("sftp.error.directCopyUnsupported"));
          return;
        }
      } catch (err) { toast(i18nT("sftp.error.paste", { name: entry.name, error: String(err) })); }
    }
    if (localCount > 0) loadDir(tab.id, tab.path, undefined, setTabs);
  };

  const handleCompress = async (
    format: "tar.gz" | "zip",
    tab: PaneTab,
    setTabs: React.Dispatch<React.SetStateAction<PaneTab[]>>,
    entries: FileEntry[],
  ) => {
    if (!tab.sftpId) return;
    if (!providerCaps(providerOf(tab.sftpId)).exec) {
      toast(i18nT("sftp.error.compressUnsupported", { provider: providerUnsupportedLabel(providerOf(tab.sftpId)) }));
      return;
    }
    setCtxMenu(null);
    const defaultName = entries.length === 1 ? entries[0].name : "archive";
    const name = await showInput(i18nT("sftp.input.compress", { format }), defaultName);
    if (!name?.trim()) return;
    const fullName = name.trim().endsWith(`.${format}`) ? name.trim() : `${name.trim()}.${format}`;
    const fileList = entries.map(e => `'${e.name.replace(/'/g, "'\\''")}'`).join(" ");
    const escapedPath = tab.path.replace(/'/g, "'\\''");
    const command = format === "tar.gz"
      ? `cd '${escapedPath}' && tar -czf '${fullName}' ${fileList}`
      : `cd '${escapedPath}' && zip -r '${fullName}' ${fileList}`;
    try {
      await invoke("sftp_exec", { sftpId: tab.sftpId, command });
      loadDir(tab.id, tab.path, tab.sftpId, setTabs);
      toast(i18nT("sftp.compressDone", { name: fullName }));
    } catch (err) { toast(i18nT("sftp.error.compress", { error: String(err) })); }
  };

  // ── Context menu positioning ──────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = ctxRef.current;
    if (!el || !ctxMenu) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, ctxMenu.x + width  > window.innerWidth  ? ctxMenu.x - width  : ctxMenu.x)}px`;
    el.style.top  = `${Math.max(4, ctxMenu.y + height > window.innerHeight ? ctxMenu.y - height : ctxMenu.y)}px`;
  }, [ctxMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    const h = () => setCtxMenu(null);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [!!ctxMenu]);

  useLayoutEffect(() => {
    const el = xferCtxRef.current;
    if (!el || !xferCtxMenu) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, xferCtxMenu.x + width  > window.innerWidth  ? xferCtxMenu.x - width  : xferCtxMenu.x)}px`;
    el.style.top  = `${Math.max(4, xferCtxMenu.y + height > window.innerHeight ? xferCtxMenu.y - height : xferCtxMenu.y)}px`;
  }, [xferCtxMenu]);

  useEffect(() => {
    if (!xferCtxMenu) return;
    const h = () => setXferCtxMenu(null);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [!!xferCtxMenu]);

  useLayoutEffect(() => {
    const el = subCtxRef.current;
    if (!el || !subCtxMenu) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, subCtxMenu.x + width  > window.innerWidth  ? subCtxMenu.x - width  : subCtxMenu.x)}px`;
    el.style.top  = `${Math.max(4, subCtxMenu.y + height > window.innerHeight ? subCtxMenu.y - height : subCtxMenu.y)}px`;
  }, [subCtxMenu]);

  useEffect(() => {
    if (!subCtxMenu) return;
    const h = () => setSubCtxMenu(null);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [!!subCtxMenu]);

  // (picker tree built inside HostPickerTree component)

  // ── Resolved ctx tab ──────────────────────────────────────────────────────
  const ctxTab     = ctxMenu ? (ctxMenu.pane === "left" ? leftTab  : rightTab) : null;
  const ctxSetTabs = ctxMenu?.pane === "left" ? setLeftTabs : setRightTabs;
  const otherTab   = ctxMenu ? (ctxMenu.pane === "left" ? rightTab : leftTab)  : null;

  // Stable style objects so MemoFilePane equality check on `style` works.
  const leftPaneStyle  = useMemo(() => ({ flex: `0 0 ${dividerPct}%` }), [dividerPct]);
  const rightPaneStyle = useMemo<React.CSSProperties>(() => ({ flex: 1 }), []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="sftp-view"
      onClick={() => setCtxMenu(null)}
      style={{
        cursor:     isDragging ? "col-resize" : xferDragging ? "row-resize" : undefined,
        userSelect: (isDragging || xferDragging) ? "none" : undefined,
      }}>

      <div className="sftp-panes" ref={panesRef}>
        {/* Left pane */}
        <MemoFilePane
          tabs={leftTabs} activeTabId={leftActive} colWidths={leftColWidths}
          onTabActivate={setLeftActive}
          onTabClose={id => closeTab(id, leftTabs, setLeftTabs, leftActive, setLeftActive)}
          onTabAdd={e => showHostPicker("left", e)}
          onInputChange={(tid, v) => setLeftTabs(prev => prev.map(t => t.id === tid ? { ...t, input: v } : t))}
          onNavigate={(tid, p) => navigateTo(tid, p, setLeftTabs, leftTabsRef)}
          onBack={tid => goBack(tid, setLeftTabs, leftTabsRef)}
          onForward={tid => goForward(tid, setLeftTabs, leftTabsRef)}
          onHome={tid => goHome(tid, setLeftTabs, leftTabsRef)}
          onUp={tid => {
            const tab = leftTabsRef.current.find(t => t.id === tid);
            if (tab) navigateTo(tid, parentPath(tab.path), setLeftTabs, leftTabsRef);
          }}
          onRefresh={tid => {
            const tab = leftTabsRef.current.find(t => t.id === tid);
            if (!tab) return;
            if (tab.sftpId && tab.connected === false && tab.hostId) {
              const host = propHosts.find(h => h.id === tab.hostId);
              if (host) { reconnectTab(tid, host, "left"); return; }
            }
            loadDir(tid, tab.path, tab.sftpId, setLeftTabs);
          }}
          onEditPath={(tid, editing) => setLeftTabs(prev => prev.map(t => t.id === tid ? { ...t, editingInput: editing } : t))}
          onShowDrives={(tid, btn) => showDrives("left", tid, btn)}
          onToggleHidden={() => setLeftShowHidden(v => !v)}
          showHidden={leftShowHidden}
          onSelect={selectLeft}
          onColResize={makeColResize(leftColWidths, setLeftColWidths)}
          onContextMenu={(e, ents) => { e.preventDefault(); e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, pane: "left", entries: ents }); }}
          onBgContextMenu={e => { e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, pane: "left", entries: [] }); }}
          onTransfer={entry => handleCopyToOther("left", [entry])}
          onEdit={sftpSettings.doubleClick === "Edit" ? (entry => leftTab && handleEdit(leftTab, [entry])) : undefined}
          onPaste={() => handlePasteUpload("left")}
          isDragOver={dragHoverPane === "left"}
          containerRef={leftPaneRef}
          nativeIcons
          style={leftPaneStyle}
        />

        <div className={`sftp-divider${isDragging ? " is-dragging" : ""}`}
          onMouseDown={onDividerMouseDown}/>

        {/* Right pane */}
        <MemoFilePane
          tabs={rightTabs} activeTabId={rightActive} colWidths={rightColWidths}
          onTabActivate={setRightActive}
          onTabClose={id => closeTab(id, rightTabs, setRightTabs, rightActive, setRightActive)}
          onTabAdd={e => showHostPicker("right", e)}
          onInputChange={(tid, v) => setRightTabs(prev => prev.map(t => t.id === tid ? { ...t, input: v } : t))}
          onNavigate={(tid, p) => navigateTo(tid, p, setRightTabs, rightTabsRef)}
          onBack={tid => goBack(tid, setRightTabs, rightTabsRef)}
          onForward={tid => goForward(tid, setRightTabs, rightTabsRef)}
          onHome={tid => goHome(tid, setRightTabs, rightTabsRef)}
          onUp={tid => {
            const tab = rightTabsRef.current.find(t => t.id === tid);
            if (tab) navigateTo(tid, parentPath(tab.path), setRightTabs, rightTabsRef);
          }}
          onRefresh={tid => {
            const tab = rightTabsRef.current.find(t => t.id === tid);
            if (!tab) return;
            if (tab.sftpId && tab.connected === false && tab.hostId) {
              const host = propHosts.find(h => h.id === tab.hostId);
              if (host) { reconnectTab(tid, host, "right"); return; }
            }
            loadDir(tid, tab.path, tab.sftpId, setRightTabs);
          }}
          onEditPath={(tid, editing) => setRightTabs(prev => prev.map(t => t.id === tid ? { ...t, editingInput: editing } : t))}
          onShowDrives={(tid, btn) => showDrives("right", tid, btn)}
          onToggleHidden={() => setRightShowHidden(v => !v)}
          showHidden={rightShowHidden}
          onSelect={selectRight}
          onColResize={makeColResize(rightColWidths, setRightColWidths)}
          onContextMenu={(e, ents) => { e.preventDefault(); e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, pane: "right", entries: ents }); }}
          onBgContextMenu={e => { e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, pane: "right", entries: [] }); }}
          onTransfer={entry => handleCopyToOther("right", [entry])}
          onEdit={sftpSettings.doubleClick === "Edit" ? (entry => rightTab && handleEdit(rightTab, [entry])) : undefined}
          onPaste={() => handlePasteUpload("right")}
          isDragOver={dragHoverPane === "right"}
          containerRef={rightPaneRef}
          style={rightPaneStyle}
        />
      </div>

      {/* ── Transfer panel (always visible) ── */}
      <div className="sftp-xfer-panel" style={{
          height: xferHeight,
          '--xc-name':     `${xferCols.name}px`,
          '--xc-status':   `${xferCols.status}px`,
          '--xc-progress': `${xferCols.progress}px`,
          '--xc-size':     `${xferCols.size}px`,
          '--xc-path':     `${xferCols.path}px`,
          '--xc-speed':    `${xferCols.speed}px`,
          '--xc-remain':   `${xferCols.remain}px`,
          '--xc-elapsed':  `${xferCols.elapsed}px`,
        } as React.CSSProperties}>
        <div className={`sftp-xfer-drag${xferDragging ? " sftp-xfer-drag--active" : ""}`}
          onMouseDown={onXferDragStart}/>
        <div className="sftp-xfer-header">
          {(["sftp.xfer.name","sftp.xfer.status","sftp.xfer.progress","sftp.xfer.size","sftp.xfer.srcPath","sftp.xfer.dstPath","sftp.xfer.speed","sftp.xfer.remaining","sftp.xfer.elapsed"] as const).map((label, i) => {
            const cols: (keyof XferColW)[] = ["name","status","progress","size","path","path","speed","remain","elapsed"];
            const col = cols[i];
            return (
              <div key={i} className={`sftp-xfer-cell xc-${col}`}>
                {i18nT(label)}
                <div className={`sftp-xfer-col-handle${xferColDragging === col ? " sftp-xfer-col-handle--dragging" : ""}`}
                  onMouseDown={e => startXferColResize(col, e)}/>
              </div>
            );
          })}
          <div className="sftp-xfer-cell xc-dismiss"/>
        </div>
        <div className="sftp-xfer-body">
          {transfers.length === 0 ? (
            <div className="sftp-xfer-empty">
              <InboxEmptyIcon />
              <span>{i18nT("sftp.xfer.empty")}</span>
            </div>
          ) : transfers.map(t => {
            // For dir transfers, fall back to summing subFiles if the aggregate ticker hasn't fired yet
            const subXfer       = t.subFiles?.reduce((s, f) => s + f.transferred, 0) ?? 0;
            const subTotal      = t.subFiles?.reduce((s, f) => s + f.total, 0) ?? 0;
            const subSpeed      = t.subFiles?.reduce((s, f) => s + f.speed, 0) ?? 0;
            const subAnyRunning = t.subFiles?.some(f => f.status === "running") ?? false;
            const effXfer   = t.total > 0 ? t.transferred : subXfer;
            const effTotal  = t.total > 0 ? t.total : subTotal;
            const effSpeed  = t.speed > 0 ? t.speed : subSpeed;
            const effStatus = t.status !== "pending" ? t.status : subAnyRunning ? "running" : "pending";
            const pct    = t.status === "done" ? 100
              : effTotal > 0 ? Math.min(100, Math.round(effXfer / effTotal * 100)) : 0;
            const remain = effStatus === "running" && effTotal > effXfer && effSpeed > 0
              ? fmtRemain(effTotal - effXfer, effSpeed) : "—";
            const elapsed = fmtElapsed(t.elapsedMs ?? (Date.now() - t.startedAt));
            const sizeText = t.status === "done"
              ? (effTotal > 0 ? fmtSize(effTotal) : effXfer > 0 ? fmtSize(effXfer) : "—")
              : effTotal > 0
                ? `${fmtSize(effXfer)} / ${fmtSize(effTotal)}`
                : (effXfer > 0 ? fmtSize(effXfer) : "—");
            const nonDoneSubs = t.subFiles?.filter(f => f.status !== "done") ?? [];
            const parentEffPaused = t.paused
              || (t.isDir && nonDoneSubs.length > 0 && nonDoneSubs.every(f => f.paused));
            const isExpanded = expandedXfers.has(t.id);
            return (
              <div key={t.id}>
                <div className={`sftp-xfer-row sftp-xfer-row-${t.status}`}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation();
                    setXferCtxMenu({ x: e.clientX, y: e.clientY, transfer: t }); }}>
                  <div className="sftp-xfer-cell xc-name">
                    {t.isDir && (t.subFiles?.length ?? 0) > 0 ? (
                      <button className="sftp-xfer-expand"
                        onClick={e => { e.stopPropagation();
                          setExpandedXfers(prev => {
                            const s = new Set(prev);
                            s.has(t.id) ? s.delete(t.id) : s.add(t.id); return s;
                          }); }}>
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    ) : <span style={{ width: 14, flexShrink: 0 }}/>}
                    <span className={`sftp-xfer-dir ${t.direction}`}>
                      {t.direction === "up" ? "↑" : "↓"}
                    </span>
                    <span className="sftp-xfer-fname" data-tooltip={t.name}>{t.name}</span>
                  </div>
                  <div className="sftp-xfer-cell xc-status">
                    {effStatus === "pending" && <span className="sftp-xfer-badge badge-wait">{i18nT("sftp.xfer.pending")}</span>}
                    {effStatus === "running" && parentEffPaused  && <span className="sftp-xfer-badge badge-pause">{i18nT("sftp.xfer.paused")}</span>}
                    {effStatus === "running" && !parentEffPaused && <span className="sftp-xfer-badge badge-run">{i18nT("sftp.xfer.running")}</span>}
                    {effStatus === "done"    && <span className="sftp-xfer-badge badge-done">{i18nT("sftp.xfer.done")}</span>}
                    {t.status  === "error"   && <span className="sftp-xfer-badge badge-err" data-tooltip={t.error}>{i18nT("sftp.xfer.error")}</span>}
                  </div>
                  <div className="sftp-xfer-cell xc-progress">
                    {t.status === "error" ? (
                      <span className="sftp-xfer-errmsg" data-tooltip={t.error}>{t.error ?? i18nT("sftp.xfer.unknownError")}</span>
                    ) : (<>
                      <div className="sftp-xfer-bar">
                        <div className="sftp-xfer-fill" style={{ width: `${pct}%` }}/>
                      </div>
                      <span className="sftp-xfer-pct">{pct}%</span>
                    </>)}
                  </div>
                  <div className="sftp-xfer-cell xc-size" data-tooltip={sizeText}>{sizeText}</div>
                  <div className="sftp-xfer-cell xc-path" data-tooltip={t.srcPath}>
                    <span className="sftp-xfer-path">{t.srcPath}</span>
                  </div>
                  <div className="sftp-xfer-cell xc-path" data-tooltip={t.dstPath}>
                    <span className="sftp-xfer-path">{t.dstPath}</span>
                  </div>
                  <div className="sftp-xfer-cell xc-speed">
                    {effStatus === "running" ? fmtSpeed(effSpeed) : "—"}
                  </div>
                  <div className="sftp-xfer-cell xc-remain">{remain}</div>
                  <div className="sftp-xfer-cell xc-elapsed">{elapsed}</div>
                  <div className="sftp-xfer-cell xc-dismiss">
                    <button className="sftp-xfer-x" onClick={async () => {
                      const msg = effStatus === "running"
                        ? i18nT("sftp.xfer.cancelConfirm", { name: t.name })
                        : i18nT("sftp.xfer.closeConfirm", { name: t.name });
                      if (!await showConfirm(msg)) return;
                      setTransfers(p => p.filter(x => x.id !== t.id));
                    }}>×</button>
                  </div>
                </div>
                {/* Sub-file rows for directory transfers — tree view aligned with header columns */}
                {isExpanded && (() => {
                  const subs = t.subFiles ?? [];
                  const rootFiles: SubFile[] = [];
                  const folderMap = new Map<string, SubFile[]>();
                  for (const sf of subs) {
                    const slash = sf.relPath.indexOf('/');
                    if (slash === -1) rootFiles.push(sf);
                    else {
                      const folder = sf.relPath.slice(0, slash);
                      if (!folderMap.has(folder)) folderMap.set(folder, []);
                      folderMap.get(folder)!.push(sf);
                    }
                  }

                  const renderSubBadge = (st: "pending" | "running" | "done", paused?: boolean) => {
                    if (st === "pending") return <span className="sftp-xfer-badge badge-wait">{i18nT("sftp.xfer.pending")}</span>;
                    if (st === "running" && paused) return <span className="sftp-xfer-badge badge-pause">{i18nT("sftp.xfer.paused")}</span>;
                    if (st === "running") return <span className="sftp-xfer-badge badge-run">{i18nT("sftp.xfer.running")}</span>;
                    return <span className="sftp-xfer-badge badge-done">{i18nT("sftp.xfer.done")}</span>;
                  };

                  // Strip trailing separator so we can append consistently
                  const srcBase = t.srcPath.replace(/[/\\]+$/, '');
                  const dstBase = t.dstPath.replace(/[/\\]+$/, '');

                  const renderFileRow = (sf: SubFile, depth: number) => {
                    const sfPct     = sf.total > 0 ? Math.min(100, Math.round(sf.transferred / sf.total * 100)) : 0;
                    const sfSize    = sf.status === "done" ? fmtSize(sf.total)
                      : sf.total > 0 ? `${fmtSize(sf.transferred)} / ${fmtSize(sf.total)}` : "—";
                    const sfElapsed = sf.status !== "pending" ? fmtElapsed(sf.elapsedMs ?? (Date.now() - sf.startedAt)) : "—";
                    const sfRemain  = sf.status === "running" && sf.total > sf.transferred && sf.speed > 0
                      ? fmtRemain(sf.total - sf.transferred, sf.speed) : "—";
                    const sfSrc = `${srcBase}/${sf.relPath}`;
                    const sfDst = `${dstBase}/${sf.relPath}`;
                    const sfEffPaused = t.paused || sf.paused;
                    return (
                      <div key={sf.relPath} className={`sftp-xfer-subrow sftp-xfer-depth-${depth}`}
                        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSubCtxMenu({ x: e.clientX, y: e.clientY, tid: t.id, parentPaused: t.paused, subFile: sf }); }}>
                        <div className="sftp-xfer-cell xc-name" style={{ gap: 5 }}>
                          <span className={`sftp-xfer-subrow-dot ${sfEffPaused && sf.status === "running" ? "paused" : sf.status}`}/>
                          <span className="sftp-xfer-subfname" data-tooltip={sf.name}>{sf.name}</span>
                        </div>
                        <div className="sftp-xfer-cell xc-status">{renderSubBadge(sf.status, sfEffPaused)}</div>
                        <div className="sftp-xfer-cell xc-progress" style={{ gap: 6 }}>
                          <div className="sftp-xfer-bar">
                            <div className="sftp-xfer-fill" style={{ width: `${sfPct}%` }}/>
                          </div>
                          <span className="sftp-xfer-pct">{sfPct}%</span>
                        </div>
                        <div className="sftp-xfer-cell xc-size" data-tooltip={sfSize}>{sfSize}</div>
                        <div className="sftp-xfer-cell xc-path" data-tooltip={sfSrc}>
                          <span className="sftp-xfer-path">{sfSrc}</span>
                        </div>
                        <div className="sftp-xfer-cell xc-path" data-tooltip={sfDst}>
                          <span className="sftp-xfer-path">{sfDst}</span>
                        </div>
                        <div className="sftp-xfer-cell xc-speed">
                          {sf.status === "running" && sf.speed > 0 ? fmtSpeed(sf.speed) : "—"}
                        </div>
                        <div className="sftp-xfer-cell xc-remain">{sfRemain}</div>
                        <div className="sftp-xfer-cell xc-elapsed">{sfElapsed}</div>
                        <div className="sftp-xfer-cell xc-dismiss"/>
                      </div>
                    );
                  };

                  return <>
                    {rootFiles.map(sf => renderFileRow(sf, 1))}
                    {[...folderMap.entries()].map(([folderName, files]) => {
                      const folderXfer   = files.reduce((s, f) => s + f.transferred, 0);
                      const folderTotal  = files.reduce((s, f) => s + f.total, 0);
                      const folderSpeed  = files.reduce((s, f) => s + f.speed, 0);
                      const allDone      = files.every(f => f.status === "done");
                      const anyRunning   = files.some(f => f.status === "running");
                      const folderStatus = allDone ? "done" : anyRunning ? "running" : "pending";
                      const folderPct    = folderTotal > 0 ? Math.min(100, Math.round(folderXfer / folderTotal * 100)) : 0;
                      const folderSize   = allDone ? fmtSize(folderTotal)
                        : folderTotal > 0 ? `${fmtSize(folderXfer)} / ${fmtSize(folderTotal)}` : "—";
                      const isFolderExpanded = expandedSubFolders.get(t.id)?.has(folderName) ?? false;
                      const folderRemain = anyRunning && folderSpeed > 0 && folderTotal > folderXfer
                        ? fmtRemain(folderTotal - folderXfer, folderSpeed) : "—";
                      const folderElapsed = allDone
                        ? fmtElapsed(Math.max(...files.map(f => f.elapsedMs ?? 0)))
                        : folderStatus !== "pending"
                          ? fmtElapsed(Date.now() - Math.min(...files.filter(f => f.status !== "pending").map(f => f.startedAt)))
                          : "—";
                      const folderSrc = `${srcBase}/${folderName}`;
                      const folderDst = `${dstBase}/${folderName}`;
                      const runningFiles = files.filter(f => f.status !== "done");
                      const folderEffPaused = !allDone && runningFiles.length > 0
                        && runningFiles.every(f => t.paused || f.paused);
                      const folderDotStatus = folderEffPaused ? "paused" : folderStatus;
                      return (
                        <React.Fragment key={folderName}>
                          <div className="sftp-xfer-subrow sftp-xfer-depth-1 sftp-xfer-folder-row"
                            onClick={() => toggleSubFolder(t.id, folderName)}
                            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setSubCtxMenu({ x: e.clientX, y: e.clientY, tid: t.id, parentPaused: t.paused, folderName, folderFiles: files }); }}
                            style={{ cursor: "pointer" }}>
                            <div className="sftp-xfer-cell xc-name" style={{ gap: 5 }}>
                              <button className="sftp-xfer-expand" tabIndex={-1}
                                onClick={e => { e.stopPropagation(); toggleSubFolder(t.id, folderName); }}>
                                {isFolderExpanded ? "▾" : "▸"}
                              </button>
                              <span className={`sftp-xfer-subrow-dot ${folderDotStatus}`}/>
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0, opacity: 0.75 }}>
                                <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.879a1.5 1.5 0 0 1 1.06.44l.622.621A1.5 1.5 0 0 0 9.621 3H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3A1.5 1.5 0 0 1 1.5 12.5V3Z"/>
                              </svg>
                              <span className="sftp-xfer-subfname" data-tooltip={folderName}>{folderName}</span>
                            </div>
                            <div className="sftp-xfer-cell xc-status">{renderSubBadge(folderStatus, folderEffPaused)}</div>
                            <div className="sftp-xfer-cell xc-progress" style={{ gap: 6 }}>
                              <div className="sftp-xfer-bar">
                                <div className="sftp-xfer-fill" style={{ width: `${folderPct}%` }}/>
                              </div>
                              <span className="sftp-xfer-pct">{folderPct}%</span>
                            </div>
                            <div className="sftp-xfer-cell xc-size">{folderSize}</div>
                            <div className="sftp-xfer-cell xc-path" data-tooltip={folderSrc}>
                              <span className="sftp-xfer-path">{folderSrc}</span>
                            </div>
                            <div className="sftp-xfer-cell xc-path" data-tooltip={folderDst}>
                              <span className="sftp-xfer-path">{folderDst}</span>
                            </div>
                            <div className="sftp-xfer-cell xc-speed">
                              {anyRunning && folderSpeed > 0 ? fmtSpeed(folderSpeed) : "—"}
                            </div>
                            <div className="sftp-xfer-cell xc-remain">{folderRemain}</div>
                            <div className="sftp-xfer-cell xc-elapsed">{folderElapsed}</div>
                            <div className="sftp-xfer-cell xc-dismiss"/>
                          </div>
                          {isFolderExpanded && files.map(sf => renderFileRow(sf, 2))}
                        </React.Fragment>
                      );
                    })}
                  </>;
                })()}
              </div>
            );
          })}
        </div>
      </div>

      {/* Context menu rendered in a body portal to escape stacking contexts. */}
      {ctxMenu && ctxTab && createPortal(
        <div ref={ctxRef} className="ctx-menu"
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 99999 }}
          onClick={e => e.stopPropagation()}>

          {/* Transfer */}
          {(() => {
            const canTransfer = otherTab &&
              ctxMenu.entries.length > 0 &&
              ((!ctxTab.sftpId && otherTab.sftpId) || (ctxTab.sftpId && !otherTab.sftpId));
            if (!canTransfer) return null;
            return (
              <div className="ctx-item ctx-item--primary"
                onClick={() => handleCopyToOther(ctxMenu.pane, ctxMenu.entries)}>{i18nT("sftp.menu.transfer")}</div>
            );
          })()}

          {/* Edit — files only */}
          {ctxMenu.entries.some(e => e.isFile) && (
            <div className="ctx-item"
              onClick={() => handleEdit(ctxTab, ctxMenu.entries)}>{i18nT("sftp.menu.edit")}</div>
          )}

          {/* Copy / Paste */}
          {ctxMenu.entries.length > 0 && <div className="ctx-divider"/>}
          {ctxMenu.entries.length > 0 && (
            <div className="ctx-item"
              onClick={() => handleCopy(ctxTab, ctxMenu.entries)}>{i18nT("sftp.menu.copy")}</div>
          )}
          {clipboardFilled && (
            <div className="ctx-item"
              onClick={() => handlePaste(ctxTab, ctxSetTabs)}>{i18nT("sftp.menu.paste")}</div>
          )}

          {/* Copy path / Open in Explorer */}
          {ctxMenu.entries.length > 0 && <div className="ctx-divider"/>}
          {ctxMenu.entries.length > 0 && (
            <div className="ctx-item" onClick={() => handleCopyPath(ctxMenu.entries)}>{i18nT("sftp.menu.copyPath")}</div>
          )}
          {!ctxTab.sftpId && ctxMenu.entries.length > 0 && (
            <div className="ctx-item"
              onClick={() => handleOpenInExplorer(ctxMenu.entries, ctxTab)}>{i18nT("sftp.menu.openInFileManager")}</div>
          )}

          {/* Rename / Delete / Permissions / Compress */}
          {ctxMenu.entries.length > 0 && <div className="ctx-divider"/>}
          {ctxMenu.entries.length === 1 && (
            <div className="ctx-item" onClick={() => ctxTab.sftpId
              ? handleRemoteRename(ctxTab, ctxSetTabs, ctxMenu.entries[0])
              : handleLocalRename(ctxTab, ctxSetTabs, ctxMenu.entries[0])}>{i18nT("sftp.menu.rename")}</div>
          )}
          {ctxMenu.entries.length > 0 && (
            <div className="ctx-item ctx-item--danger" onClick={() => ctxTab.sftpId
              ? handleRemoteDelete(ctxTab, ctxSetTabs, ctxMenu.entries)
              : handleLocalDelete(ctxTab, ctxSetTabs, ctxMenu.entries)}>{i18nT("sftp.menu.delete")}</div>
          )}
          {ctxTab.sftpId && ctxMenu.entries.length === 1 && (
            <div className="ctx-item"
              onClick={() => handleChmod(ctxTab, ctxSetTabs, ctxMenu.entries[0])}>{i18nT("sftp.menu.chmod")}</div>
          )}
          {ctxTab.sftpId && ctxMenu.entries.length > 0 && (
            <div className="ctx-item ctx-item--has-sub">
              <span>{i18nT("sftp.menu.compress")}</span>
              <span className="ctx-sub-arrow">▶</span>
              <div className="ctx-sub">
                <div className="ctx-item"
                  onClick={() => handleCompress("tar.gz", ctxTab, ctxSetTabs, ctxMenu.entries)}>
                  tar.gz
                </div>
                <div className="ctx-item"
                  onClick={() => handleCompress("zip", ctxTab, ctxSetTabs, ctxMenu.entries)}>
                  zip
                </div>
              </div>
            </div>
          )}

          {/* Select all */}
          {(ctxMenu.entries.length > 0 || clipboardFilled) && <div className="ctx-divider"/>}
          {(() => {
            const ctxShowHidden = ctxMenu.pane === "left" ? leftShowHidden : rightShowHidden;
            const paneEntries = ctxTab.entries.filter(e => ctxShowHidden || !e.name.startsWith("."));
            const allSel = paneEntries.length > 0 && paneEntries.every(e => ctxTab.selected.has(e.path));
            const ctxSelect = ctxMenu.pane === "left" ? selectLeft : selectRight;
            return (
              <div className="ctx-item" onClick={() => {
                setCtxMenu(null);
                ctxSelect(ctxTab.id, () => allSel ? new Set() : new Set(paneEntries.map(e => e.path)));
              }}>{allSel ? i18nT("sftp.menu.clearSelection") : i18nT("sftp.menu.selectAll")}</div>
            );
          })()}

          {/* Refresh */}
          <div className="ctx-item" onClick={() => {
            setCtxMenu(null);
            loadDir(ctxTab.id, ctxTab.path, ctxTab.sftpId, ctxSetTabs);
          }}>{i18nT("sftp.refresh")}</div>

          {/* New submenu */}
          <div className="ctx-divider"/>
          <div className="ctx-item ctx-item--has-sub">
            <span>{i18nT("sftp.menu.new")}</span>
            <span className="ctx-sub-arrow">▶</span>
            <div className="ctx-sub">
              <div className="ctx-item" onClick={() => ctxTab.sftpId
                ? handleRemoteMkdir(ctxTab, ctxSetTabs)
                : handleLocalMkdir(ctxTab, ctxSetTabs)}>{i18nT("sftp.menu.newFolder")}</div>
              <div className="ctx-item" onClick={() => ctxTab.sftpId
                ? handleRemoteCreateFile(ctxTab, ctxSetTabs)
                : handleLocalCreateFile(ctxTab, ctxSetTabs)}>{i18nT("sftp.menu.newFile")}</div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Transfer row right-click menu */}
      {xferCtxMenu && createPortal(
        <div ref={xferCtxRef} className="ctx-menu xfer-ctx-menu"
          style={{ position: "fixed", left: xferCtxMenu.x, top: xferCtxMenu.y, zIndex: 99999 }}
          onClick={e => e.stopPropagation()}>
          {/* Open destination in file manager — only if local path exists */}
          {xferCtxMenu.transfer.dstPath && (
            <div className="ctx-item" onClick={async () => {
              setXferCtxMenu(null);
              try { await invoke("local_open_in_explorer", { path: xferCtxMenu.transfer.dstPath }); }
              catch (err) { toast(i18nT("sftp.error.open", { error: String(err) })); }
            }}>{i18nT("sftp.menu.openInExplorer")}</div>
          )}
          {(xferCtxMenu.transfer.status === "running" || xferCtxMenu.transfer.status === "pending") &&
           providerCaps(xferCtxMenu.transfer.provider).pause && (
            <div className="ctx-item" onClick={() => {
              const t = xferCtxMenu.transfer;
              setXferCtxMenu(null);
              if (t.paused) {
                setTransfers(prev => prev.map(x => x.id === t.id ? { ...x, paused: false } : x));
                invoke("sftp_resume_transfer", { tid: t.id }).catch(e => toast(i18nT("sftp.error.resume", { error: String(e) })));
              } else {
                setTransfers(prev => prev.map(x => x.id === t.id ? { ...x, paused: true } : x));
                invoke("sftp_pause_transfer", { tid: t.id }).catch(e => toast(i18nT("sftp.error.pause", { error: String(e) })));
              }
            }}>{xferCtxMenu.transfer.paused ? i18nT("sftp.menu.resume") : i18nT("sftp.menu.pause")}</div>
          )}
          <div className="ctx-divider"/>
          <div className="ctx-item" onClick={() => {
            setXferCtxMenu(null);
            setTransfers(p => p.filter(x => x.id !== xferCtxMenu.transfer.id));
          }}>{i18nT("sftp.menu.delete")}</div>
          <div className="ctx-item" onClick={() => {
            setXferCtxMenu(null);
            setTransfers([]);
          }}>{i18nT("sftp.menu.deleteAll")}</div>
          <div className="ctx-item" onClick={() => {
            setXferCtxMenu(null);
            setTransfers(p => p.filter(x => x.status !== "done"));
          }}>{i18nT("sftp.menu.deleteCompleted")}</div>
          <div className="ctx-item" onClick={() => {
            setXferCtxMenu(null);
            setTransfers(p => p.filter(x => x.status !== "error"));
          }}>{i18nT("sftp.menu.clearFailed")}</div>
        </div>,
        document.body
      )}

      {/* Sub-item (file / folder) right-click menu */}
      {subCtxMenu && createPortal(
        <div ref={subCtxRef} className="ctx-menu"
          style={{ position: "fixed", left: subCtxMenu.x, top: subCtxMenu.y, zIndex: 99999 }}
          onClick={e => e.stopPropagation()}>
          {(() => {
            const tid            = subCtxMenu.tid;
            const isSingleFile   = !!subCtxMenu.subFile;
            const sf             = subCtxMenu.subFile;
            const folderPrefix   = subCtxMenu.folderName ? subCtxMenu.folderName + "/" : "";
            const ffiles         = subCtxMenu.folderFiles ?? [];

            // ── helpers ──────────────────────────────────────────────────────
            // effPaused for a file: either parent is globally paused OR the file itself is paused
            const sfEffPaused    = sf ? (subCtxMenu.parentPaused || sf.paused) : false;
            // for folder: all non-done files in the folder are effectively paused
            const folderActive   = ffiles.filter(f => f.status !== "done");
            const folderAllPaused = folderActive.length > 0
              && folderActive.every(f => subCtxMenu.parentPaused || f.paused);

            const isDone = isSingleFile ? sf!.status === "done" : folderActive.length === 0;

            // ── resume a set of files (handles global→per-file switch) ──────
            const resumeFiles = (relPaths: string[]) => {
              setTransfers(prev => {
                const pt = prev.find(t => t.id === tid);
                if (!pt) return prev;
                if (pt.paused) {
                  // Switch: clear global, individually pause everyone NOT in relPaths
                  const resumeSet = new Set(relPaths);
                  const others = (pt.subFiles ?? []).filter(s => !resumeSet.has(s.relPath) && s.status !== "done");
                  invoke("sftp_resume_transfer", { tid });
                  others.forEach(s => invoke("sftp_pause_transfer", { tid, relPath: s.relPath }));
                  return prev.map(t => t.id !== tid ? t : {
                    ...t, paused: false,
                    subFiles: t.subFiles?.map(s => resumeSet.has(s.relPath)
                      ? { ...s, paused: false }
                      : s.status !== "done" ? { ...s, paused: true } : s),
                  });
                } else {
                  relPaths.forEach(r => invoke("sftp_resume_transfer", { tid, relPath: r }));
                  return prev.map(t => t.id !== tid ? t : {
                    ...t, subFiles: t.subFiles?.map(s => relPaths.includes(s.relPath) ? { ...s, paused: false } : s),
                  });
                }
              });
            };

            // ── pause all / resume all for the whole transfer ─────────────
            const pauseAll = () => {
              invoke("sftp_pause_transfer", { tid });
              setTransfers(prev => prev.map(t => t.id !== tid ? t : { ...t, paused: true }));
            };
            const resumeAll = () => {
              invoke("sftp_resume_transfer", { tid });
              setTransfers(prev => prev.map(t => t.id !== tid ? t : {
                ...t, paused: false,
                subFiles: t.subFiles?.map(s => ({ ...s, paused: false })),
              }));
            };

            // ── delete helpers ────────────────────────────────────────────
            const hideFiles = (relPaths: string[]) => {
              const set = hiddenSubPathsRef.current.get(tid) ?? new Set<string>();
              relPaths.forEach(r => set.add(r));
              hiddenSubPathsRef.current.set(tid, set);
              // Pause so backend stops consuming resources
              relPaths.forEach(r => invoke("sftp_pause_transfer", { tid, relPath: r }));
              setTransfers(prev => prev.map(t => t.id !== tid ? t : {
                ...t, subFiles: t.subFiles?.filter(s => !relPaths.includes(s.relPath)),
              }));
            };

            return <>
              {/* Pause / Resume this item */}
              {!isDone && (
                <div className="ctx-item" onClick={() => {
                  setSubCtxMenu(null);
                  if (isSingleFile) {
                    if (sfEffPaused) resumeFiles([sf!.relPath]);
                    else {
                      invoke("sftp_pause_transfer", { tid, relPath: sf!.relPath });
                      setTransfers(prev => prev.map(t => t.id !== tid ? t : {
                        ...t, subFiles: t.subFiles?.map(s => s.relPath === sf!.relPath ? { ...s, paused: true } : s),
                      }));
                    }
                  } else {
                    if (folderAllPaused) resumeFiles(folderActive.map(s => s.relPath));
                    else {
                      folderActive.forEach(s => invoke("sftp_pause_transfer", { tid, relPath: s.relPath }));
                      setTransfers(prev => prev.map(t => t.id !== tid ? t : {
                        ...t, subFiles: t.subFiles?.map(s => s.relPath.startsWith(folderPrefix) && s.status !== "done"
                          ? { ...s, paused: true } : s),
                      }));
                    }
                  }
                }}>{(isSingleFile ? sfEffPaused : folderAllPaused) ? i18nT("sftp.menu.resume") : i18nT("sftp.menu.pause")}</div>
              )}
              {isDone && <div className="ctx-item ctx-item--disabled">{i18nT("sftp.xfer.done")}</div>}

              {/* Pause all / Resume all */}
              <div className="ctx-item" onClick={() => { setSubCtxMenu(null); pauseAll(); }}>{i18nT("sftp.menu.pauseAll")}</div>
              <div className="ctx-item" onClick={() => { setSubCtxMenu(null); resumeAll(); }}>{i18nT("sftp.menu.resumeAll")}</div>

              <div className="ctx-divider"/>

              {/* Delete */}
              <div className="ctx-item ctx-item--danger" onClick={() => {
                setSubCtxMenu(null);
                if (isSingleFile) {
                  hideFiles([sf!.relPath]);
                } else {
                  // include the pending ones we know about via folderFiles
                  const relPaths = (subCtxMenu.folderFiles ?? []).map(s => s.relPath);
                  hideFiles(relPaths);
                }
              }}>{i18nT("sftp.menu.delete")}</div>
            </>;
          })()}
        </div>,
        document.body
      )}

      {/* Host picker rendered in a body portal. */}
      {picker && createPortal(
        <div ref={pickerRef} className="sftp-picker"
          style={{ position: "fixed", left: picker.x, top: picker.y, zIndex: 99999 }}
          onMouseDown={e => e.stopPropagation()}>
          <div className="sftp-picker-header">
            {i18nT("sftp.picker.connectSide", { side: pickerPane === "left" ? i18nT("sftp.picker.side.left") : i18nT("sftp.picker.side.right") })}
          </div>
          <div className="sftp-picker-search">
            <div className="proto-prefix-wrap" ref={pickerProtoRef}>
              <button
                className="proto-prefix-btn proto-prefix-btn--compact"
                onClick={() => setPickerProtoDropOpen(v => !v)}
                data-tooltip={i18nT("sftp.picker.switchType")}
              >
                <span className="proto-prefix-icon">
                  {SFTP_PICKER_PROTOS.find(p => p.value === pickerProtoFilter)?.icon ?? pickerProtos[0]?.icon ?? "≡"}
                </span>
                <span className="proto-prefix-arrow">▾</span>
              </button>
              {pickerProtoDropOpen && (
                <div className="proto-prefix-drop proto-prefix-drop--sidebar">
                  {pickerProtos.map(p => (
                    <div
                      key={p.value}
                      className={`proto-prefix-drop-item${pickerProtoFilter === p.value ? " active" : ""}`}
                      onClick={() => { setPickerProtoFilter(p.value); setPickerProtoDropOpen(false); }}
                    >
                      <span className="proto-drop-icon">{p.icon}</span>
                      <span>{p.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <input autoFocus placeholder={i18nT("host.searchPlaceholder")}
              value={pickerSearch}
              onChange={e => setPickerSearch(e.target.value)}/>
          </div>
          <div className="sftp-picker-scroll">
            {pickerHosts.length === 0
              ? <div className="sftp-picker-empty">{i18nT("sftp.loading")}</div>
              : <HostPickerTree hosts={pickerHosts} search={pickerSearch}
                  protoFilter={pickerProtoFilter}
                  onConnect={handleHostConnect} connecting={connecting}/>
            }
          </div>
        </div>,
        document.body
      )}

      {/* Custom dialog */}
      {dialog && createPortal(
        <div className="dlg-overlay" onMouseDown={dlgCancel}>
          <div className="dlg-box dlg-box--plain" onMouseDown={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === "Escape") dlgCancel(); }}>
            {/* Body: message + optional input */}
            <div className="dlg-body">
              {dialog.message}
              {dialog.type === "input" && (
                <input ref={dlgInputRef} className="dlg-input"
                  autoFocus
                  defaultValue={dialog.defaultValue}
                  onKeyDown={e => { if (e.key === "Enter") dlgConfirm(); }}
                />
              )}
            </div>
            {/* Footer: buttons */}
            <div className="dlg-footer">
              <button className="dlg-btn dlg-btn-cancel" onClick={dlgCancel}>{i18nT("confirm.cancel")}</button>
              <button className="dlg-btn dlg-btn-ok"
                autoFocus={dialog.type === "confirm"}
                onClick={dlgConfirm}>
                {i18nT("confirm.ok")}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Pre-transfer conflict dialog (shown before transfer starts) */}
      {preConflict && (() => {
        const req = preConflict;
        const commit = () => {
          preConflictResolveRef.current?.({ action: conflictAction, applyAll: conflictApplyAll });
          preConflictResolveRef.current = null;
        };
        const cancel = () => {
          preConflictResolveRef.current?.({ action: null, applyAll: false });
          preConflictResolveRef.current = null;
        };
        const fmtDate = (s: number | null) => {
          if (s == null) return "—";
          return new Date(s * 1000).toLocaleString("zh-CN", {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          });
        };
        const isDir = req.isDir;
        const ItemIcon = () => isDir
          ? (
            <svg width="36" height="30" viewBox="0 0 17 14" fill="none">
              <path d="M1 2.5C1 1.67 1.67 1 2.5 1H6.5L8 3H14.5C15.33 3 16 3.67 16 4.5V11.5C16 12.33 15.33 13 14.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z"
                fill="#f9c74f" fillOpacity="0.35" stroke="#f4a61d" strokeWidth="1"/>
              <path d="M1 5H16" stroke="#f4a61d" strokeWidth="0.8" strokeOpacity="0.6"/>
            </svg>
          ) : (
            <svg width="28" height="36" viewBox="0 0 14 16" fill="none">
              <path d="M2 1h7l3 3v11H2V1z" fill="#adb5bd" fillOpacity="0.25" stroke="#868e96" strokeWidth="1"/>
              <path d="M9 1v3h3" stroke="#868e96" strokeWidth="1" fill="none"/>
            </svg>
          );
        return createPortal(
          <div className="conflict-overlay">
            <div className="conflict-dialog">
              <div className="conflict-dlg-top">
                <svg className="conflict-warn-icon" width="36" height="36" viewBox="0 0 36 36" fill="none">
                  <path d="M18 3L33 30H3L18 3Z" fill="#f4a61d" fillOpacity="0.18" stroke="#f4a61d" strokeWidth="1.5" strokeLinejoin="round"/>
                  <line x1="18" y1="14" x2="18" y2="23" stroke="#f4a61d" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="18" cy="26.5" r="1.2" fill="#f4a61d"/>
                </svg>
                <div className="conflict-dlg-msgs">
                  <span>{isDir ? i18nT("sftp.conflict.dirExists") : i18nT("sftp.conflict.fileExists")}</span>
                  <span>{i18nT("sftp.conflict.chooseAction")}</span>
                </div>
              </div>
              <div className="conflict-dlg-field-row">
                <span className="conflict-dlg-field-lbl">{i18nT("sftp.conflict.name")}</span>
                <span className="conflict-dlg-field-val" data-tooltip={req.relPath}>{req.name}</span>
              </div>
              <div className="conflict-sep" />
              <div className="conflict-dlg-section-lbl">{i18nT("sftp.conflict.target", { kind: isDir ? i18nT("sftp.conflict.folder") : i18nT("sftp.conflict.file") })}</div>
              <div className="conflict-dlg-file-row">
                <ItemIcon />
                <span className="conflict-dlg-mtime">{fmtDate(req.existingModified)}</span>
              </div>
              <div className="conflict-sep" />
              <div className="conflict-dlg-section-lbl">{i18nT("sftp.conflict.source", { kind: isDir ? i18nT("sftp.conflict.folder") : i18nT("sftp.conflict.file") })}</div>
              <div className="conflict-dlg-file-row">
                <ItemIcon />
                <span className="conflict-dlg-mtime">{fmtDate(req.incomingModified)}</span>
              </div>
              <div className="conflict-sep" />
              <div className="conflict-dlg-action-row">
                <span className="conflict-dlg-field-lbl">{i18nT("sftp.conflict.action")}</span>
                <CustomSelect
                  className="sctl conflict-action-sel"
                  value={conflictAction}
                  onChange={(value) => setConflictAction(value as "overwrite" | "skip")}
                  options={[
                    { value: "overwrite", label: i18nT("sftp.conflict.overwrite") },
                    { value: "skip", label: i18nT("sftp.conflict.skip") },
                  ]}
                />
                <label className="conflict-apply-all">
                  <input type="checkbox" checked={conflictApplyAll}
                    onChange={e => setConflictApplyAll(e.target.checked)} />
                  <span>{i18nT("sftp.conflict.applyAll")}</span>
                </label>
              </div>
              <div className="conflict-dlg-footer">
                <button className="conflict-btn conflict-btn--ok" onClick={commit}>{i18nT("confirm.ok")}</button>
                <button className="conflict-btn" onClick={cancel}>{i18nT("confirm.cancel")}</button>
              </div>
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* Conflict resolution dialog */}
      {conflictQueue.length > 0 && (() => {
        const req = conflictQueue[0];
        const commit = (action: string) => {
          if (conflictApplyAll) applyAllRef.current.set(req.tid, action);
          invoke("sftp_resolve_conflict", { requestId: req.requestId, action });
          setConflictApplyAll(false);
          setConflictAction("overwrite");
          setConflictQueue(q => q.slice(1));
        };
        const cancel = () => {
          // Cancel = skip this item (consistent with closing without choosing)
          invoke("sftp_resolve_conflict", { requestId: req.requestId, action: "skip" });
          setConflictApplyAll(false);
          setConflictAction("overwrite");
          setConflictQueue(q => q.slice(1));
        };
        const fmtDate = (s: number | null) => {
          if (s == null) return "—";
          return new Date(s * 1000).toLocaleString("zh-CN", {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          });
        };
        const isDir = req.isDir;
        const ItemIcon = () => isDir
          ? (
            <svg width="36" height="30" viewBox="0 0 17 14" fill="none">
              <path d="M1 2.5C1 1.67 1.67 1 2.5 1H6.5L8 3H14.5C15.33 3 16 3.67 16 4.5V11.5C16 12.33 15.33 13 14.5 13H2.5C1.67 13 1 12.33 1 11.5V2.5Z"
                fill="#f9c74f" fillOpacity="0.35" stroke="#f4a61d" strokeWidth="1"/>
              <path d="M1 5H16" stroke="#f4a61d" strokeWidth="0.8" strokeOpacity="0.6"/>
            </svg>
          ) : (
            <svg width="28" height="36" viewBox="0 0 14 16" fill="none">
              <path d="M2 1h7l3 3v11H2V1z" fill="#adb5bd" fillOpacity="0.25" stroke="#868e96" strokeWidth="1"/>
              <path d="M9 1v3h3" stroke="#868e96" strokeWidth="1" fill="none"/>
            </svg>
          );
        return createPortal(
          <div className="conflict-overlay">
            <div className="conflict-dialog">
              {/* top: warn icon + messages */}
              <div className="conflict-dlg-top">
                <svg className="conflict-warn-icon" width="36" height="36" viewBox="0 0 36 36" fill="none">
                  <path d="M18 3L33 30H3L18 3Z" fill="#f4a61d" fillOpacity="0.18" stroke="#f4a61d" strokeWidth="1.5" strokeLinejoin="round"/>
                  <line x1="18" y1="14" x2="18" y2="23" stroke="#f4a61d" strokeWidth="2" strokeLinecap="round"/>
                  <circle cx="18" cy="26.5" r="1.2" fill="#f4a61d"/>
                </svg>
                <div className="conflict-dlg-msgs">
                  <span>{isDir ? i18nT("sftp.conflict.dirExists") : i18nT("sftp.conflict.fileExists")}</span>
                  <span>{i18nT("sftp.conflict.chooseAction")}</span>
                </div>
              </div>

              {/* name row */}
              <div className="conflict-dlg-field-row">
                <span className="conflict-dlg-field-lbl">{i18nT("sftp.conflict.name")}</span>
                <span className="conflict-dlg-field-val" data-tooltip={req.relPath}>{req.name}</span>
              </div>
              <div className="conflict-sep" />

              {/* destination */}
              <div className="conflict-dlg-section-lbl">{i18nT("sftp.conflict.target", { kind: isDir ? i18nT("sftp.conflict.folder") : i18nT("sftp.conflict.file") })}</div>
              <div className="conflict-dlg-file-row">
                <ItemIcon />
                <span className="conflict-dlg-mtime">{fmtDate(req.existingModified)}</span>
              </div>
              <div className="conflict-sep" />

              {/* source */}
              <div className="conflict-dlg-section-lbl">{i18nT("sftp.conflict.source", { kind: isDir ? i18nT("sftp.conflict.folder") : i18nT("sftp.conflict.file") })}</div>
              <div className="conflict-dlg-file-row">
                <ItemIcon />
                <span className="conflict-dlg-mtime">{fmtDate(req.incomingModified)}</span>
              </div>
              <div className="conflict-sep" />

              {/* action row */}
              <div className="conflict-dlg-action-row">
                <span className="conflict-dlg-field-lbl">{i18nT("sftp.conflict.action")}</span>
                <CustomSelect
                  className="sctl conflict-action-sel"
                  value={conflictAction}
                  onChange={(value) => setConflictAction(value as "overwrite" | "skip")}
                  options={[
                    { value: "overwrite", label: i18nT("sftp.conflict.overwrite") },
                    { value: "skip", label: i18nT("sftp.conflict.skip") },
                  ]}
                />
                <label className="conflict-apply-all">
                  <input type="checkbox" checked={conflictApplyAll}
                    onChange={e => setConflictApplyAll(e.target.checked)} />
                  <span>{i18nT("sftp.conflict.applyAll")}</span>
                </label>
                {conflictQueue.length > 1 && (
                  <span className="conflict-queue-count">{i18nT("sftp.conflict.remaining", { count: conflictQueue.length - 1 })}</span>
                )}
              </div>

              {/* footer */}
              <div className="conflict-dlg-footer">
                <button className="conflict-btn conflict-btn--ok" onClick={() => commit(conflictAction)}>{i18nT("confirm.ok")}</button>
                <button className="conflict-btn" onClick={cancel}>{i18nT("confirm.cancel")}</button>
              </div>
            </div>
          </div>,
          document.body,
        );
      })()}

      {/* Drives / volumes popup */}
      {drivesMenu && createPortal(
        <div ref={drivesRef} className="sftp-drives-panel"
          style={{ position: "fixed", left: drivesMenu.x, top: drivesMenu.y, zIndex: 99999 }}
          onMouseDown={e => e.stopPropagation()}>
          {drivesMenu.paths.map(p => (
            <div key={p} className="sftp-drives-item"
              onClick={() => {
                const tabsRef = drivesMenu.pane === "left" ? leftTabsRef : rightTabsRef;
                const setTabs = drivesMenu.pane === "left" ? setLeftTabs : setRightTabs;
                navigateTo(drivesMenu.tabId, p, setTabs, tabsRef);
                setDrivesMenu(null);
              }}>
              <svg width="14" height="13" viewBox="0 0 14 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
                <rect x="1" y="1" width="12" height="7.5" rx="1.2"/>
                <path d="M4 11.5h6M7 8.5v3"/>
              </svg>
              <span>{p}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

export default React.memo(SftpView);
