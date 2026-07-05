import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "tree.expanded";
export const ROOT_ID = "__root__";

// ── Singleton expanded state (shared across all tree components) ──────────────
let _expanded: Set<string> = new Set([ROOT_ID]);
const _listeners = new Set<() => void>();

function _notify() { _listeners.forEach(fn => fn()); }

function _persist(s: Set<string>) {
  invoke("settings_set", { key: STORAGE_KEY, value: JSON.stringify([...s]) }).catch(() => {});
}

/** Called once on app startup to restore expanded state from DB. */
export async function loadTreeExpanded(): Promise<void> {
  try {
    const raw = await invoke<string | null>("settings_get", { key: STORAGE_KEY });
    if (raw) {
      _expanded = new Set(JSON.parse(raw) as string[]);
      _notify();
    }
  } catch { /**/ }
}

export function getTreeExpanded(): Set<string> {
  return _expanded;
}

export function setTreeExpanded(next: Set<string>): void {
  _expanded = next;
  _persist(next);
  _notify();
}

export function toggleExpanded(id: string): void {
  const next = new Set(_expanded);
  next.has(id) ? next.delete(id) : next.add(id);
  setTreeExpanded(next);
}

/** React hook — returns a reactive snapshot of the shared expanded set. */
export function useTreeExpanded(): Set<string> {
  const [snapshot, setSnapshot] = useState<Set<string>>(_expanded);
  useEffect(() => {
    // Sync if store changed while component was unmounted
    if (_expanded !== snapshot) setSnapshot(_expanded);
    const listener = () => setSnapshot(_expanded);
    _listeners.add(listener);
    return () => { _listeners.delete(listener); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return snapshot;
}
