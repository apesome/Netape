import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension, Node as TiptapNode, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import FontFamily from "@tiptap/extension-font-family";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import type { Note } from "../types";
import ConfirmDialog, { useConfirm } from "./ConfirmDialog";
import { t as i18nT, useT } from "../i18n";

// ── Icons ─────────────────────────────────────────────────────────────────────

const IcChevRight = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4l4 4-4 4"/></svg>
);
const IcChevLeft = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4l-4 4 4 4"/></svg>
);
const IcChevDown = () => (
  <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4"/></svg>
);
const IcFolder = ({ open }: { open: boolean }) => open ? (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.5 5a1 1 0 0 1 1-1h3.9l1.1 1.5h6a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" opacity="0.9"/>
  </svg>
) : (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.65">
    <path d="M1.5 4a1 1 0 0 1 1-1h3.9l1.1 1.5h6a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>
  </svg>
);
const IcNote = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.5" y="1.5" width="11" height="13" rx="1.5"/>
    <path d="M5 5.5h6M5 8.5h6M5 11.5h3.5"/>
  </svg>
);
const IcPlus = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>
);
const IcAlignLeft = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="14" height="2" rx="1"/><rect x="1" y="6" width="9" height="2" rx="1"/>
    <rect x="1" y="10" width="14" height="2" rx="1"/><rect x="1" y="14" width="9" height="2" rx="1"/>
  </svg>
);
const IcAlignCenter = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="14" height="2" rx="1"/><rect x="3.5" y="6" width="9" height="2" rx="1"/>
    <rect x="1" y="10" width="14" height="2" rx="1"/><rect x="3.5" y="14" width="9" height="2" rx="1"/>
  </svg>
);
const IcAlignRight = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="14" height="2" rx="1"/><rect x="6" y="6" width="9" height="2" rx="1"/>
    <rect x="1" y="10" width="14" height="2" rx="1"/><rect x="6" y="14" width="9" height="2" rx="1"/>
  </svg>
);
const IcAlignJustify = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="14" height="2" rx="1"/><rect x="1" y="6" width="14" height="2" rx="1"/>
    <rect x="1" y="10" width="14" height="2" rx="1"/><rect x="1" y="14" width="14" height="2" rx="1"/>
  </svg>
);
const IcLink = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.5 9.5a4.24 4.24 0 0 0 6 0l1.5-1.5a4.24 4.24 0 0 0-6-6L7 3"/>
    <path d="M9.5 6.5a4.24 4.24 0 0 0-6 0L2 8a4.24 4.24 0 0 0 6 6L9 13"/>
  </svg>
);
const IcClearFormat = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 14h8M5.5 10.5l-2-2L8 4l4 4-3 3z"/><path d="M1.5 14.5l3-3"/>
  </svg>
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props { onClose: () => void; mode?: "dialog" | "panel"; width?: number }
type AddMenu = { parentId: string | null } | null;
type CtxMenu  = { x: number; y: number; item: Note | null } | null;

// ── Tree helpers ──────────────────────────────────────────────────────────────

function sortedChildren(items: Note[], parentId: string | null): Note[] {
  return items
    .filter(i => (i.parentId ?? null) === parentId)
    .sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.sort - b.sort || a.name.localeCompare(b.name);
    });
}

// ── Custom Tiptap extensions ──────────────────────────────────────────────────

const FontSizeExt = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: el => (el as HTMLElement).style.fontSize || null,
          renderHTML: attrs => attrs.fontSize ? { style: `font-size:${attrs.fontSize as string}` } : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: (size: string) => ({ chain }: any) =>
        chain().setMark("textStyle", { fontSize: size }).run(),
      unsetFontSize: () => ({ chain }: any) =>
        chain().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run(),
    } as any;
  },
});

const LineHeightExt = Extension.create({
  name: "lineHeight",
  addGlobalAttributes() {
    return [{
      types: ["heading", "paragraph"],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: el => (el as HTMLElement).style.lineHeight || null,
          renderHTML: attrs => attrs.lineHeight ? { style: `line-height:${attrs.lineHeight as string}` } : {},
        },
      },
    }];
  },
  addCommands() {
    return {
      setLineHeight: (lh: string) => ({ tr, state, dispatch }: any) => {
        const { from, to } = state.selection;
        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (["heading", "paragraph"].includes(node.type.name as string)) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: lh });
          }
        });
        if (dispatch) dispatch(tr);
        return true;
      },
    } as any;
  },
});

const CalloutNode = TiptapNode.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML() { return [{ tag: 'div[data-type="callout"]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "callout", class: "note-callout" }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      toggleCallout: () => ({ commands }: any) => commands.toggleWrap("callout"),
    } as any;
  },
});

// ── Toolbar constants ─────────────────────────────────────────────────────────

const FONT_FAMILIES = [
  { labelKey: "note.font.default", value: "" },
  { labelKey: "note.font.microsoftYaHei", value: "Microsoft YaHei, sans-serif" },
  { labelKey: "note.font.simsun", value: "SimSun, serif" },
  { labelKey: "note.font.simhei", value: "SimHei, sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Courier New",      value: '"Courier New", monospace' },
  { label: "Times New Roman",  value: '"Times New Roman", serif' },
];

const FONT_SIZES = ["10","11","12","13","14","15","16","18","20","24","28","32","36","48","72"];

const TEXT_COLORS = [
  // light
  "#ffffff","#d0d0d0","#5b9ef6","#1dc3d4","#38c975","#f24040","#f97b2a","#f6cc20","#b05ef7",
  // dark
  "#1a1a1a","#3c3c3c","#1c3f96","#076177","#124f22","#891818","#7a3000","#614e00","#4b0e87",
  // medium
  "#7a7a7a","#5a6878","#3060c2","#0b8796","#1e7534","#c02020","#c86a10","#9e8910","#7020a8",
  // pastel
  "#f0f0f0","#c0d8ff","#a8c2ff","#a8eaf5","#b6edcc","#ffc0c0","#ffd0a0","#fff0a0","#d5b8ff",
];

const HL_COLORS = [
  // row 1
  "#ffff00","#b4ff8c","#8cd8ff","#ffb8b8","#ffc87a","#f0acff","#8cffe8","#ffeea0","#c8ffb8",
  // row 2
  "#ffd700","#78f078","#64c8f0","#ff7878","#ffaa40","#dd78ff","#50e0c8","#f5e060","#90f090",
  // row 3
  "#e8a800","#20c060","#2090d8","#f04040","#e06000","#a040e0","#10b8a8","#c8b800","#50b850",
  // row 4
  "#c07800","#108040","#1050a0","#a01010","#803800","#680090","#006878","#887800","#287828",
];

const ALIGN_ICONS: Record<string, JSX.Element> = {
  left:    <IcAlignLeft/>,
  center:  <IcAlignCenter/>,
  right:   <IcAlignRight/>,
  justify: <IcAlignJustify/>,
};

const ALIGN_LABELS: Record<string, string> = {
  left: "note.align.left", center: "note.align.center", right: "note.align.right", justify: "note.align.justify",
};

const LINE_HEIGHTS = [
  { labelKey: "note.lineHeight.compact", value: "1" },
  { label: "1.15",       value: "1.15" },
  { labelKey: "note.lineHeight.default", value: "1.5" },
  { labelKey: "note.lineHeight.double", value: "2" },
  { label: "2.5",        value: "2.5" },
  { label: "3.0",        value: "3" },
];

// ── Toolbar state helpers ─────────────────────────────────────────────────────

function getBlockLabel(ed: Editor) {
  for (let i = 1; i <= 6; i++) {
    if (ed.isActive("heading", { level: i })) return `H${i}`;
  }
  return i18nT("note.block.paragraph");
}

function getCurrentFontLabel(ed: Editor) {
  const ff = ed.getAttributes("textStyle").fontFamily as string | undefined;
  if (!ff) return i18nT("note.font.default");
  const font = FONT_FAMILIES.find(f => f.value === ff);
  return font ? i18nT(font.labelKey ?? font.label) : i18nT("note.font.fallback");
}

function getCurrentFontSize(ed: Editor) {
  const fs = ed.getAttributes("textStyle").fontSize as string | undefined;
  return fs ? fs.replace("px", "") : "14";
}

function getCurrentAlign(ed: Editor) {
  for (const a of ["left","center","right","justify"]) {
    if (ed.isActive({ textAlign: a })) return a;
  }
  return "left";
}

// ── TableGridPicker ───────────────────────────────────────────────────────────

function TableGridPicker({ onSelect }: { onSelect: (r: number, c: number) => void }) {
  useT();
  const [hover, setHover] = useState({ r: 0, c: 0 });
  const R = 8, C = 8;
  return (
    <div className="note-tb-tgrid-wrap">
      <div className="note-tb-tgrid">
        {Array.from({ length: R }, (_, ri) =>
          Array.from({ length: C }, (_, ci) => (
            <div
              key={`${ri}-${ci}`}
              className={`note-tb-tgrid-cell${ri <= hover.r && ci <= hover.c ? " active" : ""}`}
              onMouseEnter={() => setHover({ r: ri, c: ci })}
              onMouseDown={e => { e.preventDefault(); onSelect(ri + 1, ci + 1); }}
            />
          ))
        )}
      </div>
      <div className="note-tb-tgrid-label">{i18nT("note.tableGrid", { rows: hover.r + 1, cols: hover.c + 1 })}</div>
    </div>
  );
}

// ── ColorPalette ──────────────────────────────────────────────────────────────

const DIAGONAL_SLASH = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <line x1="0.5" y1="9.5" x2="9.5" y2="0.5" stroke="var(--fg-dim)" strokeWidth="1.2"/>
  </svg>
);
const EMPTY_SLOT_SLASH = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <line x1="0.5" y1="9.5" x2="9.5" y2="0.5" stroke="var(--border)" strokeWidth="1"/>
  </svg>
);

function ColorPalette({ colors, onSelect, onCustom, customValue, recentColors, defaultSwatch }: {
  colors: string[];
  onSelect: (c: string) => void;
  onCustom: (c: string) => void;
  customValue: string;
  recentColors: string[];
  defaultSwatch: string; // "var(--fg)" for text, "" for highlight (= diagonal slash)
}) {
  useT();
  const cellBase: React.CSSProperties = {
    width: 20, height: 20, borderRadius: 3, flexShrink: 0,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  return (
    <>
      {/* Default / unset */}
      <div className="note-tb-color-default" onMouseDown={e => { e.preventDefault(); onSelect(""); }}>
        {defaultSwatch ? (
          <span style={{ ...cellBase, background: defaultSwatch, border: "1px solid rgba(255,255,255,0.12)" }}/>
        ) : (
          <span style={{ ...cellBase, background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}>
            {DIAGONAL_SLASH}
          </span>
        )}
        <span>{i18nT("note.default")}</span>
      </div>

      {/* Main 9-column grid */}
      <div className="note-tb-color-grid">
        {colors.map((c, i) => (
          <div key={i} className="note-tb-color-cell" data-tooltip={c}
            style={{ background: c }}
            onMouseDown={e => { e.preventDefault(); onSelect(c); }}
          />
        ))}
      </div>

      {/* Recently used */}
      <div className="note-tb-color-recent-label">{i18nT("note.recentColors")}</div>
      <div className="note-tb-color-grid" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
        {Array.from({ length: 8 }).map((_, i) => {
          const c = recentColors[i];
          return (
            <div key={i} className="note-tb-color-cell"
              style={{ background: c || "rgba(255,255,255,0.03)" }}
              onMouseDown={e => { e.preventDefault(); if (c) onSelect(c); }}>
              {!c && EMPTY_SLOT_SLASH}
            </div>
          );
        })}
      </div>

      <div className="note-tb-color-sep"/>

      {/* Custom color picker */}
      <label className="note-tb-color-custom">
        <IcPalette/>
        <span>{i18nT("note.customColor")}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.88em" }}>›</span>
        <input type="color" value={customValue || "#ffffff"}
          onMouseDown={e => e.stopPropagation()}
          onChange={e => onCustom(e.target.value)}
        />
      </label>
    </>
  );
}

// ── Insert-menu & block-type icons ───────────────────────────────────────────

const IcImgIns = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/>
    <circle cx="5.5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/>
    <path d="M1.5 11.5 5 8l2.5 2.5 2-2 5 5"/>
  </svg>
);
const IcTableIns = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1"/>
    <line x1="1.5" y1="6.5" x2="14.5" y2="6.5"/>
    <line x1="1.5" y1="10.5" x2="14.5" y2="10.5"/>
    <line x1="6" y1="2.5" x2="6" y2="13.5"/>
    <line x1="10.5" y1="2.5" x2="10.5" y2="13.5"/>
  </svg>
);
const IcCodeIns = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>
  </svg>
);
const IcHrIns = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="1" y1="8" x2="15" y2="8"/>
    <line x1="1" y1="5.5" x2="1" y2="10.5"/>
    <line x1="15" y1="5.5" x2="15" y2="10.5"/>
  </svg>
);
const IcQuoteIns = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 3.5h3.5V7H4A1.5 1.5 0 002.5 8.5V10H6V8.5H4.5V7H6V3.5H2zm6 0h3.5V7H10A1.5 1.5 0 008.5 8.5V10H12V8.5H10.5V7H12V3.5H8z" opacity=".85"/>
  </svg>
);
const IcCalloutIns = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>
    <line x1="4.5" y1="6" x2="11.5" y2="6"/>
    <line x1="4.5" y1="9" x2="9" y2="9"/>
  </svg>
);
const IcHighlighter = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.5 2.5l3 3-7 7H3.5v-3l7-7z"/>
    <line x1="8.5" y1="4.5" x2="11.5" y2="7.5" strokeWidth="0.9"/>
    <line x1="3.5" y1="13" x2="6.5" y2="13" strokeWidth="2.2"/>
  </svg>
);
const IcPalette = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M8 1.5A6.5 6.5 0 1 0 13.5 9c0-1.1-.9-2-2-2H10a2 2 0 0 1-2-2V3.5"/>
    <circle cx="5"  cy="6"  r="1" fill="currentColor" stroke="none"/>
    <circle cx="4"  cy="9"  r="1" fill="currentColor" stroke="none"/>
    <circle cx="7"  cy="11" r="1" fill="currentColor" stroke="none"/>
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>
    <circle cx="11" cy="7"  r="1" fill="currentColor" stroke="none"/>
  </svg>
);
const BlockIc = ({ level }: { level?: 1|2|3|4|5|6 }) =>
  level ? (
    <span style={{ fontWeight: 800, fontSize: 11, lineHeight: 1, display: "flex", alignItems: "baseline" }}>
      H<sub style={{ fontSize: "0.62em", fontWeight: 800 }}>{level}</sub>
    </span>
  ) : (
    <span style={{ fontFamily: '"Times New Roman", Georgia, serif', fontWeight: 700, fontSize: 14, lineHeight: 1 }}>T</span>
  );

// ── NoteToolbar ───────────────────────────────────────────────────────────────

function NoteToolbar({ editor, onSave }: { editor: Editor | null; onSave: () => void }) {
  useT();
  const [panel,          setPanel]      = useState<string | null>(null);
  const [popupPos,       setPos]        = useState({ left: 0, top: 0 });
  const [hovSub,         setHovSub]     = useState<string | null>(null);
  const [hovSubPos,      setHovSubPos]  = useState({ left: 0, top: 0 });
  const [lastTxtColor,   setLTC]        = useState("");
  const [lastHlColor,    setLHC]        = useState("");
  const [recentTxtColors, setRecentTxt] = useState<string[]>([]);
  const [recentHlColors,  setRecentHl]  = useState<string[]>([]);
  const [overflowFrom,    setOF]         = useState(100);
  const tbRef       = useRef<HTMLDivElement>(null);
  const innerRef    = useRef<HTMLDivElement>(null);
  const moreRef     = useRef<HTMLButtonElement>(null);
  const popupRef    = useRef<HTMLDivElement>(null);
  const fileRef     = useRef<HTMLInputElement>(null);
  const groupRefs   = useRef<(HTMLElement | null)[]>([]);
  const hovTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calcRef     = useRef<() => void>(() => {});
  const act = useCallback((fn: () => void) => { fn(); onSave(); }, [onSave]);

  // Open a panel, anchored below the clicked button
  const openAt = useCallback((name: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ left: rect.left, top: rect.bottom + 4 });
    setPanel(p => p === name ? null : name);
    setHovSub(null);
  }, []);

  const close = useCallback(() => { setPanel(null); setHovSub(null); }, []);

  const addRecentTxt = useCallback((c: string) => {
    if (!c) return;
    setRecentTxt(p => [c, ...p.filter(x => x !== c)].slice(0, 8));
  }, []);
  const addRecentHl = useCallback((c: string) => {
    if (!c) return;
    setRecentHl(p => [c, ...p.filter(x => x !== c)].slice(0, 8));
  }, []);

  // Hover submenu (for table grid inside insert panel)
  const enterHovSub = useCallback((name: string, e: React.MouseEvent) => {
    if (hovTimerRef.current) clearTimeout(hovTimerRef.current);
    const item      = e.currentTarget as HTMLElement;
    const popupRect = popupRef.current?.getBoundingClientRect() ?? item.getBoundingClientRect();
    const itemRect  = item.getBoundingClientRect();
    setHovSubPos({ left: popupRect.right + 4, top: itemRect.top });
    setHovSub(name);
  }, []);

  const leaveHovSub = useCallback(() => {
    hovTimerRef.current = setTimeout(() => setHovSub(null), 150);
  }, []);

  const keepHovSub = useCallback(() => {
    if (hovTimerRef.current) clearTimeout(hovTimerRef.current);
  }, []);

  // Close on outside click (checks both toolbar and the portal popup)
  useEffect(() => {
    if (!panel) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!tbRef.current?.contains(t) && !popupRef.current?.contains(t)) setPanel(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [panel]);

  useEffect(() => () => { if (hovTimerRef.current) clearTimeout(hovTimerRef.current); }, []);

  // ── Overflow computation ───────────────────────────────────────────────────
  const computeOverflow = useCallback(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const avail = inner.clientWidth;
    let used = 0;
    for (let i = 0; i < groupRefs.current.length; i++) {
      const w = groupRefs.current[i]?.offsetWidth ?? 0;
      if (i === 0 && !w) return;
      used += w;
      if (used > avail) { setOF(p => p === i ? p : i); return; }
    }
    const n = groupRefs.current.length;
    setOF(p => p === n ? p : n);
  }, []);
  calcRef.current = computeOverflow;

  useLayoutEffect(() => {
    if (!editor) return;
    calcRef.current();
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const tb = tbRef.current;
    if (!tb) return;
    const ro = new ResizeObserver(() => calcRef.current());
    ro.observe(tb);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clamp portal popup to viewport edges after it renders
  useLayoutEffect(() => {
    if (!panel || !popupRef.current) return;
    const el   = popupRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    if (rect.right > window.innerWidth - margin) {
      el.style.left = `${window.innerWidth - margin - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight - margin) {
      el.style.top = `${popupPos.top - rect.height - 8}px`;
    }
  }, [panel, popupPos]);

  if (!editor) return <div className="note-toolbar"/>;

  const activeAlign = getCurrentAlign(editor);

  const handleImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        editor.chain().focus().setImage({ src: reader.result }).run();
        onSave();
      }
    };
    reader.readAsDataURL(file);
  };

  const handleLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt(i18nT("note.linkPrompt"), prev ?? "https://");
    if (url === null) return;
    if (url === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().setLink({ href: url, target: "_blank" }).run();
    onSave();
  };

  // ── Toolbar groups (also reused in the "more" overflow popup) ────────────

  const groups: { key: string; isSep?: boolean; el: JSX.Element }[] = [
    { key: "insert", el: (
      <button className="note-tb-dd" onMouseDown={e => { e.preventDefault(); openAt("insert", e); }}>
        {i18nT("note.insert")} <IcChevDown/>
      </button>
    )},
    { key: "s1", isSep: true, el: <span className="note-tb-sep"/> },
    { key: "textfmt", el: (
      <>
        <button className="note-tb-dd" style={{ width: 58 }} onMouseDown={e => { e.preventDefault(); openAt("blockType", e); }}>
          <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getBlockLabel(editor)}</span>
          <IcChevDown/>
        </button>
        <button className="note-tb-dd" style={{ width: 74 }} onMouseDown={e => { e.preventDefault(); openAt("fontFamily", e); }}>
          <span className="note-tb-dd-label">{getCurrentFontLabel(editor)}</span>
          <IcChevDown/>
        </button>
        <button className="note-tb-dd" style={{ width: 42 }} onMouseDown={e => { e.preventDefault(); openAt("fontSize", e); }}>
          {getCurrentFontSize(editor)} <IcChevDown/>
        </button>
      </>
    )},
    { key: "s2", isSep: true, el: <span className="note-tb-sep"/> },
    { key: "bius", el: (
      <>
        <button className={`note-tb-btn${editor.isActive("bold") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.bold")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleBold().run()); }}>
          <b>B</b>
        </button>
        <button className={`note-tb-btn${editor.isActive("italic") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.italic")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleItalic().run()); }}>
          <i>I</i>
        </button>
        <button className={`note-tb-btn${editor.isActive("underline") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.underline")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleUnderline().run()); }}>
          <u>U</u>
        </button>
        <button className={`note-tb-btn${editor.isActive("strike") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.strike")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleStrike().run()); }}>
          <s>S</s>
        </button>
      </>
    )},
    { key: "s3", isSep: true, el: <span className="note-tb-sep"/> },
    { key: "colors", el: (
      <>
        <div className="note-tb-wrap">
          <button className="note-tb-btn note-tb-color-btn"
            data-tooltip={i18nT("note.applyTextColor")}
            onMouseDown={e => {
              e.preventDefault();
              act(() => lastTxtColor
                ? editor.chain().focus().setColor(lastTxtColor).run()
                : (editor.chain().focus() as any).unsetColor().run());
            }}>
            <b>A</b>
            <span className="note-tb-color-bar" style={{ background: lastTxtColor || "var(--fg)" }}/>
          </button>
          <button className="note-tb-arr" onMouseDown={e => { e.preventDefault(); openAt("textColor", e); }}>
            <IcChevDown/>
          </button>
        </div>
        <div className="note-tb-wrap">
          <button className="note-tb-btn note-tb-color-btn"
            data-tooltip={i18nT("note.applyHighlight")}
            onMouseDown={e => {
              e.preventDefault();
              act(() => lastHlColor
                ? editor.chain().focus().setHighlight({ color: lastHlColor }).run()
                : editor.chain().focus().unsetHighlight().run());
            }}>
            <IcHighlighter/>
            <span className="note-tb-color-bar"
              style={{ background: lastHlColor || "transparent", border: lastHlColor ? "none" : "1px solid var(--border)" }}/>
          </button>
          <button className="note-tb-arr" onMouseDown={e => { e.preventDefault(); openAt("hlColor", e); }}>
            <IcChevDown/>
          </button>
        </div>
      </>
    )},
    { key: "s4", isSep: true, el: <span className="note-tb-sep"/> },
    { key: "lists", el: (
      <>
        <button className={`note-tb-btn${editor.isActive("bulletList") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.bulletList")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleBulletList().run()); }}>
          •≡
        </button>
        <button className={`note-tb-btn${editor.isActive("orderedList") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.orderedList")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleOrderedList().run()); }}>
          1≡
        </button>
      </>
    )},
    { key: "s5", isSep: true, el: <span className="note-tb-sep"/> },
    { key: "layout", el: (
      <>
        <button className="note-tb-btn" data-tooltip={i18nT("note.align")}
          onMouseDown={e => { e.preventDefault(); openAt("align", e); }}>
          {ALIGN_ICONS[activeAlign]}
        </button>
        <button className="note-tb-btn" data-tooltip={i18nT("note.indent")}
          onMouseDown={e => {
            e.preventDefault();
            if (editor.isActive("taskItem"))      act(() => editor.chain().focus().sinkListItem("taskItem").run());
            else if (editor.isActive("listItem")) act(() => editor.chain().focus().sinkListItem("listItem").run());
          }}>→|</button>
        <button className="note-tb-btn" data-tooltip={i18nT("note.outdent")}
          onMouseDown={e => {
            e.preventDefault();
            if (editor.isActive("taskItem"))      act(() => editor.chain().focus().liftListItem("taskItem").run());
            else if (editor.isActive("listItem")) act(() => editor.chain().focus().liftListItem("listItem").run());
          }}>|←</button>
        <button className="note-tb-dd" onMouseDown={e => { e.preventDefault(); openAt("lineHeight", e); }}>
          {i18nT("note.lineHeight")} <IcChevDown/>
        </button>
      </>
    )},
    { key: "s6", isSep: true, el: <span className="note-tb-sep"/> },
    { key: "misc", el: (
      <>
        <button className={`note-tb-btn${editor.isActive("taskList") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.taskList")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleTaskList().run()); }}>
          ☑
        </button>
        <button className={`note-tb-btn${editor.isActive("link") ? " is-active" : ""}`}
          data-tooltip={i18nT("note.insertLink")}
          onMouseDown={e => { e.preventDefault(); handleLink(); }}>
          <IcLink/>
        </button>
        <button className="note-tb-btn" data-tooltip={i18nT("note.clearFormat")}
          onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().clearNodes().unsetAllMarks().run()); }}>
          <IcClearFormat/>
        </button>
      </>
    )},
  ];
  const hasOverflow = overflowFrom < groups.length;

  // ── Portal popup content ──────────────────────────────────────────────────

  const popupContent = (() => {
    switch (panel) {
      case "insert": return (
        <>
          <div className="note-tb-popup-item" onMouseDown={e => { e.preventDefault(); fileRef.current?.click(); close(); }}>
            <span className="note-tb-item-ic"><IcImgIns/></span>{i18nT("note.image")}
          </div>
          <div className="note-tb-popup-item" onMouseEnter={e => enterHovSub("tableGrid", e)} onMouseLeave={leaveHovSub}>
            <span className="note-tb-item-ic"><IcTableIns/></span>{i18nT("note.table")}
            <span className="note-tb-item-sub">›</span>
          </div>
          <div className="note-tb-popup-item" onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleCodeBlock().run()); close(); }}>
            <span className="note-tb-item-ic"><IcCodeIns/></span>{i18nT("note.codeBlock")}
          </div>
          <div className="note-tb-popup-item" onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().setHorizontalRule().run()); close(); }}>
            <span className="note-tb-item-ic"><IcHrIns/></span>{i18nT("note.hr")}
          </div>
          <div className="note-tb-popup-sep"/>
          <div className="note-tb-popup-item" onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleBlockquote().run()); close(); }}>
            <span className="note-tb-item-ic"><IcQuoteIns/></span>{i18nT("note.quote")}
          </div>
          <div className="note-tb-popup-item" onMouseDown={e => { e.preventDefault(); act(() => (editor.chain().focus() as any).toggleCallout().run()); close(); }}>
            <span className="note-tb-item-ic"><IcCalloutIns/></span>{i18nT("note.callout")}
          </div>
        </>
      );
      case "blockType": return (
        <>
          <div className="note-tb-popup-item"
            onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().setParagraph().run()); close(); }}>
            <span className="note-tb-item-ic"><BlockIc/></span>
            <span>{i18nT("note.block.paragraph")}</span>
            {!editor.isActive("heading") && <span className="note-tb-item-chk">✓</span>}
          </div>
          {([1,2,3,4,5,6] as const).map(lv => (
            <div key={lv} className="note-tb-popup-item"
              onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().toggleHeading({ level: lv }).run()); close(); }}>
              <span className="note-tb-item-ic"><BlockIc level={lv}/></span>
              <span>{i18nT("note.block.heading", { level: i18nT(`note.heading.${lv}`) })}</span>
              {editor.isActive("heading", { level: lv }) && <span className="note-tb-item-chk">✓</span>}
            </div>
          ))}
        </>
      );
      case "fontFamily": return (
        <>
          {FONT_FAMILIES.map(f => (
            <div key={f.label} className="note-tb-popup-item"
              style={{ fontFamily: f.value || undefined }}
              onMouseDown={e => {
                e.preventDefault();
                act(() => f.value ? editor.chain().focus().setFontFamily(f.value).run()
                  : editor.chain().focus().unsetFontFamily().run());
                close();
              }}>
              {f.label}
            </div>
          ))}
        </>
      );
      case "fontSize": return (
        <div style={{ maxHeight: 200, overflowY: "auto" }}>
          {FONT_SIZES.map(s => (
            <div key={s} className="note-tb-popup-item"
              onMouseDown={e => {
                e.preventDefault();
                act(() => (editor.chain().focus() as any).setFontSize(`${s}px`).run());
                close();
              }}>
              {s}
            </div>
          ))}
        </div>
      );
      case "textColor": return (
        <ColorPalette
          colors={TEXT_COLORS}
          defaultSwatch="var(--fg)"
          customValue={lastTxtColor}
          recentColors={recentTxtColors}
          onSelect={c => {
            if (c) setLTC(c);
            addRecentTxt(c);
            act(() => c ? editor.chain().focus().setColor(c).run()
              : (editor.chain().focus() as any).unsetColor().run());
            close();
          }}
          onCustom={c => { setLTC(c); addRecentTxt(c); editor.chain().focus().setColor(c).run(); onSave(); }}
        />
      );
      case "hlColor": return (
        <ColorPalette
          colors={HL_COLORS}
          defaultSwatch=""
          customValue={lastHlColor}
          recentColors={recentHlColors}
          onSelect={c => {
            if (c) setLHC(c);
            addRecentHl(c);
            act(() => c ? editor.chain().focus().setHighlight({ color: c }).run()
              : editor.chain().focus().unsetHighlight().run());
            close();
          }}
          onCustom={c => { setLHC(c); addRecentHl(c); editor.chain().focus().setHighlight({ color: c }).run(); onSave(); }}
        />
      );
      case "align": return (
        <>
          {(["left","center","right","justify"] as const).map(a => (
            <div key={a}
              className={`note-tb-popup-item${editor.isActive({ textAlign: a }) ? " is-active" : ""}`}
              onMouseDown={e => { e.preventDefault(); act(() => editor.chain().focus().setTextAlign(a).run()); close(); }}>
              <span style={{ marginRight: 6, display: "inline-flex", verticalAlign: "middle" }}>{ALIGN_ICONS[a]}</span>
              {ALIGN_LABELS[a]}
            </div>
          ))}
        </>
      );
      case "lineHeight": return (
        <>
          {LINE_HEIGHTS.map(lh => (
            <div key={lh.value} className="note-tb-popup-item"
              onMouseDown={e => {
                e.preventDefault();
                act(() => (editor.chain().focus() as any).setLineHeight(lh.value).run());
                close();
              }}>
              {lh.label}
            </div>
          ))}
        </>
      );
      case "more": return (
        <div className="note-tb-more-panel">
          {groups.slice(overflowFrom).filter(g => !g.isSep).map(g => (
            <span key={g.key} style={{ display: "flex", alignItems: "center" }}>
              {g.el}
            </span>
          ))}
        </div>
      );
      default: return null;
    }
  })();

  const isColorPanel = panel === "textColor" || panel === "hlColor";

  return (
    <>
    <div ref={tbRef} className="note-toolbar">
      <div ref={innerRef} className="note-toolbar-inner">
        {groups.map((g, i) => (
          <span key={g.key}
            ref={el => { groupRefs.current[i] = el; }}
            className={i >= overflowFrom ? "note-tb-slot-hidden" : "note-tb-slot"}>
            {g.el}
          </span>
        ))}
      </div>
      <button ref={moreRef}
        className="note-tb-btn note-tb-more-btn"
        style={{ visibility: hasOverflow ? "visible" : "hidden" }}
        data-tooltip={i18nT("note.more")}
        onMouseDown={e => { e.preventDefault(); openAt("more", e); }}>
        ···
      </button>

      {/* hidden file input for image upload */}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImage}/>
    </div>

    {panel && popupContent && createPortal(
      <>
        <div
          ref={popupRef}
          className={isColorPanel ? "note-tb-color-popup" : "note-tb-popup"}
          style={{ position: "fixed", left: popupPos.left, top: popupPos.top, zIndex: 9999,
            ...(isColorPanel ? { padding: 8, minWidth: 228 } : {}) }}
          onMouseDown={e => e.stopPropagation()}
        >
          {popupContent}
        </div>
        {panel === "insert" && hovSub === "tableGrid" && (
          <div
            className="note-tb-popup"
            style={{ position: "fixed", left: hovSubPos.left, top: hovSubPos.top, zIndex: 9999, padding: 8 }}
            onMouseEnter={keepHovSub}
            onMouseLeave={leaveHovSub}
            onMouseDown={e => e.stopPropagation()}
          >
            <TableGridPicker onSelect={(r, c) => {
              editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: true }).run();
              onSave(); close();
            }}/>
          </div>
        )}
      </>,
      document.body
    )}
    </>
  );
}

// ── NoteDialog ────────────────────────────────────────────────────────────────

export default function NoteDialog({ onClose, mode = "dialog", width }: Props) {
  useT();
  const [items,            setItems]            = useState<Note[]>([]);
  const [selectedNote,     setSelectedNote]     = useState<Note | null>(null);
  const [activeFolderId,   setActiveFolderId]   = useState<string | null>(null);
  const [expanded,         setExpanded]         = useState<Set<string>>(new Set());
  const [renaming,         setRenaming]         = useState<{ id: string; value: string } | null>(null);
  const [inlineFolder,     setInlineFolder]     = useState<{ parentId: string | null; name: string } | null>(null);
  const [addMenu,          setAddMenu]          = useState<AddMenu>(null);
  const [ctxMenu,          setCtxMenu]          = useState<CtxMenu>(null);
  const [sidebarWidth,     setSidebarWidth]     = useState(220);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const titleInputRef        = useRef<HTMLInputElement>(null);
  const saveTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedNoteRef      = useRef<Note | null>(null);
  const editorInstanceRef    = useRef<Editor | null>(null);
  const inlineFolderInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef           = useRef<HTMLDivElement>(null);
  const ctxMenuRef           = useRef<HTMLDivElement>(null);
  selectedNoteRef.current    = selectedNote;

  const { confirmState, confirm: confirmDlg, handleOk, handleCancel } = useConfirm();

  // ── Tiptap editor ─────────────────────────────────────────────────────────

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1,2,3,4,5,6] } }),
      Underline,
      TextAlign.configure({ types: ["heading","paragraph"] }),
      FontFamily,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: true }),
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      FontSizeExt,
      LineHeightExt,
      CalloutNode,
    ],
    content: "",
    editorProps: {
      attributes: { "data-placeholder": i18nT("note.editorPlaceholder") },
    },
    onUpdate: ({ editor: ed }) => {
      editorInstanceRef.current = ed;
      scheduleSave();
    },
  });

  useEffect(() => { editorInstanceRef.current = editor; }, [editor]);

  useEffect(() => {
    editor?.view.dom.setAttribute("data-placeholder", i18nT("note.editorPlaceholder"));
  });

  // Sync editor content when selected note changes
  useEffect(() => {
    if (!editor) return;
    if (!selectedNote || selectedNote.isFolder) return;
    editor.commands.setContent(selectedNote.content || "");
    if (titleInputRef.current) titleInputRef.current.value = selectedNote.name;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNote?.id, editor]);

  // ── Data loading ──────────────────────────────────────────────────────────

  const load = useCallback(async (): Promise<Note[]> => {
    try {
      const list = await invoke<Note[]>("note_list");
      setItems(list);
      return list;
    } catch { return []; }
  }, []);

  // Initial load: restore last note + expanded state from DB settings
  useEffect(() => {
    Promise.all([
      load(),
      invoke<string | null>("settings_get", { key: "note.lastNoteId" }),
      invoke<string | null>("settings_get", { key: "note.expandedIds" }),
    ]).then(([list, lastId, expandedRaw]) => {
      if (expandedRaw) {
        try { setExpanded(new Set(JSON.parse(expandedRaw) as string[])); } catch { /**/ }
      }
      if (lastId) {
        const note = list.find(i => i.id === lastId && !i.isFolder);
        if (note) setSelectedNote(note);
      }
    });
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist selected note ID to DB
  useEffect(() => {
    if (selectedNote && !selectedNote.isFolder) {
      invoke("settings_set", { key: "note.lastNoteId", value: selectedNote.id }).catch(() => {});
    }
  }, [selectedNote?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist expanded folder IDs to DB
  useEffect(() => {
    invoke("settings_set", { key: "note.expandedIds", value: JSON.stringify([...expanded]) })
      .catch(() => {});
  }, [expanded]);

  useEffect(() => {
    if (inlineFolder) inlineFolderInputRef.current?.focus();
  }, [inlineFolder]);

  useEffect(() => {
    if (!addMenu) return;
    const h = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as HTMLElement)) setAddMenu(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [addMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onM = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as HTMLElement)) setCtxMenu(null);
    };
    const onK = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("mousedown", onM);
    document.addEventListener("keydown", onK);
    return () => { document.removeEventListener("mousedown", onM); document.removeEventListener("keydown", onK); };
  }, [ctxMenu]);

  // ── Resize ────────────────────────────────────────────────────────────────

  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => setSidebarWidth(Math.max(160, Math.min(480, startW + ev.clientX - startX)));
    const onUp   = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── Save ──────────────────────────────────────────────────────────────────

  const doSave = useCallback(async (note: Note, content: string, name: string) => {
    try {
      await invoke("note_save", { note: { ...note, content, name, updateDate: 0 } });
    } catch { }
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const note = selectedNoteRef.current;
      if (!note || note.isFolder) return;
      void doSave(note, editorInstanceRef.current?.getHTML() ?? "", titleInputRef.current?.value || note.name);
    }, 600);
  }, [doSave]);

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const createNote = async (parentId: string | null) => {
    setAddMenu(null); setCtxMenu(null);
    try {
      const prevIds = new Set(items.map(i => i.id));
      await invoke("note_save", {
        note: { id: "", name: i18nT("note.newNote"), content: "", group: "", parentId: parentId ?? null, isFolder: false, sort: Date.now(), createDate: 0, updateDate: 0 },
      });
      if (parentId) setExpanded(e => new Set([...e, parentId]));
      const newItems = await load();
      const newNote  = newItems.find(i => !prevIds.has(i.id) && !i.isFolder);
      if (newNote) {
        setSelectedNote(newNote);
        setTimeout(() => { titleInputRef.current?.select(); titleInputRef.current?.focus(); }, 0);
      }
    } catch { }
  };

  const startInlineFolder = (parentId: string | null) => {
    setAddMenu(null); setCtxMenu(null);
    if (parentId) setExpanded(e => new Set([...e, parentId]));
    setInlineFolder({ parentId, name: "" });
  };

  const commitInlineFolder = async () => {
    if (!inlineFolder) return;
    const name = inlineFolder.name.trim() || i18nT("note.newFolder");
    setInlineFolder(null);
    try {
      await invoke("note_save", {
        note: { id: "", name, content: "", group: "", parentId: inlineFolder.parentId, isFolder: true, sort: Date.now(), createDate: 0, updateDate: 0 },
      });
      await load();
    } catch { }
  };

  const deleteNote = async (item: Note) => {
    setCtxMenu(null);
    const ok = await confirmDlg(i18nT("note.deleteConfirm", { name: item.name, suffix: item.isFolder ? i18nT("note.deleteFolderSuffix") : "" }));
    if (!ok) return;
    try {
      const toDelete: string[] = [item.id];
      const collect = (pid: string) => {
        items.filter(i => i.parentId === pid).forEach(i => { toDelete.push(i.id); if (i.isFolder) collect(i.id); });
      };
      if (item.isFolder) collect(item.id);
      for (const id of toDelete) await invoke("note_remove", { id });
      if (selectedNote && toDelete.includes(selectedNote.id)) setSelectedNote(null);
      await load();
    } catch { }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    const item = items.find(i => i.id === id);
    if (item && value.trim()) {
      await invoke("note_save", { note: { ...item, name: value.trim() } });
      if (selectedNote?.id === id) setSelectedNote(s => s ? { ...s, name: value.trim() } : s);
      await load();
    }
  };

  // ── Tree rendering ────────────────────────────────────────────────────────

  function AddMenuPopup({ parentId }: { parentId: string | null }) {
    return (
      <div ref={addMenuRef} className="note-add-menu" onClick={e => e.stopPropagation()}>
        <div className="note-add-menu-item" onMouseDown={e => { e.preventDefault(); void createNote(parentId); }}>
          <IcNote/> {i18nT("note.note")}
        </div>
        <div className="note-add-menu-sep"/>
        <div className="note-add-menu-item" onMouseDown={e => { e.preventDefault(); startInlineFolder(parentId); }}>
          <IcFolder open={false}/> {i18nT("note.folder")}
        </div>
      </div>
    );
  }

  function renderTree(parentId: string | null, depth: number) {
    const children    = sortedChildren(items, parentId);
    const inlineInput = inlineFolder?.parentId === parentId ? (
      <div key="__inline__" className="tree-row" style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="tree-arrow"/>
        <span className="tree-icon"><IcFolder open={false}/></span>
        <input
          ref={inlineFolderInputRef}
          className="tree-rename-input"
          value={inlineFolder!.name}
          placeholder={i18nT("note.newFolder")}
          onChange={e => setInlineFolder(p => p ? { ...p, name: e.target.value } : null)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); void commitInlineFolder(); }
            if (e.key === "Escape") setInlineFolder(null);
          }}
          onBlur={() => void commitInlineFolder()}
          onClick={e => e.stopPropagation()}
        />
      </div>
    ) : null;

    return (
      <>
        {children.map(item => {
          const isFolder   = item.isFolder;
          const isOpen     = expanded.has(item.id);
          const isSelected = isFolder ? activeFolderId === item.id : selectedNote?.id === item.id;
          const isRenaming = renaming?.id === item.id;
          const isMenuOpen = addMenu?.parentId === item.id;

          return (
            <div key={item.id} className="tree-node">
              <div
                className={`tree-row${isSelected ? " tree-row--selected" : ""}`}
                style={{ paddingLeft: 8 + depth * 16, position: "relative" }}
                onClick={() => {
                  if (isFolder) {
                    setExpanded(e => { const n = new Set(e); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; });
                    setActiveFolderId(item.id);
                  } else {
                    setSelectedNote(item);
                  }
                }}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation();
                  setAddMenu(null);
                  setCtxMenu({ x: e.clientX, y: e.clientY, item });
                }}
              >
                <span className="tree-arrow">
                  {isFolder ? (isOpen ? <IcChevDown/> : <IcChevRight/>) : null}
                </span>
                <span className="tree-icon">
                  {isFolder ? <IcFolder open={isOpen}/> : <IcNote/>}
                </span>
                {isRenaming ? (
                  <input
                    autoFocus
                    className="tree-rename-input"
                    value={renaming!.value}
                    onChange={e => setRenaming({ id: item.id, value: e.target.value })}
                    onBlur={() => void commitRename()}
                    onKeyDown={e => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <div className="tree-label-group">
                    <span className="tree-label">{item.name}</span>
                  </div>
                )}
                {!isRenaming && isFolder && (
                  <div className="note-row-actions" onClick={e => e.stopPropagation()}>
                    <button
                      className={`note-add-btn${isMenuOpen ? " note-add-btn--open" : ""}`}
                      data-tooltip={i18nT("note.new")}
                      onClick={e => { e.stopPropagation(); setAddMenu(isMenuOpen ? null : { parentId: item.id }); }}
                    >
                      <IcPlus/>
                    </button>
                  </div>
                )}
                {isMenuOpen && <AddMenuPopup parentId={item.id}/>}
              </div>
              {isFolder && isOpen && renderTree(item.id, depth + 1)}
            </div>
          );
        })}
        {inlineInput}
      </>
    );
  }

  const isRootMenuOpen = addMenu?.parentId === null;

  // ── Shared body fragments ─────────────────────────────────────────────────

  const noteHeader = (
    <div className="dialog-header">
      <h2 className="dialog-title">{i18nT("note.title")}</h2>
      <button className="dialog-x" onClick={onClose}>✕</button>
    </div>
  );

  const noteBody = (
    <div className="note-body">
      {/* ── Collapsed bar ── */}
      {sidebarCollapsed ? (
        <div className="note-collapsed-bar" onClick={() => setSidebarCollapsed(false)}>
          <span data-tooltip={i18nT("note.expandTree")} style={{ display: "flex" }}><IcChevRight/></span>
        </div>
      ) : (
        <>
          {/* ── Left: note tree ── */}
          <div className="note-sidebar" style={{ width: sidebarWidth }}>
            <div className="note-tree-scroll">
              <div
                className={`tree-row${activeFolderId === null ? " tree-row--selected" : ""}`}
                style={{ paddingLeft: 8, position: "relative" }}
                onClick={() => setActiveFolderId(null)}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation();
                  setAddMenu(null);
                  setCtxMenu({ x: e.clientX, y: e.clientY, item: null });
                }}
              >
                <span className="tree-arrow"/>
                <span className="tree-icon"><IcFolder open={true}/></span>
                <div className="tree-label-group">
                  <span className="tree-label" style={{ fontWeight: 600 }}>{i18nT("note.all")}</span>
                </div>
                <div className="note-row-actions" onClick={e => e.stopPropagation()}>
                  <button
                    className={`note-add-btn${isRootMenuOpen ? " note-add-btn--open" : ""}`}
                    data-tooltip={i18nT("note.new")}
                    onClick={e => { e.stopPropagation(); setAddMenu(isRootMenuOpen ? null : { parentId: null }); }}
                  >
                    <IcPlus/>
                  </button>
                </div>
                {isRootMenuOpen && <AddMenuPopup parentId={null}/>}
              </div>
              {renderTree(null, 1)}
            </div>
          </div>

          {/* ── Resizer ── */}
          <div className="note-resizer" onMouseDown={onResizerMouseDown}>
            <button
              className="note-resizer-btn"
              onClick={e => { e.stopPropagation(); setSidebarCollapsed(true); }}
              data-tooltip={i18nT("note.collapseTree")}
              data-tooltip-pos="above"
            >
              <IcChevLeft/>
            </button>
          </div>
        </>
      )}

      {/* ── Right: editor ── */}
      <div className="note-editor-pane">
        {!selectedNote || selectedNote.isFolder ? (
          <div className="note-empty-editor">{i18nT("note.emptyEditor")}</div>
        ) : (
          <>
            <NoteToolbar editor={editor} onSave={scheduleSave}/>
            <input
              ref={titleInputRef}
              className="note-title-input"
              placeholder={i18nT("note.titlePlaceholder")}
              onBlur={e => {
                const newName = e.target.value.trim() || selectedNote.name;
                setSelectedNote(s => s ? { ...s, name: newName } : s);
                setItems(prev => prev.map(i => i.id === selectedNote.id ? { ...i, name: newName } : i));
                void doSave(selectedNote, editorInstanceRef.current?.getHTML() ?? "", newName);
              }}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
            <div className="note-editor">
              <EditorContent editor={editor}/>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const noteTail = (
    <>
      {/* ── Context menu ── */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="note-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {(!ctxMenu.item || ctxMenu.item.isFolder) && (
            <>
              <div className="note-ctx-item" onClick={() => void createNote(ctxMenu.item?.id ?? null)}>
                <IcNote/> {i18nT("note.note")}
              </div>
              <div className="note-ctx-item" onClick={() => startInlineFolder(ctxMenu.item?.id ?? null)}>
                <IcFolder open={false}/> {i18nT("note.folder")}
              </div>
            </>
          )}
          {ctxMenu.item?.isFolder && (
            <>
              <div className="note-ctx-sep"/>
              <div className="note-ctx-item" onClick={() => {
                const it = ctxMenu.item!;
                setCtxMenu(null);
                setRenaming({ id: it.id, value: it.name });
              }}>
                {i18nT("note.rename")}
              </div>
            </>
          )}
            {ctxMenu.item && (
              <>
                <div className="note-ctx-item note-ctx-item--danger" onClick={() => void deleteNote(ctxMenu.item!)}>
                  {i18nT("note.delete")}
                </div>
              </>
            )}
        </div>
      )}
      {confirmState && (
        <ConfirmDialog message={confirmState.message} onOk={handleOk} onCancel={handleCancel} okText={i18nT("note.delete")}/>
      )}
    </>
  );

  // ── Panel mode: inline flex panel, no overlay ─────────────────────────────
  if (mode === "panel") {
    return (
      <>
        <div className="note-panel-inner" style={width !== undefined ? { width } : undefined}>
          {noteHeader}
          {noteBody}
        </div>
        {noteTail}
      </>
    );
  }

  // ── Dialog mode: centered modal overlay ───────────────────────────────────
  return (
    <>
      <div className="dialog-overlay" onClick={onClose}>
        <div className="dialog dialog-note" onClick={e => e.stopPropagation()}>
          {noteHeader}
          {noteBody}
        </div>
      </div>
      {noteTail}
    </>
  );
}
