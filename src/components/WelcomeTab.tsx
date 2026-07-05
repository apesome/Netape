import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Host } from "../types";
import HostTree from "./HostTree";
import ConfirmDialog, { useConfirm } from "./ConfirmDialog";
import NameDialog from "./NameDialog";
import { toast } from "./Toast";
import { useAvailableProtocols } from "../protocols";
import { useT } from "../i18n";
import { InboxEmptyIcon } from "./icons";

const OpenNewTabIcon = () => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path fillRule="evenodd" clipRule="evenodd" d="M7 3H3C1.89543 3 1 3.89543 1 5V11C1 12.1046 1.89543 13 3 13H11C12.1046 13 13 12.1046 13 11V9H12V11C12 11.5523 11.5523 12 11 12H3C2.44772 12 2 11.5523 2 11V5C2 4.44772 2.44772 4 3 4H7V3Z"/>
    <path fillRule="evenodd" clipRule="evenodd" d="M12.5 0C12.2239 0 12 0.223858 12 0.5V3H9.5C9.22386 3 9 3.22386 9 3.5C9 3.77614 9.22386 4 9.5 4H12V6.5C12 6.77614 12.2239 7 12.5 7C12.7761 7 13 6.77614 13 6.5V4H15.5C15.7761 4 16 3.77614 16 3.5C16 3.22386 15.7761 3 15.5 3H13V0.5C13 0.223858 12.7761 0 12.5 0Z"/>
  </svg>
);

const FolderGridIcon = () => (
  <svg width="17" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);

const CrumbChevron = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 1.5L7 5L3 8.5"/>
  </svg>
);

interface Props {
  hosts: Host[];
  layoutMode?: "Fence" | "Screen" | "Grid";
  onOpenHost: (host: Host) => void;
  onNewHost: (parentId?: string, protocol?: string) => void;
  onNewHostDrawer?: (parentId?: string, protocol?: string) => void;
  onNewRootGroup?: () => void;
  onEditHost: (host: Host) => void;
  onEditHostDrawer?: (host: Host) => void;
  onDeleteHost: () => void;
  onNewFolder: (parentId: string, name: string, protocol?: string) => void;
  onRename: (id: string, name: string) => void;
  onOpenKeyManager: () => void;
  onOpenSettings: () => void;
}


export default function WelcomeTab({
  hosts,
  layoutMode = "Screen",
  onOpenHost,
  onNewHost,
  onNewHostDrawer,
  onNewRootGroup,
  onEditHost,
  onEditHostDrawer,
  onDeleteHost,
  onNewFolder,
  onRename,
}: Props) {
  const t = useT();
  const PROTO_OPTIONS = useAvailableProtocols().map((p) => ({ value: p.id, icon: p.icon, label: t(p.filterLabelKey ?? p.filterLabel) }));
  const [query, setQuery] = useState("");
  const [protoFilter, setProtoFilter] = useState("SSH");
  const [protoDropOpen, setProtoDropOpen] = useState(false);
  const [emptyNewMenuOpen, setEmptyNewMenuOpen] = useState(false);
  const [currentGroupId, setCurrentGroupId] = useState("0");
  const [gridCtx, setGridCtx] = useState<null | { x: number; y: number; kind: "folder" | "host"; item: Host }>(null);
  const [renameTarget, setRenameTarget] = useState<Host | null>(null);
  const [newChildFolderParent, setNewChildFolderParent] = useState<Host | null>(null);
  const protoBadgeRef = useRef<HTMLDivElement>(null);
  const emptyNewMenuRef = useRef<HTMLDivElement>(null);
  const gridCtxRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!emptyNewMenuOpen) return;
    const fn = (e: MouseEvent) => {
      if (emptyNewMenuRef.current && !emptyNewMenuRef.current.contains(e.target as Node)) {
        setEmptyNewMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [emptyNewMenuOpen]);

  useEffect(() => {
    if (!gridCtx) return;
    const fn = (e: MouseEvent) => {
      if (gridCtxRef.current && !gridCtxRef.current.contains(e.target as Node)) {
        setGridCtx(null);
      }
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [gridCtx]);

  useEffect(() => {
    if (PROTO_OPTIONS.length > 0 && !PROTO_OPTIONS.some((p) => p.value === protoFilter)) {
      setProtoFilter(PROTO_OPTIONS[0].value);
    }
  }, [PROTO_OPTIONS, protoFilter]);

  const curProto = PROTO_OPTIONS.find((p) => p.value === protoFilter) ?? PROTO_OPTIONS[0];
  const showGrid = layoutMode === "Grid";

  const hostsById = new Map(hosts.map((h) => [h.id, h]));
  const isFolder = (h: Host) => h.protocol === "Folder";
  const activeProtocol = protoFilter || "SSH";
  const folderBelongsToActiveProtocol = (h: Host) => isFolder(h) && ((h.ownerType || "SSH") === activeProtocol);
  const queryLower = query.trim().toLowerCase();
  const currentGroup = currentGroupId === "0" ? null : hostsById.get(currentGroupId);

  useEffect(() => {
    if (currentGroupId !== "0" && (!currentGroup || currentGroup.deleted || !isFolder(currentGroup))) {
      setCurrentGroupId("0");
    }
  }, [currentGroup, currentGroupId]);

  useEffect(() => {
    if (!showGrid) setCurrentGroupId("0");
  }, [showGrid]);

  // Restore the last-visited grid group on mount (grid view only), then persist
  // any subsequent change so reopening the app returns to the same group.
  const GRID_GROUP_KEY = "grid.currentGroup";
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!showGrid) return;
    // Restore once the host list is available.
    if (!restoredRef.current && hosts.length > 0) {
      restoredRef.current = true;
      invoke<string | null>("settings_get", { key: GRID_GROUP_KEY })
        .then((raw) => {
          const id = raw ? (JSON.parse(raw) as string) : "0";
          if (id === "0") return;
          const h = hosts.find((x) => x.id === id);
          if (h && !h.deleted && isFolder(h)) setCurrentGroupId(id);
        })
        .catch(() => {});
    }
  }, [showGrid, hosts]);

  // Persist the current grid group (skip "0" so leaving the grid view via the
  // tree-mode reset above does not clobber the saved value).
  useEffect(() => {
    if (!showGrid || currentGroupId === "0") return;
    invoke("settings_set", { key: GRID_GROUP_KEY, value: JSON.stringify(currentGroupId) }).catch(() => {});
  }, [showGrid, currentGroupId]);

  const belongsToCurrentBranch = (host: Host) => {
    if (currentGroupId === "0") return (host.parentId ?? "0") === "0";
    return (host.parentId ?? "0") === currentGroupId;
  };

  const folderOrDescendantMatches = (folderId: string): boolean => {
    const children = hosts.filter((h) => !h.deleted && (h.parentId ?? "0") === folderId);
    return children.some((h) => {
      if (isFolder(h)) {
        if (!folderBelongsToActiveProtocol(h)) return false;
        return (!!queryLower && h.name.toLowerCase().includes(queryLower)) || folderOrDescendantMatches(h.id);
      }
      return (!protoFilter || h.protocol === protoFilter)
        && [h.name, h.host, h.username, h.remark].some((v) => v.toLowerCase().includes(queryLower));
    });
  };

  const folderHasAnyDescendantHost = (folderId: string): boolean => {
    const children = hosts.filter((h) => !h.deleted && (h.parentId ?? "0") === folderId);
    return children.some((h) => !isFolder(h) || (folderBelongsToActiveProtocol(h) && folderHasAnyDescendantHost(h.id)));
  };

  const countHostsInFolder = (folderId: string): number => {
    const children = hosts.filter((h) => !h.deleted && (h.parentId ?? "0") === folderId);
    let count = 0;
    for (const child of children) {
      if (isFolder(child)) {
        count += countHostsInFolder(child.id);
      } else if (!protoFilter || child.protocol === protoFilter) {
        count += 1;
      }
    }
    return count;
  };

  const childFolders = hosts
    .filter((h) => !h.deleted && folderBelongsToActiveProtocol(h) && belongsToCurrentBranch(h))
    .filter((h) => !protoFilter || folderOrDescendantMatches(h.id) || !folderHasAnyDescendantHost(h.id))
    .filter((h) => !queryLower || h.name.toLowerCase().includes(queryLower) || folderOrDescendantMatches(h.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const childHosts = hosts
    .filter((h) => !h.deleted && !isFolder(h) && belongsToCurrentBranch(h))
    .filter((h) => !protoFilter || h.protocol === protoFilter)
    .filter((h) => !queryLower || [h.name, h.host, h.username, h.remark].some((v) => v.toLowerCase().includes(queryLower)))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.host.localeCompare(b.host);
    });

  const isGridEmpty = showGrid && childFolders.length === 0 && childHosts.length === 0;

  const breadcrumbs = (() => {
    const items: Array<{ id: string; name: string }> = [{ id: "0", name: t("host.root") }];
    let pid = currentGroupId;
    const stack: Array<{ id: string; name: string }> = [];
    while (pid && pid !== "0") {
      const folder = hostsById.get(pid);
      if (!folder || !isFolder(folder)) break;
      stack.push({ id: folder.id, name: folder.name });
      pid = folder.parentId ?? "0";
    }
    return [...items, ...stack.reverse()];
  })();

  const hostSubtitle = (host: Host) => {
    if (host.protocol === "Local") return "local";
    if (host.protocol === "WSL") return host.host || "wsl";
    const left = host.username ? `${host.username}@` : "";
    return `${left}${host.host}`;
  };

  const handleDelete = async (host: Host) => {
    const ok = await confirm(t("host.deleteConfirm", { name: host.name }));
    if (!ok) return;
    try {
      await invoke("host_remove", { id: host.id });
      onDeleteHost();
    } catch (e) {
      toast(t("host.deleteFailed", { error: String(e) }));
    }
  };

  const handleCopy = (host: Host) => {
    onEditHost({
      ...host,
      id: crypto.randomUUID(),
      name: `${host.name} (${t("host.copySuffix")})`,
      createDate: 0,
      updateDate: 0,
    });
  };

  const openGridCtx = (e: React.MouseEvent, kind: "folder" | "host", item: Host) => {
    e.preventDefault();
    e.stopPropagation();
    setGridCtx({ x: e.clientX, y: e.clientY, kind, item });
  };

  return (
    <>
      <div className={`welcome-tab${showGrid ? " welcome-full" : ""}`}>
        {!showGrid && (
          <div className="welcome-banner-area">
            <img className="welcome-logo" src="/icon.png" alt="Netape" draggable={false} />
            <span className="welcome-brand">Netape</span>
          </div>
        )}

        <div className="welcome-content">
          <div className="welcome-grid">
            <div className="welcome-toolbar-border" />

            <div className="proto-prefix-wrap welcome-grid-proto" ref={protoBadgeRef}>
              <button
                className="proto-prefix-btn"
                onClick={() => setProtoDropOpen((v) => !v)}
                data-tooltip={t("host.switchType")}
              >
                <span className="proto-prefix-icon">{curProto.icon}</span>
                <span className="proto-prefix-label">{curProto.label}</span>
                <span className="proto-prefix-arrow">▾</span>
              </button>
              {protoDropOpen && (
                <div className="proto-prefix-drop">
                  {PROTO_OPTIONS.map((p) => (
                  <div
                      key={p.value}
                      className={`proto-prefix-drop-item${protoFilter === p.value ? " active" : ""}`}
                      onClick={() => { setProtoFilter(p.value); setProtoDropOpen(false); }}
                    >
                      <span className="proto-drop-icon">{p.icon}</span>
                      <span>{p.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <input
              className="welcome-search welcome-grid-search"
              type="text"
              placeholder={t("host.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />

            <div className="welcome-grid-actions">
              <div className="welcome-grid-new-wrap" ref={emptyNewMenuRef}>
                <button className="icon-btn" data-tooltip={t("host.new")}
                  onClick={() => {
                    if (showGrid) {
                      setEmptyNewMenuOpen((v) => !v);
                    } else {
                      onNewHost(undefined, protoFilter || "SSH");
                    }
                  }}><OpenNewTabIcon /></button>
                {emptyNewMenuOpen && (
                  <div className="welcome-grid-new-menu">
                    <button
                      type="button"
                      className="welcome-grid-new-item"
                      onClick={() => {
                        setEmptyNewMenuOpen(false);
                        (onNewHostDrawer ?? onNewHost)(undefined, protoFilter || "SSH");
                      }}
                    >
                      {t("host.newHost")}
                    </button>
                    <button
                      type="button"
                      className="welcome-grid-new-item"
                      onClick={() => {
                        setEmptyNewMenuOpen(false);
                        onNewRootGroup?.();
                      }}
                    >
                      {t("host.newGroup")}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="welcome-tree welcome-grid-tree">
              {showGrid ? (
                <div className="welcome-grid-panel">
                  <div className="welcome-grid-breadcrumbs">
                    {breadcrumbs.map((crumb, index) => (
                      <div key={crumb.id} className="welcome-grid-crumb-wrap">
                        {index > 0 && <span className="welcome-grid-crumb-sep"><CrumbChevron /></span>}
                        <button
                          type="button"
                          className={`welcome-grid-crumb${crumb.id === currentGroupId ? " active" : ""}`}
                          onClick={() => setCurrentGroupId(crumb.id)}
                        >
                          {crumb.name}
                        </button>
                      </div>
                    ))}
                  </div>
                  {isGridEmpty ? (
                    <div className="welcome-grid-empty">
                      <InboxEmptyIcon />
                      <div className="welcome-grid-empty-text">{query ? t("sftp.noMatchedHosts") : t("host.gridEmpty")}</div>
                    </div>
                  ) : (
                    <>
                    {childFolders.length > 0 && (
                      <div className="welcome-grid-section">
                        <div className="welcome-grid-section-head">
                          <div className="welcome-grid-section-title">{t("host.groupSection")}</div>
                          <div className="welcome-grid-section-meta">{t("host.groupCount", { count: childFolders.length })}</div>
                        </div>
                      <div className="welcome-group-grid">
                        {childFolders.map((folder) => {
                          const totalHostCount = countHostsInFolder(folder.id);
                          return (
                          <button
                            key={folder.id}
                            type="button"
                            className="welcome-group-card"
                            onClick={() => setCurrentGroupId(folder.id)}
                            onContextMenu={(e) => openGridCtx(e, "folder", folder)}
                            data-tooltip={folder.name}
                          >
                            <div className="welcome-group-card-icon"><FolderGridIcon /></div>
                            <div className="welcome-group-card-text">
                              <div className="welcome-group-card-name">{folder.name}</div>
                              <div className="welcome-group-card-sub">
                                {t("host.groupHostCount", { count: totalHostCount })}
                              </div>
                            </div>
                          </button>
                          );
                        })}
                      </div>
                      </div>
                    )}
                    <div className="welcome-grid-section">
                    <div className="welcome-grid-section-head">
                      <div className="welcome-grid-section-title">{t("host.hostSection")}</div>
                      <div className="welcome-grid-section-meta">{t("host.hostCount", { count: childHosts.length })}</div>
                    </div>
                    <div className="welcome-host-grid">
                    {childHosts.map((host) => {
                      return (
                        <button
                          key={host.id}
                          type="button"
                          className="welcome-host-card"
                          onClick={() => onOpenHost(host)}
                          onDoubleClick={() => onOpenHost(host)}
                          onContextMenu={(e) => openGridCtx(e, "host", host)}
                          data-tooltip={host.name}
                        >
                          <div className="welcome-host-card-icon">{PROTO_OPTIONS.find((p) => p.value === host.protocol)?.icon ?? "≡"}</div>
                          <div className="welcome-host-card-text">
                            <div className="welcome-host-card-name">{host.name}</div>
                            <div className="welcome-host-card-sub">{hostSubtitle(host)}</div>
                          </div>
                        </button>
                      );
                    })}
                    </div>
                    </div>
                    </>
                  )}
                </div>
              ) : (
                <HostTree
                  hosts={hosts}
                  onOpen={onOpenHost}
                  onEdit={onEditHost}
          onDelete={handleDelete}
          onNewHost={onNewHost}
          onNewFolder={onNewFolder}
          onRename={onRename}
          filter={query}
          protoFilter={protoFilter}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {confirmState && (
        <ConfirmDialog message={confirmState.message} onOk={handleOk} onCancel={handleCancel} okText={t("host.delete")} />
      )}
      {gridCtx && (
        <div
          ref={gridCtxRef}
          className="ctx-menu"
          style={{ top: gridCtx.y, left: gridCtx.x }}
        >
          {gridCtx.kind === "folder" ? (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  const item = gridCtx.item;
                  setGridCtx(null);
                  (onNewHostDrawer ?? onNewHost)(item.id, protoFilter || "SSH");
                }}
              >
                {t("host.newHost")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setNewChildFolderParent(gridCtx.item);
                  setGridCtx(null);
                }}
              >
                {t("host.newFolderPlaceholder")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setRenameTarget(gridCtx.item);
                  setGridCtx(null);
                }}
              >
                {t("host.rename")}
              </div>
              <div
                className="ctx-item ctx-item--danger"
                onClick={() => {
                  const item = gridCtx.item;
                  setGridCtx(null);
                  void handleDelete(item);
                }}
              >
                {t("host.delete")}
              </div>
            </>
          ) : (
            <>
              <div className="ctx-item ctx-item--primary" onClick={() => { onOpenHost(gridCtx.item); setGridCtx(null); }}>
                {t("host.connect")}
              </div>
              <div className="ctx-divider" />
              <div className="ctx-item" onClick={() => { handleCopy(gridCtx.item); setGridCtx(null); }}>
                {t("host.copy")}
              </div>
              <div className="ctx-item" onClick={() => { setRenameTarget(gridCtx.item); setGridCtx(null); }}>
                {t("host.rename")}
              </div>
              <div className="ctx-item ctx-item--danger" onClick={() => { const item = gridCtx.item; setGridCtx(null); void handleDelete(item); }}>
                {t("host.delete")}
              </div>
              <div className="ctx-divider" />
              <div className="ctx-item" onClick={() => { (onEditHostDrawer ?? onEditHost)(gridCtx.item); setGridCtx(null); }}>
                {t("host.properties")}
              </div>
            </>
          )}
        </div>
      )}
      {renameTarget && (
        <NameDialog
          title={t("host.rename")}
          initialValue={renameTarget.name}
          placeholder={t("host.dialog.namePlaceholder")}
          confirmText={t("host.dialog.save")}
          onClose={() => setRenameTarget(null)}
          onConfirm={(name) => {
            onRename(renameTarget.id, name);
            setRenameTarget(null);
          }}
        />
      )}
      {newChildFolderParent && (
        <NameDialog
          title={t("host.newFolderPlaceholder")}
          placeholder={t("host.groupDialog.namePlaceholder")}
          confirmText={t("host.groupDialog.confirm")}
          onClose={() => setNewChildFolderParent(null)}
            onConfirm={(name) => {
            onNewFolder(newChildFolderParent.id, name, activeProtocol);
            setNewChildFolderParent(null);
            setCurrentGroupId(newChildFolderParent.id);
          }}
        />
      )}
    </>
  );
}
