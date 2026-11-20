import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

const KEY = "terminal.recentHosts";
const LIMIT = 100;
let recent: string[] = [];
let touched: string[] = [];
let loading: Promise<void> | null = null;
let ready = false;
let writes = Promise.resolve();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => recent;
const merge = (first: string[], second: string[]) => [...new Set([...first, ...second])].slice(0, LIMIT);

function persist() {
  const value = JSON.stringify(recent);
  writes = writes.then(() => invoke<void>("settings_set", { key: KEY, value })).catch(error => {
    console.error("Could not save recent hosts", error);
  });
}
export function loadRecentHosts() {
  if (loading) return loading;
  loading = invoke<string | null>("settings_get", { key: KEY }).then(raw => {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const stored = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    recent = merge(touched, stored);
  }).catch(() => { /* Keep this session's history if older settings are unreadable. */ }).then(() => {
    ready = true;
    notify();
    if (touched.length) persist();
  });
  return loading;
}
export function recordRecentHost(id: string) {
  if (!id) return;
  touched = merge([id], touched);
  recent = merge([id], recent);
  notify();
  if (ready) persist(); else void loadRecentHosts();
}
export function useRecentHosts() {
  useEffect(() => { void loadRecentHosts(); }, []);
  return useSyncExternalStore(subscribe, snapshot);
}
