'use strict';
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { formatBytes, formatDuration, formatSpeed, stamp } = require('./util');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 整卡指纹：所有文件哈希按路径排序后拼接再哈希，用于归档核对 */
function masterFingerprint(task) {
  const list = (task.manifest || []).filter((m) => m.hash).sort((a, b) => a.rel.localeCompare(b.rel));
  if (!list.length) return '';
  const h = crypto.createHash('sha256');
  for (const m of list) h.update(m.rel + ':' + m.hash + '\n');
  return h.digest('hex');
}

const PHASE_TEXT = { done: '完成', failed: '失败', cancelled: '已取消', running: '进行中' };

function buildReportHtml(task, opts = {}) {
  const maxRows = opts.maxRows || 400;
  const t = {
    ...task,
    dests: task.dests || [],
    errors: task.errors || [],
    manifest: task.manifest || [],
  };
  const duration = (t.endedAt && t.startedAt) ? (t.endedAt - t.startedAt) : 0;
  const avg = duration > 0 ? (t.totalBytes / (duration / 1000)) : 0;
  const statusColor = t.phase === 'done' ? '#128a5b' : t.phase === 'cancelled' ? '#8a6d12' : '#b3261e';
  const statusText = PHASE_TEXT[t.phase] || t.phase;
  const fingerprint = masterFingerprint(t);

  const rows = t.manifest.slice(0, maxRows).map((m, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td class="mono ell">${esc(m.rel)}</td>
      <td class="num">${m.size.toLocaleString()}</td>
      <td class="mono ell hash">${esc(m.hash || (m.skipped ? '（已跳过）' : '—'))}</td>
      <td class="ok">${m.verified ? '✓' : '✗'}</td>
    </tr>`).join('');

  const destRows = t.dests.map((d) => `
    <tr>
      <td class="mono ell">${esc(d.path)}</td>
      <td class="num">${d.filesDone}</td>
      <td class="num">${d.filesSkipped || 0}</td>
      <td class="num ${d.filesFailed ? 'fail' : ''}">${d.filesFailed}</td>
      <td class="num ${d.verifyFailed ? 'fail' : ''}">${d.verifyFailed || 0}</td>
      <td>${esc(d.status || '')}</td>
    </tr>`).join('');

  const errRows = t.errors.slice(0, 100).map((e) => `
    <tr><td class="mono ell">${esc(e.file || '-')}</td><td class="mono ell">${esc(e.dest || '-')}</td><td>${esc(e.message)}</td></tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CardSafe 拷卡报告 ${esc(t.id)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
         color: #1a1c20; margin: 0; font-size: 10.5pt; line-height: 1.45; }
  .head { display: flex; justify-content: space-between; align-items: flex-end;
          border-bottom: 2.5px solid #1a1c20; padding-bottom: 8px; margin-bottom: 14px; }
  .brand { font-size: 20pt; font-weight: 800; letter-spacing: -0.5px; }
  .brand span { color: #0a7d6b; }
  .sub { font-size: 9pt; color: #6b7280; margin-top: 2px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 3px; color: #fff;
           background: ${statusColor}; font-weight: 700; font-size: 10pt; }
  h2 { font-size: 11pt; margin: 16px 0 6px; border-left: 3px solid #0a7d6b; padding-left: 7px; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { text-align: left; background: #f2f4f6; font-weight: 600; color: #374151;
       padding: 5px 6px; border-bottom: 1px solid #d6dae0; }
  td { padding: 4px 6px; border-bottom: 1px solid #eceef1; vertical-align: top; }
  tr:nth-child(even) td { background: #fafbfc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mono { font-family: "SF Mono", Consolas, "Courier New", monospace; font-size: 8.5pt; }
  .ell { max-width: 78mm; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hash { color: #4b5563; }
  .ok { color: #128a5b; text-align: center; font-weight: 700; }
  .fail { color: #b3261e; font-weight: 700; }
  .kv { width: 100%; table-layout: fixed; }
  .kv td { border: none; padding: 2px 6px; background: none !important; }
  .kv td.k { color: #6b7280; width: 22mm; white-space: nowrap; }
  .kv td.v { overflow-wrap: anywhere; }
  .kv-wrap { display: flex; gap: 18px; }
  .kv-wrap > div { flex: 1 1 0; min-width: 0; }
  .finger { margin-top: 10px; padding: 8px 10px; background: #f6f8f9; border: 1px solid #e3e7ea;
            border-radius: 4px; font-family: "SF Mono", Consolas, monospace; font-size: 8pt;
            word-break: break-all; color: #374151; }
  .foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #d6dae0;
          font-size: 8pt; color: #9ca3af; display: flex; justify-content: space-between; }
  .note { font-size: 8.5pt; color: #6b7280; margin-top: 6px; }
</style></head>
<body>
  <div class="head">
    <div>
      <div class="brand">CARD<span>SAFE</span> 拷卡报告</div>
      <div class="sub">任务 ${esc(t.id)} · ${esc(t.dateText || '')}</div>
    </div>
    <div><span class="badge">${esc(statusText)}</span></div>
  </div>

  <div class="kv-wrap">
    <div><table class="kv">
      <tr><td class="k">素材来源</td><td class="mono v">${esc(t.sourcePath)}</td></tr>
      <tr><td class="k">卡片类型</td><td class="v">${esc(t.camera || '—')}</td></tr>
      <tr><td class="k">项目名称</td><td class="v">${esc(t.project || '—')}</td></tr>
      <tr><td class="k">命名模板</td><td class="mono v">${esc(t.template || '—')}</td></tr>
    </table></div>
    <div><table class="kv">
      <tr><td class="k">文件数量</td><td class="v">${t.totalFiles} 个（失败 ${t.failedFiles || 0}）</td></tr>
      <tr><td class="k">素材容量</td><td class="v">${formatBytes(t.totalBytes)}</td></tr>
      <tr><td class="k">耗时 / 均速</td><td class="v">${formatDuration(duration)} / ${formatSpeed(avg)}</td></tr>
      <tr><td class="k">校验方式</td><td class="v">${t.verify === 'hash' ? esc((t.algorithm || '').toUpperCase()) + ' 哈希校验' : t.verify === 'size' ? '文件尺寸比对' : '未校验'}</td></tr>
    </table></div>
  </div>

  <h2>目标路径</h2>
  <table>
    <thead><tr><th>路径</th><th class="num">完成</th><th class="num">跳过</th><th class="num">失败</th><th class="num">校验失败</th><th>状态</th></tr></thead>
    <tbody>${destRows || '<tr><td colspan="6">—</td></tr>'}</tbody>
  </table>

  ${t.errors.length ? `<h2>异常记录（${t.errors.length}）</h2>
  <table><thead><tr><th>文件</th><th>目标</th><th>说明</th></tr></thead><tbody>${errRows}</tbody></table>` : ''}

  <h2>文件清单${t.manifest.length > maxRows ? `（显示前 ${maxRows} / 共 ${t.manifest.length} 条）` : ''}</h2>
  <table>
    <thead><tr><th class="num">#</th><th>相对路径</th><th class="num">字节</th><th>${esc((t.algorithm || 'hash').toUpperCase())}</th><th>校验</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody>
  </table>
  <div class="note">完整清单请导出 CSV。</div>

  ${fingerprint ? `<h2>整卡指纹</h2><div class="finger">SHA-256(&#8203;排序后的全部文件哈希) = ${esc(fingerprint)}</div>
  <div class="note">归档核对时，对比该指纹即可快速确认两份备份完全一致。</div>` : ''}

  <div class="foot">
    <div>CARDSAFE 素材拷卡 · 报告生成于 ${esc(stamp().dateDash + ' ' + stamp().timeColon)}</div>
    <div>${esc(t.operator || '')}</div>
  </div>
</body></html>`;
}

async function exportPdf(html, outPath, BrowserWindow) {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: { offscreen: true, javascript: false, sandbox: true },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.55, bottom: 0.55, left: 0.47, right: 0.47 },
    });
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, pdf);
    return outPath;
  } finally {
    try { win.destroy(); } catch {}
  }
}

function buildCsv(task) {
  const lines = [];
  const q = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  lines.push(['任务ID', '开始时间', '来源', '目标', '相对路径', '字节', '算法', '哈希', '校验通过'].map(q).join(','));
  for (const m of (task.manifest || [])) {
    const dests = (task.dests || []).map((d) => d.path).join(' | ');
    lines.push([
      task.id, task.dateText || '', task.sourcePath, dests, m.rel, m.size,
      (task.algorithm || '').toUpperCase(), m.hash || '', m.verified ? 'YES' : 'NO',
    ].map(q).join(','));
  }
  // Excel 需要 BOM 才能正确识别 UTF-8 中文
  return '\ufeff' + lines.join('\r\n');
}

module.exports = { buildReportHtml, exportPdf, buildCsv, masterFingerprint };
