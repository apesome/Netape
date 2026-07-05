# Netape

**Netape** is a cross-platform terminal and SSH client built with Rust + [Tauri](https://tauri.app/), targeting **Windows, macOS, and Linux**.

The desktop shell is powered by Tauri, while the UI is built with React + TypeScript and renders terminals through [xterm.js](https://xtermjs.org/).

## Status

Netape is still under active development, but it is no longer just a local-terminal prototype. The current codebase already includes:

- Local terminal support, including WSL on Windows
- SSH and Telnet host definitions and terminal sessions
- Host management with groups, grid/tree views, and host properties
- Transfer workflows for SSH-based file browsing plus plugin-based transfer protocols such as FTP and SMB
- Notes, key management, keyword highlighting, settings, and plugin management

## Layout

```text
Netape/
├── Cargo.toml              # Rust workspace
├── crates/
│   ├── netape-domain/      # Domain models and managers
│   ├── netape-ftp/         # FTP plugin sidecar
│   ├── netape-protocol/    # SSH / Telnet / proxy protocol support
│   ├── netape-pty/         # PTY abstraction
│   ├── netape-smb/         # SMB plugin sidecar
│   ├── netape-store/       # SQLite-backed storage and settings
│   └── netape-terminal/    # Terminal core types
├── src-tauri/              # Tauri desktop app (Rust)
├── src/                    # React + TypeScript frontend
├── public/                 # Static frontend assets
└── plugins-dist/           # Plugin distribution artifacts
```

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- Tauri platform prerequisites: <https://tauri.app/start/prerequisites/>

On Windows, that usually means:

- **Microsoft C++ Build Tools**
- **WebView2** (typically preinstalled on Windows 11)

## Develop

Install dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Run the full desktop app with hot reload:

```bash
npm run tauri -- dev
```

If the Tauri CLI is missing, install dependencies first. It is already listed in `devDependencies`.

## Build

Build the frontend bundle only:

```bash
npm run build
```

Build the desktop application:

```bash
npm run tauri -- build
```

## License

`AGPL-3.0-or-later`
