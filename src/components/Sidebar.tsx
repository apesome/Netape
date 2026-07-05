import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Host } from "../types";
import HostTree from "./HostTree";
import ConfirmDialog, { useConfirm } from "./ConfirmDialog";
import { toast } from "./Toast";
import { useAvailableProtocols } from "../protocols";
import { useT } from "../i18n";

const NO_FILTER = { icon: "≡", label: "" };

interface Props {
  hosts: Host[];
  onToggle: () => void;
  onOpenHost: (host: Host) => void;
  onEditHost: (host: Host) => void;
  onDeleteHost: () => void;
  onNewHost: (parentId?: string, protocol?: string) => void;
  onNewFolder: (parentId: string, name: string) => void;
  onRefresh: () => void;
  width?: number;
}

export default function Sidebar({
  hosts,
  onToggle,
  onOpenHost,
  onEditHost,
  onDeleteHost,
  onNewHost,
  onNewFolder,
  onRefresh,
  width,
}: Props) {
  const t = useT();
  const PROTO_OPTIONS = useAvailableProtocols().map((p) => ({ value: p.id, icon: p.icon, label: t(p.filterLabelKey ?? p.filterLabel) }));
  const [filter, setFilter] = useState("");
  const [protoFilter, setProtoFilter] = useState("SSH");
  const [protoDropOpen, setProtoDropOpen] = useState(false);
  const protoBadgeRef = useRef<HTMLDivElement>(null);
  const { confirmState, confirm, handleOk, handleCancel } = useConfirm();

  useEffect(() => {
    if (!protoDropOpen) return;
    const fn = (e: MouseEvent) => {
      if (protoBadgeRef.current && !protoBadgeRef.current.contains(e.target as Node))
        setProtoDropOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [protoDropOpen]);

  const curProto = PROTO_OPTIONS.find((p) => p.value === protoFilter) ?? NO_FILTER;

  const handleDelete = async (host: Host) => {
    const ok = await confirm(t("host.deleteConfirmFull", { name: host.name }));
    if (!ok) return;
    try {
      await invoke("host_remove", { id: host.id });
      onDeleteHost();
    } catch (e) {
      toast(t("host.deleteFailed", { error: String(e) }));
    }
  };

  const handleRename = async (id: string, name: string) => {
    const host = hosts.find((h) => h.id === id);
    if (!host) return;
    try {
      await invoke("host_save", { host: { ...host, name, updateDate: Date.now() } });
      onRefresh();
    } catch (e) {
      toast(String(e));
    }
  };

  return (
    <>
    <aside className="sidebar" style={width !== undefined ? { width } : undefined}>
      {/* Header */}
      <div className="sidebar-header">
        <div style={{ flex: 1 }} />
        <span className="sidebar-brand">Netape</span>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn"
          data-tooltip={t("sidebar.collapse")}
          onClick={onToggle}
        >
          ◁
        </button>
      </div>

      {/* Search input */}
      <div className="sidebar-search">
        <div className="sidebar-search-row">
          <div className="proto-prefix-wrap" ref={protoBadgeRef}>
            <button
              className="proto-prefix-btn proto-prefix-btn--compact"
              onClick={() => setProtoDropOpen((v) => !v)}
              data-tooltip={t("host.switchType")}
            >
              <span className="proto-prefix-icon">{curProto.icon}</span>
              <span className="proto-prefix-arrow">▾</span>
            </button>
            {protoDropOpen && (
              <div className="proto-prefix-drop proto-prefix-drop--sidebar">
                {PROTO_OPTIONS.map((p) => (
                  <div
                    key={p.value}
                    className={`proto-prefix-drop-item${protoFilter === p.value ? " active" : ""}`}
                    onClick={() => { setProtoFilter(protoFilter === p.value ? "" : p.value); setProtoDropOpen(false); }}
                  >
                    <span className="proto-drop-icon">{p.icon}</span>
                    <span>{p.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <input
            className="sidebar-search-input"
            placeholder={t("host.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setFilter(""); }}
          />
          {filter && (
            <button className="sidebar-search-clear" onClick={() => setFilter("")}>✕</button>
          )}
        </div>
      </div>

      {/* Host tree */}
      <div className="sidebar-tree">
        <HostTree
          hosts={hosts}
          onOpen={onOpenHost}
          onEdit={onEditHost}
          onDelete={handleDelete}
          onNewHost={(pid, proto) => onNewHost(pid, proto)}
          onNewFolder={(pid, name) => onNewFolder(pid, name)}
          onRename={handleRename}
          filter={filter}
          protoFilter={protoFilter}
        />
      </div>
    </aside>
    {confirmState && (
      <ConfirmDialog message={confirmState.message} onOk={handleOk} onCancel={handleCancel} okText={t("host.delete")} />
    )}
    </>
  );
}
