import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface CustomSelectOption {
  value: string;
  label: ReactNode;
}

interface Props {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  portalMenu?: boolean;
  id?: string;
  style?: CSSProperties;
}

export default function CustomSelect({
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  menuClassName = "",
  portalMenu = false,
  id,
  style,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const fallbackId = useId();
  const listboxId = id ? `${id}-listbox` : `custom-select-${fallbackId}`;

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !portalMenu) return;
    const update = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8, above = rect.top - 8;
      const desired = Math.min(240, menuRef.current?.scrollHeight ?? 240);
      const up = below < desired && above > below;
      const maxHeight = Math.max(0, Math.min(240, up ? above : below));
      const width = Math.min(rect.width, window.innerWidth - 16);
      setMenuStyle({ position: "fixed", left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), right: "auto", width, maxHeight, boxSizing: "border-box", zIndex: 12000,
        top: up ? "auto" : rect.bottom + 4, bottom: up ? window.innerHeight - rect.top + 4 : "auto" });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); document.removeEventListener("scroll", update, true); };
  }, [open, portalMenu, options.length]);

  const handlePick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const menu = open && !disabled ? <div ref={menuRef} id={listboxId}
    className={`custom-select-menu${menuClassName ? ` ${menuClassName}` : ""}`} role="listbox"
    style={portalMenu ? menuStyle : undefined}>
    {options.map((option) => <button key={option.value} type="button" role="option"
      aria-selected={option.value === value} className={`custom-select-option${option.value === value ? " is-selected" : ""}`}
      onClick={() => handlePick(option.value)}>{option.label}</button>)}
  </div> : null;

  return (
    <div
      ref={rootRef}
      className={`custom-select${disabled ? " is-disabled" : ""}${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      style={style}
    >
      <button
        id={id}
        type="button"
        className="custom-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => !disabled && setOpen((prev) => !prev)}
      >
        <span className="custom-select-value">{selected?.label ?? ""}</span>
        <span className="custom-select-arrow">{open ? "▸" : "▾"}</span>
      </button>

      {portalMenu && menu ? createPortal(menu, document.body) : menu}
    </div>
  );
}
