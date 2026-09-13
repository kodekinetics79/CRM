import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from '../server/app.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everbright-phase-three-'));
  const dbPath = join(dir, 'test.sqlite');
  let app;
  let server;
  let base;
  async function open() {
    app = createApp({ dbPath, seed: true });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
    if (app) { app.locals.close(); app = null; }
  }
  await open();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) {
      headers.Cookie = session.cookie;
      if (csrf) headers['X-CSRF-Token'] = typeof csrf === 'string' ? csrf : session.csrfToken;
    }
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, json, headers: response.headers };
  }
  async function login(email = 'alex@foundation.example') {
    const r = await request('/api/auth/login', { method: 'POST', body: { email, password: 'FoundationDemo!2026' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { ...r.json, cookie: r.headers.get('set-cookie').split(';')[0] };
  }
  let admin = await login();
  async function workspace(session = admin) {
    const r = await request('/api/workspace', { session });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  }
  async function create(collection, body, session = admin) {
    const r = await request(`/api/records/${collection}`, { method: 'POST', session, body });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
    return r.json.record;
  }
  async function patch(collection, record, changes, session = admin) {
    return request(`/api/records/${collection}/${record.id}`, { method: 'PATCH', session, body: { version: record.version, ...changes } });
  }
  async function restart() { await close(); await open(); admin = await login(); return workspace(); }
  return { request, login, workspace, create, patch, restart, get app() { return app; }, get admin() { return admin; } };
}

const person = (name = 'Grant funder', type = 'Foundation') => ({ name, email: 'phase-three@example.test', type, preference: 'Email', household: '', contacts: [], parentId: null, segments: '', phone: '', notes: '' });
const grant = (funder, changes = {}) => ({ name: 'Evaluator school grant', funderId: funder?.id || null, amount: 30000, awardedAmount: 20000, awardDate: '2026-08-01', stage: 'Awarded', deadline: '2026-07-15', reportDue: '2027-03-01', notes: '', ...changes });
const gift = (funder, fund, amount = 6000, changes = {}) => ({ constituentId: funder.id, amount, date: '2026-09-13', type: 'Grant', method: 'Check', campaignId: null, allocations: [{ designationId: fund.id, amount }], externalRef: '', notes: '', tribute: '', softCreditId: null, pledge: '', pledgeId: null, grantId: null, giftKind: 'One-time', ...changes });
const feedback = changes => ({ scenarioId: 'grants', tester: 'Evaluator reviewer', result: 'Needs attention', severity: 'Medium', actual: 'Award receipt could not be saved.', reproduction: 'Open Grants, choose a grant, and attempt to record a receipt.', notes: 'Synthetic review feedback only.', ...changes });
const rejected = r => assert.ok([400, 403, 409].includes(r.status), `Expected rejection, got ${r.status}: ${JSON.stringify(r.json)}`);
const record = (workspace, collection, id) => workspace.data[collection].find(r => r.id === id);

async function setup(t) {
  const f = await fixture(t);
  const funder = await f.create('constituents', person());
  const fund = await f.create('designations', { name: 'Phase three school fund', school: 'Synthetic school', parentId: null, accountCode: 'PHASE3', description: '' });
  return { f, funder, fund };
}

test('grant requested and verified award amounts round-trip separately with stage and calendar validation', async t => {
  const { f, funder } = await setup(t);
  const staff = await f.login('staff@foundation.example');
  const g = await f.create('grants', grant(funder), staff);
  assert.equal(g.amount, 30000);
  assert.equal(g.awardedAmount, 20000);
  assert.equal(g.awardDate, '2026-08-01');
  for (const changes of [{ awardedAmount: -1 }, { awardedAmount: 1.1 }, { awardedAmount: 20000, awardDate: null }, { awardDate: '2026-02-30' }, { stage: 'Preparing' }, { stage: 'Declined' }, { funderId: 'missing-funder' }]) rejected(await f.request('/api/records/grants', { method: 'POST', session: staff, body: grant(funder, changes) }));
  const oldStyle = await f.create('grants', { name: 'Unknown legacy-style award', amount: 99999, stage: 'Awarded', funderId: funder.id, deadline: '2026-08-01', reportDue: null, notes: '' });
  assert.equal(oldStyle.amount, 99999);
  assert.equal(oldStyle.awardedAmount, 0);
  assert.equal(oldStyle.awardDate, null);
  assert.equal((await f.patch('grants', g, { amount: 35000 }, staff)).status, 200);
  assert.equal((await f.patch('grants', g, { amount: 40000 }, staff)).status, 409);
});

test('grant receipt links reject wrong type, known funder mismatch, missing award, missing grant and double commitment linkage', async t => {
  const { f, funder, fund } = await setup(t);
  const other = await f.create('constituents', person('Other funder'));
  const g = await f.create('grants', grant(funder));
  const unknown = await f.create('grants', grant(funder, { awardedAmount: 0, awardDate: null }));
  const p = await f.create('pledges', { name: 'Separate commitment', constituentId: funder.id, amount: 20000, startDate: '2026-08-01', installments: 2, frequency: 'Monthly', designationId: null, campaignId: null, status: 'Active', notes: '' });
  const before = await f.workspace();
  for (const changes of [{ type: 'Cash' }, { type: 'Fee payment' }, { type: 'In-kind', method: 'In-kind' }, { constituentId: other.id }, { grantId: 'missing-grant' }, { grantId: unknown.id }, { pledgeId: p.id }]) rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(funder, fund, 6000, { grantId: g.id, ...changes }) }));
  assert.equal((await f.workspace()).data.gifts.length, before.data.gifts.length);
  assert.equal((await f.workspace()).audit.length, before.audit.length);
  const unnamedFunder = await f.create('grants', grant(null));
  const valid = await f.create('gifts', gift(other, fund, 1000, { grantId: unnamedFunder.id }));
  assert.equal(valid.constituentId, other.id);
  assert.equal(valid.grantId, unnamedFunder.id);
});

test('grant receipt and award edits preserve financial integrity while voids release received balance', async t => {
  const { f, funder, fund } = await setup(t);
  const other = await f.create('constituents', person('Different named funder'));
  const g = await f.create('grants', grant(funder));
  const a = await f.create('gifts', gift(funder, fund, 12345, { grantId: g.id }));
  const b = await f.create('gifts', gift(funder, fund, 7655, { grantId: g.id }));
  rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(funder, fund, 1, { grantId: g.id }) }));
  rejected(await f.patch('gifts', a, { amount: 12346, allocations: [{ designationId: fund.id, amount: 12346 }] }));
  rejected(await f.patch('gifts', a, { constituentId: other.id }));
  rejected(await f.patch('gifts', a, { type: 'Cash' }));
  for (const changes of [{ awardedAmount: 19999 }, { funderId: other.id }, { awardedAmount: 0, awardDate: null }, { stage: 'Preparing' }]) rejected(await f.patch('grants', g, changes));
  const requested = await f.patch('grants', g, { amount: 50000 });
  assert.equal(requested.status, 200, JSON.stringify(requested.json));
  const voided = await f.request(`/api/gifts/${b.id}/void`, { method: 'POST', session: f.admin, body: { version: b.version, reason: 'Replace erroneous grant receipt' } });
  assert.equal(voided.status, 200);
  await f.create('gifts', gift(funder, fund, 7655, { grantId: g.id }));
  const state = await f.workspace();
  assert.equal(state.data.gifts.filter(r => r.grantId === g.id && r.status === 'Posted').reduce((n, r) => n + r.amount, 0), 20000);
  assert.equal(record(state, 'gifts', b.id).status, 'Voided');
  rejected(await f.request(`/api/records/grants/${g.id}`, { method: 'DELETE', session: f.admin, body: { version: requested.json.record.version } }));
});

test('grant overfulfillment in an import rolls back every batch receipt and audit entry', async t => {
  const { f, funder, fund } = await setup(t);
  const g = await f.create('grants', grant(funder, { awardedAmount: 1000 }));
  const before = await f.workspace();
  const rows = [gift(funder, fund, 600, { grantId: g.id, externalRef: 'grant-batch-A' }), gift(funder, fund, 600, { grantId: g.id, externalRef: 'grant-batch-B' })];
  rejected(await f.request('/api/gifts/import', { method: 'POST', session: f.admin, body: { rows } }));
  const after = await f.workspace();
  assert.equal(after.data.gifts.length, before.data.gifts.length);
  assert.equal(after.audit.length, before.audit.length);
  assert.ok(!after.data.gifts.some(r => r.externalRef.startsWith('grant-batch-')));
});

test('grant reconciliation views preserve a valid saved scope and viewers cannot change grants or receipts', async t => {
  const { f, funder, fund } = await setup(t);
  const viewer = await f.login('board@foundation.example');
  const staff = await f.login('staff@foundation.example');
  const g = await f.create('grants', grant(funder));
  const view = await f.create('reportViews', { name: 'Grant reconciliation review', filters: { report: 'Grant reconciliation', start: '', end: '', type: 'All', schoolYear: 'All', excludeFees: true, inactiveDays: 90 } }, staff);
  assert.equal(record(await f.workspace(viewer), 'reportViews', view.id).filters.report, 'Grant reconciliation');
  assert.equal((await f.patch('grants', g, { awardedAmount: 30000 }, viewer)).status, 403);
  assert.equal((await f.request('/api/records/grants', { method: 'POST', session: viewer, body: grant(funder) })).status, 403);
  assert.equal((await f.request('/api/records/gifts', { method: 'POST', session: viewer, body: gift(funder, fund, 1000, { grantId: g.id }) })).status, 403);
  assert.equal((await f.request('/api/records/gifts', { method: 'POST', session: f.admin, csrf: false, body: gift(funder, fund, 1000, { grantId: g.id }) })).status, 403);
});

test('viewer may submit feedback but cannot edit/delete it or use ordinary write permissions', async t => {
  const f = await fixture(t);
  const viewer = await f.login('board@foundation.example');
  const submitted = await f.create('evaluations', feedback(), viewer);
  assert.equal(record(await f.workspace(), 'evaluations', submitted.id).tester, 'Evaluator reviewer');
  assert.equal((await f.patch('evaluations', submitted, { result: 'Passed' }, viewer)).status, 403);
  assert.equal((await f.request(`/api/records/evaluations/${submitted.id}`, { method: 'DELETE', session: viewer, body: { version: submitted.version } })).status, 403);
  assert.equal((await f.request('/api/records/constituents', { method: 'POST', session: viewer, body: person('Not allowed') })).status, 403);
  assert.equal((await f.request('/api/records/evaluations', { method: 'POST', session: viewer, csrf: false, body: feedback() })).status, 403);
  assert.equal((await f.request('/api/records/evaluations', { method: 'POST', body: feedback() })).status, 401);
  assert.equal(record(await f.workspace(viewer), 'evaluations', submitted.id).result, 'Needs attention');
});

test('feedback has strict scenario/result/severity validation and versioned staff review', async t => {
  const f = await fixture(t);
  const staff = await f.login('staff@foundation.example');
  const before = await f.workspace();
  for (const changes of [{ scenarioId: 'unknown' }, { result: 'Almost passed' }, { severity: 'Urgent' }, { tester: '' }, { tester: '   ' }, { actual: 42 }, { actual: '' }, { actual: '   ' }, { result: 'Blocked', reproduction: '' }, { result: 'Needs attention', reproduction: '   ' }, { unexpected: 'not allowed' }]) rejected(await f.request('/api/records/evaluations', { method: 'POST', session: staff, body: feedback(changes) }));
  assert.equal((await f.workspace()).data.evaluations.length, before.data.evaluations.length);
  const item = await f.create('evaluations', feedback({ scenarioId: 'access', result: 'Passed', severity: 'Low' }), staff);
  const revised = await f.patch('evaluations', item, { notes: 'Staff reviewed this access case.' }, staff);
  assert.equal(revised.status, 200, JSON.stringify(revised.json));
  assert.equal(revised.json.record.version, item.version + 1);
  assert.equal((await f.patch('evaluations', item, { notes: 'Stale overwrite' }, staff)).status, 409);
  assert.equal((await f.request(`/api/records/evaluations/${item.id}`, { method: 'DELETE', session: staff, body: { version: item.version } })).status, 409);
  const persisted = await f.restart();
  assert.equal(record(persisted, 'evaluations', item.id).notes, 'Staff reviewed this access case.');
  assert.equal(record(persisted, 'evaluations', item.id).result, 'Passed');
});

test('legacy single-value grants upgrade without inventing awards, receipts or dates', async t => {
  const { f, funder, fund } = await setup(t);
  const g = await f.create('grants', grant(funder, { name: 'Legacy unverified award', amount: 750000, awardedAmount: 0, awardDate: null }));
  const historic = await f.create('gifts', gift(funder, fund, 20000, { externalRef: 'legacy-unlinked-grant', grantId: null }));
  const db = f.app.locals.db;
  const legacy = { ...g }; delete legacy.awardedAmount; delete legacy.awardDate;
  db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(legacy), 'grants', g.id);
  const oldGift = { ...historic }; delete oldGift.grantId;
  db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(oldGift), 'gifts', historic.id);
  const upgraded = await f.restart();
  const retained = record(upgraded, 'grants', g.id);
  assert.equal(retained.amount, 750000);
  assert.equal(retained.awardedAmount, 0);
  assert.equal(retained.awardDate, null);
  assert.equal(retained.stage, 'Awarded');
  assert.equal(record(upgraded, 'gifts', historic.id).grantId ?? null, null);
  assert.equal(record(upgraded, 'gifts', historic.id).amount, 20000);
  const reopened = await f.restart();
  assert.equal(record(reopened, 'grants', g.id).awardedAmount, 0);
  assert.equal(reopened.data.grants.length, upgraded.data.grants.length);
  assert.equal(reopened.data.gifts.length, upgraded.data.gifts.length);
});

test('public health is minimal and does not expose records, credentials or local database paths', async t => {
  const f = await fixture(t);
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.deepEqual(Object.keys(health.json).sort(), ['mode', 'status', 'version']);
  assert.match(health.json.version, /^\d+\.\d+\.\d+$/);
  assert.ok(['local', 'evaluator', 'production'].includes(health.json.mode));
  assert.ok(!/sqlite|password|FoundationDemo|csrf|constituents|records|users|sessions/i.test(JSON.stringify(health.json)));
  assert.equal((await f.request('/api/workspace')).status, 401);
});

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const launcherPath = join(projectRoot, 'scripts/evaluate.mjs');
const exec = promisify(execFile);
function launcherEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['NODE_ENV', 'APP_HOST', 'APP_ORIGIN', 'PORT', 'DB_PATH', 'ALLOW_DEMO', 'EVALUATOR_MODE', 'TRUST_PROXY', 'ADMIN_EMAIL', 'ADMIN_NAME', 'ADMIN_PASSWORD']) delete env[key];
  return { ...env, ...overrides };
}

test('local evaluator launcher rejects production and nonlocal exposure instead of weakening production', async () => {
  for (const overrides of [{ NODE_ENV: 'production' }, { APP_HOST: '0.0.0.0' }, { APP_ORIGIN: 'https://crm.example.test' }, { APP_ORIGIN: 'http://outside.example.test' }, { PORT: '0' }]) {
    await assert.rejects(exec(process.execPath, [launcherPath], { cwd: projectRoot, env: launcherEnv(overrides), timeout: 5000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /production|loopback|integer/i);
      return true;
    });
  }
});

test('one-process evaluator serves built pages and authenticated APIs on an isolated loopback port/database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'everbright-client-launch-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [launcherPath], { cwd: projectRoot, env: launcherEnv({ DB_PATH: join(dir, 'client.sqlite'), PORT: String(port), APP_HOST: '::1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Evaluator startup timed out: ${output}`)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Evaluator exited with ${code}: ${output}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetch(origin + '/api/health');
  assert.deepEqual(Object.keys(await health.clone().json()).sort(), ['mode', 'status', 'version']);
  assert.equal((await health.json()).mode, 'evaluator');
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="root"/);
  assert.ok(!/@vite\/client|localhost:517[34]|127\.0\.0\.1:517[34]/.test(html));
  assert.equal((await fetch(origin + '/api/workspace')).status, 401);
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'board@foundation.example', password: 'FoundationDemo!2026' }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /^jordan_everbright_evaluator_session=/, 'Built evaluator sessions must not overwrite the separate development cookie');
  const credentials = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin + '/api/workspace', { headers: { Origin: 'https://outside.example.test', Cookie: cookie } })).status, 403);
  const submitted = await fetch(origin + '/api/records/evaluations', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-CSRF-Token': credentials.csrfToken }, body: JSON.stringify(feedback({ result: 'Passed', actual: 'Isolated client startup and feedback submission succeeded.' })) });
  assert.ok([200, 201].includes(submitted.status), await submitted.text());
  const workspace = await fetch(origin + '/api/workspace', { headers: { Origin: origin, Cookie: cookie } });
  assert.equal(workspace.status, 200);
  assert.ok((await workspace.json()).data.evaluations.some(item => item.actual === 'Isolated client startup and feedback submission succeeded.'));
  assert.ok(output.includes('http://127.0.0.1:'), 'Allowed IPv6 loopback configuration must still bind the client launcher to IPv4 loopback');
});

test('legacy one-way acknowledgment still protects completed interaction identity after reopen', async t => {
 const f=await fixture(t);const w=await f.workspace();const g=w.data.gifts.find(g=>g.type==='Cash');
 const ack=await f.request(`/api/gifts/${g.id}/acknowledge`,{method:'POST',session:f.admin,body:{version:g.version,date:'2026-09-13',channel:'Phone',notes:'Synthetic completed acknowledgment.'}});assert.equal(ack.status,200);
 const saved=(await f.workspace()).data.gifts.find(x=>x.id===g.id);const linked=(await f.workspace()).data.communications.find(x=>x.id===saved.acknowledgment.communicationId);delete linked.giftId;
 f.app.locals.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(linked),'communications',linked.id);
 await f.restart();const other=(await f.workspace()).data.constituents.find(c=>c.id!==linked.constituentId);
 for(const change of [{constituentId:other.id},{status:'Draft'},{channel:'Email'},{date:'2026-09-12'}])assert.equal((await f.patch('communications',linked,change)).status,409);
 assert.equal((await f.request(`/api/records/communications/${linked.id}`,{method:'DELETE',session:f.admin,body:{version:linked.version}})).status,409);
 const expanded=await f.patch('communications',linked,{body:'Expanded factual context, same completed interaction.'});assert.equal(expanded.status,200);assert.equal(expanded.json.record.constituentId,linked.constituentId);
});
