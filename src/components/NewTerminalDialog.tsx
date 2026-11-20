import { useState } from "react";
import type { Host } from "../types";
import { getProtocol } from "../protocols";
import { useT } from "../i18n";
import { useRecentHosts } from "../store/recentHosts";

/** "New host" card icon — a window with a plus badge. */
const NewHostIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 6.5h.01M10 6.5h.01" />
    <circle cx="17.5" cy="15.5" r="4.5" fill="var(--panel2)" />
    <path d="M17.5 13.5v4M15.5 15.5h4" />
  </svg>
);

/** "Local terminal" card icon — a terminal window with a prompt. */
const TerminalIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 6.5h.01M10 6.5h.01" />
    <path d="M7.5 13l3 1.8-3 1.8" />
    <path d="M13 16.6h3.5" />
  </svg>
);

/** Search icon. */
const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

function hostSubtitle(h: Host): string {
  if (h.protocol === "Local") return "local";
  if (h.protocol === "WSL") return h.host || "wsl";
  const left = h.username ? `${h.username}@` : "";
  return h.host ? `${left}${h.host}` : "";
}

/**
 * "New terminal" dialog — launched from the tab bar's "+" button.
 * Offers quick access to create a host, open a local terminal, or pick an
 * existing host from a searchable list (click or double-click to connect).
 */
export default function NewTerminalDialog({
  hosts,
  onPickHost,
  onNewHost,
  onLocalTerminal,
  onClose,
}: {
  hosts: Host[];
  onPickHost: (host: Host) => void;
  onNewHost: () => void;
  onLocalTerminal: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const lf = filter.trim().toLowerCase();
  const recent = useRecentHosts();
  const rank = new Map(recent.map((id, index) => [id, index]));

  // Recently opened hosts first, then hosts without history in name order.
  const list = hosts
    .filter((h) => !h.deleted && h.protocol !== "Folder")
    .filter((h) => !lf || h.name.toLowerCase().includes(lf) || (h.host || "").toLowerCase().includes(lf) || (h.username || "").toLowerCase().includes(lf))
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.name.localeCompare(b.name));

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-new-term" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{t("terminal.new.title")}</h2>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>

        {/* Action cards */}
        <div className="new-term-actions">
          <button className="new-term-action" onClick={onNewHost}>
            <span className="new-term-action-icon"><NewHostIcon /></span>
            <span className="new-term-action-text">{t("host.newHost")}</span>
          </button>
          <button className="new-term-action" onClick={onLocalTerminal}>
            <span className="new-term-action-icon"><TerminalIcon /></span>
            <span className="new-term-action-text">{t("terminal.new.localTerminal")}</span>
          </button>
        </div>

        {/* Search */}
        <div className="new-term-search">
          <span className="new-term-search-icon"><SearchIcon /></span>
          <input
            className="new-term-search-input"
            placeholder={t("host.searchPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {list.length > 0 && <span className="new-term-search-hint">{t("terminal.new.dblHint")}</span>}
        </div>

        {/* Host list */}
        <div className="new-term-list">
          {list.length === 0 ? (
            <div className="new-term-empty">{t("terminal.new.empty")}</div>
          ) : (
            list.map((h) => {
              const icon = getProtocol(h.protocol)?.icon;
              const sub = hostSubtitle(h);
              return (
                <div
                  key={h.id}
                  className="new-term-row"
                  title={h.remark || h.name}
                  onClick={() => onPickHost(h)}
                >
                  <span className="new-term-row-icon">{icon}</span>
                  <div className="new-term-row-info">
                    <span className="new-term-row-name">{h.name}</span>
                    {sub && <span className="new-term-row-sub">{sub}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
