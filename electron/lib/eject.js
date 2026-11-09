'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const pexec = promisify(execFile);

/** 安全弹出卷 */
async function ejectVolume(volumePath) {
  if (process.platform === 'darwin') {
    const { stdout } = await pexec('diskutil', ['eject', volumePath], { timeout: 30000 });
    return { ok: true, message: stdout.trim() };
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
