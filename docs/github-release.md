# GitHub 创建、打包与发布

仓库：<https://github.com/apesome/Netape>。主程序、FTP、SMB 同仓库维护，独立版本发布。当前自动打包目标为 Windows x64 GNU；macOS、Linux 不会生成未经验证的安装包。

## 首次配置

1. 在 GitHub 创建公开仓库，推送源码到 `main`。
2. 在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 在 **Settings → Secrets and variables → Actions** 添加 `PLUGIN_CATALOG_PRIVATE_KEY`，值为本机 `~/.netape/publisher/catalog-key.pem` 的完整内容。不要提交私钥文件；公钥保存在 `config/plugin-market.json`。

## 之后发布新版本

1. 同步更新根 `Cargo.toml`、`package.json`、`package-lock.json` 和 `src-tauri/tauri.conf.json` 的应用版本。
2. 修改了插件时，同步更新对应 crate 的 `Cargo.toml` 与 `plugin.json`。未修改的插件继续使用已经发布的原始包。
3. 推送源码到 `main`，打开 **Actions → Publish Windows release → Run workflow**。

工作流执行测试、构建 NSIS 安装包、打包 FTP/SMB、复用相同插件版本的已发布文件、签名并校验索引，再发布：

- 应用标签：`v<应用版本>`，包含安装器、SHA-256、签名索引与 GitHub 自动提供的对应源码。
- 插件标签：`plugin-ftp-v<版本>`、`plugin-smb-v<版本>`，包含归档和 SHA-256。
- GitHub Pages：`https://apesome.github.io/Netape/plugins/v1/index.json` 及 `.sig`。

已有应用 Release 不会覆盖；请提升应用版本。已有插件归档也不会覆盖；新增平台时请提升插件版本。Release 标签指向构建时的源码提交。构建产物还会保存在该次 Actions 的 artifacts 中，便于排查。

安装器暂未配置 Windows Authenticode 签名。FTP/SMB 在线目录按完整 Rust target 匹配；当前为 `x86_64-pc-windows-gnu`。

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
