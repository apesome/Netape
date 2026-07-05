import { useRef, useState, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import type { Host } from "../types";
import { t as i18nT, useT } from "../i18n";
import {
  useServerStats,
  type ServerStats,
  type NetIfaceStat,
  type DiskStat,
  type ProcessInfo,
} from "../hooks/useServerStats";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtSpeed(bps: number): string {
  if (bps >= 1073741824) return `${(bps / 1073741824).toFixed(1)} GB/s`;
  if (bps >= 1048576)    return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024)       return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtMB(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} G` : `${mb} M`;
}

function cpuColor(pct: number)  { return pct >= 90 ? "var(--clr-red)" : pct >= 70 ? "var(--clr-yellow)" : "var(--clr-green)"; }
function diskColor(pct: number) { return pct >= 90 ? "var(--clr-red)" : pct >= 80 ? "var(--clr-yellow)" : "var(--accent)"; }
function latencyColor(ms: number) {
  if (ms < 0)   return "var(--fg-dim)";
  if (ms >= 200) return "var(--clr-red)";
  if (ms >= 80)  return "var(--clr-yellow)";
  return "var(--clr-green)";
}

// ── Mini progress bar ─────────────────────────────────────────────────────────

function Bar({ pct, color, w = 44 }: { pct: number; color: string; w?: number }) {
  return (
    <span className="sbp-minibar" style={{ width: w }}>
      <span className="sbp-minibar-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </span>
  );
}

// ── Chip: click-toggled, passes its DOMRect to parent ───────────────────────

function Chip({
  name, openPop, onToggle, children,
}: {
  name: string;
  openPop: string | null;
  onToggle: (name: string, rect: DOMRect) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const isOpen = openPop === name;
  return (
    <span
      className={`sb-chip${isOpen ? " sb-chip--active" : ""}`}
      ref={ref}
      onClick={() => ref.current && onToggle(name, ref.current.getBoundingClientRect())}
    >
      {children}
    </span>
  );
}

// ── Popover contents ──────────────────────────────────────────────────────────

function CpuPop({ s }: { s: ServerStats }) {
  const cols = s.cpuCores > 8 ? 4 : 2;
  return (
    <div className="sbp">
      <div className="sbp-title">{i18nT("stats.cpu.cores", { n: s.cpuCores })}</div>
      <div className="sbp-cpu-scroll">
        <div className="sbp-grid" style={{ gridTemplateColumns: `repeat(${cols}, auto)` }}>
          {s.cpuPerCore.map((pct, i) => (
            <div key={i} className="sbp-core">
              <span className="sbp-lbl">C{i}</span>
              <Bar pct={pct} color={cpuColor(pct)} w={44} />
              <span className="sbp-val" style={{ color: cpuColor(pct) }}>{Math.round(pct)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProcList({ procs }: { procs: ProcessInfo[] }) {
  return (
    <div className="sbp-proc-list">
      {procs.map((p) => (
        <div key={p.pid} className="sbp-proc">
          <span className="sbp-proc-cmd" data-tooltip={p.cmd}>{p.cmd}</span>
          <Bar pct={p.memPct * 5} color="var(--accent)" w={40} />
          <span className="sbp-proc-pct">{p.memPct.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

function MemPop({ s }: { s: ServerStats }) {
  const t = s.memTotal || 1;
  return (
    <div className="sbp sbp--mem">
      <div className="sbp-title">{i18nT("stats.mem.title")}</div>
      <div className="sbp-membar">
        <span style={{ width: `${(s.memUsed    / t) * 100}%`, background: "var(--clr-green)" }} />
        <span style={{ width: `${(s.memBuffers / t) * 100}%`, background: "var(--accent)" }} />
        <span style={{ width: `${(s.memCached  / t) * 100}%`, background: "var(--clr-yellow)" }} />
      </div>
      <div className="sbp-mem-row"><span className="sbp-dot" style={{ background: "var(--clr-green)" }} /><span>{i18nT("stats.mem.used")}</span><span className="sbp-r">{fmtMB(s.memUsed)}</span></div>
      <div className="sbp-mem-row"><span className="sbp-dot" style={{ background: "var(--accent)" }} /><span>{i18nT("stats.mem.buffers")}</span><span className="sbp-r">{fmtMB(s.memBuffers)}</span></div>
      <div className="sbp-mem-row"><span className="sbp-dot" style={{ background: "var(--clr-yellow)" }} /><span>{i18nT("stats.mem.cached")}</span><span className="sbp-r">{fmtMB(s.memCached)}</span></div>
      <div className="sbp-mem-row"><span className="sbp-dot" style={{ background: "rgba(255,255,255,0.1)" }} /><span>{i18nT("stats.mem.free")}</span><span className="sbp-r">{fmtMB(s.memFree)}</span></div>
      <div className="sbp-divider" />
      <div className="sbp-mem-total">{fmtMB(s.memUsed)} / {fmtMB(s.memTotal)}</div>
      {s.swapTotal > 0 && <div className="sbp-mem-swap">Swap {fmtMB(s.swapUsed)} / {fmtMB(s.swapTotal)}</div>}
      {s.topProcs.length > 0 && (
        <>
          <div className="sbp-divider" />
          <div className="sbp-title" style={{ marginBottom: 5 }}>{i18nT("stats.mem.topProcs")}</div>
          <ProcList procs={s.topProcs} />
        </>
      )}
    </div>
  );
}

function DiskPop({ disks }: { disks: DiskStat[] }) {
  return (
    <div className="sbp">
      <div className="sbp-title">{i18nT("stats.disk.title")}</div>
      {disks.length === 0
        ? <div className="sbp-empty">{i18nT("stats.disk.empty")}</div>
        : disks.map((d) => (
          <div key={d.mount} className="sbp-disk">
            <span className="sbp-lbl sbp-mount">{d.mount}</span>
            <Bar pct={d.pct} color={diskColor(d.pct)} w={60} />
            <span className="sbp-val">
              {d.used.toFixed(0)}/{d.total.toFixed(0)} G
              <span style={{ color: diskColor(d.pct), marginLeft: 4 }}>{d.pct}%</span>
            </span>
          </div>
        ))}
    </div>
  );
}

function NetPop({ ifaces, latency }: { ifaces: NetIfaceStat[]; latency: number }) {
  const sorted = [...ifaces].sort((a, b) => (b.rxSpeed + b.txSpeed) - (a.rxSpeed + a.txSpeed));
  const active = sorted.filter((f) => f.rxSpeed + f.txSpeed > 0);
  const idle   = sorted.filter((f) => f.rxSpeed + f.txSpeed === 0);
  return (
    <div className="sbp sbp--net">
      <div className="sbp-title-row">
        <span>{i18nT("stats.net.title")}</span>
        <span className="sbp-latency" style={{ color: latencyColor(latency) }}>
          {i18nT("stats.net.latency", { val: latency < 0 ? "---" : `${latency} ms` })}
        </span>
      </div>
      <div className="sbp-net-scroll">
        {ifaces.length === 0
          ? <div className="sbp-empty">{i18nT("stats.net.empty")}</div>
          : <>
              {active.map((f) => (
                <div key={f.name} className="sbp-net">
                  <span className="sbp-lbl sbp-iface">{f.name}</span>
                  <span className="sbp-rx">↓ {fmtSpeed(f.rxSpeed)}</span>
                  <span className="sbp-tx">↑ {fmtSpeed(f.txSpeed)}</span>
                </div>
              ))}
              {active.length > 0 && idle.length > 0 && <div className="sbp-divider sbp-divider--net" />}
              {idle.map((f) => (
                <div key={f.name} className="sbp-net sbp-net--idle">
                  <span className="sbp-lbl sbp-iface">{f.name}</span>
                  <span className="sbp-rx">↓ {fmtSpeed(f.rxSpeed)}</span>
                  <span className="sbp-tx">↑ {fmtSpeed(f.txSpeed)}</span>
                </div>
              ))}
            </>}
      </div>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const IcCopy    = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>;
const IcOk      = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l4 4 6-7"/></svg>;
const IcCpu     = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1v2M8 1v2M10 1v2M6 13v2M8 13v2M10 13v2M1 6h2M1 8h2M1 10h2M13 6h2M13 8h2M13 10h2"/></svg>;
const IcMem     = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="14" height="8" rx="1.5"/><path d="M4 4V3M7 4V3M10 4V3M13 4V3M4 12v1M7 12v1M10 12v1M13 12v1"/></svg>;
const IcDisk    = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="8" cy="13" rx="6" ry="1.5"/><path d="M2 8c0-1.1 2.686-2 6-2s6 .9 6 2"/><path d="M2 5c0-1.1 2.686-2 6-2s6 .9 6 2"/><path d="M2 5v8M14 5v8M2 8v0M14 8v0"/></svg>;
const IcNet     = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 2v12M2 8h12"/><path d="M3 5q2.5 1 5 1t5-1M3 11q2.5-1 5-1t5 1"/></svg>;
const IcChevron  = () => <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3l5 5-5 5"/></svg>;
const IcSearch   = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5l3.5 3.5"/></svg>;
const IcSystem   = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="1" width="14" height="10" rx="1.5"/><path d="M5 14h6M8 11v3"/><path d="M4 4h8M4 7h5"/></svg>;
const IcInfo     = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5.5v.5"/></svg>;

// ── SysInfo types + popover ───────────────────────────────────────────────────

interface SysInfoData {
  hostname:  string;
  user:      string;
  ipAddr:    string;
  osName:    string;
  osVer:     string;
  kernel:    string;
  arch:      string;
  cpuModel:  string;
  cpuCores:  string;
  memTotal:  string;
  uptime:    string;
}

function SysInfoPop({ info }: { info: SysInfoData }) {
  const osLabel  = [info.osName, info.osVer].filter(Boolean).join(" ");
  const cpuLabel = info.cpuCores
    ? `${info.cpuModel}${info.cpuCores ? ` · ${i18nT("stats.sysinfo.cpuCores", { n: info.cpuCores })}` : ""}`
    : info.cpuModel;
  const rows: [string, string][] = [
    [i18nT("stats.sysinfo.hostname"), info.hostname],
    [i18nT("stats.sysinfo.user"),     info.user    ],
    [i18nT("stats.sysinfo.ip"),       info.ipAddr  ],
    [i18nT("stats.sysinfo.os"),       osLabel      ],
    [i18nT("stats.sysinfo.kernel"),   info.kernel  ],
    [i18nT("stats.sysinfo.arch"),     info.arch    ],
    [i18nT("stats.sysinfo.cpu"),      cpuLabel     ],
    [i18nT("stats.sysinfo.mem"),      info.memTotal],
    [i18nT("stats.sysinfo.uptime"),   info.uptime  ],
  ].filter(([, v]) => v) as [string, string][];
  return (
    <div className="sbp sbp--sysinfo">
      <div className="sbp-title">{i18nT("stats.sysinfo.title")}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="sbp-si-row">
          <span className="sbp-si-key">{k}</span>
          <span className="sbp-si-val">{v}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main bar ──────────────────────────────────────────────────────────────────

interface Props {
  sessionId?:           string;
  host?:                Host;
  transport?:           "ssh" | "telnet";
  onSystem?:            () => void;
  systemOpen?:          boolean;
  // Search — controlled from parent
  searchOpen?:          boolean;
  searchQuery?:         string;
  onSearchToggle?:      () => void;
  onSearchQueryChange?: (q: string) => void;
  onFindNext?:          (q: string) => void;
  onFindPrev?:          (q: string) => void;
  onSearchClose?:       () => void;
}

export default function ServerStatsBar({
  sessionId, host, transport,
  onSystem, systemOpen,
  searchOpen, searchQuery, onSearchToggle, onSearchQueryChange, onFindNext, onFindPrev, onSearchClose,
}: Props) {
  useT();
  const enabled    = transport !== "telnet";
  const stats      = useServerStats(sessionId, enabled);
  const [copied,   setCopied]   = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openPop,  setOpenPop]  = useState<string | null>(null);
  const [popPos,   setPopPos]   = useState({ left: 0, top: 0 });
  const [sysInfo,  setSysInfo]  = useState<SysInfoData | null>(null);

  useEffect(() => {
    setSysInfo(null);
    if (!sessionId || !enabled) return;
    let cancelled = false;
    invoke<SysInfoData>("ssh_sysinfo", { sessionId })
      .then((d) => { if (!cancelled) setSysInfo(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, enabled]);

  // Close popover when clicking outside
  useEffect(() => {
    if (!openPop) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!t.closest(".sb-chip--active") && !t.closest(".sbp-fixed")) {
        setOpenPop(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openPop]);

  if (!host) return null;

  const rootDisk = stats?.disks.find((d) => d.mount === "/") ?? stats?.disks[0];

  const handleCopy = async () => {
    await writeText(host.host);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const togglePop = (name: string, rect: DOMRect) => {
    setOpenPop((prev) => {
      if (prev === name) return null;
      setPopPos({ left: rect.left, top: rect.bottom + 5 });
      return name;
    });
  };

  const handleToggleExpand = () => {
    setOpenPop(null);
    setExpanded((v) => !v);
  };

  return (
    <div className="sb-bar">
      {/* Host copy button */}
      <button
        className={`sb-host${copied ? " sb-host--ok" : ""}`}
        onClick={handleCopy}
        data-tooltip={copied ? i18nT("stats.copied") : i18nT("stats.copyHost", { host: host.host })}
      >
        <span className="sb-host-name">{host.name || host.host}</span>
        {copied ? <IcOk /> : <IcCopy />}
      </button>

      {/* System info chip — shown once sysinfo is loaded */}
      {sysInfo && (
        <Chip name="sysinfo" openPop={openPop} onToggle={togglePop}>
          <IcInfo />
        </Chip>
      )}

      {enabled && (
        <>
          <span className="sb-sep" />

          {/* Expand / collapse toggle */}
          <button
            className={`sb-toggle${expanded ? " sb-toggle--open" : ""}`}
            onClick={handleToggleExpand}
            data-tooltip={expanded ? i18nT("stats.collapse") : i18nT("stats.expand")}
          >
            <IcChevron />
          </button>

          {/* Stats chips — slide in/out via max-width */}
          <div className={`sb-stats${expanded ? " sb-stats--open" : ""}`}>
            <Chip name="cpu" openPop={openPop} onToggle={togglePop}>
              <IcCpu />
              {stats
                ? <><span style={{ color: cpuColor(stats.cpu) }}>{stats.cpu}%</span><span className="sb-sub"> {stats.cpuCores}C</span></>
                : <span className="sb-dim">---</span>}
            </Chip>

            <Chip name="mem" openPop={openPop} onToggle={togglePop}>
              <IcMem />
              {stats
                ? <>{fmtMB(stats.memUsed)}<span className="sb-sub">/{fmtMB(stats.memTotal)}</span></>
                : <span className="sb-dim">---</span>}
            </Chip>

            <Chip name="disk" openPop={openPop} onToggle={togglePop}>
              <IcDisk />
              {!stats || !rootDisk
                ? <span className="sb-dim">---</span>
                : <><span style={{ color: diskColor(rootDisk.pct) }}>{rootDisk.mount}</span><span className="sb-sub"> {rootDisk.used.toFixed(0)}/{rootDisk.total.toFixed(0)} G</span></>}
            </Chip>

            <Chip name="net" openPop={openPop} onToggle={togglePop}>
              <IcNet />
              {stats
                ? <>
                    <span className="sb-rx">↓{fmtSpeed(stats.netRx)}</span>
                    <span className="sb-tx"> ↑{fmtSpeed(stats.netTx)}</span>
                    <span className="sb-sep-inline" />
                    <span style={{ color: latencyColor(stats.latency) }}>
                      {stats.latency < 0 ? "---" : `${stats.latency}ms`}
                    </span>
                  </>
                : <span className="sb-dim">---</span>}
            </Chip>
          </div>
        </>
      )}

      {/* Center search input — squeezes between stats and right buttons */}
      {searchOpen && (
        <div className="sb-search" onMouseDown={(e) => e.stopPropagation()}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
            <circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5l3.5 3.5"/>
          </svg>
          <input
            className="sb-search-input"
            value={searchQuery ?? ""}
            placeholder={i18nT("stats.searchPlaceholder")}
            autoFocus
            onChange={(e) => {
              const q = e.target.value;
              onSearchQueryChange?.(q);
              if (q) onFindNext?.(q);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? onFindPrev?.(searchQuery ?? "") : onFindNext?.(searchQuery ?? ""); }
              if (e.key === "Escape") onSearchClose?.();
            }}
          />
          <button className="sb-action" onClick={() => onFindPrev?.(searchQuery ?? "")} data-tooltip={i18nT("stats.prevResult")}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4"/></svg>
          </button>
          <button className="sb-action" onClick={() => onFindNext?.(searchQuery ?? "")} data-tooltip={i18nT("stats.nextResult")}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4"/></svg>
          </button>
        </div>
      )}

      {/* Right-side action buttons */}
      <div className="sb-right">
        {onSearchToggle !== undefined && (
          <button className={`sb-action${searchOpen ? " sb-action--active" : ""}`} onClick={onSearchToggle} data-tooltip={i18nT("stats.search")}>
            <IcSearch />
          </button>
        )}
        {onSystem && (
          <button
            className={`sb-action${systemOpen ? " sb-action--active" : ""}`}
            onClick={onSystem}
            data-tooltip={i18nT("stats.system")}
          >
            <IcSystem />
          </button>
        )}
      </div>

      {/* Popovers rendered in document.body to escape overflow:hidden */}
      {openPop && (stats || openPop === "sysinfo") && createPortal(
        <div className="sbp-fixed" style={{ left: popPos.left, top: popPos.top }}>
          {openPop === "cpu"     && stats && <CpuPop s={stats} />}
          {openPop === "mem"     && stats && <MemPop s={stats} />}
          {openPop === "disk"    && stats && <DiskPop disks={stats.disks} />}
          {openPop === "net"     && stats && <NetPop ifaces={stats.netIfaces} latency={stats.latency} />}
          {openPop === "sysinfo" && sysInfo && <SysInfoPop info={sysInfo} />}
        </div>,
        document.body,
      )}
    </div>
  );
}
