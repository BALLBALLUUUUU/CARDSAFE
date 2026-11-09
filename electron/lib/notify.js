'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

/* 系统通知 */
async function systemNotify(msg) {
  const { Notification } = require('electron');
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: msg.title || 'CardSafe',
    body: (msg.lines || []).slice(0, 2).join('\n'),
    silent: false,
  });
  n.show();
  return true;
}

/* 邮件（SMTP） */
async function emailNotify(cfg, msg) {
  if (!cfg.enabled || !cfg.host || !cfg.to) return false;
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch { return false; }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 465,
    secure: cfg.secure !== false,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 12000,
    socketTimeout: 20000,
  });
  const html = `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
    <h2 style="margin:0 0 10px">${escapeHtml(msg.title || 'CardSafe')}</h2>
    <pre style="background:#f5f6f8;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap">${escapeHtml((msg.lines || []).join('\n'))}</pre>
    <p style="color:#9aa0a6;font-size:12px">—— CARDSAFE 素材拷卡</p></div>`;
  await transport.sendMail({
    from: cfg.from || cfg.user,
    to: cfg.to,
    subject: `[CARDSAFE] ${msg.title || '拷卡通知'}`,
    text: (msg.lines || []).join('\n'),
    html,
  });
  return true;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Webhook：自动适配 Bark / Server酱 / 钉钉 / 企业微信 / 通用 */
function buildWebhookPayload(url, msg) {
  const text = (msg.lines || []).join('\n');
  if (/api\.day\.app/.test(url)) {
    return { body: { title: msg.title, body: text, group: 'CardSafe' }, headers: { 'Content-Type': 'application/json' } };
  }
  if (/sctapi\.ftqq\.com|pushplus|serverchan/.test(url)) {
    return { body: { title: msg.title, desp: text.replace(/\n/g, '\n\n') }, headers: { 'Content-Type': 'application/json' } };
  }
  if (/oapi\.dingtalk\.com/.test(url)) {
    return { body: { msgtype: 'text', text: { content: `${msg.title}\n${text}` } }, headers: { 'Content-Type': 'application/json' } };
  }
  if (/qyapi\.weixin\.qq\.com/.test(url)) {
    return { body: { msgtype: 'text', text: { content: `${msg.title}\n${text}` } }, headers: { 'Content-Type': 'application/json' } };
  }
  return { body: { title: msg.title, text, status: msg.status, at: new Date().toISOString() }, headers: { 'Content-Type': 'application/json' } };
}

function webhookNotify(cfg, msg) {
  if (!cfg.enabled || !cfg.url) return Promise.resolve(false);
  return new Promise((resolve) => {
    let u;
    try { u = new URL(cfg.url); } catch { return resolve(false); }
    const { body, headers } = buildWebhookPayload(cfg.url, msg);
    const data = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': data.length },
      timeout: 10000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

async function notifyAll(settings, msg) {
  const n = settings.notify || {};
  const tasks = [];
  if (n.system !== false) tasks.push(systemNotify(msg).catch(() => false));
  if (n.email && n.email.enabled) tasks.push(emailNotify(n.email, msg).catch(() => false));
  if (n.webhook && n.webhook.enabled) tasks.push(webhookNotify(n.webhook, msg));
  return Promise.all(tasks);
}

module.exports = { notifyAll, systemNotify, emailNotify, webhookNotify };
