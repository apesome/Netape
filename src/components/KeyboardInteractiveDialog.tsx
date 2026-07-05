import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../i18n";

interface KbiPrompt {
  prompt: string;
  echo: boolean;
}

interface KbiRequest {
  reqId: string;
  name: string;
  instructions: string;
  prompts: KbiPrompt[];
}

/**
 * Global listener + modal for SSH keyboard-interactive authentication.
 *
 * The backend emits `ssh://kbi-request` whenever a server issues a challenge
 * during connection; we collect the user's answers and send them back via the
 * `ssh_kbi_respond` command. Mounted once at the app root.
 */
export default function KeyboardInteractiveDialog() {
  const t = useT();
  const [req, setReq] = useState<KbiRequest | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<KbiRequest>("ssh://kbi-request", (e) => {
      const r = e.payload;
      setReq(r);
      setAnswers(r.prompts.map(() => ""));
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (req) setTimeout(() => firstInputRef.current?.focus(), 50);
  }, [req?.reqId]);

  if (!req) return null;

  const send = async (values: string[]) => {
    const reqId = req.reqId;
    setReq(null);
    setAnswers([]);
    try {
      await invoke("ssh_kbi_respond", { reqId, answers: values });
    } catch { /* ignore — connection likely already gone */ }
  };

  const submit = () => send(answers);
  // Cancel: answer with empties so the auth attempt fails cleanly rather than
  // leaving the connection hanging.
  const cancel = () => send(req.prompts.map(() => ""));

  return (
    <div className="dialog-overlay" onClick={cancel}>
      <div className="dialog dialog-kbi" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{req.name || t("kbi.title")}</h2>
        </div>

        <div className="dialog-body kbi-body">
          {req.instructions && <p className="kbi-instructions">{req.instructions}</p>}

          {req.prompts.length === 0 && (
            <p className="kbi-instructions">{t("kbi.noPrompts")}</p>
          )}

          {req.prompts.map((p, i) => (
            <div className="kbi-field" key={i}>
              <label className="kbi-label">{p.prompt || t("kbi.inputPlaceholder")}</label>
              <input
                ref={i === 0 ? firstInputRef : undefined}
                className="hf-ctrl"
                type={p.echo ? "text" : "password"}
                value={answers[i] ?? ""}
                autoComplete={p.echo ? "off" : "new-password"}
                onChange={(e) =>
                  setAnswers((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") cancel();
                }}
              />
            </div>
          ))}
        </div>

        <div className="dialog-actions">
          <button onClick={cancel}>{t("confirm.cancel")}</button>
          <button className="btn-primary" onClick={submit}>{t("confirm.ok")}</button>
        </div>
      </div>
    </div>
  );
}
