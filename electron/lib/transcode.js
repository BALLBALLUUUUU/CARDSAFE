'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { PRESETS } = require('./presets');
const { isVideoFile, formatBytes } = require('./util');

const pexec = promisify(execFile);

/** 查找 ffmpeg：设置里的自定义路径 → PATH → 常见安装位置 */
async function findFfmpeg(customPath) {
  const candidates = [];
  if (customPath) candidates.push(customPath);
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const n of names) {
    const sep = process.platform === 'win32' ? ';' : ':';
    for (const dir of (process.env.PATH || '').split(sep)) {
      if (dir) candidates.push(path.join(dir, n));
    }
  }
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/Applications/ffmpeg');
  }
  if (process.platform === 'win32') {
    candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe');
  }
  for (const c of candidates) {
    try {
      await fsp.access(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

function runFfmpeg(bin, args, onProgress, flag) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-8000);
      if (onProgress) onProgress(stderr);
    });
    const timer = setInterval(() => { if (flag && flag.cancelled) child.kill('SIGKILL'); }, 300);
    child.on('close', (code) => {
      clearInterval(timer);
      resolve({ code, stderr });
    });
    child.on('error', (e) => { clearInterval(timer); resolve({ code: -1, stderr: e.message }); });
  });
}

/**
 * 转码：把每个目标目录里的视频文件生成代理文件到 <dest>/_PROXY/
 * 仅复制成功的视频文件参与转码
 */
async function transcodeDest(job, hooks = {}) {
  const { onProgress, onLog } = hooks;
  const log = onLog || (() => {});
  const flag = { cancelled: false };
  const cfg = job.transcode || {};
  const preset = PRESETS[cfg.preset] || PRESETS.proxy_h264;
  const bin = await findFfmpeg(cfg.ffmpegPath);
  if (!bin) {
    log({ level: 'warn', msg: '未检测到 ffmpeg，已跳过转码。可在「设置 → 转码」指定 ffmpeg 路径。' });
    return { ok: false, reason: 'no-ffmpeg', files: [] };
  }
  const videos = (job.manifest || []).filter((m) => isVideoFile(m.rel) && m.verified !== false);
  if (!videos.length) {
    log({ level: 'info', msg: '没有需要转码的视频文件' });
    return { ok: true, files: [] };
  }

  const results = [];
  let done = 0;
  for (const dest of job.destinations) {
    for (const v of videos) {
      if (flag.cancelled) return { ok: false, reason: 'cancelled', files: results };
      const src = path.join(dest.root, v.rel);
      const outRel = path.join('_PROXY', path.dirname(v.rel), path.basename(v.rel, path.extname(v.rel)) + preset.ext);
      const out = path.join(dest.root, outRel);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
        '-map', '0:v:0?', '-map', '0:a:0?', ...preset.args, out];
      const started = Date.now();
      const r = await runFfmpeg(bin, args, null, flag);
      done++;
      const ok = r.code === 0;
      results.push({ rel: v.rel, out: outRel, dest: dest.base, ok, ms: Date.now() - started, msg: ok ? '' : r.stderr.slice(-400) });
      if (!ok) log({ level: 'error', msg: `转码失败 ${v.rel}: ${r.stderr.slice(-200)}` });
      else log({ level: 'info', msg: `转码完成 ${v.rel} → ${outRel}` });
      if (onProgress) onProgress({ done, total: videos.length * job.destinations.length, file: v.rel });
    }
  }
  const fail = results.filter((r) => !r.ok).length;
  log({ level: fail ? 'warn' : 'info', msg: `转码结束：成功 ${results.length - fail}，失败 ${fail}` });
  return { ok: fail === 0, files: results };
}

module.exports = { findFfmpeg, transcodeDest };
