'use strict';
/**
 * 生成应用图标：把 build/icon.html 渲染成 1024×1024 透明 PNG
 * 用法：electron scripts/make-icon.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');
const HTML = path.join(__dirname, '..', 'build', 'icon.html');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadFile(HTML);
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(OUT, png);
  console.log('ICON_OK ' + OUT + ' ' + png.length + ' bytes  ' + img.getSize().width + 'x' + img.getSize().height);
  app.exit(0);
});
