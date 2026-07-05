import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KeywordHighlight } from "../types";
import ConfirmDialog, { useConfirm } from "./ConfirmDialog";
import { InboxEmptyIcon } from "./icons";
import { useT } from "../i18n";

interface Props {
  onClose: () => void;
  onChange?: () => void;
}

const DEFAULT_COLORS = [
  "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1",
  "#89dceb", "#89b4fa", "#cba6f7", "#f5c2e7",
];

/** Small inline icons for the highlight dialog. */
const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.5 2.5l2 2L5 13l-2.7.7L3 11l8.5-8.5z" />
  </svg>
);
const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 9h5L11 4M6.5 7v4M9.5 7v4" />
  </svg>
);

function newRule(): KeywordHighlight {
  return {
    id: crypto.randomUUID(), keyword: "", textColor: "#f9e2af", bgColor: "",
    description: "", enabled: true, regex: false, matchCase: false, bold: false,
    sort: 0, createDate: 0, updateDate: 0,
  };
}

export default function KeyHighlightDialog({ onClose, onChange }: Props) {
  const t = useT();
  const [rules, setRules] = useState<KeywordHighlight[]>([]);
  const [selected, setSelected] = useState<KeywordHighlight | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<KeywordHighlight>(newRule());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const list = await invoke<KeywordHighlight[]>("highlight_list");
      list.sort((a, b) => a.sort - b.sort || a.keyword.localeCompare(b.keyword));
      setRules(list);
    } catch (e) { setError(String(e)); }
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setForm(newRule());
    setSelected(null);
    setEditing(true);
    setError("");
  };

  const openEdit = (r: KeywordHighlight) => {
    setForm({ ...r });
    setSelected(r);
    setEditing(true);
    setError("");
  };

  const handleSave = async () => {
    if (!form.keyword.trim()) { setError(t("highlight.keywordRequired")); return; }
    setBusy(true); setError("");
    try {
      await invoke("highlight_save", { highlight: { ...form, keyword: form.keyword.trim() } });
      await load();
      setEditing(false);
      onChange?.();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const handleToggle = async (r: KeywordHighlight) => {
    try {
      await invoke("highlight_save", { highlight: { ...r, enabled: !r.enabled } });
      await load();
      onChange?.();
    } catch (e) { setError(String(e)); }
  };

  const { confirmState, confirm: confirmDlg, handleOk, handleCancel } = useConfirm();

  const handleDelete = async (r: KeywordHighlight) => {
    const ok = await confirmDlg(t("highlight.deleteConfirm", { keyword: r.keyword }));
    if (!ok) return;
    try {
      await invoke("highlight_remove", { id: r.id });
      if (selected?.id === r.id) { setSelected(null); setEditing(false); }
      await load();
      onChange?.();
    } catch (e) { setError(String(e)); }
  };

  const upd = (k: keyof KeywordHighlight, v: unknown) =>
    setForm((p) => ({ ...p, [k]: v } as KeywordHighlight));

  /** A boolean field rendered as a toggle chip. */
  const ToggleChip = ({ k, label }: { k: keyof KeywordHighlight; label: string }) => (
    <button
      type="button"
      className={`hl-chip${form[k] ? " on" : ""}`}
      onClick={() => upd(k, !(form[k] as boolean))}
    >
      <span className="hl-chip-dot" />
      {label}
    </button>
  );

  return (
    <>
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-highlight" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("highlight.title")}</h2>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>

        <div className="highlight-body">
          {/* Toolbar */}
          <div className="highlight-toolbar">
            <div className="hl-toolbar-left">
              {rules.length > 0 && (
                <span className="hl-count">{t("highlight.ruleCount", { count: rules.length })}</span>
              )}
              {error && <span className="dialog-error">{error}</span>}
            </div>
            <button className="btn-sm" onClick={openNew}>
              {t("highlight.addRule")}
            </button>
          </div>

          {/* Table */}
          <div className="highlight-table-wrap">
            {rules.length === 0 ? (
              <div className="list-empty-state">
                <InboxEmptyIcon />
                <div className="list-empty-state-text">{t("highlight.empty")}</div>
              </div>
            ) : (
              <table className="highlight-table">
                <thead>
                  <tr>
                    <th style={{ width: 56, whiteSpace: "nowrap" }}>{t("highlight.col.enabled")}</th>
                    <th>{t("highlight.col.keyword")}</th>
                    <th style={{ width: 200, whiteSpace: "nowrap" }}>{t("highlight.col.preview")}</th>
                    <th>{t("highlight.col.desc")}</th>
                    <th style={{ width: 76, whiteSpace: "nowrap" }}>{t("highlight.col.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr
                      key={r.id}
                      className={selected?.id === r.id ? "hl-row-active" : ""}
                      onClick={() => setSelected(r)}
                    >
                      <td>
                        <button
                          type="button"
                          className={`hl-switch${r.enabled ? " on" : ""}`}
                          onClick={(e) => { e.stopPropagation(); handleToggle(r); }}
                          aria-pressed={r.enabled}
                        >
                          <span className="hl-switch-knob" />
                        </button>
                      </td>
                      <td className="hl-cell-keyword">
                        <span className={`hl-keyword${r.enabled ? "" : " is-off"}`}>{r.keyword}</span>
                        {!r.enabled && <span className="hl-off-tag">{t("highlight.col.enabled")}</span>}
                      </td>
                      <td className="hl-cell-preview">
                        <span
                          className="hl-preview"
                          title={r.keyword || t("highlight.preview")}
                          style={{
                            color: r.textColor,
                            background: r.bgColor || "transparent",
                            fontWeight: r.bold ? "bold" : "normal",
                            opacity: r.enabled ? 1 : 0.5,
                          }}
                        >
                          {r.keyword || t("highlight.preview")}
                        </span>
                      </td>
                      <td className="hl-desc">{r.description}</td>
                      <td>
                        <div className="hl-actions">
                          <button
                            className="icon-btn hl-act"
                            onClick={(e) => { e.stopPropagation(); openEdit(r); }}
                            data-tooltip={t("highlight.edit")}
                          ><PencilIcon /></button>
                          <button
                            className="icon-btn hl-act"
                            onClick={(e) => { e.stopPropagation(); handleDelete(r); }}
                            data-tooltip={t("highlight.delete")}
                          ><TrashIcon /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Edit form */}
          {editing && (
            <div className="highlight-form">
              <div className="highlight-form-title">
                <span className="hl-form-dot" />
                {form.id ? t("highlight.form.editRule") : t("highlight.form.newRule")}
              </div>
              <div className="highlight-form-row">
                <label className="field hl-field" style={{ flex: 1 }}>
                  <span>{t("highlight.form.keyword")}</span>
                  <input
                    value={form.keyword}
                    onChange={(e) => upd("keyword", e.target.value)}
                    placeholder={t("highlight.form.keywordPlaceholder")}
                    autoFocus
                  />
                </label>
                <label className="field hl-field" style={{ width: 150 }}>
                  <span>{t("highlight.form.desc")}</span>
                  <input
                    value={form.description}
                    onChange={(e) => upd("description", e.target.value)}
                    placeholder={t("highlight.form.descPlaceholder")}
                  />
                </label>
              </div>
              <div className="highlight-form-row">
                <label className="field hl-field">
                  <span>{t("highlight.form.textColor")}</span>
                  <div className="color-picker-row">
                    <input
                      type="color"
                      value={form.textColor}
                      onChange={(e) => upd("textColor", e.target.value)}
                    />
                    <span className="color-hex">{form.textColor}</span>
                    <div className="color-swatches">
                      {DEFAULT_COLORS.map((c) => (
                        <div
                          key={c}
                          className={`color-swatch${form.textColor === c ? " active" : ""}`}
                          style={{ background: c }}
                          onClick={() => upd("textColor", c)}
                        />
                      ))}
                    </div>
                  </div>
                </label>
                <label className="field hl-field">
                  <span>{t("highlight.form.bgColor")}</span>
                  <div className="color-picker-row">
                    <input
                      type="color"
                      value={form.bgColor || "#1e2230"}
                      onChange={(e) => upd("bgColor", e.target.value)}
                    />
                    <span className="color-hex">{form.bgColor || t("highlight.form.bgNone")}</span>
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={(e) => { e.preventDefault(); upd("bgColor", ""); }}
                      style={{ padding: "0 8px" }}
                    >{t("highlight.form.bgClear")}</button>
                  </div>
                </label>
              </div>
              <div className="highlight-form-row highlight-form-checks">
                <ToggleChip k="regex" label={t("highlight.form.regex")} />
                <ToggleChip k="matchCase" label={t("highlight.form.matchCase")} />
                <ToggleChip k="bold" label={t("highlight.form.bold")} />
                <ToggleChip k="enabled" label={t("highlight.form.enabled")} />
                <div className="hl-preview-inline" style={{
                  color: form.textColor,
                  background: form.bgColor || "transparent",
                  fontWeight: form.bold ? "bold" : "normal",
                }}>
                  {form.keyword || t("highlight.form.preview")}
                </div>
              </div>
              {error && <div className="dialog-error">{error}</div>}
              <div className="dialog-actions">
                <button onClick={() => setEditing(false)}>{t("highlight.form.cancel")}</button>
                <button className="btn-primary" onClick={handleSave} disabled={busy}>
                  {busy ? t("highlight.form.saving") : t("highlight.form.save")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    {confirmState && (
      <ConfirmDialog message={confirmState.message} onOk={handleOk} onCancel={handleCancel} okText={t("highlight.delete")} />
    )}
    </>
  );
}
