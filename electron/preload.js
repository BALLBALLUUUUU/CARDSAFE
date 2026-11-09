'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch, cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  info: () => invoke('app:info'),

  volumes: () => invoke('volumes:list'),
  volumesRefresh: () => invoke('volumes:list', true),
  probe: (p) => invoke('source:probe', p),
  scan: (p) => invoke('source:scan', p),

  pickDir: (opts) => invoke('dialog:pickDir', opts),
  pickFile: (opts) => invoke('dialog:pickFile', opts),

  settings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:set', patch),

  enqueue: (spec) => invoke('task:enqueue', spec),
  cancel: () => invoke('task:cancel'),
  queue: () => invoke('queue:state'),

  history: () => invoke('history:list'),
  historyGet: (id) => invoke('history:get', id),
  historyClear: () => invoke('history:clear'),
  historyRemove: (id) => invoke('history:remove', id),

  exportPdf: (id, savePath) => invoke('report:pdf', { id, savePath }),
  exportCsv: (id) => invoke('report:csv', id),
  previewReport: (id) => invoke('report:preview', id),

  eject: (p) => invoke('eject:volume', p),
  checkFfmpeg: () => invoke('ffmpeg:check'),
  testNotify: () => invoke('notify:test'),

  update: {
    state: () => invoke('update:state'),
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    skip: (v) => invoke('update:skip', v),
    openNotes: () => invoke('update:openNotes'),
    onEvent: (cb) => on('update:event', cb),
  },

  reveal: (p) => invoke('shell:reveal', p),
  open: (p) => invoke('shell:open', p),
  setWindowBg: (color) => invoke('window:bg', color),
  setTransparent: (on) => invoke('window:setTransparent', on),
  setOpacityLevel: (lv) => invoke('window:setOpacityLevel', lv),

  win: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
  },

  onProgress: (cb) => on('task:progress', cb),
  onLog: (cb) => on('task:log', cb),
  onTaskStart: (cb) => on('task:started', cb),
  onTaskDone: (cb) => on('task:done', cb),
  onTranscode: (cb) => on('task:transcode', cb),
  onQueue: (cb) => on('queue:state', cb),
  onHistoryChanged: (cb) => on('history:changed', cb),
});
