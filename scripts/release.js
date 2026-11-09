'use strict';
/**
 * 生成更新清单 latest.json
 *
 * 用法：
 *   node scripts/release.js --base https://dl.example.com/cardsafe/ [--notes "更新说明"]
 *   node scripts/release.js --base http://127.0.0.1:8787/        # 本地联调
 *
 * 会扫描 dist/ 下的安装包，计算 SHA-256 与体积，按平台写入清单。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('base', 'https://example.com/cardsafe/').replace(/\/?$/, '/');
const notes = arg('notes', `CardSafe ${pkg.version}`);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

function listDist() {
  if (!fs.existsSync(DIST)) return [];
  return fs.readdirSync(DIST).filter((f) => /\.(dmg|zip|exe)$/i.test(f));
}

function pick(files, re) { return files.find((f) => re.test(f)); }

(async () => {
  const files = listDist();
  const platforms = {};

  const macZip = pick(files, /\.zip$/i) && files.filter((f) => /\.zip$/i.test(f) && !/win/i.test(f));
  for (const f of (macZip || [])) {
    const arch = /arm64/i.test(f) ? 'arm64' : /x64|x86_64/i.test(f) ? 'x64' : 'universal';
    const full = path.join(DIST, f);
    platforms[`darwin-${arch}`] = {
      url: base + encodeURIComponent(f),
      sha256: await sha256(full),
      size: fs.statSync(full).size,
      name: f,
    };
  }

  const winExe = pick(files, /\.exe$/i);
  const winZip = pick(files, /win.*\.zip$/i);
  if (winExe || winZip) {
    const f = winExe || winZip;
    const full = path.join(DIST, f);
    platforms['win32-x64'] = {
      url: base + encodeURIComponent(f),
      sha256: await sha256(full),
      size: fs.statSync(full).size,
      name: f,
    };
  }

  if (!Object.keys(platforms).length) {
    console.error('dist/ 里没有找到可发布的安装包，请先执行 npm run dist:mac / dist:win');
    process.exit(1);
  }

  const manifest = {
    version: pkg.version,
    notes,
    publishedAt: new Date().toISOString(),
    platforms,
  };

  const out = path.join(DIST, 'latest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log('已生成 ' + out);
  for (const [k, v] of Object.entries(platforms)) {
    console.log(`  ${k.padEnd(14)} ${v.name}  ${(v.size / 1048576).toFixed(1)}MB  ${v.sha256.slice(0, 16)}…`);
  }
  console.log('\n把 latest.json 和对应的安装包一起上传到：' + base);
})().catch((e) => { console.error(e); process.exit(1); });
