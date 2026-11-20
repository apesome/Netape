# GitHub 创建、打包与发布

仓库：<https://github.com/apesome/Netape>。主程序、FTP、SMB 同仓库维护，独立版本发布。Windows 使用 x64 GNU；macOS 和 Linux 使用独立原生 runner 构建 x64、ARM64。CI 固定使用 Rust `1.95.0`，避免新版 Cargo 构建目录变化影响当前 Tauri 构建依赖；升级工具链时先运行仅构建验证。

应用从 `1.0.0` 开始发布，首个发行标签为 `v1.0.0`。安装包同时包含项目许可证和合并后的第三方许可文件。

## 首次配置

1. 在 GitHub 创建公开仓库，推送源码到 `main`。
2. 在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 在 **Settings → Secrets and variables → Actions** 添加 `PLUGIN_CATALOG_PRIVATE_KEY`，值为本机 `~/.netape/publisher/catalog-key.pem` 的完整内容。不要提交私钥文件；公钥保存在 `config/plugin-market.json`。

## 之后发布新版本

1. 同步更新根 `Cargo.toml`、`package.json`、`package-lock.json`、`Cargo.lock` 和 `src-tauri/tauri.conf.json` 的应用版本。构建检查通过后提交，发布脚本会核对应用版本是否一致。
2. 修改了插件时，同步更新对应 crate 的 `Cargo.toml` 与 `plugin.json`。未修改的插件继续使用已经发布的原始包。
3. 推送源码到 `main`，打开 **Actions → Publish Windows release → Run workflow**。默认勾选 `publish`；取消勾选时仅验证构建并保存 artifacts，不创建 Release 或部署 Pages。

工作流执行测试、构建 NSIS 安装包、打包 FTP/SMB、复用相同插件版本的已发布文件、签名并校验索引，再发布：

- 应用标签：`v<应用版本>`，包含安装器、SHA-256、签名索引与 GitHub 自动提供的对应源码。
- 插件标签：`plugin-ftp-v<版本>`、`plugin-smb-v<版本>`，包含归档和 SHA-256。
- GitHub Pages：`https://apesome.github.io/Netape/plugins/v1/index.json` 及 `.sig`。

已有应用安装包、插件归档不会覆盖；相同名称必须具有相同 SHA-256。修改代码后发布新包时必须提升版本。首次补齐此前缺失的平台可使用下述追加流程。Release 标签对应原始源码提交；后补平台另外附带具体源码提交记录。构建产物还会保存在该次 Actions 的 artifacts 中，便于排查。

安装器暂未配置 Windows Authenticode 签名。FTP/SMB 在线目录按完整 Rust target 匹配；SMB 仅支持 `x86_64-pc-windows-gnu`。

## macOS 和 Linux 发布

先完成 Windows 发布以创建应用 Release 和插件 Release，再运行 **Actions → Publish macOS and Linux release**。四个目标全部构建成功后才执行发布；取消 `publish` 仅保留构建产物。

| Runner | Rust target | 安装格式 |
| --- | --- | --- |
| macos-15-intel | x86_64-apple-darwin | DMG |
| macos-15 | aarch64-apple-darwin | DMG |
| ubuntu-22.04 | x86_64-unknown-linux-gnu | DEB、AppImage |
| ubuntu-24.04-arm | aarch64-unknown-linux-gnu | DEB、AppImage |

发布器验证每个平台的源码提交、版本、文件大小及 SHA-256，向当前应用 Release 追加安装器、校验文件和 `.build.json` 源码记录。FTP 向同版本插件 Release 追加缺失的平台，任何已存在归档都必须字节一致；SMB 不扩展到非 Windows。合并目录时保留 Windows 记录，重新签名后更新 Release 的 `index.json` / `.sig` 并部署 Pages。仅该可续期目录允许替换，安装器和插件包不会覆盖。

Linux x64 以 Ubuntu 22.04 为基础，ARM64 以 Ubuntu 24.04 为基础，需要 WebKitGTK 4.1。macOS 安装包未使用 Developer ID 签名或公证。CI 检查原生编译和打包，不等同于在各系统上完成交互式终端、SSH 和文件传输测试。

## 本地发布

先安装并登录 GitHub CLI，准备 Rust GNU、MinGW、Node.js 和 NSIS 构建环境：

```powershell
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:PATH = 'C:\msys64\mingw64\bin;' + $env:PATH
npm ci
node --test tests/*.test.mjs
npm run build
cargo test --locked -p netape-plugin-package
npm run tauri -- build --target x86_64-pc-windows-gnu --bundles nsis
node scripts/plugin-release.mjs pack --id ftp --target x86_64-pc-windows-gnu
node scripts/plugin-release.mjs pack --id smb --target x86_64-pc-windows-gnu
node scripts/github-release.mjs --prepare
node scripts/plugin-release.mjs sign
cargo run --locked -p netape-plugin-package --example verify_release -- config/plugin-market.json plugin-release x86_64-pc-windows-gnu
git push origin main
node scripts/github-release.mjs
```

最后运行 **Actions → Deploy published plugin catalog**，它从最新应用 Release 获取已签名索引、再次验签并部署 Pages。正常的完整发布工作流会自动部署，无需重复操作。签名索引默认 60 天有效；到期前重新生成、签名，并更新公开索引。

脚本支持 `--repository owner/repo`、`--target <完整提交 SHA>`、`--installer <安装器路径>`、`--out <插件输出目录>`。发布脚本不创建仓库、不替你提交或强制推送源码，先确认远程源码已包含本次更改。
