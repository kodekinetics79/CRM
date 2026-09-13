import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const operator = { name: 'Synthetic contacts conversion operator', email: 'contacts.operator@example.test', password: 'ContactsSourceFixture!2026' };
const file = (collection, rows) => ({ collection, mapping: Object.fromEntries(Object.keys(rows[0]).map(key => [key, key])), rows });
const prior = (changes = {}) => ({ sourceId: 'person-old', name: 'Synthetic prior donor', type: 'Individual', email: 'prior.contacts@example.test', notes: 'Original source note', ...changes });
const contacts = () => [{ name: 'Robin Parker', email: 'robin.contacts@example.test', role: '  Finance liaison\noriginal role  ' }, { name: 'Sam Lee', email: '', role: '' }];
const input = (files, fileKey = 'contacts-source-1') => ({ source: 'Synthetic prepared contacts export', fileKey, files });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-contacts-conversion-')), dbPath = join(dir, 'workspace.sqlite');
  let app, server, base, sessions;
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, body, session = sessions?.admin, method = body === undefined ? 'GET' : 'POST', extra = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login(email = operator.email) { const result = await request('/auth/login', { email, password: operator.password }, null); assert.equal(result.status, 200); return { ...result.json, cookie: result.headers.get('set-cookie').split(';')[0] }; }
  async function open() { app = createApp({ dbPath, seed: false, initialAdmin: operator }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; sessions = { admin: await login() }; }
  await open();
  for (const role of ['staff', 'viewer']) assert.equal((await request('/users', { name: 'Synthetic ' + role, email: role + '.contacts@example.test', password: operator.password, role })).status, 201);
  sessions.staff = await login('staff.contacts@example.test'); sessions.viewer = await login('viewer.contacts@example.test');
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const counts = () => ({ records: app.locals.db.prepare('SELECT count(*) n FROM records').get().n, mappings: app.locals.db.prepare('SELECT count(*) n FROM migration_mapping').get().n, batches: app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n, audit: app.locals.db.prepare('SELECT count(*) n FROM audit').get().n });
  async function commit(source) { const preview = await request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true, JSON.stringify(preview.json)); return request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); }
  return { request, commit, counts, get app() { return app; }, get sessions() { return sessions; }, restart: async () => { await close(); await open(); sessions.staff = await login('staff.contacts@example.test'); sessions.viewer = await login('viewer.contacts@example.test'); } };
}
async function workspace(f, session) { const result = await f.request('/workspace', undefined, session || f.sessions.admin); assert.equal(result.status, 200); return result.json.data; }

test('mapped constituent contact arrays preserve source order and values without creating accounts, identities or consent', async t => {
  const f = await fixture(t), source = input([file('constituents', [prior({ type: 'Business', preference: 'Do not contact', contacts: JSON.stringify(contacts()) })])]), before = f.counts();
  const preview = await f.request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true); assert.deepEqual(f.counts(), before);
  const saved = await f.commit(source); assert.equal(saved.status, 201); assert.deepEqual(saved.json.summary.createCounts, { constituents: 1, designations: 0, gifts: 0 });
  const data = await workspace(f, f.sessions.viewer); assert.equal(data.constituents.length, 1); assert.equal(data.gifts.length, 0); assert.equal(data.communications.length, 0);
  assert.deepEqual(data.constituents[0].contacts, contacts()); assert.equal(data.constituents[0].preference, 'Do not contact');
  assert.equal(f.app.locals.db.prepare('SELECT count(*) n FROM users').get().n, 3);
  assert.ok(!Object.hasOwn(data.constituents[0], 'sourceContacts')); assert.ok(!Object.hasOwn(data.constituents[0], 'sourceId'));
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.deepEqual(detail.json.integrity, { unchanged: 1, changed: 0, missing: 0 });
  assert.equal(detail.json.batch.sourceFiles[0].mapping.contacts, 'contacts'); assert.equal(detail.json.batch.sourceRecords[0].sourceId, 'person-old');
  const report = await f.request('/custom-reports/run', { name: 'Original contact proof', entity: 'constituents', columns: ['name', 'contacts', 'preference'] }, f.sessions.viewer);
  assert.equal(report.status, 200); assert.deepEqual(report.json.rows, [[prior().name, JSON.stringify(contacts()), 'Do not contact']]);
});

test('contacts require explicit bounded JSON with safe exact native fields and valid names and emails', async t => {
  const f = await fixture(t), invalid = ['', ' ', '{}', 'null', '[', JSON.stringify([{}]), JSON.stringify([{ name: '', email: '', role: '' }]), JSON.stringify([{ name: '   ', email: '', role: '' }]), JSON.stringify([{ name: ' Name ', email: '', role: '' }]), JSON.stringify([{ name: 'x'.repeat(251), email: '', role: '' }]), JSON.stringify([{ name: 'Name', email: 'invalid', role: '' }]), JSON.stringify([{ name: 'Name', email: '', role: 'x'.repeat(301) }]), JSON.stringify([{ name: 'Name', email: '', role: '', password: 'unsafe' }]), '[{"name":"Name","email":"","role":"","__proto__":{"admin":true}}]', JSON.stringify(Array.from({ length: 51 }, () => ({ name: 'Name', email: '', role: '' })))];
  for (const [index, value] of invalid.entries()) {
    const source = input([file('constituents', [prior({ contacts: value })])], 'invalid-contacts-' + index), before = f.counts();
    const preview = await f.request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, false, value); assert.equal(preview.json.previewDigest, null);
    assert.equal((await f.request('/migration/commit', { ...source, previewDigest: '0'.repeat(64) })).status, 400); assert.deepEqual(f.counts(), before);
  }
  const empty = await f.commit(input([file('constituents', [prior({ contacts: '[]' })])], 'explicit-empty')); assert.equal(empty.status, 201); assert.deepEqual((await workspace(f)).constituents[0].contacts, []);
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: 'Contact ' + i, email: '', role: 'Source contact' }));
  const boundary = await f.commit(input([file('constituents', [prior({ sourceId: 'boundary', email: 'boundary@example.test', contacts: JSON.stringify(rows) })])], 'fifty-contacts')); assert.equal(boundary.status, 201);
  assert.deepEqual((await workspace(f)).constituents.find(row => row.email === 'boundary@example.test').contacts, rows);
});

test('contacts conversion retains administrator, duplicate, rollback and source record protection rules', async t => {
  const f = await fixture(t), source = input([file('constituents', [prior({ contacts: JSON.stringify(contacts()) })])]);
  for (const session of [f.sessions.staff, f.sessions.viewer]) assert.equal((await f.request('/migration/preview', source, session)).status, 403);
  assert.equal((await f.request('/migration/preview', source, null)).status, 401); assert.equal((await f.request('/migration/preview', source, f.sessions.admin, 'POST', { 'X-CSRF-Token': 'invalid' })).status, 403);
  const duplicate = await f.request('/migration/preview', input([file('constituents', [prior({ contacts: '[]' }), prior({ contacts: '[]' })])])); assert.equal(duplicate.json.valid, false);
  f.app.locals.db.exec("CREATE TRIGGER fail_synthetic_contacts_write BEFORE INSERT ON records WHEN NEW.collection='constituents' BEGIN SELECT RAISE(ABORT,'Synthetic contact persistence fault'); END");
  const preview = await f.request('/migration/preview', source), before = f.counts(); assert.equal(preview.json.valid, true);
  assert.equal((await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest })).status, 500); assert.deepEqual(f.counts(), before);
  f.app.locals.db.exec('DROP TRIGGER fail_synthetic_contacts_write'); const saved = await f.commit(source); assert.equal(saved.status, 201);
  const record = (await workspace(f)).constituents[0]; assert.equal((await f.request('/records/constituents/' + record.id, { version: record.version }, f.sessions.admin, 'DELETE')).status, 409);
  const changed = await f.request('/migration/preview', input([file('constituents', [prior({ contacts: JSON.stringify([...contacts()].reverse()) })])], 'changed-contact-order')); assert.equal(changed.json.valid, false);
});

test('unmapped contacts preserve prior constituent fingerprints and source reuse across restart; mapped contacts remain immutable lineage', async t => {
  const f = await fixture(t), legacy = input([file('constituents', [prior()])], 'legacy-constituent'), old = await f.commit(legacy); assert.equal(old.status, 201);
  assert.equal(f.app.locals.db.prepare("SELECT source_hash FROM migration_mapping WHERE external_id='person-old'").get().source_hash, '35467af5cb9b3c046a0e78348ce35e658c50b12e6e3bc926086c987794e93655');
  const withContacts = input([file('constituents', [prior({ sourceId: 'business-contacts', name: 'Synthetic source organization', email: 'organization.contacts@example.test', type: 'Business', contacts: JSON.stringify(contacts()) })])], 'mapped-contacts'), saved = await f.commit(withContacts); assert.equal(saved.status, 201);
  const originals = (await workspace(f)).constituents, mappings = f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY external_id').all(); await f.restart();
  for (const [source, result] of [[legacy, old], [withContacts, saved]]) {
    const replay = await f.request('/migration/commit', { ...source, previewDigest: result.json.previewDigest }); assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.recordIds, result.json.recordIds);
    const reuse = await f.commit({ ...source, fileKey: source.fileKey + '-reuse' }); assert.equal(reuse.status, 201); assert.equal(reuse.json.recordIds.length, 0);
  }
  assert.deepEqual((await workspace(f)).constituents, originals); assert.deepEqual(f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY external_id').all(), mappings);
  const explicit = await f.request('/migration/preview', input([file('constituents', [prior({ contacts: '[]' })])], 'legacy-explicit-contacts')); assert.equal(explicit.json.valid, false);
  const business = originals.find(row => row.type === 'Business'); assert.equal((await f.request('/records/constituents/' + business.id, { version: business.version, contacts: [contacts()[1]] }, f.sessions.admin, 'PATCH')).status, 200);
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.deepEqual(detail.json.integrity, { unchanged: 0, changed: 1, missing: 0 });
  const dependency = input([file('communications', [{ sourceId: 'contact-dependency', constituentSourceId: 'business-contacts', subject: 'Original contact history', channel: 'Meeting', status: 'Logged', accessScope: 'Workspace', date: '2016-09-13' }])], 'changed-contact-dependency');
  const preview = await f.request('/migration/preview', dependency); assert.equal(preview.json.valid, false); assert.match(preview.json.rows[0].error, /Previously mapped dependency changed/);
});
