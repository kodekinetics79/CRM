import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { totp } from '../server/mfa.js';
import { inspectProductionReadiness } from '../server/productionReadiness.js';

// Synthetic local test accounts/key only. No external provider or deployment.
const key = '47'.repeat(32), password = 'SyntheticOwnAccount!2026';
const roles = ['admin', 'staff', 'viewer', 'event-helper'];
const origin = 'https://all-user-policy.example.test';
function environment(t, production = true) {
  const names = ['NODE_ENV', 'APP_ORIGIN', 'TRUST_PROXY', 'ALLOW_DEMO', 'EVALUATOR_MODE', 'ENABLE_ACCEPTANCE', 'ADMIN_EMAIL', 'ADMIN_NAME', 'ADMIN_PASSWORD'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, { NODE_ENV: production ? 'production' : 'test', APP_ORIGIN: origin, TRUST_PROXY: 'true' });
  t.after(() => { for (const n of names) if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; });
}
function storageFixture() {
  const objects = new Map(); let hook = null;
  const storage = {
    kind: 'object', scope: { provider: 's3', bucket: 'synthetic-policy-documents', namespace: 'synthetic-policy' },
    async verifyReadiness() { return { verified: true }; },
    stage(p) { return { ...p, ...this.scope, key: `synthetic/${p.tenantId}/${p.documentId}/${p.revision}/${p.attemptId}`, version: null }; },
    async put(ref, bytes) { const result = { ...ref, version: randomUUID(), encryption: 'AES256' }; objects.set(result.key, { ref: result, bytes: Buffer.from(bytes) }); await hook?.('put'); return result; },
    async get(ref) { const stored = objects.get(ref.key); assert.ok(stored); assert.equal(stored.ref.version, ref.version); await hook?.('get'); return stored.bytes; },
    async deleteStaged(ref) { objects.delete(ref.key); }
  };
  return { storage, objects, hook(fn) { hook = fn; } };
}
async function fixture(t, { production = true, external = false } = {}) {
  environment(t, production);
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-all-user-integrity-')), dbPath = join(dir, 'workspace.sqlite'), tenantId = randomUUID();
  const privateObjects = storageFixture(); let app, server, base, time = 1700000010000, active = true;
  async function open() {
    app = createApp({ dbPath, seed: false, initialAdmin: { name: 'Synthetic bootstrap owner', email: 'bootstrap.policy@example.test', password }, tenantId,
      mfaKey: key, mfaClock: () => time, isTenantActive: () => active, reminderWorker: false, workflowWorker: false,
      ...(external ? { documentStorage: privateObjects.storage } : {}) });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(base + path, { method, headers: { Origin: origin, 'X-Forwarded-Proto': 'https',
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie } : {}),
      ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text, headers: response.headers };
  }
  const session = result => ({ ...result.json, cookie: result.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') });
  const login = email => request('/auth/login', { method: 'POST', body: { email, password } });
  async function enroll(account) {
    const start = await request('/auth/mfa/enroll', { method: 'POST', session: account, body: { password } }); assert.equal(start.status, 200, start.text);
    const confirm = await request('/auth/mfa/confirm', { method: 'POST', session: account, body: { code: totp(start.json.secret, time) } }); assert.equal(confirm.status, 200, confirm.text);
    return { secret: start.json.secret, ...confirm.json };
  }
  async function verify(email, code) {
    const challenge = await login(email); assert.equal(challenge.json.mfaRequired, true, challenge.text);
    const result = await request('/auth/mfa/verify', { method: 'POST', body: { challengeToken: challenge.json.challengeToken, code } });
    return { ...result, session: session(result) };
  }
  let bootstrap = session(await login('bootstrap.policy@example.test'));
  if (production) { const factors = await enroll(bootstrap); bootstrap = (await verify(bootstrap.user.email, factors.recoveryCodes[0])).session; }
  async function create(collection, body) { const result = await request('/records/' + collection, { method: 'POST', session: bootstrap, body }); assert.equal(result.status, 201, result.text); return result.json.record; }
  const subjects = {};
  for (const role of roles) {
    const email = role.replace('-', '') + '.policy@example.test';
    const result = await request('/users', { method: 'POST', session: bootstrap, body: { name: 'Synthetic ' + role, email, password, role } }); assert.equal(result.status, 201, result.text);
    subjects[role] = { id: result.json.user.id, email };
  }
  const person = await create('constituents', { name: 'Synthetic protected roster identity', type: 'Staff', preference: 'Post' });
  let event = await create('events', { name: 'Synthetic assigned event', date: '2026-09-13', location: 'Synthetic room', capacity: 5, ticketPrice: 0, sponsorGoal: 0 });
  const registered = await request('/events/' + event.id + '/register', { method: 'POST', session: bootstrap, body: { constituentId: person.id, seating: '' } }); assert.equal(registered.status, 200, registered.text); event = registered.json.record;
  const issued = await request('/event-operations/events/' + event.id + '/tickets', { method: 'POST', session: bootstrap, body: { eventVersion: event.version, constituentId: person.id } }); assert.equal(issued.status, 201, issued.text);
  const grant = await request('/users/' + subjects['event-helper'].id + '/event-access', { method: 'PATCH', session: bootstrap, body: { version: 1, eventIds: [event.id], reason: 'Synthetic approved event assignment' } }); assert.equal(grant.status, 200, grant.text);
  return { request, login, session, enroll, verify, bootstrap, subjects, person, event, ticket: issued.json.ticket, privateObjects, dir, dbPath, tenantId,
    get db() { return app.locals.db; }, runReminders: at => app.locals.runDueReminders(at), runReports: at => app.locals.runDueReports(at), runWorkflows: at => app.locals.runCommunicationWorkflows(at), restart: async () => { await close(); await open(); }, active(value) { active = value; },
    recordSnapshot: () => app.locals.db.prepare('SELECT * FROM records ORDER BY collection,id').all() };
}

test('production password sessions for every interactive role are own-enrollment only and cannot read, write, export or check in', async t => {
  const f = await fixture(t), before = f.recordSnapshot();
  for (const role of roles) {
    const result = await f.login(f.subjects[role].email); assert.equal(result.status, 200); const account = f.session(result);
    assert.equal(result.json.mfaEnrollmentRequired, true, role); assert.equal(result.json.access, 'MFA enrollment only');
    assert.match(result.headers.get('set-cookie'), /Secure/); assert.equal((await f.request('/auth/me', { session: account })).json.mfaEnrollmentRequired, true);
    const status = await f.request('/auth/mfa/status', { session: account }); assert.equal(status.status, 200); assert.equal(status.json.required, true); assert.equal(status.json.enabled, false);
    for (const path of ['/workspace', '/custom-reports/catalog', '/backup', '/documents', '/event-checkin/events', '/event-checkin/events/' + f.event.id]) {
      const denied = await f.request(path, { session: account }); assert.equal(denied.status, 403, role + ' ' + path + ': ' + denied.text); assert.doesNotMatch(denied.text, /protected roster identity|Synthetic assigned event/);
    }
    const actions = [ ['/records/tasks', { title: 'Must not persist', dueDate: '2026-09-13', status: 'Open' }],
      ['/custom-reports/run', { name: 'Forbidden report', entity: 'constituents', columns: ['id', 'name'] }],
      ['/event-checkin/events/' + f.event.id + '/tickets/' + f.ticket.id + '/checkin', { version: f.ticket.version, eventVersion: f.event.version }] ];
    for (const [path, body] of actions) assert.equal((await f.request(path, { method: 'POST', body, session: account })).status, 403, role + ' ' + path);
    assert.equal((await f.request('/auth/mfa/enroll', { method: 'POST', session: account, csrf: false, body: { password } })).status, 403);
    assert.equal((await f.request('/auth/mfa/enroll', { method: 'POST', session: account, body: { password, userId: f.bootstrap.user.id } })).status, 400);
    assert.equal((await f.request('/auth/logout', { method: 'POST', session: account })).status, 200);
    assert.equal((await f.request('/auth/me', { session: account })).status, 401);
  }
  assert.deepEqual(f.recordSnapshot(), before); assert.equal(f.db.prepare('SELECT checked_in_at FROM event_tickets WHERE id=?').get(f.ticket.id).checked_in_at, null);
});

test('each production role confirms its own factor, revokes password sessions, verifies freshly and cannot disable mandatory MFA', async t => {
  const f = await fixture(t);
  for (const role of roles) {
    const subject = f.subjects[role], account = f.session(await f.login(subject.email)), other = f.session(await f.login(subject.email)), factors = await f.enroll(account);
    for (const old of [account, other]) assert.equal((await f.request('/auth/me', { session: old })).status, 401);
    const challenge = await f.login(subject.email); assert.equal(challenge.json.mfaRequired, true); assert.equal(challenge.headers.get('set-cookie'), null); assert.equal(challenge.json.csrfToken, undefined);
    const verified = await f.request('/auth/mfa/verify', { method: 'POST', body: { challengeToken: challenge.json.challengeToken, code: factors.recoveryCodes[0] } }); assert.equal(verified.status, 200, verified.text);
    const fresh = f.session(verified); assert.equal((await f.request('/auth/mfa/status', { session: fresh })).json.required, true);
    assert.equal((await f.request('/auth/mfa/disable', { method: 'POST', session: fresh, body: { password, code: factors.recoveryCodes[1] } })).status, 403, role);
    const reuse = await f.verify(subject.email, factors.recoveryCodes[0]); assert.equal(reuse.status, 401, role);
    if (role === 'event-helper') {
      assert.equal((await f.request('/workspace', { session: fresh })).status, 403);
      const roster = await f.request('/event-checkin/events/' + f.event.id, { session: fresh }); assert.equal(roster.status, 200, roster.text); assert.equal(roster.json.tickets[0].attendeeName, f.person.name);
      assert.equal((await f.request('/event-checkin/events/' + f.event.id + '/tickets/' + f.ticket.id + '/checkin', { method: 'POST', session: fresh, body: { version: f.ticket.version, eventVersion: f.event.version } })).status, 200);
    } else {
      assert.equal((await f.request('/workspace', { session: fresh })).status, 200);
      const report = await f.request('/custom-reports/run', { method: 'POST', session: fresh, body: { name: 'Own authorized report', entity: 'constituents', columns: ['id', 'name'] } }); assert.equal(report.status, 200, report.text); assert.deepEqual(report.json.rows, [[f.person.id, f.person.name]]);
      const mutation = await f.request('/records/tasks', { method: 'POST', session: fresh, body: { title: 'Role authorized task', dueDate: '2026-09-13', status: 'Open' } }); assert.equal(mutation.status, role === 'viewer' ? 403 : 201, mutation.text);
    }
  }
});

test('required all-role factors survive restart and pending challenges/account bindings cannot outlive role change or suspension', async t => {
  const f = await fixture(t), enrolled = {};
  for (const role of roles) { const account = f.session(await f.login(f.subjects[role].email)); enrolled[role] = await f.enroll(account); }
  await f.restart();
  for (const role of roles) { const result = await f.verify(f.subjects[role].email, enrolled[role].recoveryCodes[0]); assert.equal(result.status, 200, result.text); assert.equal((await f.request('/auth/mfa/status', { session: result.session })).json.required, true); }
  const staff = f.subjects.staff, pending = await f.login(staff.email);
  f.db.prepare("UPDATE users SET role='viewer',version=version+1 WHERE id=?").run(staff.id);
  assert.equal((await f.request('/auth/mfa/verify', { method: 'POST', body: { challengeToken: pending.json.challengeToken, code: enrolled.staff.recoveryCodes[1] } })).status, 401);
  const current = await f.verify(staff.email, enrolled.staff.recoveryCodes[1]); assert.equal(current.status, 200); assert.equal(current.session.user.role, 'viewer');
  f.db.prepare('UPDATE users SET active=0,version=version+1 WHERE id=?').run(staff.id);
  assert.equal((await f.request('/workspace', { session: current.session })).status, 401); assert.equal((await f.login(staff.email)).status, 401);
});

test('local nonproduction accounts retain optional MFA without making helper privileges broader', async t => {
  const f = await fixture(t, { production: false });
  for (const role of roles) {
    const result = await f.login(f.subjects[role].email), account = f.session(result); assert.equal(result.status, 200); assert.equal(result.json.mfaEnrollmentRequired, undefined);
    const status = await f.request('/auth/mfa/status', { session: account }); assert.equal(status.json.enabled, false); assert.notEqual(status.json.required, true);
    assert.equal((await f.request('/workspace', { session: account })).status, role === 'event-helper' ? 403 : 200);
    if (role === 'event-helper') assert.equal((await f.request('/event-checkin/events/' + f.event.id, { session: account })).status, 200);
  }
  const viewer = f.session(await f.login(f.subjects.viewer.email)), factors = await f.enroll(viewer), verified = await f.verify(viewer.user.email, factors.recoveryCodes[0]); assert.equal(verified.status, 200);
  assert.equal((await f.request('/auth/mfa/disable', { method: 'POST', session: verified.session, body: { password, code: factors.recoveryCodes[1] } })).status, 200);
  assert.ok((await f.login(viewer.user.email)).json.csrfToken);
});

test('async exact document read and upload recheck factor loss even when user and session rows remain current', async t => {
  const f = await fixture(t, { external: true }), users = {};
  for (const role of ['staff', 'viewer']) { const account = f.session(await f.login(f.subjects[role].email)), factors = await f.enroll(account); users[role] = (await f.verify(account.user.email, factors.recoveryCodes[0])).session; }
  const body = { title: 'Synthetic all-user protected bytes', category: 'Report', status: 'Final', visibility: 'Workspace', evidenceDate: '2026-09-13', collection: 'constituents', recordId: f.person.id, filename: 'policy.txt', contentBase64: Buffer.from('Synthetic private evidence').toString('base64') };
  const uploaded = await f.request('/documents', { method: 'POST', session: users.staff, body }); assert.equal(uploaded.status, 201, uploaded.text);
  const auditBefore = f.db.prepare("SELECT count(*) n FROM audit WHERE action='download_document'").get().n;
  f.privateObjects.hook(stage => { if (stage === 'get') f.db.prepare('UPDATE mfa_settings SET enabled=0 WHERE user_id=?').run(users.viewer.user.id); });
  const read = await f.request('/documents/' + uploaded.json.document.id + '/revisions/1/content', { session: users.viewer }); assert.equal(read.status, 401, read.text); assert.equal(read.json.contentBase64, undefined); assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='download_document'").get().n, auditBefore);
  f.privateObjects.hook(stage => { if (stage === 'put') f.db.prepare('UPDATE mfa_settings SET enabled=0 WHERE user_id=?').run(users.staff.user.id); });
  const failed = await f.request('/documents', { method: 'POST', session: users.staff, body: { ...body, title: 'Must not become usable evidence' } }); assert.equal(failed.status, 401, failed.text);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get().n, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM document_revisions').get().n, 1); assert.equal(f.privateObjects.objects.size, 1);
  assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(users.staff.user.id).active, 1);
  assert.ok(f.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(users.staff.user.id));
});

test('production readiness rejects each unenrolled active interactive role and accepts inactive account exclusion only', async t => {
  const f = await fixture(t), now = Date.now(), archiveSha256 = 'a'.repeat(64);
  const input = { db: f.db, dbPath: f.dbPath, durableRoot: f.dir, expectedTenantId: f.tenantId, now,
    env: { NODE_ENV: 'production', APP_ORIGIN: origin, MFA_ENCRYPTION_KEY: key, BACKUP_ENCRYPTION_KEY: '48'.repeat(32), PERSISTENT_STORAGE_CONFIRMED: 'true' },
    recoveryEvidence: { tenantId: f.tenantId, backup: { tenantId: f.tenantId, verified: true, offHost: true, archiveSha256, createdAt: new Date(now).toISOString() }, restore: { tenantId: f.tenantId, verified: true, archiveSha256, restoredAt: new Date(now).toISOString() }, retention: { approved: true, backupDays: 30 } }, monitoring: { probe: async () => ({ verified: true }) } };
  f.db.prepare("UPDATE users SET active=0 WHERE email<>'bootstrap.policy@example.test'").run();
  assert.equal((await inspectProductionReadiness(input)).ready, true);
  for (const role of roles) {
    const id = f.subjects[role].id; f.db.prepare('UPDATE users SET active=1 WHERE id=?').run(id);
    const blocked = await inspectProductionReadiness(input); assert.equal(blocked.ready, false, role + ' unenrolled account must block admission');
    assert.ok(blocked.checks.some(c => c.status === 'blocked' && /MFA|factor/i.test(c.detail)));
    const account = f.session(await f.login(f.subjects[role].email)); await f.enroll(account);
    assert.equal((await inspectProductionReadiness(input)).ready, true, role + ' enrolled admission');
    f.db.prepare('UPDATE mfa_settings SET encrypted_secret=? WHERE user_id=?').run('INVALID_SYNTHETIC_ENROLLMENT', id);
    assert.equal((await inspectProductionReadiness(input)).ready, false, role + ' unusable enrollment');
    f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(id);
    assert.equal((await inspectProductionReadiness(input)).ready, true, 'inactive account is not an interactive admission');
  }
});


test('business gate freshly rejects factor loss during authentication session renewal rather than trusting cached verified state', async t => {
  const f = await fixture(t), account = f.session(await f.login(f.subjects.staff.email)), factors = await f.enroll(account), verified = await f.verify(account.user.email, factors.recoveryCodes[0]);
  f.db.exec(`CREATE TRIGGER synthetic_factor_loss_after_auth AFTER UPDATE OF last_seen ON sessions WHEN NEW.user_id='${account.user.id}' BEGIN UPDATE mfa_settings SET enabled=0 WHERE user_id=NEW.user_id; END;`);
  const denied = await f.request('/workspace', { session: verified.session }); assert.equal(denied.status, 403, denied.text); assert.equal(denied.json.data, undefined); assert.equal(denied.json.mfaEnrollmentRequired, true);
  assert.ok(f.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(account.user.id)); assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(account.user.id).active, 1);
});

test('durable report/reminder/workflow authorization survives logout but both removed and unusable owner factors deny later effects', async t => {
  const f = await fixture(t), clock = Date.now(), financialBefore = f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all();
  for (const [role, invalidation] of [['staff', 'disabled'], ['admin', 'unavailable']]) {
    const account = f.session(await f.login(f.subjects[role].email)), factors = await f.enroll(account), fresh = (await f.verify(account.user.email, factors.recoveryCodes[0])).session;
    async function post(path, body, session = fresh) { const r = await f.request(path, { method: 'POST', session, body }); assert.equal(r.status, 201, r.text); return r.json; }
    const tasks = [];
    for (let i=0;i<2;i++) tasks.push((await post('/records/tasks', { title: `Synthetic ${role} durable action ${i}`, dueDate: new Date(clock+86400000).toISOString().slice(0,10), status: 'Open', ownerId: account.user.id })).record);
    const reminders = [];
    for (let i=0;i<2;i++) reminders.push((await post('/tasks/'+tasks[i].id+'/reminders', { taskVersion: 1, ownerVersion: 1, remindAt: new Date(clock+60000+i*7200000).toISOString() })).reminder);
    const report = (await post('/custom-reports', { name: `Synthetic ${role} durable report`, entity: 'constituents', columns: ['id','name'] })).report;
    const schedule = (await post('/report-schedules', { reportId: report.id, name: 'Explicit internal schedule', cadence: 'Hourly', startAt: new Date(clock+60000).toISOString() })).schedule;
    const token = 'Episode-'+role;
    const audience = (await post('/audiences', { name: 'Synthetic owner factor audience '+role, filters: { segmentTokens:[token], segmentMatch:'Any', types:[], preferences:[] } })).audience;
    const template = (await post('/correspondence/templates', { name:'Synthetic unsent owner template',kind:'Messaging',subject:'Hello {{recipientName}}',body:'Original unsent draft for {{recipientName}}.' })).template;
    const preview = await f.request('/audiences/'+audience.id+'/preview?version=1&channel=Print',{session:fresh}); assert.equal(preview.status,200,preview.text);
    const workflow = (await post('/communication-workflows', { name:'Synthetic durable '+role, audienceId:audience.id,audienceVersion:1,sourceDigest:preview.json.sourceDigest,templateId:template.id,templateVersion:1,channel:'Print',confirmed:true })).workflow;
    const first = (await post('/records/constituents',{name:'Synthetic prospective first '+role,type:'Individual',preference:'Post',segments:'Other'},f.bootstrap)).record;
    const second = (await post('/records/constituents',{name:'Synthetic prospective second '+role,type:'Individual',preference:'Post',segments:'Other'},f.bootstrap)).record;
    f.runWorkflows(clock); // observe non-members before entry; arming itself never backfills.
    assert.equal((await f.request('/auth/logout',{method:'POST',session:fresh})).status,200);
    const entered = await f.request('/records/constituents/'+first.id,{method:'PATCH',session:f.bootstrap,body:{version:1,segments:token}});assert.equal(entered.status,200,entered.text);
    assert.equal(f.runReminders(clock+60000).delivered,1);
    assert.equal(f.runReports(clock+60000).produced,1);
    assert.equal(f.runWorkflows(clock+60000).drafted,1);
    const currentEntry = await f.request('/records/constituents/'+second.id,{method:'PATCH',session:f.bootstrap,body:{version:1,segments:token}});assert.equal(currentEntry.status,200,currentEntry.text);
    if(invalidation==='disabled')f.db.prepare('UPDATE mfa_settings SET enabled=0 WHERE user_id=?').run(account.user.id);
    else f.db.prepare('UPDATE mfa_settings SET encrypted_secret=? WHERE user_id=?').run('INVALID_SYNTHETIC_FACTOR',account.user.id);
    const reminderOutcome=f.runReminders(clock+3660000);assert.equal(reminderOutcome.delivered,0);assert.equal(reminderOutcome.suppressed,1);
    assert.equal(f.db.prepare('SELECT status FROM task_reminders WHERE id=?').get(reminders[1].id).status,'Suppressed');
    assert.equal(f.db.prepare('SELECT count(*) n FROM task_reminder_inbox WHERE reminder_id=?').get(reminders[1].id).n,0);
    const reportOutcome=f.runReports(clock+3660000);assert.equal(reportOutcome.produced,0);assert.equal(reportOutcome.failed,1);
    const failed=f.db.prepare("SELECT * FROM report_deliveries WHERE schedule_id=? AND status='Failed'").get(schedule.id);assert.ok(failed);assert.equal(failed.result,null);
    const workflowOutcome=f.runWorkflows(clock+3660000);assert.equal(workflowOutcome.drafted,0);assert.equal(f.db.prepare('SELECT status FROM communication_workflows WHERE id=?').get(workflow.id).status,'Suppressed');
    assert.equal(f.db.prepare('SELECT count(*) n FROM communication_workflow_executions WHERE workflow_id=?').get(workflow.id).n,1);
    assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(account.user.id).active,1);
    // Retire this schedule to isolate the next owner, using the still-valid bootstrap account.
    const saved=f.db.prepare('SELECT version FROM report_schedules WHERE id=?').get(schedule.id);
    assert.equal((await f.request('/report-schedules/'+schedule.id,{method:'PATCH',session:f.bootstrap,body:{version:saved.version,status:'Retired',reason:'Synthetic completed independent owner scenario'}})).status,200);
  }
  assert.deepEqual(f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all(),financialBefore);
  const communications=f.db.prepare("SELECT data FROM records WHERE collection='communications'").all().map(r=>JSON.parse(r.data));assert.equal(communications.length,2);assert.ok(communications.every(r=>r.status==='Draft'));assert.ok(communications.every(r=>!r.giftId&&!r.receiptId));
});
