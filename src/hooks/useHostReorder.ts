import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Host } from "../types";
import { planHostDrop, type HostDropPosition } from "../hostTreeOrder";
import { toast } from "../components/Toast";

/** Shared drag handling and persistence for tree rows and grid cards. */
export function useHostReorder({ hosts, onReorder, layout = "tree", disabled = false, resetKey, onDragStart }: {
  hosts: Host[];
  onReorder?: () => void;
  layout?: "tree" | "grid";
  disabled?: boolean;
  resetKey: string;
  onDragStart: () => void;
}) {
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: HostDropPosition } | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);
  useEffect(() => () => cancelDragRef.current?.(), []);
  useEffect(() => { cancelDragRef.current?.(); }, [resetKey, disabled]);

  const startReorder = (event: ReactPointerEvent<HTMLElement>, host: Host) => {
    const control = (event.target as Element).closest("input, button");
    if (!onReorder || savingOrder || disabled || event.button !== 0 || event.isPrimary === false
      || (control && control !== event.currentTarget)) return;
    cancelDragRef.current?.();
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    const sourceElement = event.currentTarget;
    const sourceBounds = sourceElement.getBoundingClientRect();
    const scrollArea = event.currentTarget.closest<HTMLElement>(".welcome-tree, .sidebar-tree");
    let dragging = false;
    let preview: HTMLElement | null = null;
    let target: { id: string; position: HostDropPosition } | null = null;
    const previousCursor = document.body.style.cursor;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(pointer.clientX - origin.x, pointer.clientY - origin.y) < 5) return;
      if (!dragging) {
        onDragStart();
        preview = sourceElement.cloneNode(true) as HTMLElement;
        preview.classList.add(layout === "grid" ? "host-card-drag-preview" : "tree-row-drag-preview");
        preview.removeAttribute("data-host-order-id");
        preview.removeAttribute("data-tooltip");
        preview.setAttribute("aria-hidden", "true");
        preview.inert = true;
        preview.style.width = `${sourceBounds.width}px`;
        preview.style.height = `${sourceBounds.height}px`;
        if (layout === "tree") preview.style.paddingLeft = "12px";
        document.body.appendChild(preview);
        scrollArea?.classList.add("host-grid--reordering");
      }
      dragging = true;
      pointer.preventDefault();
      if (preview) {
        const x = Math.max(8, Math.min(window.innerWidth - sourceBounds.width * 1.02 - 8,
          sourceBounds.left + pointer.clientX - origin.x));
        const y = Math.max(8, Math.min(window.innerHeight - sourceBounds.height * 1.02 - 8,
          sourceBounds.top + pointer.clientY - origin.y));
        preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.02)`;
      }
      setDragSource(host.id);
      document.body.style.cursor = "grabbing";
      suppressClickUntil.current = Date.now() + 300;
      const row = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>("[data-host-order-id]");
      target = null;
      if (row && scrollArea?.contains(row)) {
        const id = row.dataset.hostOrderId!;
        const bounds = row.getBoundingClientRect();
        const folder = id === "0" || hosts.some(item => item.id === id && item.protocol === "Folder");
        const fraction = layout === "grid" ? (pointer.clientX - bounds.left) / bounds.width
          : (pointer.clientY - bounds.top) / bounds.height;
        const position: HostDropPosition = folder && (id === "0" || (fraction > 0.25 && fraction < 0.75))
          ? "inside" : fraction >= 0.5 ? "after" : "before";
        if (planHostDrop(hosts, host.id, id, position)) target = { id, position };
      }
      setDropTarget(target);
      if (scrollArea) {
        const bounds = scrollArea.getBoundingClientRect();
        if (pointer.clientY < bounds.top + 32) scrollArea.scrollTop -= 16;
        else if (pointer.clientY > bounds.bottom - 32) scrollArea.scrollTop += 16;
      }
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", cancel);
      preview?.remove();
      scrollArea?.classList.remove("host-grid--reordering");
      document.body.style.cursor = previousCursor;
      if (dragging) suppressClickUntil.current = Date.now() + 300;
      setDragSource(null);
      setDropTarget(null);
      cancelDragRef.current = null;
    };
    const cancel = () => cleanup();
    const keydown = (key: KeyboardEvent) => { if (key.key === "Escape") cancel(); };
    const finish = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const plan = dragging && target ? planHostDrop(hosts, host.id, target.id, target.position) : null;
      cleanup();
      if (!plan) return;
      setSavingOrder(true);
      const moving = plan.parentId !== (host.parentId || "0");
      void invoke(moving ? "host_move" : "host_reorder", moving
        ? { id: host.id, parentId: plan.parentId, ids: plan.ids } : { ids: plan.ids }).then(onReorder)
        .catch(error => toast(String(error))).finally(() => setSavingOrder(false));
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", keydown);
    window.addEventListener("blur", cancel);
    cancelDragRef.current = cleanup;
  };

  return { dragSource, dropTarget, startReorder, suppressClickUntil };
}
