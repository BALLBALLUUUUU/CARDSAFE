'use strict';
/**
 * 拷贝引擎：单次读取素材卡 → 同时写入多个目标 → 逐目标回读校验
 * 不依赖任何 native 模块，纯 Node 流 + OpenSSL 哈希，macOS / Windows 行为一致。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { isJunk, naturalCompare } = require('./util');

const HIGH_WATER = 8 * 1024 * 1024; // 8MB 块，顺序读写更友好

class CancelledError extends Error {
  constructor() { super('任务已取消'); this.code = 'ECANCELLED'; }
}

function checkCancel(flag) { if (flag.cancelled) throw new CancelledError(); }

async function freeSpace(p) {
  try {
    const s = await fsp.statfs(p);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/**
 * 扫描源目录。返回文件清单（相对路径、大小、mtime）
 */
async function scanSource(root, opts = {}) {
  const { skipJunk = true, onProgress } = opts;
  const files = [];
  let totalBytes = 0;
  let scanned = 0;

  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') return;
      throw e;
    }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    for (const ent of entries) {
      if (skipJunk && isJunk(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = relBase ? path.join(relBase, ent.name) : ent.name;
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        let st;
        try { st = await fsp.stat(abs); } catch { continue; }
        if (!st.isFile()) continue;
        files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
        totalBytes += st.size;
        scanned++;
        if (onProgress && scanned % 200 === 0) onProgress({ files: files.length, bytes: totalBytes });
      }
    }
  }

  const self = await fsp.stat(root);
  if (self.isFile()) {
    files.push({ rel: path.basename(root), abs: root, size: self.size, mtimeMs: self.mtimeMs });
    totalBytes = self.size;
  } else {
    await walk(root, '');
  }
  return { files, totalBytes };
}

/**
 * 一个文件写入多个目标（源只读一次）
 * targets: [{ path, error?, ws?, wrote }]
 */
async function copyFileMultiDest(src, targets, { algorithm, onBytes, flag }) {
  const hash = crypto.createHash(algorithm);
  const rs = fs.createReadStream(src, { highWaterMark: HIGH_WATER });
  const writers = targets.map((t) => {
    t.wrote = 0;
    const ws = fs.createWriteStream(t.path, { highWaterMark: HIGH_WATER });
    ws.on('error', (e) => { if (!t.error) t.error = e; });
    return { t, ws };
  });

  try {
    for await (const chunk of rs) {
      hash.update(chunk);
      for (const w of writers) {
        if (w.t.error) continue;
        try {
          if (!w.ws.write(chunk)) await once(w.ws, 'drain');
          w.t.wrote += chunk.length;
        } catch (e) {
          if (!w.t.error) w.t.error = e;
        }
      }
      if (onBytes) onBytes(chunk.length);
      if (flag && flag.cancelled) throw new CancelledError();
    }
    await Promise.all(writers.map((w) => new Promise((resolve) => {
      if (w.t.error) { try { w.ws.destroy(); } catch {} return resolve(); }
      w.ws.end(() => resolve());
    })));
  } catch (e) {
    for (const w of writers) { try { w.ws.destroy(); } catch {} }
    try { rs.destroy(); } catch {}
    throw e;
  }
  return hash.digest('hex');
}

async function hashFile(p, algorithm, onBytes, flag) {
  const hash = crypto.createHash(algorithm);
  const rs = fs.createReadStream(p, { highWaterMark: HIGH_WATER });
  for await (const chunk of rs) {
    hash.update(chunk);
    if (onBytes) onBytes(chunk.length);
    if (flag && flag.cancelled) throw new CancelledError();
  }
  return hash.digest('hex');
}

function makeEmptyState(job) {
  return {
    // 任务 id 在主进程里叫 job.id；测试/自检脚本传的是 job.taskId。
    // 两者都要认，否则进度事件的 taskId 为 undefined，渲染层会当作“别人的任务”整段丢弃。
    taskId: job.taskId || job.id,
    phase: 'pending',
    totalFiles: 0,
    doneFiles: 0,
    failedFiles: 0,
    skippedFiles: 0,
    totalBytes: 0,
    copiedBytes: 0,
    speed: 0,
    etaMs: 0,
    currentFile: '',
    dests: job.destinations.map((d) => ({
      path: d.root,
      base: d.base,
      copiedBytes: 0,
      filesDone: 0,
      filesSkipped: 0,
      filesFailed: 0,
      verifyFailed: 0,
      status: '等待中',
    })),
    errors: [],
    startedAt: Date.now(),
    endedAt: null,
  };
}

/**
 * 执行一次拷卡任务
 * job = {
 *   taskId, source, destinations:[{base, root}], algorithm, options:{
 *     skipJunk, skipExisting, verify ('hash'|'size'|'none'), concurrency, preserveTime
 *   }
 * }
 */
async function runCopyJob(job, hooks = {}) {
  const { onProgress, onLog } = hooks;
  const log = onLog || (() => {});
  const emit = onProgress || (() => {});
  // 允许外部传入取消标志（主进程的取消按钮通过它中断任务）
  const flag = hooks.flag || { cancelled: false };

  const opts = Object.assign({
    skipJunk: true,
    skipExisting: false,
    verify: 'hash',
    concurrency: 4,
    preserveTime: true,
  }, job.options || {});

  const state = makeEmptyState(job);
  const manifest = [];
  let lastEmit = 0;
  let windowBytes = 0;
  let windowStart = Date.now();

  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    const dt = (now - windowStart) / 1000;
    if (dt > 0.4) {
      const inst = windowBytes / dt;
      state.speed = state.speed ? state.speed * 0.6 + inst * 0.4 : inst;
      windowBytes = 0;
      windowStart = now;
    }
    const remain = Math.max(0, state.totalBytes - state.copiedBytes);
    state.etaMs = state.speed > 1024 ? (remain / state.speed) * 1000 : 0;
    // 只发浅拷贝 + 最近 30 条错误，避免异常卡导致 IPC 序列化爆炸
    emit({
      ...state,
      dests: state.dests.map((d) => ({ ...d })),
      errors: state.errors.slice(-30),
    });
  };

  try {
    // ---------- 1. 扫描 ----------
    state.phase = 'scanning';
    tick(true);
    const { files, totalBytes } = await scanSource(job.source, {
      skipJunk: opts.skipJunk,
      onProgress: (p) => { state.totalFiles = p.files; state.totalBytes = p.bytes; tick(true); },
    });
    state.totalFiles = files.length;
    state.totalBytes = totalBytes;
    tick(true);
    log({ level: 'info', msg: `扫描完成：${files.length} 个文件，共 ${totalBytes} 字节` });

    if (files.length === 0) throw new Error('源目录中没有可拷贝的文件');

    // ---------- 2. 目标预检 ----------
    for (const d of job.destinations) {
      try {
        await fsp.mkdir(d.root, { recursive: true });
        const probe = path.join(d.root, '.cardsafe_write_test');
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
        const fsInfo = await freeSpace(d.root);
        if (fsInfo && fsInfo.free < totalBytes) {
          const e = new Error(`目标空间不足：可用 ${fsInfo.free} 字节，需要 ${totalBytes} 字节`);
          e.fatal = true;
          throw e;
        }
      } catch (e) {
        const err = new Error(`目标不可用 ${d.root}：${e.message}`);
        state.errors.push({ dest: d.root, file: '', message: err.message });
        log({ level: 'error', msg: err.message });
        state.phase = 'failed';
        state.endedAt = Date.now();
        tick(true);
        return { state, manifest, ok: false, fatal: true };
      }
    }

    // ---------- 3. 拷贝 ----------
    state.phase = 'copying';
    log({ level: 'info', msg: `开始拷贝：${files.length} 个文件 → ${job.destinations.length} 个目标（${job.algorithm.toUpperCase()} 校验）` });
    const destStates = state.dests;
    let idx = 0;

    const worker = async () => {
      for (;;) {
        if (flag.cancelled) throw new CancelledError();
        const i = idx++;
        if (i >= files.length) return;
        const f = files[i];
        state.currentFile = f.rel;

        const targets = [];
        let anySkipped = false;
        for (let di = 0; di < job.destinations.length; di++) {
          const d = job.destinations[di];
          const dstPath = path.join(d.root, f.rel);
          let skip = false;
          if (opts.skipExisting) {
            try {
              const st = await fsp.stat(dstPath);
              if (st.isFile() && st.size === f.size) skip = true;
            } catch {}
          }
          if (skip) {
            destStates[di].filesSkipped++;
            destStates[di].copiedBytes += f.size;
            anySkipped = true;
            continue;
          }
          try {
            await fsp.mkdir(path.dirname(dstPath), { recursive: true });
          } catch (e) {
            destStates[di].filesFailed++;
            destStates[di].status = '写入失败';
            state.errors.push({ dest: d.base, file: f.rel, message: '创建目录失败：' + e.message });
            continue;
          }
          targets.push({ di, path: dstPath, error: null, wrote: 0 });
        }

        let srcHash = null;
        if (targets.length > 0) {
          try {
            srcHash = await copyFileMultiDest(f.abs, targets, {
              algorithm: job.algorithm,
              flag,
              onBytes: (n) => { windowBytes += n * targets.length; },
            });
          } catch (e) {
            if (e.code === 'ECANCELLED') throw e;
            // 整块失败：逐个目标记录
            for (const t of targets) {
              if (!t.error) t.error = e;
            }
          }

          for (const t of targets) {
            const ds = destStates[t.di];
            if (t.error) {
              ds.filesFailed++;
              ds.status = '有文件失败';
              state.failedFiles++;
              state.errors.push({ dest: job.destinations[t.di].base, file: f.rel, message: t.error.message });
              try { await fsp.unlink(t.path); } catch {}
              continue;
            }

            // 校验
            let verified = true;
            if (opts.verify === 'hash') {
              try {
                const dstHash = await hashFile(t.path, job.algorithm, null, flag);
                if (dstHash !== srcHash) { verified = false; }
              } catch (e) {
                if (e.code === 'ECANCELLED') throw e;
                verified = false;
              }
              if (!verified) {
                // 重试一次
                try {
                  await fsp.unlink(t.path).catch(() => {});
                  const retry = { di: t.di, path: t.path, error: null, wrote: 0 };
                  const h2 = await copyFileMultiDest(f.abs, [retry], { algorithm: job.algorithm, flag });
                  const h3 = await hashFile(t.path, job.algorithm, null, flag);
                  if (h2 === h3 && h2 === srcHash) verified = true;
                } catch (e) {
                  if (e.code === 'ECANCELLED') throw e;
                }
              }
              if (!verified) {
                ds.verifyFailed++;
                ds.status = '校验失败';
                state.failedFiles++;
                state.errors.push({
                  dest: job.destinations[t.di].base,
                  file: f.rel,
                  message: `哈希校验不一致（${job.algorithm.toUpperCase()}）`,
                });
                continue;
              }
            } else if (opts.verify === 'size') {
              try {
                const st = await fsp.stat(t.path);
                if (st.size !== f.size) verified = false;
              } catch { verified = false; }
              if (!verified) {
                ds.verifyFailed++;
                state.failedFiles++;
                state.errors.push({ dest: job.destinations[t.di].base, file: f.rel, message: '文件大小不一致' });
                continue;
              }
            }

            if (opts.preserveTime) {
              try {
                const mt = new Date(f.mtimeMs);
                await fsp.utimes(t.path, mt, mt);
              } catch {}
            }

            ds.filesDone++;
            ds.copiedBytes += f.size;
          }
        }

        // 全局进度按“源字节”计一次，避免多目标时进度翻倍
        if (anySkipped && targets.length === 0) {
          state.skippedFiles++;
          state.copiedBytes += f.size;
          if (manifest) manifest.push({ rel: f.rel, size: f.size, hash: '', verified: true, skipped: true });
        } else if (targets.some((t) => !t.error)) {
          state.copiedBytes += f.size;
          if (manifest) manifest.push({
            rel: f.rel,
            size: f.size,
            hash: srcHash || '',
            verified: targets.every((t) => !t.error),
          });
        }

        state.doneFiles++;
        tick();
      }
    };

    const conc = Math.max(1, Math.min(Number(opts.concurrency) || 4, 16));
    const workers = Array.from({ length: conc }, () => worker());
    const results = await Promise.allSettled(workers);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected) throw rejected.reason;

    // 处理被跳过但已计数的情况：copiedBytes 可能超出 totalBytes（多次累加），做一次夹取
    state.copiedBytes = Math.min(state.copiedBytes, state.totalBytes);
    state.speed = 0;

    // 收尾：给每个目标一个明确状态，报告里不再显示"等待中"
    for (const d of state.dests) {
      if (d.filesFailed > 0 || d.verifyFailed > 0) d.status = '有异常';
      else if (d.filesDone === 0 && d.filesSkipped > 0) d.status = '已跳过';
      else d.status = '完成';
    }

    state.phase = state.failedFiles > 0 ? 'failed' : 'done';
    state.endedAt = Date.now();
    tick(true);
    return { state, manifest, ok: state.failedFiles === 0 };
  } catch (e) {
    if (e.code === 'ECANCELLED') {
      state.phase = 'cancelled';
    } else {
      state.phase = 'failed';
      state.errors.push({ dest: '', file: state.currentFile || '', message: e.message });
      log({ level: 'error', msg: e.message });
    }
    state.endedAt = Date.now();
    state.speed = 0;
    tick(true);
    return { state, manifest, ok: false, aborted: true };
  }
}

module.exports = { runCopyJob, scanSource, freeSpace, hashFile, CancelledError, checkCancel };
