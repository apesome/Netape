import { useState, useRef, useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Host, type AuthType, type Tunneling, type TunnelingType, type KeyPair, newHost } from "../types";
import { getProtocol, useAvailableProtocols, type SectionId } from "../protocols";
import { t, useT } from "../i18n";
import CustomSelect from "./CustomSelect";

// ── Section nav icons (match each tab's meaning) ──
const svgProps = {
  width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};
const IcoGeneral = () => (
  <svg {...svgProps}>
    <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
    <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
    <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
  </svg>
);
const IcoProxy = () => (
  <svg {...svgProps}>
    <polyline points="16 3 21 8 16 13"/>
    <path d="M21 8H7a4 4 0 0 0-4 4"/>
    <polyline points="8 21 3 16 8 11"/>
    <path d="M3 16h14a4 4 0 0 0 4-4"/>
  </svg>
);
const IcoTunnel = () => (
  <svg {...svgProps}>
    <path d="M3 21V12a9 9 0 0 1 18 0v9"/>
    <path d="M9 21v-6a3 3 0 0 1 6 0v6"/>
  </svg>
);
const IcoJump = () => (
  <svg {...svgProps}>
    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
  </svg>
);
const IcoTerminal = () => (
  <svg {...svgProps}>
    <polyline points="4 17 10 11 4 5"/>
    <line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
);
const IcoTransfer = () => (
  <svg {...svgProps}>
    <path d="M8 21V5"/><polyline points="4 9 8 5 12 9"/>
    <path d="M16 3v16"/><polyline points="20 15 16 19 12 15"/>
  </svg>
);

const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const EyeOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

interface Props {
  host?: Host;
  hosts?: Host[];
  initialProtocol?: string;
  mode?: "dialog" | "drawer";
  drawerWidth?: number;
  onSave: () => void;
  onClose: () => void;
}

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  general:   <IcoGeneral />,
  proxy:     <IcoProxy />,
  tunneling: <IcoTunnel />,
  jumphosts: <IcoJump />,
  terminal:  <IcoTerminal />,
  sftp:      <IcoTransfer />,
};

function emptyTunneling(): Tunneling {
  return { name: "", type: "Local", sourceHost: "127.0.0.1", sourcePort: 8080, destinationHost: "127.0.0.1", destinationPort: 22 };
}

export default function HostDialog({ host, hosts = [], initialProtocol, mode = "dialog", drawerWidth, onSave, onClose }: Props) {
  useT(); // Subscribe to language changes
  const isNew = !host?.createDate;
  const isProtocolLocked = !isNew || (host?.parentId ?? "0") !== "0";
  const [form, setForm] = useState<Host>(() => {
    const base = host ? structuredClone(host) : newHost();
    if (!host && initialProtocol) {
      base.protocol = initialProtocol;
      const protoDef = getProtocol(initialProtocol);
      if (protoDef) base.port = protoDef.defaultPort;
    }
    return base;
  });
  const [section, setSection] = useState<SectionId>("general");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tunForm, setTunForm] = useState<{ idx: number | null; data: Tunneling } | null>(null);
  const [showJumpPicker, setShowJumpPicker] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [showProxyPass, setShowProxyPass] = useState(false);
  const [keys, setKeys] = useState<KeyPair[]>([]);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [discoveringShares, setDiscoveringShares] = useState(false);
  const [shareOptions, setShareOptions] = useState<string[]>([]);
  const keyFileRef = useRef<HTMLInputElement>(null);

  const loadKeys = async () => {
    try { setKeys(await invoke<KeyPair[]>("key_list")); } catch { /* ignore */ }
  };
  useEffect(() => { loadKeys(); }, []);

  useEffect(() => {
    if (form.protocol !== "WSL") return;
    invoke<string[]>("wsl_list_distributions")
      .then(setWslDistros)
      .catch(() => {});
  }, [form.protocol]);

  const onKeyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const pem = await file.text();
      const name = file.name.replace(/\.(pem|key|ppk|pub|openssh)$/i, "") || "key";
      const kp = await invoke<KeyPair>("key_import", { name, privateKey: pem });
      await loadKeys();
      setAuth("password", kp.id);
      setError("");
    } catch (err) {
      setError(t("host.dialog.keyImportFailed", { error: String(err) }));
    }
  };

  const changeAuthType = (v: string) => {
    setForm((p) => {
      const keepKey = v === "PublicKey" && keys.some((k) => k.id === p.authentication.password);
      return {
        ...p,
        authentication: {
          ...p.authentication,
          type: v as AuthType,
          password: keepKey ? p.authentication.password : "",
        },
      };
    });
  };

  const availableProtocols = useAvailableProtocols();
  const proto = form.protocol;
  const def = getProtocol(proto) ?? getProtocol("SSH")!;
  const needsHost = def.needsHostField;
  const sections = def.sections;
  const activeSection: SectionId = sections.includes(section) ? section : "general";

  const set = <K extends keyof Host>(k: K, v: Host[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const setAuth = (k: keyof Host["authentication"], v: string) =>
    setForm((p) => ({ ...p, authentication: { ...p.authentication, [k]: v as AuthType } }));

  const setProxy = (k: keyof Host["proxy"], v: string | number) =>
    setForm((p) => ({ ...p, proxy: { ...p.proxy, [k]: v } }));

  const setOpts = (k: keyof Host["options"], v: unknown) =>
    setForm((p) => ({ ...p, options: { ...p.options, [k]: v } }));

  const extra = (key: string) => form.options.extras?.[key] ?? "";
  const setExtra = (key: string, value: string) =>
    setForm((p) => ({
      ...p,
      options: {
        ...p.options,
        extras: { ...p.options.extras, [key]: value },
      },
    }));

  const setTunField = <K extends keyof Tunneling>(k: K, v: Tunneling[K]) =>
    setTunForm((p) => p ? { ...p, data: { ...p.data, [k]: v } } : null);

  const discoverShares = async () => {
    if (!form.host.trim()) {
      setError(t("host.dialog.hostRequired"));
      return;
    }
    setDiscoveringShares(true);
    setError("");
    try {
      const shares = await invoke<string[]>("smb_list_shares", {
        params: {
          host: form.host,
          username: form.username || undefined,
          password: form.authentication.password || undefined,
          domain: extra("smbDomain") || undefined,
        },
      });
      setShareOptions(shares);
      if (shares.length === 0) {
        setError(t("host.dialog.noSharesFound"));
      } else if (!extra("smbShare").trim()) {
        setExtra("smbShare", shares[0]);
      }
    } catch (err) {
      setError(t("host.dialog.discoverSharesFailed", { error: String(err) }));
    } finally {
      setDiscoveringShares(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError(t("host.dialog.nameRequired")); return; }
    if (needsHost && !form.host.trim()) { setError(t("host.dialog.hostRequired")); return; }
    if (form.protocol === "SMB" && !extra("smbShare").trim()) { setError(t("host.dialog.shareRequired")); return; }
    setSaving(true); setError("");
    try {
      await invoke("host_save", { host: { ...form, updateDate: Date.now() } });
      onSave();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const switchProto = (p: string) => {
    const nextDef = getProtocol(p);
    const prevDef = getProtocol(form.protocol);
    const next: Host = { ...form, protocol: p };
    if (nextDef && (form.port === 0 || form.port === prevDef?.defaultPort)) {
      next.port = nextDef.defaultPort;
    }
    setForm(next);
    if (nextDef && !nextDef.sections.includes(activeSection)) setSection("general");
  };

  const commitTunnel = () => {
    if (!tunForm || !tunForm.data.name.trim()) return;
    const list = [...form.tunnelings];
    if (tunForm.idx === null) list.push(tunForm.data);
    else list[tunForm.idx] = tunForm.data;
    setForm((p) => ({ ...p, tunnelings: list }));
    setTunForm(null);
  };

  const delTunnel = (idx: number) => {
    const list = [...form.tunnelings];
    list.splice(idx, 1);
    setForm((p) => ({ ...p, tunnelings: list }));
    if (tunForm?.idx === idx) setTunForm(null);
  };

  const addJumpHost = (id: string) => {
    if (!form.options.jumpHosts.includes(id))
      setOpts("jumpHosts", [...form.options.jumpHosts, id]);
    setShowJumpPicker(false);
  };

  const removeJumpHost = (id: string) =>
    setOpts("jumpHosts", form.options.jumpHosts.filter((j) => j !== id));

  const sshHosts = hosts.filter((h) => h.protocol === "SSH" && !h.deleted && h.id !== form.id);
  const [protoDropOpen, setProtoDropOpen] = useState(false);
  const protoBadgeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!protoDropOpen) return;
    const fn = (e: MouseEvent) => {
      if (protoBadgeRef.current && !protoBadgeRef.current.contains(e.target as Node))
        setProtoDropOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [protoDropOpen]);

  const tunnelTypeLabels: Record<string, string> = {
    Local:   t("host.dialog.tunnelTypeLocal"),
    Remote:  t("host.dialog.tunnelTypeRemote"),
    Dynamic: t("host.dialog.tunnelTypeDynamic"),
  };

  const curProto = def;
  const showAllSections = mode === "drawer";
  const renderSectionCard = (sectionId: SectionId, content: ReactNode) => {
    if (!showAllSections) return content;
    return (
      <section className="host-drawer-card" key={sectionId}>
        <div className="host-drawer-card-head">
          <span className="host-drawer-card-icon">{SECTION_ICONS[sectionId]}</span>
          <span className="host-drawer-card-title">{t(`host.dialog.section.${sectionId}`)}</span>
        </div>
        <div className="host-drawer-card-body">{content}</div>
      </section>
    );
  };

  const hostInner = (
      <>

        {/* ── Header ── */}
        <div className="dialog-header">
          <h2 className="dialog-title">{isNew ? t("host.dialog.newHost") : t("host.dialog.edit", { name: form.name })}</h2>
          <div className="host-proto-badge-wrap" ref={protoBadgeRef}>
            <button
              className={`host-proto-badge${isProtocolLocked ? " is-disabled" : ""}`}
              disabled={isProtocolLocked}
              onClick={() => !isProtocolLocked && setProtoDropOpen((v) => !v)}
            >
              <span>{curProto.icon}</span>
              <span>{t(curProto.labelKey ?? curProto.label)}</span>
              {!isProtocolLocked && <span className="proto-badge-arrow">▾</span>}
            </button>
            {!isProtocolLocked && protoDropOpen && (
              <div className="host-proto-drop">
                {availableProtocols.map((p) => (
                  <div
                    key={p.id}
                    className={`host-proto-drop-item${form.protocol === p.id ? " active" : ""}`}
                    onClick={() => { switchProto(p.id); setProtoDropOpen(false); }}
                  >
                    <span className="host-proto-icon">{p.icon}</span>
                    <span>{t(p.labelKey ?? p.label)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="dialog-x" onClick={onClose}>✕</button>
        </div>

        {/* ── Split: nav + content ── */}
        <div className="host-split">

          {/* Left nav */}
          {!showAllSections && <nav className="host-nav">
            {sections.map((s) => (
              <button
                key={s}
                className={`host-nav-item${s === activeSection ? " active" : ""}`}
                onClick={() => setSection(s)}
              >
                <span className="host-nav-icon">{SECTION_ICONS[s]}</span>
                {t(`host.dialog.section.${s}`)}
              </button>
            ))}
          </nav>}

          {/* Right content */}
          <form
            className={`host-content${showAllSections ? " host-content--drawer" : ""}`}
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >

            {/* ── General ── */}
            {(showAllSections ? sections.includes("general") : activeSection === "general") && renderSectionCard("general", (
              <div className="hf">
                <label className="hf-lbl" htmlFor="hf-name">{t("host.dialog.name")}</label>
                <input id="hf-name" className="hf-ctrl" value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder={t("host.dialog.namePlaceholder")} autoComplete="off" autoFocus />

                {def.showWslDistro && (<>
                  <label className="hf-lbl" htmlFor="hf-wsl">{t("host.dialog.distro")}</label>
                  <CustomSelect
                    id="hf-wsl"
                    className="hf-ctrl"
                    value={wslDistros.includes(form.host) ? form.host : ""}
                    onChange={(value) => set("host", value)}
                    options={[
                      { value: "", label: t("host.dialog.distroDefault") },
                      ...wslDistros.map((d) => ({ value: d, label: d })),
                    ]}
                  />
                </>)}

                {needsHost && (<>
                  <label className="hf-lbl" htmlFor="hf-host">{t("host.dialog.host")}</label>
                  <div className="hf-inline">
                    <input id="hf-host" className="hf-ctrl"
                      value={form.host} onChange={(e) => set("host", e.target.value)}
                      placeholder={t("host.dialog.hostPlaceholder")} autoComplete="off" />
                    <label className="hf-sub" htmlFor="hf-port">{t("host.dialog.port")}</label>
                    <input id="hf-port" className="hf-ctrl hf-port" type="number"
                      value={form.port || ""}
                      onChange={(e) => set("port", Number(e.target.value))}
                      min={1} max={65535} />
                  </div>
                </>)}

                {def.needsUsername && (<>
                  <label className="hf-lbl" htmlFor="hf-user">{t("host.dialog.username")}</label>
                  <input id="hf-user" className="hf-ctrl" value={form.username}
                    onChange={(e) => set("username", e.target.value)} placeholder={t("host.dialog.usernamePlaceholder")} autoComplete="off" />
                </>)}

                {def.showPassword && (<>
                  <label className="hf-lbl" htmlFor="hf-fpass">{t("host.dialog.password")}</label>
                  <div className="hf-pass-wrap">
                    <input id="hf-fpass" type={showPass ? "text" : "password"} className="hf-ctrl"
                      value={form.authentication.password}
                      onChange={(e) => setAuth("password", e.target.value)}
                      placeholder={t("host.dialog.passwordPlaceholder")} autoComplete="new-password" />
                    <button type="button" className="hf-pass-eye" onClick={() => setShowPass(v => !v)}
                      data-tooltip={showPass ? t("host.dialog.hidePassword") : t("host.dialog.showPassword")}>
                      {showPass ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                </>)}

                {form.protocol === "SMB" && (<>
                  <label className="hf-lbl" htmlFor="hf-share">{t("host.dialog.share")}</label>
                  <div className="hf-inline">
                    <input id="hf-share" className="hf-ctrl"
                      list="hf-share-list"
                      value={extra("smbShare")}
                      onChange={(e) => setExtra("smbShare", e.target.value)}
                      placeholder={t("host.dialog.sharePlaceholder")}
                      autoComplete="off" />
                    <button
                      type="button"
                      className="hf-key-import"
                      onClick={() => void discoverShares()}
                      disabled={discoveringShares}
                    >
                      {discoveringShares ? t("host.dialog.discoveringShares") : t("host.dialog.discoverShares")}
                    </button>
                    <datalist id="hf-share-list">
                      {shareOptions.map((share) => <option key={share} value={share} />)}
                    </datalist>
                  </div>

                  <label className="hf-lbl" htmlFor="hf-domain">{t("host.dialog.domain")}</label>
                  <input id="hf-domain" className="hf-ctrl"
                    value={extra("smbDomain")}
                    onChange={(e) => setExtra("smbDomain", e.target.value)}
                    placeholder={t("host.dialog.domainPlaceholder")}
                    autoComplete="off" />
                  {shareOptions.length > 0 && (
                    <div className="field-hint-box hf-field">
                      <span className="info-icon">ℹ</span>
                      {t("host.dialog.shareDiscovered", { count: shareOptions.length })}
                    </div>
                  )}
                </>)}

                {def.showAuth && (<>
                  <label className="hf-lbl" htmlFor="hf-auth">{t("host.dialog.authType")}</label>
                  <CustomSelect
                    id="hf-auth"
                    className="hf-ctrl"
                    value={form.authentication.type}
                    onChange={changeAuthType}
                    options={[
                      { value: "No", label: t("host.dialog.auth.none") },
                      { value: "Password", label: t("host.dialog.auth.password") },
                      { value: "PublicKey", label: t("host.dialog.auth.publickey") },
                      { value: "KeyboardInteractive", label: t("host.dialog.auth.keyboard") },
                    ]}
                  />
                </>)}

                {def.showAuth && form.authentication.type === "Password" && (<>
                  <label className="hf-lbl" htmlFor="hf-pass">{t("host.dialog.password")}</label>
                  <div className="hf-pass-wrap">
                    <input id="hf-pass" type={showPass ? "text" : "password"} className="hf-ctrl"
                      value={form.authentication.password}
                      onChange={(e) => setAuth("password", e.target.value)}
                      placeholder={t("host.dialog.passwordMaskPlaceholder")} autoComplete="new-password" />
                    <button type="button" className="hf-pass-eye" onClick={() => setShowPass(v => !v)}
                      data-tooltip={showPass ? t("host.dialog.hidePassword") : t("host.dialog.showPassword")}>
                      {showPass ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                </>)}

                {def.showAuth && form.authentication.type === "PublicKey" && (<>
                  <label className="hf-lbl" htmlFor="hf-key">{t("host.dialog.key")}</label>
                  <div className="hf-inline">
                    <CustomSelect
                      id="hf-key"
                      className="hf-ctrl"
                      value={keys.some((k) => k.id === form.authentication.password) ? form.authentication.password : ""}
                      onChange={(value) => setAuth("password", value)}
                      options={[
                        { value: "", label: t("host.dialog.keyAuto") },
                        ...keys.map((k) => ({
                          value: k.id,
                          label: `${k.name}${k.keyType ? ` · ${k.keyType}` : ""}`,
                        })),
                      ]}
                    />
                    <button type="button" className="hf-key-import"
                      onClick={() => keyFileRef.current?.click()}>{t("host.dialog.keyImport")}</button>
                    <input ref={keyFileRef} type="file" hidden
                      accept=".pem,.key,.ppk,.pub,.openssh,application/octet-stream"
                      onChange={onKeyFile} />
                  </div>
                  <div className="field-hint-box hf-field">
                    <span className="info-icon">ℹ</span>
                    {form.authentication.password
                      ? t("host.dialog.keyHintSelected")
                      : t("host.dialog.keyHintAuto")}
                  </div>
                </>)}

                {def.showAuth && form.authentication.type === "KeyboardInteractive" && (
                  <div className="field-hint-box hf-field">
                    <span className="info-icon">ℹ</span>
                    {t("host.dialog.keyboardHint")}
                  </div>
                )}

                <label className="hf-lbl hf-lbl-top" htmlFor="hf-remark">{t("host.dialog.remark")}</label>
                <textarea id="hf-remark" className="hf-ctrl" value={form.remark}
                  onChange={(e) => set("remark", e.target.value)}
                  placeholder={t("host.dialog.remarkPlaceholder")} rows={4} autoComplete="off" />
              </div>
            ))}

            {/* ── Proxy ── */}
            {(showAllSections ? sections.includes("proxy") : activeSection === "proxy") && renderSectionCard("proxy", (
              <div className="hf">
                <label className="hf-lbl" htmlFor="hf-ptype">{t("host.dialog.proxyType")}</label>
                <CustomSelect
                  id="hf-ptype"
                  className="hf-ctrl"
                  value={form.proxy.type}
                  onChange={(value) => setProxy("type", value)}
                  options={[
                    { value: "NO", label: t("host.dialog.proxy.none") },
                    { value: "HTTP", label: "HTTP" },
                    { value: "SOCKS5", label: "SOCKS5" },
                  ]}
                />

                {form.proxy.type !== "NO" && (<>
                  <label className="hf-lbl" htmlFor="hf-phost">{t("host.dialog.proxyHost")}</label>
                  <div className="hf-inline">
                    <input id="hf-phost" className="hf-ctrl"
                      value={form.proxy.host}
                      onChange={(e) => setProxy("host", e.target.value)}
                      placeholder={t("host.dialog.proxyHostPlaceholder")} autoComplete="off" />
                    <label className="hf-sub" htmlFor="hf-pport">{t("host.dialog.port")}</label>
                    <input id="hf-pport" className="hf-ctrl hf-port" type="number"
                      value={form.proxy.port}
                      onChange={(e) => setProxy("port", Number(e.target.value))} />
                  </div>

                  <label className="hf-lbl" htmlFor="hf-pauth">{t("host.dialog.proxyAuth")}</label>
                  <CustomSelect
                    id="hf-pauth"
                    className="hf-ctrl"
                    value={form.proxy.authenticationType}
                    onChange={(value) => setProxy("authenticationType", value)}
                    options={[
                      { value: "No", label: t("host.dialog.proxyAuth.none") },
                      { value: "Password", label: t("host.dialog.proxyAuth.password") },
                    ]}
                  />

                  {form.proxy.authenticationType !== "No" && (<>
                    <label className="hf-lbl" htmlFor="hf-puser">{t("host.dialog.username")}</label>
                    <input id="hf-puser" className="hf-ctrl"
                      value={form.proxy.username}
                      onChange={(e) => setProxy("username", e.target.value)}
                      autoComplete="off" />

                    <label className="hf-lbl" htmlFor="hf-ppass">{t("host.dialog.password")}</label>
                    <div className="hf-pass-wrap">
                      <input id="hf-ppass" type={showProxyPass ? "text" : "password"} className="hf-ctrl"
                        value={form.proxy.password}
                        onChange={(e) => setProxy("password", e.target.value)}
                        autoComplete="new-password" />
                      <button type="button" className="hf-pass-eye" onClick={() => setShowProxyPass(v => !v)}
                        data-tooltip={showProxyPass ? t("host.dialog.hidePassword") : t("host.dialog.showPassword")}>
                        {showProxyPass ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                  </>)}
                </>)}
              </div>
            ))}

            {/* ── Tunneling ── */}
            {(showAllSections ? sections.includes("tunneling") : activeSection === "tunneling") && renderSectionCard("tunneling", (
              <>
                <div className="htable">
                  <div className="htable-head">
                    <span className="htable-cell" style={{ flex: 1.2 }}>{t("host.dialog.tunnelName")}</span>
                    <span className="htable-cell" style={{ width: 68 }}>{t("host.dialog.tunnelType")}</span>
                    <span className="htable-cell" style={{ flex: 1 }}>{t("host.dialog.tunnelSrc")}</span>
                    <span className="htable-cell" style={{ flex: 1 }}>{t("host.dialog.tunnelDst")}</span>
                    <span style={{ width: 24 }} />
                  </div>
                  {form.tunnelings.length === 0 && (
                    <div className="htable-empty">{t("host.dialog.tunnelEmpty")}</div>
                  )}
                  {form.tunnelings.map((tun, idx) => (
                    <div key={idx}
                      className={`htable-row${tunForm?.idx === idx ? " selected" : ""}`}
                      onClick={() => setTunForm({ idx, data: structuredClone(tun) })}
                    >
                      <span className="htable-cell" style={{ flex: 1.2 }}>{tun.name || "—"}</span>
                      <span className="htable-cell" style={{ width: 68 }}>{tunnelTypeLabels[tun.type] ?? tun.type}</span>
                      <span className="htable-cell" style={{ flex: 1 }}>{tun.sourceHost}:{tun.sourcePort}</span>
                      <span className="htable-cell" style={{ flex: 1 }}>{tun.type === "Dynamic" ? "—" : `${tun.destinationHost}:${tun.destinationPort}`}</span>
                  <button type="button" className="htable-del" onClick={(e) => { e.stopPropagation(); delTunnel(idx); }}>×</button>
                    </div>
                  ))}
                </div>

                {!tunForm && (
                  <button type="button" className="htable-add-btn"
                    onClick={() => setTunForm({ idx: null, data: emptyTunneling() })}>
                    {t("host.dialog.tunnelAdd")}
                  </button>
                )}

                {tunForm && (
                  <div className="htable-form">
                    <div className="htable-form-title">
                      {tunForm.idx === null ? t("host.dialog.tunnelNew") : t("host.dialog.tunnelEdit")}
                    </div>
                    <div className="hf">
                      <label className="hf-lbl" htmlFor="tf-name">{t("host.dialog.tunnelName")}</label>
                      <input id="tf-name" className="hf-ctrl" value={tunForm.data.name}
                        onChange={(e) => setTunField("name", e.target.value)}
                        placeholder={t("host.dialog.tunnelNamePlaceholder")} autoFocus />

                      <label className="hf-lbl" htmlFor="tf-type">{t("host.dialog.tunnelType")}</label>
                      <CustomSelect
                        id="tf-type"
                        className="hf-ctrl"
                        value={tunForm.data.type}
                        onChange={(value) => setTunField("type", value as TunnelingType)}
                        options={[
                          { value: "Local", label: t("host.dialog.tunnelLocal") },
                          { value: "Remote", label: t("host.dialog.tunnelRemote") },
                          { value: "Dynamic", label: t("host.dialog.tunnelDynamic") },
                        ]}
                      />

                      <label className="hf-lbl" htmlFor="tf-sh">{t("host.dialog.tunnelSrcAddr")}</label>
                      <div className="hf-inline">
                        <input id="tf-sh" className="hf-ctrl"
                          value={tunForm.data.sourceHost}
                          onChange={(e) => setTunField("sourceHost", e.target.value)} />
                        <label className="hf-sub" htmlFor="tf-sp">{t("host.dialog.port")}</label>
                        <input id="tf-sp" className="hf-ctrl hf-port" type="number"
                          value={tunForm.data.sourcePort}
                          onChange={(e) => setTunField("sourcePort", Number(e.target.value))}
                          min={1} max={65535} />
                      </div>

                      {tunForm.data.type !== "Dynamic" && (<>
                        <label className="hf-lbl" htmlFor="tf-dh">{t("host.dialog.tunnelDstAddr")}</label>
                        <div className="hf-inline">
                          <input id="tf-dh" className="hf-ctrl"
                            value={tunForm.data.destinationHost}
                            onChange={(e) => setTunField("destinationHost", e.target.value)} />
                          <label className="hf-sub" htmlFor="tf-dp">{t("host.dialog.port")}</label>
                          <input id="tf-dp" className="hf-ctrl hf-port" type="number"
                            value={tunForm.data.destinationPort}
                            onChange={(e) => setTunField("destinationPort", Number(e.target.value))}
                            min={1} max={65535} />
                        </div>
                      </>)}
                    </div>
                    <div className="htable-form-actions">
                      <button type="button" onClick={() => setTunForm(null)}>{t("host.dialog.cancel")}</button>
                      <button type="button" className="btn-primary" onClick={commitTunnel}>
                        {tunForm.idx === null ? t("host.dialog.tunnelAddBtn") : t("host.dialog.tunnelSaveBtn")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ))}

            {/* ── Jump hosts ── */}
            {(showAllSections ? sections.includes("jumphosts") : activeSection === "jumphosts") && renderSectionCard("jumphosts", (
              <>
                <div className="htable">
                  <div className="htable-head">
                    <span className="htable-cell" style={{ flex: 1 }}>{t("host.dialog.jumpName")}</span>
                    <span className="htable-cell" style={{ flex: 1 }}>{t("host.dialog.jumpHost")}</span>
                    <span style={{ width: 24 }} />
                  </div>
                  {form.options.jumpHosts.length === 0 && (
                    <div className="htable-empty">{t("host.dialog.jumpEmpty")}</div>
                  )}
                  {form.options.jumpHosts.map((jid) => {
                    const jh = hosts.find((h) => h.id === jid);
                    return (
                      <div key={jid} className="htable-row">
                        <span className="htable-cell" style={{ flex: 1 }}>{jh?.name ?? jid}</span>
                        <span className="htable-cell" style={{ flex: 1 }}>{jh ? `${jh.host}:${jh.port}` : ""}</span>
                        <button type="button" className="htable-del" onClick={() => removeJumpHost(jid)}>×</button>
                      </div>
                    );
                  })}
                </div>

                <button type="button" className="htable-add-btn" onClick={() => setShowJumpPicker((v) => !v)}>
                  {t("host.dialog.jumpAdd")}
                </button>

                {showJumpPicker && (
                  <div className="jump-picker">
                    {sshHosts.filter((h) => !form.options.jumpHosts.includes(h.id)).length === 0 ? (
                      <div className="htable-empty">{t("host.dialog.jumpNoHosts")}</div>
                    ) : (
                      sshHosts.filter((h) => !form.options.jumpHosts.includes(h.id)).map((h) => (
                        <div key={h.id} className="jump-picker-item" onClick={() => addJumpHost(h.id)}>
                          <span className="jump-name">{h.name}</span>
                          <span className="jump-addr">{h.host}:{h.port}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </>
            ))}

            {/* ── Terminal ── */}
            {(showAllSections ? sections.includes("terminal") : activeSection === "terminal") && renderSectionCard("terminal", (
              <div className="hf">
                <label className="hf-lbl" htmlFor="hf-enc">{t("host.dialog.encoding")}</label>
                <CustomSelect
                  id="hf-enc"
                  className="hf-ctrl"
                  value={form.options.encoding}
                  onChange={(value) => setOpts("encoding", value)}
                  options={[
                    { value: "UTF-8", label: "UTF-8" },
                    { value: "GBK", label: "GBK" },
                    { value: "GB2312", label: "GB2312" },
                    { value: "Big5", label: "Big5" },
                    { value: "Shift_JIS", label: "Shift_JIS" },
                    { value: "EUC-JP", label: "EUC-JP" },
                  ]}
                />

                {def.tab.kind !== "local" && (
                  <>
                    <label className="hf-lbl" htmlFor="hf-hb">{t("host.dialog.heartbeat")}</label>
                    <input id="hf-hb" className="hf-ctrl" type="number"
                      value={form.options.heartbeatInterval}
                      onChange={(e) => setOpts("heartbeatInterval", Number(e.target.value))}
                      min={0} max={300} />
                  </>
                )}

                <label className="hf-lbl" htmlFor="hf-cmd">{t("host.dialog.startupCmd")}</label>
                <input id="hf-cmd" className="hf-ctrl"
                  value={form.options.startupCommand}
                  onChange={(e) => setOpts("startupCommand", e.target.value)}
                  placeholder={t("host.dialog.startupCmdPlaceholder")} />

                <label className="hf-lbl hf-lbl-top" htmlFor="hf-env">{t("host.dialog.env")}</label>
                <textarea id="hf-env" className="hf-ctrl"
                  value={form.options.env}
                  onChange={(e) => setOpts("env", e.target.value)}
                  placeholder={t("host.dialog.envPlaceholder")} rows={5} />
              </div>
            ))}

            {/* ── SFTP ── */}
            {(showAllSections ? sections.includes("sftp") : activeSection === "sftp") && renderSectionCard("sftp", (
              <div className="hf">
                <label className="hf-lbl" htmlFor="hf-sftp">{t("host.dialog.sftpDir")}</label>
                <input id="hf-sftp" className="hf-ctrl"
                  value={form.options.sftpDefaultDirectory}
                  onChange={(e) => setOpts("sftpDefaultDirectory", e.target.value)}
                  placeholder={t("host.dialog.sftpDirPlaceholder")} />
              </div>
            ))}

            {error && <div className="dialog-error" style={{ marginTop: 12 }}>{error}</div>}
          </form>
        </div>

        {/* ── Footer ── */}
        <div className="dialog-actions">
          <button onClick={onClose}>{t("host.dialog.cancel")}</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t("host.dialog.saving") : t("host.dialog.save")}
          </button>
        </div>
      </>
  );

  if (mode === "drawer") {
    return (
      <div
        className="host-drawer-panel dialog-host-v2"
        style={drawerWidth ? { width: `${drawerWidth}px` } : undefined}
      >
        {hostInner}
      </div>
    );
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog dialog-host-v2" onClick={(e) => e.stopPropagation()}>
        {hostInner}
      </div>
    </div>
  );
}
