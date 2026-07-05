import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "./Toast";
import { setInstalledPluginProtocols, pluginSupportedOnPlatform } from "../protocols";
import { getSystemLang, useT } from "../i18n";
import CustomSelect from "./CustomSelect";

type Section = "appearance" | "terminal" | "keyshortcuts" | "sftp" | "plugins" | "about";

interface DiscoveredShell {
  id: string;
  name: string;
  command: string;
  args: string[];
  isDefault: boolean;
}

interface PluginManifest {
  id: string; name: string; version: string; kind: string;
  protocol?: string; description?: string; author?: string;
}

interface MarketEntry extends PluginManifest {
  installed: boolean;
  installedVersion?: string;
}

interface Settings {
  // Appearance
  theme: string;
  language: string;
  layout: string;
  opacity: number;
  backgroundRunning: boolean;
  confirmClose: boolean;
  // Terminal
  font: string;
  fallbackFont: string;
  fontSize: number;
  maxRows: number;
  startupLogs: boolean;
  hyperlink: boolean;
  selectCopy: boolean;
  rightClick: string;
  cursorStyle: string;
  cursorBlink: boolean;
  autoReconnect: boolean;
  localShell: string;
  // SFTP
  sftpPinTab: boolean;
  sftpEditCommand: string;
  sftpDoubleClick: string;
  sftpDefaultDir: string;
  sftpPreserveMtime: boolean;
  sftpClearDone: boolean;
}

const DEFAULTS: Settings = {
  theme: "Dark",
  language: getSystemLang(),
  layout: "Fence",
  opacity: 1.0,
  backgroundRunning: true,
  confirmClose: true,
  font: "JetBrains Mono",
  fallbackFont: "",
  fontSize: 14,
  maxRows: 5000,
  startupLogs: false,
  hyperlink: true,
  selectCopy: false,
  rightClick: "Menu",
  cursorStyle: "Block",
  cursorBlink: true,
  autoReconnect: false,
  localShell: "",
  sftpPinTab: false,
  sftpEditCommand: "",
  sftpDoubleClick: "Transfer",
  sftpDefaultDir: "",
  sftpPreserveMtime: true,
  sftpClearDone: false,
};

const FIELD_KEYS: Record<keyof Settings, string> = {
  theme:             "Setting.Appearance.theme",
  language:          "Setting.Appearance.language",
  layout:            "Setting.Appearance.layout",
  opacity:           "Setting.Appearance.opacity",
  backgroundRunning: "Setting.Appearance.backgroundRunning",
  confirmClose:      "Setting.Appearance.confirmClose",
  font:              "Setting.Terminal.font",
  fallbackFont:      "Setting.Terminal.fallbackFont",
  fontSize:          "Setting.Terminal.fontSize",
  maxRows:           "Setting.Terminal.maxRows",
  startupLogs:       "Setting.Terminal.startupLogs",
  hyperlink:         "Setting.Terminal.hyperlink",
  selectCopy:        "Setting.Terminal.selectCopy",
  rightClick:        "Setting.Terminal.rightClick",
  cursorStyle:       "Setting.Terminal.cursorStyle",
  cursorBlink:       "Setting.Terminal.cursorBlink",
  autoReconnect:     "Setting.Terminal.autoReconnect",
  localShell:        "Setting.Terminal.localShell",
  sftpPinTab:        "Setting.SFTP.pinTab",
  sftpEditCommand:   "Setting.SFTP.editCommand",
  sftpDoubleClick:   "Setting.SFTP.doubleClick",
  sftpDefaultDir:    "Setting.SFTP.defaultDir",
  sftpPreserveMtime: "Setting.SFTP.preserveMtime",
  sftpClearDone:     "Setting.SFTP.clearDone",
};

const SECTION_IDS: Section[] = ["appearance", "terminal", "keyshortcuts", "sftp", "plugins", "about"];

const SHORTCUT_KEYS: { key: string; windows: string; mac: string }[] = [
  { key: "shortcut.newHost",          windows: "Ctrl+N",         mac: "Cmd+N" },
  { key: "shortcut.toggleSidebar",    windows: "Ctrl+Shift+B",   mac: "Cmd+Shift+B" },
  { key: "shortcut.closeTab",         windows: "Ctrl+W",         mac: "Cmd+W" },
  { key: "shortcut.nextTab",          windows: "Ctrl+Tab",       mac: "Cmd+Tab" },
  { key: "shortcut.prevTab",          windows: "Ctrl+Shift+Tab", mac: "Cmd+Shift+Tab" },
  { key: "shortcut.settings",         windows: "Ctrl+Shift+S",   mac: "Cmd+Shift+S" },
  { key: "shortcut.keyManager",       windows: "Ctrl+Shift+K",   mac: "Cmd+Shift+K" },
  { key: "shortcut.newLocalTerminal", windows: "Ctrl+T",         mac: "Cmd+T" },
  { key: "shortcut.notes",            windows: "Ctrl+Shift+P",   mac: "Cmd+Shift+P" },
  { key: "shortcut.sftp",             windows: "Ctrl+Shift+G",   mac: "Cmd+Shift+G" },
  { key: "shortcut.highlight",        windows: "Ctrl+Shift+H",   mac: "Cmd+Shift+H" },
];

const VERSION = "0.1.0-alpha";

// ── Icons for pill selectors ─────────────────────────────────────────────
const IcoSun = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="7" cy="7" r="2.5"/>
    <line x1="7" y1="0.5" x2="7" y2="2.5"/><line x1="7" y1="11.5" x2="7" y2="13.5"/>
    <line x1="0.5" y1="7" x2="2.5" y2="7"/><line x1="11.5" y1="7" x2="13.5" y2="7"/>
    <line x1="2.44" y1="2.44" x2="3.86" y2="3.86"/><line x1="10.14" y1="10.14" x2="11.56" y2="11.56"/>
    <line x1="11.56" y1="2.44" x2="10.14" y2="3.86"/><line x1="3.86" y1="10.14" x2="2.44" y2="11.56"/>
  </svg>
);
const IcoMonitor = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="2" width="12" height="8" rx="1.5"/>
    <line x1="4.5" y1="12" x2="9.5" y2="12"/>
    <line x1="7" y1="10" x2="7" y2="12"/>
  </svg>
);
const IcoMoon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.5 9.5a6 6 0 0 1-7-7 5 5 0 1 0 7 7z"/>
  </svg>
);
const IcoFence = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="2" width="5" height="10" rx="1"/>
    <rect x="8" y="2" width="5" height="10" rx="1"/>
  </svg>
);
const IcoScreen = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="2" width="12" height="10" rx="1"/>
    <line x1="1" y1="8" x2="13" y2="8"/>
  </svg>
);
const IcoGrid = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.3" y="1.3" width="4.4" height="4.4" rx="0.8"/>
    <rect x="8.3" y="1.3" width="4.4" height="4.4" rx="0.8"/>
    <rect x="1.3" y="8.3" width="4.4" height="4.4" rx="0.8"/>
    <rect x="8.3" y="8.3" width="4.4" height="4.4" rx="0.8"/>
  </svg>
);
const IcoTerminal = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.5" y="2" width="11" height="10" rx="1.5"/>
    <path d="M4 5l2 2-2 2"/>
    <line x1="7.5" y1="9" x2="10" y2="9"/>
  </svg>
);
const IcoShortcut = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.5" y="2" width="4" height="4" rx="0.9"/>
    <rect x="8.5" y="2" width="4" height="4" rx="0.9"/>
    <rect x="1.5" y="8" width="4" height="4" rx="0.9"/>
    <path d="M8.5 10h4"/>
  </svg>
);
const IcoTransfer = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 11V3"/>
    <path d="M2.5 5l2-2 2 2"/>
    <path d="M9.5 3v8"/>
    <path d="M7.5 9l2 2 2-2"/>
  </svg>
);
const IcoPlugin = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.5 2.5a1.5 1.5 0 1 1 3 0V4H10a1 1 0 0 0-1 1v1.5H7.5V5a1 1 0 0 0-1-1H5V2.5a1.5 1.5 0 1 0-3 0V4H1.5v3H3a1 1 0 0 1 1 1v1.5H2.5v2h3V10a1 1 0 0 1 1-1H8v1.5h3V9a1 1 0 0 1 1-1h.5V4H11V2.5"/>
  </svg>
);
const IcoAbout = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7" cy="7" r="5.5"/>
    <line x1="7" y1="6" x2="7" y2="9.5"/>
    <circle cx="7" cy="4.1" r="0.4" fill="currentColor" stroke="none"/>
  </svg>
);

const SECTION_ICONS: Record<Section, React.ReactNode> = {
  appearance: <IcoSun />,
  terminal: <IcoTerminal />,
  keyshortcuts: <IcoShortcut />,
  sftp: <IcoTransfer />,
  plugins: <IcoPlugin />,
  about: <IcoAbout />,
};

export default function SettingsDialog({ onClose, onApply }: { onClose: () => void; onApply?: (key: string, value: string) => void }) {
  const t = useT();
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || "");
  const [section, setSection] = useState<Section>("appearance");
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [discoveredShells, setDiscoveredShells] = useState<DiscoveredShell[]>([]);
  const [shellCustom, setShellCustom] = useState(false);

  // ── Plugins ──
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [market, setMarket] = useState<MarketEntry[]>([]);
  const [pluginTab, setPluginTab] = useState<"market" | "installed">("market");
  const [pluginBusy, setPluginBusy] = useState(false);
  const loadPlugins = async () => {
    try {
      const list = await invoke<PluginManifest[]>("plugins_list");
      setPlugins(list);
      setInstalledPluginProtocols(list);   // refresh protocol pickers app-wide
    } catch { /* ignore */ }
  };
  const loadMarket = async () => {
    try { setMarket(await invoke<MarketEntry[]>("plugins_marketplace")); } catch { /* ignore */ }
  };
  const refreshPlugins = async () => { await Promise.all([loadPlugins(), loadMarket()]); };
  useEffect(() => { refreshPlugins(); }, []);

  const installPlugin = async () => {
    try {
      const dir = await openDialog({ directory: true, title: t("plugins.selectDirTitle") });
      if (!dir || typeof dir !== "string") return;
      setPluginBusy(true);
      const m = await invoke<PluginManifest>("plugins_install", { srcDir: dir });
      await refreshPlugins();
      toast(t("plugins.installSuccess", { name: m.name }), "success");
    } catch (e) {
      toast(t("plugins.installFailed", { error: String(e) }), "error");
    } finally { setPluginBusy(false); }
  };

  const installFromMarket = async (id: string, name: string) => {
    setPluginBusy(true);
    try {
      await invoke<PluginManifest>("plugins_install_market", { id });
      await refreshPlugins();
      toast(t("plugins.installSuccess", { name }), "success");
    } catch (e) {
      toast(t("plugins.installFailed", { error: String(e) }), "error");
    } finally { setPluginBusy(false); }
  };

  const uninstallPlugin = async (id: string, name: string) => {
    setPluginBusy(true);
    try {
      await invoke("plugins_uninstall", { id });
      await refreshPlugins();
      toast(t("plugins.uninstallSuccess", { name }), "success");
    } catch (e) {
      toast(t("plugins.uninstallFailed", { error: String(e) }), "error");
    } finally { setPluginBusy(false); }
  };

  // Load all settings from backend
  useEffect(() => {
    const entries = Object.entries(FIELD_KEYS) as [keyof Settings, string][];
    const updates: Partial<Record<keyof Settings, unknown>> = {};
    Promise.all(
      entries.map(async ([field, key]) => {
        try {
          const val = await invoke<string | null>("settings_get", { key });
          if (val !== null) {
            const def = DEFAULTS[field];
            if (typeof def === "boolean") {
              updates[field] = val === "true";
            } else if (typeof def === "number") {
              const n = parseFloat(val);
              if (!isNaN(n)) updates[field] = n;
            } else {
              updates[field] = val;
            }
          }
        } catch { /* store not yet ready */ }
      })
    ).then(() => {
      setS((p) => ({ ...p, ...(updates as Partial<Settings>) }));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    invoke<string[]>("system_fonts").then(setSystemFonts).catch(() => {});
    invoke<DiscoveredShell[]>("discover_shells").then((shells) => {
      setDiscoveredShells(shells);
    }).catch(() => {});
  }, []);

  // Sync shellCustom once when discovered shells load (initial state only)
  useEffect(() => {
    if (!s.localShell) return;
    setShellCustom(!discoveredShells.some((sh) => sh.id === s.localShell));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveredShells]);

  // Update a field and save immediately, then notify App for real-time application
  const upd = (field: keyof Settings, value: unknown) => {
    setS((p) => ({ ...p, [field]: value } as Settings));
    const key = FIELD_KEYS[field];
    const strVal = String(value);
    invoke("settings_set", { key, value: strVal }).catch(console.error);
    onApply?.(key, strVal);
  };

  // ── Row helper renderers ──────────────────────────────────────────────────


  const rowSwitch = (field: keyof Settings, label: string) => (
    <div className="srow">
      <span className="slabel">{label}</span>
      <label className="sctl-switch">
        <input
          type="checkbox"
          checked={s[field] as boolean}
          onChange={e => !loading && upd(field, e.target.checked)}
          disabled={loading}
        />
        <span className="sctl-switch-track" />
      </label>
    </div>
  );

  const rowSel = (field: keyof Settings, label: string, opts: { value: string; label: string }[]) => (
    <div className="srow">
      <span className="slabel">{label}</span>
      <CustomSelect
        className="sctl"
        value={s[field] as string}
        onChange={(value) => upd(field, value)}
        disabled={loading}
        options={opts}
      />
    </div>
  );

  const rowSeg = (
    field: keyof Settings,
    label: string,
    opts: Array<{ value: string; label: string; icon?: React.ReactNode }>,
  ) => (
    <div className="srow">
      <span className="slabel">{label}</span>
      <div className="sctl-pill">
        {opts.map(o => (
          <button
            key={o.value}
            type="button"
            className={`sctl-pill-opt${(s[field] as string) === o.value ? " active" : ""}`}
            onClick={() => !loading && upd(field, o.value)}
            disabled={loading}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  const rowNum = (field: keyof Settings, label: string, min: number, max: number, step = 1) => (
    <div className="srow">
      <span className="slabel">{label}</span>
      <input
        className="sctl-font-size"
        type="number"
        value={s[field] as number}
        min={min}
        max={max}
        step={step}
        onChange={(e) => upd(field, parseFloat(e.target.value))}
        disabled={loading}
      />
    </div>
  );


  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-settings" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="dialog-header">
          <h2 className="dialog-title">{t("settings.title")}</h2>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">

          {/* ── Left navigation ── */}
          <nav className="settings-nav">
            {SECTION_IDS.map((id) => (
              <button
                key={id}
                className={`settings-nav-item${section === id ? " active" : ""}`}
                onClick={() => setSection(id)}
              >
                <span className="settings-nav-icon">{SECTION_ICONS[id]}</span>
                {t(`settings.section.${id}`)}
              </button>
            ))}
          </nav>

          {/* ── Right panel ── */}
          <div className="settings-panel">
            {loading && <div className="settings-loading">{t("settings.loading")}</div>}

            {/* ── Appearance ── */}
            {!loading && section === "appearance" && (<>
              {rowSeg("layout", t("appearance.layout"), [
                { value: "Fence",  label: t("appearance.layout.fence"),  icon: <IcoFence /> },
                { value: "Screen", label: t("appearance.layout.screen"), icon: <IcoScreen /> },
                { value: "Grid",   label: t("appearance.layout.grid"),   icon: <IcoGrid /> },
              ])}
              {rowSeg("theme", t("appearance.theme"), [
                { value: "Light",  label: t("appearance.theme.light"),  icon: <IcoSun /> },
                { value: "System", label: t("appearance.theme.system"), icon: <IcoMonitor /> },
                { value: "Dark",   label: t("appearance.theme.dark"),   icon: <IcoMoon /> },
              ])}
              {rowSel("language", t("appearance.language"), [
                { value: "zh_CN", label: t("language.zh_CN") },
                { value: "en",    label: t("language.en") },
                { value: "de",    label: t("language.de") },
                { value: "ja",    label: t("language.ja") },
              ])}
              {/* Window opacity */}
              <div className="srow srow-opacity">
                <span className="slabel">{t("appearance.opacity")}</span>
                <div className="opacity-ctl">
                  <div className="opacity-top">
                    <input
                      type="range"
                      className="opacity-slider"
                      min={0.1} max={1.0} step={0.05}
                      value={s.opacity}
                      onChange={e => upd("opacity", parseFloat(e.target.value))}
                      disabled={loading}
                      style={{ '--pct': `${Math.round((s.opacity - 0.1) / 0.9 * 100)}%` } as React.CSSProperties}
                    />
                    <span className="opacity-val">{Math.round(s.opacity * 100)}%</span>
                  </div>
                  <div className="sctl-pill opacity-presets">
                    {([1.0, 0.85, 0.7] as const).map(v => (
                      <button
                        key={v}
                        type="button"
                        className={`sctl-pill-opt${Math.abs(s.opacity - v) < 0.001 ? " active" : ""}`}
                        onClick={() => !loading && upd("opacity", v)}
                        disabled={loading}
                      >
                        {Math.round(v * 100)}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {rowSwitch("backgroundRunning", t("appearance.backgroundRunning"))}
              {rowSwitch("confirmClose", t("appearance.confirmClose"))}
            </>)}

            {/* ── Terminal ── */}
            {!loading && section === "terminal" && (<>
              {/* Font */}
              <div className="srow">
                <span className="slabel">{t("terminal.font")}</span>
                <CustomSelect
                  className="sctl"
                  value={s.font}
                  onChange={(value) => upd("font", value)}
                  disabled={loading}
                  options={systemFonts.length > 0
                    ? (() => {
                        const list = systemFonts.includes(s.font)
                          ? systemFonts
                          : [s.font, ...systemFonts];
                        return list.map((f) => ({ value: f, label: f }));
                      })()
                    : ([
                        "JetBrains Mono",
                        "Consolas",
                        "Cascadia Code",
                        "Fira Code",
                        "Source Code Pro",
                        "Monaco",
                        "Courier New",
                      ].map((f) => ({ value: f, label: f })))
                  }
                />
              </div>
              <div className="srow">
                <span className="slabel">{t("terminal.fallbackFont")}</span>
                <CustomSelect
                  className="sctl"
                  value={s.fallbackFont}
                  onChange={(value) => upd("fallbackFont", value)}
                  disabled={loading}
                  options={(systemFonts.length > 0
                    ? [
                        { value: "", label: t("terminal.fallbackFont.auto") },
                        ...(() => {
                          const list = s.fallbackFont && !systemFonts.includes(s.fallbackFont)
                            ? [s.fallbackFont, ...systemFonts]
                            : systemFonts;
                          return list.map((f) => ({ value: f, label: f }));
                        })(),
                      ]
                    : [
                        { value: "", label: t("terminal.fallbackFont.auto") },
                        { value: "Microsoft YaHei Mono", label: "Microsoft YaHei Mono" },
                        { value: "Noto Sans Mono CJK SC", label: "Noto Sans Mono CJK SC" },
                        { value: "WenQuanYi Mono", label: "WenQuanYi Mono" },
                      ])}
                />
              </div>
              {/* Font size */}
              <div className="srow">
                <span className="slabel">{t("terminal.fontSize")}</span>
                <input
                  className="sctl-font-size"
                  type="number"
                  value={s.fontSize}
                  min={9}
                  max={99}
                  step={1}
                  onChange={(e) => upd("fontSize", parseFloat(e.target.value))}
                  disabled={loading}
                />
              </div>
              {rowNum("maxRows", t("terminal.maxRows"), 1000, 100000, 500)}

              {rowSwitch("startupLogs", t("terminal.startupLogs"))}
              {rowSwitch("hyperlink",  t("terminal.hyperlink"))}
              {rowSwitch("selectCopy", t("terminal.selectCopy"))}
              {rowSel("rightClick", t("terminal.rightClick"), [
                { value: "Menu",         label: t("terminal.rightClick.menu") },
                { value: "Copy",         label: t("terminal.rightClick.copy") },
                { value: "CopyAndPaste", label: t("terminal.rightClick.copyPaste") },
                { value: "Nothing",      label: t("terminal.rightClick.nothing") },
              ])}

              {rowSeg("cursorStyle", t("terminal.cursorStyle"), [
                { value: "Block",     label: t("terminal.cursor.block"),     icon: "▋ " },
                { value: "Bar",       label: t("terminal.cursor.bar"),       icon: "▏" },
                { value: "Underline", label: t("terminal.cursor.underline"), icon: "▁ " },
              ])}

              {rowSwitch("cursorBlink",   t("terminal.cursorBlink"))}
              {rowSwitch("autoReconnect", t("terminal.autoReconnect"))}

              {/* Local shell picker */}
              <div className="srow">
                <span className="slabel">{t("terminal.localShell")}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <CustomSelect
                    className="sctl"
                    style={{ width: "100%" }}
                    value={shellCustom ? "__custom__" : (s.localShell || "")}
                    onChange={(v) => {
                      if (v === "__custom__") {
                        setShellCustom(true);
                        if (discoveredShells.some((sh) => sh.id === s.localShell)) {
                          upd("localShell", "");
                        }
                      } else {
                        setShellCustom(false);
                        upd("localShell", v);
                      }
                    }}
                    disabled={loading}
                    options={[
                      { value: "", label: t("terminal.localShell.default") },
                      ...discoveredShells.map((sh) => ({ value: sh.id, label: sh.name })),
                      { value: "__custom__", label: t("terminal.localShell.custom") },
                    ]}
                  />
                  {shellCustom && (
                    <>
                      <input
                        className="sctl-font-size"
                        style={{ width: "100%", textAlign: "left" }}
                        type="text"
                        value={s.localShell}
                        onChange={(e) => upd("localShell", e.target.value)}
                        placeholder={t("terminal.localShell.placeholder")}
                        disabled={loading}
                      />
                      <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        {t("terminal.localShell.hint")}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </>)}

            {/* ── Shortcuts ── */}
            {!loading && section === "keyshortcuts" && (<>
              <div className="shortcuts-hint">{t("shortcuts.note")}</div>
              <div className="shortcuts-table">
                <div className="shortcuts-head">
                  <span>{t("shortcuts.col.action")}</span>
                  <span>{t("shortcuts.col.key")}</span>
                </div>
                {SHORTCUT_KEYS.map((r, i) => (
                  <div className="shortcuts-row" key={i}>
                    <span className="shortcut-action">{t(r.key)}</span>
                    <kbd className="shortcut-key">{isMac ? r.mac : r.windows}</kbd>
                  </div>
                ))}
              </div>
            </>)}

            {/* ── SFTP ── */}
            {!loading && section === "sftp" && (<>
              {rowSwitch("sftpPinTab", t("sftp.pinTab"))}

              <div className="srow">
                <span className="slabel">{t("sftp.editCommand")}</span>
                <div className="sctl-path">
                  <input
                    className="sctl-path-input"
                    type="text"
                    value={s.sftpEditCommand}
                    placeholder={t("sftp.editCommand.placeholder")}
                    onChange={(e) => setS((p) => ({ ...p, sftpEditCommand: e.target.value }))}
                    onBlur={() => upd("sftpEditCommand", s.sftpEditCommand)}
                    disabled={loading}
                  />
                  <button className="sctl-path-btn" disabled={loading}
                    onClick={async () => {
                      const file = await openDialog({ multiple: false, directory: false });
                      if (file) upd("sftpEditCommand", file as string);
                    }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>
                </div>
              </div>

              {rowSel("sftpDoubleClick", t("sftp.doubleClick"), [
                { value: "Transfer", label: t("sftp.doubleClick.transfer") },
                { value: "Edit",     label: t("sftp.doubleClick.edit") },
              ])}

              <div className="srow">
                <span className="slabel">{t("sftp.defaultDir")}</span>
                <div className="sctl-path">
                  <input
                    className="sctl-path-input"
                    type="text"
                    value={s.sftpDefaultDir}
                    placeholder={t("sftp.defaultDir.placeholder")}
                    onChange={(e) => setS((p) => ({ ...p, sftpDefaultDir: e.target.value }))}
                    onBlur={() => upd("sftpDefaultDir", s.sftpDefaultDir)}
                    disabled={loading}
                  />
                  <button className="sctl-path-btn" disabled={loading}
                    onClick={async () => {
                      const dir = await openDialog({ multiple: false, directory: true });
                      if (dir) upd("sftpDefaultDir", dir as string);
                    }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>
                </div>
              </div>

              {rowSwitch("sftpPreserveMtime", t("sftp.preserveMtime"))}
              {rowSwitch("sftpClearDone",    t("sftp.clearDone"))}
            </>)}

            {/* ── Plugins ── */}
            {section === "plugins" && (
              <div className="plugins-panel">
                <div className="plugins-tabs">
                  <button className={`plugins-tab${pluginTab === "market" ? " active" : ""}`}
                    onClick={() => setPluginTab("market")}>{t("plugins.market")}</button>
                  <button className={`plugins-tab${pluginTab === "installed" ? " active" : ""}`}
                    onClick={() => setPluginTab("installed")}>{t("plugins.installed")}{(() => { const n = plugins.filter((p) => pluginSupportedOnPlatform(p.protocol)).length; return n ? ` (${n})` : ""; })()}</button>
                  <div style={{ flex: 1 }} />
                  <button className="btn-sm" disabled={pluginBusy} onClick={installPlugin}>{t("plugins.installLocal")}</button>
                </div>

                {pluginTab === "market" && (
                  market.filter((p) => pluginSupportedOnPlatform(p.protocol)).length === 0 ? (
                    <div className="plugins-empty">{t("plugins.marketEmpty")}</div>
                  ) : (
                    <div className="plugins-list">
                      {market.filter((p) => pluginSupportedOnPlatform(p.protocol)).map((p) => (
                        <div className="plugin-card" key={p.id}>
                          <div className="plugin-meta">
                            <span className="plugin-name">{p.name}
                              <span className="plugin-ver">v{p.version}</span>
                            </span>
                            <span className="plugin-sub">
                              {p.kind}{p.protocol ? ` · ${p.protocol}` : ""}{p.author ? ` · ${p.author}` : ""}
                            </span>
                            {p.description && <span className="plugin-desc">{p.description}</span>}
                          </div>
                          {p.installed && p.installedVersion === p.version ? (
                            <button className="btn-sm" disabled>{t("plugins.installedBadge")}</button>
                          ) : (
                            <button className="btn-sm btn-primary" disabled={pluginBusy}
                              onClick={() => installFromMarket(p.id, p.name)}>
                              {p.installed ? t("plugins.update") : t("plugins.install")}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}

                {pluginTab === "installed" && (
                  plugins.filter((p) => pluginSupportedOnPlatform(p.protocol)).length === 0 ? (
                    <div className="plugins-empty">{t("plugins.installedEmpty")}</div>
                  ) : (
                    <div className="plugins-list">
                      {plugins.filter((p) => pluginSupportedOnPlatform(p.protocol)).map((p) => (
                        <div className="plugin-card" key={p.id}>
                          <div className="plugin-meta">
                            <span className="plugin-name">{p.name}
                              <span className="plugin-ver">v{p.version}</span>
                            </span>
                            <span className="plugin-sub">
                              {p.kind}{p.protocol ? ` · ${p.protocol}` : ""}{p.author ? ` · ${p.author}` : ""}
                            </span>
                            {p.description && <span className="plugin-desc">{p.description}</span>}
                          </div>
                          <button className="btn-sm" disabled={pluginBusy}
                            onClick={() => uninstallPlugin(p.id, p.name)}>{t("plugins.uninstall")}</button>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            )}

            {/* ── About ── */}
            {!loading && section === "about" && (
              <div className="about-panel">
                <div className="about-brand">
                  <img src="/icons/128x128.png" alt="Netape" className="about-logo" draggable={false} />
                  <div className="about-name">Netape</div>
                </div>
                <div className="about-meta">
                  <span className="about-version">{t("about.version", { version: VERSION })}</span>
                  <span className="about-meta-sep">·</span>
                  <span className="about-author">{t("about.author")} bicongming</span>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
