'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_SETTINGS = {
  destinations: [],                 // [{ base, template }]
  template: '{date}_{card}',
  project: '',
  algorithm: 'sha256',
  verify: 'hash',
  concurrency: 4,
  skipJunk: true,
  skipExisting: false,
  preserveTime: true,
  autoEject: false,
  autoReport: true,        // 拷卡完成后自动生成 PDF 报告
  openAfterDone: true,
  notify: {
    system: true,
    email: { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' },
    webhook: { enabled: false, url: '', method: 'POST' },
  },
  transcode: { enabled: false, preset: 'proxy_h264', ffmpegPath: '', onlyMedia: true },
  update: {
    auto: true,             // 启动后自动检查
    feedUrl: '',            // latest.json 或 GitHub Releases API
    skippedVersion: '',     // 用户选择"跳过此版本"
  },
  reportDir: '',
  themeMode: 'auto',        // auto | light | dark
  transparent: false,       // 窗口背景透明（macOS 带 vibrancy）
  transparentLevel: 55,     // 透明度 0–100（0 不透明，100 完全透出桌面）
  accent: 'mono',           // 旧版预设配色（保留兼容，已改为 accentRgb）
  accentRgb: null,          // [r,g,b] 自定义强调色
  recentSources: [],
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.settingsPath = path.join(dir, 'settings.json');
    this.historyPath = path.join(dir, 'history.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.history = [];
    this._writeTimer = null;
    this._historyTimer = null;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.settings = deepMerge(DEFAULT_SETTINGS, parsed);
    } catch { /* 首次运行 */ }
    try {
      const raw = await fsp.readFile(this.historyPath, 'utf8');
      this.history = JSON.parse(raw);
      if (!Array.isArray(this.history)) this.history = [];
    } catch { this.history = []; }
    return this;
  }

  getSettings() { return this.settings; }

  async updateSettings(patch) {
    this.settings = deepMerge(this.settings, patch || {});
    this.saveSettingsSoon();
    return this.settings;
  }

  saveSettingsSoon() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      fsp.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2)).catch(() => {});
    }, 250);
  }

  /** 立即落盘（退出前 / 自检恢复设置时必须调用） */
  async flush() {
    clearTimeout(this._writeTimer);
    clearTimeout(this._historyTimer);
    try {
      await fsp.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch {}
    try {
      await fsp.writeFile(this.historyPath, JSON.stringify(this.history));
    } catch {}
    return true;
  }

  addHistory(entry) {
    this.history.unshift(entry);
    if (this.history.length > 300) this.history.length = 300;
    this.saveHistorySoon();
  }

  updateHistory(id, patch) {
    const i = this.history.findIndex((h) => h.id === id);
    if (i >= 0) { this.history[i] = { ...this.history[i], ...patch }; this.saveHistorySoon(); }
    return this.history[i];
  }

  getHistory(id) { return this.history.find((h) => h.id === id) || null; }

  clearHistory() { this.history = []; this.saveHistorySoon(); }

  saveHistorySoon() {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => {
      fsp.writeFile(this.historyPath, JSON.stringify(this.history)).catch(() => {});
    }, 400);
  }
}

function isPlain(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlain(patch)) return patch === undefined ? out : patch;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isPlain(v) && isPlain(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = { Store, DEFAULT_SETTINGS, deepMerge };
