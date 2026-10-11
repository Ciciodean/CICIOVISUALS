// Visual Arc — REAL production server (zero dependencies, plain Node.js)
// Accounts · credits · real numbers (Twilio/Telnyx) · admin panel

const http = require('http');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const crypto = require('crypto');
const { activeProvider, searchNumbers, buyNumber, releaseNumber, parseInbound, fetchMessages } = require('./providers');

const PORT = process.env.PORT || 5050;
const DB_FILE = path.join(__dirname, 'db.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'visualarc2026';
const SIGNUP_BONUS = Number(process.env.SIGNUP_BONUS || 0); // in KSh
const USDT_ADDRESS = process.env.USDT_ADDRESS || '';        // TRC-20 address for top-ups

// prices in KSh (server is the source of truth)
const PRICES = {
  'Generic SMS': 20, 'WhatsApp': 110, 'Telegram': 70, 'Discord': 45,
  'Uber': 100, 'Instagram': 155, 'Google / Gmail': 195, 'Dating apps': 115
};

// ---- env ----
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  }
} catch (e) {}

// ---- db ----
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    d.users = d.users || {}; d.sessions = d.sessions || {}; d.rentals = d.rentals || {};
    return d;
  } catch { return { users: {}, sessions: {}, rentals: {}, baseUrl: null }; }
}
const db = loadDb();
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function hashPassword(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pass, stored) {
  const [salt, hash] = String(stored).split(':');
  const test = crypto.scryptSync(String(pass), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}
function getUser(req, body) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = auth || (body && body.token) || '';
  const s = db.sessions[token];
  return s ? db.users[s.email] : null;
}

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req && req.headers && req.headers.host;
  return host ? 'https://' + host : (db.baseUrl || 'http://localhost:' + PORT);
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}
function extractCode(text) {
  const m = (text || '').match(/\b(\d{3,8})\b/);
  return m ? m[1] : '';
}

// ---- rentals ----
async function createRental(user, service, areaCode, req) {
  const price = PRICES[service] || 20;
  if (user.credits < price) throw { code: 402, message: 'Not enough credits — top up your balance first (need KSh ' + price + ')' };
  const numbers = await searchNumbers(areaCode);
  if (!numbers.length) throw new Error('No US numbers available right now — try again in a minute');
  const webhook = publicBase(req) + '/webhooks/' + activeProvider();
  const bought = await buyNumber(numbers[0], webhook);
  user.credits -= price;
  const id = crypto.randomBytes(8).toString('hex');
  db.rentals[id] = {
    id, service, price, email: user.email, number: bought.number, providerRef: bought.providerRef,
    status: 'active', createdAt: Date.now(), messages: []
  };
  saveDb();
  return db.rentals[id];
}

function findRentalByNumber(number) {
  return Object.values(db.rentals).find(r => r.number === number && r.status === 'active');
}

async function releaseRental(id) {
  const r = db.rentals[id];
  if (!r || r.status === 'released') return false;
  await releaseNumber(r.providerRef);
  r.status = 'released';
  r.releasedAt = Date.now();
  // refund if nothing was received
  if (!r.messages.length && r.email && db.users[r.email]) {
    db.users[r.email].credits += r.price;
    r.refunded = true;
  }
  saveDb();
  return true;
}

setInterval(() => {
  const now = Date.now();
  Object.values(db.rentals).forEach(r => {
    if (r.status === 'active' && now - r.createdAt > 20 * 60 * 1000) releaseRental(r.id);
  });
}, 60 * 1000);

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
    return res.end();
  }
  try {
    let body = {};
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try { body = JSON.parse(raw || '{}'); } catch (e) {
        if (url.startsWith('/webhooks/')) body = querystring.parse(raw || '');
      }
    }

    // ---------- status ----------
    if (url === '/api/status') {
      return json(res, 200, { real: !!activeProvider(), provider: activeProvider(), payments: !!USDT_ADDRESS });
    }

    // ---------- auth ----------
    if (url === '/api/signup' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const pass = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { ok: false, error: 'Invalid email' });
      if (pass.length < 6) return json(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
      if (db.users[email]) return json(res, 409, { ok: false, error: 'Account already exists — log in instead' });
      db.users[email] = { email, pass: hashPassword(pass), credits: SIGNUP_BONUS, createdAt: Date.now() };
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions[token] = { email, createdAt: Date.now() };
      saveDb();
      return json(res, 200, { ok: true, token, email, credits: db.users[email].credits });
    }

    if (url === '/api/login' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const u = db.users[email];
      if (!u || !verifyPassword(String(body.password || ''), u.pass)) return json(res, 401, { ok: false, error: 'Wrong email or password' });
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions[token] = { email, createdAt: Date.now() };
      saveDb();
      return json(res, 200, { ok: true, token, email, credits: u.credits });
    }

    if (url === '/api/me' && req.method === 'GET') {
      const u = getUser(req);
      if (!u) return json(res, 401, { ok: false, error: 'Not logged in' });
      return json(res, 200, { ok: true, email: u.email, credits: u.credits });
    }

    // ---------- payments info ----------
    if (url === '/api/payment-info') {
      return json(res, 200, { ok: true, usdtAddress: USDT_ADDRESS, currency: 'KSh', method: 'USDT (TRC-20)' });
    }

    // ---------- rent / rentals ----------
    if (url === '/api/rent' && req.method === 'POST') {
      const user = getUser(req, body);
      if (!user) return json(res, 401, { ok: false, error: 'Please log in first' });
      if (!activeProvider()) return json(res, 503, { ok: false, error: 'Number provider not configured' });
      try {
        const rental = await createRental(user, body.service || 'Generic SMS', body.areaCode, req);
        return json(res, 200, { ok: true, rentalId: rental.id, number: rental.number, service: rental.service, price: rental.price, credits: user.credits });
      } catch (e) {
        return json(res, e.code || 502, { ok: false, error: String(e.message || e) });
      }
    }

    const m = url.match(/^\/api\/rentals\/([a-f0-9]+)$/);
    if (m && req.method === 'GET') {
      const r = db.rentals[m[1]];
      if (!r) return json(res, 404, { ok: false, error: 'Rental not found' });
      try {
        const inbound = await fetchMessages(r.number);
        const seen = new Set(r.messages.map(x => x.providerMsgId).filter(Boolean));
        inbound.forEach(msg => {
          if (!seen.has(msg.providerMsgId)) {
            r.messages.push({ providerMsgId: msg.providerMsgId, from: msg.from, text: msg.text, code: extractCode(msg.text), ts: msg.ts });
          }
        });
        r.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        saveDb();
      } catch (e) {}
      return json(res, 200, { ok: true, status: r.status, number: r.number, messages: r.messages, refunded: !!r.refunded });
    }

    const mr = url.match(/^\/api\/rentals\/([a-f0-9]+)\/release$/);
    if (mr && req.method === 'POST') {
      await releaseRental(mr[1]);
      return json(res, 200, { ok: true });
    }

    // ---------- webhooks (fallback delivery path) ----------
    if (url === '/webhooks/twilio' && req.method === 'POST') {
      const msg = parseInbound('twilio', body);
      const rental = findRentalByNumber(msg.number);
      if (rental) {
        rental.messages.push({ providerMsgId: msg.providerMsgId, from: msg.from, text: msg.text, code: extractCode(msg.text), ts: Date.now() });
        saveDb();
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end('<Response></Response>');
    }
    if (url === '/webhooks/telnyx' && req.method === 'POST') {
      const msg = parseInbound('telnyx', body);
      const rental = findRentalByNumber(msg.number);
      if (rental) {
        rental.messages.push({ providerMsgId: msg.providerMsgId, from: msg.from, text: msg.text, code: extractCode(msg.text), ts: Date.now() });
        saveDb();
      }
      return json(res, 200, { ok: true });
    }

    // ---------- admin ----------
    if (url === '/api/admin/overview' && req.method === 'GET') {
      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (key !== ADMIN_KEY) return json(res, 403, { ok: false, error: 'Bad admin key' });
      const users = Object.values(db.users).map(u => ({ email: u.email, credits: u.credits, createdAt: u.createdAt }));
      const rentals = Object.values(db.rentals).map(r => ({
        id: r.id, email: r.email, service: r.service, number: r.number, price: r.price,
        status: r.status, msgs: r.messages.length, refunded: !!r.refunded
      })).sort((a, b) => b.id.localeCompare(a.id));
      return json(res, 200, { ok: true, users, rentals, provider: activeProvider() });
    }

    if (url === '/api/admin/credit' && req.method === 'POST') {
      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (key !== ADMIN_KEY) return json(res, 403, { ok: false, error: 'Bad admin key' });
      const email = String(body.email || '').trim().toLowerCase();
      const amount = Number(body.amount || 0);
      if (!db.users[email]) return json(res, 404, { ok: false, error: 'No such user' });
      if (!amount || Math.abs(amount) > 100000) return json(res, 400, { ok: false, error: 'Bad amount' });
      db.users[email].credits += amount;
      saveDb();
      return json(res, 200, { ok: true, email, credits: db.users[email].credits });
    }

    // ---------- static ----------
    let file = path.join(__dirname, 'index.html');
    if (url === '/admin') file = path.join(__dirname, 'admin.html');
    else if (url !== '/' && url !== '/index.html') {
      const cand = path.join(__dirname, path.normalize(url).replace(/^([.][.][/\\])+/, ''));
      if (fs.existsSync(cand) && fs.statSync(cand).isFile() && cand.startsWith(__dirname)) file = cand;
    }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain' };
    res.writeHead(200, { 'Content-Type': (types[ext] || 'application/octet-stream') + '; charset=utf-8' });
    return res.end(fs.readFileSync(file));

  } catch (e) {
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException:', e && e.message));

server.listen(PORT, '0.0.0.0', () => {
  console.log('Visual Arc REAL server on :' + PORT);
  console.log('Provider: ' + (activeProvider() || 'NONE') + ' | Payments: ' + (USDT_ADDRESS ? 'USDT enabled' : 'pending (set USDT_ADDRESS)'));
});
