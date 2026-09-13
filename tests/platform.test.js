import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createPlatformApp } from '../server/platform.js';
import { createApp } from '../server/app.js';

const platformAdmin = { name: 'Platform operator', email: 'operator@example.test', password: 'PlatformSecure!2026' };
const tenantAdmin = { name: 'Tenant administrator', email: 'tenant-admin@example.test', password: 'TenantSecure!2026' };
const tenantBody = (slug, changes = {}) => ({ slug, name: `Workspace ${slug}`, plan: 'trial', admin: tenantAdmin, dataMode: 'restricted', aiEnabled: false, ...changes });
const person = name => ({ name, type: 'Individual', email: '', preference: 'Email' });
const cookies = headers => headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

async function fixture(t, { configured = true, prepare, factory = createApp } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-platform-'));
  const legacyDbPath = join(dir, 'legacy.sqlite');
  if (prepare) await prepare(legacyDbPath);
  const policies = new Map(); let app, server, base;
  async function open() {
    app = createPlatformApp({ rootDir: join(dir, 'registry'), legacyDbPath, seedLegacy: true, initialPlatformAdmin: configured ? platformAdmin : undefined, tenantFactory: args => { policies.set(args.tenantInfo.slug, { ...args }); return factory(args); } });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, cookie, csrf = true, origin, headers: extra = {} } = {}) {
    const headers = { ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session || cookie) headers.Cookie = cookie ?? session.cookie;
    if (session && csrf) headers['X-CSRF-Token'] = typeof csrf === 'string' ? csrf : session.csrfToken;
    if (origin) headers.Origin = origin;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json(), headers: r.headers };
  }
  async function loginPlatform() { const r = await request('/api/platform/auth/login', { method: 'POST', body: { email: platformAdmin.email, password: platformAdmin.password } }); assert.equal(r.status, 200, JSON.stringify(r.json)); return { ...r.json, cookie: cookies(r.headers) }; }
  async function loginTenant(slug, credentials = tenantAdmin) { const r = await request('/api/auth/login', { method: 'POST', body: { email: credentials.email, password: credentials.password, ...(slug === undefined ? {} : { tenantSlug: slug }) } }); assert.equal(r.status, 200, JSON.stringify(r.json)); return { ...r.json, cookie: cookies(r.headers) }; }
  async function createTenant(slug, session, changes) { const r = await request('/api/platform/tenants', { method: 'POST', session, body: tenantBody(slug, changes) }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.tenant; }
  return { request, loginPlatform, loginTenant, createTenant, policies, dir, restart: async () => { await close(); await open(); }, get app() { return app; } };
}

test('unconfigured platform has no shared administrator; anonymous registry and tenant routes remain protected', async t => {
  const f = await fixture(t, { configured: false });
  assert.deepEqual((await f.request('/api/platform/config')).json, { configured: false });
  assert.equal((await f.request('/api/platform/auth/me')).status, 503);
  const denied = await f.request('/api/platform/auth/login', { method: 'POST', body: { email: 'alex@foundation.example', password: 'FoundationDemo!2026' } });
  assert.equal(denied.status, 401);
  assert.equal((await f.request('/api/workspace')).status, 401);
  const configured = await fixture(t);
  assert.equal((await configured.request('/api/platform/tenants')).status, 401);
  assert.equal((await configured.request('/api/platform/audit')).status, 401);
});

test('platform and tenant sessions are independent and platform role has no business/impersonation authority', async t => {
  const f = await fixture(t); const operator = await f.loginPlatform();
  assert.equal(operator.user.role, 'platform_admin');
  assert.match(operator.cookie, /^wimblo_platform_session=/);
  assert.match((await f.request('/api/platform/auth/me', { session: operator })).json.user.email, /operator/);
  assert.equal((await f.request('/api/workspace', { session: operator })).status, 401);
  await f.createTenant('alpha', operator); const alpha = await f.loginTenant('alpha');
  assert.equal((await f.request('/api/platform/tenants', { session: alpha })).status, 401);
  assert.equal((await f.request('/api/platform/impersonate', { method: 'POST', session: operator, body: { tenantSlug: 'alpha' } })).status, 404);
  assert.equal((await f.request('/api/platform/auth/logout', { method: 'POST', session: operator })).status, 200);
  assert.equal((await f.request('/api/platform/auth/me', { session: operator })).status, 401);
  assert.equal((await f.request('/api/workspace', { session: alpha })).status, 200);
});

test('two tenant databases isolate sessions, business records and foreign references despite identical admin credentials', async t => {
  const f = await fixture(t); const operator = await f.loginPlatform();
  const a = await f.createTenant('alpha', operator); const b = await f.createTenant('beta', operator);
  const alpha = await f.loginTenant('alpha'); const beta = await f.loginTenant('beta');
  assert.notEqual(alpha.cookie.split(';')[0].split('=')[0], beta.cookie.split(';')[0].split('=')[0]);
  const created = await f.request('/api/records/constituents', { method: 'POST', session: alpha, body: person('Alpha-only donor') }); assert.equal(created.status, 201);
  const alphaState = await f.request('/api/workspace', { session: alpha }); const betaState = await f.request('/api/workspace', { session: beta });
  assert.equal(alphaState.json.data.constituents.length, 1); assert.equal(betaState.json.data.constituents.length, 0);
  const cross = await f.request('/api/records/pledges', { method: 'POST', session: beta, body: { name: 'Cross-tenant pledge', constituentId: created.json.record.id, amount: 100, startDate: '2026-09-13', installments: 1, frequency: 'Monthly', status: 'Active' } }); assert.equal(cross.status, 400);
  const alphaAuthOnly = alpha.cookie.split(';').find(v => v.trim().startsWith('wimblo_tenant_')).trim();
  assert.equal((await f.request('/api/workspace', { cookie: `${alphaAuthOnly}; wimblo_selected_tenant=${b.id}` })).status, 401);
  assert.equal((await f.request('/api/workspace?tenantSlug=beta', { session: alpha, headers: { 'X-Tenant-Id': b.id, 'X-Tenant-Slug': 'beta' } })).json.data.constituents[0].name, 'Alpha-only donor');
  assert.ok(f.policies.get('alpha').dbPath.includes(a.id)); assert.ok(!f.policies.get('alpha').dbPath.includes('alpha/'));
  assert.deepEqual((await f.request('/api/config', { session: alpha })).json.tenant, { slug: 'alpha', name: 'Workspace alpha' });
});

test('unknown selectors and unknown login slugs never fall back to the legacy tenant', async t => {
  const f = await fixture(t); const legacy = await f.loginTenant(undefined, { email: 'alex@foundation.example', password: 'FoundationDemo!2026' });
  const legacyAuth = legacy.cookie.split(';').find(v => v.trim().startsWith('foundation_session=')).trim();
  assert.equal((await f.request('/api/workspace', { cookie: `${legacyAuth}; wimblo_selected_tenant=not-a-registered-id` })).status, 401);
  for (const tenantSlug of ['missing', '../../outside', '', 7]) assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: 'alex@foundation.example', password: 'FoundationDemo!2026', tenantSlug } })).status, 401);
  assert.equal((await f.request('/api/workspace', { cookie: legacyAuth })).status, 200);
});

test('lifecycle changes require platform CSRF/current version and suspension revokes routing without deleting data', async t => {
  const f = await fixture(t); const operator = await f.loginPlatform(); const tenant = await f.createTenant('alpha', operator); const alpha = await f.loginTenant('alpha');
  await f.request('/api/records/constituents', { method: 'POST', session: alpha, body: person('Persistent suspended donor') });
  const path = `/api/platform/tenants/${tenant.id}`; const body = { version: tenant.version, status: 'suspended', aiEnabled: false, plan: 'subscription' };
  assert.equal((await f.request(path, { method: 'PATCH', session: operator, csrf: false, body })).status, 403);
  assert.equal((await f.request(path, { method: 'PATCH', session: alpha, body })).status, 401);
  const suspended = await f.request(path, { method: 'PATCH', session: operator, body }); assert.equal(suspended.status, 200);
  assert.equal((await f.request(path, { method: 'PATCH', session: operator, body })).status, 409);
  assert.equal((await f.request('/api/workspace', { session: alpha })).status, 403);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { ...tenantAdmin, tenantSlug: 'alpha' } })).status, 403);
  await f.restart(); assert.equal((await f.request('/api/workspace', { session: alpha })).status, 403);
  const resumed = await f.request(path, { method: 'PATCH', session: operator, body: { version: suspended.json.tenant.version, status: 'active', plan: 'dedicated', aiEnabled: true } }); assert.equal(resumed.status, 200);
  assert.equal((await f.request('/api/workspace', { session: alpha })).status, 401);
  const renewed = await f.loginTenant('alpha'); assert.equal((await f.request('/api/workspace', { session: renewed })).json.data.constituents[0].name, 'Persistent suspended donor');
  assert.equal(f.policies.get('alpha').aiPolicy.enabled, true);
  assert.equal((await f.request(path, { method: 'PATCH', session: operator, body: { version: resumed.json.tenant.version, dataMode: 'synthetic' } })).status, 400);
});

test('tenant provisioning rejects unsafe slugs/weak credentials/duplicates, with no secrets or paths in registry audit', async t => {
  const f = await fixture(t); const operator = await f.loginPlatform();
  assert.equal((await f.request('/api/platform/tenants', { method: 'POST', session: operator, csrf: false, body: tenantBody('alpha') })).status, 403);
  for (const changes of [{ slug: '../escape' }, { admin: { ...tenantAdmin, password: 'short' } }, { plan: 'free-billing' }, { dataMode: 'actual-approved' }, { unexpected: true }]) assert.equal((await f.request('/api/platform/tenants', { method: 'POST', session: operator, body: tenantBody('alpha', changes) })).status, 400);
  await f.createTenant('alpha', operator, { dataMode: 'synthetic' });
  assert.equal((await f.request('/api/platform/tenants', { method: 'POST', session: operator, body: tenantBody('alpha') })).status, 409);
  const list = await f.request('/api/platform/tenants', { session: operator }); const serialized = JSON.stringify(list.json);
  assert.ok(!serialized.includes(tenantAdmin.password)); assert.ok(!serialized.includes(platformAdmin.password)); assert.ok(!/password_hash|workspace.sqlite|csrfToken|dbPath/.test(serialized));
  assert.equal(list.json.tenants.length, 2); assert.ok(list.json.audit.some(r => r.action === 'create_tenant'));
  assert.equal((await readdir(join(f.dir, 'registry', 'tenants'))).length, 1);
});

test('legacy database/custom settings and preexisting legacy sessions survive platform wrapping and restart', async t => {
  let legacyCookie; let before;
  const f = await fixture(t, { prepare: async dbPath => { const app = createApp({ dbPath, seed: true }); const db = app.locals.db; db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify({ organizationName: 'Custom preserved organization', fiscalStartMonth: 9 })); before = db.prepare('SELECT COUNT(*) AS total FROM records').get().total; const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const r = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alex@foundation.example', password: 'FoundationDemo!2026' }) }); legacyCookie = cookies(r.headers); await new Promise(resolve => server.close(resolve)); app.locals.close(); } });
  assert.equal(f.policies.get('wimblo').tenantId, null); assert.equal(f.policies.get('wimblo').aiPolicy.enabled, true); assert.equal(f.policies.get('wimblo').aiPolicy.dataMode, 'synthetic');
  for (let i = 0; i < 2; i++) { const state = await f.request('/api/workspace', { cookie: legacyCookie }); assert.equal(state.status, 200); assert.equal(state.json.settings.organizationName, 'Custom preserved organization'); assert.equal(state.json.settings.fiscalStartMonth, 9); assert.equal(Object.values(state.json.data).reduce((n, records) => n + records.length, 0), before); await f.restart(); }
});

test('platform login rejects foreign origins, rate limits failures and expires idle sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/platform/auth/login', { method: 'POST', origin: 'https://outside.example.test', body: { email: platformAdmin.email, password: platformAdmin.password } })).status, 403);
  const operator = await f.loginPlatform();
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/platform/auth/login', { method: 'POST', body: { email: 'invalid@example.test', password: 'wrong' } })).status, 401);
  assert.equal((await f.request('/api/platform/auth/login', { method: 'POST', body: { email: 'invalid@example.test', password: 'wrong' } })).status, 429);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1800001 });
  assert.equal((await f.request('/api/platform/auth/me', { session: operator })).status, 401);
});

test('production platform requires HTTPS, explicit proxy trust and explicit synthetic permission', async t => {
  const keys = ['NODE_ENV', 'APP_ORIGIN', 'TRUST_PROXY', 'ALLOW_DEMO']; const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  process.env.NODE_ENV = 'production'; process.env.APP_ORIGIN = 'https://crm.example.test'; process.env.TRUST_PROXY = 'true'; delete process.env.ALLOW_DEMO;
  const factory = () => { const app = express(); app.get('/api/health', (req, res) => res.json({ status: 'ok' })); app.locals.close = () => {}; return app; };
  const f = await fixture(t, { factory });
  assert.equal((await f.request('/api/platform/config')).status, 403);
  const logged = await f.request('/api/platform/auth/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, origin: process.env.APP_ORIGIN, body: { email: platformAdmin.email, password: platformAdmin.password } }); assert.equal(logged.status, 200); assert.match(logged.headers.get('set-cookie'), /Secure/i);
  const operator = { ...logged.json, cookie: cookies(logged.headers) };
  assert.equal((await f.request('/api/platform/tenants', { method: 'POST', session: operator, headers: { 'X-Forwarded-Proto': 'https' }, body: tenantBody('synthetic', { dataMode: 'synthetic' }) })).status, 403);
  assert.equal((await f.request('/api/platform/tenants', { method: 'POST', session: operator, headers: { 'X-Forwarded-Proto': 'https' }, body: tenantBody('restricted') })).status, 201);
});


test('lost nonlegacy storage fails closed after restart instead of recreating a globally bootstrapped database', async t => {
  const f = await fixture(t); const operator = await f.loginPlatform(); const tenant = await f.createTenant('alpha', operator); const alpha = await f.loginTenant('alpha');
  const path = f.policies.get('alpha').dbPath;
  await f.restart(); await rm(path, { force: true });
  assert.equal((await f.request('/api/workspace', { session: alpha })).status, 503);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: tenantAdmin.email, password: tenantAdmin.password, tenantSlug: 'alpha' } })).status, 503);
  await assert.rejects(access(path));
  const registry = await f.request('/api/platform/tenants', { session: operator }); assert.equal(registry.status, 200); assert.ok(registry.json.tenants.some(r => r.id === tenant.id));
});
