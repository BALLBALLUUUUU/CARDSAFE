'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

const PRESETS = {
  proxy_h264: {
    label: 'H.264 代理（540p）',
    ext: '.mp4',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-vf', 'scale=-2:540',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
    note: '剪辑代理，体积极小',
  },
  proxy_prores: {
    label: 'ProRes Proxy（422）',
    ext: '.mov',
    args: ['-c:v', 'prores_ks', '-profile:v', '0', '-vendor', 'apl0', '-c:a', 'pcm_s16le'],
    note: 'Final Cut / Premiere 原生友好',
  },
  preview_720: {
    label: 'H.264 预览（720p）',
    ext: '.mp4',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-vf', 'scale=-2:720',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
    note: '给客户看片用',
  },
  archive_hevc: {
    label: 'HEVC 归档（10bit 可选）',
    ext: '.mp4',
    args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '26', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
    note: '体积约减半，适合长期存档',
  },
};

module.exports = { PRESETS };
