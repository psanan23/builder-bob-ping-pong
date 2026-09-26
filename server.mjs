import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AlignmentBot } from './src/bot.mjs';
import * as ai from './src/ai.mjs';
import { createStore } from './src/store.mjs';
import { TelegramClient } from './src/telegram.mjs';

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL', 'OPENAI_API_KEY', 'DATABASE_URL'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

const publicUrl = new URL(process.env.PUBLIC_BASE_URL);
if (publicUrl.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS');
const webhookPath = '/telegram/webhook';
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET has an invalid format');

const allowedIds = new Set((process.env.ALLOWED_TELEGRAM_USER_IDS || '').split(',').map((item) => item.trim()).filter(Boolean));
const telegram = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
const store = createStore();
const bot = new AlignmentBot({ store, telegram, ai });
const chatQueues = new Map();
let webhookReady = false;

function sameSecret(received) {
  const first = Buffer.from(String(received || ''));
  const second = Buffer.from(secret);
  return first.length === second.length && timingSafeEqual(first, second);
}

function enqueue(chatId, work) {
  const key = String(chatId);
  const previous = chatQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work).catch((error) => {
    console.error('Webhook processing failed:', error?.name || 'Error');
  });
  chatQueues.set(key, next);
  next.finally(() => { if (chatQueues.get(key) === next) chatQueues.delete(key); });
}

function simplePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Builder Bob · connection test</title><style>body{font:18px system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:24px;color:#183128;background:#f4f7f4}h1{font-size:2rem}button{font:inherit;background:#205d43;color:white;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}button:disabled{opacity:.6}#result{min-height:2em;font-weight:600}small{color:#53655d}</style></head><body><small>Builder Bob · connection test</small><h1>Send Ping. Get Pong.</h1><p>This checks that your deployed service can receive a request and reply.</p><button id="ping">Send Ping</button><p id="result" role="status" aria-live="polite"></p><small>This page uses no AI and shows no project information.</small><script>const b=document.querySelector('#ping'),r=document.querySelector('#result');b.onclick=async()=>{b.disabled=true;r.textContent='Sending Ping…';try{const x=await fetch('/ping',{method:'POST'});if(!x.ok||await x.text()!=='Pong')throw Error();r.textContent='Pong — the server replied.'}catch{r.textContent='No reply. Please try again.'}finally{b.disabled=false}}</script></body></html>`;
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(webhookReady ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end(webhookReady ? 'ok' : 'starting');
  }
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(simplePage());
  }
  if (request.method === 'POST' && request.url === '/ping') {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Pong');
  }
  if (request.method !== 'POST' || request.url !== webhookPath) {
    response.writeHead(404); return response.end();
  }
  if (!sameSecret(request.headers['x-telegram-bot-api-secret-token'])) {
    response.writeHead(403); return response.end();
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { response.writeHead(413); return response.end(); }
      chunks.push(chunk);
    }
    const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const from = update.message?.from ?? update.callback_query?.from;
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (!from?.id || !chat?.id || chat.type !== 'private') {
      response.writeHead(200); return response.end('ok');
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    if (!allowedIds.has(String(from.id))) {
      if (update.message?.text?.startsWith('/start')) enqueue(chat.id, () => telegram.send(chat.id,
        `Your Telegram ID is <b>${from.id}</b>. Add it to ALLOWED_TELEGRAM_USER_IDS on the bot service, then send /start again.`));
      return;
    }
    enqueue(chat.id, () => bot.handleUpdate(update));
  } catch {
    if (!response.headersSent) { response.writeHead(400); response.end(); }
  }
});

// Fail deployment startup when durable storage is unavailable. Never claim readiness with volatile state.
await store.load('__startup_check__');
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', async () => {
  console.log(`Builder Bob listening on port ${port}`);
  try {
    await telegram.setWebhook(new URL(webhookPath, publicUrl).toString(), secret);
    webhookReady = true;
    console.log('Telegram webhook registered');
  } catch (error) {
    console.error('Telegram webhook registration failed:', error?.name || 'Error');
    server.close(() => process.exit(1));
  }
});

process.on('SIGTERM', () => server.close(async () => { await store.close(); }));
