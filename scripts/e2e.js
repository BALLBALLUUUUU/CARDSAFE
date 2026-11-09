'use strict';
/**
 * 端到端自检启动器（跨平台）
 * 用法：npm run test:e2e
 */
const { spawn } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron'); // 返回可执行文件路径
} catch (e) {
  console.error('未找到 Electron，请先运行 npm install');
  process.exit(1);
}

const env = { ...process.env, CARDSAFE_E2E: '1' };
// 某些终端/宿主环境会注入这两个变量，会让 Electron 退化成纯 Node 模式
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, [path.join(__dirname, '..')], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
