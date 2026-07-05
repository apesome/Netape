import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ToastType = "error" | "success" | "warning" | "info";

interface ToastItem {
  id:      string;
  type:    ToastType;
  title?:  string;
  message: string;
}

let _dispatch: ((item: ToastItem) => void) | null = null;

export function toast(message: string, type: ToastType = "error", title?: string) {
  const item: ToastItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type, title, message,
  };
  _dispatch?.(item);
}

const ICONS: Record<ToastType, string> = {
  error:   "✕",
  success: "✓",
  warning: "⚠",
  info:    "ℹ",
};

const AUTO_DISMISS: Record<ToastType, number> = {
  error:   6000,
  success: 3000,
  warning: 5000,
  info:    4000,
};

function ToastItemEl({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS[item.type]);
    return () => clearTimeout(timerRef.current);
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`toast-item toast-${item.type}`}>
      <span className="toast-icon">{ICONS[item.type]}</span>
      <div className="toast-body">
        {item.title && <div className="toast-title">{item.title}</div>}
        <div className="toast-msg">{item.message}</div>
      </div>
      <button className="toast-close" onClick={onDismiss}>×</button>
    </div>
  );
}

export default function GlobalToast() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    _dispatch = (item) => setItems(prev => [...prev.slice(-4), item]); // cap at 5
    return () => { _dispatch = null; };
  }, []);

  if (items.length === 0) return null;

  return createPortal(
    <div className="toast-container">
      {items.map(item => (
        <ToastItemEl
          key={item.id}
          item={item}
          onDismiss={() => setItems(prev => prev.filter(i => i.id !== item.id))}
        />
      ))}
    </div>,
    document.body
  );
}
