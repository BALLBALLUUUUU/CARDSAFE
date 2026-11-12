'use strict';
/* CardSafe 渲染进程 */

const $ = (id) => document.getElementById(id);
const appApi = window.api;

const S = {
  platform: 'darwin',
  settings: null,
  volumes: [],
  source: null,       // { path, label, camera, total, free }
  probe: null,        // { files, bytes }
  dests: [],          // [{ base }]
  running: false,
  taskId: null,
  reportPath: '',
  scanToken: 0,
};

/* ---------------- 工具 ---------------- */
function fmtBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + u[i];
}
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function fmtSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '--';
  return fmtBytes(bps) + '/s';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}
function expandTpl(tpl, ctx = {}) {
  const t = stampNow();
  const vars = {
    date: t.date, time: t.time, yyyy: t.date.slice(0, 4),
    project: ctx.project || '', card: ctx.card || '', camera: ctx.camera || '', taskid: ctx.taskId || '',
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/* ---------------- 导航 ---------------- */
const TITLES = { copy: '拷卡', history: '拷卡记录', settings: '设置', about: '关于' };
function switchView(v) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('is-active', s.id === 'view-' + v));
  $('viewTitle').textContent = TITLES[v] || '';
  $('btnRefresh').style.visibility = v === 'copy' ? 'visible' : 'hidden';
  $('scrollArea').scrollTop = 0;
  if (v === 'history') renderHistory();
  if (v === 'settings') loadSettingsUI();
  if (v === 'about') renderAbout();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

/* ---------------- 主题 ---------------- */
const THEME = { mode: 'auto', accentRgb: null, dayStart: 7, nightStart: 19 };

const rgbHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

function effectiveTheme() {
  if (THEME.mode === 'light' || THEME.mode === 'dark') return THEME.mode;
  const h = new Date().getHours();
  return h >= THEME.dayStart && h < THEME.nightStart ? 'light' : 'dark';
}

function lumOf(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function mixRgb(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

/**
 * 强调色只决定“背景与色块”，文字一律使用主题前景色。
 * 另外派生 --accent-edge：保证在浅色背景上仍然看得见的描边色。
 */
function applyAccent() {
  const root = document.documentElement;
  const theme = root.dataset.theme === 'light' ? 'light' : 'dark';
  const base = THEME.accentRgb || (theme === 'light' ? [26, 29, 34] : [232, 235, 239]);
  const [r, g, b] = base;
  const lum = lumOf(base);

  let edge = base;
  if (theme === 'light' && lum > 0.42) edge = mixRgb(base, [18, 22, 28], Math.min(0.72, (lum - 0.42) * 1.9));
  if (theme === 'dark' && lum < 0.10) edge = mixRgb(base, [238, 242, 248], Math.min(0.62, (0.10 - lum) * 4.5));

  const st = root.style;
  st.setProperty('--accent', rgbHex(r, g, b));
  st.setProperty('--accent-d', rgbHex(...mixRgb(base, [10, 12, 16], 0.22)));
  st.setProperty('--on-accent', lum > 0.55 ? '#0d0f12' : '#ffffff');
  st.setProperty('--accent-edge', `rgb(${edge[0]},${edge[1]},${edge[2]})`);
  st.setProperty('--accent-soft', `rgba(${r},${g},${b},0.16)`);
  st.setProperty('--accent-faint', `rgba(${r},${g},${b},0.06)`);
  st.setProperty('--accent-line', `rgba(${edge[0]},${edge[1]},${edge[2]},0.34)`);
  st.setProperty('--accent-line-strong', `rgba(${edge[0]},${edge[1]},${edge[2]},0.46)`);
  st.setProperty('--accent-glow', `rgba(${r},${g},${b},0.26)`);
}

function applyTheme() {
  const eff = effectiveTheme();
  const root = document.documentElement;
  root.dataset.theme = eff;
  applyAccent();
  if (appApi.setWindowBg) {
    appApi.setWindowBg(eff === 'light' ? '#e9ebef' : '#0a0b0d').catch(() => {});
  }
  renderThemeUI(eff);
}

function renderThemeUI(eff) {
  const mode = THEME.mode;
  document.querySelectorAll('#themeSeg button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mode === mode);
  });
  const rgb = THEME.accentRgb || (eff === 'light' ? [24, 27, 32] : [232, 235, 239]);
  const hex = rgbHex(...rgb);
  ['R', 'G', 'B'].forEach((ch, i) => {
    const el = $('accent' + ch);
    if (el && document.activeElement !== el) el.value = rgb[i];
  });
  $('accentHex').textContent = hex;
  $('accentSwatch').style.background = hex;
  $('accentColor').value = hex.toLowerCase();

  const modeText = { auto: '跟随时间', light: '白天', dark: '夜间' }[mode] || '';
  const actual = eff === 'light' ? '白天' : '夜间';
  const accentText = THEME.accentRgb ? `自定义 ${hex}` : '黑白（默认）';
  $('themeHint').textContent = mode === 'auto'
    ? `当前：${actual} · ${accentText}　（07:00–19:00 自动切换白天，其余时间夜间）`
    : `当前：${actual} · ${accentText}`;
  $('verText').textContent = 'v' + (S.version || '1.2.0');
}

/**
 * 背景透明度。
 * on    是否启用透明模式
 * level 0–100，0=完全不透明，100=完全透出桌面（薄纱 alpha = 1 - level/100）
 */
function applyTransparency(on, level) {
  const root = document.documentElement;
  const raw = level == null ? Number($('transparentLevel').value) : Number(level);
  const lv = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 55;

  root.dataset.transparent = on ? 'true' : 'false';
  // 0% → 完全不透明；100% → 只留 10% 的底纱，桌面清晰可见但文字仍有最低对比
  const veil = 0.10 + (1 - lv / 100) * 0.90;
  root.style.setProperty('--veil', veil.toFixed(3));

  const slider = $('transparentLevel');
  if (slider) {
    if (document.activeElement !== slider) slider.value = String(lv);
    slider.style.setProperty('--pct', lv + '%');
  }
  const val = $('transparentVal');
  if (val) val.textContent = lv + '%';
  $('opacityRow')?.classList.toggle('is-off', !on);
  $('opacityScale')?.classList.toggle('is-off', !on);
}

function setThemeMode(mode) {
  THEME.mode = mode;
  applyTheme();
  appApi.saveSettings({ themeMode: mode }).catch(() => {});
}

function setAccentRgb(rgb, persist = true) {
  THEME.accentRgb = rgb ? rgb.map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))) : null;
  applyTheme();
  if (persist) appApi.saveSettings({ accentRgb: THEME.accentRgb }).catch(() => {});
}
function readRgbInputs() {
  const v = ['R', 'G', 'B'].map((ch) => {
    const n = Number($('accent' + ch).value);
    return Number.isFinite(n) ? n : 0;
  });
  return v;
}

// 每分钟检查一次是否该切换（自动模式）
setInterval(() => {
  if (THEME.mode !== 'auto') return;
  const eff = effectiveTheme();
  if (document.documentElement.dataset.theme !== eff) applyTheme();
}, 60000);

/* ---------------- 卷列表 ---------------- */
async function loadVolumes(force = false) {
  const grid = $('volGrid');
  grid.innerHTML = '<div class="vol-empty">正在识别设备…</div>';
  try {
    const list = force ? await appApi.volumesRefresh() : await appApi.volumes();
    S.volumes = list || [];
    renderVolumes();
  } catch (e) {
    grid.innerHTML = `<div class="vol-empty">识别失败：${esc(e.message)}</div>`;
  }
}
function renderVolumes() {
  const grid = $('volGrid');
  if (!S.volumes.length) {
    grid.innerHTML = `<div class="vol-empty">
      <div>未检测到可用的磁盘。插入读卡器后点右上角「刷新设备」。</div>
      <button class="btn ghost sm" id="btnBrowseEmpty" style="margin-top:10px">选择文件夹…</button>
    </div>`;
    const b = $('btnBrowseEmpty');
    if (b) b.addEventListener('click', browseSource);
    return;
  }
  grid.innerHTML = S.volumes.map((v) => {
    const used = v.total > 0 ? ((v.total - v.free) / v.total) * 100 : 0;
    const sel = S.source && S.source.path === v.path ? ' is-sel' : '';
    return `<button class="vol ${v.isCard ? 'is-card' : ''}${sel}" data-path="${esc(v.path)}">
      <div class="vol-top">
        <span class="vol-name">${esc(v.label)}</span>
        ${v.isCard ? '<span class="vol-tag">素材卡</span>' : `<span class="vol-tag fixed">${v.removable ? '可移动' : '本地'}</span>`}
      </div>
      <div class="vol-meta">${fmtBytes(v.free)} 可用 / ${fmtBytes(v.total)}</div>
      <div class="vol-bar"><i style="width:${used.toFixed(1)}%"></i></div>
      ${v.camera ? `<div class="vol-meta" style="margin-top:2px;color:var(--tx-3)">${esc(v.camera)}</div>` : ''}
    </button>`;
  }).join('');
  grid.querySelectorAll('.vol').forEach((el) => {
    el.addEventListener('click', () => {
      const v = S.volumes.find((x) => x.path === el.dataset.path);
      if (v) selectSource(v);
    });
  });
}

async function browseSource() {
  const p = await appApi.pickDir({ title: '选择素材来源文件夹' });
  if (!p) return;
  const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
  await selectSource({ path: p, label: name, camera: '', total: 0, free: 0 });
}

async function selectSource(v) {
  S.source = {
    path: v.path, label: v.label, camera: v.camera || '',
    total: v.total || 0, free: v.free || 0,
  };
  renderVolumes();
  renderSource();
  updateEstimate();
  updateStartState();
  // 后台统计大小
  const token = ++S.scanToken;
  $('estValue').textContent = '统计中…';
  try {
    await appApi.probe(v.path);
    const scan = await appApi.scan(v.path);
    if (token !== S.scanToken) return;
    S.probe = scan || { files: 0, bytes: 0 };
    updateEstimate();
  } catch (e) {
    if (token === S.scanToken) $('estValue').textContent = '统计失败';
  }
}
function renderSource() {
  const box = $('srcSelected');
  if (!S.source) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('srcName').textContent = S.source.label;
  const parts = [S.source.path];
  if (S.source.camera) parts.push(S.source.camera);
  if (S.source.total) parts.push(`${fmtBytes(S.source.total)}（可用 ${fmtBytes(S.source.free)}）`);
  $('srcMeta').textContent = parts.join(' · ');
  renderHero();
}

function renderHero(state) {
  const src = S.source;
  const pill = $('heroPill');
  if (src) {
    $('heroTitle').textContent = src.label;
    const isCard = !!src.camera;
    pill.className = 'pill ' + (isCard ? 'is-ok' : 'is-on');
    pill.innerHTML = `<i></i>${isCard ? '素材卡已连接' : '已选择文件夹'}`;
    $('heroPath').textContent = src.path;
  } else {
    $('heroTitle').textContent = '未选择素材卡';
    pill.className = 'pill';
    pill.innerHTML = '<i></i>等待设备';
    $('heroPath').textContent = '插入读卡器，或手动选择文件夹';
  }
  if (state) {
    const pct = state.totalBytes ? Math.round((state.copiedBytes / state.totalBytes) * 100) : 0;
    $('heroPct').textContent = pct;
    $('heroState').textContent = {
      scanning: '正在扫描', copying: '正在拷贝', verifying: '正在校验',
      transcoding: '正在转码', done: '拷贝完成', failed: '存在异常', cancelled: '已取消',
    }[state.phase] || '拷贝等待中';
  }
}

/* ---------------- 目标 ---------------- */
function renderDests() {
  const box = $('destList');
  if (!S.dests.length) {
    box.innerHTML = '<div class="dest-empty">还没有目标磁盘，点右上角「+ 添加」选择备份位置</div>';
    renderTplPreview();
    return;
  }
  const verifyMode = $('verifySelect').value;
  box.innerHTML = S.dests.map((d, i) => {
    const preview = d.base ? joinPreview(d.base, expandTpl($('tplInput').value || '{date}_{card}', {
      project: $('projectInput').value, card: S.source ? S.source.label : '', camera: S.source ? S.source.camera : '',
    })) : '';
    const vol = S.volumes.find((v) => v.path === d.base);
    const need = S.probe ? S.probe.bytes : 0;
    const warn = vol && need && vol.free < need;
    const verifyText = verifyMode === 'none' ? '未启用' : warn ? '待开始' : '待开始';
    return `<div class="dcard" data-i="${i}">
      <div class="dcard-head">
        <span class="dcard-label">拷贝目的地</span>
        <span class="dcard-path" title="${esc(preview || d.base)}">${esc(preview || d.base)}</span>
        ${warn ? '<span class="pill" style="color:var(--warn);border-color:rgba(232,163,61,.35)">空间不足</span>' : ''}
        <button class="dcard-x" data-act="open" title="在访达中打开" style="font-size:12px">▤</button>
        <button class="dcard-x" data-act="rm" title="移除">×</button>
      </div>
      <div class="dcard-body">
        <div class="cell copy idle"><span class="cell-k">拷贝</span><span class="cell-v">${vol ? fmtBytes(vol.free) + ' 可用' : '待开始'}</span></div>
        <div class="cell verify idle"><span class="cell-k">校验</span><span class="cell-v">${verifyText}</span></div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.dcard').forEach((card) => {
    const i = Number(card.dataset.i);
    const rm = card.querySelector('[data-act="rm"]');
    if (rm) rm.addEventListener('click', () => {
      S.dests.splice(i, 1);
      renderDests(); updateStartState();
    });
    const open = card.querySelector('[data-act="open"]');
    if (open) open.addEventListener('click', () => { if (S.dests[i]) appApi.open(S.dests[i].base); });
  });
  renderTplPreview();
}

function joinPreview(base, tpl) {
  const sep = S.platform === 'win32' ? '\\' : '/';
  const t = tpl.split(/[\\/]/).filter(Boolean).join(sep);
  return base.replace(/[\\/]+$/, '') + sep + t;
}
function renderTplPreview() {
  const tpl = $('tplInput').value || '{date}_{card}';
  const base = S.dests[0] ? S.dests[0].base : (S.platform === 'win32' ? 'D:\\' : '/Volumes/备份盘');
  $('tplPreview').textContent = '预览：' + joinPreview(base, expandTpl(tpl, {
    project: $('projectInput').value,
    card: S.source ? S.source.label : 'CARD',
    camera: S.source ? S.source.camera : '',
  }));
}
async function addDest() {
  const p = await appApi.pickDir({ title: '选择备份目标文件夹', defaultPath: S.dests.length ? S.dests[S.dests.length - 1].base : undefined });
  if (!p) return;
  if (S.dests.some((d) => d.base === p)) { toast('该目标已添加', 'warn'); return; }
  S.dests.push({ base: p });
  renderDests(); updateStartState();
}

/* ---------------- 预估 / 校验 ---------------- */
async function updateEstimate() {
  if (!S.source) { $('estValue').textContent = '—'; return; }
  if (!S.probe) { $('estValue').textContent = '统计中…'; return; }
  const multi = Math.max(1, S.dests.length);
  $('estValue').textContent = `${S.probe.files} 个文件 · ${fmtBytes(S.probe.bytes)} × ${multi} 目标`;
  renderDests();
}
function updateStartState() {
  $('btnStart').disabled = S.running || !S.source || S.dests.length === 0;
}

/* ---------------- 开始任务 ---------------- */
async function startTask() {
  if (!S.source) return toast('请先选择素材来源', 'err');
  if (!S.dests.length) return toast('请至少添加一个目标路径', 'err');
  const tpl = ($('tplInput').value || '{date}_{card}').trim();
  const spec = {
    sourcePath: S.source.path,
    cardLabel: S.source.label,
    camera: S.source.camera,
    project: $('projectInput').value.trim(),
    template: tpl,
    algorithm: $('algoSelect').value,
    verify: $('verifySelect').value,
    concurrency: Number($('concSelect').value),
    skipJunk: $('optSkipJunk').checked,
    skipExisting: $('optSkipExist').checked,
    preserveTime: $('optKeepTime').checked,
    autoReport: $('optAutoReport').checked,
    destinations: S.dests.map((d) => ({ base: d.base, template: tpl })),
    transcode: { enabled: $('optTranscode').checked, preset: (S.settings && S.settings.transcode.preset) || 'proxy_h264' },
  };
  try {
    const r = await appApi.enqueue(spec);
    S.taskId = r.id;
    S.running = true;
    // 记住本次选项，下次打开保持一致
    appApi.saveSettings({
      template: tpl,
      algorithm: spec.algorithm,
      verify: spec.verify,
      concurrency: spec.concurrency,
      skipJunk: spec.skipJunk,
      skipExisting: spec.skipExisting,
      preserveTime: spec.preserveTime,
      autoEject: $('optAutoEject').checked,
      autoReport: spec.autoReport,
    }).catch(() => {});
    enterRunMode();
    toast('任务已加入队列：' + r.id);
  } catch (e) {
    toast('创建任务失败：' + e.message, 'err');
  }
}

function enterRunMode() {
  $('copyForm').classList.add('hidden');
  $('runPanel').classList.remove('hidden');
  $('logBox').innerHTML = '';
  $('btnCancel').classList.remove('hidden');
  $('btnNewTask').classList.add('hidden');
  $('btnOpenReport').classList.add('hidden');
  setRing(0);
  $('heroPct').textContent = '0';
  $('heroState').textContent = '准备中';
  $('runStatus').textContent = '准备中…';
  $('runSub').textContent = '正在扫描素材…';
}
function exitRunMode() {
  S.running = false;
  $('runPanel').classList.add('hidden');
  $('copyForm').classList.remove('hidden');
  updateStartState();
}

function setRing(pct) {
  const c = 2 * Math.PI * 52;
  $('ringFg').style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(1, pct))));
  $('ringNum').textContent = Math.round(pct * 100) + '%';
}

/* ---------------- 进度 ---------------- */
appApi.onProgress((st) => {
  // 只有两边都有 id 且不一致时才丢弃；id 缺失时照常渲染，避免整段进度被静默吞掉
  if (S.taskId && st.taskId && st.taskId !== S.taskId) return;
  renderHero(st);
  const pct = st.totalBytes > 0 ? st.copiedBytes / st.totalBytes : 0;
  setRing(pct);
  const phaseText = {
    scanning: '正在扫描素材…', copying: '正在拷贝…', verifying: '正在校验…',
    transcoding: '正在转码…', done: '已完成', failed: '已完成（有异常）', cancelled: '已取消',
  }[st.phase] || st.phase;
  $('runStatus').textContent = phaseText;
  $('runSub').textContent = `${st.doneFiles}/${st.totalFiles} 个文件 · ${fmtBytes(st.copiedBytes)} / ${fmtBytes(st.totalBytes)}`;
  $('stCopied').textContent = `${fmtBytes(st.copiedBytes)} / ${fmtBytes(st.totalBytes)}`;
  $('stSpeed').textContent = fmtSpeed(st.speed);
  $('stEta').textContent = st.phase === 'copying' ? fmtDur(st.etaMs) : '--';
  $('stFiles').textContent = `${st.doneFiles} / ${st.totalFiles}`;
  $('stFail').textContent = String(st.failedFiles || 0);
  $('stFail').classList.toggle('bad', (st.failedFiles || 0) > 0);
  $('curFile').textContent = st.currentFile || '—';

  const dp = $('destProgress');
  if (dp.dataset.count !== String(st.dests.length)) {
    dp.dataset.count = String(st.dests.length);
    dp.innerHTML = st.dests.map((d, i) => `<div class="dcard" data-i="${i}">
      <div class="dcard-head"><span class="dcard-label">拷贝目的地</span><span class="dcard-path" title="${esc(d.path)}">${esc(d.path)}</span></div>
      <div class="dcard-body">
        <div class="cell copy"><span class="cell-k">拷贝</span><span class="cell-v" data-k="copy">待开始</span></div>
        <div class="cell verify"><span class="cell-k">校验</span><span class="cell-v" data-k="verify">待开始</span></div>
      </div>
      <div class="dp-bar"><i></i></div>
    </div>`).join('');
  }
  st.dests.forEach((d, i) => {
    const el = dp.children[i];
    if (!el) return;
    const p = st.totalBytes > 0 ? Math.min(1, d.copiedBytes / st.totalBytes) : 0;
    el.querySelector('.dp-bar i').style.width = (p * 100).toFixed(1) + '%';
    const pct = Math.round(p * 100);
    el.querySelector('[data-k="copy"]').textContent = `${pct}% · ${fmtBytes(d.copiedBytes)}`;
    const vEl = el.querySelector('[data-k="verify"]');
    const cell = vEl.closest('.cell');
    if (d.verifyFailed > 0) {
      vEl.textContent = `${d.verifyFailed} 个失败`;
      cell.className = 'cell verify fail';
    } else if (d.filesFailed > 0) {
      vEl.textContent = '有异常';
      cell.className = 'cell verify fail';
    } else if (st.phase === 'done' && pct === 100) {
      vEl.textContent = '✓ 通过';
      cell.className = 'cell verify ok';
    } else if (d.filesDone > 0) {
      vEl.textContent = `已完成 ${d.filesDone} 个`;
      cell.className = 'cell verify';
    } else {
      vEl.textContent = '待开始';
      cell.className = 'cell verify';
    }
  });
});

appApi.onTaskStart((p) => {
  S.taskId = p.id;
  if (!S.running) { S.running = true; enterRunMode(); }
  logLine('info', '任务开始：' + p.id);
});
appApi.onLog((l) => logLine(l.level, l.msg));
appApi.onTranscode((p) => {
  $('runStatus').textContent = `正在转码 ${p.done}/${p.total}`;
  setRing(p.total ? p.done / p.total : 0);
});
appApi.onTaskDone((d) => {
  S.reportPath = d.reportPath || '';
  renderHero({ phase: d.phase, totalBytes: d.bytes, copiedBytes: d.phase === 'cancelled' ? 0 : d.bytes });
  // 收尾时补齐统计卡片：否则进度事件停止后这几格会永远停在「—」
  const doneBytes = d.phase === 'cancelled' ? 0 : d.bytes;
  $('stCopied').textContent = `${fmtBytes(doneBytes)} / ${fmtBytes(d.bytes)}`;
  $('stSpeed').textContent = fmtSpeed(d.speed);
  $('stEta').textContent = '--';
  $('stFiles').textContent = `${d.files} / ${d.files}`;
  $('stFail').textContent = String(d.failed || 0);
  $('stFail').classList.toggle('bad', (d.failed || 0) > 0);
  $('btnCancel').classList.add('hidden');
  $('btnNewTask').classList.remove('hidden');
  if (S.reportPath) $('btnOpenReport').classList.remove('hidden');
  const ok = d.phase === 'done';
  $('runStatus').textContent = ok ? '✓ 拷卡完成' : d.phase === 'cancelled' ? '已取消' : '完成（有异常）';
  $('runSub').textContent = `${d.files} 个文件 · ${fmtBytes(d.bytes)} · 耗时 ${fmtDur(d.duration)} · 均速 ${fmtSpeed(d.speed)}`;
  setRing(ok ? 1 : 0.999);
  logLine(ok ? 'info' : 'err', ok ? '全部校验通过，可以安全拔卡。' : `存在 ${d.failed} 个异常文件，请查看报告。`);
  toast(ok ? '拷卡完成，校验通过' : '任务结束，存在异常', ok ? '' : 'warn');
  S.running = false;
  loadHistory();
});

function logLine(level, msg) {
  const box = $('logBox');
  const d = document.createElement('div');
  const t = new Date();
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  d.className = level === 'error' ? 'err' : level === 'warn' ? 'warn' : '';
  d.innerHTML = `<span class="t">${ts}</span>${esc(msg)}`;
  box.appendChild(d);
  if (box.children.length > 500) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 记录 ---------------- */
async function loadHistory() {
  try {
    S.history = await appApi.history();
    $('histSummary').textContent = S.history.length
      ? `共 ${S.history.length} 次拷卡 · 累计 ${fmtBytes(S.history.reduce((a, h) => a + (h.totalBytes || 0), 0))}`
      : '还没有拷卡记录';
  } catch { S.history = []; }
  renderRecent();
}

/* 侧栏：最近完成的拷卡 */
function renderRecent() {
  const box = $('recentList');
  if (!box) return;
  const items = (S.history || [])
    .filter((h) => ['done', 'failed', 'cancelled'].includes(h.phase))
    .slice(0, 5);
  const cnt = $('recentCount');
  if (cnt) cnt.textContent = items.length ? `${items.length}` : '';
  if (!items.length) {
    box.innerHTML = '<div class="recent-empty">还没有完成的拷卡<br>完成后会出现在这里</div>';
    return;
  }
  box.innerHTML = items.map((h) => {
    const name = h.project || (h.sourcePath || '').split(/[\\/]/).filter(Boolean).pop() || '未命名任务';
    const t = h.endedAt ? new Date(h.endedAt) : (h.startedAt ? new Date(h.startedAt) : null);
    const hm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '--:--';
    const ok = h.phase === 'done';
    return `<button class="recent-item" data-id="${esc(h.id)}">
      <span class="ri-top"><i class="ri-dot ${ok ? '' : 'fail'}"></i><span class="ri-name">${esc(name)}</span></span>
      <span class="ri-meta">${hm} · ${h.totalFiles || 0} 个 · ${fmtBytes(h.totalBytes || 0)}</span>
    </button>`;
  }).join('');
  box.querySelectorAll('.recent-item').forEach((b) => {
    b.addEventListener('click', () => openDetail(b.dataset.id));
  });
}
async function renderHistory() {
  await loadHistory();
  const list = $('histList');
  if (!S.history.length) {
    list.innerHTML = '<div class="hist-empty">还没有记录。完成一次拷卡后，这里会留下可导出的报告。</div>';
    return;
  }
  list.innerHTML = S.history.map((h) => {
    const phase = h.phase || 'queued';
    const badgeCls = phase === 'done' ? '' : phase === 'cancelled' ? 'cancel' : phase === 'running' ? 'run' : 'fail';
    const tagCls = phase === 'done' ? '' : phase === 'cancelled' ? 'cancel' : 'fail';
    const tagText = { done: '校验通过', cancelled: '已取消', running: '进行中', failed: '有异常', queued: '排队中' }[phase] || phase;
    const dur = h.startedAt && h.endedAt ? ` · 耗时 ${fmtDur(h.endedAt - h.startedAt)}` : '';
    return `<div class="hist" data-id="${esc(h.id)}">
      <span class="hist-badge ${badgeCls}"></span>
      <div class="hist-main">
        <div class="hist-title">${esc(h.project || h.sourcePath.split(/[\\/]/).pop())}
          <span class="tag ${tagCls}">${tagText}</span>
          <span class="hist-id">${esc(h.id)}</span></div>
        <div class="hist-meta">${esc(h.dateText || '')} · ${h.totalFiles || 0} 个文件 · ${fmtBytes(h.totalBytes || 0)}${h.failedFiles ? ` · ${h.failedFiles} 失败` : ''}${dur}</div>
        <div class="hist-meta">${esc((h.roots && h.roots[0]) || (h.destinations && h.destinations[0]) || '')}</div>
      </div>
      <div class="hist-acts">
        <button class="btn ghost sm" data-act="peek">详情</button>
        <button class="btn ghost sm" data-act="pdf">PDF</button>
        <button class="btn ghost sm" data-act="csv">CSV</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.hist').forEach((el, i) => {
    const h = S.history[i];
    // 整行点击进详情；行内按钮交给各自的处理
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      openDetail(h.id);
    });
    el.querySelector('[data-act="peek"]').addEventListener('click', () => openDetail(h.id));
    el.querySelector('[data-act="pdf"]').addEventListener('click', async () => {
      try {
        const p = await appApi.exportPdf(h.id);
        if (p) toast('报告已保存：' + p);
      } catch (e) { toast('导出失败：' + e.message, 'err'); }
    });
    el.querySelector('[data-act="csv"]').addEventListener('click', async () => {
      try {
        const p = await appApi.exportCsv(h.id);
        if (p) toast('CSV 已保存：' + p);
      } catch (e) { toast('导出失败：' + e.message, 'err'); }
    });
  });
}

/* ---------------- 记录详情 ---------------- */
let detailId = null;

const PHASE_TAG = {
  done: { text: '校验通过', cls: '' },
  cancelled: { text: '已取消', cls: 'cancel' },
  running: { text: '进行中', cls: '' },
  failed: { text: '有异常', cls: 'fail' },
  queued: { text: '排队中', cls: '' },
};

function fmtClock(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function openDetail(id) {
  if (!id) return;
  let full;
  try { full = await appApi.historyGet(id); } catch (e) { return toast('读取记录失败：' + e.message, 'err'); }
  if (!full) return toast('找不到这条记录', 'err');
  detailId = id;

  const phase = full.phase || 'done';
  const tag = PHASE_TAG[phase] || { text: phase, cls: '' };
  const name = full.project || (full.sourcePath || '').split(/[\\/]/).filter(Boolean).pop() || '未命名任务';
  $('dtTitle').textContent = name;
  $('dtId').textContent = full.dateText ? `${full.id} · ${full.dateText}` : full.id;
  $('dtTag').className = 'tag ' + tag.cls;
  $('dtTag').textContent = tag.text;

  const dur = full.startedAt && full.endedAt ? full.endedAt - full.startedAt : 0;
  const avg = dur > 0 ? (full.totalBytes || 0) / (dur / 1000) : 0;
  const dests = full.dests || [];
  const errors = full.errors || [];
  const verifyText = full.verify === 'hash' ? `${String(full.algorithm || '').toUpperCase()} 哈希校验`
    : full.verify === 'size' ? '文件尺寸比对' : '未校验';

  const destHtml = dests.length ? dests.map((d) => `
    <div class="dt-dest">
      <div class="dt-dest-top">
        <span class="dt-dest-path" title="${esc(d.path || '')}">${esc(d.path || '')}</span>
        <span class="tag ${d.filesFailed || d.verifyFailed ? 'fail' : ''}">${esc(d.status || (d.filesFailed ? '有异常' : '完成'))}</span>
      </div>
      <div class="dt-dest-stats">
        <span>完成 <b>${d.filesDone || 0}</b> 个</span>
        <span>跳过 <b>${d.filesSkipped || 0}</b> 个</span>
        <span class="${d.filesFailed ? 'bad' : ''}">写入失败 <b>${d.filesFailed || 0}</b></span>
        <span class="${d.verifyFailed ? 'bad' : ''}">校验失败 <b>${d.verifyFailed || 0}</b></span>
        <span>已拷贝 <b>${fmtBytes(d.copiedBytes || 0)}</b></span>
      </div>
    </div>`).join('') : '<div class="dt-empty">没有目标记录</div>';

  const errHtml = errors.length
    ? `<div class="dt-err">${errors.slice(0, 60).map((e) => `<div><span class="f">${esc(e.file || '（任务级）')}</span> — ${esc(e.message || '')}</div>`).join('')}</div>
       ${errors.length > 60 ? `<div class="dt-empty">仅显示前 60 条，共 ${errors.length} 条</div>` : ''}`
    : '<div class="dt-empty">没有异常</div>';

  $('dtBody').innerHTML = `
    <div class="dt-grid">
      <div class="dt-col">
        <div class="dt-row"><span class="dt-k">开始</span><span class="dt-v">${esc(fmtClock(full.startedAt))}</span></div>
        <div class="dt-row"><span class="dt-k">结束</span><span class="dt-v">${esc(fmtClock(full.endedAt))}</span></div>
        <div class="dt-row"><span class="dt-k">耗时</span><span class="dt-v">${fmtDur(dur)}${avg ? ' · 均速 ' + fmtSpeed(avg) : ''}</span></div>
        <div class="dt-row"><span class="dt-k">文件</span><span class="dt-v">${full.totalFiles || 0} 个 · ${fmtBytes(full.totalBytes || 0)}</span></div>
        <div class="dt-row"><span class="dt-k">失败</span><span class="dt-v">${full.failedFiles || 0} 个${full.skippedFiles ? ` · 跳过 ${full.skippedFiles} 个` : ''}</span></div>
        <div class="dt-row"><span class="dt-k">校验</span><span class="dt-v">${esc(verifyText)}</span></div>
      </div>
      <div class="dt-col">
        <div class="dt-row"><span class="dt-k">来源</span><span class="dt-v mono">${esc(full.sourcePath || '—')}</span></div>
        <div class="dt-row"><span class="dt-k">卡片</span><span class="dt-v">${esc(full.camera || '—')}</span></div>
        <div class="dt-row"><span class="dt-k">模板</span><span class="dt-v mono">${esc(full.template || '—')}</span></div>
        <div class="dt-row"><span class="dt-k">清单</span><span class="dt-v">${full.manifestCount || 0} 条${full.manifestCount > 500 ? '（详情页仅存前 500）' : ''}</span></div>
        <div class="dt-row"><span class="dt-k">报告</span><span class="dt-v">${full.reportPath ? '已生成' : '未生成'}</span></div>
      </div>
    </div>
    <div class="dt-sec">目标路径（${dests.length}）</div>
    ${destHtml}
    <div class="dt-sec">异常记录（${errors.length}）</div>
    ${errHtml}
  `;

  const reportPath = full.reportPath || '';
  const rp = $('dtReport');
  rp.textContent = reportPath || '尚未生成 PDF 报告';
  rp.title = reportPath || '';
  $('dtOpenFolder').classList.toggle('hidden', !reportPath);

  $('detailMask').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeDetail() {
  $('detailMask').classList.add('hidden');
  document.body.classList.remove('modal-open');
  detailId = null;
}

$('dtClose').addEventListener('click', closeDetail);
$('dtDone').addEventListener('click', closeDetail);
$('detailMask').addEventListener('click', (ev) => { if (ev.target.id === 'detailMask') closeDetail(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('detailMask').classList.contains('hidden')) closeDetail();
});
$('dtOpenFolder').addEventListener('click', async () => {
  if (!detailId) return;
  const full = await appApi.historyGet(detailId);
  if (full && full.reportPath) appApi.reveal(full.reportPath);
});
$('dtPdf').addEventListener('click', async () => {
  if (!detailId) return;
  try {
    const p = await appApi.exportPdf(detailId);
    if (!p) return;
    toast('报告已保存：' + p);
    // 记录上的报告路径立刻刷新，方便直接打开文件夹
    const full = await appApi.historyGet(detailId);
    if (full) {
      $('dtReport').textContent = p;
      $('dtReport').title = p;
      $('dtOpenFolder').classList.remove('hidden');
    }
    loadHistory();
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
});
$('dtCsv').addEventListener('click', async () => {
  if (!detailId) return;
  try {
    const p = await appApi.exportCsv(detailId);
    if (p) toast('CSV 已保存：' + p);
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
});

/* ---------------- 设置 ---------------- */
async function loadSettingsUI() {
  const s = await appApi.settings();
  S.settings = s;
  $('setReportDir').value = s.reportDir || '';
  $('setNotifySystem').checked = s.notify.system !== false;
  $('setEmailOn').checked = !!s.notify.email.enabled;
  $('setEmailHost').value = s.notify.email.host || '';
  $('setEmailPort').value = s.notify.email.port || '';
  $('setEmailUser').value = s.notify.email.user || '';
  $('setEmailPass').value = s.notify.email.pass || '';
  $('setEmailTo').value = s.notify.email.to || '';
  $('setHookOn').checked = !!s.notify.webhook.enabled;
  $('setHookUrl').value = s.notify.webhook.url || '';
  $('setFfmpeg').value = s.transcode.ffmpegPath || '';
  $('setPreset').value = s.transcode.preset || 'proxy_h264';
  $('setFeedUrl').value = (s.update && s.update.feedUrl) || '';
  $('setUpdateAuto').checked = !s.update || s.update.auto !== false;
  THEME.mode = s.themeMode || 'auto';
  THEME.accentRgb = Array.isArray(s.accentRgb) && s.accentRgb.length === 3 ? s.accentRgb : null;
  $('setTransparent').checked = !!s.transparent;
  applyTransparency(!!s.transparent, s.transparentLevel);
  applyTheme();
  renderUpdate();
  $('setDestList').innerHTML = (s.destinations || []).length
    ? s.destinations.map((d, i) => `<div class="dest" data-i="${i}">
        <span class="dest-idx">${i + 1}</span>
        <div class="dest-body"><div class="dest-path">${esc(d.base || d)}</div></div>
        <button class="dest-x" title="移除">×</button></div>`).join('')
    : '';
}
function collectSettings() {
  return {
    reportDir: $('setReportDir').value,
    notify: {
      system: $('setNotifySystem').checked,
      email: {
        enabled: $('setEmailOn').checked, host: $('setEmailHost').value.trim(),
        port: Number($('setEmailPort').value) || 465, secure: (Number($('setEmailPort').value) || 465) === 465,
        user: $('setEmailUser').value.trim(), pass: $('setEmailPass').value,
        to: $('setEmailTo').value.trim(),
      },
      webhook: { enabled: $('setHookOn').checked, url: $('setHookUrl').value.trim() },
    },
    transcode: {
      ffmpegPath: $('setFfmpeg').value.trim(),
      preset: $('setPreset').value,
    },
    update: {
      auto: $('setUpdateAuto').checked,
      feedUrl: $('setFeedUrl').value.trim(),
    },
    themeMode: THEME.mode,
    accentRgb: THEME.accentRgb,
    transparent: $('setTransparent').checked,
    transparentLevel: Number($('transparentLevel').value) || 0,
    destinations: (S.settings && S.settings.destinations) || [],
  };
}
async function saveSettings() {
  try {
    S.settings = await appApi.saveSettings(collectSettings());
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
}

/* ---------------- 关于 ---------------- */
function renderAbout() {
  $('aboutVer').textContent = 'v' + (S.version || '');
  const os = S.platform === 'darwin' ? 'macOS' : S.platform === 'win32' ? 'Windows' : S.platform;
  $('aboutEnv').textContent = `${os} ${S.arch || ''} · Electron ${S.electron || ''}`.trim();
}

/* ---------------- 软件更新 ---------------- */
let upd = { status: 'idle', current: '', version: '', notes: '', size: 0, received: 0, percent: 0, speed: 0, error: '', notesUrl: '' };

function renderUpdate() {
  const st = upd.status || 'idle';
  const bar = $('updateBar');
  const showBar = ['available', 'downloading', 'ready', 'installing'].includes(st);
  bar.classList.toggle('hidden', !showBar);

  if (showBar) {
    let text = '';
    if (st === 'available') {
      text = `新版本 <b>${esc(upd.version)}</b> 可用 · 当前 ${esc(upd.current)}${upd.size ? ' · ' + fmtBytes(upd.size) : ''}`;
    } else if (st === 'downloading') {
      text = `正在下载 <b>${esc(upd.version)}</b> · ${Math.round((upd.percent || 0) * 100)}%${upd.speed ? ' · ' + fmtSpeed(upd.speed) : ''}`;
    } else if (st === 'ready') {
      text = `新版本 <b>${esc(upd.version)}</b> 已下载并通过校验`;
    } else {
      text = `正在安装 <b>${esc(upd.version)}</b>，应用即将重启…`;
    }
    $('ubText').innerHTML = text;
  }

  const act = $('ubAction');
  act.classList.toggle('hidden', !['available', 'ready'].includes(st));
  act.textContent = st === 'ready' ? '重启并安装' : '下载更新';
  $('ubSkip').classList.toggle('hidden', st !== 'available');

  // 左下角常驻入口
  const side = $('btnSideUpdate');
  const sideText = $('sideUpdateText');
  side.classList.toggle('has-update', ['available', 'ready'].includes(st));
  side.classList.toggle('checking', st === 'checking' || st === 'downloading');
  side.disabled = ['checking', 'downloading', 'installing'].includes(st);
  sideText.textContent = {
    checking: '检查中…',
    available: `发现 v${upd.version}`,
    downloading: `下载中 ${Math.round((upd.percent || 0) * 100)}%`,
    ready: '重启安装',
    installing: '正在安装…',
    uptodate: '已是最新',
    error: '检查失败 · 重试',
  }[st] || '检查更新';
  side.title = st === 'error' ? ('更新检查失败：' + (upd.error || '未知错误')) : '检查是否有新版本';
  if (st === 'uptodate') {
    setTimeout(() => { if (upd.status === 'uptodate') { sideText.textContent = '检查更新'; } }, 4000);
  }

  // 设置页
  $('setCurVer').textContent = upd.current || S.version || '—';
  const hint = {
    idle: '尚未检查',
    checking: '正在检查更新…',
    uptodate: `已是最新版本（${upd.current || S.version}）`,
    available: `发现新版本 ${upd.version}${upd.size ? '（' + fmtBytes(upd.size) + '）' : ''}`,
    downloading: `正在下载 ${upd.version} · ${Math.round((upd.percent || 0) * 100)}%`,
    ready: `新版本 ${upd.version} 已就绪，可重启安装`,
    installing: '正在安装，应用即将退出…',
    error: '更新检查失败：' + (upd.error || '未知错误'),
  }[st] || '';
  const hintEl = $('updateHint');
  hintEl.textContent = hint;
  hintEl.style.color = st === 'error' ? 'var(--red)' : st === 'available' ? 'var(--accent)' : 'var(--tx-3)';

  const showProgress = ['downloading', 'ready'].includes(st) && (upd.percent > 0);
  $('updateProgress').classList.toggle('hidden', !showProgress);
  if (showProgress) {
    $('upbarFill').style.width = ((upd.percent || 0) * 100).toFixed(1) + '%';
    $('upPercent').textContent = `${Math.round((upd.percent || 0) * 100)}%` +
      (upd.size ? ` · ${fmtBytes(upd.received || 0)} / ${fmtBytes(upd.size)}` : '');
    $('upSpeed').textContent = upd.speed ? fmtSpeed(upd.speed) : '';
  }
  $('btnDownloadUpdate').classList.toggle('hidden', st !== 'available');
  $('btnInstallUpdate').classList.toggle('hidden', st !== 'ready');
  $('btnUpdateNotes').classList.toggle('hidden', !(upd.notes || upd.notesUrl));
}

async function checkUpdate() {
  $('updateHint').textContent = '正在检查更新…';
  $('updateHint').style.color = 'var(--tx-3)';
  const sideText = $('sideUpdateText');
  sideText.textContent = '检查中…';
  const r = await appApi.update.check();
  if (!r.ok) {
    toast(r.error || '检查失败', 'err');
    sideText.textContent = '检查失败 · 重试';
    renderUpdate();
    // 设置页可能停在这一页，让失败原因就地可见
    $('updateHint').textContent = '更新检查失败：' + (r.error || '未知错误');
    $('updateHint').style.color = 'var(--red)';
    return;
  }
  if (r.uptodate) toast(r.skipped ? '已跳过该版本' : `当前已是最新版本（${r.version || ''}）`);
  else toast(`发现新版本 ${r.version}，可点击下载`);
  renderUpdate();
}

async function downloadUpdate() {
  $('updateBar').classList.remove('hidden');
  const r = await appApi.update.download();
  if (!r.ok) { toast('下载失败：' + r.error, 'err'); renderUpdate(); return; }
  toast(r.verified ? '下载完成，SHA-256 校验通过' : '下载完成（该版本未提供校验值）');
  renderUpdate();
}

async function installUpdate() {
  if (!confirm('将退出应用并安装新版本，确定现在更新吗？')) return;
  const r = await appApi.update.install();
  if (!r.ok) { toast('安装失败：' + r.error, 'err'); renderUpdate(); }
}

/* ---------------- 事件绑定 ---------------- */
$('btnRefresh').addEventListener('click', () => loadVolumes(true));
$('btnBrowseSrc').addEventListener('click', browseSource);
$('btnEject').addEventListener('click', async () => {
  if (!S.source) return;
  if (S.running) return toast('任务进行中，无法弹出', 'warn');
  const r = await appApi.eject(S.source.path);
  toast(r.message || (r.ok ? '已弹出' : '弹出失败'), r.ok ? '' : 'warn');
});
$('btnAddDest').addEventListener('click', addDest);
$('tplInput').addEventListener('input', () => { renderDests(); });
$('projectInput').addEventListener('input', () => renderDests());
$('tplChips').querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => {
    const inp = $('tplInput');
    const pos = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
    inp.value = inp.value.slice(0, pos) + b.dataset.t + inp.value.slice(inp.selectionEnd == null ? pos : inp.selectionEnd);
    inp.focus();
    inp.selectionStart = inp.selectionEnd = pos + b.dataset.t.length;
    renderDests();
  });
});
$('btnStart').addEventListener('click', startTask);
$('btnCancel').addEventListener('click', async () => {
  await appApi.cancel();
  logLine('warn', '已请求取消…');
});
$('btnNewTask').addEventListener('click', () => { S.taskId = null; S.reportPath = ''; exitRunMode(); });
$('btnOpenReport').addEventListener('click', () => { if (S.reportPath) appApi.reveal(S.reportPath); });
$('btnToggleLog').addEventListener('click', () => {
  const box = $('logBox');
  box.classList.toggle('collapsed');
  $('btnToggleLog').textContent = box.classList.contains('collapsed') ? '展开' : '收起';
});
$('btnClearHist').addEventListener('click', async () => {
  if (!confirm('确定清空所有拷卡记录？（已导出的 PDF 文件不受影响）')) return;
  await appApi.historyClear();
  renderHistory();
  toast('记录已清空');
});
$('btnPickReportDir').addEventListener('click', async () => {
  const p = await appApi.pickDir({ title: '选择报告保存目录' });
  if (!p) return;
  $('setReportDir').value = p;
  await saveSettings();
});
$('btnAddDefaultDest').addEventListener('click', async () => {
  const p = await appApi.pickDir({ title: '选择默认目标文件夹' });
  if (!p) return;
  S.settings.destinations = [...(S.settings.destinations || []), { base: p }];
  await appApi.saveSettings({ destinations: S.settings.destinations });
  loadSettingsUI();
  toast('已添加默认目标');
});
$('setDestList').addEventListener('click', async (e) => {
  const x = e.target.closest('.dest-x');
  if (!x) return;
  const i = Number(x.closest('.dest').dataset.i);
  S.settings.destinations.splice(i, 1);
  await appApi.saveSettings({ destinations: S.settings.destinations });
  loadSettingsUI();
});
$('btnTestNotify').addEventListener('click', async () => {
  await saveSettings();
  try { await appApi.testNotify(); toast('测试通知已发送'); }
  catch (e) { toast('发送失败：' + e.message, 'err'); }
});
$('btnPickFfmpeg').addEventListener('click', async () => {
  const p = await appApi.pickFile({ title: '选择 ffmpeg 可执行文件' });
  if (!p) return;
  $('setFfmpeg').value = p;
  await saveSettings();
});
$('btnCheckFfmpeg').addEventListener('click', async () => {
  await saveSettings();
  const r = await appApi.checkFfmpeg();
  $('ffmpegHint').textContent = r.found ? '✓ 已找到 ffmpeg：' + r.path : '✗ 未找到 ffmpeg，转码功能不可用（可从 ffmpeg.org 下载后指定路径）';
  $('ffmpegHint').style.color = r.found ? 'var(--green)' : 'var(--warn)';
});
['setNotifySystem', 'setEmailOn', 'setHookOn'].forEach((id) => $(id).addEventListener('change', saveSettings));
['setEmailHost', 'setEmailPort', 'setEmailUser', 'setEmailPass', 'setEmailTo', 'setHookUrl', 'setPreset', 'setFfmpeg', 'setFeedUrl']
  .forEach((id) => $(id).addEventListener('change', saveSettings));
$('setUpdateAuto').addEventListener('change', saveSettings);
$('setTransparent').addEventListener('change', async (e) => {
  const on = e.target.checked;
  applyTransparency(on);
  await appApi.setTransparent(on);
  toast(on ? `背景透明已开启 · ${$('transparentLevel').value}%` : '已恢复不透明背景');
});

// 透明度滑块：拖动即时生效，停手后再落盘
let opacityTimer = null;
$('transparentLevel').addEventListener('input', () => {
  const lv = Number($('transparentLevel').value);
  applyTransparency($('setTransparent').checked, lv);
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(() => { appApi.setOpacityLevel(lv).catch(() => {}); }, 240);
});

$('btnCheckUpdate').addEventListener('click', async () => { await saveSettings(); checkUpdate(); });
$('btnDownloadUpdate').addEventListener('click', downloadUpdate);
$('btnInstallUpdate').addEventListener('click', installUpdate);
$('ubAction').addEventListener('click', () => {
  if (upd.status === 'ready') installUpdate(); else downloadUpdate();
});
$('ubSkip').addEventListener('click', async () => {
  await appApi.update.skip(upd.version);
  $('updateBar').classList.add('hidden');
  toast(`已跳过 ${upd.version}`);
});
$('btnUpdateNotes').addEventListener('click', async () => {
  const opened = await appApi.update.openNotes();
  if (!opened && upd.notes) alert(upd.notes);
});

// 外观
document.querySelectorAll('#themeSeg button').forEach((b) => {
  b.addEventListener('click', () => setThemeMode(b.dataset.mode));
});
$('accentColor').addEventListener('input', (e) => {
  const h = e.target.value;
  setAccentRgb([parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
});
['accentR', 'accentG', 'accentB'].forEach((id) => {
  $(id).addEventListener('input', () => setAccentRgb(readRgbInputs()));
});
$('btnMonoAccent').addEventListener('click', () => { setAccentRgb(null); toast('已恢复默认黑白配色'); });

// 左下角检查更新
$('btnSideUpdate').addEventListener('click', async () => {
  if (upd.status === 'ready') return installUpdate();
  if (upd.status === 'available') return downloadUpdate();
  if (upd.status === 'downloading' || upd.status === 'installing' || upd.status === 'checking') return;
  await checkUpdate();
});

appApi.update.onEvent((payload) => {
  if (payload && payload.state) {
    upd = payload.state;
    renderUpdate();
  }
});

appApi.onQueue((q) => {
  const busy = !!q.running;
  $('queuePill').classList.toggle('busy', busy);
  $('queueText').textContent = busy ? `正在拷卡${q.pending.length ? ' · 队列 ' + q.pending.length : ''}` : (q.pending.length ? `队列 ${q.pending.length}` : '空闲');
});
appApi.onHistoryChanged(() => {
  if ($('view-history').classList.contains('is-active')) renderHistory();
  else loadHistory();
});

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    const info = await appApi.info();
    S.platform = info.platform;
    S.version = info.version;
    S.arch = info.arch;
    S.electron = info.electron;
    document.body.classList.add(info.platform === 'darwin' ? 'mac' : 'win');
    $('verText').textContent = 'v' + info.version;

    const s = await appApi.settings();
    S.settings = s;
    // 先应用主题，再渲染内容，避免首屏闪烁
    THEME.mode = s.themeMode || 'auto';
    THEME.accentRgb = Array.isArray(s.accentRgb) && s.accentRgb.length === 3 ? s.accentRgb : null;
  $('setTransparent').checked = !!s.transparent;
  applyTransparency(!!s.transparent, s.transparentLevel);
    applyTheme();
    S.dests = (s.destinations || []).map((d) => ({ base: d.base || d })).filter((d) => d.base);
    $('tplInput').value = s.template || '{date}_{card}';
    $('algoSelect').value = s.algorithm || 'sha256';
    $('verifySelect').value = s.verify || 'hash';
    $('concSelect').value = String(s.concurrency || 4);
    $('optSkipJunk').checked = s.skipJunk !== false;
    $('optSkipExist').checked = !!s.skipExisting;
    $('optKeepTime').checked = s.preserveTime !== false;
    $('optAutoEject').checked = !!s.autoEject;
    $('optAutoReport').checked = s.autoReport !== false;

    renderDests();
    await loadVolumes();
    await loadHistory();

    // 更新状态
    try {
      upd = await appApi.update.state();
      renderUpdate();
    } catch {}

    // 有素材卡时自动选中第一张
    const card = S.volumes.find((v) => v.isCard);
    if (card) selectSource(card);
    else updateStartState();

    const q = await appApi.queue();
    if (q.running) { S.running = true; S.taskId = q.running.id; enterRunMode(); }

    // 首屏稳定后确认滚动位置在顶部（异步渲染可能在初始化期间改变内容高度）
    const pinTop = () => { $('scrollArea').scrollTop = 0; };
    requestAnimationFrame(pinTop);
    setTimeout(pinTop, 400);
    setTimeout(pinTop, 1200);
  } catch (e) {
    console.error(e);
    toast('初始化失败：' + e.message, 'err');
  }
})();
