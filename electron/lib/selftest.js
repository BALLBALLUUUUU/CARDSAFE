'use strict';
/**
 * 端到端自检（真实走 主进程 enqueue → 队列 → 引擎 → 历史 → PDF 报告 全链路）
 * 用法：CARDSAFE_E2E=1 npm start
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildFakeCard(root) {
  const layout = [
    ['DCIM/100CANON/IMG_0001.JPG', 800 * 1024],
    ['DCIM/100CANON/IMG_0002.JPG', 1200 * 1024],
    ['DCIM/101CANON/IMG_0100.JPG', 640 * 1024],
    ['PRIVATE/M4ROOT/CLIP/C0001.MP4', 5 * 1024 * 1024],
    ['PRIVATE/M4ROOT/CLIP/C0002.MP4', 3 * 1024 * 1024],
  ];
  for (const [rel, size] of layout) {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, crypto.randomBytes(size));
  }
  await fsp.writeFile(path.join(root, '.DS_Store'), 'junk');
  await fsp.writeFile(path.join(root, 'DCIM', 'Thumbs.db'), 'junk');
  return layout;
}

async function walkFiles(root, out = []) {
  for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) await walkFiles(p, out);
    else out.push(path.relative(root, p));
  }
  return out;
}

async function md5(p) {
  const h = crypto.createHash('md5');
  h.update(await fsp.readFile(p));
  return h.digest('hex');
}

async function runE2E({ enqueue, getHistory, store }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsafe-e2e-'));
  const card = path.join(base, 'SDCARD');
  const destA = path.join(base, 'SSD_A');
  const destB = path.join(base, 'SSD_B');
  const reportDir = path.join(base, 'reports');

  const layout = await buildFakeCard(card);

  const prevReportDir = store.getSettings().reportDir;
  const prevNotify = store.getSettings().notify || {};
  await store.updateSettings({ reportDir, notify: { system: false } });

  try {
  const id = await enqueue({
    sourcePath: card,
    cardLabel: 'SDCARD',
    camera: '',
    project: 'E2E测试',
    template: '{date}_{card}',
    algorithm: 'md5',
    verify: 'hash',
    concurrency: 2,
    destinations: [{ base: destA }, { base: destB }],
  });

  let entry = null;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    entry = getHistory(id);
    if (entry && ['done', 'failed', 'cancelled'].includes(entry.phase)) break;
  }
  // 报告在状态落库之后才生成，等它写完
  await sleep(2500);
  entry = getHistory(id);

  const checks = [];
  const add = (name, pass, extra = '') => checks.push({ name, pass, extra });

  add('任务状态为完成', entry && entry.phase === 'done', entry && entry.phase);
  add('文件计数正确', entry && entry.totalFiles === layout.length, `${entry && entry.totalFiles}/${layout.length}`);
  add('无失败文件', entry && entry.failedFiles === 0, String(entry && entry.failedFiles));

  // 双目标内容校验
  let hashOk = true;
  let junkOk = true;
  const dbg = { entryPhase: entry && entry.phase, errors: (entry && entry.errors || []).slice(0, 5) };
  for (const d of [destA, destB]) {
    let base2;
    try {
      base2 = path.join(d, fs.readdirSync(d)[0]);
    } catch (e) {
      hashOk = false;
      dbg.missingDest = d;
      continue;
    }
    const files = await walkFiles(base2).catch(() => []);
    if (files.length !== layout.length) hashOk = false;
    for (const [rel] of layout) {
      const src = path.join(card, rel);
      const dst = path.join(base2, rel);
      if (!fs.existsSync(dst)) { hashOk = false; continue; }
      if (await md5(src) !== await md5(dst)) hashOk = false;
    }
    if (fs.existsSync(path.join(base2, '.DS_Store')) || fs.existsSync(path.join(base2, 'DCIM/Thumbs.db'))) junkOk = false;
  }
  add('双目标哈希一致', hashOk, JSON.stringify(dbg));
  add('垃圾文件已过滤', junkOk);

  // 报告
  const reportPath = entry && entry.reportPath;
  const reportOk = !!reportPath && fs.existsSync(reportPath) && fs.statSync(reportPath).size > 3000;
  add('PDF 报告已生成', reportOk, reportPath ? `${Math.round(fs.statSync(reportPath).size / 1024)}KB` : '无');

  // 整卡指纹
  const { masterFingerprint } = require('./report');
  const fp = masterFingerprint({ manifest: (entry && entry.manifest) || [] });
  add('整卡指纹已计算', fp.length === 64, fp.slice(0, 12) + '…');

  // ---- 关闭"自动生成报告"时不应产出 PDF ----
  const destC = path.join(base, 'SSD_C');
  const id2 = await enqueue({
    sourcePath: card,
    cardLabel: 'SDCARD',
    project: 'E2E-无报告',
    template: '{date}_{card}',
    algorithm: 'md5',
    verify: 'hash',
    concurrency: 2,
    autoReport: false,
    destinations: [{ base: destC }],
  });
  let e2 = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    e2 = getHistory(id2);
    if (e2 && ['done', 'failed', 'cancelled'].includes(e2.phase)) break;
  }
  await sleep(1500);
  e2 = getHistory(id2);
  add('关闭自动报告时不生成 PDF', e2 && e2.phase === 'done' && !e2.reportPath, e2 && e2.reportPath ? '仍生成了 ' + e2.reportPath : '无报告');

  await store.updateSettings({ reportDir: prevReportDir });
  if (!process.env.CARDSAFE_E2E_KEEP) {
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
    taskId: id,
    durationMs: entry && entry.startedAt ? entry.endedAt - entry.startedAt : 0,
    bytes: entry && entry.totalBytes,
  };
  } finally {
    // 无论成功与否都要还原用户真实设置，并立即落盘
    await store.updateSettings({
      reportDir: prevReportDir,
      notify: { system: prevNotify.system !== false },
    });
    if (typeof store.flush === 'function') await store.flush();
  }
}

module.exports = { runE2E };
