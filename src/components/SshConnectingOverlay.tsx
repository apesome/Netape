import { useEffect, useRef, useState } from "react";
import type { Host } from "../types";
import { t, useT } from "../i18n";

interface Props {
  host: Host;
  error?: string;
  completed?: boolean;
  defaultShowLogs?: boolean;
  onReconnect: () => void;
  onClose: () => void;
}

const LOG_MESSAGES = [
  (h: string, p: number) => t("ssh.connecting.resolving", { host: h, port: String(p) }),
  () => t("ssh.connecting.tcp"),
  () => t("ssh.connecting.handshake"),
  () => t("ssh.connecting.auth"),
];

export default function SshConnectingOverlay({ host, error, completed, defaultShowLogs = false, onReconnect, onClose }: Props) {
  useT(); // Subscribe to language changes
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(defaultShowLogs);
  const [bar2Ready, setBar2Ready] = useState(false);
  const startTimeRef = useRef(0);

  const isError = Boolean(error);
  const isDone = completed && !isError;

  useEffect(() => {
    setShowLogs(defaultShowLogs);
  }, [defaultShowLogs, host.id]);

  useEffect(() => {
    if (isError || isDone) return;
    setProgress(0);
    setBar2Ready(false);
    setLogs([]);
    startTimeRef.current = Date.now();

    const timers: ReturnType<typeof setTimeout>[] = [];
    LOG_MESSAGES.forEach((fn, i) => {
      timers.push(setTimeout(() => {
        setLogs((prev) => [...prev, fn(host.host, host.port)]);
      }, i * 900 + 300));
    });

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const p = Math.min(82, Math.pow(elapsed / 22000, 0.45) * 82);
      setProgress(p);
    }, 120);

    return () => {
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, [isError]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isDone) { setBar2Ready(false); return; }
    const timer = setTimeout(() => setBar2Ready(true), 350);
    return () => clearTimeout(timer);
  }, [isDone]);

  const bar1 = isError ? 100 : isDone ? 100 : Math.min(100, progress * 2);
  const bar2 = isError ? 100 : bar2Ready ? 100 : Math.max(0, Math.min(100, (progress - 50) * 2));

  const step1 = isError ? "error" : (isDone || progress > 0) ? "active" : "";
  const step2 = isError ? "error" : (isDone || progress >= 40) ? "active" : "";
  const step3 = isError ? "error" : (isDone || progress >= 70) ? "active" : "";

  return (
    <div className="ssh-overlay">
      <div className="ssh-overlay-card">

        {/* ── Header ── */}
        <div className="ssh-overlay-header">
          <div className="ssh-overlay-host-info">
            <div className="ssh-overlay-avatar">⬡</div>
            <div className="ssh-overlay-host-text">
              <div className="ssh-overlay-hostname">{host.name}</div>
              <div className="ssh-overlay-address">SSH {host.host}:{host.port}</div>
            </div>
          </div>
          <div className="ssh-overlay-header-actions">
            <button
              className="ssh-overlay-btn-ghost"
              onClick={() => setShowLogs((v) => !v)}
            >
              {showLogs ? t("ssh.connecting.hideLogs") : t("ssh.connecting.showLogs")}
            </button>
            <button className="ssh-overlay-btn-icon" onClick={onClose} data-tooltip={t("ssh.connecting.close")}>✕</button>
          </div>
        </div>

        {/* ── Three-step progress bar ── */}
        <div className="ssh-overlay-steps">
          <div className={`ssh-step-icon ${step1}`}>⊕</div>
          <div className="ssh-step-bar">
            <div className={`ssh-step-bar-fill ${isError ? "bar-error" : "bar-primary"}`}
              style={{ width: `${bar1}%` }} />
          </div>
          <div className={`ssh-step-icon ${step2}`}>◈</div>
          <div className="ssh-step-bar">
            <div className={`ssh-step-bar-fill ${isError ? "bar-error" : "bar-primary"}`}
              style={{ width: `${bar2}%` }} />
          </div>
          <div className={`ssh-step-icon ${step3}`}>⊟</div>
        </div>

        {/* ── Status / logs ── */}
        <div className="ssh-overlay-body">
          <div className="ssh-overlay-status">
            {isError ? (
              <>
                <span className="ssh-error-dot" />
                <span className="ssh-error-text">{error}</span>
              </>
            ) : isDone ? (
              <>
                <span className="ssh-done-dot" />
                <span className="ssh-status-text">{t("ssh.connecting.connected")}</span>
              </>
            ) : (
              <>
                <span className="ssh-spinner" />
                <span className="ssh-status-text">{t("ssh.connecting.inProgress")}</span>
              </>
            )}
          </div>

          {showLogs && (
            <div className="ssh-overlay-logs">
              {logs.map((line, i) => (
                <div key={i} className="ssh-log-line">
                  <span className="ssh-log-dot" />
                  <span>{line}</span>
                </div>
              ))}
              {error && (
                <div className="ssh-log-line ssh-log-error">
                  <span className="ssh-log-dot-error" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Action buttons (error state only) ── */}
        {isError && (
          <div className="ssh-overlay-actions">
            <button className="ssh-overlay-btn-ghost" onClick={onClose}>{t("ssh.connecting.closeSession")}</button>
            <button className="ssh-overlay-btn-primary" onClick={onReconnect}>{t("ssh.connecting.reconnect")}</button>
          </div>
        )}

      </div>
    </div>
  );
}
