'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexec = promisify(execFile);

let cache = { at: 0, data: [] };

function plat() { return process.platform; }

async function statfsSafe(p) {
  try {
    const s = await fsp.statfs(p);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { free: 0, total: 0 };
  }
}

/* ---------------- macOS ---------------- */
async function macRemovableMap() {
  const map = new Map();
  try {
    const { stdout } = await pexec('diskutil', ['list'], { timeout: 8000 });
    // 解析 diskutil list：外部/可移除磁盘通常标注 "external, physical"
    let current = null;
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\/dev\/(disk\d+)\s+\(([^)]*)\)/);
      if (m) current = { dev: m[1], flags: m[2] };
      const v = line.match(/^\s+\d+:\s+\S+\s+.*?\s(\/Volumes\/.+)$/);
      if (v && current) map.set(v[1].trim(), /external|removable/i.test(current.flags));
    }
  } catch { /* ignore */ }
  return map;
}

async function listMac() {
  const out = [];
  let names = [];
  try { names = await fsp.readdir('/Volumes'); } catch { return out; }
  const remov = await macRemovableMap();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = path.join('/Volumes', name);
    let st;
    try { st = await fsp.lstat(p); } catch { continue; }
    if (st.isSymbolicLink()) continue; // 启动盘符号链接
    const info = await statfsSafe(p);
    out.push({
      path: p,
      label: name,
      fs: '',
      total: info.total,
      free: info.free,
      removable: remov.get(p) || false,
      kind: 'volume',
    });
  }
  return out;
}

/* -------------- Windows 11 -------------- */
async function listWindows() {
  const script = [
    'Get-CimInstance Win32_LogicalDisk |',
    'Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType |',
    'ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((d) => d && d.DeviceID && Number(d.DriveType) !== 5)
      .map((d) => ({
        path: d.DeviceID.endsWith('\\') ? d.DeviceID : d.DeviceID + '\\',
        label: d.VolumeName || d.DeviceID.replace(':', ''),
        fs: d.FileSystem || '',
        total: Number(d.Size) || 0,
        free: Number(d.FreeSpace) || 0,
        removable: Number(d.DriveType) === 2,
        kind: Number(d.DriveType) === 2 ? 'removable' : 'fixed',
      }));
  } catch {
    return [];
  }
}

/* ---------------- Linux ---------------- */
async function listLinux() {
  const out = [];
  const roots = [`/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, '/media', '/mnt'];
  for (const r of roots) {
    let names = [];
    try { names = await fsp.readdir(r); } catch { continue; }
    for (const n of names) {
      const p = path.join(r, n);
      try {
        const st = await fsp.stat(p);
        if (!st.isDirectory()) continue;
        const info = await statfsSafe(p);
        if (info.total === 0) continue;
        out.push({ path: p, label: n, fs: '', total: info.total, free: info.free, removable: true, kind: 'volume' });
      } catch {}
    }
  }
  return out;
}

async function listVolumes(force = false) {
  const now = Date.now();
  if (!force && now - cache.at < 4000 && cache.data.length) return cache.data;
  let data = [];
  if (plat() === 'darwin') data = await listMac();
  else if (plat() === 'win32') data = await listWindows();
  else data = await listLinux();
  // 归类：有 DCIM / PRIVATE / CLIP 之类结构视为“素材卡”
  for (const v of data) {
    v.camera = await detectCard(v.path);
    v.isCard = !!v.camera;
  }
  data.sort((a, b) => (b.isCard - a.isCard) || a.label.localeCompare(b.label));
  cache = { at: now, data };
  return data;
}

const CARD_MARKERS = [
  ['DCIM', '相机卡 (DCIM)'],
  ['PRIVATE', '索尼 / AVCHD (PRIVATE)'],
  ['XDROOT', '索尼 XDCAM (XDROOT)'],
  ['CONTENTS', 'BMD / 摄影机 (CONTENTS)'],
  ['AVCHD', 'AVCHD'],
  ['BPAV', '索尼 XDCAM EX (BPAV)'],
  ['CLIP', 'RED / 通用 CLIP'],
  ['M4ROOT', '佳能 Cinema EOS (M4ROOT)'],
  ['ARRI', 'ARRI (ARRI)'],
  ['RDM', 'RED (RDM)'],
];

async function detectCard(root) {
  try {
    const names = await fsp.readdir(root);
    const upper = new Set(names.map((n) => n.toUpperCase()));
    for (const [marker, label] of CARD_MARKERS) {
      if (upper.has(marker)) return label;
    }
    if (upper.has('DCIM')) return '相机卡 (DCIM)';
  } catch {}
  return null;
}

/** 扫描目录下的拍摄素材统计，用于界面预览 */
async function probeSource(root) {
  const res = { path: root, files: 0, bytes: 0, camera: null, topDirs: [], mediaCount: 0 };
  try {
    const names = await fsp.readdir(root, { withFileTypes: true });
    res.camera = await detectCard(root);
    for (const ent of names) {
      if (!ent.isDirectory()) continue;
      res.topDirs.push(ent.name);
      if (res.topDirs.length >= 12) break;
    }
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

module.exports = { listVolumes, detectCard, probeSource };
