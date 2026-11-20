import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { AiProfile } from "../ai";
import { AI_PROVIDERS, identifyAiProvider, aiNeedsApiKey, type AiCatalog } from "../aiProviders";
import { companionServiceKey } from "../aiCompanion";
import CustomSelect from "./CustomSelect";
import { AiProviderMark } from "./AiSettingsUi";
import { aiLabel as l } from "./AiCommon";

interface Props {
  id: string; profiles: AiProfile[]; profileId: string; model: string; disabled: boolean; visible: boolean;
  onProfileChange: (id: string) => void; onModelChange: (model: string) => void;
  onSettings: () => void;
}

export default function AiCompanionModelPicker(props: Props) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<{ source: string; value: AiCatalog } | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const revision = useRef(0), currentSource = useRef("");
  const profile = props.profiles.find(item => item.id === props.profileId);
  const missingKey = !!profile && aiNeedsApiKey(profile);
  const source = profile ? companionServiceKey(profile) : ""; currentSource.current = source;
  const listId = useId(), inputId = useId(), serviceId = useId();
  const detected = profile ? identifyAiProvider(profile.baseUrl, profile.protocol, profile.providerId) : undefined;
  const provider = AI_PROVIDERS.find(item => item.id === detected?.provider);
  const edition = provider?.editions.find(item => item.id === (profile?.editionId ?? detected?.edition));
  const models = [...new Set([...(catalog?.source === source ? catalog.value.models : []), ...(edition?.models ?? []), ...(profile?.model ? [profile.model] : []), ...(props.model ? [props.model] : [])])];
  const matches = models.filter(model => model.toLowerCase().includes(query.toLowerCase()));
  const typed = query.trim();
  const validTyped = !!typed && new TextEncoder().encode(typed).length <= 200 && !/[\x00-\x1f\x7f]/.test(typed);
  const shown = open && !props.disabled && props.visible;
  const pick = (value: string) => { props.onModelChange(value); setOpen(false); trigger.current?.focus(); };

  const refresh = async (cachedFirst = false) => {
    if (!profile || missingKey) return;
    const attempt = ++revision.current, captured = source;
    const draft = { profileId: profile.id, baseUrl: profile.baseUrl, protocol: profile.protocol ?? "openai", model: "", apiKey: null };
    const live = () => attempt === revision.current && currentSource.current === captured;
    setLoading(true); setError("");
    try {
      if (cachedFirst) {
        const cached = await invoke<AiCatalog | null>("ai_catalog_cached", { draft });
        if (!live()) return;
        if (cached) { setCatalog({ source: captured, value: cached }); return; }
      }
      const value = await invoke<AiCatalog>("ai_catalog_refresh", { draft });
      if (live()) setCatalog({ source: captured, value });
    } catch (error) {
      if (live()) {
        const code = String(error);
        setError(code === "AI_KEY_REJECTED" ? l("密钥验证失败，请在 AI 设置中检查密钥。", "API key rejected. Check the key in AI settings.")
          : l("未能获取模型列表，可刷新重试或手动输入模型 ID。", "Could not fetch models. Refresh or enter a model ID manually."));
      }
    } finally { if (live()) setLoading(false); }
  };

  useEffect(() => {
    if (!shown) return;
    setQuery(""); setActive(-1); setCatalog(null); setError(""); setLoading(false);
    void refresh(true);
    return () => { revision.current++; };
  }, [shown, profile]);
  useEffect(() => { if (props.disabled || !props.visible) setOpen(false); }, [props.disabled, props.visible]);
  useEffect(() => { setActive(-1); }, [query, source]);
  useEffect(() => {
    if (!shown) return;
    const frame = requestAnimationFrame(() => (input.current ?? menu.current?.querySelector<HTMLButtonElement>(".ai-runtime-key-configure"))?.focus());
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        const select = menu.current?.querySelector<HTMLButtonElement>(".custom-select.is-open > button");
        if (select) { select.click(); return; }
        setOpen(false); trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [shown, missingKey]);
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
      const up = above > below, height = Math.max(0, Math.min(380, up ? above : below));
      const width = Math.min(320, window.innerWidth - 16);
      setPosition({ position: "fixed", zIndex: 12000, width, maxHeight: height,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: up ? "auto" : rect.bottom + 4, bottom: up ? window.innerHeight - rect.top + 4 : "auto" });
    };
    update(); window.addEventListener("resize", update); document.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); document.removeEventListener("scroll", update, true); };
  }, [shown]);
  useEffect(() => {
    if (active >= 0) menu.current?.querySelectorAll<HTMLElement>('[role="option"][data-model]')[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return <>
    <button ref={trigger} id={props.id} className="ai-runtime-model-trigger" type="button" disabled={props.disabled}
      aria-label={l("选择服务和模型", "Select service and model")} aria-expanded={shown} aria-haspopup="dialog"
      onClick={() => setOpen(!open)} title={`${profile?.name ?? ""} · ${props.model || l("选择模型", "Choose model")}`}>
      <span>{props.model || l("选择模型", "Choose model")}</span><svg className="ai-model-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {shown && createPortal(<div ref={menu} className="ai-runtime-model-menu" role="dialog" aria-label={l("选择服务和模型", "Select service and model")} style={position}>
      <div className="ai-runtime-model-heading"><label htmlFor={serviceId}>{l("模型服务", "Model service")}</label><CustomSelect id={serviceId} value={props.profileId} options={props.profiles.map(item => ({ value: item.id, label: <span className="ai-service-option"><AiProviderMark provider={identifyAiProvider(item.baseUrl,item.protocol,item.providerId).provider} small/>{item.name}</span> }))} onChange={props.onProfileChange}/><button type="button" disabled={loading||missingKey} onClick={() => void refresh()} aria-label={l("刷新可用模型", "Refresh available models")} title={l("刷新可用模型", "Refresh available models")}><svg className={loading?"ai-refreshing":undefined} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg></button></div>
      {missingKey?<div className="ai-runtime-key-notice"><p role="status">{l("请先配置 API Key，再获取和选择模型。","Configure an API key before fetching and selecting models.")}</p><button type="button" className="ai-runtime-key-configure" onClick={()=>{setOpen(false);props.onSettings();}}>{l("去配置","Configure")}</button></div>:<>
      <div className="ai-runtime-model-search"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input ref={input} id={inputId} className="hf-ctrl" value={query} maxLength={200} placeholder={l("搜索或输入模型 ID…", "Search or enter model ID…")} aria-label={l("搜索或输入模型 ID", "Search or enter model ID")}
        role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls={listId} aria-activedescendant={active >= 0 && matches[active] ? `${listId}-${active}` : undefined}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setActive(index => matches.length ? Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))) : -1); }
          if (event.key === "Enter") { event.preventDefault(); if (matches[active]) pick(matches[active]); else if (validTyped) pick(typed); }
        }}/></div>
      {(loading||error)&&<p className="ai-runtime-model-status" role="status">{loading ? l("正在获取模型列表…", "Fetching models…") : error}</p>}
      <div id={listId} role="listbox" aria-label={l("可用模型", "Available models")} className="ai-runtime-model-list">
        {matches.map((item, index) => <button data-model key={item} id={`${listId}-${index}`} type="button" role="option" aria-selected={props.model === item}
          className={`${props.model === item ? "is-selected " : ""}${active === index ? "is-keyboard-active" : ""}`}
          onMouseDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => pick(item)}><AiProviderMark provider={detected?.provider??"custom"} model={item} small/><span>{item}</span>{props.model === item && <svg className="ai-model-check" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m3 8 3 3 7-7"/></svg>}</button>)}
        {!matches.length&&!loading && <p>{l("暂无匹配模型，可在上方手动填写。", "No matching models. Enter an ID above.")}</p>}
      </div>
      {typed && <button type="button" className="ai-runtime-model-apply" disabled={!validTyped} onClick={() => pick(typed)}>{l("使用", "Use")} <span>{typed}</span></button>}
      </>}
    </div>, document.body)}
  </>;
}
