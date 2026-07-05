import { useState, useCallback } from "react";
import { t } from "../i18n";

interface ConfirmState {
  message: string;
  resolve: (ok: boolean) => void;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({ message, resolve });
    });
  }, []);

  const handleOk = useCallback(() => {
    state?.resolve(true);
    setState(null);
  }, [state]);

  const handleCancel = useCallback(() => {
    state?.resolve(false);
    setState(null);
  }, [state]);

  return { confirmState: state, confirm, handleOk, handleCancel };
}

interface Props {
  message: string;
  onOk: () => void;
  onCancel: () => void;
  okText?: string;
  okDanger?: boolean;
}

export default function ConfirmDialog({ message, onOk, onCancel, okText }: Props) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-msg">{message}</p>
        <div className="dialog-actions">
          <button onClick={onCancel}>{t("confirm.cancel")}</button>
          <button
            className="btn-primary"
            onClick={onOk}
            autoFocus
          >
            {okText ?? t("confirm.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
