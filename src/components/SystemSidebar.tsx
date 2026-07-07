import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t as i18nT, useT } from "../i18n";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProcessEntry {
  pid:     string;
  user:    string;
  cpu:     number;
  mem:     number;
  cmd:     string;
  stat:    string;
  rss:     number;   // KB
  vsz:     number;   // KB
  ppid:    string;
  elapsed: string;   // etime format e.g. "01:23:45"
}

interface DockerContainer {
  id:     string;
  name:   string;
  image:  string;
  status: string;
  state:  string;
  ports:  string;
}

interface DockerImage {
  id:         string;
  repository: string;
  tag:        string;
  size:       string;
  created:    string;
}

interface Props {
  sessionId?: string;
  onClose: () => void;
  width?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cmdName(cmd: string) {
  const first = cmd.split(" ")[0];
  return first.split("/").pop() ?? first;
}

function fmtKb(kb: number) {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024)        return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

type SysErrorKind = "process" | "docker";

function summarizeSystemError(kind: SysErrorKind, error: string) {
  const msg = String(error || "").trim();
  const lower = msg.toLowerCase();

  if (kind === "docker") {
    if (
      lower.includes("permission denied") ||
      lower.includes("docker daemon sock") ||
      lower.includes("sudoers")
    ) {
      return {
        title: i18nT("docker.error.permissionTitle"),
        detail: i18nT("docker.error.permissionDetail"),
      };
    }
    return {
      title: i18nT("docker.error.unavailableTitle"),
      detail: i18nT("docker.error.unavailableDetail"),
    };
  }

  if (
    lower.includes("permission denied") ||
    lower.includes("operation not permitted") ||
    lower.includes("sudoers")
  ) {
    return {
      title: i18nT("sys.process.error.permissionTitle"),
      detail: i18nT("sys.process.error.permissionDetail"),
    };
  }

  return {
    title: i18nT("sys.process.error.unavailableTitle"),
    detail: i18nT("sys.process.error.unavailableDetail"),
  };
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const IcSearch = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.5 }}>
    <circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5l3.5 3.5"/>
  </svg>
);
const IcTerm = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="8" cy="8" r="6"/>
    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>
  </svg>
);
const IcKill = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8"/>
  </svg>
);
const IcPlay = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 3l10 5-10 5z"/>
  </svg>
);
const IcStop = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
    <rect x="3" y="3" width="10" height="10" rx="1"/>
  </svg>
);
const IcRestart = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M2 8a6 6 0 1 0 1.5-4"/><path d="M2 4v4h4"/>
  </svg>
);
const IcPause = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
    <rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/>
  </svg>
);
const IcTrash = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5M3 4l1 9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-9"/>
  </svg>
);
const IcGauge = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M2.5 11a6 6 0 1 1 11 0"/>
    <path d="M8 10.5l-3-4"/>
  </svg>
);
const IcDocker = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="#2496ed" style={{ flexShrink: 0 }}>
    <path d="M13.5 9h2v2h-2zM10.5 9h2v2h-2zM7.5 9h2v2h-2zM10.5 6h2v2h-2zM7.5 6h2v2h-2z"/>
    <path d="M22.8 10.3c-.5-.3-1.5-.4-2.3-.2-.1-.8-.6-1.5-1.3-2l-.4-.3-.3.4c-.4.5-.5 1.4-.4 2 .1.4.3.8.6 1.1-.3.2-.8.4-1.5.4H1.1c-.2 1.1.1 2.5.8 3.5.8 1 1.9 1.5 3.4 1.5 3.2 0 5.6-1.5 6.7-4.2.5 0 1.6 0 2.2-1.1h.1c.4.7 1.2 1.1 2 1.1h.1c.2 0 .3-.1.3-.1.6-.2 1.1-.6 1.5-1.1.4.2.8.3 1.3.3.5 0 .9-.1 1.2-.3z"/>
  </svg>
);
const IcLayers = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 5l7-3 7 3-7 3-7-3z"/>
    <path d="M1 9l7 3 7-3"/>
    <path d="M1 13l7 3 7-3"/>
  </svg>
);
const IcBlocked = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M15.5 8.5l-7 7"/>
  </svg>
);

function SysErrorState({
  kind,
  error,
  onRetry,
}: {
  kind: SysErrorKind;
  error: string;
  onRetry: () => void;
}) {
  const summary = summarizeSystemError(kind, error);
  return (
    <div className="sys-empty-state">
      <div className="sys-empty-icon sys-empty-icon--error"><IcBlocked /></div>
      <div className="sys-empty-title">{summary.title}</div>
      <div className="sys-empty-detail">{summary.detail}</div>
      <button className="sys-empty-retry" onClick={onRetry}>
        <IcRestart /> {i18nT("sys.retry")}
      </button>
    </div>
  );
}

// ── Shared small components ───────────────────────────────────────────────────

function ResBar({ label, value }: { label: string; value: number }) {
  const pct  = Math.min(100, Math.max(0, value));
  const high = pct > 85;
  return (
    <div className="sys-res-bar">
      <span className="sys-res-label">{label}</span>
      <div className="sys-res-track">
        <div className="sys-res-fill"
          style={{ width: `${pct}%`, background: high ? "var(--clr-red)" : undefined }} />
      </div>
      <span className="sys-res-value">{value.toFixed(1)}%</span>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function SystemSidebar({ sessionId, onClose, width = 420 }: Props) {
  useT();
  const [tab, setTab] = useState<"process" | "docker">("process");

  return (
    <div className="sysbar" style={{ width }}>
      <div className="sysbar-header">
        <div className="sysbar-tabs">
          <button className={`sysbar-tab${tab === "process" ? " sysbar-tab--active" : ""}`}
            onClick={() => setTab("process")}>{i18nT("sys.tab.process")}</button>
          <button className={`sysbar-tab${tab === "docker"  ? " sysbar-tab--active" : ""}`}
            onClick={() => setTab("docker")}>{i18nT("sys.tab.docker")}</button>
        </div>
        <button className="sysbar-close" onClick={onClose} data-tooltip={i18nT("sys.close")}>✕</button>
      </div>
      <div className="sysbar-body">
        {tab === "process"
          ? <ProcessPanel sessionId={sessionId} />
          : <DockerPanel  sessionId={sessionId} />}
      </div>
    </div>
  );
}

// ── Process panel ─────────────────────────────────────────────────────────────

type SortKey    = "cpu" | "mem" | "pid" | "cmd" | "user";
type SortDir    = "asc" | "desc";
type ProcFilter = "all" | "running";

const SORT_OPTIONS: { key: SortKey; label: string; labelKey?: string }[] = [
  { key: "cpu",  label: "CPU"  },
  { key: "mem",  label: "Memory", labelKey: "sys.sort.mem" },
  { key: "pid",  label: "PID"  },
  { key: "cmd",  label: "Command", labelKey: "sys.sort.cmd" },
  { key: "user", label: "User", labelKey: "sys.sort.user" },
];

function defaultSortDir(key: SortKey): SortDir {
  return key === "pid" || key === "cmd" || key === "user" ? "asc" : "desc";
}

function procBadgeKind(stat: string) {
  switch (stat[0]) {
    case "R": return "running";
    case "Z": return "zombie";
    case "T": return "stopped";
    case "D": return "paused";
    default:  return "idle";
  }
}

function procBadgeLabel(stat: string) {
  const m: Record<string, string> = { R: i18nT("proc.badge.R"), S: i18nT("proc.badge.S"), D: i18nT("proc.badge.D"), T: i18nT("proc.badge.T"), Z: i18nT("proc.badge.Z"), I: i18nT("proc.badge.I") };
  return m[stat[0]] ?? stat;
}

function ProcessPanel({ sessionId }: { sessionId?: string }) {
  const [procs,        setProcs]        = useState<ProcessEntry[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [search,       setSearch]       = useState("");
  const [filter,       setFilter]       = useState<ProcFilter>("all");
  const [sort,         setSort]         = useState<{ key: SortKey; dir: SortDir }>({ key: "cpu", dir: "desc" });
  const [expanded,     setExpanded]     = useState<string | null>(null);
  const [busy,         setBusy]         = useState<Record<string, boolean>>({});
  const [tick,         setTick]         = useState(0);
  const [reniceTarget, setReniceTarget] = useState<string | null>(null);
  const [reniceNice,   setReniceNice]   = useState("0");
  const listRef = useRef<HTMLDivElement>(null);

  const doRefresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    // Sequential fetch: wait for completion before scheduling next, avoiding
    // request pile-up on slow/busy servers with many processes.
    const run = async () => {
      while (!cancelled) {
        try {
          const list = await invoke<ProcessEntry[]>("ssh_process_list", { sessionId });
          if (cancelled) break;
          setProcs(list);
          setError(null);
          setLoading(false);
        } catch (e) {
          if (cancelled) break;
          setProcs([]);
          setError(String(e));
          setLoading(false);
        }
        await new Promise<void>(r => setTimeout(r, 5000));
      }
    };
    run();
    return () => { cancelled = true; };
  }, [sessionId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll list to top whenever the filter or search changes so the user sees
  // the filtered results rather than a mid-list blank area.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [filter, search]);

  const cycleSort = (key: SortKey) => {
    setSort(prev => ({
      key,
      dir: prev.key === key ? (prev.dir === "asc" ? "desc" : "asc") : defaultSortDir(key),
    }));
  };

  const visible = useMemo(() => {
    let list = procs;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.cmd.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q) ||
        p.pid.includes(q)
      );
    }
    if (filter === "running") {
      list = list.filter(p => "RD".includes(p.stat[0]));
    }
    const d = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sort.key) {
        case "mem":  return d * (a.mem - b.mem);
        case "pid":  return d * (parseInt(a.pid) - parseInt(b.pid));
        case "cmd":  return d * cmdName(a.cmd).localeCompare(cmdName(b.cmd));
        case "user": return d * a.user.localeCompare(b.user);
        default:     return d * (a.cpu - b.cpu);
      }
    });
  }, [procs, search, filter, sort]);

  const signal = async (e: React.MouseEvent, pid: string, sig: string) => {
    e.stopPropagation();
    if (!sessionId) return;
    setBusy(b => ({ ...b, [pid]: true }));
    try {
      await invoke("ssh_process_signal", { sessionId, pid, signal: sig });
      setTimeout(doRefresh, 600);
    } catch { /* ignore */ } finally {
      setBusy(b => ({ ...b, [pid]: false }));
    }
  };

  const doRenice = async () => {
    if (!sessionId || !reniceTarget) return;
    const n = parseInt(reniceNice);
    if (isNaN(n) || n < -20 || n > 19) return;
    const pid = reniceTarget;
    setBusy(b => ({ ...b, [pid]: true }));
    setReniceTarget(null);
    try {
      await invoke("ssh_process_renice", { sessionId, pid, nice: n });
      setTimeout(doRefresh, 600);
    } catch { /* ignore */ } finally {
      setBusy(b => ({ ...b, [pid]: false }));
    }
  };

  return (
    <div className="sys-panel">
      <div className="sys-toolbar">
        <div className="sys-search-wrap">
          <IcSearch />
          <input className="sys-search-input" placeholder={i18nT("sys.search.process")}
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button className="sys-search-clear" onClick={() => setSearch("")}>✕</button>
          )}
        </div>
        <div className="sys-sort-btns">
          {SORT_OPTIONS.map(({ key, label, labelKey }) => (
            <button key={key}
              className={`sys-sort-btn${sort.key === key ? " active" : ""}`}
              onClick={() => cycleSort(key)}>
              {i18nT(labelKey ?? label)}{sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
            </button>
          ))}
        </div>
      </div>
      <div className="sys-filter-bar">
        <div className="sys-filter-btns">
          <button className={`sys-filter-btn${filter === "all"     ? " active" : ""}`} onClick={() => setFilter("all")}>{i18nT("sys.filter.all")}</button>
          <button className={`sys-filter-btn${filter === "running" ? " active" : ""}`} onClick={() => setFilter("running")}>{i18nT("sys.filter.running")}</button>
        </div>
        <span className="sys-meta-count">{i18nT("sys.count.processes", { n: visible.length })}</span>
      </div>
      <div className="sys-list" ref={listRef}>
        {loading && !error && (
          <div className="sys-hint">{i18nT("sys.loading.processes")}</div>
        )}
        {error && (
          <SysErrorState kind="process" error={error} onRetry={doRefresh} />
        )}
        {!loading && !error && visible.length === 0 && procs.length > 0 && (
          <div className="sys-hint">{i18nT("sys.noMatch.processes")}</div>
        )}
        {visible.map(p => {
          const isExp     = expanded === p.pid;
          const kind      = procBadgeKind(p.stat || "S");
          const isStopped = p.stat?.[0] === "T";
          const isZombie  = p.stat?.[0] === "Z";
          return (
            <div key={p.pid} className={`sys-row${isExp ? " sys-row--expanded" : ""}`}
              onClick={() => setExpanded(isExp ? null : p.pid)}>
              <div className="sys-row-head">
                <span className="sys-row-name">{p.cmd}</span>
                <span className={`sys-badge sys-badge--${kind}`}>{procBadgeLabel(p.stat || "S")}</span>
                <div className="sys-actions">
                  {!isStopped && !isZombie && (
                    <button className="sys-act-btn" disabled={busy[p.pid]}
                      onClick={e => signal(e, p.pid, "STOP")} data-tooltip={i18nT("proc.pause")}>
                      <IcPause />
                    </button>
                  )}
                  {isStopped && (
                    <button className="sys-act-btn" disabled={busy[p.pid]}
                      onClick={e => signal(e, p.pid, "CONT")} data-tooltip={i18nT("proc.resume")}>
                      <IcPlay />
                    </button>
                  )}
                  <button className="sys-act-btn" disabled={busy[p.pid]}
                    onClick={e => signal(e, p.pid, "TERM")} data-tooltip={i18nT("proc.kill")}>
                    <IcTerm />
                  </button>
                  <button className="sys-act-btn sys-act-btn--danger" disabled={busy[p.pid]}
                    onClick={e => signal(e, p.pid, "KILL")} data-tooltip={i18nT("proc.forceKill")}>
                    <IcKill />
                  </button>
                  <button className="sys-act-btn" disabled={busy[p.pid]}
                    onClick={e => { e.stopPropagation(); setReniceTarget(p.pid); setReniceNice("0"); }}
                    data-tooltip={i18nT("proc.renice")}>
                    <IcGauge />
                  </button>
                </div>
              </div>
              <div className="sys-row-sub">{p.user} · PID {p.pid}</div>
              {isExp && (
                <div className="sys-expand">
                  <div className="sys-expand-cmd">{p.cmd}</div>
                <div className="sys-expand-grid sys-expand-grid--2col">
                    <span className="sys-expand-key">{i18nT("proc.expand.ppid")}</span>  <span className="sys-expand-val">{p.ppid || "—"}</span>
                    <span className="sys-expand-key">{i18nT("proc.expand.stat")}</span>    <span className="sys-expand-val">{p.stat || "—"}</span>
                    <span className="sys-expand-key">{i18nT("proc.expand.elapsed")}</span>  <span className="sys-expand-val">{p.elapsed || "—"}</span>
                    <span className="sys-expand-key">{i18nT("proc.expand.rss")}</span><span className="sys-expand-val">{fmtKb(p.rss || 0)}</span>
                    <span className="sys-expand-key">{i18nT("proc.expand.vsz")}</span><span className="sys-expand-val">{fmtKb(p.vsz || 0)}</span>
                  </div>
                  <ResBar label="CPU" value={p.cpu} />
                  <ResBar label="MEM" value={p.mem} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {reniceTarget && (
        <div className="sys-renice-overlay" onClick={() => setReniceTarget(null)}>
          <div className="sys-renice-box" onClick={e => e.stopPropagation()}>
            <div className="sys-renice-title">{i18nT("proc.renice.title", { pid: reniceTarget })}</div>
            <div className="sys-renice-sub">{i18nT("proc.renice.sub")}</div>
            <input
              type="number" min="-20" max="19"
              className="sys-renice-input"
              value={reniceNice}
              onChange={e => setReniceNice(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter")  doRenice();
                if (e.key === "Escape") setReniceTarget(null);
              }}
              autoFocus
            />
            <div className="sys-renice-actions">
              <button className="sys-sort-btn" onClick={() => setReniceTarget(null)}>{i18nT("proc.renice.cancel")}</button>
              <button className="sys-sort-btn active" onClick={doRenice}>{i18nT("proc.renice.confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Docker panel ──────────────────────────────────────────────────────────────

type DockerFilter = "all" | "running" | "stopped" | "paused";

function dockerKind(state: string, status: string): "running" | "paused" | "stopped" {
  const s = (state || status).toLowerCase();
  if (s.includes("paused")) return "paused";          // "Up X (Paused)" before "Up" check
  if (s === "running" || s.startsWith("up")) return "running";
  return "stopped";
}

function DockerContainersPanel({ sessionId }: { sessionId?: string }) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [search,     setSearch]     = useState("");
  const [filter,     setFilter]     = useState<DockerFilter>("all");
  const [expanded,   setExpanded]   = useState<string | null>(null);
  const [busy,       setBusy]       = useState<Record<string, boolean>>({});
  const [tick,       setTick]       = useState(0);

  const doRefresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setError(null);
    const load = async () => {
      try {
        const list = await invoke<DockerContainer[]>("ssh_docker_list", { sessionId });
        if (!cancelled) { setContainers(list); setLoading(false); }
      } catch (e) {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [sessionId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    let list = containers;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    }
    if (filter !== "all") {
      list = list.filter(c => dockerKind(c.state, c.status) === filter);
    }
    return list;
  }, [containers, search, filter]);

  const action = async (e: React.MouseEvent, c: DockerContainer, act: string) => {
    e.stopPropagation();
    if (!sessionId) return;
    if (act === "rm" && !window.confirm(i18nT("docker.confirmDelete", { name: c.name }))) return;
    setBusy(b => ({ ...b, [c.id]: true }));
    try {
      await invoke("ssh_docker_action", { sessionId, containerId: c.id, action: act });
      setTimeout(doRefresh, 800);
    } catch { /* ignore */ } finally {
      setBusy(b => ({ ...b, [c.id]: false }));
    }
  };

  const FILTER_LABELS: Record<DockerFilter, string> = {
    all: i18nT("docker.filter.all"), running: i18nT("docker.filter.running"), stopped: i18nT("docker.filter.stopped"), paused: i18nT("docker.filter.paused"),
  };

  return (
    <div className="sys-panel">
      <div className="sys-toolbar">
        <div className="sys-search-wrap">
          <IcSearch />
          <input className="sys-search-input" placeholder={i18nT("docker.search.containers")}
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button className="sys-search-clear" onClick={() => setSearch("")}>✕</button>
          )}
        </div>
        <button className="sys-act-btn" onClick={doRefresh} data-tooltip={i18nT("docker.refresh")}><IcRestart /></button>
      </div>
      <div className="sys-filter-bar">
        <div className="sys-filter-btns">
          {(["all","running","stopped","paused"] as DockerFilter[]).map(f => (
            <button key={f} className={`sys-filter-btn${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}>{FILTER_LABELS[f]}</button>
          ))}
        </div>
        <span className="sys-meta-count">{i18nT("docker.count.containers", { n: visible.length })}</span>
      </div>
      <div className="sys-list">
        {loading && containers.length === 0 && (
          <div className="sys-hint">{i18nT("docker.loading.containers")}</div>
        )}
        {error && (
          <SysErrorState kind="docker" error={error} onRetry={doRefresh} />
        )}
        {!loading && !error && containers.length === 0 && (
          <div className="sys-hint">{i18nT("docker.empty.containers")}</div>
        )}
        {visible.map(c => {
          const isExp     = expanded === c.id;
          const kind      = dockerKind(c.state, c.status);
          const isRunning = kind === "running";
          const isStopped = kind === "stopped";
          const isPaused  = kind === "paused";
          const badgeLabel = isRunning ? i18nT("docker.badge.running") : isPaused ? i18nT("docker.badge.paused") : i18nT("docker.badge.stopped");
          return (
            <div key={c.id} className={`sys-row sys-row--docker${isExp ? " sys-row--expanded" : ""}`}
              onClick={() => setExpanded(isExp ? null : c.id)}>
              <div className="sys-row-head">
                <IcDocker />
                <span className="sys-row-name" style={{ marginLeft: 6 }}>{c.name}</span>
                <span className={`sys-badge sys-badge--${kind}`}>{badgeLabel}</span>
                <div className="sys-actions">
                  {isRunning && (<>
                    <button className="sys-act-btn" disabled={busy[c.id]}
                      onClick={e => action(e, c, "restart")} data-tooltip={i18nT("docker.action.restart")}><IcRestart /></button>
                    <button className="sys-act-btn" disabled={busy[c.id]}
                      onClick={e => action(e, c, "stop")}    data-tooltip={i18nT("docker.action.stop")}><IcStop /></button>
                  </>)}
                  {isPaused && (
                    <button className="sys-act-btn" disabled={busy[c.id]}
                      onClick={e => action(e, c, "unpause")} data-tooltip={i18nT("proc.resume")}><IcPlay /></button>
                  )}
                  {isStopped && (
                    <button className="sys-act-btn" disabled={busy[c.id]}
                      onClick={e => action(e, c, "start")} data-tooltip={i18nT("docker.action.start")}><IcPlay /></button>
                  )}
                </div>
              </div>
              <div className="sys-row-sub">{c.image}</div>
              {isExp && (
                <div className="sys-expand">
                  <div className="sys-expand-grid">
                    <span className="sys-expand-key">{i18nT("docker.expand.image")}</span>
                    <span className="sys-expand-val">{c.image}</span>
                    <span className="sys-expand-key">{i18nT("docker.expand.id")}</span>
                    <span className="sys-expand-val sys-mono">{c.id}</span>
                    <span className="sys-expand-key">{i18nT("docker.expand.status")}</span>
                    <span className="sys-expand-val">{c.status}</span>
                    {c.ports && (<>
                      <span className="sys-expand-key">{i18nT("docker.expand.ports")}</span>
                      <span className="sys-expand-val sys-mono">{c.ports}</span>
                    </>)}
                  </div>
                  <div className="sys-expand-actions">
                    <button className="sys-expand-del-btn" disabled={busy[c.id]}
                      onClick={e => action(e, c, "rm")}>
                      <IcTrash />{i18nT("docker.deleteContainer")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Docker images panel ───────────────────────────────────────────────────────

function DockerImagesPanel({ sessionId }: { sessionId?: string }) {
  const [images,   setImages]   = useState<DockerImage[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [search,   setSearch]   = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy,     setBusy]     = useState<Record<string, boolean>>({});
  const [tick,     setTick]     = useState(0);

  const doRefresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setError(null);
    const load = async () => {
      try {
        const list = await invoke<DockerImage[]>("ssh_docker_image_list", { sessionId });
        if (!cancelled) { setImages(list); setLoading(false); }
      } catch (e) {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [sessionId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    if (!search) return images;
    const q = search.toLowerCase();
    return images.filter(img =>
      img.repository.toLowerCase().includes(q) ||
      img.tag.toLowerCase().includes(q) ||
      img.id.toLowerCase().includes(q)
    );
  }, [images, search]);

  const imageAction = async (e: React.MouseEvent, img: DockerImage, act: string) => {
    e.stopPropagation();
    if (!sessionId) return;
    if (act === "rmi") {
      const label = img.repository !== "<none>" ? `${img.repository}:${img.tag}` : img.id;
      if (!window.confirm(i18nT("docker.confirmDeleteImage", { label }))) return;
    }
    const imageId = img.repository !== "<none>"
      ? `${img.repository}:${img.tag}`
      : img.id;
    setBusy(b => ({ ...b, [img.id]: true }));
    try {
      await invoke("ssh_docker_image_action", { sessionId, imageId, action: act });
      setTimeout(doRefresh, 800);
    } catch { /* ignore */ } finally {
      setBusy(b => ({ ...b, [img.id]: false }));
    }
  };

  const doPrune = async () => {
    if (!sessionId) return;
    if (!window.confirm(i18nT("docker.confirmPrune"))) return;
    try {
      await invoke("ssh_docker_image_action", { sessionId, imageId: "", action: "prune" });
      setTimeout(doRefresh, 800);
    } catch { /* ignore */ }
  };

  return (
    <div className="sys-panel">
      <div className="sys-toolbar">
        <div className="sys-search-wrap">
          <IcSearch />
          <input className="sys-search-input" placeholder={i18nT("docker.search.images")}
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button className="sys-search-clear" onClick={() => setSearch("")}>✕</button>
          )}
        </div>
        <button className="sys-act-btn" onClick={doPrune} data-tooltip={i18nT("docker.prune")}><IcTrash /></button>
        <button className="sys-act-btn" onClick={doRefresh} data-tooltip={i18nT("docker.refresh")}><IcRestart /></button>
      </div>
      <div className="sys-filter-bar">
        <span className="sys-meta-count">{i18nT("docker.count.images", { n: visible.length })}</span>
      </div>
      <div className="sys-list">
        {loading && images.length === 0 && (
          <div className="sys-hint">{i18nT("docker.loading.images")}</div>
        )}
        {error && (
          <SysErrorState kind="docker" error={error} onRetry={doRefresh} />
        )}
        {!loading && !error && images.length === 0 && (
          <div className="sys-hint">{i18nT("docker.empty.images")}</div>
        )}
        {visible.map(img => {
          const isExp       = expanded === img.id;
          const displayName = img.repository !== "<none>"
            ? (img.tag && img.tag !== "<none>" ? `${img.repository}:${img.tag}` : img.repository)
            : img.id;
          return (
            <div key={img.id} className={`sys-row sys-row--docker${isExp ? " sys-row--expanded" : ""}`}
              onClick={() => setExpanded(isExp ? null : img.id)}>
              <div className="sys-row-head">
                <IcLayers />
                <span className="sys-row-name" style={{ marginLeft: 6 }}>{displayName}</span>
                <span className="sys-badge sys-badge--stopped">{img.size}</span>
              </div>
              <div className="sys-row-sub">{img.id} · {img.created}</div>
              {isExp && (
                <div className="sys-expand">
                  <div className="sys-expand-grid">
                    <span className="sys-expand-key">{i18nT("docker.expand.repository")}</span>
                    <span className="sys-expand-val">{img.repository}</span>
                    <span className="sys-expand-key">{i18nT("docker.expand.tag")}</span>
                    <span className="sys-expand-val sys-mono">{img.tag}</span>
                    <span className="sys-expand-key">{i18nT("docker.expand.imageId")}</span>
                    <span className="sys-expand-val sys-mono">{img.id}</span>
                    <span className="sys-expand-key">{i18nT("docker.expand.size")}</span>
                    <span className="sys-expand-val">{img.size}</span>
                    <span className="sys-expand-key">{i18nT("docker.expand.created")}</span>
                    <span className="sys-expand-val">{img.created}</span>
                  </div>
                  <div className="sys-expand-actions">
                    <button className="sys-expand-del-btn" disabled={busy[img.id]}
                      onClick={e => imageAction(e, img, "rmi")}>
                      <IcTrash />{i18nT("docker.deleteImage")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Docker panel (container + image tabs) ─────────────────────────────────────

function DockerPanel({ sessionId }: { sessionId?: string }) {
  const [subTab, setSubTab] = useState<"containers" | "images">("containers");
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="sys-subtab-bar">
        <button className={`sys-subtab-btn${subTab === "containers" ? " active" : ""}`}
          onClick={() => setSubTab("containers")}>{i18nT("docker.subtab.containers")}</button>
        <button className={`sys-subtab-btn${subTab === "images" ? " active" : ""}`}
          onClick={() => setSubTab("images")}>{i18nT("docker.subtab.images")}</button>
      </div>
      {subTab === "containers"
        ? <DockerContainersPanel sessionId={sessionId} />
        : <DockerImagesPanel     sessionId={sessionId} />}
    </div>
  );
}
