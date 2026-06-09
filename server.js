'use strict';
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRES = process.env.TOKEN_EXPIRES || '8h';

// 固定后台密码（scrypt 加盐哈希；代码与配置中均无明文）。如需换密码，设置 ADMIN_PASS_HASH 覆盖。
const PASS_HASH = process.env.ADMIN_PASS_HASH ||
  'e0d61928011ee5ca290941018168f501:a24d1b1836f91a7b9e845e2627df3a44a1409016408d001c7d934cb1a0c7559ad46223a9beb9d126eb87a590acca1ee959d9e408b5ee1d95de4ff7fccb26025b';

if (!JWT_SECRET || JWT_SECRET.length < 16) { console.error('[fatal] 未设置足够强的 JWT_SECRET。'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('[fatal] 未设置 DATABASE_URL（Neon 数据库连接串）。'); process.exit(1); }

/* ---------- 云数据库（Neon Postgres，整份数据存为一行 JSON，永久持久化） ---------- */
const sql = neon(process.env.DATABASE_URL);
let data = { items: [], claims: [], reports: [], audit: [], seq: { audit: 0 } };
async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS kv (id INT PRIMARY KEY, doc JSONB NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, b64 TEXT NOT NULL)`;
  const rows = await sql`SELECT doc FROM kv WHERE id = 1`;
  if (rows.length) { const d = rows[0].doc; data = (typeof d === 'string') ? JSON.parse(d) : d; }
  else { await sql`INSERT INTO kv (id, doc) VALUES (1, ${JSON.stringify(data)}::jsonb)`; }
  for (const k of ['items', 'claims', 'reports', 'audit']) if (!Array.isArray(data[k])) data[k] = [];
  if (!data.seq) data.seq = { audit: 0 };
}
let saveChain = Promise.resolve();
function save() {
  saveChain = saveChain.then(() => sql`UPDATE kv SET doc = ${JSON.stringify(data)}::jsonb WHERE id = 1`).catch(e => console.error('[save]', e.message));
  return saveChain;
}

function verifyPassword(input) {
  const i = PASS_HASH.indexOf(':');
  if (i < 0) return false;
  const salt = Buffer.from(PASS_HASH.slice(0, i), 'hex');
  const key = Buffer.from(PASS_HASH.slice(i + 1), 'hex');
  let dk; try { dk = crypto.scryptSync(String(input), salt, key.length); } catch { return false; }
  return dk.length === key.length && crypto.timingSafeEqual(dk, key);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));   // 前端用了 CDN 字体/库与内联脚本，关闭 CSP 以免被拦
app.use(express.json({ limit: '25mb' }));   // 容纳含照片的提交与备份导入

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: '登录尝试过于频繁，请 15 分钟后再试' } });
const publicWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: '操作过于频繁，请稍后再试' } });

/* ---------- 工具 ---------- */
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(9).toString('base64url');
const pickupCode = () => { const L = 'ABCDEFGHJKMNPQRSTUVWXY'; let s = ''; for (let i = 0; i < 2; i++) s += L[crypto.randomInt(L.length)]; return s + '-' + crypto.randomInt(1000, 10000); };
function str(v, { required = false, max = 500 } = {}) { if (v == null) v = ''; v = String(v).trim(); if (required && !v) return { err: true }; if (v.length > max) v = v.slice(0, max); return { v }; }
function audit(action, detail) { data.audit.push({ id: ++data.seq.audit, action, detail: detail ?? null, created_at: now() }); if (data.audit.length > 1000) data.audit = data.audit.slice(-1000); }
const byNewest = (a, b) => (a.created_at < b.created_at ? 1 : -1);

/* ---------- 照片（存于独立 media 表，不进主数据，避免拖慢） ---------- */
const MAX_PHOTOS = 3;
async function storeMedia(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  if (Buffer.from(m[2], 'base64').length > 1024 * 1024) return null; // 单图上限 ~1MB
  const id = newId();
  await sql`INSERT INTO media (id, b64) VALUES (${id}, ${dataUrl})`;
  return id;
}
async function storePhotos(arr) {
  const out = [];
  if (Array.isArray(arr)) for (const d of arr.slice(0, MAX_PHOTOS)) { const id = await storeMedia(d); if (id) out.push(id); }
  return out;
}
async function deleteMedia(ids) {
  if (Array.isArray(ids)) for (const id of ids) { try { await sql`DELETE FROM media WHERE id = ${id}`; } catch (e) {} }
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: '登录已失效，请重新登录' }); }
}
const publicItem = it => ({ id: it.id, name: it.name, category: it.category, found_location: it.found_location, found_date: it.found_date, public_description: it.public_description, status: it.status, photos: it.photos || [] });

/* ========== 登录（只需密码） ========== */
app.post('/api/login', loginLimiter, (req, res) => {
  const p = str(req.body.password, { required: true, max: 200 });
  if (p.err) return res.status(400).json({ error: '请输入密码' });
  if (!verifyPassword(p.v)) return res.status(401).json({ error: '密码错误' });
  res.json({ token: jwt.sign({ role: 'staff' }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES }) });
});

/* ========== 公众 ========== */
app.get('/api/items', (req, res) => {
  const q = str(req.query.q, { max: 100 }).v.toLowerCase();
  let list = [...data.items];
  if (q) list = list.filter(it => `${it.name}${it.category}${it.found_location}${it.public_description}`.toLowerCase().includes(q));
  list.sort(byNewest);
  res.json(list.map(publicItem));
});
app.get('/api/items/:id', (req, res) => {
  const it = data.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '物品不存在' });
  res.json(publicItem(it));
});
app.get('/api/media/:id', async (req, res) => {
  try {
    const rows = await sql`SELECT b64 FROM media WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).end();
    const m = /^data:(image\/[a-zA-Z+]+);base64,([\s\S]*)$/.exec(rows[0].b64);
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (e) { res.status(500).end(); }
});
app.post('/api/items/:id/claims', publicWriteLimiter, async (req, res) => {
  const it = data.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '物品不存在' });
  if (it.status !== 'available') return res.status(409).json({ error: '该物品当前不可认领' });
  const f = str(req.body.feature_desc, { required: true, max: 800 });
  const ld = str(req.body.lost_date, { required: true, max: 30 });
  const ll = str(req.body.lost_location, { required: true, max: 120 });
  const nm = str(req.body.claimant_name, { required: true, max: 60 });
  const ph = str(req.body.claimant_phone, { required: true, max: 40 });
  const it2 = str(req.body.id_type, { required: true, max: 30 });
  if (f.err || ld.err || ll.err || nm.err || ph.err || it2.err) return res.status(400).json({ error: '请完整填写认领信息' });
  if (req.body.agreed !== true) return res.status(400).json({ error: '请确认同意认领须知' });
  const id = newId();
  data.claims.push({ id, item_id: it.id, feature_desc: f.v, lost_date: ld.v, lost_location: ll.v, claimant_name: nm.v, claimant_phone: ph.v, id_type: it2.v, status: 'pending', created_at: now(), decided_at: null });
  it.status = 'pending';
  await save();
  res.json({ ok: true, reference: id.slice(-6).toUpperCase() });
});
app.post('/api/reports', publicWriteLimiter, async (req, res) => {
  const nm = str(req.body.name, { required: true, max: 120 });
  const ld = str(req.body.lost_date, { required: true, max: 30 });
  const ll = str(req.body.lost_location, { required: true, max: 120 });
  const ds = str(req.body.description, { required: true, max: 800 });
  const rn = str(req.body.reporter_name, { required: true, max: 60 });
  const rp = str(req.body.reporter_phone, { required: true, max: 40 });
  if (nm.err || ld.err || ll.err || ds.err || rn.err || rp.err) return res.status(400).json({ error: '请完整填写寻物信息' });
  const photos = await storePhotos(req.body.photos);
  data.reports.push({ id: newId(), name: nm.v, lost_date: ld.v, lost_location: ll.v, description: ds.v, reporter_name: rn.v, reporter_phone: rp.v, photos, done: 0, created_at: now() });
  await save();
  res.json({ ok: true });
});

/* ========== 客服（登录后） ========== */
app.get('/api/staff/items', auth, (req, res) => {
  res.json([...data.items].sort(byNewest).map(it => ({ ...it, pending_claims: data.claims.filter(c => c.item_id === it.id && c.status === 'pending').length })));
});
app.post('/api/items', auth, async (req, res) => {
  const nm = str(req.body.name, { required: true, max: 120 });
  const secret = str(req.body.secret_feature, { required: true, max: 800 });
  if (nm.err) return res.status(400).json({ error: '请填写物品名称' });
  if (secret.err) return res.status(400).json({ error: '请填写核验特征（认领核对依据）' });
  const id = newId(); const code = pickupCode();
  const photos = await storePhotos(req.body.photos);
  data.items.push({ id, pickup_code: code, name: nm.v, category: str(req.body.category, { max: 40 }).v, storage_location: str(req.body.storage_location, { max: 120 }).v, found_date: str(req.body.found_date, { max: 30 }).v, found_location: str(req.body.found_location, { max: 120 }).v, public_description: str(req.body.public_description, { max: 800 }).v, secret_feature: secret.v, photos, status: 'available', created_at: now() });
  audit('add_item', `${nm.v} (${code})`);
  await save();
  res.json({ ok: true, id, pickup_code: code });
});
app.patch('/api/items/:id', auth, async (req, res) => {
  const it = data.items.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '物品不存在' });
  if (['available', 'pending', 'claimed'].includes(req.body.status)) it.status = req.body.status;
  audit('update_item', `${it.name} -> ${it.status}`);
  await save();
  res.json({ ok: true });
});
app.delete('/api/items/:id', auth, async (req, res) => {
  const idx = data.items.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '物品不存在' });
  const [it] = data.items.splice(idx, 1);
  data.claims = data.claims.filter(c => c.item_id !== it.id);
  await deleteMedia(it.photos);
  audit('delete_item', it.name);
  await save();
  res.json({ ok: true });
});
app.get('/api/staff/claims', auth, (req, res) => {
  const list = data.claims.map(c => { const it = data.items.find(i => i.id === c.item_id) || {}; return { ...c, item_name: it.name, secret_feature: it.secret_feature, pickup_code: it.pickup_code, storage_location: it.storage_location }; })
    .sort((a, b) => { const ap = a.status === 'pending', bp = b.status === 'pending'; if (ap !== bp) return ap ? -1 : 1; return byNewest(a, b); });
  res.json(list);
});
app.post('/api/staff/claims/:id/decide', auth, async (req, res) => {
  const decision = req.body.decision === 'approved' ? 'approved' : req.body.decision === 'rejected' ? 'rejected' : null;
  if (!decision) return res.status(400).json({ error: '无效的审核结果' });
  const c = data.claims.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '申请不存在' });
  if (c.status !== 'pending') return res.status(409).json({ error: '该申请已处理' });
  c.status = decision; c.decided_at = now(); c.decision_note = str(req.body.note, { max: 300 }).v;
  const it = data.items.find(i => i.id === c.item_id);
  if (it) it.status = decision === 'approved' ? 'claimed' : 'available';
  audit('decide_claim', `${c.id} -> ${decision}`);
  await save();
  res.json({ ok: true });
});
app.get('/api/staff/reports', auth, (req, res) => {
  res.json([...data.reports].sort((a, b) => (a.done - b.done) || byNewest(a, b)));
});
app.patch('/api/staff/reports/:id', auth, async (req, res) => {
  const r = data.reports.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: '记录不存在' });
  r.done = req.body.done ? 1 : 0;
  await save();
  res.json({ ok: true });
});

/* ========== 备份：导出 / 导入（含照片） ========== */
app.get('/api/staff/export', auth, async (req, res) => {
  const media = await sql`SELECT id, b64 FROM media`;
  res.json({ app: 'laf', version: 2, exportedAt: now(), data, media });
});
app.post('/api/staff/import', auth, async (req, res) => {
  const body = req.body || {};
  if (!body.data || !Array.isArray(body.data.items)) return res.status(400).json({ error: '不是有效的备份文件' });
  data = {
    items: body.data.items || [], claims: body.data.claims || [], reports: body.data.reports || [],
    audit: body.data.audit || [], seq: body.data.seq || { audit: 0 },
  };
  await sql`DELETE FROM media`;
  if (Array.isArray(body.media)) for (const m of body.media) { if (m && m.id && m.b64) { try { await sql`INSERT INTO media (id, b64) VALUES (${m.id}, ${m.b64})`; } catch (e) {} } }
  await save();
  res.json({ ok: true, items: data.items.length });
});

/* ---------- 前端页面（仅返回 index.html，不暴露源码） ---------- */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`失物招领服务已启动，端口 ${PORT}（数据存于 Neon 云数据库）`)))
  .catch(e => { console.error('[fatal] 数据库初始化失败:', e.message); process.exit(1); });
