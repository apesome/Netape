import { useState, useRef, useCallback, useEffect } from "react";
import type { Host } from "../types";
import { ROOT_ID, useTreeExpanded, toggleExpanded, setTreeExpanded } from "../store/treeStore";
import { useT } from "../i18n";

interface Props {
  hosts: Host[];
  onOpen: (host: Host) => void;
  onEdit: (host: Host) => void;
  onDelete: (host: Host) => void;
  onNewHost: (parentId: string, protocol?: string) => void;
  onNewFolder: (parentId: string, name: string, protocol?: string) => void;
  onRename: (id: string, name: string) => void;
  filter?: string;
  protoFilter?: string;
}

// Transparent host icon (server/rack style, uses current color)
const HostAvatarIcon = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="0.7" y="0.7" width="14.6" height="5.2" rx="1.3" />
    <rect x="0.7" y="8.1" width="14.6" height="5.2" rx="1.3" />
    <circle cx="13.2" cy="3.3" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="13.2" cy="10.7" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

const PersonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

// Chevron arrow — rotates on open/close
const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="10" height="10" viewBox="0 0 10 10"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0 }}
  >
    <path d="M3 1.5L7.5 5L3 8.5" />
  </svg>
);

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {open ? (
      <>
        <path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2A2 2 0 0 0 12.11 6H18a2 2 0 0 1 2 2v2"/>
      </>
    ) : (
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    )}
  </svg>
);

interface CtxState {
  x: number;
  y: number;
  id: string;           // ROOT_ID or host.id
  isRoot: boolean;
  isFolder: boolean;
  host?: Host;          // undefined for root
}

export default function HostTree({
  hosts,
  onOpen,
  onEdit,
  onDelete,
  onNewHost,
  onNewFolder,
  onRename,
  filter = "",
  protoFilter = "",
}: Props) {
  const t = useT();
  const expanded = useTreeExpanded();
  const [selected, setSelected] = useState<string | null>(ROOT_ID);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const inlineFolderInputRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  // Inline new-folder: { parentId, name }
  const [inlineFolder, setInlineFolder] = useState<{ parentId: string; name: string } | null>(null);
  // Refs so the click-outside handler always reads the latest values (no stale closure)
  const inlineFolderValueRef = useRef(inlineFolder);
  inlineFolderValueRef.current = inlineFolder;
  const onNewFolderRef = useRef(onNewFolder);
  onNewFolderRef.current = onNewFolder;

  const showHostSubtitle = (host: Host) => !["Local", "WSL"].includes(host.protocol);
  const activeProtocol = protoFilter || "SSH";
  const folderBelongsToActiveProtocol = (host: Host) =>
    host.protocol === "Folder" && ((host.ownerType || "SSH") === activeProtocol);

  useEffect(() => { renameInputRef.current?.select(); }, [renaming?.id]);

  // Commit inline folder when clicking outside it (same pattern as ctx menu close)
  useEffect(() => {
    if (!inlineFolder) return;
    const handler = (e: MouseEvent) => {
      if (inlineFolderInputRef.current && !inlineFolderInputRef.current.contains(e.target as Node)) {
        const f = inlineFolderValueRef.current;
        setInlineFolder(null);
        if (f?.name.trim()) onNewFolderRef.current(f.parentId, f.name.trim(), activeProtocol);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [inlineFolder]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctx) return;
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtx(null);
        setOpenSub(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ctx]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const toggle = useCallback((id: string) => toggleExpanded(id), []);


  /** Count all non-folder descendants recursively — the real "host count". */
  const countHosts = useCallback((parentId: string): number => {
    const direct = hosts.filter((h) => (h.parentId ?? "0") === parentId && !h.deleted);
    let n = 0;
    for (const h of direct) {
      if (h.protocol === "Folder") n += countHosts(h.id);
      else if (!protoFilter || h.protocol === protoFilter) n++;
    }
    return n;
  }, [hosts, protoFilter]);

  /** All folder IDs under a parentId, recursively. */
  function allFolderIds(parentId: string): string[] {
    const result: string[] = [];
    for (const h of hosts) {
      if ((h.parentId ?? "0") === parentId && !h.deleted && h.protocol === "Folder") {
        result.push(h.id);
        result.push(...allFolderIds(h.id));
      }
    }
    return result;
  }

  function expandAll(fromId: string) {
    const ids = fromId === ROOT_ID
      ? [ROOT_ID, ...allFolderIds("0")]
      : [fromId, ...allFolderIds(fromId)];
    setTreeExpanded(new Set([...expanded, ...ids]));
    setCtx(null);
  }

  function collapseAll(fromId: string) {
    const collapse = new Set(
      fromId === ROOT_ID ? allFolderIds("0") : [fromId, ...allFolderIds(fromId)]
    );
    const next = new Set(expanded);
    collapse.forEach(id => next.delete(id));
    setTreeExpanded(next);
    setCtx(null);
  }

  // ── Filter ─────────────────────────────────────────────────────────────────

  const lf = filter.toLowerCase();

  function hostMatches(h: Host): boolean {
    if (protoFilter && h.protocol !== protoFilter) return false;
    if (!lf) return true;
    return (
      h.name.toLowerCase().includes(lf) ||
      h.host.toLowerCase().includes(lf) ||
      h.username.toLowerCase().includes(lf)
    );
  }

  function folderVisible(id: string): boolean {
    const folder = hosts.find((h) => h.id === id);
    if (!folder || !folderBelongsToActiveProtocol(folder)) return false;
    if (!lf) return true;
    if (folder?.name.toLowerCase().includes(lf)) return true;
    return hosts.some((h) => !h.deleted && (
      (h.protocol === "Folder" && isDescendantOf(h.id, id) && folderVisible(h.id)) ||
      (h.protocol !== "Folder" && isDescendantOf(h.id, id) && hostMatches(h))
    ));
  }

  function isDescendantOf(childId: string, ancestorId: string): boolean {
    const child = hosts.find((h) => h.id === childId);
    if (!child) return false;
    const pid = child.parentId ?? "0";
    if (pid === ancestorId) return true;
    if (pid === "0" || pid === "") return false;
    return isDescendantOf(pid, ancestorId);
  }

  // ── Rename ─────────────────────────────────────────────────────────────────

  const startRename = (id: string, name: string) => {
    setCtx(null);
    setRenaming({ id, name });
  };

  const commitRename = () => {
    if (renaming?.name.trim()) onRename(renaming.id, renaming.name.trim());
    setRenaming(null);
  };

  const commitInlineFolder = () => {
    const f = inlineFolderValueRef.current;
    setInlineFolder(null);
    if (f?.name.trim()) onNewFolderRef.current(f.parentId, f.name.trim(), activeProtocol);
  };

  // ── Sorted children ────────────────────────────────────────────────────────

  function getChildren(parentId: string): Host[] {
    return hosts
      .filter((h) => (h.parentId ?? "0") === parentId && !h.deleted)
      .sort((a, b) => {
        const af = a.protocol === "Folder" ? 0 : 1;
        const bf = b.protocol === "Folder" ? 0 : 1;
        if (af !== bf) return af - bf;
        if (a.sort !== b.sort) return a.sort - b.sort;
        return a.name.localeCompare(b.name);
      });
  }

  // ── Context menu open helpers ───────────────────────────────────────────────

  function openCtxForRoot(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSelected(ROOT_ID);
    setCtx({ x: e.clientX, y: e.clientY, id: ROOT_ID, isRoot: true, isFolder: true });
  }

  function openCtxForHost(e: React.MouseEvent, host: Host) {
    e.preventDefault();
    e.stopPropagation();
    setSelected(host.id);
    setCtx({ x: e.clientX, y: e.clientY, id: host.id, isRoot: false, isFolder: host.protocol === "Folder", host });
  }

  // ── Keyboard on rows ───────────────────────────────────────────────────────

  function handleRowKey(e: React.KeyboardEvent, id: string, isFolder: boolean, host?: Host) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!isFolder && host) onOpen(host);
      else toggle(id === ROOT_ID ? ROOT_ID : id);
    }
    if (e.key === "F2" && id !== ROOT_ID) {
      e.preventDefault();
      const name = host?.name ?? "";
      startRename(id, name);
    }
    if (e.key === "ArrowLeft" && isFolder && expanded.has(id)) toggle(id);
    if (e.key === "ArrowRight" && isFolder && !expanded.has(id)) toggle(id);
  }

  // ── Recursive node renderer ─────────────────────────────────────────────────

  function renderNodes(parentId: string, depth: number): React.ReactNode {
    const children = getChildren(parentId)
      .filter((h) => (lf || protoFilter)
        ? (h.protocol === "Folder" ? folderVisible(h.id) : hostMatches(h))
        : true);

    const inlineInput = inlineFolder?.parentId === parentId ? (
      <div key="__inline_folder__" className="tree-row" style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="tree-arrow" />
        <span className="tree-icon"><FolderIcon open={false} /></span>
        <input
          ref={inlineFolderInputRef}
          autoFocus
          className="tree-rename-input"
          value={inlineFolder!.name}
          placeholder={t("host.newFolderPlaceholder")}
          onChange={(e) => {
            const name = e.target.value;
            setInlineFolder((prev) => prev ? { ...prev, name } : null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitInlineFolder(); }
            if (e.key === "Escape") setInlineFolder(null);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    ) : null;

    return (
      <>
        {children.map((host) => {
        const isFolder = host.protocol === "Folder";
        const isOpen = expanded.has(host.id) || (!!lf && isFolder);
        const isSelected = selected === host.id;
        const isRenaming = renaming?.id === host.id;
        const hostCount = isFolder ? countHosts(host.id) : 0;

        return (
          <div key={host.id} className="tree-node">
            <div
              className={`tree-row${isFolder ? "" : " tree-row--host"}${isSelected ? " tree-row--selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              tabIndex={isSelected ? 0 : -1}
              data-tooltip={host.remark || undefined}
              onClick={() => {
                setSelected(host.id);
                if (isFolder) toggle(host.id);
              }}
              onDoubleClick={() => { if (!isFolder) onOpen(host); }}
              onKeyDown={(e) => handleRowKey(e, host.id, isFolder, host)}
              onContextMenu={(e) => openCtxForHost(e, host)}
            >
              {isFolder ? (
                /* ── Folder row: single line ── */
                <>
                  <span className="tree-arrow"><ChevronIcon open={isOpen} /></span>
                  <span className="tree-icon"><FolderIcon open={isOpen} /></span>
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="tree-rename-input"
                      value={renaming!.name}
                      onChange={(e) => setRenaming({ id: host.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="tree-label-group">
                      <span className="tree-label">{host.name}</span>
                      {hostCount > 0 && <span className="tree-count-tag">{hostCount}</span>}
                    </span>
                  )}
                </>
              ) : (
                /* ── Host row: avatar + two-line text ── */
                <>
                  <div className="tree-host-avatar">
                    <HostAvatarIcon />
                  </div>
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="tree-rename-input"
                      value={renaming!.name}
                      onChange={(e) => setRenaming({ id: host.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className="tree-host-info">
                      <div className="tree-host-name">{host.name}</div>
                      {showHostSubtitle(host) && (
                        <div className="tree-host-sub">
                          {host.username ? `${host.username}@` : ""}{host.host}:{host.port}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {isFolder && isOpen && (
              <div className="tree-children">{renderNodes(host.id, depth + 1)}</div>
            )}
          </div>
        );
      })}
      {inlineInput}
      </>
    );
  }

  // ── Root row ───────────────────────────────────────────────────────────────

  const rootOpen = expanded.has(ROOT_ID);
  const totalHostCount = countHosts("0");
  const rootRenaming = renaming?.id === ROOT_ID; // never true but guard

  // ── Context menu ───────────────────────────────────────────────────────────

  function handleCopy(host: Host) {
    onEdit({ ...host, id: crypto.randomUUID(), name: `${host.name} (${t("host.copySuffix")})`, createDate: 0, updateDate: 0 });
    setCtx(null);
  }

  function handleDelete(host: Host) {
    onDelete(host);
    setCtx(null);
  }

  // The "real" parentId to use when creating inside a folder
  const ctxParentId = ctx
    ? (ctx.isRoot ? "0" : (ctx.isFolder ? ctx.id : (ctx.host?.parentId ?? "0")))
    : "0";

  return (
    <div className="host-tree">

      {/* ── Root node ── */}
      <div
        className={`tree-row tree-row--root${selected === ROOT_ID ? " tree-row--selected" : ""}`}
        tabIndex={selected === ROOT_ID ? 0 : -1}
        onClick={() => { setSelected(ROOT_ID); toggle(ROOT_ID); }}
        onKeyDown={(e) => handleRowKey(e, ROOT_ID, true)}
        onContextMenu={openCtxForRoot}
      >
        <span className="tree-arrow"><ChevronIcon open={rootOpen} /></span>
        <span className="tree-icon"><PersonIcon /></span>
        {rootRenaming ? null : (
          <span className="tree-label-group">
            <span className="tree-label">{t("host.root")}</span>
            {totalHostCount > 0 && <span className="tree-count-tag">{totalHostCount}</span>}
          </span>
        )}
      </div>

      {/* ── Root children ── */}
      {rootOpen && (
        <div className="tree-children">{renderNodes("0", 1)}</div>
      )}

      {/* ── Context menu ── */}
      {ctx && (
        <div
          ref={ctxRef}
          className="ctx-menu"
          style={{ top: ctx.y, left: ctx.x }}
        >
          {/* HOST: connect */}
          {!ctx.isFolder && ctx.host && (
            <>
              <div className="ctx-item ctx-item--primary"
                onClick={() => { onOpen(ctx.host!); setCtx(null); }}>
                {t("host.connect")}
              </div>
              <div className="ctx-divider" />
            </>
          )}

          {/* FOLDER: new submenu */}
          {ctx.isFolder && (
            <div
              className="ctx-item ctx-item--has-sub"
              onMouseEnter={() => setOpenSub("new")}
              onMouseLeave={() => setOpenSub(null)}
            >
              <span>{t("sftp.menu.new")}</span>
              <span className="ctx-sub-arrow">▶</span>
              {openSub === "new" && (
                <div className="ctx-sub">
                  <div className="ctx-item" onClick={() => { onNewHost(ctxParentId, protoFilter || undefined); setCtx(null); }}>
                    {t("host.newHost")}
                  </div>
                  <div className="ctx-item" onClick={() => {
                    // Expand the target folder so inline input is visible
                    setTreeExpanded(new Set([...expanded, ctxParentId === "0" ? ROOT_ID : ctxParentId]));
                    setCtx(null);
                    setOpenSub(null);
                    setInlineFolder({ parentId: ctxParentId, name: "" });
                  }}>
                    {t("host.newFolderPlaceholder")}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* HOST: copy */}
          {!ctx.isFolder && ctx.host && (
            <div className="ctx-item" onClick={() => handleCopy(ctx.host!)}>
              {t("host.copy")}
            </div>
          )}

          {/* Delete & Rename — disabled for root */}
          {!ctx.isRoot && (
            <>
              <div className="ctx-item ctx-item--danger"
                onClick={() => ctx.host && handleDelete(ctx.host)}>
                {t("host.delete")}
              </div>
              <div className="ctx-item"
                onClick={() => ctx.host && startRename(ctx.host.id, ctx.host.name)}>
                {t("host.rename")}
              </div>
            </>
          )}

          {/* HOST: properties */}
          {!ctx.isFolder && ctx.host && (
            <>
              <div className="ctx-divider" />
              <div className="ctx-item" onClick={() => { onEdit(ctx.host!); setCtx(null); }}>
                {t("host.properties")}
              </div>
            </>
          )}

          {/* FOLDER: expand/collapse all */}
          {ctx.isFolder && (
            <>
              <div className="ctx-divider" />
              <div className="ctx-item" onClick={() => expandAll(ctx.id)}>
                {t("host.expandAll")}
              </div>
              <div className="ctx-item" onClick={() => collapseAll(ctx.id)}>
                {t("host.collapseAll")}
              </div>
            </>
          )}

        </div>
      )}
    </div>
  );
}
