import { createElement, useSyncExternalStore, type ReactNode } from "react";
import { SshIcon, TelnetIcon, LocalIcon, WslIcon, FtpFolderIcon, SmbFolderIcon } from "./components/icons";

// Central protocol registry — the single source of truth for everything a
// protocol contributes to the UI: how its host is opened/connected, which
// host-dialog sections and fields it exposes, and how it appears in the
// protocol dropdowns.
//
// Instead of hardcoding `if (proto === "SSH") ...` in several components, each
// component reads this registry, and adding a protocol means adding one entry
// here (plus its backend command, if it needs one).

export type SectionId =
  | "general"
  | "proxy"
  | "tunneling"
  | "jumphosts"
  | "terminal"
  | "sftp";

/**
 * How opening a host of this protocol maps onto a tab:
 *  - `local`        → a local PTY tab (Local shell, WSL)
 *  - `ssh`          → a network terminal tab driven by the given backend transport
 *  - `unsupported`  → cannot be opened yet (shows a "not supported" notice)
 */
export type TabPlan =
  | { kind: "local" }
  | { kind: "ssh"; transport: "ssh" | "telnet" }
  | { kind: "transfer"; provider: "ftp" | "smb" }
  | { kind: "unsupported" };

export interface ProtocolDef {
  /** Canonical id, matches `Host.protocol` (case-insensitive). */
  id: string;
  /** Long label shown in the host dialog's protocol picker. */
  label: string;
  /** i18n key for the long label. */
  labelKey?: string;
  /** Short label shown in the search-filter dropdowns. */
  filterLabel: string;
  /** i18n key for the short label. */
  filterLabelKey?: string;
  /** Icon shown next to the label in dropdowns — a text glyph or an element. */
  icon: ReactNode;
  /** Default TCP port (0 = not applicable). */
  defaultPort: number;
  /** How to open + connect a host of this protocol. */
  tab: TabPlan;
  /** Which left-nav sections the host dialog shows. */
  sections: SectionId[];
  /** Show the host address + port fields. */
  needsHostField: boolean;
  /** Show the username field. */
  needsUsername: boolean;
  /** Show the SSH authentication UI (auth type + credential fields). */
  showAuth: boolean;
  /** Show the WSL distribution selector. */
  showWslDistro: boolean;
  /** Show a plain password field (e.g. FTP) without the SSH auth UI. */
  showPassword?: boolean;
  /** Requires an installed plugin contributing this protocol. */
  requiresPlugin?: boolean;
  /** Can browse/transfer files (shown in the transfer host picker). */
  canTransfer?: boolean;
  /** Restrict this protocol to certain platforms. Omit/`all` = everywhere. */
  platform?: "windows" | "unix" | "all";
}

const TERMINAL_ONLY: SectionId[] = ["general", "terminal"];

export const PROTOCOLS: ProtocolDef[] = [
  {
    id: "SSH",
    label: "SSH",
    filterLabel: "SSH",
    icon: createElement(SshIcon),
    defaultPort: 22,
    tab: { kind: "ssh", transport: "ssh" },
    sections: ["general", "proxy", "tunneling", "jumphosts", "terminal", "sftp"],
    needsHostField: true,
    needsUsername: true,
    showAuth: true,
    showWslDistro: false,
    canTransfer: true,
  },
  {
    id: "Telnet",
    label: "Telnet",
    filterLabel: "Telnet",
    icon: createElement(TelnetIcon),
    defaultPort: 23,
    tab: { kind: "ssh", transport: "telnet" },
    sections: ["general", "proxy", "terminal"],
    needsHostField: true,
    needsUsername: true,
    showAuth: false,
    showWslDistro: false,
  },
  {
    id: "Local",
    label: "Local terminal",
    labelKey: "protocol.local.label",
    filterLabel: "Local",
    filterLabelKey: "protocol.local.filter",
    icon: createElement(LocalIcon),
    defaultPort: 0,
    tab: { kind: "local" },
    sections: TERMINAL_ONLY,
    needsHostField: false,
    needsUsername: false,
    showAuth: false,
    showWslDistro: false,
  },
  {
    id: "WSL",
    label: "WSL",
    filterLabel: "WSL",
    icon: createElement(WslIcon),
    defaultPort: 0,
    tab: { kind: "local" },
    sections: TERMINAL_ONLY,
    needsHostField: false,
    needsUsername: false,
    showAuth: false,
    showWslDistro: true,
    platform: "windows",
  },
  {
    id: "FTP",
    label: "FTP",
    filterLabel: "FTP",
    icon: createElement(FtpFolderIcon),
    defaultPort: 21,
    tab: { kind: "transfer", provider: "ftp" },
    sections: ["general", "jumphosts"],
    needsHostField: true,
    needsUsername: true,
    showAuth: false,
    showWslDistro: false,
    showPassword: true,
    requiresPlugin: true,
    canTransfer: true,
  },
  {
    id: "SMB",
    label: "SMB",
    filterLabel: "SMB",
    icon: createElement(SmbFolderIcon),
    defaultPort: 445,
    tab: { kind: "transfer", provider: "smb" },
    sections: ["general"],
    needsHostField: true,
    needsUsername: true,
    showAuth: false,
    showWslDistro: false,
    showPassword: true,
    requiresPlugin: true,
    canTransfer: true,
    platform: "windows",
  },
  // Serial will be exposed as an installable plugin, similar to FTP.
];

/** Look up a protocol definition by id (case-insensitive). */
export function getProtocol(id: string | undefined): ProtocolDef | undefined {
  if (!id) return undefined;
  const up = id.toUpperCase();
  return PROTOCOLS.find((p) => p.id.toUpperCase() === up);
}

/** Whether a protocol can browse/transfer files (SSH/SFTP, FTP). */
export function isTransferProtocol(id: string | undefined): boolean {
  return getProtocol(id)?.canTransfer ?? false;
}

/**
 * Register an additional protocol at runtime (future plugin hook). Replaces any
 * existing entry with the same id.
 */
export function registerProtocol(def: ProtocolDef): void {
  const idx = PROTOCOLS.findIndex((p) => p.id.toUpperCase() === def.id.toUpperCase());
  if (idx >= 0) PROTOCOLS[idx] = def;
  else PROTOCOLS.push(def);
}

// ── Installed-plugin awareness ──────────────────────────────────────────────
// Protocols flagged `requiresPlugin` are hidden from the pickers until the
// contributing plugin is installed. The installed set is a tiny external store
// so all dropdowns react when a plugin is installed/uninstalled at runtime.

/** Detect the host OS class once: "windows" vs "unix" (mac/linux). */
const _hostPlatform: "windows" | "unix" = (() => {
  const raw = (navigator.platform || navigator.userAgent || "").toLowerCase();
  return raw.includes("win") ? "windows" : "unix";
})();

/** True if a protocol's `platform` constraint matches the current OS. */
function _platformMatches(p: ProtocolDef): boolean {
  if (!p.platform || p.platform === "all") return true;
  return p.platform === _hostPlatform;
}

/**
 * Whether a plugin contributing the given protocol should be shown on the
 * current OS. Used to hide Windows-only transfer plugins (e.g. SMB) on macOS.
 * Unknown/undefined protocols are always shown.
 */
export function pluginSupportedOnPlatform(protocol: string | undefined): boolean {
  if (!protocol) return true;
  const def = getProtocol(protocol);
  return def ? _platformMatches(def) : true;
}

let _installedProtocols = new Set<string>();
let _available: ProtocolDef[] = PROTOCOLS.filter((p) => !p.requiresPlugin && _platformMatches(p));
const _subs = new Set<() => void>();

function _recompute() {
  _available = PROTOCOLS.filter(
    (p) => _platformMatches(p) && (!p.requiresPlugin || _installedProtocols.has(p.id.toUpperCase())),
  );
}

/** Update which plugin-provided protocols are installed (from `plugins_list`). */
export function setInstalledPluginProtocols(
  manifests: { protocol?: string }[],
): void {
  const next = new Set(
    manifests.map((m) => m.protocol?.toUpperCase()).filter((p): p is string => !!p),
  );
  if (next.size === _installedProtocols.size && [..._installedProtocols].every((p) => next.has(p))) {
    return; // unchanged
  }
  _installedProtocols = next;
  _recompute();
  _subs.forEach((fn) => fn());
}

function _subscribe(fn: () => void): () => void {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}
function _snapshot(): ProtocolDef[] {
  return _available;
}

/**
 * Protocols available for new connections — excludes `requiresPlugin` protocols
 * whose plugin isn't installed. Reactive: re-renders on install/uninstall.
 * (Use `getProtocol` for resolving an existing host's protocol regardless.)
 */
export function useAvailableProtocols(): ProtocolDef[] {
  return useSyncExternalStore(_subscribe, _snapshot, _snapshot);
}
