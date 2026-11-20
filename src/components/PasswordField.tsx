import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useT } from "../i18n";
import { toast } from "./Toast";

export default function PasswordField({ id, value, onChange, disabled = false, placeholder }: {
  id: string; value: string; onChange: (value: string) => void; disabled?: boolean; placeholder?: string;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch { toast(t("host.dialog.copyPasswordFailed")); }
  };
  return <div className="hf-pass-wrap hf-pass-wrap--actions">
    <input id={id} type={visible ? "text" : "password"} className="hf-ctrl" value={value}
      disabled={disabled} onChange={event => onChange(event.target.value)}
      placeholder={placeholder} autoComplete="new-password"/>
    <button type="button" className="hf-pass-eye hf-pass-copy" onClick={() => void copy()} disabled={!value}
      aria-label={t("host.dialog.copyPassword")} data-tooltip={t(copied ? "stats.copied" : "host.dialog.copyPassword")}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {copied ? <path d="m5 12 4 4L19 6"/> : <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>}
      </svg>
    </button>
    <button type="button" className="hf-pass-eye" onClick={() => setVisible(previous => !previous)}
      aria-label={t(visible ? "host.dialog.hidePassword" : "host.dialog.showPassword")}
      data-tooltip={t(visible ? "host.dialog.hidePassword" : "host.dialog.showPassword")}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12"/><circle cx="12" cy="12" r="3"/>
        {visible && <path d="m2 2 20 20"/>}
      </svg>
    </button>
  </div>;
}
