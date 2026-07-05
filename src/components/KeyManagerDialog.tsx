import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KeyPair } from "../types";
import ConfirmDialog, { useConfirm } from "./ConfirmDialog";
import { InboxEmptyIcon } from "./icons";
import { useT } from "../i18n";

interface Props {
  onClose: () => void;
}

export default function KeyManagerDialog({ onClose }: Props) {
  const t = useT();
  const [keys, setKeys] = useState<KeyPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"list" | "generate" | "import">("list");
  const [genName, setGenName] = useState("");
  const [genType, setGenType] = useState<"ED25519" | "RSA">("ED25519");
  const [importName, setImportName] = useState("");
  const [importPem, setImportPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadKeys = async () => {
    setLoading(true);
    try {
      const list = await invoke<KeyPair[]>("key_list");
      setKeys(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadKeys(); }, []);

  const handleGenerate = async () => {
    if (!genName.trim()) { setError(t("keyMgr.nameRequired")); return; }
    setBusy(true); setError("");
    try {
      await invoke("key_generate", { name: genName, keyType: genType });
      await loadKeys();
      setMode("list"); setGenName("");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const handleImport = async () => {
    if (!importName.trim()) { setError(t("keyMgr.nameRequired")); return; }
    if (!importPem.trim()) { setError(t("keyMgr.pemRequired")); return; }
    setBusy(true); setError("");
    try {
      await invoke("key_import", { name: importName, privateKey: importPem });
      await loadKeys();
      setMode("list"); setImportName(""); setImportPem("");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const { confirmState, confirm: confirmDlg, handleOk, handleCancel } = useConfirm();

  const handleDelete = async (id: string) => {
    const ok = await confirmDlg(t("keyMgr.deleteConfirm"));
    if (!ok) return;
    try {
      await invoke("key_remove", { id });
      await loadKeys();
    } catch (e) { setError(String(e)); }
  };

  return (
    <>
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-lg dialog-keymgr dialog-highlight" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("keyMgr.title")}</h2>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>

        {mode === "list" && (
          <>
            <div className="keymgr-toolbar">
              <button className="btn-sm" onClick={() => { setMode("generate"); setError(""); }}>
                {t("keyMgr.generate")}
              </button>
              <button className="btn-sm" onClick={() => { setMode("import"); setError(""); }}>
                {t("keyMgr.import")}
              </button>
            </div>

            <div className="keymgr-list">
              {loading && <div className="keymgr-empty">{t("keyMgr.loading")}</div>}
              {!loading && keys.length === 0 && (
                <div className="keymgr-empty list-empty-state">
                  <InboxEmptyIcon />
                  <div className="list-empty-state-text">{t("keyMgr.empty")}</div>
                </div>
              )}
              {keys.map((kp) => (
                <div key={kp.id} className="key-row">
                  <div className="key-info">
                    <span className="key-name">{kp.name}</span>
                    <span className="key-type">{kp.keyType}{kp.length ? ` ${kp.length}` : ""}</span>
                  </div>
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => handleDelete(kp.id)}
                  >
                    {t("keyMgr.delete")}
                  </button>
                </div>
              ))}
            </div>

            {error && <div className="dialog-error">{error}</div>}
            <div className="dialog-actions">
              <button onClick={onClose}>{t("keyMgr.close")}</button>
            </div>
          </>
        )}

        {mode === "generate" && (
          <>
            <div className="dialog-body">
              <label className="field">
                <span>{t("keyMgr.name")}</span>
                <input
                  value={genName}
                  onChange={(e) => setGenName(e.target.value)}
                  placeholder={t("keyMgr.namePlaceholder")}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>{t("keyMgr.type")}</span>
                <select value={genType} onChange={(e) => setGenType(e.target.value as "ED25519" | "RSA")}>
                  <option value="ED25519">{t("keyMgr.ed25519")}</option>
                  <option value="RSA">{t("keyMgr.rsa4096")}</option>
                </select>
              </label>
              {error && <div className="dialog-error">{error}</div>}
            </div>
            <div className="dialog-actions">
              <button onClick={() => setMode("list")}>{t("keyMgr.cancel")}</button>
              <button className="btn-primary" onClick={handleGenerate} disabled={busy}>
                {busy ? t("keyMgr.generating") : t("keyMgr.generateBtn")}
              </button>
            </div>
          </>
        )}

        {mode === "import" && (
          <>
            <div className="dialog-body">
              <label className="field">
                <span>{t("keyMgr.name")}</span>
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder={t("keyMgr.importNamePlaceholder")}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>{t("keyMgr.pemLabel")}</span>
                <textarea
                  className="key-pem-input"
                  value={importPem}
                  onChange={(e) => setImportPem(e.target.value)}
                  placeholder={t("keyMgr.pemPlaceholder")}
                  rows={8}
                />
              </label>
              {error && <div className="dialog-error">{error}</div>}
            </div>
            <div className="dialog-actions">
              <button onClick={() => setMode("list")}>{t("keyMgr.cancel")}</button>
              <button className="btn-primary" onClick={handleImport} disabled={busy}>
                {busy ? t("keyMgr.importing") : t("keyMgr.importBtn")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
    {confirmState && (
      <ConfirmDialog message={confirmState.message} onOk={handleOk} onCancel={handleCancel} okText={t("keyMgr.delete")} />
    )}
    </>
  );
}
