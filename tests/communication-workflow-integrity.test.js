import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.js';
import { backupWorkspace, restoreWorkspace } from '../server/backup.js';
import { totp } from '../server/mfa.js';

const password = 'SyntheticProspectiveWorkflowAcceptance!2026', mfaKey = '7'.repeat(64);
const filters = { segmentTokens: ['Welcome'], segmentMatch: 'Any', types: [], preferences: [] };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-communication-workflow-')), dbPath = join(dir, 'workspace.sqlite'), tenantId = randomUUID(), initialAdmin = { name: 'Synthetic workflow administrator', email: 'admin.workflow@example.test', password };
  let app, server, base, active = true, time = Date.now(); const sessions = {};
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, { method = 'GET', body, session = sessions.admin, csrf = true } = {}) { const r = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; } return { status: r.status, json, text, headers: r.headers }; }
  async function login(email = initialAdmin.email) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); assert.equal(r.status, 200); return { ...await r.json(), cookie: r.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }; }
  async function open(path = dbPath) { app = createApp({ dbPath: path, seed: false, tenantId, initialAdmin, mfaKey, mfaClock: () => time, isTenantActive: () => active, workflowClock: () => time, workflowWorker: false }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; sessions.admin = await login(); }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  for (const [key, role] of [['staff', 'staff'], ['other', 'staff'], ['viewer', 'viewer'], ['helper', 'event-helper']]) { const r = await request('/users', { method: 'POST', body: { name: 'Synthetic workflow ' + key, email: key + '.workflow@example.test', password, role } }); assert.equal(r.status, 201, r.text); sessions[key] = await login(key + '.workflow@example.test'); }
  async function create(collection, body) { const r = await request('/records/' + collection, { method: 'POST', body }); assert.equal(r.status, 201, r.text); return r.json.record; }
  const baseline = await create('constituents', { name: 'Already matched baseline donor', type: 'Individual', preference: 'Email', email: 'baseline.workflow@example.test', segments: 'Welcome', notes: 'PRIVATE_FINANCIAL_HISTORY_MARKER' });
  const outsider = await create('constituents', { name: 'Prospective donor', type: 'Staff', preference: 'Email', email: 'prospective.workflow@example.test', segments: 'Other', contacts: [{ name: 'Secondary contact', email: 'secondary.workflow@example.test', role: 'No consent inference' }] });
  const fund = await create('designations', { name: 'Synthetic unchanged workflow fund', accountCode: 'WORKFLOW-101' }); await create('gifts', { constituentId: baseline.id, amount: 10001, type: 'Cash', method: 'Check', date: new Date(time).toISOString().slice(0, 10), allocations: [{ designationId: fund.id, amount: 10001 }] });
  const a = await request('/audiences', { method: 'POST', session: sessions.staff, body: { name: 'Prospective welcome audience', filters } }); assert.equal(a.status, 201); const audience = a.json.audience;
  const templateBody = { name: 'Prospective Messaging only', kind: 'Messaging', subject: 'Welcome {{recipientName}}', body: 'Hello {{recipientName}} from {{organizationName}}. Review this original unsent draft.' };
  const templateResult = await request('/correspondence/templates', { method: 'POST', session: sessions.staff, body: templateBody }); assert.equal(templateResult.status, 201); const template = templateResult.json.template;
  async function eligibility(channel = 'Email draft') { const r = await request('/audiences/' + audience.id + '/preview?version=1&channel=' + encodeURIComponent(channel), { session: sessions.staff }); assert.equal(r.status, 200, r.text); return r.json; }
  async function arm(changes = {}, session = sessions.staff) { const p = await eligibility(changes.channel || 'Email draft'); return request('/communication-workflows', { method: 'POST', session, body: { name: 'Prospective unsent welcome', audienceId: audience.id, audienceVersion: 1, sourceDigest: p.sourceDigest, templateId: template.id, templateVersion: 1, channel: 'Email draft', confirmed: true, ...changes } }); }
  async function update(profile, changes) { const current = JSON.parse(app.locals.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(profile.id).data); const r = await request('/records/constituents/' + profile.id, { method: 'PATCH', body: { version: current.version, ...changes } }); assert.equal(r.status, 200, r.text); return r.json.record; }
  const drafts = () => app.locals.db.prepare("SELECT data FROM records WHERE collection='communications' ORDER BY rowid").all().map(row => JSON.parse(row.data));
  const financial = () => Object.fromEntries(['records', 'receipt_issues', 'correspondence_preparations', 'correspondence_finalizations', 'correspondence_fulfillments'].map(table => [table, table === 'records' ? app.locals.db.prepare("SELECT * FROM records WHERE collection IN ('gifts','pledges','grants') ORDER BY rowid").all() : app.locals.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const workflowTables = () => app.locals.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'communication_workflow%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => Object.fromEntries(['records', ...workflowTables()].map(table => [table, app.locals.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const run = at => { assert.equal(typeof app.locals.runCommunicationWorkflows, 'function'); return app.locals.runCommunicationWorkflows(at ?? time); };
  return { dir, dbPath, tenantId, initialAdmin, audience, template, templateBody, baseline, outsider, request, login, create, eligibility, arm, update, drafts, financial, snapshot, workflowTables, close, open, run, sessions, get app() { return app; }, get db() { return app.locals.db; }, get time() { return time; }, set time(value) { time = value; }, set active(value) { active = value; }, restart: async () => { await close(); await open(); for (const key of ['staff', 'other', 'viewer', 'helper']) sessions[key] = await login(key + '.workflow@example.test'); } };
}

test('activation baselines existing matches and observed membership episodes create only prospective unsent drafts', async t => {
  const f = await fixture(t), finance = f.financial(), armed = await f.arm(); assert.equal(armed.status, 201, armed.text); assert.equal(f.drafts().length, 0); await f.run(); assert.equal(f.drafts().length, 0);
  await f.update(f.baseline, { notes: 'Unrelated baseline edit' }); await f.run(); assert.equal(f.drafts().length, 0);
  await f.update(f.outsider, { segments: 'Welcome, Other' }); await f.run(); let drafts = f.drafts(); assert.equal(drafts.length, 1); assert.equal(drafts[0].constituentId, f.outsider.id); assert.equal(drafts[0].status, 'Draft'); assert.equal(drafts[0].channel, 'Email'); assert.equal(drafts[0].subject, 'Welcome Prospective donor'); assert.match(drafts[0].body, /Hello Prospective donor/); assert.doesNotMatch(JSON.stringify(drafts), /Sent|providerMessageId|acknowledgment|receiptId/);
  await f.update(f.outsider, { notes: 'Unrelated eligible profile edit' }); await f.run(); await f.restart(); await f.run(); assert.equal(f.drafts().length, 1);
  await f.update(f.outsider, { segments: 'Other' }); await f.run(); assert.equal(f.drafts().length, 1);
  await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 2); await f.run(); assert.equal(f.drafts().length, 2);
  assert.deepEqual(f.financial(), finance);
});

test('activation and history controls require current staff authority, explicit reviewed sources and terminal reasoned retirement', async t => {
  const f = await fixture(t);
  for (const session of [f.sessions.viewer, f.sessions.helper]) { const r = await f.arm({}, session); assert.equal(r.status, 403, r.text); assert.equal((await f.request('/communication-workflows', { session })).status, session === f.sessions.helper ? 403 : 200); if (session === f.sessions.helper) assert.equal((await f.request('/communication-workflows/unknown', { session })).status, 403); }
  assert.equal((await f.arm({}, null)).status, 401);
  const p = await f.eligibility(), body = { name: 'Explicit reviewed workflow', audienceId: f.audience.id, audienceVersion: 1, sourceDigest: p.sourceDigest, templateId: f.template.id, templateVersion: 1, channel: 'Email draft', confirmed: true };
  assert.equal((await f.request('/communication-workflows', { method: 'POST', session: f.sessions.staff, body, csrf: false })).status, 403);
  for (const change of [{ audienceVersion: 2 }, { sourceDigest: '0'.repeat(64) }, { templateVersion: 2 }, { confirmed: false }, { channel: 'Email' }, { unexpected: true }]) { const r = await f.request('/communication-workflows', { method: 'POST', session: f.sessions.staff, body: { ...body, ...change } }); assert.ok([400, 409].includes(r.status), r.text); assert.equal(f.drafts().length, 0); }
  const armed = await f.arm(); assert.equal(armed.status, 201, armed.text); const rule = armed.json.workflow;
  const stale = await f.request('/communication-workflows/' + rule.id + '/retire', { method: 'POST', session: f.sessions.staff, body: { version: rule.version + 1, reason: 'Stale reviewed version' } }); assert.equal(stale.status, 409);
  assert.equal((await f.request('/communication-workflows/' + rule.id + '/retire', { method: 'POST', session: f.sessions.staff, body: { version: rule.version, reason: '' } })).status, 400);
  const retired = await f.request('/communication-workflows/' + rule.id + '/retire', { method: 'POST', session: f.sessions.staff, body: { version: rule.version, reason: 'Stop prospective drafts after staff review' } }); assert.equal(retired.status, 200, retired.text); assert.equal(retired.json.workflow.status, 'Retired');
  assert.equal((await f.request('/communication-workflows/' + rule.id + '/retire', { method: 'POST', session: f.sessions.staff, body: { version: retired.json.workflow.version, reason: 'Cannot retire twice' } })).status, 409);
  await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 0);
});

test('current contact eligibility controls entry and does not infer permission from segment labels or secondary contacts', async t => {
  const f = await fixture(t); assert.equal((await f.arm()).status, 201);
  const excluded = [];
  for (const [name, preference, email] of [['Do not contact', 'Do not contact', 'dnc.workflow@example.test'], ['Phone only', 'Phone', 'phone.workflow@example.test'], ['No primary email', 'Email', '']]) excluded.push(await f.create('constituents', { name, type: 'Individual', preference, email, segments: 'Welcome', contacts: [{ name: 'Secondary valid email', email: 'secondary.only@example.test', role: 'No inference' }] }));
  await f.run(); assert.equal(f.drafts().length, 0);
  await f.update(excluded[0], { preference: 'Email' }); await f.update(excluded[1], { preference: 'Email' }); await f.update(excluded[2], { email: 'primary.corrected@example.test' }); await f.run();
  assert.equal(f.drafts().length, 3); assert.deepEqual(new Set(f.drafts().map(row => row.constituentId)), new Set(excluded.map(row => row.id)));
});

test('audience/template revision changes and durable owner authority or workspace suspension suppress old activations', async t => {
  for (const change of ['audience', 'template', 'owner', 'tenant']) {
    const f = await fixture(t), armed = await f.arm(); assert.equal(armed.status, 201, armed.text); await f.update(f.outsider, { segments: 'Welcome' });
    if (change === 'audience') { const r = await f.request('/audiences/' + f.audience.id, { method: 'PATCH', body: { version: 1, name: f.audience.name, filters, status: 'Retired', reason: 'Retire original definition before prospective action' } }); assert.equal(r.status, 200, r.text); }
    if (change === 'template') { const r = await f.request('/correspondence/templates/' + f.template.id, { method: 'PATCH', body: { ...f.templateBody, version: 1, body: 'Changed current wording {{recipientName}}' } }); assert.equal(r.status, 200, r.text); }
    if (change === 'owner') { const r = await f.request('/users/' + f.sessions.staff.user.id, { method: 'PATCH', body: { version: 1, role: 'viewer', active: true } }); assert.equal(r.status, 200, r.text); }
    if (change === 'tenant') f.active = false;
    await f.run(); assert.equal(f.drafts().length, 0, change); if (change === 'tenant') f.active = true; await f.run(); assert.equal(f.drafts().length, 0, change + ' cannot silently reactivate');
    const rules = f.db.prepare('SELECT status FROM communication_workflows').all(); assert.deepEqual(rules.map(row => row.status), ['Suppressed']);
  }
});

test('durable account activation survives browser logout but suppresses a changed MFA enrollment fingerprint', async t => {
  const f = await fixture(t), armed = await f.arm(); assert.equal(armed.status, 201, armed.text);
  assert.equal((await f.request('/auth/logout', { method: 'POST', session: f.sessions.staff, body: {} })).status, 200); await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 1);
  f.sessions.staff = await f.login('staff.workflow@example.test'); const enrolled = await f.request('/auth/mfa/enroll', { method: 'POST', session: f.sessions.staff, body: { password } }); assert.equal(enrolled.status, 200, enrolled.text);
  const confirmed = await f.request('/auth/mfa/confirm', { method: 'POST', session: f.sessions.staff, body: { code: totp(enrolled.json.secret, f.time) } }); assert.equal(confirmed.status, 200, confirmed.text);
  await f.update(f.outsider, { segments: 'Other' }); await f.run(); await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 1); assert.equal(f.db.prepare('SELECT status FROM communication_workflows').get().status, 'Suppressed');
});

test('independent worker threads cannot duplicate the same observed prospective membership episode', async t => {
  const f = await fixture(t); assert.equal((await f.arm()).status, 201); await f.update(f.outsider, { segments: 'Welcome' }); const finance = f.financial();
  const code = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {createApp}=await import(workerData.appUrl);const app=createApp({dbPath:workerData.dbPath,seed:false,tenantId:workerData.tenantId,initialAdmin:workerData.initialAdmin,mfaKey:workerData.mfaKey,workflowWorker:false});app.locals.db.exec('PRAGMA busy_timeout=5000');parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{const result=await app.locals.runCommunicationWorkflows(workerData.at);app.locals.close();parentPort.postMessage({result});}catch(error){app.locals.close();parentPort.postMessage({error:error.message});}});})().catch(error=>parentPort.postMessage({error:error.message}));`;
  async function start() { const worker = new Worker(code, { eval: true, workerData: { appUrl: new URL('../server/app.js', import.meta.url).href, dbPath: f.dbPath, tenantId: f.tenantId, initialAdmin: f.initialAdmin, mfaKey, at: f.time } }); t.after(() => worker.terminate()); await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', m => m.ready ? resolve() : reject(Error(m.error))); }); return worker; }
  const workers = [await start(), await start()], results = workers.map(worker => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', m => m.error ? reject(Error(m.error)) : resolve(m.result)); })); for (const worker of workers) worker.postMessage('run'); await Promise.all(results);
  assert.equal(f.drafts().length, 1); assert.equal(f.drafts()[0].constituentId, f.outsider.id); await f.run(); assert.equal(f.drafts().length, 1); assert.deepEqual(f.financial(), finance);
});

// Restore authority is explicit and separate from the browser sessions cleared by backup.
test('recovery retains draft/execution history but cannot silently resume a pre-recovery prospective activation', async t => {
  const f = await fixture(t); assert.equal((await f.arm()).status, 201); await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 1);
  const original = f.snapshot(), archivePath = join(f.dir, 'workflow.backup'), destinationPath = join(f.dir, 'restored.sqlite'), encryptionKey = randomBytes(32).toString('base64');
  await backupWorkspace({ db: f.db, outputPath: archivePath, tenantId: f.tenantId, encryptionKey }); const result = await restoreWorkspace({ archivePath, destinationPath, expectedTenantId: f.tenantId, encryptionKey }); assert.ok(result.cleared.sessions > 0);
  const copy = new DatabaseSync(destinationPath); try { for (const [table, rows] of Object.entries(original)) assert.deepEqual(copy.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all(), rows, table); assert.equal(copy.prepare('SELECT count(*) n FROM sessions').get().n, 0); assert.equal(copy.prepare('SELECT count(*) n FROM automation_recovery_markers').get().n, 1); } finally { copy.close(); }
  await f.close(); await f.open(destinationPath); await f.run(); assert.equal(f.db.prepare('SELECT status FROM communication_workflows').get().status, 'Suppressed'); assert.equal(f.drafts().length, 1);
  await f.update(f.outsider, { segments: 'Other' }); await f.run(); await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 1);
});

test('deferred COMMIT failure retains a dated retry and cannot claim a native draft or execution before durability', async t => {
  const f = await fixture(t); assert.equal((await f.arm()).status, 201); const finance = f.financial(); await f.update(f.outsider, { segments: 'Welcome' });
  f.db.exec("CREATE TABLE synthetic_workflow_commit_fault(owner_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_failed_workflow_commit AFTER INSERT ON communication_workflow_executions BEGIN INSERT INTO synthetic_workflow_commit_fault VALUES('missing-synthetic-account'); END");
  const failed = await f.run(); assert.equal(failed.drafted, 0); assert.equal(failed.failed, 1); assert.equal(f.drafts().length, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM communication_workflow_executions').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM synthetic_workflow_commit_fault').get().n, 0); assert.deepEqual(f.financial(), finance);
  const edge = f.db.prepare('SELECT * FROM communication_workflow_entries').get(); assert.equal(edge.status, 'Pending'); assert.equal(edge.attempt_count, 1); assert.equal(edge.next_attempt, new Date(f.time + 60000).toISOString());
  const history = f.db.prepare("SELECT * FROM communication_workflow_outcomes WHERE status='Failed'").get(); assert.equal(history.at, new Date(f.time).toISOString()); assert.equal(history.retry_at, edge.next_attempt); assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='draft_communication_workflow'").get().n, 0);
  f.db.exec('DROP TRIGGER synthetic_failed_workflow_commit'); assert.equal((await f.run(f.time + 59999)).drafted, 0); const retried = await f.run(f.time + 60000); assert.equal(retried.drafted, 1); assert.equal(retried.failed, 0); assert.equal(f.drafts().length, 1); await f.restart(); await f.run(f.time + 120000); assert.equal(f.drafts().length, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM communication_workflow_executions').get().n, 1); assert.deepEqual(f.financial(), finance);
  assert.throws(() => f.db.exec("UPDATE communication_workflow_executions SET delivery='Sent'"), /immutable/); assert.throws(() => f.db.exec('DELETE FROM communication_workflow_outcomes'), /retained/); assert.equal((await f.request('/records/communications/' + f.drafts()[0].id, { method: 'DELETE', body: { version: 1 } })).status, 409);
});

test('failed native draft attempts use bounded immutable retry history and current opted-out recipient suppression', async t => {
  const f = await fixture(t); assert.equal((await f.arm()).status, 201); await f.update(f.outsider, { segments: 'Welcome' }); const finance = f.financial();
  f.db.exec("CREATE TRIGGER synthetic_workflow_audit_fault BEFORE INSERT ON audit WHEN NEW.action='draft_communication_workflow' BEGIN SELECT RAISE(ABORT,'Synthetic native draft audit unavailable'); END");
  for (let attempt = 0; attempt < 5; attempt++) { const result = await f.run(f.time + attempt * 60000); assert.equal(result.drafted, 0); assert.equal(result.failed, 1); assert.equal(f.drafts().length, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM communication_workflow_executions').get().n, 0); }
  const edge = f.db.prepare('SELECT * FROM communication_workflow_entries').get(); assert.equal(edge.status, 'Suppressed'); assert.equal(f.db.prepare("SELECT count(*) n FROM communication_workflow_outcomes WHERE status='Failed'").get().n, 4); assert.equal((await f.run(f.time + 300000)).failed, 0); f.db.exec('DROP TRIGGER synthetic_workflow_audit_fault'); assert.deepEqual(f.financial(), finance);
  await f.update(f.outsider, { segments: 'Other' }); await f.run(f.time + 360000); await f.update(f.outsider, { segments: 'Welcome' });
  f.db.exec("CREATE TRIGGER synthetic_workflow_audit_fault BEFORE INSERT ON audit WHEN NEW.action='draft_communication_workflow' BEGIN SELECT RAISE(ABORT,'Synthetic delayed pending draft'); END"); assert.equal((await f.run(f.time + 420000)).failed, 1); f.db.exec('DROP TRIGGER synthetic_workflow_audit_fault');
  await f.update(f.outsider, { preference: 'Do not contact' }); await f.run(f.time + 480000); assert.equal(f.drafts().length, 0); assert.deepEqual(f.db.prepare('SELECT status FROM communication_workflow_entries ORDER BY episode').all().map(row => row.status), ['Suppressed', 'Suppressed']); assert.deepEqual(f.financial(), finance);
});

test('post-save native draft corruption and in-transaction contact withdrawal cannot produce a successful execution', async t => {
  const f = await fixture(t); assert.equal((await f.arm()).status, 201); await f.update(f.outsider, { segments: 'Welcome' }); const finance = f.financial();
  const expressions = ["json_set(NEW.data,'$.status','Logged')", "json_set(NEW.data,'$.providerMessageId','UNVERIFIED_SENT_MARKER','$.delivery','Sent')", "json_set(NEW.data,'$.giftId','UNRELATED_FINANCIAL_MARKER')", "json_set(NEW.data,'$.id','incorrect-native-id')"];
  for (let index = 0; index < expressions.length; index++) {
    f.db.exec("CREATE TRIGGER synthetic_workflow_native_fault AFTER INSERT ON records WHEN NEW.collection='communications' BEGIN UPDATE records SET data=" + expressions[index] + " WHERE collection=NEW.collection AND id=NEW.id; END");
    const result = await f.run(f.time + index * 60000); assert.equal(result.drafted, 0, expressions[index]); assert.equal(result.failed, 1); assert.equal(f.drafts().length, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM communication_workflow_executions').get().n, 0); assert.deepEqual(f.financial(), finance); f.db.exec('DROP TRIGGER synthetic_workflow_native_fault');
  }
  f.db.exec("CREATE TRIGGER synthetic_workflow_consent_fault AFTER INSERT ON audit WHEN NEW.action='draft_communication_workflow' BEGIN UPDATE records SET data=json_set(data,'$.preference','Do not contact','$.version',json_extract(data,'$.version')+1) WHERE collection='constituents' AND id='" + f.outsider.id + "'; END");
  const result = await f.run(f.time + 240000); assert.equal(result.drafted, 0); assert.equal(result.failed, 1); assert.equal(f.drafts().length, 0); assert.equal(JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(f.outsider.id).data).preference, 'Email', 'Withdrawal fault is rolled back with the unsuccessful draft'); assert.deepEqual(f.financial(), finance);
});

test('ordinary fresh MFA sign-ins do not change durable activation authority or retrigger an existing eligibility episode', async t => {
  const f = await fixture(t), enrolled = await f.request('/auth/mfa/enroll', { method: 'POST', session: f.sessions.staff, body: { password } }); assert.equal(enrolled.status, 200);
  const confirmed = await f.request('/auth/mfa/confirm', { method: 'POST', session: f.sessions.staff, body: { code: totp(enrolled.json.secret, f.time) } }); assert.equal(confirmed.status, 200);
  async function signIn(index) { const challenge = await f.login('staff.workflow@example.test'); assert.equal(challenge.mfaRequired, true); const verified = await f.request('/auth/mfa/verify', { method: 'POST', session: null, body: { challengeToken: challenge.challengeToken, code: confirmed.json.recoveryCodes[index] } }); assert.equal(verified.status, 200, verified.text); f.sessions.staff = { ...verified.json, cookie: verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }; }
  // Use the mounted API and retained recovery factors; no fabricated verified sessions.
  await signIn(0); const armed = await f.arm(); assert.equal(armed.status, 201, armed.text); const binding = f.db.prepare('SELECT security_binding FROM communication_workflows').get().security_binding;
  assert.equal((await f.request('/auth/logout', { method: 'POST', session: f.sessions.staff, body: {} })).status, 200); await signIn(1); await f.update(f.outsider, { segments: 'Welcome' }); await f.run(); assert.equal(f.drafts().length, 1); assert.equal(f.db.prepare('SELECT status FROM communication_workflows').get().status, 'Active'); assert.equal(f.db.prepare('SELECT security_binding FROM communication_workflows').get().security_binding, binding);
  await signIn(2); await f.run(); assert.equal(f.drafts().length, 1);
});
