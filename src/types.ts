// TypeScript types mirroring Rust domain structs.
// Serde uses rename_all = "camelCase" and specific #[serde(rename)] overrides.

export type AuthType =
  | "No"
  | "Password"
  | "PublicKey"
  | "SshAgent"
  | "KeyboardInteractive";

export type ProxyType = "NO" | "HTTP" | "SOCKS5";

export interface Authentication {
  type: AuthType;
  password: string;
}

export interface Proxy {
  type: ProxyType;
  host: string;
  port: number;
  authenticationType: AuthType;
  username: string;
  password: string;
}

export type TunnelingType = "Local" | "Remote" | "Dynamic";

export interface Tunneling {
  name: string;
  type: TunnelingType;
  sourceHost: string;
  sourcePort: number;
  destinationHost: string;
  destinationPort: number;
}

export interface Options {
  encoding: string;
  heartbeatInterval: number;
  tags: string[];
  extras: Record<string, string>;
  startupCommand: string;
  env: string;
  jumpHosts: string[];
  sftpDefaultDirectory: string;
}

export interface Host {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  remark: string;
  authentication: Authentication;
  proxy: Proxy;
  options: Options;
  tunnelings: Tunneling[];
  sort: number;
  parentId: string;
  ownerId: string;
  creatorId: string;
  ownerType: string;
  deleted: boolean;
  createDate: number;
  updateDate: number;
}

export interface KeyPair {
  id: string;
  publicKey: string;
  privateKey: string;
  keyType: string;
  name: string;
  remark: string;
  length: number;
  sort: number;
  updateDate: number;
}

export interface Note {
  id: string;
  name: string;
  content: string;
  group: string;
  parentId: string | null;
  isFolder: boolean;
  sort: number;
  createDate: number;
  updateDate: number;
}

export interface KeywordHighlight {
  id: string;
  keyword: string;
  textColor: string;
  bgColor: string;
  description: string;
  enabled: boolean;
  regex: boolean;
  matchCase: boolean;
  bold: boolean;
  sort: number;
  createDate: number;
  updateDate: number;
}

export interface SftpSettings {
  doubleClick:   string;   // "Transfer" | "Edit"
  editCommand:   string;   // e.g. "code" or "notepad {0}"
  preserveMtime: boolean;
  pinTab:        boolean;
  defaultDir:    string;
  clearDone:     boolean;
}

export interface TerminalSettings {
  font: string;
  fallbackFont: string;
  fontSize: number;
  maxRows: number;
  startupLogs: boolean;
  cursorBlink: boolean;
  cursorStyle: string;
  selectCopy: boolean;
  rightClick: string;
  hyperlink: boolean;
  localShell: string;
  autoReconnect: boolean;
}

export function newHost(overrides?: Partial<Host>): Host {
  return {
    id: crypto.randomUUID(),
    name: "",
    protocol: "SSH",
    host: "",
    port: 22,
    username: "",
    remark: "",
    authentication: { type: "Password", password: "" },
    proxy: {
      type: "NO",
      host: "",
      port: 7890,
      authenticationType: "No",
      username: "",
      password: "",
    },
    options: {
      encoding: "UTF-8",
      heartbeatInterval: 30,
      tags: [],
      extras: {},
      startupCommand: "",
      env: "",
      jumpHosts: [],
      sftpDefaultDirectory: "",
    },
    tunnelings: [],
    sort: 0,
    parentId: "0",
    ownerId: "0",
    creatorId: "0",
    ownerType: "",
    deleted: false,
    createDate: 0,
    updateDate: 0,
    ...overrides,
  };
}
