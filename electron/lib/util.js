'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function formatBytes(b) {
  if (!Number.isFinite(b) || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) + ' ' + u[i];
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '--';
  return formatBytes(bps) + '/s';
}

function stamp(d = new Date()) {
  return {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    hh: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    dateDash: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    timeColon: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

// 非法文件名字符：Windows 更严格，统一按 Windows 规则清洗，保证跨平台一致
function sanitizeSegment(s) {
  return String(s == null ? '' : s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

/**
 * 展开命名模板。支持变量：
 * {date} {time} {yyyy} {mm} {dd} {hh} {mm} {ss} {project} {card} {camera} {taskid} {dest}
 */
function expandTemplate(tpl, ctx) {
  const d = ctx.now instanceof Date ? ctx.now : new Date();
  const t = stamp(d);
  const vars = {
    date: t.date, dateDash: t.dateDash,
    time: t.time, timeColon: t.timeColon,
    yyyy: t.YYYY, MM: t.MM, DD: t.DD, hh: t.hh, mm: t.mm, ss: t.ss,
    project: ctx.project || '',
    card: ctx.card || '',
    camera: ctx.camera || '',
    taskid: ctx.taskId || '',
    dest: ctx.dest || '',
  };
  let out = String(tpl || '');
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const segs = out.split(/[\\/]+/).map(sanitizeSegment).filter(Boolean);
  return segs.join(path.sep);
}

const JUNK_PATTERNS = [
  /^\.DS_Store$/i,
  /^\._/,                      // AppleDouble
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\.Spotlight-V100$/,
  /^\.Trashes$/,
  /^\.fseventsd$/,
  /^\.TemporaryItems$/,
  /^\.DocumentRevisions-V100$/,
  /^\.apdisk$/,
  /^System Volume Information$/i,
  /^\$RECYCLE\.BIN$/i,
  /^\.Trash-\d+$/,
];

function isJunk(name) {
  return JUNK_PATTERNS.some((re) => re.test(name));
}

const MEDIA_EXT = new Set([
  '.mov', '.mp4', '.mxf', '.avi', '.mts', '.m2ts', '.m4v', '.r3d', '.braw', '.mkv', '.wmv', '.m2v', '.dv',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.heif', '.cr2', '.cr3', '.nef', '.arw', '.raf',
  '.dng', '.raw', '.orf', '.rw2', '.pef', '.srw', '.bmp', '.gif', '.psd', '.exr', '.dpx',
  '.wav', '.bwf', '.mp3', '.aif', '.aiff', '.m4a', '.flac',
]);

function isMediaFile(name) {
  return MEDIA_EXT.has(path.extname(name).toLowerCase());
}

function isVideoFile(name) {
  return ['.mov', '.mp4', '.mxf', '.avi', '.mts', '.m2ts', '.m4v', '.mkv', '.wmv', '.dv'].includes(path.extname(name).toLowerCase());
}

// 自然排序：A001C002 在 A001C010 之前
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).match(re) || [];
  const bx = String(b).match(re) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = parseInt(ax[i], 10), bn = parseInt(bx[i], 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

function homedir() { return os.homedir(); }

module.exports = {
  pad, formatBytes, formatDuration, formatSpeed, stamp,
  sanitizeSegment, expandTemplate, isJunk, isMediaFile, isVideoFile, naturalCompare, homedir,
};
