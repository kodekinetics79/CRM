import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { createPlatformApp } from '../server/platform.js';

const password = 'SyntheticTaskReminderAcceptance!2026', poison = 'PRIVATE_TASK_FINANCIAL_NOTES_MARKER';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-task-reminder-integrity-')), dbPath = join(dir, 'workspace.sqlite'), initialAdmin = { name: 'Synthetic reminder administrator', email: 'admin.reminder@example.test', password };
  let app, server, base, active = true, time = Date.now();
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function open() { app = createApp({ dbPath, seed: false, initialAdmin, isTenantActive: () => active, reminderClock: () => time, reminderWorker: false }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; } return { status: response.status, json, text };
  }
  async function login(email = initialAdmin.email) { const result = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); assert.equal(result.status, 200); return { ...await result.json(), cookie: result.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }; }
  const sessions = { admin: await login() };
  for (const [key, role] of [['staff', 'staff'], ['other', 'staff'], ['viewer', 'viewer'], ['helper', 'event-helper']]) { const result = await request('/users', { method: 'POST', session: sessions.admin, body: { name: 'Synthetic reminder ' + key, email: key + '.reminder@example.test', password, role } }); assert.equal(result.status, 201, result.text); sessions[key] = await login(key + '.reminder@example.test'); }
  async function create(collection, body) { const result = await request('/records/' + collection, { method: 'POST', session: sessions.admin, body }); assert.equal(result.status, 201, result.text); return result.json.record; }
  const donor = await create('constituents', { name: 'Synthetic reminder donor', type: 'Individual', email: 'donor.reminder@example.test', notes: poison }), fund = await create('designations', { name: 'Synthetic fund', accountCode: 'REMINDER-101' });
  await create('gifts', { constituentId: donor.id, amount: 10001, type: 'Cash', method: 'Check', date: new Date(time).toISOString().slice(0, 10), allocations: [{ designationId: fund.id, amount: 10001 }], notes: poison });
  async function task(changes = {}) { return create('tasks', { title: 'Synthetic owner action', dueDate: new Date(time + 120000).toISOString().slice(0, 10), ownerId: sessions.staff.user.id, status: 'Open', constituentId: donor.id, notes: poison, ...changes }); }
  const original = await task();
  const snapshot = () => Object.fromEntries(app.locals.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='sessions' ORDER BY name").all().map(({ name }) => [name, app.locals.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
  async function remind(source = original, changes = {}, session = sessions.staff) { return request('/tasks/' + source.id + '/reminders', { method: 'POST', session, body: { taskVersion: source.version, ownerVersion: app.locals.db.prepare('SELECT version FROM users WHERE id=?').get(source.ownerId).version, remindAt: new Date(time + 120000).toISOString(), ...changes } }); }
  const run = at => { assert.equal(typeof app.locals.runDueReminders, 'function'); return app.locals.runDueReminders(at ?? time); };
  const inbox = session => request('/reminder-inbox', { session: session || sessions.staff });
  async function update(source, changes) { const result = await request('/records/tasks/' + source.id, { method: 'PATCH', session: sessions.admin, body: { version: source.version, ...changes } }); assert.equal(result.status, 200, result.text); return result.json.record; }
  return { request, sessions, original, task, remind, run, inbox, snapshot, update, dbPath, initialAdmin, get app() { return app; }, get db() { return app.locals.db; }, get time() { return time; }, set time(value) { time = value; }, set active(value) { active = value; }, restart: async () => { await close(); await open(); for (const key of Object.keys(sessions)) sessions[key] = await login(key === 'admin' ? initialAdmin.email : key + '.reminder@example.test'); } };
}

test('reminders require explicit valid UTC timing and current owner versions without granting helpers, viewers or other staff task notification access', async t => {
  const f = await fixture(t), path = '/tasks/' + f.original.id + '/reminders';
  for (const session of [f.sessions.viewer, f.sessions.helper, f.sessions.other, f.sessions.admin]) {
    const before = f.snapshot(), result = await f.remind(f.original, {}, session); assert.ok([403, 404].includes(result.status), result.text); assert.ok(!result.text.includes(poison)); assert.deepEqual(f.snapshot(), before);
  }
  for (const session of [f.sessions.viewer, f.sessions.helper]) {
    const before = f.snapshot(); assert.equal((await f.request('/records/tasks/' + f.original.id, { method: 'PATCH', session, body: { version: f.original.version, status: 'Completed' } })).status, 403); assert.deepEqual(f.snapshot(), before);
  }
  for (const changes of [{ taskVersion: 99 }, { ownerVersion: 99 }, { remindAt: '2026-02-30T00:00:00Z' }, { remindAt: '2026-09-13T09:00:00' }, { remindAt: '2026-09-13T09:00:00+02:00' }, { remindAt: '' }, { remindAt: new Date(f.time - 120000).toISOString() }, { remindAt: new Date(f.time + 367 * 86400000).toISOString() }, { extra: true }]) {
    const before = f.snapshot(), result = await f.remind(f.original, changes); assert.ok([400, 409].includes(result.status), result.text); assert.deepEqual(f.snapshot(), before);
  }
  assert.equal((await f.request(path, { method: 'POST', session: f.sessions.staff, csrf: false, body: { taskVersion: 1, ownerVersion: 1, remindAt: new Date(f.time + 120000).toISOString() } })).status, 403);
  const created = await f.remind(); assert.equal(created.status, 201, created.text); assert.equal((await f.remind()).status, 409);
  for (const session of [f.sessions.viewer, f.sessions.helper]) { assert.equal((await f.inbox(session)).status, 403); assert.equal((await f.request('/task-reminders', { session })).status, 403); }
  for (const session of [f.sessions.other, f.sessions.admin]) { assert.deepEqual((await f.inbox(session)).json.items, []); const detail = await f.request('/task-reminders/' + created.json.reminder.id, { session }); assert.ok([403, 404].includes(detail.status), detail.text); assert.ok(!detail.text.includes(f.original.title)); }
});

test('an explicit UTC boundary delivers once after restart and never writes gifts, communications or extra native task transitions', async t => {
  const f = await fixture(t), at = f.time + 120000, created = await f.remind(); assert.equal(created.status, 201, created.text); const native = f.snapshot().records;
  assert.equal(f.run(at - 1).delivered, 0); assert.deepEqual((await f.inbox()).json.items, []); await f.restart();
  const due = f.run(at); assert.equal(due.delivered, 1); assert.equal(due.suppressed, 0); assert.equal(due.failed, 0); const first = await f.inbox(); assert.equal(first.status, 200); assert.equal(first.json.items.length, 1); assert.ok(!first.text.includes(poison)); assert.ok(!/owner_binding|password|email|provider|recipientEmail/.test(first.text));
  assert.equal(f.db.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 1); assert.deepEqual(f.snapshot().records, native); const after = f.snapshot();
  assert.equal(f.run(at).delivered, 0); assert.equal(f.run(at + 86400000).delivered, 0); assert.deepEqual(f.snapshot(), after); await f.restart(); assert.equal(f.run(at + 86400000).delivered, 0); assert.equal((await f.inbox()).json.items.length, 1);
  const reminder = await f.request('/task-reminders/' + created.json.reminder.id, { session: f.sessions.staff }); assert.equal(reminder.status, 200); assert.equal(reminder.json.reminder.status, 'Delivered'); assert.equal(reminder.json.outcomes.filter(outcome => outcome.status === 'Delivered').length, 1);
});

test('completion, reassignment, deadline changes and owner account changes suppress stale reminders rather than retargeting recipients', async t => {
  for (const change of ['completion', 'reassignment', 'deadline', 'account']) {
    const f = await fixture(t), created = await f.remind(); assert.equal(created.status, 201);
    if (change === 'completion') await f.update(f.original, { status: 'Completed' });
    else if (change === 'reassignment') await f.update(f.original, { ownerId: f.sessions.other.user.id, assignmentReason: 'Explicit responsibility transfer' });
    else if (change === 'deadline') await f.update(f.original, { dueDate: new Date(f.time + 86400000).toISOString().slice(0, 10) });
    else { const result = await f.request('/users/' + f.sessions.staff.user.id, { method: 'PATCH', session: f.sessions.admin, body: { version: 1, role: 'viewer', active: true } }); assert.equal(result.status, 200); }
    const native = f.snapshot().records, outcome = f.run(f.time + 120000); assert.equal(outcome.delivered, 0, change); assert.equal(outcome.suppressed, 1, change); assert.equal(f.db.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 0); assert.equal(f.db.prepare('SELECT status FROM task_reminders WHERE id=?').get(created.json.reminder.id).status, 'Suppressed'); assert.deepEqual(f.snapshot().records, native);
    assert.deepEqual((await f.inbox(f.sessions.other)).json.items, []);
  }
});

test('suspension suppresses pending future reminders permanently and delivered notification titles disappear when current source no longer matches', async t => {
  const f = await fixture(t), created = await f.remind(); assert.equal(created.status, 201); f.active = false;
  const suspended = f.run(f.time); assert.equal(suspended.suspended, true); assert.equal(suspended.delivered, 0); assert.equal(f.db.prepare('SELECT status FROM task_reminders WHERE id=?').get(created.json.reminder.id).status, 'Suppressed'); assert.equal((await f.inbox()).status, 403);
  f.active = true; assert.equal(f.run(f.time + 120000).delivered, 0); assert.deepEqual((await f.inbox()).json.items, []);
  const nextTask = await f.task({ title: 'Second current source task' }), next = await f.remind(nextTask); assert.equal(next.status, 201); assert.equal(f.run(f.time + 120000).delivered, 1); assert.equal((await f.inbox()).json.items.length, 1);
  await f.update(nextTask, { status: 'Completed' }); assert.deepEqual((await f.inbox()).json.items, []); const detail = await f.request('/task-reminders/' + next.json.reminder.id, { session: f.sessions.staff }); assert.equal(detail.status, 200); assert.ok(!detail.text.includes(nextTask.title)); assert.ok(!detail.text.includes(poison));
});

test('owner cancellation is versioned and reasoned and retained reminder outcome and inbox rows cannot be rewritten', async t => {
  const f = await fixture(t), created = await f.remind(); assert.equal(created.status, 201); const reminder = created.json.reminder, path = '/task-reminders/' + reminder.id + '/cancel';
  for (const body of [{ version: reminder.version, reason: '' }, { version: 99, reason: 'Stale cancel' }, { version: reminder.version, reason: 'Explicit cancel', extra: true }]) { const before = f.snapshot(), result = await f.request(path, { method: 'POST', session: f.sessions.staff, body }); assert.ok([400, 409].includes(result.status), result.text); assert.deepEqual(f.snapshot(), before); }
  const cancelled = await f.request(path, { method: 'POST', session: f.sessions.staff, body: { version: reminder.version, reason: 'Explicitly cancelled owner reminder' } }); assert.equal(cancelled.status, 200); assert.equal(f.run(f.time + 120000).delivered, 0); assert.equal((await f.request(path, { method: 'POST', session: f.sessions.staff, body: { version: cancelled.json.reminder.version, reason: 'Repeat cancellation' } })).status, 409);
  assert.throws(() => f.db.prepare('DELETE FROM task_reminder_outcomes WHERE reminder_id=?').run(reminder.id), /retained|immutable/);
  assert.throws(() => f.db.prepare('UPDATE task_reminder_outcomes SET reason=? WHERE reminder_id=?').run('Changed', reminder.id), /immutable/);
});

test('two independent worker threads share one durable reminder delivery under a simultaneous write race', async t => {
  const f = await fixture(t), created = await f.remind(); assert.equal(created.status, 201);
  const code = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {createApp}=await import(workerData.appUrl);const app=createApp({dbPath:workerData.dbPath,seed:false,initialAdmin:workerData.initialAdmin,reminderWorker:false});app.locals.db.exec('PRAGMA busy_timeout=5000');parentPort.postMessage({ready:true});parentPort.once('message',()=>{try{const outcome=app.locals.runDueReminders(workerData.at);app.locals.close();parentPort.postMessage({outcome});}catch(error){app.locals.close();parentPort.postMessage({error:error.message});}});})().catch(error=>parentPort.postMessage({error:error.message}));`;
  async function start() {
    const worker = new Worker(code, { eval: true, workerData: { appUrl: new URL('../server/app.js', import.meta.url).href, dbPath: f.dbPath, initialAdmin: f.initialAdmin, at: f.time + 120000 } }); t.after(() => worker.terminate());
    await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', message => message.ready ? resolve() : reject(new Error(message.error))); }); return worker;
  }
  const workers = [await start(), await start()], outcomes = workers.map(worker => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.outcome)); }));
  for (const worker of workers) worker.postMessage('run'); const results = await Promise.all(outcomes);
  assert.equal(results.reduce((sum, result) => sum + result.delivered, 0), 1); assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0); assert.equal(f.db.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 1); assert.equal((await f.inbox()).json.items.length, 1);
});

test('deferred COMMIT failure cannot claim delivery and leaves a dated retry that succeeds exactly once after repair', async t => {
  const f = await fixture(t), created = await f.remind(); assert.equal(created.status, 201); const at = f.time + 120000, native = f.snapshot().records;
  f.db.exec("CREATE TABLE synthetic_deferred_reminder_fault(owner_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_synthetic_reminder_commit AFTER INSERT ON task_reminder_inbox BEGIN INSERT INTO synthetic_deferred_reminder_fault VALUES('missing-synthetic-account'); END");
  const failed = f.run(at); assert.equal(failed.delivered, 0); assert.equal(failed.failed, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM synthetic_deferred_reminder_fault').get().n, 0); assert.deepEqual(f.snapshot().records, native);
  const reminder = f.db.prepare('SELECT * FROM task_reminders WHERE id=?').get(created.json.reminder.id); assert.equal(reminder.status, 'Active'); assert.equal(reminder.next_attempt, new Date(at + 60000).toISOString());
  const history = await f.request('/task-reminders/' + created.json.reminder.id, { session: f.sessions.staff }); assert.equal(history.status, 200); assert.equal(history.json.outcomes[0].status, 'Failed'); assert.equal(history.json.outcomes[0].retryAt, new Date(at + 60000).toISOString());
  assert.equal(f.run(at + 59999).delivered, 0); f.db.exec('DROP TRIGGER fail_synthetic_reminder_commit'); assert.equal(f.run(at + 60000).delivered, 1); assert.equal(f.run(at + 60000).delivered, 0); assert.equal((await f.inbox()).json.items.length, 1);
});

test('persistent actor-audit outage rolls back delivery and retry evidence without recording a false inbox success', async t => {
  const f = await fixture(t), created = await f.remind(); assert.equal(created.status, 201);
  f.db.exec("CREATE TRIGGER fail_synthetic_all_reminder_audits BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic reminder audit outage'); END");
  const before = f.snapshot(), failed = f.run(f.time + 120000); assert.equal(failed.delivered, 0); assert.equal(failed.failed, 1); assert.deepEqual(f.snapshot(), before); assert.equal((await f.inbox()).json.items.length, 0);
  f.db.exec('DROP TRIGGER fail_synthetic_all_reminder_audits'); assert.equal(f.run(f.time + 120000).delivered, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 1);
});

async function platformReminderFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-reminder-platform-cycle-')), children = new Map(), now = Date.now();
  const platformAdmin = { name: 'Synthetic platform reminder operator', email: 'platform.reminder@example.test', password }, tenantAdmin = { name: 'Synthetic tenant reminder owner', email: 'tenant.reminder@example.test', password };
  const app = createPlatformApp({ rootDir: join(dir, 'registry'), legacyDbPath: join(dir, 'legacy.sqlite'), seedLegacy: false, initialPlatformAdmin: platformAdmin, tenantFactory: args => { const child = createApp({ ...args, reminderClock: () => now, reminderWorker: false }); children.set(args.tenantInfo.slug, child); return child; } });
  let registry; const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { registry?.close(); await new Promise(resolve => server.close(resolve)); app.locals.close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, body, session, method = body === undefined ? 'GET' : 'POST') { const response = await fetch('http://127.0.0.1:' + server.address().port + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, json: await response.json(), headers: response.headers }; }
  const platformLogin = await request('/api/platform/auth/login', { email: platformAdmin.email, password }); assert.equal(platformLogin.status, 200); const operator = { ...platformLogin.json, cookie: platformLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const tenant = await request('/api/platform/tenants', { slug: 'reminder-rapid', name: 'Synthetic rapid reminder tenant', plan: 'trial', admin: tenantAdmin, dataMode: 'restricted', aiEnabled: false }, operator); assert.equal(tenant.status, 201, JSON.stringify(tenant.json));
  const loggedIn = await request('/api/auth/login', { email: tenantAdmin.email, password, tenantSlug: 'reminder-rapid' }); assert.equal(loggedIn.status, 200); const owner = { ...loggedIn.json, cookie: loggedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const task = await request('/api/records/tasks', { title: 'Future rapid-cycle reminder', dueDate: new Date(now + 86400000).toISOString().slice(0, 10), ownerId: owner.user.id, status: 'Open' }, owner); assert.equal(task.status, 201);
  const created = await request('/api/tasks/' + task.json.record.id + '/reminders', { taskVersion: 1, ownerVersion: 1, remindAt: new Date(now + 86400000).toISOString() }, owner); assert.equal(created.status, 201, JSON.stringify(created.json));
  registry = new DatabaseSync(join(dir, 'registry', 'platform.sqlite'));
  return { dir, request, operator, owner, tenant, created, child: children.get('reminder-rapid'), registry, now };
}

test('a rapid platform suspend-and-resume suppresses future reminders without requiring a worker tick', async t => {
  const { request, operator, owner, tenant, created, child, now } = await platformReminderFixture(t);
  const suspended = await request('/api/platform/tenants/' + tenant.json.tenant.id, { version: tenant.json.tenant.version, status: 'suspended' }, operator, 'PATCH'); assert.equal(suspended.status, 200, JSON.stringify(suspended.json));
  const resumed = await request('/api/platform/tenants/' + tenant.json.tenant.id, { version: suspended.json.tenant.version, status: 'active' }, operator, 'PATCH'); assert.equal(resumed.status, 200);
  assert.equal(child.locals.db.prepare('SELECT status FROM task_reminders WHERE id=?').get(created.json.reminder.id).status, 'Suppressed'); assert.equal(child.locals.runDueReminders(now + 86400000).delivered, 0); assert.equal(child.locals.db.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 0); assert.equal((await request('/api/reminder-inbox', undefined, owner)).status, 401);
});

test('platform suspension audit failure leaves the active tenant reminders and current owner sessions unchanged', async t => {
  const f = await platformReminderFixture(t), childDb = f.child.locals.db;
  const before = Object.fromEntries(['task_reminders', 'task_reminder_outcomes', 'task_reminder_inbox', 'sessions', 'records'].map(name => [name, childDb.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all()]));
  f.registry.exec("CREATE TRIGGER fail_synthetic_platform_suspension_audit BEFORE INSERT ON platform_audit WHEN NEW.action='update_tenant' BEGIN SELECT RAISE(ABORT,'Synthetic platform audit fault'); END");
  const result = await f.request('/api/platform/tenants/' + f.tenant.json.tenant.id, { version: f.tenant.json.tenant.version, status: 'suspended' }, f.operator, 'PATCH'); assert.equal(result.status, 500);
  const tenant = f.registry.prepare('SELECT * FROM tenants WHERE id=?').get(f.tenant.json.tenant.id); assert.equal(tenant.status, 'active'); assert.equal(tenant.version, f.tenant.json.tenant.version);
  for (const name of Object.keys(before)) assert.deepEqual(childDb.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all(), before[name], name);
  assert.equal((await f.request('/api/reminder-inbox', undefined, f.owner)).status, 200);
});

test('postcommit suppression failure keeps the tenant suspended until effects succeed and pending future reminders remain terminal', async t => {
  const f = await platformReminderFixture(t), childDb = f.child.locals.db, tenantId = f.tenant.json.tenant.id;
  childDb.exec("CREATE TRIGGER fail_synthetic_workspace_suppression_audit BEFORE INSERT ON audit WHEN NEW.action='suppress_task_reminder' BEGIN SELECT RAISE(ABORT,'Synthetic suppression persistence fault'); END");
  const suspended = await f.request('/api/platform/tenants/' + tenantId, { version: f.tenant.json.tenant.version, status: 'suspended' }, f.operator, 'PATCH'); assert.equal(suspended.status, 503);
  let tenant = f.registry.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId); assert.equal(tenant.status, 'suspended'); assert.equal(tenant.version, f.tenant.json.tenant.version + 1); assert.equal(childDb.prepare('SELECT status FROM task_reminders WHERE id=?').get(f.created.json.reminder.id).status, 'Active'); assert.equal((await f.request('/api/reminder-inbox', undefined, f.owner)).status, 403);
  const prematureResume = await f.request('/api/platform/tenants/' + tenantId, { version: tenant.version, status: 'active' }, f.operator, 'PATCH'); assert.ok([500, 503].includes(prematureResume.status), JSON.stringify(prematureResume.json)); assert.equal(f.registry.prepare('SELECT status FROM tenants WHERE id=?').get(tenantId).status, 'suspended'); assert.equal(childDb.prepare('SELECT count(*) n FROM task_reminder_outcomes').get().n, 0);
  childDb.exec('DROP TRIGGER fail_synthetic_workspace_suppression_audit');
  const retried = await f.request('/api/platform/tenants/' + tenantId, { version: tenant.version, status: 'suspended' }, f.operator, 'PATCH'); assert.equal(retried.status, 200); assert.equal(childDb.prepare('SELECT status FROM task_reminders WHERE id=?').get(f.created.json.reminder.id).status, 'Suppressed'); assert.equal(childDb.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  tenant = f.registry.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId); const resumed = await f.request('/api/platform/tenants/' + tenantId, { version: tenant.version, status: 'active' }, f.operator, 'PATCH'); assert.equal(resumed.status, 200);
  assert.equal(f.child.locals.runDueReminders(f.now + 86400000).delivered, 0); assert.equal(childDb.prepare('SELECT count(*) n FROM task_reminder_inbox').get().n, 0); assert.equal((await f.request('/api/reminder-inbox', undefined, f.owner)).status, 401);
});

test('missing tenant storage cannot produce an active lifecycle success when resuming a suspended workspace', async t => {
  const f = await platformReminderFixture(t), tenantId = f.tenant.json.tenant.id, suspended = await f.request('/api/platform/tenants/' + tenantId, { version: f.tenant.json.tenant.version, status: 'suspended' }, f.operator, 'PATCH'); assert.equal(suspended.status, 200);
  const path = join(f.dir, 'registry', 'tenants', tenantId, 'workspace.sqlite'), displaced = path + '.synthetic-missing'; await rename(path, displaced);
  try {
    const result = await f.request('/api/platform/tenants/' + tenantId, { version: suspended.json.tenant.version, status: 'active' }, f.operator, 'PATCH'); assert.equal(result.status, 503); const current = f.registry.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId); assert.equal(current.status, 'suspended'); assert.equal(current.version, suspended.json.tenant.version);
  } finally { await rename(displaced, path); }
  assert.equal(f.child.locals.db.prepare('SELECT status FROM task_reminders WHERE id=?').get(f.created.json.reminder.id).status, 'Suppressed');
});
