import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';

const password = 'SyntheticAudienceAcceptance!2026';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-audience-integrity-')), dbPath = join(dir, 'workspace.sqlite'), initialAdmin = { name: 'Synthetic audience administrator', email: 'admin.audience@example.test', password };
  let app, server, base, active = true;
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function open() { app = createApp({ dbPath, seed: false, initialAdmin, isTenantActive: () => active }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; } return { status: response.status, json, text };
  }
  async function login(email = initialAdmin.email) { const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); assert.equal(response.status, 200); return { ...await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }; }
  const sessions = { admin: await login() };
  for (const [key, role] of [['staff', 'staff'], ['viewer', 'viewer'], ['helper', 'event-helper']]) { const result = await request('/users', { method: 'POST', session: sessions.admin, body: { name: 'Synthetic audience ' + key, email: key + '.audience@example.test', password, role } }); assert.equal(result.status, 201, result.text); sessions[key] = await login(key + '.audience@example.test'); }
  async function create(collection, body) { const result = await request('/records/' + collection, { method: 'POST', session: sessions.admin, body }); assert.equal(result.status, 201, result.text); return result.json.record; }
  const people = {};
  for (const [key, data] of [
    ['eligible', { type: 'Staff', segments: 'VIP', preference: 'Email', email: 'eligible.audience@example.test' }],
    ['substring', { type: 'Individual', segments: 'NotVIP,VIP Alumni', preference: 'Email', email: 'substring.audience@example.test' }],
    ['both', { type: 'Employee', segments: ' VIP , Alumni ', preference: 'Email', email: 'both.audience@example.test' }],
    ['dnc', { type: 'Employee', segments: 'VIP', preference: 'Do not contact', email: '' }],
    ['noEmail', { type: 'Staff', segments: 'VIP', preference: 'Email', email: '', contacts: [{ name: 'Alternate contact', email: 'contact.audience@example.test', role: 'Source liaison' }] }],
    ['phone', { type: 'Alumni', segments: 'VIP', preference: 'Phone', email: 'phone.audience@example.test' }],
    ['post', { type: 'Business', segments: 'VIP', preference: 'Post', email: 'post.audience@example.test' }],
  ]) people[key] = await create('constituents', { name: 'Synthetic audience ' + key, ...data });
  const templateResult = await request('/correspondence/templates', { method: 'POST', session: sessions.staff, body: { name: 'Audience plain-text message', kind: 'Messaging', subject: 'Hello {{recipientName}}', body: 'Hello {{recipientName}} from {{organizationName}}.' } }); assert.equal(templateResult.status, 201); const template = templateResult.json.template;
  const snapshot = () => Object.fromEntries(app.locals.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sessions','observability_counters','observability_heartbeat') ORDER BY name").all().map(({ name }) => [name, app.locals.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
  async function update(person, changes) { const result = await request('/records/constituents/' + person.id, { method: 'PATCH', session: sessions.admin, body: { version: person.version, ...changes } }); assert.equal(result.status, 200, result.text); return result.json.record; }
  return { request, sessions, people, template, snapshot, update, set active(value) { active = value; }, get db() { return app.locals.db; }, restart: async () => { await close(); await open(); for (const key of Object.keys(sessions)) sessions[key] = await login(key === 'admin' ? initialAdmin.email : key + '.audience@example.test'); } };
}

const filters = (changes = {}) => ({ segmentTokens: ['VIP'], segmentMatch: 'Any', types: [], preferences: [], ...changes });
async function audience(f, changes = {}) { const result = await f.request('/audiences', { method: 'POST', session: f.sessions.staff, body: { name: 'Synthetic saved VIP audience', filters: filters(), ...changes } }); assert.equal(result.status, 201, result.text); return result.json.audience; }
const preview = (f, saved, channel = 'Email draft', query = '') => f.request('/audiences/' + saved.id + '/preview?version=' + saved.version + '&channel=' + encodeURIComponent(channel) + query, { session: f.sessions.staff });
const prepare = (f, saved, reviewed, ids, changes = {}) => f.request('/correspondence/prepare', { method: 'POST', session: f.sessions.staff, body: { templateId: f.template.id, templateVersion: f.template.version, channel: reviewed.channel, constituentIds: ids, audience: { id: saved.id, version: saved.version, sourceDigest: reviewed.sourceDigest }, ...changes } });
const finalize = (f, correspondence) => f.request('/correspondence/' + correspondence.id + '/finalize', { method: 'POST', session: f.sessions.staff, body: { version: 1, preparationDigest: correspondence.preparationDigest, confirmed: true } });

test('exact saved tokens, type and preference filters do not infer channel consent from contacts or substrings', async t => {
  const f = await fixture(t), saved = await audience(f), before = f.snapshot(), email = await preview(f, saved);
  assert.equal(email.status, 200, email.text); assert.equal(email.json.totalCount, 7); assert.equal(email.json.matchedCount, 6); assert.equal(email.json.eligibleCount, 2); assert.equal(email.json.excludedCount, 5);
  assert.deepEqual(email.json.recipients.map(row => row.id).sort(), [f.people.eligible.id, f.people.both.id].sort()); assert.ok(email.json.recipients.every(row => !Object.hasOwn(row, 'email') && !Object.hasOwn(row, 'contacts') && !Object.hasOwn(row, 'notes')));
  assert.deepEqual(email.json.reasonCounts, { 'Merged identity': 0, 'Outside saved criteria': 1, 'Do not contact': 1, 'Email preference required': 2, 'Invalid primary email': 1 }); assert.deepEqual(f.snapshot(), before);
  const print = await preview(f, saved, 'Print'); assert.equal(print.status, 200); assert.equal(print.json.eligibleCount, 5); assert.ok(print.json.recipients.some(row => row.id === f.people.phone.id)); assert.ok(print.json.recipients.some(row => row.id === f.people.noEmail.id)); assert.ok(!print.json.recipients.some(row => row.id === f.people.dnc.id));
  const paged = []; let after = '';
  do { const page = await preview(f, saved, 'Print', '&limit=2' + (after ? '&after=' + after : '')); assert.equal(page.status, 200); assert.equal(page.json.sourceDigest, print.json.sourceDigest); paged.push(...page.json.recipients.map(row => row.id)); after = page.json.nextCursor; } while (after);
  assert.deepEqual(paged, print.json.recipients.map(row => row.id)); assert.equal(new Set(paged).size, 5);
  for (const [criteria, expected] of [[filters({ segmentTokens: ['VIP', 'Alumni'], segmentMatch: 'All' }), [f.people.both.id]], [filters({ segmentTokens: ['vip'] }), []], [filters({ segmentTokens: ['VIP Alumni'] }), [f.people.substring.id]], [filters({ types: ['Staff'] }), [f.people.eligible.id]], [filters({ preferences: ['Phone'] }), []]]) {
    const distinct = await audience(f, { filters: criteria }), result = await preview(f, distinct); assert.equal(result.status, 200); assert.deepEqual(result.json.recipients.map(row => row.id).sort(), expected.sort());
  }
});

test('audience snapshots and revisions are role guarded, strict, CSRF protected and tenant-local', async t => {
  const f = await fixture(t), saved = await audience(f);
  for (const path of ['/audiences', '/audiences/' + saved.id, '/audiences/' + saved.id + '/preview?version=1&channel=Print', '/%61udiences', '/custom-reports/catalog']) for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
    const result = await f.request(path, { method, session: f.sessions.helper, ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { body: {} } : {}) }); assert.equal(result.status, 403, method + path + result.text);
  }
  assert.equal((await f.request('/audiences')).status, 401); assert.equal((await f.request('/audiences', { session: f.sessions.viewer })).status, 200);
  assert.equal((await f.request('/audiences', { method: 'POST', session: f.sessions.viewer, body: { name: 'Denied', filters: filters() } })).status, 403);
  assert.equal((await f.request('/audiences', { method: 'POST', session: f.sessions.staff, csrf: false, body: { name: 'Denied', filters: filters() } })).status, 403);
  for (const bad of [{ segmentTokens: ['VIP', 'VIP'] }, { segmentTokens: [' VIP ', 'VIP'] }, { segmentTokens: ['VIP,Alumni'] }, { segmentMatch: 'Sometimes' }, { types: ['Administrator'] }, { preferences: ['Consent inferred'] }, { recipientIds: [f.people.eligible.id] }]) {
    const before = f.snapshot(), result = await f.request('/audiences', { method: 'POST', session: f.sessions.staff, body: { name: 'Invalid criteria', filters: filters(bad) } }); assert.equal(result.status, 400, result.text); assert.deepEqual(f.snapshot(), before);
  }
  for (const query of ['&limit=0', '&limit=101', '&after=invalid', '&unknown=1']) assert.equal((await preview(f, saved, 'Print', query)).status, 400);
  const foreign = await fixture(t), elsewhere = await audience(foreign); assert.equal((await f.request('/audiences/' + elsewhere.id, { session: f.sessions.staff })).status, 404);
});

test('explicit selected recipients cannot be expanded, mixed with ineligible IDs or prepared from a stale source preview', async t => {
  const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json;
  for (const ids of [[f.people.eligible.id, f.people.dnc.id], [f.people.eligible.id, f.people.noEmail.id], [f.people.eligible.id, f.people.substring.id], [f.people.eligible.id, f.people.eligible.id], [randomUUID()], Array.from({ length: 101 }, () => randomUUID())]) {
    const before = f.snapshot(), result = await prepare(f, saved, reviewed, ids); assert.ok([400, 403, 404, 409].includes(result.status), result.text); assert.deepEqual(f.snapshot(), before);
  }
  const wrongChannelBefore = f.snapshot(); assert.equal((await prepare(f, saved, reviewed, [f.people.eligible.id], { channel: 'Print' })).status, 409); assert.deepEqual(f.snapshot(), wrongChannelBefore);
  let before = f.snapshot(); const selected = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(selected.status, 201, selected.text); assert.equal(selected.json.delivery, 'Not sent'); assert.deepEqual(selected.json.correspondence.items.map(item => item.recipient.id), [f.people.eligible.id]);
  assert.deepEqual(f.snapshot().records, before.records); assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_fulfillments').get().n, 0);
  await f.update(f.people.both, { notes: 'An unselected corpus record changed after preview' }); before = f.snapshot(); const stale = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(stale.status, 409, stale.text); assert.deepEqual(f.snapshot(), before);
  const refreshed = (await preview(f, saved)).json, fresh = await prepare(f, saved, refreshed, [f.people.eligible.id]); assert.equal(fresh.status, 201); assert.deepEqual(fresh.json.correspondence.items.map(item => item.recipient.id), [f.people.eligible.id]);
  before = f.snapshot(); assert.equal((await finalize(f, selected.json.correspondence)).status, 409); assert.deepEqual(f.snapshot(), before);
});

test('definition changes or retirement invalidate prepared review while historical audience wording remains retained', async t => {
  const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json, prepared = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(prepared.status, 201);
  const changed = await f.request('/audiences/' + saved.id, { method: 'PATCH', session: f.sessions.staff, body: { version: saved.version, name: 'Changed saved definition', filters: filters({ types: ['Staff'] }), status: 'Active' } }); assert.equal(changed.status, 200, changed.text);
  const before = f.snapshot(); assert.equal((await finalize(f, prepared.json.correspondence)).status, 409); assert.equal((await prepare(f, saved, reviewed, [f.people.eligible.id])).status, 409); assert.deepEqual(f.snapshot(), before);
  const detail = await f.request('/audiences/' + saved.id, { session: f.sessions.viewer }); assert.equal(detail.status, 200); assert.equal(detail.json.revisionCount, 2); assert.deepEqual(detail.json.revisions.find(revision => revision.version === 1).filters.segmentTokens, ['VIP']);
  const current = changed.json.audience, fresh = await preview(f, current), next = await prepare(f, current, fresh.json, [f.people.eligible.id]); assert.equal(next.status, 201);
  const retired = await f.request('/audiences/' + saved.id, { method: 'PATCH', session: f.sessions.staff, body: { version: current.version, name: current.name, filters: current.filters, status: 'Retired', reason: 'Approved audience retirement' } }); assert.equal(retired.status, 200, retired.text);
  assert.equal((await preview(f, retired.json.audience)).status, 409); assert.equal((await finalize(f, next.json.correspondence)).status, 409);
  const resume = await f.request('/audiences/' + saved.id, { method: 'PATCH', session: f.sessions.staff, body: { version: retired.json.audience.version, name: current.name, filters: current.filters, status: 'Active' } }); assert.equal(resume.status, 409);
  const retained = await f.request('/correspondence/' + prepared.json.correspondence.id, { session: f.sessions.viewer }); assert.equal(retained.status, 200); assert.deepEqual(retained.json.correspondence.items, prepared.json.correspondence.items); assert.equal(retained.json.delivery, 'Not sent');
});

test('recipient preference, template and settings changes fail finalization without altering money, communications or retained snapshots', async t => {
  for (const change of ['preference', 'template', 'settings']) {
    const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json, prepared = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(prepared.status, 201);
    if (change === 'preference') await f.update(f.people.eligible, { preference: 'Do not contact' });
    else if (change === 'template') assert.equal((await f.request('/correspondence/templates/' + f.template.id, { method: 'PATCH', session: f.sessions.staff, body: { version: f.template.version, name: f.template.name, kind: 'Messaging', subject: f.template.subject, body: 'Changed template wording {{recipientName}}.' } })).status, 200);
    else assert.equal((await f.request('/settings', { method: 'PATCH', session: f.sessions.admin, body: { organizationName: 'Changed organization wording', fiscalStartMonth: 7 } })).status, 200);
    const before = f.snapshot(), result = await finalize(f, prepared.json.correspondence); assert.ok([403, 409].includes(result.status), change + result.text); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection='communications'").get().n, 0); assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection='gifts'").get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_finalizations').get().n, 0);
  }
});

test('suspended workspace cannot prepare or finalize saved audiences through a different correspondence route', async t => {
  const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json, prepared = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(prepared.status, 201);
  f.active = false; const before = f.snapshot(); assert.equal((await preview(f, saved)).status, 403); assert.equal((await prepare(f, saved, reviewed, [f.people.eligible.id])).status, 403); assert.equal((await finalize(f, prepared.json.correspondence)).status, 403); assert.deepEqual(f.snapshot(), before);
});

test('audience preparation rechecks account binding inside its transaction after session authentication', async t => {
  const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json;
  // Authentication renews last_seen after loading its account. Simulate an
  // access change at that point to exercise the later transaction's recheck.
  f.db.exec(`CREATE TRIGGER change_synthetic_actor_binding AFTER UPDATE OF last_seen ON sessions WHEN NEW.user_id='${f.sessions.staff.user.id}' BEGIN UPDATE users SET active=0,version=version+1 WHERE id=NEW.user_id AND active=1; END`);
  const before = f.snapshot(), result = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(result.status, 401, result.text);
  const after = f.snapshot(); for (const name of Object.keys(before)) if (name !== 'users') assert.deepEqual(after[name], before[name], name); assert.equal(f.db.prepare('SELECT active FROM users WHERE id=?').get(f.sessions.staff.user.id).active, 0);
});

test('audience and preparation audits roll back snapshots and revisions; retained definitions survive restart', async t => {
  const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json;
  f.db.exec("CREATE TRIGGER fail_synthetic_audience_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic audience audit fault'); END");
  let before = f.snapshot(); const create = await f.request('/audiences', { method: 'POST', session: f.sessions.staff, body: { name: 'Rolled back audience', filters: filters() } }); assert.equal(create.status, 500); assert.deepEqual(f.snapshot(), before);
  const changed = await f.request('/audiences/' + saved.id, { method: 'PATCH', session: f.sessions.staff, body: { version: saved.version, name: 'Rolled back edit', filters: saved.filters, status: 'Active' } }); assert.equal(changed.status, 500); assert.deepEqual(f.snapshot(), before);
  const prepared = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(prepared.status, 500); assert.deepEqual(f.snapshot(), before); f.db.exec('DROP TRIGGER fail_synthetic_audience_audit');
  const good = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(good.status, 201);
  f.db.exec("CREATE TRIGGER fail_synthetic_audience_finalization BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic audience finalization audit fault'); END"); before = f.snapshot(); assert.equal((await finalize(f, good.json.correspondence)).status, 500); assert.deepEqual(f.snapshot(), before); f.db.exec('DROP TRIGGER fail_synthetic_audience_finalization');
  const finalized = await finalize(f, good.json.correspondence); assert.equal(finalized.status, 200); assert.equal(finalized.json.delivery, 'Not sent');
  assert.throws(() => f.db.prepare('UPDATE audience_revisions SET reason=? WHERE audience_id=?').run('Changed retained source', saved.id), /immutable/); assert.throws(() => f.db.prepare('DELETE FROM audience_revisions WHERE audience_id=?').run(saved.id), /retained/);
  before = f.snapshot(); await f.restart(); const detail = await f.request('/audiences/' + saved.id, { session: f.sessions.viewer }); assert.equal(detail.status, 200); assert.deepEqual(detail.json.audience, saved); assert.deepEqual(f.snapshot(), before);
  const retained = await f.request('/correspondence/' + good.json.correspondence.id, { session: f.sessions.viewer }); assert.equal(retained.json.correspondence.status, 'Finalized'); assert.deepEqual(retained.json.correspondence.items, good.json.correspondence.items);
});
