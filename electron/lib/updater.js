'use strict';
/**
 * 应用更新器
 * - 版本源：自建 latest.json 或 GitHub Releases API（自动识别）
 * - 下载：流式写入 + 进度回调 + SHA-256 校验
 * - 安装：Windows 走 NSIS 静默安装；macOS 走 zip 原地替换（dmg 引导手动拖拽）
 * 不依赖 electron-updater，避免代码签名/XHR 代理等额外约束。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const UA = 'CardSafe-Updater/1.0';
const MAX_REDIRECT = 5;

/* ---------------- 语义化版本 ---------------- */
function parseVer(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** 返回 1 表示 a>b，-1 表示 a<b，0 相等 */
function compareVersions(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  // 无预发布标识的正式版 > 带标识的预发布版
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

/* ---------------- HTTP ---------------- */
function request(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('更新源地址无效：' + url)); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('仅支持 http(s) 更新源'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, application/octet-stream, */*',
        ...(opts.headers || {}),
      },
      timeout: opts.timeout || 20000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECT) return reject(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, u).toString();
        return resolve(request(next, opts, redirects + 1));
      }
      if (res.statusCode === 404) { res.resume(); return reject(new Error('更新源返回 404（文件或清单不存在）')); }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`更新源返回 ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(new Error('连接更新源超时')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchJson(url, opts) {
  const res = await request(url, { ...opts, timeout: 15000 });
  const chunks = [];
  for await (const c of res) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 2 * 1024 * 1024) throw new Error('版本清单过大');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('版本清单不是合法 JSON'); }
}

/* ---------------- 清单归一化 ---------------- */
function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function matchGitHubAsset(name) {
  const n = name.toLowerCase();
  if (/\.blockmap$/.test(n)) return false;
  if (process.platform === 'win32') {
    if (/\.exe$/.test(n)) return true;                       // NSIS 安装包优先
    return /\.zip$/.test(n) && (n.includes('win') || n.includes('windows')); // 便携 zip 兜底
  }
  if (process.platform === 'darwin') {
    // 自动更新优先用 zip；只有 dmg 时也接受（安装脚本会挂载后替换）
    if (/\.zip$/.test(n) && (n.includes(process.arch) || n.includes('universal'))) return true;
    return /\.dmg$/.test(n);
  }
  return /\.(zip|appimage|tar\.gz)$/.test(n);
}

/**
 * 用户可以直接填 GitHub 仓库地址，这里统一换算成 Releases API：
 *   https://github.com/OWNER/REPO            → https://api.github.com/repos/OWNER/REPO/releases/latest
 *   https://github.com/OWNER/REPO/releases   → 同上（/releases/latest 也一样）
 * 其他地址（自建 latest.json、API 地址）原样返回。
 */
function resolveFeedUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  let m = u.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/releases(?:\/latest)?)?\/?$/i);
  if (m) return `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`;
  return u;
}

/**
 * 支持两种来源：
 * 1) GitHub Releases API：{ tag_name, body, assets:[{name,browser_download_url,size,digest}] }
 * 2) 自建清单：{ version, notes, publishedAt, platforms: { "darwin-arm64": {url,sha256,size} } }
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('版本清单格式错误');

  if (raw.tag_name || Array.isArray(raw.assets)) {
    const version = String(raw.tag_name || raw.name || '').replace(/^v/i, '');
    if (!version) throw new Error('GitHub Release 缺少 tag 名称');
    const assets = Array.isArray(raw.assets) ? raw.assets : [];
    const cands = assets.filter((a) => matchGitHubAsset(a.name || ''));
    // Windows：优先选 NSIS 安装包（支持 /S 静默升级），便携 exe 只作兜底
    // macOS：优先本机架构的 zip，其次 universal zip，最后才用 dmg
    if (process.platform === 'darwin') {
      const rank = (a) => {
        const n = (a.name || '').toLowerCase();
        if (/\.zip$/.test(n) && n.includes(process.arch)) return 0;
        if (/\.zip$/.test(n) && n.includes('universal')) return 1;
        if (/\.zip$/.test(n)) return 2;
        if (/\.dmg$/.test(n) && n.includes(process.arch)) return 3;
        if (/\.dmg$/.test(n)) return 4;
        return 9;
      };
      cands.sort((a, b) => rank(a) - rank(b));
    }
    const hit = (process.platform === 'win32')
      ? (cands.find((a) => /setup|install/i.test(a.name || '')) || cands[0])
      : cands[0];
    if (!hit) throw new Error(`该 Release 里没有适配 ${platformKey()} 的安装包（macOS 需要 .zip 或 .dmg）`);
    const digest = String(hit.digest || '').replace(/^sha256:/i, '').toLowerCase();
    return {
      source: 'github',
      version,
      notes: raw.body || '',
      publishedAt: raw.published_at || '',
      artifact: {
        name: hit.name,
        url: hit.browser_download_url,
        size: hit.size || 0,
        sha256: digest || '',
      },
      pageUrl: raw.html_url || '',
    };
  }

  const version = String(raw.version || '').replace(/^v/i, '');
  if (!version) throw new Error('清单缺少 version 字段');
  const platforms = raw.platforms || {};
  const key = platformKey();
  const entry = platforms[key] || platforms[`${process.platform}-any`]
    || (process.platform === 'darwin' ? platforms.mac : platforms.win);
  if (!entry || !entry.url) throw new Error(`清单中没有 ${key} 的下载地址`);
  return {
    source: 'custom',
    version,
    notes: raw.notes || '',
    publishedAt: raw.publishedAt || raw.published_at || '',
    artifact: {
      name: entry.url.split('/').pop(),
      url: entry.url,
      size: entry.size || 0,
      sha256: (entry.sha256 || '').toLowerCase(),
    },
    pageUrl: raw.pageUrl || '',
  };
}

/* ---------------- 下载 ---------------- */
async function downloadTo(url, destPath, { onProgress, expectedSize } = {}) {
  const res = await request(url, { timeout: 60000 });
  const total = Number(res.headers['content-length'] || expectedSize || 0);
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const hash = crypto.createHash('sha256');
  let received = 0;
  const started = Date.now();
  let lastTick = 0;

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.on('data', (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 150) {
        lastTick = now;
        const dt = (now - started) / 1000;
        onProgress({ received, total, percent: total ? received / total : 0, speed: dt > 0 ? received / dt : 0 });
      }
    });
    res.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    res.pipe(ws);
  });

  if (onProgress) onProgress({ received, total: total || received, percent: 1, speed: 0 });
  return { sha256: hash.digest('hex'), bytes: received };
}

/* ---------------- 安装脚本 ---------------- */
function macInstallScript() {
  return `#!/bin/bash
set -u
APP_PID="$1"; PKG_FILE="$2"; TARGET_APP="$3"
LOG="/tmp/cardsafe-update.log"
echo "[$(date)] 等待进程 $APP_PID 退出" > "$LOG"
for i in $(seq 1 300); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.4
done
MNT=""
TMP_DIR=""
cleanup() {
  if [ -n "$MNT" ]; then hdiutil detach "$MNT" -quiet >> "$LOG" 2>&1; rmdir "$MNT" 2>/dev/null; fi
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup EXIT
case "$PKG_FILE" in
  *.dmg|*.DMG)
    MNT=$(mktemp -d "/tmp/cardsafe-dmg.XXXXXX") || exit 1
    echo "[$(date)] 挂载 $PKG_FILE" >> "$LOG"
    hdiutil attach "$PKG_FILE" -nobrowse -readonly -mountpoint "$MNT" -quiet >> "$LOG" 2>&1 || exit 1
    NEW_APP=$(find "$MNT" -maxdepth 2 -name "*.app" -type d | head -1)
    ;;
  *)
    TMP_DIR=$(mktemp -d "/tmp/cardsafe-update.XXXXXX") || exit 1
    echo "[$(date)] 解压 $PKG_FILE" >> "$LOG"
    ditto -x -k "$PKG_FILE" "$TMP_DIR" >> "$LOG" 2>&1 || exit 1
    NEW_APP=$(find "$TMP_DIR" -maxdepth 2 -name "*.app" -type d | head -1)
    ;;
esac
if [ -z "$NEW_APP" ]; then echo "安装包里没有 .app" >> "$LOG"; exit 1; fi
case "$TARGET_APP" in
  *.app) ;;
  *) echo "目标不是 .app 包：$TARGET_APP" >> "$LOG"; exit 1 ;;
esac
echo "[$(date)] 替换 $TARGET_APP" >> "$LOG"
rm -rf "$TARGET_APP" >> "$LOG" 2>&1
ditto "$NEW_APP" "$TARGET_APP" >> "$LOG" 2>&1 || exit 1
xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null
echo "[$(date)] 完成，重新启动" >> "$LOG"
open "$TARGET_APP"
`;
}

/* ---------------- 主体 ---------------- */
class Updater {
  /**
   * @param {object} deps { app, store, emit }
   */
  constructor({ app, store, emit }) {
    this.app = app;
    this.store = store;
    this.emit = emit || (() => {});
    this.manifest = null;
    this.filePath = '';
    this.state = {
      status: 'idle',       // idle|checking|uptodate|available|downloading|ready|installing|error
      current: this.app.getVersion(),
      version: '',
      notes: '',
      notesUrl: '',
      size: 0,
      received: 0,
      percent: 0,
      speed: 0,
      error: '',
      checkedAt: 0,
      source: '',
    };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'state', state: this.snapshot() });
  }

  snapshot() { return { ...this.state }; }

  get feedUrl() {
    // 便于测试/企业内网分发的覆盖方式
    if (process.env.CARDSAFE_FEED_URL) return resolveFeedUrl(process.env.CARDSAFE_FEED_URL);
    const s = this.store.getSettings();
    return resolveFeedUrl((s.update && s.update.feedUrl || '').trim());
  }

  get autoCheck() {
    const s = this.store.getSettings();
    return !s.update || s.update.auto !== false;
  }

  async check({ silent = false } = {}) {
    const url = this.feedUrl;
    if (!url) {
      this.setState({ status: 'idle', error: '' });
      if (!silent) throw new Error('尚未配置更新源地址（设置 → 软件更新）');
      return { ok: false, reason: 'no-feed' };
    }
    this.setState({ status: 'checking', error: '', notes: '', version: '', percent: 0, received: 0 });
    if (!this.app.isPackaged) console.log('[updater] check → ' + url);
    try {
      const raw = await fetchJson(url);
      const m = normalizeManifest(raw);
      this.manifest = m;
      this.setState({ checkedAt: Date.now(), source: m.source, version: m.version, notes: m.notes, size: m.artifact.size, notesUrl: m.pageUrl });

      if (compareVersions(m.version, this.app.getVersion()) <= 0) {
        this.setState({ status: 'uptodate' });
        return { ok: true, uptodate: true, version: m.version };
      }
      const skipped = (this.store.getSettings().update || {}).skippedVersion;
      // 手动检查时忽略"跳过此版本"，让用户随时能改回来；只有静默检查才尊重它
      if (silent && skipped && skipped === m.version) {
        this.setState({ status: 'uptodate' });
        return { ok: true, uptodate: true, skipped: true, version: m.version };
      }
      this.setState({ status: 'available' });
      return { ok: true, uptodate: false, version: m.version, notes: m.notes, size: m.artifact.size };
    } catch (e) {
      let msg = e.message;
      // 仓库还没有发布过 Release（或私有仓库未授权）时 GitHub 返回 404，给出人话提示
      if (/404/.test(msg) && /api\.github\.com\//.test(url)) {
        msg = '该 GitHub 仓库还没有发布 Release，请先在 Releases 页面发布一个版本并上传安装包';
      }
      this.setState({ status: 'error', error: msg });
      if (!this.app.isPackaged) console.error('[updater] 检查失败：' + msg);
      if (!silent) throw new Error(msg);
      return { ok: false, reason: msg };
    }
  }

  async download() {
    if (!this.manifest) {
      const r = await this.check();
      if (!r || r.uptodate) throw new Error('当前已是最新版本');
    }
    const a = this.manifest.artifact;
    const dir = path.join(os.tmpdir(), 'cardsafe-update');
    const safeName = (a.name || 'update.bin').replace(/[^\w.\-]/g, '_');
    const dest = path.join(dir, `${this.manifest.version}-${safeName}`);

    this.setState({ status: 'downloading', percent: 0, received: 0, error: '' });
    try {
      const { sha256, bytes } = await downloadTo(a.url, dest, {
        expectedSize: a.size,
        onProgress: (p) => this.setState({ percent: p.percent, received: p.received, size: p.total || a.size, speed: p.speed }),
      });

      if (a.sha256 && a.sha256 !== sha256) {
        await fsp.unlink(dest).catch(() => {});
        throw new Error(`校验失败：期望 ${a.sha256.slice(0, 12)}… 实际 ${sha256.slice(0, 12)}…`);
      }
      this.filePath = dest;
      this.actualSha256 = sha256;
      this.setState({ status: 'ready', percent: 1, received: bytes, size: bytes, speed: 0 });
      return { ok: true, path: dest, bytes, sha256, verified: !!a.sha256 };
    } catch (e) {
      this.setState({ status: 'error', error: e.message });
      throw e;
    }
  }

  async install() {
    if (!this.filePath) throw new Error('请先下载安装包');
    if (!this.app.isPackaged) throw new Error('开发模式下不支持自动安装，请手动替换');

    this.setState({ status: 'installing' });

    if (process.platform === 'win32') {
      if (/\.exe$/i.test(this.filePath)) {
        // NSIS 安装包：静默安装并自动拉起新版本
        const child = spawn(this.filePath, ['/S', '--updated'], { detached: true, stdio: 'ignore' });
        child.unref();
        setTimeout(() => this.app.quit(), 600);
        return { ok: true, mode: 'nsis' };
      }
      // 免安装 zip：运行中的 exe 被占用，无法原地覆盖，交给用户手动替换
      require('electron').shell.showItemInFolder(this.filePath);
      this.setState({ status: 'ready' });
      return {
        ok: true,
        mode: 'zip-manual',
        message: '已下载免安装包并在文件夹中显示。请退出 CardSafe，解压后覆盖原目录再启动。',
      };
    }

    if (process.platform === 'darwin') {
      // zip 直接解压替换；dmg 由安装脚本挂载后替换，走同一条路径
      const targetApp = path.resolve(path.dirname(process.execPath), '..', '..');
      if (!targetApp.endsWith('.app')) throw new Error('无法定位应用包路径，请手动安装');
      // 只允许替换可写的 .app（排除从只读 DMG 直接运行的情况）
      await fsp.access(path.dirname(targetApp), fs.constants.W_OK)
        .catch(() => { throw new Error('应用所在目录不可写（可能正在从 DMG 运行），请先拖入「应用程序」'); });

      const scriptPath = path.join(os.tmpdir(), `cardsafe-install-${Date.now()}.sh`);
      await fsp.writeFile(scriptPath, macInstallScript(), { mode: 0o755 });
      const child = spawn('/bin/bash', [scriptPath, String(process.pid), this.filePath, targetApp], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      setTimeout(() => this.app.quit(), 600);
      return { ok: true, mode: 'replace-app' };
    }

    const { shell } = require('electron');
    await shell.openPath(this.filePath);
    return { ok: true, mode: 'manual' };
  }

  /** 启动后静默检查一次 */
  scheduleAutoCheck(delayMs = 5000) {
    if (!this.app.isPackaged) {
      console.log(`[updater] autoCheck=${this.autoCheck} feed=${this.feedUrl || '(空)'}`);
    }
    if (!this.autoCheck || !this.feedUrl) return;
    setTimeout(() => {
      this.check({ silent: true }).catch(() => {});
    }, delayMs);
  }
}

module.exports = { Updater, compareVersions, normalizeManifest, parseVer, platformKey, resolveFeedUrl, matchGitHubAsset, macInstallScript };
