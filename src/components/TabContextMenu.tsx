import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

export type TabAction = "properties" | "rename" | "duplicate" | "close" | "closeOthers" | "closeAll" | "reconnect";
export default function TabContextMenu({ x, y, onAction, onClose }: {
  x: number; y: number; onAction: (action: TabAction) => void; onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - bounds.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - bounds.height - 4))}px`;
  }, [x, y]);
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const actions: TabAction[] = ["properties", "rename", "duplicate", "close", "closeOthers", "closeAll", "reconnect"];
  return createPortal(<div ref={ref} className="ctx-menu terminal-tab-menu" role="menu" style={{ left: x, top: y }}>
    {actions.map(action => <Fragment key={action}>
      {["rename", "closeOthers", "reconnect"].includes(action) && <div className="ctx-divider" role="separator"/>}
      <button type="button" role="menuitem" className="ctx-item"
        onClick={() => { onClose(); onAction(action); }}>{t(`tabMenu.${action}`)}</button>
    </Fragment>)}
  </div>, document.body);
}
