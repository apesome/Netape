export interface PluginManifest {
  id: string; name: string; version: string; kind: string;
  protocol?: string; description?: string; author?: string;
}
export interface PluginEntry extends PluginManifest {
  source: "online" | "local";
  installed: boolean;
  installedVersion?: string;
  updateAvailable: boolean;
  compatible: boolean;
  unavailableReason?: "platform" | "appVersion";
}
export interface PluginProgress {
  id: string; requestId: string; phase: "preparing" | "downloading" | "verifying" | "installing";
  received: number; total: number;
}
export interface PluginMarketplace {
  entries: PluginEntry[]; target: string; fromCache: boolean; warning?: string;
  activeInstall?: PluginProgress;
}
export function pluginProgressPercent(progress: PluginProgress): number | null {
  return progress.phase === "downloading" && progress.total > 0
    ? Math.max(0, Math.min(100, Math.floor(progress.received * 100 / progress.total))) : null;
}
