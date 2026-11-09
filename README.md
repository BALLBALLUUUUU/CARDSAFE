# CARDSAFE · 素材拷卡工具

## 外观

- **材质**：Liquid Glass —— 半透明玻璃卡片 + 背景光晕折射（`backdrop-filter` 模糊 + 顶部高光边），
  深浅两套各自定义玻璃明度与描边，窗口底色随主题同步，切换不闪白
- **主题**：`跟随时间`（默认，07:00–19:00 白天）/ 强制白天 / 强制夜间
- **配色**：默认黑白；设置页可用**取色器或 R/G/B 数值自选任意颜色**，
  强调色、悬停态、描边、光晕均由所选 RGB 自动派生（`applyAccent()` 实时写入 CSS 变量），
  文字颜色按亮度自动取黑/白保证可读
- **背景透明 + 透明度滑块**：设置 → 外观 → 背景透明，下方的滑块可 **0–100% 无级调节**，
  拖动即时生效（不重建窗口、不重置表单）。
  - 实现：窗口在 macOS 上**始终**创建为 `transparent: true` + 全透明底色，真实透明度由一层
    `body::before` 薄纱的 alpha（CSS 变量 `--veil`）控制：0% → veil 1.0（完全等同不透明），
    100% → veil 0.10（桌面清晰可见，同时保留最低文字对比）
  - 玻璃卡片会自动随透明度加厚（`--panel-a` 由 `--veil` 派生），因此拖到最透明时
    桌面从卡片之间与侧栏透出，文字仍然可读
  - **不使用 macOS `vibrancy`**：系统材质会自带一层固定着色，把可调范围吃掉（这也是旧版
    「看起来没有透明效果」的原因）；Windows 因透明窗口必须在创建时指定，仍走重建路径
  - 窗口底色恒为 `#00000000`，`window:bg` 现在只同步系统明暗，不再写入不透明底色
- **透明下的对比度**：描边不再是固定值，而是由 `--veil` 派生（`--edge-a` 0.13 → 0.26），
  越透明框线越实；输入框获得独立底色（`--field-bg`）+ 内阴影，卡片/卷/目标行统一走
  `--panel-a` / `--panel-a-2`，保证「拖到最透明也看得清边界」
- **布局**：参考 KOCARD —— 顶部大标题 + 右侧大号百分比，每张目的地卡片分「拷贝 / 校验」双栏，
  进度、校验状态就地显示；开始拷卡为顶部胶囊按钮，不再遮挡内容

---
| — | ✅ 文件夹命名模板（`{date}_{project}_{card}` 等），跨平台非法字符自动清洗 |
| — | ✅ 断点续拷（跳过已存在且大小一致的文件） |
| — | ✅ 保留原始时间戳（DIT 工作流必需） |
| — | ✅ 目标空间预检、写权限探测、完成后安全弹出 |

素材卡**始终只读**：不做任何写回、移动或删除操作。

---

## 运行

```bash
cd cardsafe
npm install
npm start
```

要求 Node.js ≥ 18（开发机为 Node 22）。

**已打包产物**（`dist/`，按 `npm run dist:mac` / `dist:win` 生成，文件名随版本号变化）：
- `CARDSAFE-*-arm64.dmg` — macOS（Apple Silicon）安装包，未签名
- `CARDSAFE-*-arm64-mac.zip` — macOS 自动更新用包（**发版必须带上**）
- `CARDSAFE-*-win-x64-portable.zip` — Windows 11 免安装版，解压后双击 `CARDSAFE.exe`
- `latest.json` — 更新清单（域名为占位，发版时用 `--base` 重新生成）
- `mac-arm64/CARDSAFE.app`、`win-unpacked/` — 未压缩的应用本体

未签名说明：macOS 首次打开需 **右键 → 打开**（或 `xattr -dr com.apple.quarantine /Applications/CardSafe.app`）；Windows SmartScreen 提示时选 **更多信息 → 仍要运行**。

> 若终端环境注入了 `ELECTRON_RUN_AS_NODE=1` 或 `NODE_OPTIONS=--require ...`（部分 IDE / agent 宿主会这么做），Electron 会退化成纯 Node 模式并报 `Cannot read properties of undefined (reading 'whenReady')`。用 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS npm start` 启动即可。

## 自测

```bash
npm run test:engine   # 引擎级：不启动界面，7 项检查
npm run test:update   # 更新器：10 项（含真实执行 .app 替换脚本）
npm run test:e2e      # 端到端：真实建卡 → 拷贝 → 校验 → 出 PDF 报告
```

`test:engine` 构造一张模拟素材卡（含 DCIM / PRIVATE 结构与垃圾文件），验证：
多目标拷贝完整性、三方哈希一致、垃圾文件过滤、时间戳保留、断点续拷、外部取消、目标不可写报错。

`test:e2e` 走完整主进程链路（enqueue → 队列 → 引擎 → 历史库 → PDF 报告），验证 7 项：
任务完成、文件计数、无失败、双目标哈希一致、垃圾过滤、PDF 生成、整卡指纹计算。

## 打包

```bash
# macOS → dist/*.dmg + *.zip（arm64 + x64）
npm run dist:mac

# Windows 11 → dist/*.exe（NSIS 安装包 + 免安装 portable）
npm run dist:win
```

**建议在对应系统上打对应包。** 在 macOS 上交叉打 Windows 包需要额外安装 wine，且中文路径易出问题；直接把 `cardsafe` 目录拷到 Windows 机器上执行 `npm install && npm run dist:win` 最稳。

产物默认在 `dist/`。应用未做代码签名：
- macOS 首次打开需 **右键 → 打开**（或 `xattr -dr com.apple.quarantine /Applications/CardSafe.app`）
- Windows 首次运行 SmartScreen 提示时选 **更多信息 → 仍要运行**

---

## 使用流程

1. **插入读卡器** → 左侧「素材卡」标签的卷会自动出现在网格里（也可点「浏览其他…」选任意文件夹）。
2. **添加目标**：至少一个，可加多个；每行显示目标可用空间与最终落盘路径。
3. **命名模板**：默认 `{date}_{card}`，产出如 `20261109_SDCARD/DCIM/...`。
   支持 `{date}` `{time}` `{project}` `{card}` `{camera}` `{taskid}`，可用 `/` 分层。
4. **选项**：校验方式（哈希 / 仅大小 / 不校验）、算法、并发数（HDD 用 2，SSD 用 4~8）。
5. **开始拷卡** → 实时环形进度、每目标独立进度条、速度、剩余时间、运行日志。
6. **结束** → 自动生成 PDF 报告到「文稿 / CardSafe 拷卡报告」，并在「记录」页可再次导出。

取消任务会立即中断并清理未写完的残片文件。

---

## 目录结构

```
cardsafe/
├── electron/
│   ├── main.js              主进程：窗口、IPC、任务队列、报告落盘、通知、更新
│   ├── preload.js           contextBridge 白名单 API
│   └── lib/
│       ├── copyEngine.js    ★ 核心：扫描 → 单读多写 → 回读校验 → 清单
│       ├── updater.js       ★ 更新：清单解析 / 下载 / 校验 / 跨平台安装
│       ├── volumes.js       卷枚举（/Volumes、PowerShell CIM、Linux /media）
│       ├── report.js        PDF/CSV 报告 + 整卡指纹
│       ├── store.js         设置与历史持久化（JSON）
│       ├── notify.js        系统通知 / SMTP / Webhook
│       ├── transcode.js     ffmpeg 代理转码
│       ├── eject.js         安全弹出（diskutil / Shell COM）
│       ├── presets.js       转码预设
│       └── util.js          体积/时长格式化、模板展开、自然排序、垃圾过滤
├── renderer/                无框架前端（原生 DOM，零构建步骤）
├── scripts/
│   ├── e2e.js               端到端自检启动器
│   ├── release.js           生成 latest.json 更新清单
│   └── dev-update-server.js 本地更新服务器
├── test/
│   ├── engine.test.js       拷贝引擎自测（7 项）
│   └── updater.test.js      更新器自测（10 项）
└── package.json             electron-builder 打包配置
```

## 关键实现说明

- **单读多写**：一个文件只从卡上读一次，块级同时写入所有目标（4~8MB 块，带背压控制）。相比"每个目标各读一遍"，卡读取量减半。
- **双哈希**：第一遍读源时同步算哈希，写完后**重新打开目标文件再算一次**比对；不一致则删除重拷一次，仍不一致才判失败。
- **并发**：文件级并发（默认 4），每文件内目标并行写，进度每 200ms 聚合推送到界面。
- **报告**：用 Chromium `printToPDF` 渲染 A4 版式，无外部依赖；「整卡指纹」= 排序后所有文件哈希拼接再 SHA-256，归档时对比一次即可确认两份备份完全一致。

## 发布与更新（v1.1 新增）

### 更新是怎么工作的

1. 应用启动 6 秒后（可在设置里关闭）向**更新源**请求版本清单，或手动点「检查更新」
2. 用语义化版本比较（支持预发布、两位数段），只有远端更高才提示
3. 点「下载更新」→ 流式下载 + 进度条 + **SHA-256 校验**，不匹配立即删除并报错
4. 点「重启并安装」：
   - **macOS**：下载的是 zip 包 → 写一个独立安装脚本，等应用退出后解压、替换 `.app`、清除隔离标记、自动重新打开
   - **Windows**：下载的是 NSIS 安装包 → `/S --updated` 静默安装并重启；若是免安装 zip，则在文件夹中定位文件，引导手动覆盖（运行中的 exe 无法自替换）

安全约束：只接受 **更高版本**；只走 http(s)；校验值缺失时会在界面明确提示"该版本未提供校验值"。

### 更新源两种写法

**A. 自建清单（推荐内网 / 自有服务器）**

```json
{
  "version": "1.1.0",
  "notes": "本次更新内容…",
  "publishedAt": "2026-11-09T03:00:00Z",
  "platforms": {
    "darwin-arm64": { "url": "https://dl.example.com/CardSafe-1.1.0-arm64-mac.zip", "sha256": "…", "size": 95183782 },
    "win32-x64":    { "url": "https://dl.example.com/CardSafe%20Setup%201.1.0.exe",   "sha256": "…", "size": 98765432 }
  }
}
```

**B. GitHub Releases**

直接把 Release API 地址填进「更新源」：
`https://api.github.com/repos/你的账号/CardSafe/releases/latest`
程序会自动解析 `tag_name` 作为版本、`body` 作为更新说明、按当前平台挑选资源，并读取 `digest` 里的 sha256。

### 发一个版本（三步）

```bash
npm version patch            # 或 minor / major，会改写 package.json 并打 git tag
npm run dist:mac             # 产出 dist/*.dmg + *-mac.zip（自动更新必须用 zip）
npm run release -- --base https://dl.example.com/cardsafe/ --notes "本次修复了…"
```

`npm run release` 会扫描 `dist/`、计算每个包的 SHA-256 与体积，生成 `dist/latest.json`。
把这个 json 和安装包一起上传到 `--base` 指向的目录即可，客户端下次启动就会看到更新。

> **macOS 自动更新必须发布 `-mac.zip`**，dmg 只用于首次安装（程序无法自动替换挂在 DMG 里的应用）。

### 本地联调（不用真发版）

```bash
npm run release -- --base http://127.0.0.1:8787/    # 生成 dist/latest.json
npm run serve:update                                # 起本地更新服务器（8787）
```

然后把设置里的更新源填 `http://127.0.0.1:8787/latest.json` 就能走完整流程。
调试时也可以用环境变量直接覆盖，不改配置：

```bash
CARDSAFE_FEED_URL=http://127.0.0.1:8787/latest.json npm start
```

### 更新相关测试

```bash
npm run test:update
```

覆盖 10 项：版本比较（v 前缀 / 预发布 / 两位数段）、自建清单解析、GitHub Release 解析、
识别新版本、下载进度事件、SHA-256 校验通过、哈希不匹配拒绝安装、同版本判定已最新、
跳过版本、未配置更新源与开发模式安装被拦截、**macOS 原地替换脚本真实执行**。

## 可选：启用转码

```bash
brew install ffmpeg          # macOS
winget install Gyan.FFmpeg   # Windows 11
```

然后在「设置 → 代理转码」点「检测」。未安装时该功能自动跳过，不影响拷卡。

## 已知限制

- 转码为串行执行（单文件单进程），大批量代理生成建议另跑 DaVinci / Adobe Media Encoder。
- Windows 自动弹出依赖读卡器固件支持 Shell Eject，部分廉价读卡器只能手动拔（写入已完成，安全）。
- `_proxy` 目录不会被再次扫描，避免转码产物被误备份。
