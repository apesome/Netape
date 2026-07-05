import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

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
  id,
  style,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fallbackId = useId();
  const listboxId = id ? `${id}-listbox` : `custom-select-${fallbackId}`;

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? options[0],
    [options, value],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const handlePick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

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

      {open && !disabled && (
        <div
          id={listboxId}
          className={`custom-select-menu${menuClassName ? ` ${menuClassName}` : ""}`}
          role="listbox"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`custom-select-option${option.value === value ? " is-selected" : ""}`}
              onClick={() => handlePick(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
