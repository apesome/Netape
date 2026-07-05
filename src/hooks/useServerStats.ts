import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ── Raw data from Rust (cumulative counters) ──────────────────────────────────
export interface DiskStat { mount: string; used: number; total: number; pct: number; }
interface RawNetIface { name: string; rx: number; tx: number; }
export interface ProcessInfo { pid: string; memPct: number; cmd: string; }
interface RawServerStats {
  cpuCores:   number;
  cpuTotal:   number;
  cpuIdle:    number;
  cpuPct:     number;
  cpuPerCore: [number, number][];
  memTotal:   number;
  memFree:    number;
  memBuffers: number;
  memCached:  number;
  swapTotal:  number;
  swapFree:   number;
  disks:      DiskStat[];
  netIfaces:  RawNetIface[];
  topProcs:   ProcessInfo[];
  ts:         number;
}

// ── Computed stats exposed to the UI ──────────────────────────────────────────
export interface NetIfaceStat { name: string; rxSpeed: number; txSpeed: number; }
export interface ServerStats {
  cpu:        number;
  cpuCores:   number;
  cpuPerCore: number[];
  memTotal:   number;
  memUsed:    number;
  memFree:    number;
  memBuffers: number;
  memCached:  number;
  swapTotal:  number;
  swapUsed:   number;
  disks:      DiskStat[];
  netRx:      number;
  netTx:      number;
  netIfaces:  NetIfaceStat[];
  topProcs:   ProcessInfo[];
  latency:    number;
}


function computeStats(
  cur:     RawServerStats,
  prev:    RawServerStats | null,
  latency: number,
): ServerStats {
  let cpu = cur.cpuPct;
  let cpuPerCore: number[] = [];

  if (cur.cpuTotal > 0 && prev) {
    const dt = cur.cpuTotal - prev.cpuTotal;
    const di = cur.cpuIdle  - prev.cpuIdle;
    if (dt > 0) cpu = Math.max(0, Math.min(100, 100 - (di / dt * 100)));
    cpuPerCore = cur.cpuPerCore.map(([total, idle], i) => {
      const p = prev.cpuPerCore[i];
      if (!p) return 0;
      const dt2 = total - p[0];
      if (dt2 <= 0) return 0;
      return Math.max(0, Math.min(100, 100 - ((idle - p[1]) / dt2 * 100)));
    });
  } else if (cur.cpuPerCore.length === 0) {
    cpuPerCore = Array<number>(cur.cpuCores).fill(cpu);
  }

  const memUsed = Math.max(0, cur.memTotal - cur.memFree - cur.memBuffers - cur.memCached);
  const dtSec   = prev ? Math.max(0.5, (cur.ts - prev.ts) / 1000) : 1;

  let netRx = 0, netTx = 0;
  const netIfaces: NetIfaceStat[] = cur.netIfaces.map((iface) => {
    const p = prev?.netIfaces.find((x) => x.name === iface.name);
    const rxSpeed = p && iface.rx >= p.rx ? (iface.rx - p.rx) / dtSec : 0;
    const txSpeed = p && iface.tx >= p.tx ? (iface.tx - p.tx) / dtSec : 0;
    netRx += rxSpeed; netTx += txSpeed;
    return { name: iface.name, rxSpeed, txSpeed };
  });

  return {
    cpu: Math.round(cpu), cpuCores: cur.cpuCores, cpuPerCore,
    memTotal: cur.memTotal, memUsed, memFree: cur.memFree,
    memBuffers: cur.memBuffers, memCached: cur.memCached,
    swapTotal: cur.swapTotal, swapUsed: Math.max(0, cur.swapTotal - cur.swapFree),
    disks: cur.disks, netRx, netTx, netIfaces,
    topProcs: cur.topProcs ?? [],
    latency,
  };
}

export function useServerStats(
  sessionId:  string | undefined,
  enabled  = true,
  intervalMs = 5000,
): ServerStats | null {
  const [stats,    setStats]   = useState<ServerStats | null>(null);
  const prevRef   = useRef<RawServerStats | null>(null);
  const errorsRef = useRef(0);

  useEffect(() => {
    prevRef.current   = null;
    errorsRef.current = 0;
    setStats(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let cancelled = false;

    const poll = async () => {
      if (errorsRef.current >= 3) return;
      try {
        const [rawResult, pingResult] = await Promise.allSettled([
          invoke<RawServerStats>("ssh_server_stats", { sessionId }),
          (async () => {
            const t0 = performance.now();
            await invoke("ssh_ping", { sessionId });
            return Math.round(performance.now() - t0);
          })(),
        ]);
        if (cancelled) return;
        if (rawResult.status === "fulfilled") {
          const latency = pingResult.status === "fulfilled" ? pingResult.value : -1;
          setStats(computeStats(rawResult.value, prevRef.current, latency));
          prevRef.current   = rawResult.value;
          errorsRef.current = 0;
        } else {
          errorsRef.current++;
        }
      } catch {
        if (!cancelled) errorsRef.current++;
      }
    };

    const init = setTimeout(poll, 1200);
    const tick = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearTimeout(init); clearInterval(tick); };
  }, [sessionId, enabled, intervalMs]);

  return stats;
}
