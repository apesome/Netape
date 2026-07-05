# Netape

**Netape** 是一个基于 Rust + [Tauri](https://tauri.app/) 的跨平台终端与 SSH 客户端，面向 **Windows、macOS 和 Linux**。

桌面外壳使用 Tauri，界面使用 React + TypeScript 构建，终端渲染基于 [xterm.js](https://xtermjs.org/)。

## 当前状态

Netape 仍在持续开发中，但已经不只是“本地终端原型”。当前代码库已经包含以下能力：

- 本地终端支持，Windows 下包含 WSL
- SSH 与 Telnet 主机定义和终端会话
- 主机分组、树形/网格视图，以及主机属性编辑
- 基于 SSH 的文件传输流程，以及通过插件接入的 FTP、SMB 等传输协议
- 笔记、密钥管理、关键词高亮、设置和插件管理

## 目录结构

```text
Netape/
├── Cargo.toml              # Rust workspace
├── crates/
│   ├── netape-domain/      # 领域模型与管理层
│   ├── netape-ftp/         # FTP 插件 sidecar
│   ├── netape-protocol/    # SSH / Telnet / 代理协议支持
│   ├── netape-pty/         # PTY 抽象层
│   ├── netape-smb/         # SMB 插件 sidecar
│   ├── netape-store/       # SQLite 存储与设置
│   └── netape-terminal/    # 终端核心类型
├── src-tauri/              # Tauri 桌面应用（Rust）
├── src/                    # React + TypeScript 前端
├── public/                 # 前端静态资源
└── plugins-dist/           # 插件分发产物
```

## 环境要求

- [Rust](https://rustup.rs/)（稳定版）
- [Node.js](https://nodejs.org/) 18+
- Tauri 平台依赖，参见：<https://tauri.app/start/prerequisites/>

Windows 下通常需要：

- **Microsoft C++ Build Tools**
- **WebView2**（Windows 11 一般已预装）

## 开发

先安装依赖：

```bash
npm install
```

只运行前端开发服务器：

```bash
npm run dev
```

运行带热重载的桌面应用：

```bash
npm run tauri -- dev
```

如果提示缺少 Tauri CLI，先执行 `npm install`。它已经包含在 `devDependencies` 中。

## 构建

只构建前端：

```bash
npm run build
```

构建桌面应用：

```bash
npm run tauri -- build
```

## 许可证

`AGPL-3.0-or-later`
