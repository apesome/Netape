import { useState } from "react";
import { useT } from "../i18n";

interface Props {
  onClose: () => void;
  onConfirm: (name: string) => void;
}

export default function NewGroupDialog({ onClose, onConfirm }: Props) {
  const t = useT();
  const [name, setName] = useState("");

  const submit = () => {
    const next = name.trim();
    if (!next) return;
    onConfirm(next);
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-new-group" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("host.groupDialog.title")}</h2>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>
        <div className="dialog-body dialog-body--compact">
          <div className="hf">
            <label className="hf-lbl" htmlFor="new-group-name">{t("host.groupDialog.name")}</label>
            <input
              id="new-group-name"
              className="hf-ctrl"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("host.groupDialog.namePlaceholder")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>{t("host.dialog.cancel")}</button>
          <button className="btn-primary" onClick={submit} disabled={!name.trim()}>
            {t("host.groupDialog.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
