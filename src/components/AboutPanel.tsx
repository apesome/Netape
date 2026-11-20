import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { ABOUT_PROJECT as project, loadGithubAbout, type GithubAbout } from "../about";
import { useT } from "../i18n";
import { toast } from "./Toast";

function AboutIcon({ kind }: { kind: "source" | "issues" | "releases" | "refresh" }) {
  const paths = {
    source: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/></>,
    issues: <><path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.1-5.4A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8 10h8m-8 4h5"/></>,
    releases: <><path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></>,
  };
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

export default function AboutPanel() {
  const t = useT();
  const [version, setVersion] = useState(project.version);
  const [github, setGithub] = useState<GithubAbout | null>(null);
  const [refreshKey, setRefreshKey] = useState(0), [busy, setBusy] = useState(true);
  useEffect(() => {
    let current = true;
    void getVersion().then(value => { if (current) setVersion(value); }).catch(() => {});
    return () => { current = false; };
  }, []);
  useEffect(() => {
    let current = true;
    setBusy(true);
    void loadGithubAbout(refreshKey > 0).then(value => { if (current) setGithub(value); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [refreshKey]);
  const visit = (url: string) => { void open(url).catch(() => toast(t("about.linkFailed"), "error")); };
  const partial = github && (!github.repositoryAvailable || !github.authorAvailable || !github.releaseAvailable);
  return <section className="about-panel" aria-label={project.name}>
    <div className="about-brand"><img src="/icons/128x128.png" alt="" className="about-logo" draggable={false}/><div><h2 className="about-name">{project.name}</h2><span className="about-version">{t("about.version", { version })}</span></div></div>
    <p className="about-tagline">{github?.description ?? t("about.tagline")}</p>
    <div className="about-features">{["terminal", "transfer", "ai"].map(item => <span key={item}>{t(`about.feature.${item}`)}</span>)}</div>
    <dl className="about-details">
      <div><dt>{t("about.author")}</dt><dd><button type="button" className="about-text-link" onClick={() => visit(project.authorUrl)}>{project.author}<span aria-hidden="true">↗</span></button></dd></div>
      <div><dt>{t("about.repository")}</dt><dd><button type="button" className="about-text-link" onClick={() => visit(project.url)}>{project.owner}/{project.repo}<span aria-hidden="true">↗</span></button></dd></div>
      <div><dt>{t("about.latestVersion")}</dt><dd>{github?.latestVersion ?? (busy ? t("about.fetching") : github?.releaseAvailable ? t("about.noRelease") : t("about.unavailable"))}</dd></div>
      <div><dt>{t("about.license")}</dt><dd>{project.license}</dd></div>
      {github?.stars != null && <div><dt>GitHub Stars</dt><dd>☆ {github.stars.toLocaleString()}</dd></div>}
    </dl>
    <div className="about-links">{(["source", "issues", "releases"] as const).map(kind => <button type="button" key={kind} onClick={() => visit(project.url + (kind === "source" ? "" : `/${kind}`))}><AboutIcon kind={kind}/>{t(`about.${kind}`)}<span aria-hidden="true">↗</span></button>)}</div>
    <div className="about-sync" role="status"><span>{busy ? t("about.fetching") : partial ? t("about.offline") : t("about.synced")}</span><button type="button" disabled={busy} onClick={() => setRefreshKey(value => value + 1)} aria-label={t("about.refresh")} title={t("about.refresh")}><AboutIcon kind="refresh"/></button></div>
    <p className="about-built-with">{t("about.builtWith")}</p>
    <p className="about-credits">{t("about.credits")}</p>
  </section>;
}
