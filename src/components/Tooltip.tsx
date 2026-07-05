import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TooltipState {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

export default function GlobalTooltip() {
  const [tip, setTip]       = useState<TooltipState | null>(null);
  const tipDivRef            = useRef<HTMLDivElement>(null);
  const anchorRef            = useRef<HTMLElement | null>(null);
  const showTimerRef         = useRef<ReturnType<typeof setTimeout>>();
  const hideTimerRef         = useRef<ReturnType<typeof setTimeout>>();
  const cooldownTimerRef     = useRef<ReturnType<typeof setTimeout>>();
  const mutObsRef            = useRef<MutationObserver | null>(null);
  const inCooldownRef        = useRef(false);

  // After render: measure the tooltip div and clamp to viewport edges
  useLayoutEffect(() => {
    if (!tip || !tipDivRef.current) return;
    const el  = tipDivRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const w = rect.width;
    const clamped = Math.max(margin + w / 2, Math.min(tip.x, window.innerWidth - margin - w / 2));
    if (clamped !== tip.x) el.style.left = `${clamped}px`;
  }, [tip]);

  useEffect(() => {
    const clearTip = () => {
      clearTimeout(showTimerRef.current);
      clearTimeout(hideTimerRef.current);
      mutObsRef.current?.disconnect();
      mutObsRef.current = null;
      anchorRef.current = null;
      setTip(null);
    };

    const watchAnchor = (el: HTMLElement) => {
      mutObsRef.current?.disconnect();
      const parent = el.parentElement;
      if (!parent) return;
      mutObsRef.current = new MutationObserver(() => {
        if (!document.contains(el)) clearTip();
      });
      mutObsRef.current.observe(parent, { childList: true });
    };

    const onEnter = (e: MouseEvent) => {
      if (inCooldownRef.current) return;
      const el = (e.target as Element).closest("[data-tooltip]") as HTMLElement | null;
      if (!el) return;
      const text = el.dataset.tooltip;
      if (!text) return;

      clearTimeout(hideTimerRef.current);
      clearTimeout(showTimerRef.current);

      showTimerRef.current = setTimeout(() => {
        if (inCooldownRef.current) return;
        const r = el.getBoundingClientRect();
        const above = el.dataset.tooltipPos === "above" || r.bottom + 60 > window.innerHeight;
        const x = Math.round(r.left + r.width / 2);
        const y = above ? Math.round(r.top - 8) : Math.round(r.bottom + 8);
        anchorRef.current = el;
        watchAnchor(el);
        setTip({ text, x, y, above });
      }, 300);
    };

    const onLeave = (e: MouseEvent) => {
      const el = (e.target as Element).closest("[data-tooltip]");
      if (!el) return;
      clearTimeout(showTimerRef.current);
      hideTimerRef.current = setTimeout(clearTip, 80);
    };

    const onPointerDown = () => {
      clearTip();
      inCooldownRef.current = true;
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = setTimeout(() => {
        inCooldownRef.current = false;
      }, 500);
    };

    document.addEventListener("mouseenter",  onEnter,       true);
    document.addEventListener("mouseleave",  onLeave,       true);
    document.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      document.removeEventListener("mouseenter",  onEnter,       true);
      document.removeEventListener("mouseleave",  onLeave,       true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      clearTip();
      clearTimeout(cooldownTimerRef.current);
    };
  }, []);

  if (!tip) return null;

  return createPortal(
    <div
      ref={tipDivRef}
      className="g-tooltip"
      style={{
        left: tip.x,
        top:  tip.y,
        transform: tip.above
          ? "translateX(-50%) translateY(-100%)"
          : "translateX(-50%)",
      }}
    >
      {tip.text}
    </div>,
    document.body
  );
}
