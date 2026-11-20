import { useEffect, useId, useRef, type ReactNode } from "react";
import { aiIcon } from "../aiIcons";
import { AiIcon, aiLabel as l } from "./AiCommon";

export function AiProviderMark({ provider, model, small = false }: { provider: string; model?:string; small?: boolean }) {
  const icon=aiIcon(provider,model);
  const name=icon?.split("/").pop()?.split(".")[0]??"";
  const ink=["chatgpt","glm","granite","grok","groq","openrouter"].includes(name)?"white":["agnes","baseten","liquid","nousresearch","ollama"].includes(name)?"black":undefined;
  return <span aria-hidden="true" className={`ai-provider-mark ai-provider-mark--${provider}${small ? " ai-provider-mark--small" : ""}`}>
    {icon?<img src={icon} alt="" data-ink={ink}/>:provider==="custom"?"</>":<AiIcon/>}
  </span>;
}

export function AiSettingsConfirm({ title, children, footer, onClose, busy = false }: {
  title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="dialog ai-confirm-dialog" aria-labelledby={id} aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <h3 id={id}>{title}</h3>
    <div className="ai-confirm-dialog-body">{children}</div>
    <div className="dialog-actions">{footer}</div>
  </dialog>;
}

export function AiSettingsPage({ title, description, children, footer, onClose, busy = false }: {
  title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const root = useRef<HTMLElement>(null), close = useRef(onClose), blocked = useRef(busy);
  const id = useId();
  close.current = onClose; blocked.current = busy;
  useEffect(() => {
    const panel = root.current?.closest<HTMLElement>(".settings-panel");
    if (panel) panel.scrollTop = 0;
    const frame = requestAnimationFrame(() => (root.current?.querySelector<HTMLElement>('[data-initial-focus]') ?? root.current?.querySelector<HTMLElement>("button"))?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && !document.querySelector('.ai-model-menu')) {
        event.preventDefault(); event.stopPropagation();
        const select = root.current?.querySelector<HTMLButtonElement>('.custom-select.is-open > button');
        if (select) { select.click(); select.focus(); return; }
        if (!blocked.current) close.current();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", keydown); };
  }, [title]);
  return <section ref={root} className="ai-settings-page" aria-labelledby={id}>
    <header className="ai-settings-page-head"><button type="button" className="ai-page-back" aria-label={l("返回", "Back")} onClick={onClose} disabled={busy}>‹</button><div><h3 id={id}>{title}</h3>{description && <p>{description}</p>}</div></header>
    <div className="ai-settings-page-body">{children}</div>
    {footer && <footer className="ai-settings-page-foot">{footer}</footer>}
  </section>;
}
