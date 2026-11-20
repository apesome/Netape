import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../i18n";
import { pluginSupportedOnPlatform, setInstalledPluginProtocols } from "../protocols";
import { pluginProgressPercent, type PluginManifest, type PluginMarketplace, type PluginEntry, type PluginProgress } from "../plugins";
import { toast } from "./Toast";

export default function PluginSettings() {
  const t = useT();
  const [tab, setTab] = useState<"market" | "installed">("market");
  const [installed, setInstalled] = useState<PluginManifest[]>([]);
  const [market, setMarket] = useState<PluginMarketplace | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<PluginProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [listening, setListening] = useState(false);
  const alive = useRef(true);
  const request = useRef<string | null>(null);
  const generation = useRef(0);

  async function refresh() {
    const sequence = ++generation.current;
    setLoading(true); setLoadError(null);
    const [plugins, catalog] = await Promise.allSettled([
      invoke<PluginManifest[]>("plugins_list"), invoke<PluginMarketplace>("plugins_marketplace"),
    ]);
    if (!alive.current || generation.current !== sequence) return;
    if (plugins.status === "fulfilled") { setInstalled(plugins.value); setInstalledPluginProtocols(plugins.value); }
    else setLoadError(String(plugins.reason));
    if (catalog.status === "fulfilled") {
      setMarket(catalog.value);
      if (!request.current && catalog.value.activeInstall) {
        request.current = catalog.value.activeInstall.requestId; setCurrent(catalog.value.activeInstall);
      }
      if (request.current && !catalog.value.activeInstall) { request.current = null; setCurrent(null); setCancelling(false); }
    } else setLoadError(String(catalog.reason));
    setLoading(false);
  }

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<PluginProgress>("plugins://install-progress", ({ payload }) => {
      if (disposed) return;
      if (!request.current || request.current === payload.requestId) {
        request.current = payload.requestId; setCurrent(payload);
      }
    }).then(stop => { if (disposed) stop(); else { unlisten = stop; setListening(true); } }).catch(error => {
      if (!disposed) setLoadError(String(error));
    });
    void refresh();
    return () => { disposed = true; alive.current = false; generation.current++; unlisten?.(); };
  }, []);

  // Reopening Settings during a download recovers its progress. Poll only that recovered operation until it ends.
  useEffect(() => {
    if (!current || busy) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void invoke<PluginProgress | null>("plugins_install_status").then(status => {
        if (disposed) return;
        if (status) setCurrent(status);
        else { window.clearInterval(timer); request.current = null; setCurrent(null); setCancelling(false); void refresh(); }
      }).catch(() => {});
    }, 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [current?.requestId, busy]);

  async function mutate(action: () => Promise<PluginManifest | void>, success: (value: PluginManifest | void) => string) {
    setBusy(true);
    try { const result = await action(); if (alive.current) toast(success(result), "success"); }
    catch (error) {
      if (alive.current) {
        if (String(error).includes("installation cancelled")) toast(t("plugins.cancelled"), "success");
        else toast(t("plugins.installFailed", { error: String(error) }), "error");
      }
    } finally {
      request.current = null;
      if (alive.current) { setCurrent(null); setCancelling(false); setBusy(false); void refresh(); }
    }
  }

  async function installLocal() {
    try {
      const dir = await open({ directory: true, title: t("plugins.selectDirTitle") });
      if (typeof dir !== "string" || !alive.current) return;
      await mutate(() => invoke<PluginManifest>("plugins_install", { srcDir: dir }), value => t("plugins.installSuccess", { name: value?.name ?? "" }));
    } catch (error) { if (alive.current) toast(t("plugins.installFailed", {error:String(error)}), "error"); }
  }
  async function install(entry: PluginEntry) {
    const requestId = crypto.randomUUID(); request.current = requestId;
    setCurrent({id:entry.id, requestId, phase:"preparing", received:0, total:0});
    await mutate(() => invoke<PluginManifest>("plugins_install_market", { id:entry.id, version:entry.version, source:entry.source, requestId }), () => t("plugins.installSuccess", {name:entry.name}));
  }
  async function cancel() {
    if (!current) return;
    setCancelling(true);
    try { await invoke("plugins_cancel_install", { requestId:current.requestId }); }
    catch (error) { setCancelling(false); toast(String(error), "error"); }
  }
  async function uninstall(entry: PluginManifest) {
    setBusy(true);
    try { await invoke("plugins_uninstall", { id:entry.id }); toast(t("plugins.uninstallSuccess", {name:entry.name}), "success"); }
    catch (error) { toast(t("plugins.uninstallFailed", {error:String(error)}), "error"); }
    finally { if (alive.current) { setBusy(false); void refresh(); } }
  }
  const locked = busy || !!current;
  const visibleInstalled = installed.filter(item => pluginSupportedOnPlatform(item.protocol));
  const entries = market?.entries.filter(item => pluginSupportedOnPlatform(item.protocol)) ?? [];
  const percent = current ? pluginProgressPercent(current) : null;
  return <div className="plugins-panel">
    <div className="plugins-tabs">
      <button className={`plugins-tab${tab === "market" ? " active" : ""}`} onClick={() => setTab("market")}>{t("plugins.market")}</button>
      <button className={`plugins-tab${tab === "installed" ? " active" : ""}`} onClick={() => setTab("installed")}>{t("plugins.installed")}{visibleInstalled.length ? ` (${visibleInstalled.length})` : ""}</button>
      <div className="plugins-toolbar-actions">
        <button className="btn-sm" disabled={loading || locked} onClick={() => void refresh()}>{t("plugins.refresh")}</button>
        <button className="btn-sm" disabled={locked} onClick={() => void installLocal()}>{t("plugins.installLocal")}</button>
      </div>
    </div>
    {tab === "market" && <>
      {loading && <div className="plugins-hint" role="status">{t("plugins.loading")}</div>}
      {market?.fromCache && <div className="plugins-hint">{t("plugins.cached")}</div>}
      {(loadError || market?.warning) && <div className="plugins-notice" role="status">
        <span>{t("plugins.catalogUnavailable")}</span>
        <details><summary>{t("plugins.errorDetails")}</summary><p>{loadError || market?.warning}</p></details>
      </div>}
      {market?.target && <div className="plugins-hint">{t("plugins.target", {target:market.target})}</div>}
      {!entries.length && !loading ? <div className="plugins-empty">{t("plugins.marketEmpty")}</div> : <div className="plugins-list">
        {entries.map(entry => <div className="plugin-card" key={entry.id}>
          <div className="plugin-meta">
            <span className="plugin-name">{entry.name}<span className="plugin-ver">v{entry.version}</span><span className="plugin-source">{t(`plugins.source.${entry.source}`)}</span></span>
            <span className="plugin-sub">{entry.protocol || entry.kind}{entry.author ? ` · ${entry.author}` : ""}</span>
            {entry.description && <span className="plugin-desc">{entry.description}</span>}
            {entry.installedVersion && <span className="plugins-hint">{t("plugins.currentVersion", {version:entry.installedVersion})}</span>}
            {!entry.compatible && <span className="plugins-hint">{t(entry.unavailableReason === "appVersion" ? "plugins.requiresAppUpdate" : "plugins.noPlatform")}</span>}
          </div>
          <button className={`btn-sm${(!entry.installed || entry.updateAvailable) && entry.compatible ? " btn-primary" : ""}`}
            disabled={locked || !listening || !entry.compatible || (entry.installed && !entry.updateAvailable)} onClick={() => void install(entry)}>
            {entry.installed ? t(entry.updateAvailable ? "plugins.update" : "plugins.installedBadge") : t("plugins.install")}
          </button>
        </div>)}
      </div>}
    </>}
    {current && <div className="plugin-download" role="status" aria-live="polite">
      <div className="plugin-download-label"><span>{current.id} · {t(`plugins.phase.${current.phase}`)}{percent !== null ? ` ${percent}%` : ""}</span>
        <button className="btn-sm" disabled={cancelling || current.phase === "installing"} onClick={() => void cancel()}>{t(cancelling ? "plugins.cancelling" : "plugins.cancel")}</button></div>
      {percent !== null && <progress max={100} value={percent} aria-label={t("plugins.phase.downloading")} />}
    </div>}
    {tab === "installed" && (!visibleInstalled.length ? <div className="plugins-empty">{t("plugins.installedEmpty")}</div> : <div className="plugins-list">
      {visibleInstalled.map(entry => <div className="plugin-card" key={entry.id}><div className="plugin-meta">
        <span className="plugin-name">{entry.name}<span className="plugin-ver">v{entry.version}</span></span>
        <span className="plugin-sub">{entry.protocol || entry.kind}{entry.author ? ` · ${entry.author}` : ""}</span>
        {entry.description && <span className="plugin-desc">{entry.description}</span>}
      </div><button className="btn-sm" disabled={locked} onClick={() => void uninstall(entry)}>{t("plugins.uninstall")}</button></div>)}
    </div>)}
  </div>;
}
