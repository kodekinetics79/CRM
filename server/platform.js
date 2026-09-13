import express from 'express';
import helmet from 'helmet';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';

const LEGACY_ID = '00000000-0000-4000-8000-000000000001';
const PLATFORM_COOKIE = 'wimblo_platform_session';
const SELECTOR_COOKIE = 'wimblo_selected_tenant';
const strongPassword = z.string().min(16).max(200).refine(p => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^a-zA-Z0-9]/.test(p), 'Strong password required');
const initialAdminSchema = z.object({ name: z.string().trim().min(1).max(250), email: z.email().max(254).transform(v => v.toLowerCase()), password: strongPassword }).strict();
const tenantSchema = z.object({ slug: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().trim().min(1).max(250), plan: z.enum(['trial', 'subscription', 'dedicated']).default('trial'), aiEnabled: z.boolean().default(false), dataMode: z.enum(['synthetic', 'restricted']).default('restricted'), admin: initialAdminSchema }).strict();
const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHash = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verify = (password, stored) => { try { const [salt, digest] = stored.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex')); } catch { return false; } };
const cookieValue = (req, name) => (req.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };

export function createPlatformApp({ rootDir, legacyDbPath, seedLegacy = true, tenantFactory, initialPlatformAdmin } = {}) {
  if (!rootDir || !legacyDbPath || typeof tenantFactory !== 'function') throw new Error('Platform requires rootDir, legacyDbPath and tenantFactory.');
  const production = process.env.NODE_ENV === 'production';
  let productionOrigin;
  if (production) { try { productionOrigin = new URL(process.env.APP_ORIGIN); } catch { throw new Error('Production platform requires an HTTPS APP_ORIGIN.'); } if (productionOrigin.protocol !== 'https:' || productionOrigin.origin !== process.env.APP_ORIGIN || productionOrigin.username || productionOrigin.password) throw new Error('Production platform requires an HTTPS APP_ORIGIN.'); }
  const root = resolve(rootDir); mkdirSync(join(root, 'tenants'), { recursive: true });
  const db = new DatabaseSync(join(root, 'platform.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,ai_enabled INTEGER NOT NULL,data_mode TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS administrators(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_sessions(token_hash TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES administrators(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL,last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,tenant_id TEXT,at TEXT NOT NULL,details TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS platform_audit_no_update BEFORE UPDATE ON platform_audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS platform_audit_no_delete BEFORE DELETE ON platform_audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;`);
  if (!db.prepare('PRAGMA table_info(tenants)').all().some(c => c.name === 'data_mode')) db.exec("ALTER TABLE tenants ADD COLUMN data_mode TEXT NOT NULL DEFAULT 'restricted'");
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const audit = (actor, action, tenantId, details = {}) => db.prepare('INSERT INTO platform_audit(actor,action,tenant_id,at,details) VALUES(?,?,?,?,?)').run(actor || 'system', action, tenantId || null, new Date().toISOString(), JSON.stringify(details));
  const lookup = id => db.prepare('SELECT * FROM tenants WHERE id=?').get(id);
  const publicTenant = r => ({ id: r.id, slug: r.slug, name: r.name, plan: r.plan, status: r.status, aiEnabled: Boolean(r.ai_enabled), dataMode: r.data_mode, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at });
  const publicAdmin = r => ({ id: r.id, name: r.name, email: r.email, role: 'platform_admin' });
  const apps = new Map();
  const tenantPath = id => id === LEGACY_ID ? resolve(legacyDbPath) : join(root, 'tenants', id, 'workspace.sqlite');
  const getTenantApp = (tenant, initialAdmin) => {
    if (!apps.has(tenant.id)) {
      if (tenant.id !== LEGACY_ID && !initialAdmin && !existsSync(tenantPath(tenant.id))) fail(503, 'Workspace storage is unavailable; administrator recovery is required.');
      const aiPolicy = {}; Object.defineProperties(aiPolicy, { enabled: { enumerable: true, get: () => Boolean(lookup(tenant.id)?.ai_enabled) }, aiEnabled: { enumerable: true, get: () => Boolean(lookup(tenant.id)?.ai_enabled) }, dataMode: { enumerable: true, get: () => lookup(tenant.id)?.data_mode || 'restricted' } });
      apps.set(tenant.id, tenantFactory({ dbPath: tenantPath(tenant.id), seed: tenant.id === LEGACY_ID && seedLegacy, tenantId: tenant.id === LEGACY_ID ? null : tenant.id, tenantInfo: { slug: tenant.slug, name: tenant.name }, initialAdmin, aiPolicy, isTenantActive:()=>lookup(tenant.id)?.status==='active' }));
    }
    return apps.get(tenant.id);
  };
  try {
    if (!lookup(LEGACY_ID)) tx(() => { const at = new Date().toISOString(); db.prepare('INSERT INTO tenants(id,slug,name,plan,status,ai_enabled,data_mode,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(LEGACY_ID, 'wimblo', 'Wimblo', 'dedicated', 'active', !production && seedLegacy ? 1 : 0, !production && seedLegacy ? 'synthetic' : 'restricted', 1, at, at); audit(null, 'register_legacy', LEGACY_ID); });
    if (!db.prepare('SELECT 1 FROM administrators LIMIT 1').get()) {
      const supplied = initialPlatformAdmin || (process.env.PLATFORM_ADMIN_EMAIL || process.env.PLATFORM_ADMIN_NAME || process.env.PLATFORM_ADMIN_PASSWORD ? { email: process.env.PLATFORM_ADMIN_EMAIL, name: process.env.PLATFORM_ADMIN_NAME, password: process.env.PLATFORM_ADMIN_PASSWORD } : null);
      if (supplied) { const admin = initialAdminSchema.parse(supplied); tx(() => { const id = randomUUID(); db.prepare('INSERT INTO administrators VALUES(?,?,?,?)').run(id, admin.name, admin.email, passwordHash(admin.password)); audit(id, 'bootstrap_platform_admin', null); }); }
    }
    getTenantApp(lookup(LEGACY_ID));
  } catch (error) { for (const child of apps.values()) child.locals.close?.(); db.close(); throw error; }
  const app = express();
  let closed = false; app.locals.close = () => { if (closed) return; closed = true; for (const child of apps.values()) child.locals.close?.(); db.close(); };
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.use(helmet()); app.use(express.json({ limit: '2mb' }));
  const allowed = new Set(production ? [productionOrigin.origin] : ['http://localhost:5174', 'http://127.0.0.1:5174', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4311', 'http://127.0.0.1:4311', 'http://localhost:4321', 'http://127.0.0.1:4321', ...(process.env.EVALUATOR_MODE === 'true' ? [`http://127.0.0.1:${process.env.PORT || 4321}`, `http://localhost:${process.env.PORT || 4321}`] : []), ...(process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : [])]);
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); if (production && !req.secure) return res.status(403).json({ error: 'HTTPS required' }); const origin = req.get('Origin'); if (origin && !allowed.has(origin)) return res.status(403).json({ error: 'Origin denied' }); if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Access-Control-Allow-Credentials', 'true'); res.set('Vary', 'Origin'); res.set('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token'); res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS'); } if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
  const cookies = { httpOnly: true, sameSite: 'strict', secure: production, path: '/', maxAge: 8 * 3600 * 1000 };
  const router = express.Router();
  const configured = () => Boolean(db.prepare('SELECT 1 FROM administrators LIMIT 1').get());
  router.get('/config', (req, res) => res.json({ configured: configured() }));
  const attempts = new Map(); const dummyHash = passwordHash(randomBytes(32).toString('hex'));
  const rateLimit = (req, email) => { const time = Date.now(); for (const key of [`ip:${req.ip}`, `${req.ip}:${email}`]) { let value = attempts.get(key); if (!value || value.until < time) value = { count: 0, until: time + 900000 }; if (value.count >= (key.startsWith('ip:') ? 50 : 10)) fail(429, 'Too many login attempts'); value.count++; attempts.set(key, value); } if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until < time) attempts.delete(key); };
  router.post('/auth/login', (req, res) => { const body = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) }).strict().parse(req.body); const email = body.email.toLowerCase(); rateLimit(req, email); const admin = db.prepare('SELECT * FROM administrators WHERE email=?').get(email); const valid = verify(body.password, admin?.password_hash || dummyHash); if (!admin || !valid) fail(401, 'Invalid email or password'); attempts.delete(`${req.ip}:${email}`); const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), time = Date.now(); db.prepare('INSERT INTO platform_sessions VALUES(?,?,?,?,?)').run(hash(token), admin.id, csrf, time + 8 * 3600000, time); res.cookie(PLATFORM_COOKIE, token, cookies).json({ user: publicAdmin(admin), csrfToken: csrf }); });
  router.use((req, res, next) => { if (!configured()) return res.status(503).json({ error: 'Platform administrator is not configured. Set PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME and PLATFORM_ADMIN_PASSWORD on the server.' }); const token = cookieValue(req, PLATFORM_COOKIE); const session = token && db.prepare('SELECT * FROM platform_sessions WHERE token_hash=?').get(hash(token)); const time = Date.now(); if (!session || session.expires < time || session.last_seen < time - 1800000) { if (session) db.prepare('DELETE FROM platform_sessions WHERE token_hash=?').run(session.token_hash); return res.status(401).json({ error: 'Platform authentication required' }); } const admin = db.prepare('SELECT * FROM administrators WHERE id=?').get(session.admin_id); if (!admin) return res.status(401).json({ error: 'Platform authentication required' }); db.prepare('UPDATE platform_sessions SET last_seen=? WHERE token_hash=?').run(time, session.token_hash); req.platformAdmin = admin; req.platformSession = session; next(); });
  router.get('/auth/me', (req, res) => res.json({ user: publicAdmin(req.platformAdmin), csrfToken: req.platformSession.csrf }));
  router.use((req, res, next) => { if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('X-CSRF-Token') === req.platformSession.csrf) return next(); res.status(403).json({ error: 'Invalid CSRF token' }); });
  router.post('/auth/logout', (req, res) => { db.prepare('DELETE FROM platform_sessions WHERE token_hash=?').run(req.platformSession.token_hash); res.clearCookie(PLATFORM_COOKIE, cookies).json({ ok: true }); });
  const auditRows = () => db.prepare('SELECT * FROM platform_audit ORDER BY id DESC LIMIT 250').all().map(r => ({ id: r.id, actor: r.actor, action: r.action, tenantId: r.tenant_id, at: r.at, details: JSON.parse(r.details) }));
  router.get('/tenants', (req, res) => res.json({ tenants: db.prepare('SELECT * FROM tenants ORDER BY created_at,id').all().map(publicTenant), audit: auditRows() }));
  router.get('/audit', (req, res) => res.json({ audit: auditRows() }));
  router.post('/tenants', (req, res) => {
    const body = tenantSchema.parse(req.body); if (production && body.dataMode === 'synthetic' && process.env.ALLOW_DEMO !== 'true') fail(403, 'Synthetic tenants require explicit ALLOW_DEMO=true in production.'); const id = randomUUID(); let createdApp;
    try {
      const tenant = tx(() => { if (db.prepare('SELECT 1 FROM tenants WHERE slug=?').get(body.slug)) fail(409, 'Tenant slug already exists'); const at = new Date().toISOString(); db.prepare('INSERT INTO tenants(id,slug,name,plan,status,ai_enabled,data_mode,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, body.slug, body.name, body.plan, 'active', body.aiEnabled ? 1 : 0, body.dataMode, 1, at, at); const r = lookup(id); createdApp = getTenantApp(r, body.admin); audit(req.platformAdmin.id, 'create_tenant', id, { slug: body.slug, plan: body.plan, aiEnabled: body.aiEnabled, dataMode: body.dataMode }); return publicTenant(r); });
      res.status(201).json({ tenant });
    } catch (error) { if (createdApp) createdApp.locals.close?.(); apps.delete(id); rmSync(join(root, 'tenants', id), { recursive: true, force: true }); throw error; }
  });
  router.patch('/tenants/:id', (req, res) => { const body = z.object({ version: z.number().int().min(1), status: z.enum(['active', 'suspended']).optional(), aiEnabled: z.boolean().optional(), plan: z.enum(['trial', 'subscription', 'dedicated']).optional() }).strict().refine(v => v.status !== undefined || v.aiEnabled !== undefined || v.plan !== undefined, 'A lifecycle, plan or AI change is required').parse(req.body); const tenant = tx(() => { const old = lookup(req.params.id); if (!old) fail(404, 'Tenant not found'); if (old.version !== body.version) fail(409, 'Tenant changed; reload before saving'); const next = { status: body.status ?? old.status, aiEnabled: body.aiEnabled ?? Boolean(old.ai_enabled), plan: body.plan ?? old.plan }; if (old.status === 'active' && next.status === 'suspended' && existsSync(tenantPath(old.id))) getTenantApp(old).locals.revokeAllSessions?.(); db.prepare('UPDATE tenants SET status=?,ai_enabled=?,plan=?,version=version+1,updated_at=? WHERE id=?').run(next.status, next.aiEnabled ? 1 : 0, next.plan, new Date().toISOString(), old.id); audit(req.platformAdmin.id, 'update_tenant', old.id, { previous: { status: old.status, aiEnabled: Boolean(old.ai_enabled), plan: old.plan }, next }); return publicTenant(lookup(old.id)); }); res.json({ tenant }); });
  router.use((req, res) => res.status(404).json({ error: 'Platform endpoint not found' }));
  app.use('/api/platform', router);
  app.use('/api', (req, res, next) => {
    let tenant; const login = req.method === 'POST' && req.path === '/auth/login';
    if (login && req.body && Object.prototype.hasOwnProperty.call(req.body, 'tenantSlug')) { const { tenantSlug, ...credentials } = req.body; req.body = credentials; if (typeof tenantSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantSlug) || tenantSlug.length > 64) return res.status(401).json({ error: 'Authentication required' }); tenant = db.prepare('SELECT * FROM tenants WHERE slug=?').get(tenantSlug); }
    else { const selected = cookieValue(req, SELECTOR_COOKIE); tenant = lookup(selected === undefined ? LEGACY_ID : selected); }
    if (!tenant) return res.status(401).json({ error: 'Authentication required' });
    if (tenant.status !== 'active') return res.status(403).json({ error: 'Workspace is suspended' });
    if (login) { const json = res.json; res.json = function (payload) { if (res.statusCode >= 200 && res.statusCode < 300) res.cookie(SELECTOR_COOKIE, tenant.id, cookies); return json.call(this, payload); }; }
    const child = getTenantApp(tenant);
    // This middleware is mounted at /api; restore the prefix for the tenant application's own routes.
    const mountedUrl = req.url; req.url = '/api' + mountedUrl; child(req, res, error => { req.url = mountedUrl; next(error); });
  });
  app.use((error, req, res, next) => { if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', fields: error.issues.map(i => ({ path: i.path, message: i.message })) }); if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' }); if (error.status) return res.status(error.status).json({ error: error.status === 413 ? 'Request too large' : error.message }); res.status(500).json({ error: 'Internal server error' }); });
  return app;
}
