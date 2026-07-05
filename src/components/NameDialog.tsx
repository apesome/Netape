import { useState } from "react";
import { useT } from "../i18n";

interface Props {
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export default function NameDialog({
  title,
  initialValue = "",
  placeholder = "",
  confirmText,
  onConfirm,
  onClose,
}: Props) {
  const t = useT();
  const [value, setValue] = useState(initialValue);

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    onConfirm(next);
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-new-group" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>
        <div className="dialog-body dialog-body--compact">
          <div className="hf" style={{ gridTemplateColumns: "1fr" }}>
            <input
              className="hf-ctrl"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
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
          <button className="btn-primary" onClick={submit}>
            {confirmText ?? t("host.dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
