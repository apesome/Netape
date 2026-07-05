# Netape $VERSION

跨平台终端与 SSH 客户端。

## 下载

根据你的系统选择对应文件:

| 系统 | 文件 | 说明 |
|---|---|---|
| **Windows** | `Netape_*_x64-setup.exe` 或 `Netape_*_x64_en-US.msi` | 安装包,二选一 |
| **macOS (Apple Silicon)** | `Netape_*_aarch64.dmg` | M1/M2/M3/M4 芯片 |
| **macOS (Intel)** | `Netape_*_x64.dmg` | Intel 芯片 |
| **Linux** | `Netape_*.deb` 或 `Netape_*.AppImage` | deb 适合 Debian/Ubuntu,AppImage 免安装 |

> 不确定 Mac 芯片类型?点左上角  → "关于本机" → 看"芯片"一栏。

---

## 安装说明

### Windows
1. 下载 `.exe` 或 `.msi`
2. 双击运行安装
3. 首次启动时 SmartScreen 可能提示"Windows 已保护你的电脑" → 点 **"更多信息"** → **"仍要运行"**(因为未签名,属正常现象)

### macOS
1. 下载 `.dmg`,双击打开
2. 把 **Netape** 拖到 **Applications** 文件夹
3. **首次打开(重要):** 因为未签名,Gatekeeper 会拦截。用以下任一方法放行(只需一次):
   - **方法一(推荐):** 在 Applications 里找到 Netape,**右键 → 打开** → 弹窗点 **"打开"**
   - **方法二:** 打开"终端",粘贴运行(把 app 名换成实际名字):
     ```
     xattr -dr com.apple.quarantine /Applications/Netape.app
     ```
   - **方法三:** 双击 app 被拦后,去 **系统设置 → 隐私与安全性** → 底部点 **"仍要打开"**
4. 之后双击即可正常启动

### Linux
- **.deb(Debian/Ubuntu):** 双击安装,或 `sudo dpkg -i Netape_*.deb`
- **.AppImage:** 赋予执行权限后直接运行:
  ```
  chmod +x Netape_*.AppImage
  ./Netape_*.AppImage
  ```

---

## 备注
- 本构建**未代码签名**(开源项目,无商业证书)。Windows 的 SmartScreen 和 macOS 的 Gatekeeper 提示均属正常,按上面步骤操作即可。
- 如果运行时报错缺失依赖,请确认系统版本满足:Windows 10+、macOS 10.15+、主流 Linux 发行版。
