// Documentation fixture only. Not imported by the production entry point.
// No real credentials, network sessions, files, or AI requests are used.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const lang = new URLSearchParams(location.search).get("lang") ?? "en";
const settings: Record<string, string> = {
  "Setting.Appearance.language": lang, "Setting.Appearance.layout": "Screen",
  "Setting.Appearance.theme": "Dark", "Setting.Terminal.fontSize": "14",
  "tree.expanded": JSON.stringify(["__root__", "production", "development"]),
  "terminal.recentHosts": JSON.stringify(["web", "api", "staging"]),
};
const makeHost = (id: string, name: string, host: string, parentId = "0", protocol = "SSH") => ({
  id, name, host, parentId: parentId || "0", protocol, port: protocol === "SSH" ? 22 : 0, username: "demo",
  remark: "Documentation demo", authentication: { type: "Password", password: "" },
  proxy: { type: "NO", host: "", port: 0, authenticationType: "No", username: "", password: "" },
  options: { encoding: "UTF-8", heartbeatInterval: 30, tags: [], extras: {}, startupCommand: "", env: "", jumpHosts: [], sftpDefaultDirectory: "", },
  tunnelings: [], sort: 0, ownerId: "", creatorId: "", ownerType: "", deleted: false, createDate: 0, updateDate: 0,
});
const hosts = [
  makeHost("production", "Production", "", "", "Folder"),
  makeHost("web", "Web server", "web.example.com", "production"),
  makeHost("api", "API server", "api.example.com", "production"),
  makeHost("database", "Database", "db.example.com", "production"),
  makeHost("development", "Development", "", "", "Folder"),
  makeHost("staging", "Staging", "staging.example.com", "development"),
  makeHost("sandbox", "Sandbox", "sandbox.example.com", "development"),
  makeHost("build", "Build runner", "ci.example.com", "development"),
];
const profile = { id: "demo", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", hasKey: true, providerId: "deepseek", editionId: "global", protocol: "openai" };
const plugins = [
  { id: "ftp", name: "FTP", version: "1.1.0", kind: "transfer", protocol: "FTP", author: "apesome", description: "FTP file transfer", installed: true, installedVersion: "1.1.0" },
  { id: "smb", name: "SMB", version: "1.0.0", kind: "transfer", protocol: "SMB", author: "apesome", description: "Windows file sharing", installed: false },
];
let demoInstall: any = null;
let demoCancel = false;
const files = (path: string) => [
  ["config", true, 0], ["releases", true, 0], ["logs", true, 0],
  ["README.md", false, 2840], ["compose.yaml", false, 1260],
  ["app.conf", false, 864], ["backup-2026-11.tar.gz", false, 24861824],
].map(([name, dir, size]) => ({ name, path: `${path}/${name}`, isDir: dir, isFile: !dir, isSymlink: false, size, modified: 1795132800000, permissions: dir ? "drwxr-xr-x" : "-rw-r--r--", owner: "demo" }));
const transcript = [
  "\x1b[1;32mdemo@web\x1b[0m:\x1b[1;34m~/services\x1b[0m$ systemctl status netape-demo --no-pager",
  "\x1b[32m●\x1b[0m netape-demo.service - Demo application",
  "     Loaded: loaded (/etc/systemd/system/netape-demo.service; enabled)",
  "     Active: \x1b[32mactive (running)\x1b[0m since Fri 2026-11-20 09:00:00 CST",
  "   Main PID: 2481 (demo-server)", "      Tasks: 8 (limit: 4096)",
  "     Memory: 48.2M", "        CPU: 1.245s", "",
  "Nov 20 09:00:00 web demo-server[2481]: \x1b[32mINFO\x1b[0m Starting application",
  "Nov 20 09:00:00 web demo-server[2481]: \x1b[32mINFO\x1b[0m Listening on 127.0.0.1:8080",
  "Nov 20 09:00:01 web demo-server[2481]: \x1b[32mINFO\x1b[0m Health check passed",
  "", "\x1b[1;32mdemo@web\x1b[0m:\x1b[1;34m~/services\x1b[0m$ curl -s http://localhost:8080/health",
  '{"status":"ok","version":"1.4.2","uptime":"2h 18m"}', "",
  "\x1b[1;32mdemo@web\x1b[0m:\x1b[1;34m~/services\x1b[0m$ ",
].join("\r\n");
let outputSent = false;
mockWindows("main");
mockIPC(async (cmd, args: any = {}) => {
  if (cmd === "settings_get") return settings[args.key] ?? null;
  if (cmd === "settings_set") { settings[args.key] = args.value; return; }
  if (cmd === "host_list") return hosts;
  if (cmd === "plugins_list") return plugins.filter(p => p.installed);
  if (cmd === "plugins_marketplace") return {
    entries: plugins.map(p => ({...p, source: "online", compatible: true, updateAvailable: false})),
    target: "x86_64-pc-windows-gnu", fromCache: new URLSearchParams(location.search).get("market") === "offline",
    warning: new URLSearchParams(location.search).get("market") === "offline" ? "Documentation fixture: simulated offline catalog" : null,
    activeInstall: demoInstall,
  };
  if (cmd === "plugins_install_status") return demoInstall;
  if (cmd === "plugins_cancel_install") { demoCancel = true; return; }
  if (cmd === "plugins_uninstall") { const item = plugins.find(p => p.id === args.id); if (item) item.installed = false; return; }
  if (cmd === "plugins_install_market") {
    demoCancel = false;
    try {
      for (const received of [0, 25, 50, 75, 100]) {
        demoInstall = {id:args.id, requestId:args.requestId, phase:"downloading", received, total:100};
        await emit("plugins://install-progress", demoInstall);
        await new Promise(resolve => setTimeout(resolve, 350));
        if (demoCancel) throw "Plugin installation cancelled";
      }
      const item = plugins.find(p => p.id === args.id);
      if (item) item.installed = true;
      return item;
    } finally { demoInstall = null; }
  }
  if (cmd === "ai_config_get") return { profiles: [profile], activeProfile: "demo", systemPrompt: "", maxTokens: 4096, timeoutSecs: 60, contextLines: 100, attachOutput: false, attachHost: true, permission: "paste", saveHistory: true };
  if (cmd === "ai_catalog_cached" || cmd === "ai_catalog_refresh") return { models: ["deepseek-chat", "deepseek-reasoner"], source: "live", fetchedAt: Date.now() };
  if (cmd === "ai_history_list") return [];
  if (cmd === "ai_usage_get") return { success: true, data: { quotas: [{ percentage: 0, resetAt: 0, balance: 12.80, balanceUnit: "CNY" }] } };
  if (cmd === "ai_chat") {
    const text = lang === "zh_CN"
      ? "服务当前运行正常。\n\n- **状态**：active (running)，已通过健康检查。\n- **资源**：内存 48.2 MB，8 个任务。\n- **监听**：127.0.0.1:8080，仅本机可访问。\n\n可使用下面的命令继续查看最近日志：\n\n```bash\njournalctl -u netape-demo -n 50 --no-pager\n```"
      : "The service is running normally.\n\n- **Status**: active (running), with a passing health check.\n- **Resources**: 48.2 MB of memory and 8 tasks.\n- **Listener**: 127.0.0.1:8080, accessible locally.\n\nInspect recent service logs with:\n\n```bash\njournalctl -u netape-demo -n 50 --no-pager\n```";
    args.onEvent.onmessage({ type: "delta", text });
    args.onEvent.onmessage({ type: "usage", input_tokens: 642, output_tokens: 136 });
    args.onEvent.onmessage({ type: "done" }); return;
  }
  if (cmd === "ssh_connect") return "demo-session";
  if (cmd === "ssh_get_cwd") return "/home/demo/services";
  if (cmd === "ssh_resize" && !outputSent) {
    outputSent = true;
    setTimeout(() => void emit("ssh://output/demo-session", btoa(String.fromCharCode(...new TextEncoder().encode(transcript)))), 120);
  }
  if (cmd === "sftp_open_host") return { sftp_id: "demo-sftp", home_dir: "/home/demo/services" };
  if (cmd === "sftp_open") return "demo-sftp";
  if (cmd === "local_home_dir") return "C:/Users/demo/Projects";
  if (cmd === "local_list_drives") return ["C:/"];
  if (cmd === "local_list_dir" || cmd === "sftp_list_dir") return files(args.path);
  if (["highlight_list", "key_list", "note_list", "terminal_list_shells", "shell_list", "system_fonts", "discover_shells"].includes(cmd)) return [];
  if (cmd === "plugin:app|version") return "1.0.0";
  if (cmd === "plugin:window|is_maximized" || cmd === "plugin:window|is_fullscreen") return false;
  if (cmd === "plugin:window|inner_size") return { width: 1440, height: 900 };
  if (cmd === "plugin:window|scale_factor") return 1;
  if (cmd === "get_file_icon") throw new Error("Use bundled file icons in the documentation demo");
  return null;
}, { shouldMockEvents: true });
// Keep GitHub unavailable instead of inventing release, profile or star data.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => String(input).startsWith("https://api.github.com/")
  ? Promise.resolve(new Response("{}", { status: 404 })) : nativeFetch(input, init);
await import("../../src/main");
