'use strict';
/**
 * 更新器自测：node test/updater.test.js
 * 覆盖：版本比较、清单解析（自建 / GitHub）、检查、下载、SHA-256 校验、错误分支
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

const { Updater, compareVersions, normalizeManifest } = require('../electron/lib/updater');

const assertEq = (a, b, msg) => assert.strictEqual(a, b, `${msg}（期望 ${b}，实际 ${a}）`);
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

/* ---------- 假 store ---------- */
function makeStore(feedUrl) {
  const s = { update: { auto: true, feedUrl, skippedVersion: '' } };
  return { getSettings: () => s, updateSettings: async () => s, s };
}
const fakeApp = (v, packaged = false) => ({ getVersion: () => v, isPackaged: packaged, quit: () => {} });

/* ---------- 静态文件服务器 ---------- */
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const f = path.join(dir, rel);
      if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const st = fs.statSync(f);
      res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  /* ===== 1. 版本比较 ===== */
  assertEq(compareVersions('1.2.0', '1.1.9'), 1, '1.2.0 > 1.1.9');
  assertEq(compareVersions('1.0.0', '1.0.0'), 0, '相等');
  assertEq(compareVersions('1.0.0', '1.0.1'), -1, '1.0.0 < 1.0.1');
  assertEq(compareVersions('v1.10.0', '1.9.9'), 1, '两位数字段正确');
  assertEq(compareVersions('1.0.0', '1.0.0-beta.1'), 1, '正式版 > 预发布');
  assertEq(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1, '预发布序号');
  ok('版本比较（含 v 前缀 / 预发布 / 两位数段）');

  /* ===== 2. 清单解析 ===== */
  const custom = normalizeManifest({
    version: '1.1.0',
    notes: '测试',
    platforms: { [`${process.platform}-${process.arch}`]: { url: 'https://x/y.zip', sha256: 'AB', size: 10 } },
  });
  assertEq(custom.version, '1.1.0', '自建清单版本');
  assertEq(custom.artifact.sha256, 'ab', 'sha256 归一化为小写');
  ok('自建清单解析');

  const gh = normalizeManifest({
    tag_name: 'v1.2.0',
    body: 'release notes',
    html_url: 'https://github.com/x/y/releases/tag/v1.2.0',
    assets: [
      { name: 'CardSafe-1.2.0-arm64.dmg', browser_download_url: 'https://x/a.dmg', size: 5 },
      { name: process.platform === 'win32' ? 'CardSafe Setup 1.2.0.exe' : 'CardSafe-1.2.0-arm64-mac.zip', browser_download_url: 'https://x/b.zip', size: 99, digest: 'sha256:DEADBEEF' },
    ],
  });
  assertEq(gh.version, '1.2.0', 'GitHub tag 去 v');
  assertEq(gh.artifact.sha256, 'deadbeef', 'GitHub digest 去前缀');
  ok('GitHub Release 清单解析（自动挑当前平台资源）');

  /* ===== 3. 检查 → 下载 → 校验 ===== */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsafe-upd-'));
  const payload = crypto.randomBytes(512 * 1024);
  const bin = path.join(dir, 'CardSafe-9.9.9-arm64-mac.zip');
  await fsp.writeFile(bin, payload);
  const goodSha = crypto.createHash('sha256').update(payload).digest('hex');

  const manifest = {
    version: '9.9.9',
    notes: '自测版本',
    platforms: { [`${process.platform}-${process.arch}`]: { url: '', sha256: goodSha, size: payload.length } },
  };
  const { srv, port } = await serve(dir);
  const base = `http://127.0.0.1:${port}`;
  manifest.platforms[`${process.platform}-${process.arch}`].url = `${base}/CardSafe-9.9.9-arm64-mac.zip`;
  await fsp.writeFile(path.join(dir, 'latest.json'), JSON.stringify(manifest));

  const events = [];
  const up = new Updater({
    app: fakeApp('1.0.0', false),
    store: makeStore(`${base}/latest.json`),
    emit: (e) => events.push(e),
  });

  const r = await up.check();
  assertEq(r.ok, true, '检查成功');
  assertEq(r.uptodate, false, '有新版本');
  assertEq(r.version, '9.9.9', '新版本号');
  assertEq(up.snapshot().status, 'available', '状态 available');
  ok('检查更新：识别到更高版本');

  const dl = await up.download();
  assertEq(dl.ok, true, '下载成功');
  assertEq(dl.verified, true, 'SHA-256 校验通过');
  assertEq((await fsp.stat(dl.path)).size, payload.length, '落盘大小一致');
  assertEq(up.snapshot().status, 'ready', '状态 ready');
  assert.ok(events.some((e) => e.state && e.state.percent > 0), '有进度事件');
  ok('下载 + 进度事件 + SHA-256 校验');

  /* ===== 4. 校验失败要报错并删文件 ===== */
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsafe-upd-bad-'));
  await fsp.writeFile(path.join(badDir, 'x.zip'), payload);
  const badManifest = {
    version: '9.9.9',
    platforms: { [`${process.platform}-${process.arch}`]: { url: '', sha256: '0'.repeat(64), size: payload.length } },
  };
  const badSrv = await serve(badDir);
  badManifest.platforms[`${process.platform}-${process.arch}`].url = `http://127.0.0.1:${badSrv.port}/x.zip`;
  await fsp.writeFile(path.join(badDir, 'latest.json'), JSON.stringify(badManifest));
  const up2 = new Updater({ app: fakeApp('1.0.0'), store: makeStore(`http://127.0.0.1:${badSrv.port}/latest.json`), emit: () => {} });
  await up2.check();
  let threw = '';
  try { await up2.download(); } catch (e) { threw = e.message; }
  assert.ok(/校验失败/.test(threw), '校验失败应抛错，实际：' + threw);
  assertEq(up2.snapshot().status, 'error', '状态 error');
  ok('哈希不匹配时拒绝安装并报错');
  badSrv.srv.close();

  /* ===== 5. 已是最新 ===== */
  const up3 = new Updater({ app: fakeApp('9.9.9'), store: makeStore(`${base}/latest.json`), emit: () => {} });
  const r3 = await up3.check();
  assertEq(r3.uptodate, true, '同版本视为最新');
  assertEq(up3.snapshot().status, 'uptodate', '状态 uptodate');
  ok('同版本 / 更低版本判定为已最新');

  /* ===== 6. 跳过版本 ===== */
  const st4 = makeStore(`${base}/latest.json`);
  st4.s.update.skippedVersion = '9.9.9';
  const up4 = new Updater({ app: fakeApp('1.0.0'), store: st4, emit: () => {} });
  const r4 = await up4.check({ silent: true });
  assertEq(r4.skipped, true, '静默检查应跳过指定版本');
  assertEq(up4.snapshot().status, 'uptodate', '跳过时不提示');
  const r4b = await up4.check({ silent: false });
  assertEq(r4b.uptodate, false, '手动检查应忽略"跳过"，重新提示');
  ok('跳过指定版本（静默生效 / 手动检查可找回）');

  /* ===== 7. 未配置更新源 / 开发模式安装 ===== */
  const up5 = new Updater({ app: fakeApp('1.0.0'), store: makeStore(''), emit: () => {} });
  let e5 = '';
  try { await up5.check(); } catch (e) { e5 = e.message; }
  assert.ok(/尚未配置更新源/.test(e5), '未配置更新源要提示');
  const up6 = new Updater({ app: fakeApp('1.0.0', false), store: makeStore(`${base}/latest.json`), emit: () => {} });
  await up6.check(); await up6.download();
  let e6 = '';
  try { await up6.install(); } catch (e) { e6 = e.message; }
  assert.ok(/开发模式/.test(e6), '开发模式应拒绝安装，实际：' + e6);
  ok('未配置更新源 / 开发模式安装被拒绝');

  srv.close();
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(badDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(os.tmpdir(), 'cardsafe-update'), { recursive: true, force: true }).catch(() => {});

  /* ===== 8. macOS 原地替换脚本（真实执行） ===== */
  if (process.platform === 'darwin') {
    const { macInstallScript } = require('../electron/lib/updater');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const run = promisify(execFile);

    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cardsafe-swap-'));
    const oldApp = path.join(box, 'Demo.app');
    await fsp.mkdir(path.join(oldApp, 'Contents'), { recursive: true });
    await fsp.writeFile(path.join(oldApp, 'Contents', 'marker.txt'), 'old');

    const stage = path.join(box, 'stage', 'Demo.app');
    await fsp.mkdir(path.join(stage, 'Contents'), { recursive: true });
    await fsp.writeFile(path.join(stage, 'Contents', 'marker.txt'), 'new');
    const zip = path.join(box, 'new.zip');
    await run('ditto', ['-c', '-k', '--keepParent', 'stage/Demo.app', zip], { cwd: box });

    const script = path.join(box, 'install.sh');
    await fsp.writeFile(script, macInstallScript(), { mode: 0o755 });
    // PID 999999 必然不存在，脚本会立即进入替换流程
    await run('/bin/bash', [script, '999999', zip, oldApp]).catch(() => {});

    let marker = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try { marker = (await fsp.readFile(path.join(oldApp, 'Contents', 'marker.txt'), 'utf8')).trim(); } catch {}
      if (marker === 'new') break;
    }
    assertEq(marker, 'new', '替换脚本应把 .app 换成新版本');
    ok('macOS 原地替换脚本（真实执行）');
    await fsp.rm(box, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n全部通过：${passed} 项检查`);
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
