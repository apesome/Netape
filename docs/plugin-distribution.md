# 插件在线分发 / Online plugin distribution

[中文 README](../README.zh-CN.md) · [English README](../README.md)

客户端已支持签名 HTTPS 索引、按 Rust target 选择包、下载进度与取消、SHA-256 校验、安全解压、暂存替换及离线缓存。本地安装继续保留。Windows x64 GNU 的 FTP `1.1.0`、SMB `1.0.0` 已上传至 [Releases](https://github.com/apesome/Netape/releases)，签名索引已部署至 GitHub Pages。

## 是否拆仓库

**建议现在继续同仓库，独立发版。** FTP 和 SMB 本来就是独立进程，通过标准输入输出的逐行 JSON-RPC 通信，没有链接到主程序。同一工作区便于同步修改接口、复用测试和构建环境。插件已使用独立版本：FTP `1.1.0`、SMB `1.0.0`，清单位于各自 crate 的 `plugin.json`。

插件数量、维护者或发布频率增加后，再迁到 `apesome/netape-plugins`。迁移时给插件设置自己的 workspace 依赖；保持清单、`pluginApiVersion: 1` 和 RPC 合约；打包命令加 `--repository apesome/netape-plugins`；更新索引中的包地址即可。索引地址、公钥和接口保持不变时，用户不必重装主程序。迁移前应写出并版本化 RPC 方法、字段、错误和进度事件。

## 位置与入口

| 位置 | 用途 |
| --- | --- |
| `config/plugin-market.json` | 编译进主程序的索引地址、HTTPS 域名白名单、Ed25519 公钥 |
| `crates/netape-plugin-package/` | 可独立测试的验签、下载、归档与安装模块 |
| `src-tauri/src/plugin_market.rs` | 市场命令、下载任务、取消与进度事件 |
| `src-tauri/src/plugin.rs` | 本地安装、插件发现与连接保护 |
| `scripts/plugin-release.mjs` | 生成密钥、打包、计算摘要、生成并签名索引 |
| `crates/netape-ftp/plugin.json`、`crates/netape-smb/plugin.json` | 随源码追踪的发布清单 |

默认索引：`https://apesome.github.io/Netape/plugins/v1/index.json`；签名文件在同地址追加 `.sig`。公开仓库与 Pages 已配置，后续通过 Actions 发布。市场合并在线条目、本地目录和已安装版本，显示来源、版本和兼容状态，不向低版本提供“更新”。在线失败时明确提示，并使用仍在有效期内、验签通过的缓存。

本地目录查找顺序仍为 `NETAPE_PLUGIN_CATALOG` → 可执行文件旁 `plugins-dist/` → 源码根目录 `plugins-dist/`。安装位置：`~/.netape/plugins/<id>/`。SFTP 内置；FTP 为插件；SMB 当前只支持 Windows。

## 发布密钥

本轮已为当前工作区生成发布密钥。私钥位于用户目录的 `.netape/publisher/catalog-key.pem`，**不在仓库内**；公钥已写入 `config/plugin-market.json`。请备份私钥；丢失后不能使用原密钥发布新索引。不要上传私钥到仓库、Pages 或 Release。

新维护者首次配置（已有密钥时拒绝覆盖）：

```bash
node scripts/plugin-release.mjs keygen
```

自定义路径/标识：`--key PATH --key-id apesome-2026`。轮换时先在配置中添加新公钥并发布主程序，再用新密钥签名；兼容期保留旧公钥。客户端不会跳过验签或从网络自动信任新公钥。

## 打包与验证

确保插件 Cargo 版本与清单一致，在对应操作系统的 runner 构建。例如 Windows：

```powershell
node scripts/plugin-release.mjs pack --id ftp --target x86_64-pc-windows-msvc
node scripts/plugin-release.mjs pack --id smb --target x86_64-pc-windows-msvc
node scripts/plugin-release.mjs sign
```

输出到被 Git 忽略的 `plugin-release/`。Windows 使用 ZIP，Linux/macOS 使用 tar.gz。包根目录包含 `plugin.json`、可执行程序、AGPL 许可及从 Cargo 依赖目录收集的许可证。`--notices DIR` 可提供整理好的第三方许可；发布者仍需确认依赖许可、对应源码齐全，不应以空目录绕过要求。

已有构建使用 `--no-build --binary PATH`。本机 GNU 环境可设置 `$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'`，将 `C:\msys64\mingw64\bin` 加入 PATH，然后选择 `x86_64-pc-windows-gnu`。客户端按完整 target 精确选择，GNU 与 MSVC 不在索引中互相冒充。

每个目标运行一次 `pack`，同一版本的平台条目会合并到索引。版本变更会清除该插件旧版本的平台列表，防止混入不同版本的程序。不要并行写同一输出目录；CI 应汇总制品后由一个任务生成索引。

```text
plugin-release/
  netape-ftp-1.1.0-x86_64-pc-windows-msvc.zip
  netape-ftp-1.1.0-x86_64-pc-windows-msvc.zip.sha256
  netape-smb-1.0.0-x86_64-pc-windows-msvc.zip
  index.json
  index.json.sig
```

签名覆盖索引的**原始字节**。签名后不要重新格式化 JSON；每次修改都重新 `sign`。索引默认有效 60 天，客户端最长接受 90 天；过期在线目录和缓存均不用于安装。定期重新打包生成索引并签名。

用同一客户端模块验证发布输出（不执行插件）：

```bash
cargo run -p netape-plugin-package --example verify_release -- config/plugin-market.json plugin-release x86_64-pc-windows-msvc
```

验证真实线上目录与下载包（暂存到临时目录，不执行插件、不修改用户安装）：

```bash
cargo run -p netape-plugin-package --example verify_online -- config/plugin-market.json x86_64-pc-windows-gnu
```

## GitHub 发布顺序

1. 在目标平台测试插件连接、浏览、传输、关闭。安装器测试不代替真实协议测试。
2. 创建 `plugin-ftp-v1.1.0`、`plugin-smb-v1.0.0` 等 Release，上传对应平台归档和 `.sha256`。同时提供匹配版本的完整对应源码与构建说明，满足 AGPL 要求。仅发布实际验证的目标。
3. 从 Release 下载回读，确认大小、摘要与索引一致。
4. 最后将 `index.json`、`index.json.sig` 在同一次静态部署中发布到 Pages 的 `plugins/v1/`。暂时不匹配时客户端只回退到有效旧缓存。
5. 主程序「设置 → 插件 → 刷新」，验证下载、取消、安装、更新与卸载。

仓库创建、Windows 打包、不可变 Release 与 Pages 部署流程见 [GitHub 发布指南](github-release.md)。无需独立后台；手动触发的 Actions 工作流使用插件独立标签与签名密钥，并在上传发行包后部署索引。

## 安装保护与边界

- 在线命令只接收索引中的插件 ID、版本、来源和请求 ID；界面不能提供任意下载 URL 或安装路径。
- 索引最大 1 MiB、包最大 128 MiB、展开最大 512 MiB、最多 2048 条目；有连接/请求超时。仅允许配置内 HTTPS 域名及最多 4 次受限重定向，不关闭 TLS 校验。
- 校验 Ed25519 签名、有效期、schema、API 版本、主程序最低版本、Rust target、包大小和 SHA-256。缓存每次重新验签，拒绝比现有有效缓存更早生成的索引。
- 拒绝绝对路径、`..`、盘符、反斜杠、符号/硬链接、特殊文件、Windows 保留名称和重复路径。包清单须与签名索引一致，可执行文件须存在。安装时不启动插件。
- 同一文件系统内暂存、检查后，先将旧版改名为备份，再替换；替换失败恢复旧版。启动时恢复中断备份。Windows 占用导致重命名失败时保留原安装。
- 正在使用的插件不允许更新/卸载。启动进程与最终替换共享互斥保护。下载、校验时可取消，最终短暂提交阶段不取消。
- 插件以当前用户权限运行，没有独立沙箱。首版只接受维护者签名的插件；第三方市场、自动后台更新、镜像设置界面和沙箱留待后续。

## English summary

Netape supports a signed HTTPS catalog, exact Rust-target selection, bounded downloads with progress/cancellation, SHA-256 verification, safe ZIP/tar.gz extraction, staged replacement, rollback and verified offline cache. Local installation remains available. Windows x64 GNU packages and the signed GitHub Pages catalog are published. See [GitHub releases](github-release.md) for the repeatable build and publication workflow.

Keep FTP/SMB in this repository for now, with independent versions and release tags. Their stdio JSON-RPC boundary permits a later move to `netape-plugins` without changing client trust/index configuration. Use the publishing script above to build archives, collect notices, merge targets and sign exact catalog bytes. The private key stays outside the repository; only its public key is embedded. Publish tested archives and matching AGPL source first, then deploy the signed index.
