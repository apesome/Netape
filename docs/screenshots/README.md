# 功能截图 / Feature screenshots

这些 PNG 使用项目真实 React、xterm.js 与 CSS 界面，通过浏览器中的 Tauri IPC 演示替身采集。不是原生桌面连接测试，也不是生成的概念图。

| 文件 | 内容 |
| --- | --- |
| `overview.png` | 主机管理与分组 |
| `terminal-ai.png` | SSH 终端、上下文共享、AI 命令建议、模型与余额布局 |
| `transfer.png` | 本地与远程 SFTP 双栏目录 |
| `about.png` | 居中的关于页头部、版本、apesome 作者与仓库信息 |
| `plugins.png` | 在线插件来源、版本、安装与本地安装入口；目录与下载均为模拟数据 |

## 复现

```bash
npm ci
npm run dev -- --host 127.0.0.1
```

在开发浏览器中打开：

- 中文：`http://127.0.0.1:1420/docs/screenshots/demo.html?lang=zh_CN`
- 英文：`http://127.0.0.1:1420/docs/screenshots/demo.html?lang=en`
- 德文：`http://127.0.0.1:1420/docs/screenshots/demo.html?lang=de`
- 日文：`http://127.0.0.1:1420/docs/screenshots/demo.html?lang=ja`

插件市场演示：打开「设置 → 插件」。安装 SMB 可查看模拟进度并取消；追加 `&market=offline` 可查看已验证缓存与在线目录不可用提示。此演示不访问真实插件服务，也不运行下载的程序。

演示固定应用区域为 1440 × 900；通过应用自身设置切换布局即可拍摄主机列表或网格。打开 Web server 进入模拟终端，展开 AI 助手，输入问题、附带最近输出并发送；通过顶部传输按钮打开双栏文件浏览。关于页截图裁切保留完整设置窗口。

演示只使用 `.example.com` 域名、`demo` 用户、虚构文件列表和预设 AI 回复。标记为已配置密钥的状态用于展示布局，**没有保存真实密钥**；SSH、文件系统、余额查询与 AI 请求均被本地 fixture 拦截。GitHub 信息模拟不可用状态，保留本地版本及作者，不编造发行版或 Stars。

`demo.html` / `demo.ts` 仅由 Vite 开发服务器加载，生产入口 `index.html` 不引用它们，也不进入桌面前端构建。更新截图时请保持这条隔离边界，勿添加真实地址、密钥、聊天记录或私有文件。

## English

These are captures of the actual app UI with deterministic documentation fixtures, not live desktop integration tests. Start Vite and open the demo URL above. The fixture uses fictional hosts, filesystem entries, balance values and AI replies, with no real credentials or external sessions. Production builds do not import the fixture. Crop the application area (or the complete settings dialog) and inspect each image before replacing a README asset.
