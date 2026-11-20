import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AiConfig, AiProfile } from "../ai";
import { effectiveAiSystemPrompt, isAutomaticAiSystemPrompt } from "../aiSystemPrompt";
import { AI_PROVIDERS, identifyAiProvider, normalizeAiBase, aiSourceIdentity, editionEndpoint, aiProtocolLabel, type AiCatalog, type AiProbe } from "../aiProviders";
import { getLang, useT } from "../i18n";
import { toast } from "./Toast";
import CustomSelect from "./CustomSelect";
import AiUsage from "./AiUsage";
import AiModelPicker from "./AiModelPicker";
import { AiIcon, aiLabel as l } from "./AiCommon";
import { AiProviderMark, AiSettingsConfirm, AiSettingsPage } from "./AiSettingsUi";

function friendlyError(error: string) {
  const labels: Record<string, [string, string]> = {
    AI_INVALID_URL: ["请输入不含凭据、查询参数的 HTTP(S) 接口地址", "Enter an HTTP(S) API URL without credentials or query parameters"],
    AI_KEY_REJECTED: ["密钥未通过验证，请检查密钥或访问权限", "API key rejected; check credentials and endpoint permissions"],
    AI_ENDPOINT_UNSUPPORTED: ["该地址不支持此接口；可手动填写模型 ID 后测试响应", "Endpoint not supported; enter a model ID manually and test the response"],
    AI_MODELS_UNSUPPORTED: ["服务未提供兼容的模型列表，可手动输入模型 ID", "No compatible model list; enter a model ID manually"],
    AI_RATE_LIMITED: ["请求过于频繁，请稍后重试", "Rate limited; try again later"],
    AI_CONNECTION_FAILED: ["连接失败或超时，请检查地址及网络", "Connection failed or timed out; check endpoint and network"],
    AI_MODEL_REQUIRED: ["请先填写模型 ID", "Enter a model ID first"],
    AI_MODEL_NO_TEXT: ["接口已响应，但模型未返回文本", "The API responded but the model returned no text"],
    AI_INVALID_RESPONSE: ["接口返回的数据格式不兼容", "The API response format is incompatible"],
    AI_INVALID_KEY: ["密钥格式无效", "Invalid API key format"],
    AI_CATALOG_PAGE_LIMIT: ["模型列表分页超出限制，请手动填写模型 ID", "Model list pagination limit reached; enter the model ID manually"],
  };
  return labels[error] ? l(...labels[error]) : error.startsWith("AI_HTTP_") ? `HTTP ${error.slice(8)}` : error;
}
const probeId = (source: string, mode: "connection" | "model", model: string) => JSON.stringify([source, mode, mode === "model" ? model : ""]);
const sourceHost = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const RefreshIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg>;
const EditIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m14 5 5 5M4 20l1-6L16 3a2 2 0 0 1 5 5L10 19l-6 1Z"/></svg>;

export default function AiSettings() {
  useT();
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [section, setSection] = useState<"models" | "preferences">("models");
  const [profile, setProfile] = useState<AiProfile | null>(null), [key, setKey] = useState<string | undefined>();
  const [presetId, setPresetId] = useState("custom");
  const [showKey, setShowKey] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ kind: "remove"; profile: AiProfile } | { kind: "history" } | null>(null);
  const [catalog, setCatalog] = useState<{ source: string; value: AiCatalog } | null>(null);
  const [catalogError, setCatalogError] = useState<{ source: string; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null), [testing, setTesting] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, AiProbe>>({});
  const editorFields = useRef<HTMLFieldSetElement>(null);
  const saved = useRef<AiConfig | null>(null), revision = useRef(0), probeRevision = useRef(0), mounted = useRef(true);
  const source = profile ? aiSourceIdentity(profile.id, profile.baseUrl, key, profile.protocol) : "";
  const latest = useRef({ source, model: profile?.model ?? "" }); latest.current = { source, model: profile?.model ?? "" };
  const draft = profile ? { profileId: profile.id, baseUrl: profile.baseUrl, model: profile.model, protocol: profile.protocol ?? "openai", apiKey: key ?? null } : null;
  const validBase = profile ? normalizeAiBase(profile.baseUrl) : null;
  const previous = profile ? saved.current?.profiles.find(p => p.id === profile.id) : undefined;
  const endpointChanged = !!(profile && previous && (normalizeAiBase(previous.baseUrl) !== validBase || (previous.protocol ?? "openai") !== (profile.protocol ?? "openai")));
  const keyNeedsReview = endpointChanged && !!previous?.hasKey && key === undefined;

  useEffect(() => {
    mounted.current = true;
    void invoke<AiConfig>("ai_config_get").then(value => { if (mounted.current) { saved.current = value; setConfig(value); } }).catch(e => setError(String(e)));
    return () => { mounted.current = false; revision.current++; probeRevision.current++; };
  }, []);
  const refresh = async () => {
    if (!draft || !validBase || busy || keyNeedsReview) return;
    const attempt = ++revision.current, captured = source;
    setRefreshing(captured); setCatalogError(null);
    try {
      const value = await invoke<AiCatalog>("ai_catalog_refresh", { draft });
      if (mounted.current && attempt === revision.current && latest.current.source === captured) setCatalog({ source: captured, value });
    } catch (e) {
      if (mounted.current && attempt === revision.current && latest.current.source === captured) setCatalogError({ source: captured, text: friendlyError(String(e)) });
    } finally { if (mounted.current && attempt === revision.current) setRefreshing(null); }
  };
  useEffect(() => {
    const attempt = ++revision.current;
    setRefreshing(null); setTesting(null); probeRevision.current++;
    if (!draft || !validBase || keyNeedsReview) return;
    void invoke<AiCatalog | null>("ai_catalog_cached", { draft }).then(value => {
      if (value && mounted.current && attempt === revision.current && latest.current.source === source) setCatalog({ source, value });
    }).catch(() => {});
    const isNew = !saved.current?.profiles.some(p => p.id === profile?.id);
    const local = validBase.startsWith("http://localhost:") || validBase.startsWith("http://127.0.0.1:");
    const timer = isNew && (local || !!key) ? setTimeout(() => { void refresh(); }, 800) : undefined;
    return () => { clearTimeout(timer); revision.current++; };
  }, [source]);

  // Saving a service never silently saves pending collaboration preference edits.
  const persist = async (next: AiConfig, keys: Record<string, string> = {}, preservePreferences = false) => {
    if (next.profiles.some(p => !normalizeAiBase(p.baseUrl))) throw Error(l("请检查接口地址", "Check API base URLs"));
    await invoke("ai_config_save", { config: { ...next, profiles: next.profiles.map(p => ({ ...p, baseUrl: normalizeAiBase(p.baseUrl)! })) }, keys });
    const value = await invoke<AiConfig>("ai_config_get"); saved.current = value;
    if (!mounted.current) return;
    setConfig(current => preservePreferences && current ? { ...current, profiles: value.profiles, activeProfile: value.activeProfile } : value);
    window.dispatchEvent(new Event("netape-ai-config"));
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { if (mounted.current) setError(friendlyError(String(e))); }
    finally { if (mounted.current) setBusy(false); }
  };
  const test = async (mode: "connection" | "model", target = profile) => {
    if (!target || !normalizeAiBase(target.baseUrl) || testing || busy || (target.id === profile?.id && keyNeedsReview)) return;
    const credential = target.id === profile?.id ? key : undefined;
    const captured = aiSourceIdentity(target.id, target.baseUrl, credential, target.protocol), model = target.model;
    const identity = probeId(captured, mode, model), attempt = ++probeRevision.current;
    setTesting(identity);
    const targetDraft = { profileId: target.id, baseUrl: target.baseUrl, model, protocol: target.protocol ?? "openai", apiKey: credential ?? null };
    const stillCurrent = () => mounted.current && attempt === probeRevision.current && (!profile || (latest.current.source === captured && (mode === "connection" || latest.current.model === model)));
    try {
      const value = await invoke<AiProbe>("ai_probe", { draft: targetDraft, mode });
      if (stillCurrent()) setProbes(old => ({ ...old, [identity]: value }));
    } catch (e) {
      if (stillCurrent()) setProbes(old => ({ ...old, [identity]: { success: false, mode, latencyMs: 0, checkedAt: Date.now(), error: String(e) } }));
    } finally { if (mounted.current && attempt === probeRevision.current) setTesting(null); }
  };
  const closeEditor = () => { if (!busy) { setProfile(null); setKey(undefined); setError(""); setShowKey(false); } };
  const openEditor = (target: AiProfile) => {
    setError(""); setKey(undefined); setShowKey(false); setPresetId(identifyAiProvider(target.baseUrl, target.protocol, target.providerId).provider);
    setProfile({ ...target }); setProviderSearch("");
  };
  const addProvider = (id: string) => {
    const provider = AI_PROVIDERS.find(p => p.id === id);
    const selected = provider?.editions[0];
    openEditor({ id: crypto.randomUUID(), name: provider?.name ?? l("自定义服务", "Custom API"), baseUrl: selected?.baseUrl ?? "", model: selected?.models?.[0] ?? "", hasKey: false, protocol: selected?.protocol ?? "openai", providerId: id, editionId: selected?.id });
    setPresetId(id);
  };
  const selectProvider = (id: string) => {
    if (id === "custom") {
      setPresetId(id);
      editProfile({ name: l("自定义服务", "Custom API"), baseUrl: "", model: "", protocol: "openai", hasKey: false, providerId: "custom", editionId: undefined });
      setKey(previous?.hasKey ? "" : undefined); setShowKey(false); setCatalog(null); setCatalogError(null); setError("");
      revision.current++; probeRevision.current++; setRefreshing(null); setTesting(null);
      editorFields.current?.scrollTo({ top: 0 });
      return;
    }
    const next = AI_PROVIDERS.find(item => item.id === id), selected = next?.editions[0];
    if (!next || !selected || !profile) return;
    editProfile({ name: next.name, baseUrl: editionEndpoint(selected, selected.protocol ?? "openai"), protocol: selected.protocol ?? "openai", providerId: next.id, editionId: selected.id, model: selected.models?.[0] ?? "" });
    setPresetId(id); setKey(undefined); setShowKey(false); setCatalog(null); setCatalogError(null);
  };
  const update = (next: Partial<AiConfig>) => { setConfig(current => current ? { ...current, ...next } : current); setDirty(true); };
  const editProfile = (next: Partial<AiProfile>) => setProfile(current => current ? { ...current, ...next } : current);
  const saveService = () => void action(async () => {
    if (!profile || !saved.current) return;
    if (!profile.name.trim()) throw Error(l("请填写显示名称", "Enter a display name"));
    if (keyNeedsReview) throw Error(l("接口已变化，请更新或清除密钥", "Endpoint changed; update or clear the key"));
    const exists = saved.current.profiles.some(p => p.id === profile.id);
    const edited = { ...profile, name: profile.name.trim(), model: profile.model.trim() };
    await persist({ ...saved.current, profiles: exists ? saved.current.profiles.map(p => p.id === profile.id ? edited : p) : [...saved.current.profiles, edited], activeProfile: saved.current.activeProfile || profile.id }, key === undefined ? {} : { [profile.id]: key }, true);
    const savedSource = aiSourceIdentity(profile.id, profile.baseUrl, undefined, profile.protocol);
    setProbes(old => {
      const next = { ...old };
      for (const mode of ["connection", "model"] as const) { const identity = probeId(source, mode, profile.model), value = old[identity]; delete next[identity]; if (value) next[probeId(savedSource, mode, edited.model)] = value; }
      return next;
    });
    setProfile(null); setKey(undefined); setShowKey(false); toast(l("模型服务已保存", "Model service saved"), "success");
  });

  if (!config) return <div className="ai-settings">{error ? <p role="alert" className="ai-error">{error}</p> : <div className="ai-studio-loading">{l("正在读取 AI 配置…", "Loading AI settings…")}</div>}</div>;
  const provider = AI_PROVIDERS.find(p => p.id === presetId), detected = identifyAiProvider(profile?.baseUrl ?? "", profile?.protocol, profile?.providerId);
  const edition = provider?.editions.find(e => e.id === (profile?.editionId ?? detected.edition)) ?? provider?.editions[0];
  const models = [...new Set([...(catalog?.source === source ? catalog.value.models : []), ...(edition?.models ?? [])])];
  const isNew = !!profile && !saved.current?.profiles.some(p => p.id === profile.id);
  const result = (mode: "connection" | "model") => probes[probeId(source, mode, profile?.model ?? "")];
  const ConfirmationView = confirmation?.kind === "remove" ? AiSettingsConfirm : AiSettingsPage;

  return <div className={`ai-settings ai-settings--studio${profile ? " ai-settings--editing" : confirmation?.kind !== "history" ? " ai-settings--overview" : ""}`}>
    {!profile && confirmation?.kind !== "history" && <>
    <div className="ai-studio-tabs" role="tablist" aria-label={l("AI 设置", "AI settings")}>
      {(["models", "preferences"] as const).map(id => <button key={id} type="button" role="tab" id={`ai-tab-${id}`} aria-controls={`ai-section-${id}`} aria-selected={section === id} tabIndex={section === id ? 0 : -1} onClick={() => setSection(id)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "models" : event.key === "End" ? "preferences" : section === "models" ? "preferences" : "models"; setSection(next); document.getElementById(`ai-tab-${next}`)?.focus(); } }}>
        {id === "models" ? l("模型服务", "Model services") : l("协作偏好", "Collaboration")}{id === "models" && <span>{config.profiles.length}</span>}{id === "preferences" && dirty && <i className="ai-unsaved-dot"/>}
      </button>)}
    </div>
    {section === "models" ? <section id="ai-section-models" role="tabpanel" aria-labelledby="ai-tab-models">
      <div className="ai-studio-section-head"><h4>{l("我的模型", "Your models")}</h4><button type="button" className="btn-sm ai-studio-add" onClick={() => { setError(""); addProvider("custom"); }} disabled={busy || !!testing || config.profiles.length >= 20}>＋ {l("添加模型", "Add model")}</button></div>
      <div className="ai-service-grid">
        {config.profiles.map(item => {
          const brand = identifyAiProvider(item.baseUrl, item.protocol, item.providerId).provider;
          return <article className="ai-service-card" key={item.id}>
            <header><AiProviderMark provider={brand} small/><div className="ai-service-name"><h4 data-tooltip={item.name}>{item.name}</h4><span>{brand === "custom" ? l("自定义服务", "Custom API") : AI_PROVIDERS.find(p => p.id === brand)?.name}</span></div></header>
            <div className={`ai-service-model${!item.model ? " ai-service-model--empty" : ""}`} data-tooltip={item.model}>{item.model || l("在AI 助手 中选择模型", "Select a model in AI assistant")}</div>
            <div className="ai-service-source" data-tooltip={item.baseUrl}><span aria-hidden="true">↗</span>{sourceHost(item.baseUrl)}</div>
            <div className="ai-service-status">
              <AiUsage profile={item} visible={true} refreshSignal={false}/>
            </div>
            <footer><div><button type="button" className="ai-studio-icon-button" disabled={busy || !!testing} onClick={() => openEditor(item)} aria-label={l(`编辑 ${item.name}`, `Edit ${item.name}`)} data-tooltip={l("编辑模型服务", "Edit model service")}><EditIcon/></button><button type="button" className="ai-studio-icon-button ai-service-remove" disabled={busy || !!testing} onClick={() => { setError(""); setConfirmation({ kind: "remove", profile: item }); }} aria-label={l(`移除 ${item.name}`, `Remove ${item.name}`)} data-tooltip={l("移除模型服务", "Remove model service")}>×</button></div></footer>
          </article>;
        })}
        <button type="button" className="ai-service-add-card" disabled={busy || !!testing || config.profiles.length >= 20} onClick={() => { setError(""); addProvider("custom"); }}><span aria-hidden="true">＋</span><strong>{l("添加模型", "Add model")}</strong></button>
      </div>
    </section> : <section id="ai-section-preferences" role="tabpanel" aria-labelledby="ai-tab-preferences">
      <div className="ai-studio-section-head"><div><h4>{l("让 AI 按你的习惯协作", "Work the way you do")}</h4><p>{l("这些偏好适用于所有模型服务。", "These preferences apply to every model service.")}</p></div></div>
      <fieldset disabled={busy} className="ai-preferences-fields">
        <div className="ai-preference-group"><h4>{l("终端协作", "Terminal collaboration")}</h4><label>{l("协作权限", "Permissions")}<CustomSelect id="ai-terminal-permission" value={config.permission} onChange={value => update({ permission: value as AiConfig["permission"] })} options={[
          { value: "suggest", label: l("仅提供建议和复制", "Suggestions and copy only") }, { value: "paste", label: l("允许填入终端，不自动回车", "Allow paste without Enter") }, { value: "confirm", label: l("允许逐次确认后执行", "Allow execution after each approval") },
        ]}/></label><label className="ai-checkbox"><input type="checkbox" checked={config.attachOutput} onChange={event => update({ attachOutput: event.target.checked })}/><span>{l("默认附带最近终端输出", "Include recent terminal output by default")}</span></label><label className="ai-checkbox"><input type="checkbox" checked={config.attachHost} onChange={event => update({ attachHost: event.target.checked })}/><span>{l("附带主机名、协议和当前目录", "Include host, protocol and current directory")}</span></label><p className="ai-muted">{l("不附带连接凭据。发送前仍需检查终端输出中的敏感内容。", "Connection credentials are excluded. Review terminal output for sensitive content before sharing.")}</p></div>
        <div className="ai-preference-group"><h4>{l("提示词与生成参数", "Instructions and generation")}</h4><label htmlFor="ai-system-prompt"><span className="ai-prompt-label">{l("系统提示词", "System prompt")}<small>{isAutomaticAiSystemPrompt(config.systemPrompt) ? l("跟随界面语言", "Follows app language") : l("自定义", "Custom")}</small></span><textarea id="ai-system-prompt" className="hf-ctrl" rows={5} value={effectiveAiSystemPrompt(config.systemPrompt, getLang())} onChange={event => update({ systemPrompt: event.target.value })}/><small className="ai-muted">{l("默认随界面语言自动更新；手动编辑后保留你的内容。提示词影响回答方式，实际执行权限由上方的协作权限控制。", "The default follows the app language. Manual edits are kept as custom instructions. They guide replies; execution permissions are controlled above.")}</small></label>{!isAutomaticAiSystemPrompt(config.systemPrompt) && <button type="button" className="ai-prompt-reset" onClick={() => update({ systemPrompt: "" })}>{l("恢复自动提示词", "Restore automatic instructions")}</button>}<div className="ai-settings-numbers">
          <label>{l("最大输出 Token", "Max output tokens")}<input className="sctl-font-size" type="number" min={128} max={32768} value={config.maxTokens} onChange={event => update({ maxTokens: Number(event.target.value) })}/></label><label>{l("超时（秒）", "Timeout (seconds)")}<input className="sctl-font-size" type="number" min={10} max={600} value={config.timeoutSecs} onChange={event => update({ timeoutSecs: Number(event.target.value) })}/></label><label>{l("上下文行数", "Context lines")}<input className="sctl-font-size" type="number" min={10} max={2000} value={config.contextLines} onChange={event => update({ contextLines: Number(event.target.value) })}/></label>
        </div></div>
        <div className="ai-preference-group"><h4>{l("本地记录", "Local history")}</h4><label className="ai-checkbox"><input type="checkbox" checked={config.saveHistory} onChange={event => update({ saveHistory: event.target.checked })}/><span>{l("在本机保存聊天记录", "Save chat history on this computer")}</span></label><div className="ai-history-setting"><p className="ai-muted">{l("清空后无法恢复，已配置的模型服务会保留。", "Clearing history cannot be undone. Model services are kept.")}</p><button type="button" onClick={() => { setError(""); setConfirmation({ kind: "history" }); }}>{l("清空记录", "Clear history")}</button></div></div>
      </fieldset>
      <div className="ai-preferences-footer"><span>{dirty ? l("有未保存的偏好更改", "Unsaved preference changes") : ""}</span><button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => void action(async () => { await persist(config); setDirty(false); toast(l("协作偏好已保存", "Preferences saved"), "success"); })}>{busy ? l("保存中…", "Saving…") : l("保存偏好", "Save preferences")}</button></div>
    </section>}
    {error && !profile && !confirmation && <p role="alert" className="ai-error">{error}</p>}
    </>}

    {profile && <AiSettingsPage title={isNew ? l("连接模型服务", "Connect model service") : l("编辑模型服务", "Edit model service")} onClose={closeEditor} busy={busy} footer={<><span className="ai-editor-footer-note">{l("密钥安全存储在本机", "Keys stored securely on this device")}</span><button type="button" disabled={busy} onClick={closeEditor}>{l("取消", "Cancel")}</button><button type="button" className="btn-primary" disabled={busy || !validBase || !profile.name.trim() || keyNeedsReview} onClick={saveService}>{busy ? l("保存中…", "Saving…") : l("保存服务", "Save service")}</button></>}>
      <div className="ai-editor-split">
        <aside className="ai-provider-rail" aria-label={l("模型供应商", "Model providers")}>
          <div className="ai-provider-rail-head"><strong>{l("模型供应商", "Providers")}</strong><span>{AI_PROVIDERS.length}</span></div>
          <input className="hf-ctrl ai-provider-search" aria-label={l("搜索供应商", "Search providers")} placeholder={l("搜索供应商…", "Search providers…")} value={providerSearch} onChange={event => setProviderSearch(event.target.value)}/><div className="ai-provider-rail-list">{AI_PROVIDERS.filter(item => item.name.toLowerCase().includes(providerSearch.toLowerCase()) || item.id.includes(providerSearch.toLowerCase())).map(item => <button type="button" key={item.id} className={presetId === item.id ? "is-active" : ""} onClick={() => selectProvider(item.id)} disabled={busy}><AiProviderMark provider={item.id} small/><span>{item.name}</span></button>)}</div>
          <button type="button" className={`ai-provider-rail-custom${presetId === "custom" ? " is-active" : ""}`} onClick={() => selectProvider("custom")} disabled={busy}><AiProviderMark provider="custom" small/><span>{l("自定义服务", "Custom API")}</span></button>
        </aside>
        <div className="ai-editor-column">
        <div className="ai-editor-provider">
          <div className="ai-editor-provider-identity"><AiProviderMark provider={presetId}/><div><strong>{provider?.name ?? l("自定义兼容服务", "Custom compatible API")}</strong><span>{aiProtocolLabel(profile.protocol)}</span></div></div>

        </div>
        <fieldset ref={editorFields} disabled={busy} className="ai-editor-fields">
        <div className="ai-editor-top-fields"><label htmlFor="ai-service-name">{l("显示名称", "Display name")}<input id="ai-service-name" data-initial-focus className="hf-ctrl" maxLength={100} value={profile.name} onChange={event => editProfile({ name: event.target.value })}/></label>{provider && provider.editions.length > 1 && <label htmlFor="ai-provider-edition">{l("区域 / 版本", "Region / edition")}<CustomSelect id="ai-provider-edition" value={profile.editionId ?? edition?.id ?? ""} onChange={id => { const next = provider.editions.find(item => item.id === id)!; setKey(undefined); editProfile({ baseUrl: editionEndpoint(next, next.protocol ?? "openai"), protocol: next.protocol ?? "openai", editionId: next.id, model: next.models?.[0] ?? profile.model }); setCatalog(null); }} options={provider.editions.map(item => ({ value: item.id, label: item.name }))}/></label>}</div>
        {provider?.note && <p className="ai-config-warning">{l(provider.note, "Meta Llama uses OpenRouter. Supply an OpenRouter API key and select or enter a Llama model ID.")}</p>}
        <label htmlFor="ai-protocol">{l("接口协议", "API protocol")}<CustomSelect id="ai-protocol" value={profile.protocol ?? "openai"} onChange={value => { const protocol = value as "openai" | "anthropic"; setKey(undefined); editProfile({ protocol, ...(edition ? { baseUrl: editionEndpoint(edition, protocol) } : {}) }); }} options={(provider ? [{value:"openai",label:"OpenAI compatible"}, ...(edition?.anthropicUrl ? [{value:"anthropic",label:"Anthropic Messages"}] : [])].filter(option => presetId !== "anthropic" || option.value === "anthropic") : [{value:"openai",label:"OpenAI compatible"},{value:"anthropic",label:"Anthropic Messages"}])}/></label>
        <label htmlFor="ai-base-url">{l("API 接口地址", "API base URL")}<input id="ai-base-url" className="hf-ctrl" placeholder="https://api.openai.com/v1" value={profile.baseUrl} onChange={event => { setPresetId("custom"); editProfile({ baseUrl: event.target.value, providerId: "custom", editionId: undefined }); }}/></label>
        {!validBase && !!profile.baseUrl.trim() && <p role="alert" className="ai-error">{friendlyError("AI_INVALID_URL")}</p>}
        <label htmlFor="ai-api-key">API Key<div className="ai-key-input"><input id="ai-api-key" className="hf-ctrl" type={showKey ? "text" : "password"} autoComplete="new-password" value={key ?? ""} placeholder={profile.hasKey && !endpointChanged ? l("已安全保存；不修改则保留", "Saved securely; leave unchanged to keep") : l("输入密钥；本地服务可留空", "Enter a key; optional for local services")} onChange={event => setKey(event.target.value)}/><button type="button" className="ai-studio-icon-button" aria-label={showKey ? l("隐藏密钥", "Hide key") : l("显示密钥", "Show key")} onClick={() => setShowKey(value => !value)}>{showKey ? "◉" : "◎"}</button></div></label>
        <div className="ai-key-status"><span className="ai-muted">{key !== undefined ? key ? l("新密钥将在保存后生效", "New key takes effect after saving") : l("保存后移除原密钥", "Stored key will be removed on save") : profile.hasKey ? l("密钥保存在系统凭据库", "Key stored in the system vault") : l("密钥不会显示在模型卡片中", "Keys are never shown on model cards")}</span><button type="button" onClick={() => setKey("")}>{l("清除密钥", "Clear key")}</button></div>
        {keyNeedsReview && <p className="ai-config-warning">{l("接口地址已变化。原密钥不会发送到新地址；请填写新密钥，或清除密钥后保存。", "Endpoint changed. The old key will not be sent to it. Enter a new key or clear the stored key before saving.")}</p>}
        <div className="ai-model-field"><label htmlFor="ai-model-id">{l("默认模型 ID（选填）", "Default model ID (optional)")}</label><AiModelPicker key={profile.id} value={profile.model} models={models} onChange={model => editProfile({ model })} onRefresh={() => void refresh()} refreshing={refreshing === source} disabled={busy || keyNeedsReview}/></div>
        <p className="ai-muted">{l("可留空，保存服务后在AI 助手 中选择本次使用的模型。", "Leave blank to choose a model in AI assistant after saving this service.")}</p>
        <div className="ai-catalog-status" role="status">{refreshing === source ? l("正在获取模型列表…", "Fetching models…") : catalog?.source === source ? l(`${models.length} 个模型 · ${catalog.value.cached ? "缓存" : "已刷新"} ${new Date(catalog.value.fetchedAt).toLocaleTimeString()}`, `${models.length} models · ${catalog.value.cached ? "cached" : "refreshed"} ${new Date(catalog.value.fetchedAt).toLocaleTimeString()}`) : l("可直接输入模型 ID，或点击右侧刷新。", "Type a model ID, or refresh using the button inside the field.")}</div>
        {catalogError?.source === source && <p role="alert" className="ai-config-warning">{catalogError.text}</p>}
        <div className="ai-editor-testing"><div className="ai-probe-actions"><button type="button" disabled={busy || !!testing || !validBase || keyNeedsReview} onClick={() => void test("connection")}><RefreshIcon/>{testing === probeId(source, "connection", profile.model) ? l("测试中…", "Testing…") : l("测试连通性", "Test connection")}</button><button type="button" disabled={busy || !!testing || !validBase || !profile.model.trim() || keyNeedsReview} onClick={() => void test("model")}><AiIcon/>{testing === probeId(source, "model", profile.model) ? l("测试中…", "Testing…") : l("测试模型响应", "Test response")}</button></div>
          <div className="ai-probe-results" aria-live="polite">{(["connection", "model"] as const).map(mode => { const value = result(mode); return value && <div key={mode} className={value.success ? "ai-probe-success" : "ai-config-warning"}><strong>{mode === "connection" ? l("连通性", "Connection") : l("模型响应", "Response")} · {value.success ? l("通过", "Passed") : l("失败", "Failed")}</strong><span>{value.latencyMs} ms</span>{value.error && <p>{friendlyError(value.error)}</p>}</div>; })}</div><p className="ai-muted">{l("连通性测试检查模型列表接口；模型响应测试会发送短消息，可能产生少量用量。", "Connection checks model discovery; response testing sends a short message and may incur usage.")}</p>
        </div>
        </fieldset>
        </div>
      </div>{error && <p role="alert" className="ai-error">{error}</p>}
    </AiSettingsPage>}

    {confirmation && <ConfirmationView title={confirmation.kind === "remove" ? l("移除模型服务", "Remove model service") : l("清空聊天记录", "Clear chat history")} onClose={() => { if (!busy) { setConfirmation(null); setError(""); } }} busy={busy} footer={<><button type="button" autoFocus={confirmation.kind === "remove"} disabled={busy} onClick={() => { setConfirmation(null); setError(""); }}>{l("取消", "Cancel")}</button><button type="button" className="btn-primary" disabled={busy} onClick={() => void action(async () => {
      if (confirmation.kind === "remove") { const next = saved.current!; const profiles = next.profiles.filter(item => item.id !== confirmation.profile.id); await persist({ ...next, profiles, activeProfile: next.activeProfile === confirmation.profile.id ? profiles[0]?.id ?? "" : next.activeProfile }, {}, true); }
      else { await invoke("ai_history_clear"); window.dispatchEvent(new Event("netape-ai-history-cleared")); toast(l("聊天记录已清空", "Chat history cleared"), "success"); }
      setConfirmation(null);
    })}>{busy ? l("处理中…", "Working…") : confirmation.kind === "remove" ? l("确认移除", "Remove service") : l("确认清空", "Clear history")}</button></>}><p className="ai-confirm-copy">{confirmation.kind === "remove" ? l(`移除「${confirmation.profile.name}」及其保存的密钥？聊天记录会保留。`, `Remove “${confirmation.profile.name}” and its stored key? Chat history will be kept.`) : l("清空此设备上的所有 AI 聊天记录？此操作无法撤销。", "Clear all AI chat history on this device? This cannot be undone.")}</p>{error && <p role="alert" className="ai-error">{error}</p>}</ConfirmationView>}
  </div>;
}
