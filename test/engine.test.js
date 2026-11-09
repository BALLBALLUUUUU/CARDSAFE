'use strict';
/**
 * 引擎自测：不依赖 Electron，直接 node test/engine.test.js
 * 验证：多目标拷贝、哈希一致、垃圾文件过滤、时间戳保留、断点续拷、取消
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const { runCopyJob, scanSource } = require('../electron/lib/copyEngine');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsafe-test-'));
const CARD = path.join(ROOT, 'CARD');
const D1 = path.join(ROOT, 'destA');
const D2 = path.join(ROOT, 'destB');

function rnd(n) { return crypto.randomBytes(n); }

async function buildCard() {
  await fsp.mkdir(path.join(CARD, 'DCIM', '100CANON'), { recursive: true });
  await fsp.mkdir(path.join(CARD, 'DCIM', '101CANON'), { recursive: true });
  await fsp.mkdir(path.join(CARD, 'PRIVATE', 'M4ROOT', 'CLIP'), { recursive: true });

  const files = [
    ['DCIM/100CANON/IMG_0001.JPG', 512 * 1024],
    ['DCIM/100CANON/IMG_0002.JPG', 1024 * 1024],
    ['DCIM/101CANON/IMG_0010.JPG', 300 * 1024],
    ['PRIVATE/M4ROOT/CLIP/C0001.MP4', 4 * 1024 * 1024],
    ['PRIVATE/M4ROOT/CLIP/C0002.MP4', 2 * 1024 * 1024],
  ];
  for (const [rel, size] of files) {
    const p = path.join(CARD, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, rnd(size));
    const t = new Date(Date.now() - 3600 * 1000 * 24 * 7);
    await fsp.utimes(p, t, t);
  }
  // 应被过滤的垃圾
  await fsp.writeFile(path.join(CARD, '.DS_Store'), 'junk');
  await fsp.writeFile(path.join(CARD, 'DCIM', '100CANON', '._IMG_0001.JPG'), 'junk');
  await fsp.writeFile(path.join(CARD, 'DCIM', 'Thumbs.db'), 'junk');
  return files;
}

async function hashOf(p, algo) {
  const h = crypto.createHash(algo);
  h.update(await fsp.readFile(p));
  return h.digest('hex');
}

function job(id, dests, opts = {}, algo = 'md5') {
  return {
    taskId: id,
    source: CARD,
    destinations: dests.map((base) => ({ base, root: path.join(base, 'proj') })),
    algorithm: algo,
    options: { skipJunk: true, verify: 'hash', concurrency: 4, preserveTime: true, ...opts },
  };
}

const log = (...a) => console.log('  ', ...a);
let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }

(async () => {
  console.log('临时目录:', ROOT);
  const files = await buildCard();

  // ---- 1. 扫描与过滤 ----
  const scan = await scanSource(CARD, { skipJunk: true });
  assert.strictEqual(scan.files.length, files.length, '垃圾文件未被过滤');
  ok(`扫描过滤：${scan.files.length} 个有效文件（已排除 .DS_Store / ._* / Thumbs.db）`);

  // ---- 2. 多目标拷贝 + 校验 ----
  const r1 = await runCopyJob(job('T1', [D1, D2]), {});
  assert.strictEqual(r1.state.phase, 'done', '任务未成功: ' + JSON.stringify(r1.state.errors.slice(0, 3)));
  assert.strictEqual(r1.state.failedFiles, 0);
  assert.strictEqual(r1.state.doneFiles, files.length);
  assert.strictEqual(r1.manifest.length, files.length);
  for (const d of [D1, D2]) {
    for (const [rel] of files) {
      const dst = path.join(d, 'proj', rel);
      assert.ok(fs.existsSync(dst), '缺少文件 ' + dst);
      assert.ok(!fs.existsSync(path.join(d, 'proj', '.DS_Store')), '垃圾文件被拷贝了');
    }
  }
  ok('多目标拷贝：两份副本内容齐全，垃圾文件未复制');

  for (const [rel] of files) {
    const a = await hashOf(path.join(CARD, rel), 'md5');
    const b = await hashOf(path.join(D1, 'proj', rel), 'md5');
    const c = await hashOf(path.join(D2, 'proj', rel), 'md5');
    assert.strictEqual(a, b); assert.strictEqual(a, c);
  }
  ok('哈希校验：源 / 目标A / 目标B 三方一致');

  const st1 = await fsp.stat(path.join(D1, 'proj', files[0][0]));
  const st0 = await fsp.stat(path.join(CARD, files[0][0]));
  assert.ok(Math.abs(st1.mtimeMs - st0.mtimeMs) < 2000, '时间戳未保留');
  ok('时间戳保留：目标文件 mtime 与源一致');

  // ---- 3. 断点续拷（跳过已存在） ----
  const r2 = await runCopyJob(job('T2', [D1], { skipExisting: true }), {});
  assert.strictEqual(r2.state.phase, 'done');
  ok(`断点续拷：${r2.state.skippedFiles} 个文件被跳过`);

  // ---- 4. 取消（外部标志中断） ----
  const flag = { cancelled: false };
  const r3 = await runCopyJob(job('T3', [path.join(ROOT, 'destC')]), {
    flag,
    onProgress: (s) => { if (s.phase === 'scanning' && s.totalFiles > 0) flag.cancelled = true; },
  });
  assert.strictEqual(r3.state.phase, 'cancelled', '取消未生效，实际: ' + r3.state.phase);
  ok('取消：外部标志可中断任务');

  // ---- 5. 目标不可写 ----
  const r4 = await runCopyJob({
    taskId: 'T4', source: CARD,
    destinations: [{ base: '/nonexistent-root-path', root: '/nonexistent-root-path/x' }],
    algorithm: 'md5', options: { verify: 'hash' },
  }, {});
  assert.strictEqual(r4.state.phase, 'failed');
  ok('目标不可写时正确报错并终止');

  console.log(`\n全部通过：${passed} 项检查`);
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
