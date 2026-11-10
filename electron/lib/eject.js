'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

/** /Volumes/Untitled/M4ROOT/CLIP → /Volumes/Untitled（diskutil 只认卷根，传子目录会 Failed to find disk） */
function volumeRoot(p) {
  const parts = path.normalize(String(p)).split('/').filter(Boolean);
  if (parts[0] === 'Volumes' && parts[1]) return '/Volumes/' + parts[1];
  return String(p);
}

/** 安全弹出卷 */
async function ejectVolume(volumePath) {
  if (process.platform === 'darwin') {
    const target = volumeRoot(volumePath);
    try {
      const { stdout } = await pexec('diskutil', ['eject', target], { timeout: 30000 });
      return { ok: true, message: stdout.trim() || `已弹出 ${target}` };
    } catch (e) {
      // 卷仍被占用时退一步：只卸载（不做物理弹出），至少让卡可以安全拔除
      try {
        const { stdout } = await pexec('diskutil', ['unmount', target], { timeout: 30000 });
        return { ok: true, message: (stdout.trim() || `已卸载 ${target}`) + '（未能物理弹出，可拔出读卡器）' };
      } catch {
        return { ok: false, message: `弹出失败 ${target}：${e.message}` };
      }
    }
  }
  if (process.platform === 'win32') {
    const letter = volumePath.replace(/[\\/]+$/, '');
    const script = [
      '$ErrorActionPreference="Stop";',
      `$d='${letter.replace(/'/g, "''")}';`,
      'try {',
      '  (New-Object -comObject Shell.Application).Namespace(17).ParseName($d).InvokeVerb("Eject");',
      '  Start-Sleep -Milliseconds 800; "已发送弹出指令";',
      '} catch { throw $_.Exception.Message }',
    ].join(' ');
    try {
      const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 20000, windowsHide: true,
      });
      return { ok: true, message: stdout.trim() || '已发送弹出指令' };
    } catch (e) {
      // 兜底：部分读卡器不支持 Shell Eject，用 diskpart 卸载卷
      try {
        const drv = letter.charAt(0).toUpperCase();
        await pexec('diskpart', ['/s', '-'], { timeout: 15000, windowsHide: true, input: '' }).catch(() => {});
        return { ok: false, message: '该读卡器不支持自动弹出，可手动拔出（Windows 已写入缓存，建议先在资源管理器中"弹出"）: ' + drv };
      } catch {
        return { ok: false, message: e.message };
      }
    }
  }
  return { ok: false, message: '当前系统不支持自动弹出' };
}

module.exports = { ejectVolume };
