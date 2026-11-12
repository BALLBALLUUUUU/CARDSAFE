'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const { Store } = require('./lib/store');
const { listVolumes, probeSource, detectCard } = require('./lib/volumes');
const { runCopyJob, freeSpace, scanSource } = require('./lib/copyEngine');
const { expandTemplate, stamp, formatBytes, formatDuration, formatSpeed } = require('./lib/util');
const { buildReportHtml, exportPdf, buildCsv } = require('./lib/report');
const { notifyAll } = require('./lib/notify');
const { findFfmpeg, transcodeDest } = require('./lib/transcode');
const { ejectVolume } = require('./lib/eject');
const { Updater } = require('./lib/updater');

let mainWindow = null;
let store = null;
let updater = null;

const queue = [];        // 待执行任务
let current = null;      // { job, state, cancelFlag, historyId }
let cancelFlag = { cancelled: false };

/* ------------------------------------------------------------------ */
/* 旧数据迁移：改名后 userData 目录会变，把设置与历史带过来                */
/* ------------------------------------------------------------------ */
function migrateUserData() {
  try {
    const appData = app.getPath('appData');
    const current = app.getPath('userData');
    const legacy = path.join(appData, 'CardSafe');
    if (path.resolve(current) === path.resolve(legacy) || !fs.existsSync(legacy)) return;
    fs.mkdirSync(current, { recursive: true });
    for (const f of ['settings.json', 'history.json']) {
      const src = path.join(legacy, f);
      const dst = path.join(current, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        console.log('[migrate] ' + f + ' 已从旧目录迁移');
      }
    }
  } catch (e) {
    console.warn('[migrate] 跳过：' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function createWindow() {
  // macOS：窗口始终创建为透明，开关与滑块只改 CSS → 实时生效，不必重建窗口。
  // Windows：透明窗口必须在创建时指定，所以跟随设置创建（切换时重建）。
  // 不使用 macOS vibrancy —— 系统材质会自带一层着色，吃掉透明度的可调范围。
  const transparent = process.platform === 'darwin'
    ? true
    : !!(store && store.getSettings().transparent);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#0a0b0d',
    hasShadow: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message}  (${String(sourceId).split('/').pop()}:${line})`);
    });
    mainWindow.webContents.on('preload-error', (_e, p, err) => {
      console.error('[preload-error]', p, err && err.message);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[did-fail-load]', code, desc);
    });
  }
  const thisWin = mainWindow;
  thisWin.on('closed', () => { if (mainWindow === thisWin) mainWindow = null; });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 开发自检：CARDSAFE_SHOT=/path/to.png npm start 可自动截图后退出
    if (process.env.CARDSAFE_SHOT) {
      setTimeout(async () => {
        try {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (process.env.CARDSAFE_SHOT_DUMP) {
            const info = await mainWindow.webContents.executeJavaScript(`JSON.stringify({
              nav: document.querySelector('.nav-item.is-active')?.dataset.view,
              views: [...document.querySelectorAll('.view.is-active')].map(v => v.id),
              theme: document.documentElement.dataset.theme,
              accent: document.documentElement.dataset.accent,
              hist: document.querySelectorAll('.hist').length,
              histText: document.getElementById('histSummary')?.textContent,
              mode: (typeof THEME !== 'undefined' ? THEME.mode : '?'),
              skipJunk: document.getElementById('optSkipJunk')?.checked,
              scroll: document.getElementById('scrollArea')?.scrollTop,
              docH: document.getElementById('scrollArea')?.scrollHeight,
              trans: document.documentElement.dataset.transparent,
              veil: getComputedStyle(document.documentElement).getPropertyValue('--veil').trim(),
            })`);
            console.log('[shot] UI 状态: ' + info);

            console.log('[shot] 窗口底色: ' + mainWindow.getBackgroundColor() + ' | 透明: ' + (mainWindow.getBackgroundColor() === '#00000000'));
          }
          if (process.env.CARDSAFE_SHOT_CLICK) {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(process.env.CARDSAFE_SHOT_CLICK)})?.click(); "clicked"`,
            );
            await new Promise((res) => setTimeout(res, Number(process.env.CARDSAFE_SHOT_CLICK_WAIT || 1500)));
            if (process.env.CARDSAFE_SHOT_DUMP) {
              const after = await mainWindow.webContents.executeJavaScript(`JSON.stringify({
                nav: document.querySelector('.nav-item.is-active')?.dataset.view,
                views: [...document.querySelectorAll('.view.is-active')].map(v => v.id),
                sideText: document.getElementById('sideUpdateText')?.textContent,
              })`);
              console.log('[shot] 点击后: ' + after);
            }
          }
          if (process.env.CARDSAFE_SHOT_VIEW) {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('.nav-item[data-view="${process.env.CARDSAFE_SHOT_VIEW}"]')?.click(); "ok"`,
            );
            await new Promise((res) => setTimeout(res, 500));
          }
          if (process.env.CARDSAFE_SHOT_DOWNLOAD) {
            const r = await mainWindow.webContents.executeJavaScript(
              'appApi.update.check().then(() => appApi.update.download()).then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)',
            );
            console.log('[shot] 更新下载结果: ' + r);
            await new Promise((res) => setTimeout(res, 800));
          }
          if (process.env.CARDSAFE_SHOT_RUN) {
            const total = 48 * 1024 * 1024 * 1024;
            const copied = 21.6 * 1024 * 1024 * 1024;
            mainWindow.webContents.send('task:started', { id: 'CS20261109DEMO', roots: ['/Volumes/WORK_OR_RUN_4'] });
            mainWindow.webContents.send('task:progress', {
              taskId: 'CS20261109DEMO', phase: 'copying',
              totalFiles: 1284, doneFiles: 577, failedFiles: 0, skippedFiles: 0,
              totalBytes: total, copiedBytes: copied,
              speed: 1120 * 1024 * 1024, etaMs: 24000,
              currentFile: 'PRIVATE/M4ROOT/CLIP/C0127.MP4',
              startedAt: Date.now() - 19300, endedAt: null,
              dests: [
                { path: '/Volumes/WORK_OR_RUN_4/20261109_A7S3_CARD01', copiedBytes: copied, filesDone: 577, filesFailed: 0, filesSkipped: 0, verifyFailed: 0, status: '' },
                { path: '/Volumes/NAS_BACKUP/20261109_A7S3_CARD01', copiedBytes: copied * 0.94, filesDone: 540, filesFailed: 0, filesSkipped: 0, verifyFailed: 0, status: '' },
              ],
              errors: [],
            });
            for (const m of ['扫描完成：1284 个文件', '开始写入 2 个目标', '校验通过 C0126.MP4（MD5）', '跳过系统文件 .DS_Store']) {
              mainWindow.webContents.send('task:log', { id: 'CS20261109DEMO', at: Date.now(), level: 'info', msg: m });
            }
            await new Promise((r) => setTimeout(r, 900));
          }
          if (process.env.CARDSAFE_SHOT_JS) {
            const r = await mainWindow.webContents.executeJavaScript(process.env.CARDSAFE_SHOT_JS).catch((e) => 'ERR:' + e.message);
            console.log('[shot] JS=' + JSON.stringify(r));
            await new Promise((res) => setTimeout(res, 500));
          }
          const img = await mainWindow.webContents.capturePage();
          await fsp.writeFile(process.env.CARDSAFE_SHOT, img.toPNG());
          if (process.env.CARDSAFE_SHOT_DUMP) {
            const bmp = img.toBitmap();
            const w = img.getSize().width;
            const at = (x, y) => { const i = (y * w + x) * 4; return [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]]; };
            console.log('[shot] 像素 A(20,500)=' + at(20, 500) + ' B(600,40)=' + at(600, 40));
          }
        } catch (e) {
          console.error('capture failed', e);
        }
        app.quit();
      }, Number(process.env.CARDSAFE_SHOT_DELAY || 2500));
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* 任务队列                                                            */
/* ------------------------------------------------------------------ */
function queueSnapshot() {
  return {
    running: current ? { id: current.job.id, source: current.job.sourcePath } : null,
    pending: queue.map((j) => ({ id: j.id, source: j.sourcePath, project: j.project })),
  };
}

function broadcastQueue() { send('queue:state', queueSnapshot()); }

async function enqueue(spec) {
  const now = new Date();
  const t = stamp(now);
  const id = `CS${t.date}${t.time}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;

  const s = store.getSettings();
  const algo = spec.algorithm || s.algorithm;
  const template = spec.template || '{date}_{card}';

  const dests = (spec.destinations || []).map((d) => {
    const base = typeof d === 'string' ? d : d.base;
    const tpl = (typeof d === 'object' && d.template) || template;
    return {
      base,
      root: path.join(base, expandTemplate(tpl, {
        now, project: spec.project || '', card: spec.cardLabel || '', camera: spec.camera || '', taskId: id,
      })),
    };
  });

  if (!spec.sourcePath) throw new Error('未选择素材来源');
  if (!dests.length) throw new Error('请至少添加一个目标路径');

  const job = {
    id,
    taskId: id, // 与 id 同值，供进度事件与渲染层比对
    source: spec.sourcePath,
    sourcePath: spec.sourcePath,
    cardLabel: spec.cardLabel || path.basename(spec.sourcePath),
    camera: spec.camera || (await detectCard(spec.sourcePath)) || '',
    project: spec.project || '',
    template,
    algorithm: algo,
    verify: spec.verify || s.verify,
    destinations: dests,
    options: {
      skipJunk: spec.skipJunk !== undefined ? spec.skipJunk : s.skipJunk,
      skipExisting: spec.skipExisting !== undefined ? spec.skipExisting : s.skipExisting,
      preserveTime: spec.preserveTime !== undefined ? spec.preserveTime : s.preserveTime,
      verify: spec.verify || s.verify,
      concurrency: spec.concurrency || s.concurrency,
    },
    transcode: (spec.transcode && spec.transcode.enabled) ? spec.transcode : null,
    autoReport: spec.autoReport !== undefined ? !!spec.autoReport : (s.autoReport !== false),
    dateText: `${t.dateDash} ${t.timeColon}`,
    createdAt: now.getTime(),
    status: 'queued',
  };

  store.addHistory({
    id: job.id, dateText: job.dateText, sourcePath: job.sourcePath, camera: job.camera,
    project: job.project, template, algorithm: algo, verify: job.options.verify,
    destinations: dests.map((d) => d.base), roots: dests.map((d) => d.root),
    phase: 'queued', totalFiles: 0, totalBytes: 0, copiedBytes: 0, failedFiles: 0,
    dests: [], errors: [], manifest: [], startedAt: null, endedAt: null,
  });

  queue.push(job);
  broadcastQueue();
  send('history:changed');
  pump();
  return job.id;
}

async function pump() {
  if (current || !queue.length) return;
  const job = queue.shift();
  cancelFlag = { cancelled: false };
  current = { job, state: null };
  broadcastQueue();

  const settings = store.getSettings();
  const historyPatch = { phase: 'running', startedAt: Date.now() };
  store.updateHistory(job.id, historyPatch);
  send('task:started', { id: job.id, roots: job.destinations.map((d) => d.root) });

  let result;
  try {
    result = await runCopyJob(job, {
      flag: cancelFlag,
      onProgress: (state) => {
        if (!current) return;
        current.state = state;
        store.updateHistory(job.id, {
          phase: state.phase, totalFiles: state.totalFiles, totalBytes: state.totalBytes,
          copiedBytes: state.copiedBytes, failedFiles: state.failedFiles,
        });
        send('task:progress', state);
      },
      onLog: (entry) => send('task:log', { id: job.id, at: Date.now(), ...entry }),
    });
  } catch (e) {
    result = { state: { phase: 'failed', errors: [{ message: e.message }], dests: [] }, manifest: [], ok: false };
  }

  const state = result.state;
  let transcodeResult = null;
  const logTo = (entry) => send('task:log', { id: job.id, at: Date.now(), ...entry });

  if (job.transcode && state.phase === 'done') {
    state.phase = 'transcoding';
    send('task:progress', { ...state });
    try {
      transcodeResult = await transcodeDest(
        { ...job, destinations: job.destinations, manifest: result.manifest || [] },
        { onLog: logTo, onProgress: (p) => send('task:transcode', { id: job.id, ...p }) },
      );
    } catch (e) {
      logTo({ level: 'error', msg: '转码异常：' + e.message });
    }
    state.phase = state.failedFiles > 0 ? 'failed' : 'done';
  }

  const endedAt = state.endedAt || Date.now();
  const entry = {
    phase: state.phase,
    endedAt,
    totalFiles: state.totalFiles,
    totalBytes: state.totalBytes,
    copiedBytes: state.copiedBytes,
    failedFiles: state.failedFiles,
    skippedFiles: state.skippedFiles,
    dests: state.dests,
    errors: (state.errors || []).slice(0, 500),
    manifest: (result.manifest || []).slice(0, 20000),
    transcode: transcodeResult ? { ok: transcodeResult.ok, files: transcodeResult.files } : null,
  };
  store.updateHistory(job.id, entry);
  const full = store.getHistory(job.id);
  send('history:changed');

  // 自动导出报告
  let reportPath = '';
  if (job.autoReport) {
    try {
      const dir = settings.reportDir || path.join(app.getPath('documents'), 'CARDSAFE 拷卡报告');
      await fsp.mkdir(dir, { recursive: true });
      reportPath = path.join(dir, `${job.id}_${state.phase === 'done' ? 'OK' : 'FAIL'}.pdf`);
      await exportPdf(buildReportHtml({ ...full, dateText: job.dateText }, { reportPath }), reportPath, BrowserWindow);
      store.updateHistory(job.id, { reportPath });
    } catch (e) {
      logTo({ level: 'error', msg: '报告导出失败：' + e.message });
    }
  }

  const duration = endedAt - (state.startedAt || endedAt);
  const summary = {
    id: job.id,
    phase: state.phase,
    files: state.totalFiles,
    bytes: state.totalBytes,
    failed: state.failedFiles,
    duration,
    speed: duration > 0 ? state.totalBytes / (duration / 1000) : 0,
    reportPath,
    errorCount: (state.errors || []).length,
  };
  send('task:done', summary);

  // 通知
  try {
    await notifyAll(settings, {
      title: state.phase === 'done' ? '拷卡完成' : state.phase === 'cancelled' ? '拷卡已取消' : '拷卡有异常',
      status: state.phase,
      lines: [
        `任务：${job.id}`,
        `来源：${job.cardLabel}`,
        `文件：${state.totalFiles} 个 / ${formatBytes(state.totalBytes)}`,
        `耗时：${formatDuration(duration)}（${formatSpeed(summary.speed)}）`,
        `失败：${state.failedFiles} 个`,
        reportPath ? `报告：${reportPath}` : '',
      ].filter(Boolean),
    });
  } catch (e) {
    logTo({ level: 'warn', msg: '通知发送失败：' + e.message });
  }

  // 自动弹出
  if (settings.autoEject && state.phase === 'done' && job.sourcePath.includes(
    process.platform === 'darwin' ? '/Volumes/' : ':\\',
  )) {
    try {
      const r = await ejectVolume(job.sourcePath);
      logTo({ level: r.ok ? 'info' : 'warn', msg: r.message });
    } catch (e) {
      logTo({ level: 'warn', msg: '弹出失败：' + e.message });
    }
  }

  current = null;
  broadcastQueue();
  setTimeout(pump, 300);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    home: os.homedir(),
    sep: path.sep,
  }));

  // 主题切换时同步系统材质明暗（窗口本身始终透明，不能再设不透明底色）
  ipcMain.handle('window:bg', (_e, color) => {
    try { nativeTheme.themeSource = String(color).toLowerCase() === '#e9ebef' ? 'light' : 'dark'; } catch {}
    return true;
  });

  ipcMain.handle('volumes:list', async (_e, force) => listVolumes(!!force));

  ipcMain.handle('source:probe', async (_e, p) => {
    const info = await probeSource(p);
    const fsInfo = await freeSpace(p);
    return { ...info, size: fsInfo };
  });

  // 只统计数量与容量（不读内容），用于开始前的预估
  ipcMain.handle('source:scan', async (_e, p) => {
    const s = store.getSettings();
    const r = await scanSource(p, { skipJunk: s.skipJunk !== false });
    return { files: r.files.length, bytes: r.totalBytes };
  });

  ipcMain.handle('dialog:pickDir', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: opts.defaultPath,
      buttonLabel: opts.buttonLabel || '选择',
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFile', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: opts.filters,
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:savePdf', async (_e, defaultName) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '保存拷卡报告',
      defaultPath: path.join(app.getPath('documents'), defaultName || `CARDSAFE_${stamp().date}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const s = await store.updateSettings(patch);
    return s;
  });

  ipcMain.handle('task:enqueue', async (_e, spec) => {
    const id = await enqueue(spec);
    return { id };
  });
  ipcMain.handle('task:cancel', async () => {
    cancelFlag.cancelled = true;
    queue.length = 0;
    broadcastQueue();
    return true;
  });
  ipcMain.handle('queue:state', () => queueSnapshot());

  ipcMain.handle('history:list', () => store.history.map(stripHeavy));
  ipcMain.handle('history:get', (_e, id) => {
    const h = store.getHistory(id);
    if (!h) return null;
    return { ...h, manifestCount: (h.manifest || []).length, manifest: (h.manifest || []).slice(0, 500) };
  });
  ipcMain.handle('history:clear', () => { store.clearHistory(); send('history:changed'); return true; });
  ipcMain.handle('history:remove', (_e, id) => {
    store.history = store.history.filter((h) => h.id !== id);
    store.saveHistorySoon();
    send('history:changed');
    return true;
  });

  ipcMain.handle('report:pdf', async (_e, { id, savePath }) => {
    const h = store.getHistory(id);
    if (!h) throw new Error('找不到任务记录');
    let out = savePath;
    if (!out) {
      out = await new Promise((resolve) => {
        dialog.showSaveDialog(mainWindow, {
          title: '保存拷卡报告',
          defaultPath: path.join(app.getPath('documents'), `${id}.pdf`),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        }).then((r) => resolve(r.canceled ? null : r.filePath));
      });
      if (!out) return null;
    }
    await exportPdf(buildReportHtml(h, { reportPath: out }), out, BrowserWindow);
    store.updateHistory(id, { reportPath: out });
    return out;
  });

  ipcMain.handle('report:csv', async (_e, id) => {
    const h = store.getHistory(id);
    if (!h) throw new Error('找不到任务记录');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出 CSV 清单',
      defaultPath: path.join(app.getPath('documents'), `${id}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled) return null;
    await fsp.writeFile(r.filePath, buildCsv(h), 'utf8');
    return r.filePath;
  });

  ipcMain.handle('report:preview', async (_e, id) => {
    const h = store.getHistory(id);
    if (!h) return null;
    const tmp = path.join(os.tmpdir(), `cardsafe-report-${id}.html`);
    await fsp.writeFile(tmp, buildReportHtml(h, { reportPath: h.reportPath || '' }), 'utf8');
    const w = new BrowserWindow({
      width: 940, height: 900, title: `拷卡报告 ${id}`,
      webPreferences: { javascript: false, sandbox: true },
    });
    w.loadFile(tmp);
    return tmp;
  });

  ipcMain.handle('eject:volume', async (_e, p) => ejectVolume(p));

  ipcMain.handle('ffmpeg:check', async () => {
    const s = store.getSettings();
    const bin = await findFfmpeg(s.transcode.ffmpegPath);
    return { found: !!bin, path: bin || '' };
  });

  /* ---------------- 软件更新 ---------------- */
  ipcMain.handle('update:state', () => updater.snapshot());
  ipcMain.handle('update:check', async () => {
    try {
      return { ok: true, ...(await updater.check({ silent: false })) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('update:download', async () => {
    try {
      const r = await updater.download();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('update:install', async () => {
    try {
      return { ok: true, ...(await updater.install()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('update:skip', async (_e, version) => {
    await store.updateSettings({ update: { skippedVersion: version || '' } });
    if (version) updater.setState({ status: 'uptodate' });
    return true;
  });
  ipcMain.handle('update:openNotes', async () => {
    const u = updater.state.notesUrl;
    if (u) shell.openExternal(u);
    return !!u;
  });

  ipcMain.handle('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); return true; });
  ipcMain.handle('shell:open', (_e, p) => { if (p) shell.openPath(p); return true; });

  ipcMain.handle('notify:test', async () => {
    await notifyAll(store.getSettings(), {
      title: 'CARDSAFE 测试通知',
      status: 'test',
      lines: ['如果你看到这条消息，说明通知通道配置成功。'],
    });
    return true;
  });

  // 透明开关：macOS 只切 CSS（窗口本来就是透明的，滑块才能实时生效）；
  // Windows 的透明窗口必须在创建时指定，这里重建一次。
  ipcMain.handle('window:setTransparent', async (_e, on) => {
    await store.updateSettings({ transparent: !!on });
    await store.flush();
    if (process.platform !== 'darwin') {
      const old = mainWindow;
      mainWindow = null;
      if (old && !old.isDestroyed()) old.destroy();
      setTimeout(() => createWindow(), 80);
    }
    return true;
  });

  // 透明度滑块：0=不透明，100=全透明（纯 CSS，实时生效）
  ipcMain.handle('window:setOpacityLevel', async (_e, level) => {
    const lv = Math.max(0, Math.min(100, Number(level) || 0));
    await store.updateSettings({ transparentLevel: lv });
    return true;
  });

  ipcMain.handle('window:minimize', () => { mainWindow && mainWindow.minimize(); });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => { mainWindow && mainWindow.close(); });
}

function stripHeavy(h) {
  const { manifest, errors, dests, ...rest } = h;
  return { ...rest, manifestCount: (manifest || []).length, errorCount: (errors || []).length, dests: dests || [] };
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  app.setName('CARDSAFE');
  if (process.platform === 'win32') app.setAppUserModelId('net.cardsafe.app');
  migrateUserData();
  store = await new Store(app.getPath('userData')).init();
  updater = new Updater({
    app,
    store,
    emit: (payload) => send('update:event', payload),
  });
  registerIpc();
  buildMenu();
  createWindow();
  updater.scheduleAutoCheck(6000);

  // 端到端自检：CARDSAFE_E2E=1 npm start
  if (process.env.CARDSAFE_E2E) {
    const { runE2E } = require('./lib/selftest');
    runE2E({ enqueue, getHistory: (id) => store.getHistory(id), store })
      .then(async (r) => {
        console.log('E2E_RESULT ' + JSON.stringify(r, null, 2));
        await store.flush();
        app.exit(r.ok ? 0 : 1);
      })
      .catch(async (e) => {
        console.error('E2E_FAIL ' + (e && e.stack || e));
        await store.flush();
        app.exit(1);
      });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'CARDSAFE',
      submenu: [
        { role: 'about', label: '关于 CARDSAFE' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'quit', label: '退出 CARDSAFE' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
