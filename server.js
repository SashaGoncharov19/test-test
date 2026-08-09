#!/usr/bin/env node
/**
 * SwapZone — сервер электронных чеков.
 *
 * Возможности:
 *   • раздача статики (index.html, admin.html)
 *   • создание чека админом  → POST   /api/admin/checks
 *   • список чеков           → GET    /api/admin/checks
 *   • погашение чека         → POST   /api/admin/checks/:code/redeem
 *   • аннулирование чека     → POST   /api/admin/checks/:code/cancel
 *   • продление чека         → POST   /api/admin/checks/:code/extend
 *   • публичная проверка     → GET    /api/checks/:code
 *   • health-check           → GET    /api/health
 *
 * Зависимостей нет — только стандартная библиотека Node.js 18+.
 * Данные хранятся в data/checks.json (атомарная запись + журнал событий).
 *
 * Запуск:
 *   node server.js
 *   PORT=8080 ADMIN_TOKEN=мой-секрет node server.js
 *
 * Переменные окружения:
 *   PORT                 порт (по умолчанию 3000)
 *   HOST                 интерфейс (по умолчанию 0.0.0.0)
 *   ADMIN_TOKEN          токен админки; если не задан — генерируется и пишется в data/admin-token.txt
 *   DEFAULT_TTL_HOURS    срок действия чека по умолчанию (по умолчанию 48)
 *   ALLOWED_ORIGIN       CORS-origin для публичной проверки (по умолчанию *)
 *   TELEGRAM_BOT_TOKEN   если задан вместе с TELEGRAM_CHAT_ID — уведомления о чеках в Telegram
 *   TELEGRAM_CHAT_ID     чат/канал для уведомлений
 *   WEBHOOK_URL          внешний вебхук: POST c JSON на каждое событие чека
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

/* ─────────────────────────── КОНФИГ ─────────────────────────── */

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'checks.json');
const LOG_FILE = path.join(DATA_DIR, 'events.log');
const TOKEN_FILE = path.join(DATA_DIR, 'admin-token.txt');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_TTL_HOURS = Number(process.env.DEFAULT_TTL_HOURS || 48);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const CASH_CURRENCIES = ['AED', 'USD', 'EUR'];
const MAX_BODY = 64 * 1024;          // 64 КБ на запрос
const CODE_PREFIX = 'SZ-';
const STATIC_FILES = new Set(['index.html', 'admin.html']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

/* ─────────────────────────── ХРАНИЛИЩЕ ─────────────────────────── */

fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {{checks: Object<string, any>}} */
let db = { checks: {} };

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.checks) db = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // повреждённый файл не теряем — уводим в бэкап и стартуем с чистой базой
      const backup = DB_FILE + '.corrupt-' + Date.now();
      try { fs.renameSync(DB_FILE, backup); } catch (_) {}
      console.error('[db] не удалось прочитать базу, файл сохранён как', backup);
    }
  }
}

// очередь записи: гарантирует последовательные атомарные сохранения
let writeChain = Promise.resolve();
function saveDb() {
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp-' + process.pid;
    const data = JSON.stringify(db, null, 2);
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, DB_FILE);
  }).catch((err) => console.error('[db] ошибка записи:', err.message));
  return writeChain;
}

function logEvent(event, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload }) + '\n';
  fs.appendFile(LOG_FILE, line, () => {});
}

/* ─────────────────────────── АДМИН-ТОКЕН ─────────────────────────── */

function resolveAdminToken() {
  if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 8) {
    return process.env.ADMIN_TOKEN;
  }
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved.length >= 8) return saved;
  } catch (_) {}
  const generated = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600 });
  return generated;
}
const ADMIN_TOKEN = resolveAdminToken();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAdmin(req) {
  const header = req.headers['x-admin-token'];
  const auth = req.headers['authorization'];
  const token = header || (auth && auth.startsWith('Bearer ') ? auth.slice(7) : '');
  return Boolean(token) && timingSafeEqual(token, ADMIN_TOKEN);
}

/* ─────────────────────────── ЛИМИТ ЗАПРОСОВ ─────────────────────────── */

const hits = new Map(); // ip -> {count, resetAt}
function rateLimit(ip, limit, windowMs) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
}, 60_000).unref();

/* ─────────────────────────── ЧЕКИ ─────────────────────────── */

function generateCode() {
  for (let i = 0; i < 50; i += 1) {
    const code = CODE_PREFIX + String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!db.checks[code]) return code;
  }
  // на случай заполнения диапазона — расширяем номер
  return CODE_PREFIX + String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
}

/** Актуальный статус с учётом срока действия. */
function effectiveStatus(check) {
  if (check.status === 'active' && Date.parse(check.expiresAt) <= Date.now()) return 'expired';
  return check.status;
}

function publicView(check) {
  return {
    code: check.code,
    status: effectiveStatus(check),
    amount: check.amount,
    currency: check.currency,
    pickup: check.pickup,
    issuedAt: check.issuedAt,
    expiresAt: check.expiresAt,
    redeemedAt: check.redeemedAt || null
  };
}

function adminView(check) {
  return { ...check, status: effectiveStatus(check), storedStatus: check.status };
}

function num(value) {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// убираем управляющие символы, обрезаем длину
function clean(value, max = 120) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// приводим любой ввод (sz482913, SZ-482913, 482913) к каноническому виду SZ-482913
function normalizeCode(raw) {
  const digits = String(raw || '').toUpperCase().replace(/[^0-9]/g, '');
  if (digits.length < 6 || digits.length > 8) return null;
  return CODE_PREFIX + digits;
}

function createCheck(body) {
  const amount = num(body.amount);
  const currency = clean(body.currency, 8).toUpperCase();
  const ttlHours = body.ttlHours == null ? DEFAULT_TTL_HOURS : num(body.ttlHours);

  const errors = [];
  if (!Number.isFinite(amount) || amount <= 0) errors.push('amount: укажите положительную сумму выдачи');
  if (!CASH_CURRENCIES.includes(currency)) errors.push('currency: допустимо ' + CASH_CURRENCIES.join(', '));
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 30) errors.push('ttlHours: от 1 до 720 часов');

  const cryptoAmount = body.cryptoAmount == null || body.cryptoAmount === '' ? null : num(body.cryptoAmount);
  if (cryptoAmount !== null && (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0)) {
    errors.push('cryptoAmount: некорректная сумма криптовалюты');
  }
  const rate = body.rate == null || body.rate === '' ? null : num(body.rate);
  if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) errors.push('rate: некорректный курс');

  if (errors.length) return { error: errors };

  const now = new Date();
  const check = {
    code: generateCode(),
    status: 'active',
    amount: Math.round(amount * 100) / 100,
    currency,
    cryptoAsset: clean(body.cryptoAsset, 16).toUpperCase() || null,
    cryptoAmount,
    rate,
    network: clean(body.network, 24) || null,
    client: clean(body.client, 64) || null,
    pickup: clean(body.pickup, 120) || 'Marina Plaza, офис 2902, Dubai Marina',
    delivery: Boolean(body.delivery),
    manager: clean(body.manager, 48) || null,
    note: clean(body.note, 400) || null,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600_000).toISOString(),
    ttlHours,
    redeemedAt: null,
    cancelledAt: null,
    history: [{ at: now.toISOString(), action: 'created' }]
  };

  db.checks[check.code] = check;
  saveDb();
  logEvent('check_created', { code: check.code, amount: check.amount, currency: check.currency });
  notify('created', check);
  return { check };
}

function transition(code, action, extra = {}) {
  const check = db.checks[code];
  if (!check) return { error: 'not_found' };
  const status = effectiveStatus(check);
  const now = new Date().toISOString();

  if (action === 'redeem') {
    if (status === 'redeemed') return { error: 'already_redeemed' };
    if (status === 'cancelled') return { error: 'cancelled' };
    if (status === 'expired') return { error: 'expired' };
    check.status = 'redeemed';
    check.redeemedAt = now;
  } else if (action === 'cancel') {
    if (status === 'redeemed') return { error: 'already_redeemed' };
    check.status = 'cancelled';
    check.cancelledAt = now;
  } else if (action === 'extend') {
    if (status === 'redeemed') return { error: 'already_redeemed' };
    if (status === 'cancelled') return { error: 'cancelled' };
    const hours = num(extra.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return { error: 'bad_hours' };
    const base = Math.max(Date.now(), Date.parse(check.expiresAt));
    check.expiresAt = new Date(base + hours * 3600_000).toISOString();
    check.status = 'active';
  } else {
    return { error: 'bad_action' };
  }

  check.history.push({ at: now, action, ...extra });
  saveDb();
  logEvent('check_' + action, { code });
  notify(action, check);
  return { check };
}

/* ─────────────────────────── РЫНОЧНЫЕ КУРСЫ ───────────────────────────
 * Сервер сам ходит за курсами и кеширует их, сайт берёт готовый снимок.
 * Источники (по очереди, при сбое — следующий):
 *   крипта: CoinGecko → Binance
 *   фиат:   open.er-api.com → exchangerate.host → привязка AED к доллару
 * Последний удачный снимок сохраняется в data/rates.json и переживает рестарт.
 * ------------------------------------------------------------------ */

const RATES_FILE = path.join(DATA_DIR, 'rates.json');
const RATES_REFRESH_MS = Math.max(30, Number(process.env.RATES_REFRESH_SECONDS || 60)) * 1000;
const RATES_STALE_MS = 15 * 60 * 1000;

const COINS = [
  { code: 'BTC',  cg: 'bitcoin',           binance: 'BTCUSDT'  },
  { code: 'ETH',  cg: 'ethereum',          binance: 'ETHUSDT'  },
  { code: 'USDT', cg: 'tether',            binance: null       },
  { code: 'USDC', cg: 'usd-coin',          binance: 'USDCUSDT' },
  { code: 'TON',  cg: 'the-open-network',  binance: 'TONUSDT'  },
  { code: 'LTC',  cg: 'litecoin',          binance: 'LTCUSDT'  },
  { code: 'TRX',  cg: 'tron',              binance: 'TRXUSDT'  },
  { code: 'SOL',  cg: 'solana',            binance: 'SOLUSDT'  },
  { code: 'BNB',  cg: 'binancecoin',       binance: 'BNBUSDT'  },
  { code: 'XMR',  cg: 'monero',            binance: null       }
];

// аварийные значения: используются, только если ни один источник не ответил ни разу
const FALLBACK = {
  crypto: {
    BTC: 96400, ETH: 3420, USDT: 1, USDC: 1, TON: 5.42,
    LTC: 104.3, TRX: 0.238, SOL: 184.5, BNB: 612, XMR: 168
  },
  fiatPerUsd: { AED: 3.6725, EUR: 0.92, USD: 1 }
};

let rates = null;      // текущий снимок
let ratesFetching = false;

function emptySnapshot() {
  const crypto_ = {};
  for (const c of COINS) crypto_[c.code] = { usd: FALLBACK.crypto[c.code], change24h: 0 };
  return {
    updatedAt: null,
    sources: { crypto: 'fallback', fiat: 'fallback' },
    crypto: crypto_,
    fiatPerUsd: { ...FALLBACK.fiatPerUsd }
  };
}

function loadRates() {
  try {
    const saved = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
    if (saved && saved.crypto && saved.fiatPerUsd) { rates = saved; return; }
  } catch (_) {}
  rates = emptySnapshot();
}

function saveRates() {
  const tmp = RATES_FILE + '.tmp-' + process.pid;
  fsp.writeFile(tmp, JSON.stringify(rates, null, 2), 'utf8')
    .then(() => fsp.rename(tmp, RATES_FILE))
    .catch(() => {});
}

async function getJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'SwapZone/1.0 (+checks-server)' }
    });
    if (!res.ok) throw new Error('http_' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* --- крипта: CoinGecko --- */
async function cryptoFromCoinGecko() {
  const ids = COINS.map((c) => c.cg).join(',');
  const data = await getJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=' + ids +
    '&vs_currencies=usd&include_24hr_change=true'
  );
  const out = {};
  for (const coin of COINS) {
    const row = data[coin.cg];
    if (row && Number.isFinite(Number(row.usd)) && Number(row.usd) > 0) {
      out[coin.code] = {
        usd: Number(row.usd),
        change24h: Number.isFinite(Number(row.usd_24h_change)) ? Number(row.usd_24h_change) : 0
      };
    }
  }
  if (Object.keys(out).length < 4) throw new Error('coingecko_incomplete');
  return out;
}

/* --- крипта: Binance (резерв) --- */
async function cryptoFromBinance() {
  const symbols = COINS.filter((c) => c.binance).map((c) => c.binance);
  const data = await getJson(
    'https://api.binance.com/api/v3/ticker/24hr?symbols=' +
    encodeURIComponent(JSON.stringify(symbols))
  );
  const bySymbol = new Map((Array.isArray(data) ? data : []).map((r) => [r.symbol, r]));
  const out = { USDT: { usd: 1, change24h: 0 } };
  for (const coin of COINS) {
    if (!coin.binance) continue;
    const row = bySymbol.get(coin.binance);
    const price = row && Number(row.lastPrice);
    if (Number.isFinite(price) && price > 0) {
      out[coin.code] = { usd: price, change24h: Number(row.priceChangePercent) || 0 };
    }
  }
  if (Object.keys(out).length < 4) throw new Error('binance_incomplete');
  return out;
}

/* --- фиат --- */
async function fiatFromErApi() {
  const data = await getJson('https://open.er-api.com/v6/latest/USD');
  const r = data && data.rates;
  if (!r || !Number.isFinite(Number(r.AED)) || !Number.isFinite(Number(r.EUR))) throw new Error('erapi_bad');
  return { USD: 1, AED: Number(r.AED), EUR: Number(r.EUR) };
}
async function fiatFromExchangerateHost() {
  const data = await getJson('https://api.exchangerate.host/latest?base=USD&symbols=AED,EUR');
  const r = data && data.rates;
  if (!r || !Number.isFinite(Number(r.AED)) || !Number.isFinite(Number(r.EUR))) throw new Error('exhost_bad');
  return { USD: 1, AED: Number(r.AED), EUR: Number(r.EUR) };
}

async function refreshRates() {
  if (ratesFetching) return rates;
  ratesFetching = true;

  const next = {
    updatedAt: rates && rates.updatedAt,
    sources: { crypto: rates ? rates.sources.crypto : 'fallback', fiat: rates ? rates.sources.fiat : 'fallback' },
    crypto: { ...rates.crypto },
    fiatPerUsd: { ...rates.fiatPerUsd }
  };
  let changed = false;

  // крипта
  try {
    const fresh = await cryptoFromCoinGecko();
    Object.assign(next.crypto, fresh);
    next.sources.crypto = 'coingecko';
    changed = true;
  } catch (errA) {
    try {
      const fresh = await cryptoFromBinance();
      Object.assign(next.crypto, fresh);
      next.sources.crypto = 'binance';
      changed = true;
    } catch (errB) {
      console.error('[rates] крипта недоступна:', errA.message, '/', errB.message);
    }
  }

  // фиат (AED привязан к доллару, поэтому расхождения минимальны, но проверяем)
  try {
    next.fiatPerUsd = await fiatFromErApi();
    next.sources.fiat = 'open.er-api.com';
    changed = true;
  } catch (errA) {
    try {
      next.fiatPerUsd = await fiatFromExchangerateHost();
      next.sources.fiat = 'exchangerate.host';
      changed = true;
    } catch (errB) {
      console.error('[rates] фиат недоступен:', errA.message, '/', errB.message);
    }
  }

  if (changed) {
    next.updatedAt = new Date().toISOString();
    rates = next;
    saveRates();
  }
  ratesFetching = false;
  return rates;
}

function ratesResponse() {
  const updatedMs = rates.updatedAt ? Date.parse(rates.updatedAt) : 0;
  return {
    ...rates,
    stale: !updatedMs || (Date.now() - updatedMs > RATES_STALE_MS),
    refreshSeconds: Math.round(RATES_REFRESH_MS / 1000),
    serverTime: new Date().toISOString()
  };
}

/* ─────────────────────────── УВЕДОМЛЕНИЯ ─────────────────────────── */

function postJson(urlString, payload) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(urlString); } catch (_) { return resolve(false); }
    const body = Buffer.from(JSON.stringify(payload));
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 8000
    }, (res) => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function notify(event, check) {
  if (WEBHOOK_URL) postJson(WEBHOOK_URL, { event, check: adminView(check) });
  if (TG_TOKEN && TG_CHAT && event === 'created') {
    const text =
      '🧾 Новый чек ' + check.code + '\n' +
      'К выдаче: ' + check.amount + ' ' + check.currency + '\n' +
      (check.cryptoAmount ? 'Принято: ' + check.cryptoAmount + ' ' + (check.cryptoAsset || '') + '\n' : '') +
      'Действителен до: ' + check.expiresAt;
    postJson('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { chat_id: TG_CHAT, text });
  }
}

/* ─────────────────────────── HTTP-УТИЛИТЫ ─────────────────────────── */

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let name = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (name === 'admin' || name === 'admin/') name = 'admin.html';
  if (name.includes('..') || name.includes('\0')) return sendJson(res, 400, { error: 'bad_path' });
  if (!STATIC_FILES.has(name)) return sendJson(res, 404, { error: 'not_found' });

  const file = path.join(ROOT, name);
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': name === 'admin.html' ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    });
    res.end(data);
  });
}

/* ─────────────────────────── МАРШРУТИЗАЦИЯ ─────────────────────────── */

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const urlPath = url.pathname.replace(/\/+$/, '') || '/';
  const ip = clientIp(req);

  try {
    /* --- health --- */
    if (urlPath === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        time: new Date().toISOString(),
        checks: Object.keys(db.checks).length,
        ratesUpdatedAt: rates && rates.updatedAt,
        ratesSources: rates && rates.sources
      });
    }

    /* --- рыночные курсы --- */
    if (urlPath === '/api/rates' && req.method === 'GET') {
      if (!rateLimit('rates:' + ip, 120, 60_000)) return sendJson(res, 429, { error: 'rate_limited' });
      // если снимок протух — пробуем обновить, но ответ не блокируем надолго
      const age = rates.updatedAt ? Date.now() - Date.parse(rates.updatedAt) : Infinity;
      if (age > RATES_REFRESH_MS) refreshRates().catch(() => {});
      return sendJson(res, 200, ratesResponse());
    }

    /* --- публичная проверка чека --- */
    const publicMatch = urlPath.match(/^\/api\/checks\/([A-Za-z0-9-]{3,20})$/);
    if (publicMatch && req.method === 'GET') {
      if (!rateLimit('verify:' + ip, 40, 60_000)) return sendJson(res, 429, { error: 'rate_limited' });
      const code = normalizeCode(publicMatch[1]);
      if (!code) return sendJson(res, 400, { error: 'bad_code' });
      const check = db.checks[code];
      if (!check) return sendJson(res, 404, { status: 'not_found', code });
      return sendJson(res, 200, publicView(check));
    }

    /* --- всё, что ниже, только для админа --- */
    if (urlPath.startsWith('/api/admin/')) {
      if (!rateLimit('admin:' + ip, 120, 60_000)) return sendJson(res, 429, { error: 'rate_limited' });
      if (!isAdmin(req)) {
        logEvent('admin_denied', { ip, path: urlPath });
        return sendJson(res, 401, { error: 'unauthorized' });
      }

      if (urlPath === '/api/admin/checks' && req.method === 'POST') {
        const body = await readBody(req);
        const result = createCheck(body);
        if (result.error) return sendJson(res, 400, { error: 'validation', details: result.error });
        return sendJson(res, 201, { check: adminView(result.check) });
      }

      if (urlPath === '/api/admin/checks' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        const query = (url.searchParams.get('q') || '').trim().toUpperCase();
        const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
        let list = Object.values(db.checks).map(adminView);
        if (status && status !== 'all') list = list.filter((c) => c.status === status);
        if (query) {
          list = list.filter((c) =>
            c.code.includes(query) ||
            (c.client || '').toUpperCase().includes(query) ||
            (c.note || '').toUpperCase().includes(query));
        }
        list.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt));
        const stats = Object.values(db.checks).reduce((acc, c) => {
          const s = effectiveStatus(c);
          acc[s] = (acc[s] || 0) + 1;
          return acc;
        }, {});
        return sendJson(res, 200, { checks: list.slice(0, limit), total: list.length, stats });
      }

      const actionMatch = urlPath.match(/^\/api\/admin\/checks\/([A-Za-z0-9-]{3,20})\/(redeem|cancel|extend)$/);
      if (actionMatch && req.method === 'POST') {
        const code = normalizeCode(actionMatch[1]);
        if (!code) return sendJson(res, 400, { error: 'bad_code' });
        const body = await readBody(req).catch(() => ({}));
        const result = transition(code, actionMatch[2], body);
        if (result.error === 'not_found') return sendJson(res, 404, { error: 'not_found' });
        if (result.error) return sendJson(res, 409, { error: result.error });
        return sendJson(res, 200, { check: adminView(result.check) });
      }

      return sendJson(res, 404, { error: 'not_found' });
    }

    /* --- статика --- */
    if (req.method === 'GET') return serveStatic(req, res, urlPath);
    return sendJson(res, 405, { error: 'method_not_allowed' });

  } catch (err) {
    if (err.message === 'bad_json') return sendJson(res, 400, { error: 'bad_json' });
    if (err.message === 'too_large') return sendJson(res, 413, { error: 'payload_too_large' });
    console.error('[server]', err);
    return sendJson(res, 500, { error: 'internal' });
  }
});

server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

/* ─────────────────────────── СТАРТ ─────────────────────────── */

loadDb();
loadRates();

// первая синхронизация курсов сразу, дальше — по таймеру
refreshRates().catch(() => {});
setInterval(() => { refreshRates().catch(() => {}); }, RATES_REFRESH_MS).unref();

server.listen(PORT, HOST, () => {
  const shown = process.env.ADMIN_TOKEN ? '(из переменной ADMIN_TOKEN)' : ADMIN_TOKEN;
  console.log('SwapZone checks server');
  console.log('  сайт:    http://localhost:' + PORT + '/');
  console.log('  админка: http://localhost:' + PORT + '/admin');
  console.log('  токен:   ' + shown);
  console.log('  чеков в базе: ' + Object.keys(db.checks).length);
});

function shutdown(signal) {
  console.log('\n[server] остановка (' + signal + ')…');
  server.close(() => {
    writeChain.finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
