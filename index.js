'use strict';
/**
 * SAIYAN — Node.js + Express + MongoDB port of the original PHP project.
 *
 * index.js  = connection.php + index.php  (shared core, models, session, CSRF, uploads, home page)
 * api.js    = api.php
 * team.js   = team.php
 * leader.js = leader.php
 * admin.js  = prince.php
 *
 * URLs are kept identical to the PHP version (/index.php, /team.php, /leader.php, /prince.php, /api.php).
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const multer = require('multer');

if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') {
  try { process.loadEnvFile(); } catch (_) { /* no local .env — fine */ }
}
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
// Always coerce request input to a plain string / int (blocks NoSQL operator injection like phone[$ne]=x).
const S = (v) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
const I = (v) => { const n = Number.parseInt(S(typeof v === 'number' ? String(v) : v), 10); return Number.isSafeInteger(n) ? n : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byteLen = (s) => Buffer.byteLength(s, 'utf8'); // PHP strlen() counts bytes

// PHP htmlspecialchars(ENT_QUOTES)
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
// PHP cleanOutput(): escape every string in a structure
const clean = (d) => {
  if (Array.isArray(d)) return d.map(clean);
  if (typeof d === 'string') return h(d);
  if (d && typeof d === 'object' && !(d instanceof Date)) return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, clean(v)]));
  return d;
};
// PHP strip_tags()
const stripTags = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z!?][^>]*>?/g, '');

const dtf = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtDate = (d) => (d ? dtf.format(new Date(d)).replace(/[\u00a0\u202f]/g, ' ') : null); // "YYYY-MM-DD HH:mm:ss", Asia/Dhaka

// Safe to embed in <script>
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// Safe inside a single-quoted HTML attribute (PHP JSON_HEX_TAG|APOS|AMP)
const attrJson = (o) => JSON.stringify(o).replace(/[<>&']/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
// Client-side code is written as real JS functions; this returns the function body as script text.
const scriptBody = (fn) => { const s = fn.toString(); return s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')).replace(/<\/script/gi, '<\\/script'); };

/* ------------------------------------------------------------------ */
/* Mongoose models (replacement for the MySQL tables)                  */
/* ------------------------------------------------------------------ */
const { Schema } = mongoose;
const ID = { type: Number, required: true, unique: true };
const model = (name, fields, indexes = []) => {
  if (mongoose.models[name]) return mongoose.models[name];
  const s = new Schema(fields, { versionKey: false });
  indexes.forEach(([f, o]) => s.index(f, o || {}));
  return mongoose.model(name, s, name);
};
const now = { type: Date, default: Date.now };

const M = {
  User: model('users', {
    id: ID, name: { type: String, required: true, maxlength: 200 }, phone: { type: String, required: true, unique: true, maxlength: 30 },
    address: { type: String, default: '', maxlength: 1000 }, password: { type: String, required: true },
    team_id: { type: Number, default: 0 }, status: { type: String, default: 'pending', enum: ['pending', 'approved', 'active', 'banned'] },
    role: { type: String, default: 'member' }, power_level: { type: Number, default: 0 },
    profile_pic: { type: String, default: null }, id_card_image: { type: String, default: null }, id_card_status: { type: String, default: null },
    created_at: now,
  }, [[{ team_id: 1 }], [{ id_card_status: 1 }]]),
  Team: model('teams', { id: ID, team_name: { type: String, required: true, maxlength: 200 }, leader_id: { type: Number, default: null }, created_at: now }, [[{ leader_id: 1 }]]),
  Post: model('community_posts', { id: ID, user_id: Number, content: { type: String, default: '', maxlength: 10000 }, image: { type: String, default: null }, team_id: { type: Number, default: 0 }, created_at: now },
    [[{ team_id: 1, created_at: -1 }], [{ user_id: 1, created_at: -1 }]]),
  Like: model('post_likes', { id: ID, user_id: Number, post_id: Number, created_at: now }, [[{ post_id: 1, user_id: 1 }, { unique: true }]]),
  Comment: model('post_comments', { id: ID, user_id: Number, post_id: Number, comment: { type: String, maxlength: 2000 }, created_at: now }, [[{ post_id: 1, created_at: 1 }]]),
  Chat: model('chats', { id: ID, user_id: Number, team_id: { type: Number, default: 0 }, message: { type: String, maxlength: 2000 }, created_at: now }, [[{ team_id: 1, created_at: -1 }]]),
  Notice: model('notices', { id: ID, title: { type: String, maxlength: 300 }, message: { type: String, maxlength: 5000 }, created_by: Number, team_id: { type: Number, default: 0 }, status: { type: String, default: 'approved' }, created_at: now }, [[{ team_id: 1, status: 1 }]]),
  Mission: model('missions', { id: ID, title: { type: String, maxlength: 300 }, description: { type: String, maxlength: 5000 }, points_reward: { type: Number, default: 0 }, image: { type: String, default: null }, team_id: { type: Number, default: 0 }, created_by: Number, status: { type: String, default: 'pending' }, created_at: now }, [[{ status: 1, team_id: 1 }]]),
  Poll: model('polls', { id: ID, title: { type: String, maxlength: 500 }, created_by: Number, created_at: now }),
  Option: model('poll_options', { id: ID, poll_id: Number, option_text: { type: String, maxlength: 300 } }, [[{ poll_id: 1 }]]),
  Vote: model('poll_votes', { id: ID, poll_id: Number, option_id: Number, user_id: Number, created_at: now }, [[{ poll_id: 1, user_id: 1 }, { unique: true }], [{ option_id: 1 }]]),
  Event: model('events', { id: ID, title: { type: String, maxlength: 300 }, event_date: String, description: { type: String, default: '', maxlength: 5000 } }),
  Rule: model('rules', { id: ID, content: { type: String, maxlength: 2000 } }),
  Ad: model('ads', { id: ID, title: { type: String, maxlength: 300 }, image: String, link: { type: String, maxlength: 2000 }, type: { type: String, default: 'native' }, status: { type: String, default: 'active' } }),
  Blood: model('blood_requests', { id: ID, user_id: Number, blood_group: { type: String, maxlength: 10 }, location: { type: String, maxlength: 300 }, details: { type: String, default: '' }, contact: { type: String, maxlength: 50 }, created_at: now }, [[{ created_at: -1 }]]),
  // Uploaded images live in MongoDB because Vercel has no persistent filesystem.
  File: model('files', { name: { type: String, required: true, unique: true }, mime: String, data: Buffer, created_at: now }),
  Counter: model('counters', { _id: String, seq: { type: Number, default: 0 } }),
  RateLimit: model('ratelimits', { key: { type: String, required: true, unique: true }, count: { type: Number, default: 0 }, expireAt: { type: Date, index: { expireAfterSeconds: 0 } } }),
};

const find = (Model, filter = {}, sort, limit) => { let q = Model.find(filter).select('-_id'); if (sort) q = q.sort(sort); if (limit) q = q.limit(limit); return q.lean(); };
const one = (Model, filter) => Model.findOne(filter).select('-_id').lean();

// MySQL AUTO_INCREMENT replacement (keeps numeric ids so URLs, forms and JS keep working).
async function nextId(Model) {
  const name = Model.collection.name;
  let c = await M.Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true }).lean();
  if (c.seq === 1) { // first use: continue after any pre-existing (imported) ids
    const top = await Model.findOne().sort({ id: -1 }).select('id').lean();
    if (top && top.id >= 1) c = await M.Counter.findOneAndUpdate({ _id: name }, { $set: { seq: top.id + 1 } }, { new: true }).lean();
  }
  return c.seq;
}
async function insert(Model, doc) { const id = await nextId(Model); await Model.create({ ...doc, id }); return id; }
async function resetCounters() { // after restore/import
  for (const Model of Object.values(M)) {
    if (!Model.schema.path('id')) continue;
    const top = await Model.findOne().sort({ id: -1 }).select('id').lean();
    await M.Counter.updateOne({ _id: Model.collection.name }, { $set: { seq: top ? top.id : 0 } }, { upsert: true });
  }
}

/* ------------------------------------------------------------------ */
/* MongoDB connection (cached across serverless invocations)           */
/* ------------------------------------------------------------------ */
const cache = global.__saiyanMongo || (global.__saiyanMongo = { promise: null, ready: false });

async function bootstrapAdmin() {
  const phone = (process.env.ADMIN_PHONE || '').trim();
  const pass = process.env.ADMIN_PASSWORD || '';
  if (!phone || !pass) return;
  if (await M.User.exists({ role: 'prince' })) return;
  if (byteLen(pass) < 10) { console.error('ADMIN_PASSWORD must be at least 10 characters; admin not created.'); return; }
  try {
    await insert(M.User, { name: process.env.ADMIN_NAME || 'Prince', phone, address: '', password: await bcrypt.hash(pass, 10), team_id: 0, status: 'active', role: 'prince' });
    console.log('Bootstrap admin (role prince) created.');
  } catch (e) { if (e.code !== 11000) throw e; console.error('ADMIN_PHONE already belongs to a non-admin user; promote it manually.'); }
}

async function connectDB() {
  if (cache.ready) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, { bufferCommands: false, serverSelectionTimeoutMS: 8000, maxPoolSize: 5 })
      .then(async () => {
        try { await Promise.all(Object.values(M).map((m) => m.init())); } catch (e) { console.error('Index build warning:', e.message); }
        await bootstrapAdmin();
        cache.ready = true;
      })
      .catch((e) => { cache.promise = null; throw e; });
  }
  await cache.promise;
}

/* ------------------------------------------------------------------ */
/* Stateless signed-cookie session (works across serverless instances) */
/* ------------------------------------------------------------------ */
const SECRET = process.env.SESSION_SECRET || (IS_PROD ? null : crypto.randomBytes(32).toString('hex'));
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const newCsrf = () => crypto.randomBytes(32).toString('hex');
const mac = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const sign = (p) => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return body + '.' + mac(body); };
function unsign(tok) {
  try {
    const [body, sig] = String(tok).split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig); const b = Buffer.from(mac(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p !== 'object' || typeof p.csrf !== 'string' || Date.now() - p.iat > SESSION_TTL_MS) return null;
    return p;
  } catch (_) { return null; }
}
function readCookie(req, name) {
  const raw = req.headers.cookie; if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return null; } }
  }
  return null;
}
function setSid(res, value) {
  const parts = [`sid=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (IS_PROD) parts.push('Secure');
  if (value === '') parts.push('Max-Age=0');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function sessionMw(req, res, next) {
  if (!SECRET) { console.error('SESSION_SECRET is not set'); return res.status(500).type('text/plain').send('Server configuration error.'); }
  let p = unsign(readCookie(req, 'sid'));
  if (!p) { p = { uid: null, csrf: newCsrf(), iat: Date.now() }; setSid(res, sign(p)); }
  req.sess = p;
  next();
}
const login = (req, res, uid) => { req.sess = { uid, csrf: newCsrf(), iat: Date.now() }; setSid(res, sign(req.sess)); };
const logout = (req, res) => { setSid(res, ''); req.sess = { uid: null, csrf: newCsrf(), iat: Date.now() }; };
const csrfOk = (req) => {
  const t = Buffer.from(S(req.body && req.body.csrf_token)); const s = Buffer.from(req.sess.csrf);
  return t.length === s.length && crypto.timingSafeEqual(t, s);
};
// Current user, re-read from the DB on every request (like the PHP code). Banned/pending accounts are treated as logged out.
async function currentUser(req) {
  if (!req.sess || !req.sess.uid) return null;
  const u = await one(M.User, { id: req.sess.uid });
  return u && (u.status === 'active' || u.status === 'approved') ? u : null;
}

/* ------------------------------------------------------------------ */
/* Rate limiting (MongoDB-backed, so it works on serverless)           */
/* ------------------------------------------------------------------ */
async function isLimited(key, max) { const r = await M.RateLimit.findOne({ key, expireAt: { $gt: new Date() } }).lean(); return !!r && r.count >= max; }
async function hit(key, windowSec) {
  const t = new Date(); await M.RateLimit.deleteOne({ key, expireAt: { $lte: t } });
  const upd = { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(t.getTime() + windowSec * 1000) } };
  try { await M.RateLimit.updateOne({ key }, upd, { upsert: true }); } catch (e) { if (e.code !== 11000) throw e; await M.RateLimit.updateOne({ key }, { $inc: { count: 1 } }); }
}
const clearHits = (key) => M.RateLimit.deleteOne({ key });

/* ------------------------------------------------------------------ */
/* Uploads (images only, ≤5MB, stored in MongoDB)                      */
/* ------------------------------------------------------------------ */
const SIGS = [
  ['jpg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['png', (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a],
  ['gif', (b) => b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))],
  ['webp', (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
async function uploadFile(file) { // returns "uploads/<random>.<ext>" or null (same contract as PHP uploadFile)
  if (!file || !file.buffer || !file.size) return null;
  const hit_ = SIGS.find(([, test]) => test(file.buffer));
  if (!hit_) return null;
  const name = crypto.randomBytes(16).toString('hex') + '.' + hit_[0];
  await M.File.create({ name, mime: MIME[hit_[0]], data: file.buffer });
  return 'uploads/' + name;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 60, fieldSize: 200 * 1024 } }).any();
const fileOf = (req, field) => (req.files || []).find((f) => f.fieldname === field) || null;

/* ------------------------------------------------------------------ */
/* Express app + shared middleware                                     */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (IS_PROD && req.headers['x-forwarded-proto'] === 'http') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl); // .htaccess HTTPS force
  res.set({ 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  // .htaccess "common attack" query-string blocks
  const qs = req.originalUrl.split('?')[1] || '';
  let dec = qs; try { dec = decodeURIComponent(qs); } catch (_) { /* keep raw */ }
  const bad = [/base64_encode[^(]*\([^)]*\)/i, /(<|%3C)[\s\S]{0,100}script[\s\S]{0,100}(>|%3E)/i, /GLOBALS(=|\[|%[0-9A-Z]{0,2})/, /_REQUEST(=|\[|%[0-9A-Z]{0,2})/];
  if (qs && bad.some((r) => r.test(qs) || r.test(dec))) return res.status(403).type('text/plain').send('Forbidden');
  next();
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send(
  'User-agent: *\nDisallow: /prince.php\nDisallow: /leader.php\nDisallow: /api.php\nDisallow: /uploads/\nDisallow: /connection.php'));

// Uploaded images: DB first, then the bundled static file (original asset in /public/uploads).
app.get('/uploads/:name', async (req, res, next) => {
  if (!/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.params.name)) return next();
  try {
    await connectDB();
    const f = await M.File.findOne({ name: req.params.name }).lean();
    if (!f) return next();
    const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data.buffer);
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.send(buf);
  } catch (e) { next(e); }
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, dotfiles: 'ignore', maxAge: '30d' }));
app.get(/\.php$/, (req, res, next) => (['/index.php', '/team.php', '/leader.php', '/prince.php', '/api.php'].includes(req.path) ? next() : res.status(404).type('text/plain').send('Not found')));

app.use(async (req, res, next) => {
  try { await connectDB(); next(); } catch (e) {
    console.error('Database Connection Failed:', e.message);
    res.status(503);
    if (req.path === '/api.php') return res.json({ status: 'error', message: 'Database connection error. Please try again later.' });
    res.type('text/plain').send('Database connection error. Please try again later.');
  }
});
app.use(sessionMw);
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

const core = {
  M, S, I, h, clean, stripTags, fmtDate, jsonForScript, attrJson, scriptBody, escapeRx, byteLen, sleep,
  find, one, insert, nextId, resetCounters, bcrypt, uploadFile, upload, fileOf, csrfOk, currentUser, login, logout,
  isLimited, hit, clearHits, IS_PROD,
};

/* ------------------------------------------------------------------ */
/* Home page (index.php)                                               */
/* ------------------------------------------------------------------ */
const PLACEHOLDER40 = 'https://via.placeholder.com/40';

const INDEX_CSS = `
        :root { --primary: #008080; --bg: #f0f2f5; --white: #ffffff; }
        body { font-family: 'Hind Siliguri', sans-serif; background-color: var(--bg); padding-bottom: 70px; -webkit-tap-highlight-color: transparent; }
        .app-header { background: var(--white); padding: 10px 15px; position: sticky; top: 0; z-index: 1000; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: space-between; }
        .app-title { color: var(--primary); font-weight: 800; font-size: 1.2rem; }
        .search-box { background: #f0f2f5; border-radius: 20px; border: none; padding: 5px 15px; font-size: 0.9rem; width: 100%; margin: 0 10px; }
        .post-card { background: var(--white); border-radius: 12px; margin-bottom: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); overflow: hidden; border: 1px solid #eef0f3; }
        .post-header { padding: 12px; display: flex; align-items: center; }
        .user-pic { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid #eee; margin-right: 10px; }
        .post-content { padding: 0 12px 12px; font-size: 15px; color: #1c1e21; white-space: pre-wrap; }
        .post-img { width: 100%; display: block; max-height: 500px; object-fit: cover; background: #f0f2f5; cursor: pointer; }
        .post-actions { display: flex; border-top: 1px solid #f0f2f5; }
        .action-btn { flex: 1; background: none; border: none; padding: 10px; color: #65676b; font-size: 14px; font-weight: 600; transition: 0.2s; }
        .action-btn:active { background: #f2f2f2; }
        .action-btn.liked { color: var(--primary); }
        .member-card { background: white; padding: 10px; border-radius: 12px; margin-bottom: 10px; display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .chat-bubble { max-width: 80%; padding: 8px 12px; border-radius: 15px; margin-bottom: 8px; font-size: 0.9rem; }
        .chat-me { background: var(--primary); color: white; margin-left: auto; border-bottom-right-radius: 2px; }
        .chat-other { background: #e4e6eb; color: black; margin-right: auto; border-bottom-left-radius: 2px; }
        .bottom-nav { position: fixed; bottom: 0; width: 100%; background: var(--white); border-top: 1px solid #ddd; display: flex; justify-content: space-around; padding: 8px 0; z-index: 1020; }
        .nav-item { color: #65676b; text-align: center; text-decoration: none; font-size: 0.7rem; flex: 1; }
        .nav-item i { font-size: 1.3rem; display: block; margin-bottom: 2px; }
        .nav-item.active { color: var(--primary); }
        .menu-grid .card { transition: 0.2s; cursor: pointer; }
        .menu-grid .card:active { transform: scale(0.98); }
        .loading-spinner { text-align: center; padding: 20px; color: var(--primary); display: none; }
        a { text-decoration: none; }
    `;

/* Client-side app. Written as a real function so it is syntax-checked; its body is sent to the browser as a classic script. */
function clientIndex() {
  /* global $, CSRF_TOKEN, MY_ID, CURRENT_USER, PROFILE_PIC */
  let chatInterval = null;
  let myId = MY_ID;

  $(document).ready(function() {
    loadPage('home');
    $('#searchBar').on('keyup', function(){
      let q = $(this).val();
      if($('.nav-item.active').text().includes('হোম')) loadFeed(q);
      if($('#memberList').length) searchMember(q);
    });
  });

  // --- VIEW IMAGE FUNCTION ---
  function viewImage(src) {
    if(src && src !== 'null') {
      $('#fullSizeImage').attr('src', src);
      $('#imgViewerModal').modal('show');
    }
  }

  function loadPage(page) {
    clearInterval(chatInterval);
    $('.nav-item').removeClass('active');
    if(page=='home') $('.nav-item:eq(0)').addClass('active');
    if(page=='chat') $('.nav-item:eq(1)').addClass('active');
    if(page=='missions') $('.nav-item:eq(2)').addClass('active');
    if(page=='menu') $('.nav-item:eq(3)').addClass('active');

    $('#contentArea').html('');

    if(page === 'home') {
      $('#contentArea').html(`
                <div class="card p-3 mb-2 border-0 shadow-sm d-flex flex-row gap-2 align-items-center" style="border-radius:12px" onclick="$('#postModal').modal('show')">
                    <img src="${PROFILE_PIC}" class="user-pic m-0">
                    <div class="bg-light rounded-pill px-3 py-2 flex-grow-1 text-muted">মনের কথা শেয়ার করুন...</div>
                    <i class="fas fa-image text-success fs-4"></i>
                </div>
                <div id="feed"></div>
            `);
      loadFeed();
    }
    else if(page === 'chat') loadChatView();
    else if(page === 'missions') loadMissions();
    else if(page === 'menu') loadMenu();
    else if(page === 'members') loadAllMembers();
    else if(page === 'profile') loadProfile();
    else if(page === 'notices') loadNotices();
    else if(page === 'blood') loadBloodPage();
    else if(page === 'votes') loadVotes();
    else if(page === 'rules') loadRules();
  }

  // --- HOME ---
  function loadFeed(q='') {
    $('.loading-spinner').show();
    $.post('api.php', {action: 'load_feed', scope: 'global', search: q, csrf_token: CSRF_TOKEN}, function(res){
      $('.loading-spinner').hide();
      let html = '';
      if(!res.data || res.data.length === 0) { $('#feed').html('<div class="text-center text-muted mt-5">কোনো পোস্ট নেই</div>'); return; }
      res.data.forEach(item => {
        if(item.type === 'post') {
          let leaderIcon = item.is_leader > 0 ? '<i class="fas fa-crown text-warning small ms-1" title="Leader"></i>' : '';
          let isLiked = item.is_liked > 0 ? 'liked' : '';
          let deleteBtn = (item.user_id == res.my_id) ? `<div class="dropdown ms-auto"><button class="btn btn-sm btn-light rounded-circle" data-bs-toggle="dropdown"><i class="fas fa-ellipsis-v"></i></button><ul class="dropdown-menu"><li><a class="dropdown-item text-danger" href="#" onclick="deletePost(${item.id})">Delete</a></li></ul></div>` : '';
          html += `<div class="post-card"><div class="post-header"><img src="${item.profile_pic || 'https://via.placeholder.com/40'}" class="user-pic"><div class="d-flex flex-column"><span class="fw-bold text-dark">${item.name} ${leaderIcon}</span><small class="text-muted" style="font-size:11px">${item.team_name || 'Global'} • ${item.created_at}</small></div>${deleteBtn}</div><div class="post-content">${item.content}</div>${item.image ? `<img src="${item.image}" class="post-img" onclick="viewImage(this.src)">` : ''}<div class="post-actions"><button class="action-btn ${isLiked}" onclick="likePost(this, ${item.id})"><i class="fas fa-thumbs-up"></i> <span class="cnt">${item.like_count}</span></button><button class="action-btn" onclick="toggleC(${item.id})"><i class="fas fa-comment"></i> ${item.comment_count}</button><button class="action-btn" onclick="alert('Link copied!')"><i class="fas fa-share"></i></button></div><div id="c-box-${item.id}" style="display:none;" class="bg-light p-2"><div class="input-group mb-2"><input type="text" id="c-in-${item.id}" class="form-control form-control-sm rounded-pill" placeholder="লিখুন..."><button class="btn btn-primary btn-sm rounded-circle ms-1" onclick="postC(${item.id})"><i class="fas fa-paper-plane"></i></button></div><div class="c-list small"></div></div></div>`;
        }
      });
      $('#feed').html(html);
    }, 'json');
  }
  function submitPost() { let fd = new FormData($('#createPostForm')[0]); $.ajax({ url: 'api.php', type: 'POST', data: fd, contentType: false, processData: false, success: function(res) { if(res.status == 'success') { $('#postModal').modal('hide'); $('#createPostForm')[0].reset(); loadFeed(); } else { alert(res.message || 'Error posting'); } } }); }
  function deletePost(pid) { if(confirm('পোস্টটি মুছে ফেলতে চান?')) { $.post('api.php', {action: 'delete_post', post_id: pid, csrf_token: CSRF_TOKEN}, function(res){ if(res.status === 'success') { if($('.nav-item:eq(0)').hasClass('active')) loadFeed(); else loadProfile(); } }, 'json'); } }
  function likePost(btn, pid) { $.post('api.php', {action:'like_post', post_id:pid, csrf_token: CSRF_TOKEN}, function(r){ $(btn).find('.cnt').text(r.count); r.liked?$(btn).addClass('liked'):$(btn).removeClass('liked'); }, 'json'); }
  function toggleC(pid) { $(`#c-box-${pid}`).slideToggle(); if($(`#c-box-${pid}`).is(':visible')) { $.post('api.php', {action:'load_comments', post_id:pid, csrf_token: CSRF_TOKEN}, function(r){ let h=''; r.data.forEach(c=>h+=`<div class="d-flex gap-2 mt-2"><img src="${c.profile_pic||'https://via.placeholder.com/20'}" width="20" height="20" class="rounded-circle"><div class="bg-white p-1 px-2 rounded flex-grow-1 border"><strong>${c.name}</strong> ${c.comment}</div></div>`); $(`#c-box-${pid} .c-list`).html(h); }, 'json'); } }
  function postC(pid) { let t=$(`#c-in-${pid}`).val(); if(!t)return; $.post('api.php', {action:'comment_post', post_id:pid, comment:t, csrf_token: CSRF_TOKEN}, function(r){ $(`#c-box-${pid} .c-list`).append(`<div class="d-flex gap-2 mt-2"><img src="${r.pic||'https://via.placeholder.com/20'}" width="20" height="20" class="rounded-circle"><div class="bg-white p-1 px-2 rounded flex-grow-1 border"><strong>${r.user}</strong> ${r.comment}</div></div>`); $(`#c-in-${pid}`).val(''); }, 'json'); }

  // --- MEMBER LIST ---
  function loadAllMembers() { $('#contentArea').html('<input type="text" class="form-control mb-3 rounded-pill" placeholder="সদস্য খুঁজুন..." onkeyup="searchMember(this.value)"><div id="memberList"></div>'); searchMember(''); }
  function searchMember(q) {
    $.post('api.php', {action: 'search_members', query: q, csrf_token: CSRF_TOKEN}, function(res){
      let html = '';
      res.data.forEach(u => {
        html += `
                <div class="member-card">
                    <img src="${u.profile_pic||'https://via.placeholder.com/50'}" 
                         onclick="viewImage(this.src)"
                         style="width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #ddd;cursor:pointer">
                    <div class="flex-grow-1">
                        <div class="fw-bold">${u.name}</div>
                        <div class="small text-muted"><i class="fas fa-shield-alt text-info"></i> ${u.tname||'No Team'}</div>
                        <div class="small text-secondary"><i class="fas fa-map-marker-alt text-danger"></i> ${u.address}</div>
                    </div>
                    <div class="text-end"><span class="badge bg-primary rounded-pill">PL: ${u.power_level}</span></div>
                </div>`;
      });
      $('#memberList').html(html);
    }, 'json');
  }

  // --- MENU ---
  function loadMenu() { $('#contentArea').html(`<div class="row g-3 menu-grid"><div class="col-6"><a href="team.php" class="text-decoration-none text-dark"><div class="card p-3 text-center h-100 shadow-sm border-0"><i class="fas fa-users text-primary fs-1 mb-2"></i><div class="fw-bold">আমার টিম</div></div></a></div><div class="col-6"><div class="card p-3 text-center h-100 shadow-sm border-0" onclick="loadPage('members')"><i class="fas fa-globe text-info fs-1 mb-2"></i><div class="fw-bold">সকল সদস্য</div></div></div><div class="col-6"><div class="card p-3 text-center h-100 shadow-sm border-0" onclick="loadPage('blood')"><i class="fas fa-tint text-danger fs-1 mb-2"></i><div class="fw-bold">রক্তদান</div></div></div><div class="col-6"><div class="card p-3 text-center h-100 shadow-sm border-0" onclick="loadPage('votes')"><i class="fas fa-poll text-warning fs-1 mb-2"></i><div class="fw-bold">ভোটিং</div></div></div><div class="col-6"><div class="card p-3 text-center h-100 shadow-sm border-0" onclick="loadPage('rules')"><i class="fas fa-book text-secondary fs-1 mb-2"></i><div class="fw-bold">রুলস</div></div></div><div class="col-6"><div class="card p-3 text-center h-100 shadow-sm border-0" onclick="loadPage('notices')"><i class="fas fa-bell text-success fs-1 mb-2"></i><div class="fw-bold">নোটিশ</div></div></div><div class="col-12"><a href="?logout=true" class="btn btn-outline-danger w-100">লগআউট</a></div></div>`); }

  // --- CHAT ---
  function loadChatView() { $('#contentArea').html(`<div class="bg-white sticky-top py-2 mb-2 d-flex justify-content-center gap-2 border-bottom"><button class="btn btn-sm btn-primary rounded-pill px-4" disabled>গ্লোবাল চ্যাট</button></div><div id="chatBox" class="d-flex flex-column pb-5" style="min-height:70vh"></div><div class="fixed-bottom bg-white p-2 border-top d-flex gap-2" style="bottom:60px; max-width:600px; margin:0 auto;"><input type="text" id="msgIn" class="form-control rounded-pill" placeholder="মেসেজ লিখুন..."><button class="btn btn-primary rounded-circle" onclick="sendMsg()"><i class="fas fa-paper-plane"></i></button></div>`); fetchChat(); chatInterval = setInterval(fetchChat, 2000); }
  function fetchChat() { $.post('api.php', {action: 'load_chat', type: 'global', csrf_token: CSRF_TOKEN}, function(res){ let html = ''; res.data.forEach(c => { let isMe = (c.user_id == res.uid); html += `<div class="d-flex flex-column ${isMe?'align-items-end':'align-items-start'}">${!isMe ? `<small class="ms-1 text-muted" style="font-size:10px">${c.name}</small>` : ''}<div class="chat-bubble ${isMe?'chat-me':'chat-other'}">${c.message}</div></div>`; }); $('#chatBox').html(html); }, 'json'); }
  function sendMsg() { let m = $('#msgIn').val(); if(!m) return; $('#msgIn').val(''); $.post('api.php', {action: 'send_chat', type: 'global', message: m, csrf_token: CSRF_TOKEN}, function(){ fetchChat(); }); }

  // --- POLLS ---
  function loadVotes() { $.post('api.php', {action: 'load_polls', csrf_token: CSRF_TOKEN}, function(res){ let html = '<h5 class="mb-3 ps-2 fw-bold text-primary"><i class="fas fa-poll"></i> ভোটিং পোল</h5>'; if(res.data.length === 0) { html += '<div class="text-center text-muted mt-5"><i class="fas fa-box-open fa-2x mb-2"></i><br>বর্তমানে কোনো পোল চালু নেই</div>'; } res.data.forEach(p => { html += `<div class="card p-3 mb-3 shadow-sm border-0" style="border-radius:12px"><h6 class="fw-bold mb-3 text-dark">${p.title}</h6>`; p.options.forEach(o => { let pct = p.total_votes > 0 ? Math.round((o.votes / p.total_votes)*100) : 0; let isSelected = (p.my_vote == o.id); let bgClass = isSelected ? 'border-primary' : 'border-0'; html += `<div class="mb-2 position-relative rounded overflow-hidden border ${bgClass}" onclick="submitVote(${p.id}, ${o.id})" style="cursor:pointer; height:45px;"><div style="position:absolute; top:0; left:0; height:100%; width:${pct}%; background:#e7f1ff; z-index:0; transition: width 0.5s;"></div><div class="d-flex justify-content-between align-items-center px-3 h-100 position-relative z-1"><span class="fw-bold small text-dark">${o.option_text} ${isSelected ? '<i class="fas fa-check-circle text-primary ms-1"></i>' : ''}</span><span class="small fw-bold text-secondary">${pct}%</span></div></div>`; }); html += `<div class="d-flex justify-content-between align-items-center mt-2"><small class="text-muted"><i class="fas fa-vote-yea"></i> মোট ভোট: ${p.total_votes}</small><small class="text-secondary">#${p.id}</small></div></div>`; }); $('#contentArea').html(html); }, 'json'); }
  function submitVote(pid, oid) { $.post('api.php', {action: 'submit_vote', poll_id: pid, option_id: oid, csrf_token: CSRF_TOKEN}, function(res){ if(res.status=='success') loadVotes(); else alert(res.message); }, 'json'); }
  function loadMissions() { $.post('api.php', {action: 'load_missions', csrf_token: CSRF_TOKEN}, function(res){ let html = '<h5 class="mb-3 ps-2">গ্লোবাল মিশন</h5>'; if(res.missions.length === 0) html += '<p class="text-center text-muted">কোনো মিশন নেই</p>'; res.missions.forEach(m => html += `<div class="card p-3 mb-2 border-start border-4 border-success shadow-sm"><div class="d-flex gap-2">${m.image?`<img src="${m.image}" width="60" class="rounded">`:''}<div><h6 class="fw-bold m-0">${m.title}</h6><small class="text-muted">${m.description}</small><br><span class="badge bg-success mt-1">+${m.points_reward} PL</span></div></div></div>`); $('#contentArea').html(html); }, 'json'); }

  // --- PROFILE ---
  function loadProfile() {
    let u = CURRENT_USER;
    let idStatus = u.id_card_status;
    let badge = (idStatus==='approved') ? '<i class="fas fa-check-circle text-primary" title="Verified"></i>' : '';

    $('#contentArea').html(`
            <div class="bg-white p-4 text-center rounded shadow-sm mb-3">
                <div class="position-relative d-inline-block">
                    <img src="${u.profile_pic || 'https://via.placeholder.com/100'}" 
                         onclick="viewImage(this.src)"
                         class="rounded-circle border" 
                         style="width:100px;height:100px;object-fit:cover;cursor:pointer">
                    <label class="position-absolute bottom-0 end-0 bg-light rounded-circle p-1 border shadow-sm" style="cursor:pointer">
                        <i class="fas fa-camera text-primary"></i>
                        <form id="picForm" style="display:none"><input type="hidden" name="csrf_token" value="${CSRF_TOKEN}"><input type="file" name="pic" onchange="upPic(this)"></form>
                    </label>
                </div>
                <h4 class="mt-2 fw-bold">${u.name} ${badge}</h4>
                <p class="text-muted small">${u.phone} | Power: ${u.power_level}</p>
                <p class="text-muted small"><i class="fas fa-map-marker-alt"></i> ${u.address}</p>

                <div class="border rounded p-3 mt-3 text-start">
                    <h6><i class="fas fa-id-card"></i> আইডি ভেরিফিকেশন</h6>
                    ${idStatus === 'approved' ? '<div class="alert alert-success py-1 small">ভেরিফাইড মেম্বার</div>' : idStatus === 'pending' ? '<div class="alert alert-warning py-1 small">রিভিউ চলছে...</div>' : `<form id="idForm"><input type="hidden" name="csrf_token" value="${CSRF_TOKEN}"><input type="file" name="id_card" class="form-control form-control-sm mb-2" accept="image/*" required><button type="button" class="btn btn-sm btn-primary" onclick="upID()">আইডি কার্ড জমা দিন</button></form>`}
                </div>

                <div class="border rounded p-3 mt-3 text-start">
                    <h6><i class="fas fa-key"></i> পাসওয়ার্ড পরিবর্তন</h6>
                    <form id="passForm">
                        <input type="hidden" name="csrf_token" value="${CSRF_TOKEN}">
                        <input type="hidden" name="action" value="change_password">
                        <input type="password" name="old_password" class="form-control form-control-sm mb-2" placeholder="পুরাতন পাসওয়ার্ড" required>
                        <input type="password" name="new_password" class="form-control form-control-sm mb-2" placeholder="নতুন পাসওয়ার্ড (১০+ অক্ষর)" required>
                        <button type="button" class="btn btn-sm btn-dark w-100" onclick="updatePass()">আপডেট করুন</button>
                    </form>
                </div>
            </div>
            <h6 class="ps-2">আমার পোস্টসমূহ</h6>
            <div id="myPostsFeed" class="pb-5">Loading...</div>
        `);

    // Load User Specific Feed
    $.post('api.php', {action: 'load_feed', profile_id: u.id, csrf_token: CSRF_TOKEN}, function(res){
      let h = '';
      if(res.data && res.data.length > 0) {
        res.data.forEach(item => {
          if(item.type == 'post') {
            h += `<div class="post-card">
                            <div class="post-header">
                                <img src="${item.profile_pic || 'https://via.placeholder.com/40'}" class="user-pic">
                                <div class="d-flex flex-column"><span class="fw-bold text-dark">${item.name}</span><small class="text-muted">${item.created_at}</small></div>
                                <div class="dropdown ms-auto"><button class="btn btn-sm btn-light rounded-circle" data-bs-toggle="dropdown"><i class="fas fa-ellipsis-v"></i></button><ul class="dropdown-menu"><li><a class="dropdown-item text-danger" href="#" onclick="deletePost(${item.id})">Delete</a></li></ul></div>
                            </div>
                            <div class="post-content">${item.content}</div>
                            ${item.image ? `<img src="${item.image}" class="post-img" onclick="viewImage(this.src)">` : ''}
                            <div class="post-actions p-2 text-muted small"><i class="fas fa-thumbs-up"></i> ${item.like_count} Likes</div>
                        </div>`;
          }
        });
      }
      $('#myPostsFeed').html(h || '<p class="text-muted small ps-2 text-center py-3">আপনি এখনো কোনো পোস্ট করেননি।</p>');
    }, 'json');
  }

  function upPic(input) { let fd = new FormData($('#picForm')[0]); fd.append('action', 'upload_profile_pic'); $.ajax({ url:'api.php', type:'POST', data:fd, contentType:false, processData:false, success: function(){ location.reload(); } }); }
  function upID() { let fd = new FormData($('#idForm')[0]); fd.append('action', 'submit_id_card'); $.ajax({ url:'api.php', type:'POST', data:fd, contentType:false, processData:false, success: function(){ loadProfile(); } }); }

  function updatePass() {
    $.post('api.php', $('#passForm').serialize(), function(res) {
      alert(res.message);
      if(res.status === 'success') $('#passForm')[0].reset();
    }, 'json');
  }

  // --- OTHER ---
  function loadBloodPage() { $('#contentArea').html(`<div class="card bg-danger text-white text-center p-4 mb-3 border-0 shadow"><h3>রক্তদান করুন</h3><div class="d-flex gap-2 justify-content-center mt-3"><button class="btn btn-light text-danger fw-bold" onclick="$('#bReq').slideToggle()">রক্ত প্রয়োজন</button></div></div><div id="bReq" class="card p-3 mb-3 shadow-sm border-danger" style="display:none"><select id="bg" class="form-select mb-2"><option>A+</option><option>B+</option><option>O+</option><option>AB+</option></select><input id="bl" class="form-control mb-2" placeholder="লোকেশন"><input id="bc" class="form-control mb-2" placeholder="যোগাযোগ নম্বর"><button class="btn btn-danger w-100" onclick="subBlood()">সাবমিট</button></div><h6>সাম্প্রতিক আবেদন</h6><div id="bList"></div>`); $.post('api.php', {action: 'load_blood_reqs', csrf_token: CSRF_TOKEN}, function(res){ let html = ''; res.data.forEach(b => html+=`<div class="card p-2 mb-2 border-start border-4 border-danger"><div class="d-flex justify-content-between"><strong>${b.blood_group} Needed</strong><small>${b.created_at}</small></div><small>${b.location}</small><a href="tel:${b.contact}" class="btn btn-sm btn-outline-danger w-100 mt-1">কল করুন</a></div>`); $('#bList').html(html); }, 'json'); }
  function subBlood() { $.post('api.php', {action: 'request_blood', group:$('#bg').val(), location:$('#bl').val(), contact:$('#bc').val(), details:'', csrf_token: CSRF_TOKEN}, function(){ alert('Submitted'); loadBloodPage(); }, 'json'); }
  function loadNotices() { $.post('api.php', {action:'load_notices', csrf_token: CSRF_TOKEN}, function(r){ let h='<h5>নোটিশ বোর্ড</h5>'; r.data.forEach(n=>h+=`<div class="card p-3 mb-2 border-start border-4 border-info"><h6>${n.title}</h6><p class="small mb-0">${n.message}</p></div>`); $('#contentArea').html(h||'<p class="text-center">কোনো নোটিশ নেই</p>'); }, 'json'); }
  function loadRules() { $.post('api.php', {action: 'load_rules', csrf_token: CSRF_TOKEN}, function(res){ let html = '<h4 class="mb-3 text-danger ps-2"><i class="fas fa-shield-alt"></i> গ্রুপের নিয়মাবলী</h4><ul class="list-group">'; res.data.forEach((r, i) => html += `<li class="list-group-item">${i+1}. ${r.content}</li>`); $('#contentArea').html(html+'</ul>'); }, 'json'); }
}

function indexHtml({ csrf, user, error, success }) {
  const head = `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Saiyan - তরুণ প্রজন্ম</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>const CSRF_TOKEN = '${csrf}';</script>

    <style>${INDEX_CSS}</style>
</head>
<body>
`;
  if (!user) {
    return head + `
    <!-- === LOGIN VIEW === -->
    <div class="d-flex flex-column justify-content-center align-items-center vh-100 bg-white p-4">
        <h1 class="fw-bold display-4 mb-2" style="color:var(--primary)">SAIYAN</h1>
        <p class="text-muted mb-4 fs-5">তরুণ প্রজন্মের শক্তি</p>
        ${error ? `<div class="alert alert-danger w-100 text-center" style="max-width:350px">${h(error)}</div>` : ''}
        ${success ? `<div class="alert alert-success w-100 text-center" style="max-width:350px">${h(success)}</div>` : ''}

        <!-- Login Form -->
        <form method="POST" id="loginForm" class="w-100" style="max-width:350px">
            <input type="hidden" name="csrf_token" value="${csrf}">
            <input type="hidden" name="auth_action" value="login">
            <div class="form-floating mb-3">
                <input type="text" name="phone" class="form-control" id="floatingInput" placeholder="017..." required>
                <label for="floatingInput">মোবাইল নম্বর</label>
            </div>
            <div class="form-floating mb-3">
                <input type="password" name="password" class="form-control" id="floatingPassword" placeholder="Password" required>
                <label for="floatingPassword">পাসওয়ার্ড</label>
            </div>
            <button class="btn btn-primary w-100 py-2 fs-5 rounded-pill" style="background:var(--primary); border:none">লগইন করুন</button>
            <p class="text-center mt-3">অ্যাকাউন্ট নেই? <a href="#" onclick="$('#loginForm').hide();$('#regForm').fadeIn()" class="fw-bold" style="color:var(--primary)">নিবন্ধন করুন</a></p>
        </form>

        <!-- Register Form -->
        <form method="POST" id="regForm" class="w-100" style="max-width:350px; display:none">
            <h4 class="text-center mb-3 text-secondary">নতুন অ্যাকাউন্ট</h4>
            <input type="hidden" name="csrf_token" value="${csrf}">
            <input type="hidden" name="auth_action" value="register">
            <input type="text" name="website" style="display:none !important" tabindex="-1" autocomplete="off">
            <input type="text" name="name" class="form-control mb-2" placeholder="আপনার নাম" required>
            <input type="text" name="phone" class="form-control mb-2" placeholder="মোবাইল নম্বর (১১ ডিজিট)" pattern="[0-9]{11}" required>
            <textarea name="address" class="form-control mb-2" placeholder="পূর্ণ ঠিকানা" required></textarea>
            <input type="password" name="password" class="form-control mb-3" placeholder="নতুন পাসওয়ার্ড (কমপক্ষে ১০ অক্ষর)" required>
            <button class="btn btn-primary w-100 py-2 fs-5 rounded-pill" style="background:var(--primary); border:none">জমা দিন</button>
            <p class="text-center mt-3">আগেই অ্যাকাউন্ট আছে? <a href="#" onclick="$('#regForm').hide();$('#loginForm').fadeIn()" class="fw-bold" style="color:var(--primary)">লগইন করুন</a></p>
        </form>
    </div>
</body>
</html>`;
  }
  const pic = user.profile_pic ?? PLACEHOLDER40;
  const publicUser = clean({ id: user.id, name: user.name, phone: user.phone, address: user.address, power_level: user.power_level, profile_pic: user.profile_pic, id_card_status: user.id_card_status, team_id: user.team_id });
  return head + `
    <!-- === MAIN APP === -->
    <div class="app-header">
        <div class="app-title">Saiyan</div>
        <input type="text" id="searchBar" class="search-box" placeholder="খুঁজুন...">
        <a href="#" onclick="loadPage('profile')">
            <img src="${h(pic)}" class="user-pic m-0" style="border: 2px solid var(--primary)">
        </a>
    </div>

    <div class="container px-0 pt-2" style="max-width: 600px;">
        <div id="contentArea" class="px-2 pb-5"></div>
        <div class="loading-spinner"><i class="fas fa-spinner fa-spin fa-2x"></i></div>
    </div>

    <!-- Create Post Modal -->
    <div class="modal fade" id="postModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-header border-0"><h6 class="modal-title">পোস্ট তৈরি করুন</h6><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
                <div class="modal-body">
                    <form id="createPostForm" enctype="multipart/form-data">
                        <input type="hidden" name="csrf_token" value="${csrf}">
                        <input type="hidden" name="action" value="create_post">
                        <input type="hidden" name="scope" value="global">
                        <textarea name="content" class="form-control border-0 fs-5 mb-3" placeholder="কি ভাবছেন?" style="min-height:100px" required></textarea>
                        <input type="file" name="image" class="form-control form-control-sm mb-3" accept="image/*">
                        <button type="button" class="btn btn-primary w-100 rounded-pill" style="background:var(--primary); border:none" onclick="submitPost()">পোস্ট করুন</button>
                    </form>
                </div>
            </div>
        </div>
    </div>

    <!-- Image Viewer Modal -->
    <div class="modal fade" id="imgViewerModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content bg-transparent border-0">
                <div class="modal-body text-center p-0">
                    <button type="button" class="btn-close btn-close-white position-absolute top-0 end-0 m-2" data-bs-dismiss="modal"></button>
                    <img src="" id="fullSizeImage" class="img-fluid rounded shadow-lg" style="max-height: 80vh;">
                </div>
            </div>
        </div>
    </div>

    <div class="bottom-nav">
        <a href="#" class="nav-item active" onclick="loadPage('home')"><i class="fas fa-home"></i>হোম</a>
        <a href="#" class="nav-item" onclick="loadPage('chat')"><i class="fas fa-comments"></i>চ্যাট</a>
        <a href="#" class="nav-item" onclick="loadPage('missions')"><i class="fas fa-bullseye"></i>মিশন</a>
        <a href="#" class="nav-item" onclick="loadPage('menu')"><i class="fas fa-th-large"></i>মেনু</a>
    </div>

    <script>
    const MY_ID = ${Number(user.id)};
    const CURRENT_USER = ${jsonForScript(publicUser)};
    const PROFILE_PIC = ${jsonForScript(h(pic))};
    ${scriptBody(clientIndex)}
    </script>
</body>
</html>`;
}

app.all(['/', '/index.php'], async (req, res) => {
  let error; let success;
  const body = req.body || {};

  // --- AUTH LOGIC ---
  if (req.method === 'POST' && typeof body.auth_action === 'string') {
    if (!csrfOk(req)) return res.status(403).type('text/plain').send('Security Error: Invalid CSRF Token.');

    if (body.auth_action === 'login') {
      const phone = S(body.phone).trim(); const password = S(body.password);
      const kIp = 'login-ip:' + req.ip; const kPh = 'login-ph:' + phone.slice(0, 30);
      if (await isLimited(kIp, 30) || await isLimited(kPh, 10)) {
        error = 'অনেকবার ভুল চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';
      } else {
        const user = phone ? await one(M.User, { phone }) : null;
        if (user && await bcrypt.compare(password, user.password)) {
          if (user.status === 'active' || user.status === 'approved') {
            await clearHits(kPh);
            login(req, res, user.id);
            return res.redirect(user.role === 'prince' ? '/prince.php' : '/index.php');
          } else if (user.status === 'pending') error = 'আপনার অ্যাকাউন্টটি অনুমোদনের অপেক্ষায় আছে।';
          else error = 'আপনার অ্যাকাউন্টটি ব্যান করা হয়েছে।';
        } else {
          await Promise.all([hit(kIp, 900), hit(kPh, 900), sleep(1000)]);
          error = 'ভুল মোবাইল নম্বর বা পাসওয়ার্ড!';
        }
      }
    } else if (body.auth_action === 'register') {
      if (S(body.website)) return res.type('text/plain').send('Error'); // honeypot
      try {
        const phone = S(body.phone).trim(); const name = S(body.name).trim(); const address = S(body.address).trim(); const pass = S(body.password);
        if (await isLimited('reg-ip:' + req.ip, 10)) error = 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';
        else if (byteLen(pass) < 10) error = 'পাসওয়ার্ড অবশ্যই কমপক্ষে ১০ অক্ষরের হতে হবে!';
        else if (!/^[0-9]{11}$/.test(phone)) error = 'মোবাইল নম্বর অবশ্যই ১১ ডিজিটের হতে হবে!';
        else if (!name || !address || name.length > 200 || address.length > 1000) error = 'নাম ও ঠিকানা সঠিকভাবে দিন।';
        else if (await M.User.exists({ phone })) error = 'এই নম্বরটি আগেই নিবন্ধিত হয়েছে।';
        else {
          await insert(M.User, { name, phone, address, password: await bcrypt.hash(pass, 10), team_id: 0, status: 'pending' });
          await hit('reg-ip:' + req.ip, 3600);
          success = 'নিবন্ধন সফল! এডমিন এপ্রুভালের জন্য অপেক্ষা করুন।';
        }
      } catch (e) {
        if (e.code === 11000) error = 'এই নম্বরটি আগেই নিবন্ধিত হয়েছে।';
        else { console.error(e); error = 'ত্রুটি হয়েছে। আবার চেষ্টা করুন।'; }
      }
    }
  }

  // LOGOUT
  if (req.query.logout !== undefined) { logout(req, res); return res.redirect('/index.php'); }

  // USER DATA CHECK
  let user = null;
  if (req.sess.uid) {
    user = await currentUser(req);
    if (!user) { logout(req, res); return res.redirect('/index.php'); }
  }
  res.type('html').send(indexHtml({ csrf: req.sess.csrf, user, error, success }));
});

/* ------------------------------------------------------------------ */
/* Mount the other modules                                             */
/* ------------------------------------------------------------------ */
app.use(require('./api')(core));
app.use(require('./team')(core));
app.use(require('./leader')(core));
app.use(require('./admin')(core));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const api = req.path === '/api.php';
  if (err && err.code === 'LIMIT_FILE_SIZE') return api ? res.json({ status: 'error', message: 'File too large (max 5MB)' }) : res.status(413).type('text/plain').send('File too large (max 5MB)');
  if (err && err.name === 'MulterError') return api ? res.json({ status: 'error', message: 'Invalid upload' }) : res.status(400).type('text/plain').send('Invalid upload');
  console.error(err);
  if (res.headersSent) return;
  if (api) return res.status(500).json({ status: 'error', message: 'Server error' });
  res.status(500).type('text/plain').send('Something went wrong. Please try again later.');
});

module.exports = app;
module.exports.core = core; // exposed for tests

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Saiyan running on http://localhost:${port}`));
}
