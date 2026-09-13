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
  const snapshot = () => Object.fromEntries(app.locals.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='sessions' ORDER BY name").all().map(({ name }) => [name, app.locals.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
  async function update(person, changes) { const result = await request('/records/constituents/' + person.id, { method: 'PATCH', session: sessions.admin, body: { version: person.version, ...changes } }); assert.equal(result.status, 200, result.text); return result.json.record; }
  return { request, login, sessions, people, template, snapshot, update, set active(value) { active = value; }, get db() { return app.locals.db; }, restart: async () => { await close(); await open(); for (const key of Object.keys(sessions)) sessions[key] = await login(key === 'admin' ? initialAdmin.email : key + '.audience@example.test'); } };
}

const filters = (changes = {}) => ({ segmentTokens: ['VIP'], segmentMatch: 'Any', types: [], preferences: [], ...changes });
async function audience(f, changes = {}) { const result = await f.request('/audiences', { method: 'POST', session: f.sessions.staff, body: { name: 'Synthetic saved VIP audience', filters: filters(), ...changes } }); assert.equal(result.status, 201, result.text); return result.json.audience; }
const preview = (f, saved, channel = 'Email draft', query = '') => f.request('/audiences/' + saved.id + '/preview?version=' + saved.version + '&channel=' + encodeURIComponent(channel) + query, { session: f.sessions.staff });
const prepare = (f, saved, reviewed, ids, changes = {}) => f.request('/correspondence/prepare', { method: 'POST', session: f.sessions.staff, body: { templateId: f.template.id, templateVersion: f.template.version, channel: reviewed.channel, constituentIds: ids, audience: { id: saved.id, version: saved.version, sourceDigest: reviewed.sourceDigest }, ...changes } });
const finalize = (f, correspondence) => f.request('/correspondence/' + correspondence.id + '/finalize', { method: 'POST', session: f.sessions.staff, body: { version: 1, preparationDigest: correspondence.preparationDigest, confirmed: true } });

const report = (f, entity, columns, session = f.sessions.viewer) => f.request('/custom-reports/run', { method: 'POST', session, body: { name: 'Synthetic curated source proof', entity, columns } });

test('saved audience criteria and revisions report exact source facts while correspondence preserves its selected historical provenance', async t => {
  const f = await fixture(t), criteria = filters({ types: ['Staff', 'Employee'], preferences: ['Email'] }), saved = await audience(f, { filters: criteria }), reviewed = (await preview(f, saved)).json;
  const nativeBefore = f.snapshot().records, prepared = await prepare(f, saved, reviewed, [f.people.eligible.id]); assert.equal(prepared.status, 201);
  const criteriaReport = await report(f, 'savedAudiences', ['id', 'revision', 'status', 'name', 'segmentLabels', 'segmentMatch', 'types', 'preferences']); assert.equal(criteriaReport.status, 200, criteriaReport.text);
  assert.deepEqual(criteriaReport.json.rows, [[saved.id, 1, 'Active', saved.name, '["VIP"]', 'Any', '["Staff","Employee"]', '["Email"]']]); assert.equal(criteriaReport.json.requiredRole, 'authenticated');
  const prepColumns = ['id', 'audienceId', 'audienceName', 'audienceRevision', 'audienceSelectedCount', 'recipientCount', 'giftCount', 'monetaryCents', 'noncashCents', 'delivery', 'status'];
  const current = await report(f, 'correspondencePreparations', prepColumns); assert.equal(current.status, 200); assert.deepEqual(current.json.rows, [[prepared.json.correspondence.id, saved.id, saved.name, 1, 1, 1, 0, 0, 0, 'Not sent', 'Prepared']]);
  assert.equal((await finalize(f, prepared.json.correspondence)).status, 200);
  const edit = await f.request('/audiences/' + saved.id, { method: 'PATCH', session: f.sessions.staff, body: { version: 1, name: 'Current revised audience', filters: filters({ types: ['Staff'] }), status: 'Active' } }); assert.equal(edit.status, 200);
  const revisions = await report(f, 'audienceRevisions', ['audienceId', 'revision', 'status', 'name', 'segmentLabels', 'types', 'preferences', 'actor']); assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.json.rows, [[saved.id, 1, 'Active', saved.name, '["VIP"]', '["Staff","Employee"]', '["Email"]', f.sessions.staff.user.id], [saved.id, 2, 'Active', 'Current revised audience', '["VIP"]', '["Staff"]', '[]', f.sessions.staff.user.id]]);
  const retained = await report(f, 'correspondencePreparations', prepColumns); assert.equal(retained.status, 200); assert.deepEqual(retained.json.rows, [[prepared.json.correspondence.id, saved.id, saved.name, 1, 1, 1, 0, 0, 0, 'Not sent', 'Finalized']]);
  assert.deepEqual(f.snapshot().records, nativeBefore); assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_fulfillments').get().n, 0); assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection IN ('gifts','communications')").get().n, 0);
});

test('curated audience catalog and reports exclude raw recipient corpora, email, digests and permission metadata', async t => {
  const f = await fixture(t), saved = await audience(f), reviewed = (await preview(f, saved)).json; assert.equal((await prepare(f, saved, reviewed, [f.people.eligible.id])).status, 201);
  const catalog = await f.request('/custom-reports/catalog', { session: f.sessions.viewer }); assert.equal(catalog.status, 200);
  const entities = catalog.json.entities.filter(entity => ['savedAudiences', 'audienceRevisions', 'correspondencePreparations'].includes(entity.id)); assert.equal(entities.length, 3);
  for (const entity of entities) { assert.ok(!entity.fields.some(field => /sourceDigest|definitionDigest|recordDigest|recipientEmail|selectedConstituentIds|items|request|corpus|account_binding|permission/.test(field.key))); assert.equal(entity.requiredRole, 'authenticated'); }
  for (const [entity, allowed, forbidden] of [['savedAudiences', ['name', 'types'], ['sourceDigest', 'definition', 'recipientIds', 'email']], ['audienceRevisions', ['name', 'revision'], ['definitionDigest', 'recordDigest', 'recipients']], ['correspondencePreparations', ['audienceName', 'audienceSelectedCount', 'delivery'], ['sourceDigest', 'items', 'request', 'recipientEmail', 'selectedConstituentIds']]]) {
    const safe = await report(f, entity, allowed); assert.equal(safe.status, 200); assert.ok(!safe.text.includes(reviewed.sourceDigest)); for (const person of Object.values(f.people)) if (person.email) assert.ok(!safe.text.includes(person.email));
    for (const field of forbidden) assert.equal((await report(f, entity, [field])).status, 400, entity + ':' + field);
  }
  assert.equal((await f.request('/custom-reports/catalog', { session: f.sessions.helper })).status, 403);
});

test('helper assignment and access history reports are administrator-only and retained history is not ordinary-reader permission data', async t => {
  const f = await fixture(t), eventResult = await f.request('/records/events', { method: 'POST', session: f.sessions.admin, body: { name: 'Synthetic helper reporting event', date: '2026-09-13', location: 'Synthetic venue', capacity: 10, ticketPrice: 10001, sponsorGoal: 0 } }); assert.equal(eventResult.status, 201); const event = eventResult.json.record;
  const access = await f.request('/users/' + f.sessions.helper.user.id + '/event-access', { session: f.sessions.admin }); assert.equal(access.status, 200);
  const grant = await f.request('/users/' + f.sessions.helper.user.id + '/event-access', { method: 'PATCH', session: f.sessions.admin, body: { version: access.json.version, eventIds: [event.id], reason: 'Synthetic assigned-event reporting proof' } }); assert.equal(grant.status, 200);
  const columns = { eventHelperAssignments: ['userId', 'eventId', 'active', 'revision'], eventHelperAccessHistory: ['userId', 'fromRevision', 'toRevision', 'beforeEventIds', 'afterEventIds', 'reason', 'actorId'] };
  const assignment = await report(f, 'eventHelperAssignments', columns.eventHelperAssignments, f.sessions.admin); assert.equal(assignment.status, 200); assert.equal(assignment.json.requiredRole, 'admin'); assert.deepEqual(assignment.json.rows, [[f.sessions.helper.user.id, event.id, true, 1]]);
  const history = await report(f, 'eventHelperAccessHistory', columns.eventHelperAccessHistory, f.sessions.admin); assert.equal(history.status, 200); assert.deepEqual(history.json.rows, [[f.sessions.helper.user.id, 1, 2, '[]', JSON.stringify([event.id]), 'Synthetic assigned-event reporting proof', f.sessions.admin.user.id]]);
  for (const session of [f.sessions.viewer, f.sessions.staff]) {
    const catalog = await f.request('/custom-reports/catalog', { session }); assert.equal(catalog.status, 200); assert.ok(!catalog.json.entities.some(entity => Object.hasOwn(columns, entity.id)));
    for (const [entity, fields] of Object.entries(columns)) { const result = await report(f, entity, fields, session); assert.equal(result.status, 403, result.text); assert.ok(!result.text.includes(f.sessions.helper.user.id)); assert.ok(!result.text.includes('Synthetic assigned-event reporting proof')); }
  }
  f.sessions.helper = await f.login('helper.audience@example.test'); for (const [entity, fields] of Object.entries(columns)) assert.equal((await report(f, entity, fields, f.sessions.helper)).status, 403);
});
