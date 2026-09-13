import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const operator = { name: 'Synthetic interaction conversion operator', email: 'interaction.operator@example.test', password: 'InteractionSourceFixture!2026' };
const file = (collection, rows) => ({ collection, mapping: Object.fromEntries(Object.keys(rows[0]).map(key => [key, key])), rows });
const people = (changes = {}) => file('constituents', [{ sourceId: 'person-1', name: 'Synthetic historical constituent', type: 'Staff', email: 'interaction.person@example.test', preference: 'Do not contact', ...changes }]);
const interaction = (changes = {}) => ({ sourceId: 'interaction-1', constituentSourceId: 'person-1', subject: 'Original historical contact', channel: 'Phone', status: 'Logged', accessScope: 'Workspace', date: '2016-09-13', body: '  Original body\nwith exact source text {{name}} and <markup> preserved.  ', notes: '  Original notes\nwithout invented delivery/actor.  ', ...changes });
const input = (files, fileKey = 'interaction-source-1') => ({ source: 'Synthetic prepared interaction export', fileKey, files });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-interaction-conversion-')), dbPath = join(dir, 'workspace.sqlite');
  let app, server, base, sessions;
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, body, session = sessions?.admin, method = body === undefined ? 'GET' : 'POST', extra = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login(email = operator.email) { const result = await request('/auth/login', { email, password: operator.password }, null); assert.equal(result.status, 200); return { ...result.json, cookie: result.headers.get('set-cookie').split(';')[0] }; }
  async function open() { app = createApp({ dbPath, seed: false, initialAdmin: operator }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; sessions = { admin: await login() }; }
  await open();
  for (const role of ['staff', 'viewer']) assert.equal((await request('/users', { name: 'Synthetic ' + role, email: role + '.interaction@example.test', password: operator.password, role })).status, 201);
  sessions.staff = await login('staff.interaction@example.test'); sessions.viewer = await login('viewer.interaction@example.test');
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const counts = () => ({ records: app.locals.db.prepare('SELECT count(*) n FROM records').get().n, mappings: app.locals.db.prepare('SELECT count(*) n FROM migration_mapping').get().n, batches: app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n, audit: app.locals.db.prepare('SELECT count(*) n FROM audit').get().n });
  async function commit(source) { const preview = await request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true, JSON.stringify(preview.json)); return request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); }
  return { request, commit, counts, get app() { return app; }, get sessions() { return sessions; }, restart: async () => { await close(); await open(); sessions.staff = await login('staff.interaction@example.test'); sessions.viewer = await login('viewer.interaction@example.test'); } };
}
async function workspace(f, session) { const result = await f.request('/workspace', undefined, session || f.sessions.admin); assert.equal(result.status, 200); return result.json.data; }

test('explicit Workspace Logged historical interactions preserve literal source text and one identity without sending, consent or gift-acknowledgment changes', async t => {
  const f = await fixture(t), source = input([file('communications', [interaction()]), people()]), before = f.counts();
  const preview = await f.request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true); assert.deepEqual(f.counts(), before);
  assert.deepEqual(preview.json.summary.createCounts, { constituents: 1, designations: 0, gifts: 0, communications: 1 });
  assert.equal(preview.json.summary.communications, 1); assert.ok(!Object.hasOwn(preview.json.summary, 'campaigns')); assert.equal(preview.json.summary.giftTotalCents, '0');
  const saved = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const data = await workspace(f, f.sessions.viewer), logged = data.communications[0];
  assert.equal(logged.constituentId, data.constituents[0].id); assert.equal(logged.body, interaction().body); assert.equal(logged.notes, interaction().notes); assert.equal(logged.date, '2016-09-13'); assert.equal(logged.channel, 'Phone'); assert.equal(logged.status, 'Logged');
  assert.equal(data.constituents[0].preference, 'Do not contact'); assert.equal(data.constituents[0].type, 'Staff');
  for (const key of ['accessScope', 'sourceId', 'constituentSourceId', 'giftId', 'acknowledgment', 'correspondence', 'providerMessageId', 'sentAt']) assert.ok(!Object.hasOwn(logged, key));
  assert.equal(data.gifts.length, 0); assert.equal(data.constituents.length, 1);
  for (const table of ['receipt_preparations', 'correspondence_fulfillments', 'correspondence_preparations']) assert.equal(f.app.locals.db.prepare('SELECT count(*) n FROM ' + table).get().n, 0);
  assert.equal(saved.json.reconciliation.actualNewGiftCents, '0');
});

test('historical interaction conversion rejects unclassified/private source scope, drafts, claimed provider states, future dates and invalid channels', async t => {
  const f = await fixture(t);
  for (const changes of [{ accessScope: '' }, { accessScope: 'Private' }, { accessScope: 'Restricted' }, { accessScope: 'workspace' }, { status: 'Draft' }, { status: 'Sent' }, { status: 'Delivered' }, { channel: 'SMS' }, { date: '2016-02-30' }, { date: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }]) {
    const source = input([people(), file('communications', [interaction(changes)])], 'invalid-' + JSON.stringify(changes)), before = f.counts();
    const preview = await f.request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, false, JSON.stringify(changes)); assert.equal(preview.json.previewDigest, null);
    assert.equal((await f.request('/migration/commit', { ...source, previewDigest: '0'.repeat(64) })).status, 400); assert.deepEqual(f.counts(), before);
  }
  const missing = interaction(); delete missing.accessScope;
  assert.equal((await f.request('/migration/preview', input([people(), file('communications', [missing])]))).status, 400);
  const fabricatedActor = interaction({ originalActor: 'Unapproved actor import' });
  assert.equal((await f.request('/migration/preview', input([people(), file('communications', [fabricatedActor])]))).status, 400);
});

test('all allowed historical channels use mapped identities and reject unknown, other-source and changed constituent dependencies', async t => {
  const f = await fixture(t); assert.equal((await f.commit(input([people()], 'historical-identity'))).status, 201);
  const rows = ['Email', 'Phone', 'Meeting', 'Post'].map((channel, i) => interaction({ sourceId: 'channel-' + i, channel }));
  const source = input([file('communications', rows)], 'historical-channels'), saved = await f.commit(source); assert.equal(saved.status, 201);
  const data = await workspace(f); assert.equal(data.communications.length, 4); assert.ok(data.communications.every(row => row.constituentId === data.constituents[0].id)); assert.equal(data.constituents[0].preference, 'Do not contact');
  const unknown = await f.request('/migration/preview', input([file('communications', [interaction({ sourceId: 'unknown', constituentSourceId: 'missing' })])], 'unknown-identity')); assert.equal(unknown.json.valid, false); assert.match(unknown.json.rows[0].error, /Unmapped constituents/);
  const other = await f.request('/migration/preview', { ...input([file('communications', [interaction({ sourceId: 'other-source' })])]), source: 'Different source namespace' }); assert.equal(other.json.valid, false);
  const pending = input([file('communications', [interaction({ sourceId: 'pending-identity' })])], 'pending-identity'), preview = await f.request('/migration/preview', pending); assert.equal(preview.json.valid, true);
  const donor = data.constituents[0]; assert.equal((await f.request('/records/constituents/' + donor.id, { version: donor.version, notes: 'Explicit corrected identity after preview' }, f.sessions.admin, 'PATCH')).status, 200);
  const before = f.counts(), stale = await f.request('/migration/commit', { ...pending, previewDigest: preview.json.previewDigest }); assert.equal(stale.status, 400); assert.deepEqual(f.counts(), before);
  const refreshed = await f.request('/migration/preview', pending); assert.equal(refreshed.json.valid, false); assert.match(refreshed.json.rows[0].error, /Previously mapped dependency changed/);
});

test('interaction source IDs, audit rollback, permissions and retained record deletion remain guarded', async t => {
  const f = await fixture(t), source = input([people(), file('communications', [interaction()])]);
  const duplicate = await f.request('/migration/preview', input([people(), file('communications', [interaction(), interaction()])])); assert.equal(duplicate.json.valid, false); assert.equal(duplicate.json.rows.filter(row => /Duplicate source identifier/.test(row.error)).length, 2);
  for (const session of [f.sessions.staff, f.sessions.viewer]) assert.equal((await f.request('/migration/preview', source, session)).status, 403);
  assert.equal((await f.request('/migration/preview', source, null)).status, 401);
  assert.equal((await f.request('/migration/preview', source, f.sessions.admin, 'POST', { 'X-CSRF-Token': 'invalid' })).status, 403);
  f.app.locals.db.exec("CREATE TRIGGER fail_synthetic_interaction_write BEFORE INSERT ON records WHEN NEW.collection='communications' BEGIN SELECT RAISE(ABORT,'Synthetic interaction persistence fault'); END");
  const before = f.counts(), preview = await f.request('/migration/preview', source); assert.equal(preview.json.valid, true);
  assert.equal((await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest })).status, 500); assert.deepEqual(f.counts(), before);
  f.app.locals.db.exec('DROP TRIGGER fail_synthetic_interaction_write'); const saved = await f.commit(source); assert.equal(saved.status, 201);
  const record = (await workspace(f)).communications[0];
  assert.equal((await f.request('/records/communications/' + record.id, { version: record.version }, f.sessions.admin, 'DELETE')).status, 409);
  const changedSource = await f.request('/migration/preview', input([file('communications', [interaction({ body: 'Changed original source text' })])], 'changed-source-text')); assert.equal(changedSource.json.valid, false); assert.match(changedSource.json.rows[0].error, /already imported with different values/);
});

test('interaction originals, source lineage and old three-collection gift compatibility survive restart and replay without income or acknowledgment actions', async t => {
  const f = await fixture(t), legacyGift = { sourceId: 'gift-old', donorSourceId: 'person-1', designationSourceId: 'fund-1', amount: '1.01', type: 'Cash', method: 'Check', date: '2016-09-13', externalRef: 'OLD-GIFT', notes: 'Preserved source note' };
  const legacy = input([people(), file('designations', [{ sourceId: 'fund-1', name: 'Synthetic legacy fund', accountCode: 'LEGACY-101' }]), file('gifts', [legacyGift])], 'legacy-three-collection-source');
  const old = await f.commit(legacy); assert.equal(old.status, 201); assert.deepEqual(old.json.summary.createCounts, { constituents: 1, designations: 1, gifts: 1 });
  assert.equal(f.app.locals.db.prepare("SELECT source_hash FROM migration_mapping WHERE collection='gifts'").get().source_hash, 'f5b6dfffd6ccd0a864ac94ea49d64ef616e37bba87ce298ee0603be3b0319379');
  const historical = input([file('communications', [interaction()])], 'historical-interactions'), saved = await f.commit(historical); assert.equal(saved.status, 201);
  const originals = await workspace(f), mappings = f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all();
  await f.restart();
  for (const [source, result] of [[legacy, old], [historical, saved]]) {
    const replay = await f.request('/migration/commit', { ...source, previewDigest: result.json.previewDigest }); assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.recordIds, result.json.recordIds);
  }
  const reuse = await f.commit({ ...legacy, fileKey: 'legacy-source-reuse' }); assert.equal(reuse.status, 201); assert.equal(reuse.json.recordIds.length, 0);
  assert.deepEqual(f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all(), mappings);
  const data = await workspace(f); assert.deepEqual(data.communications, originals.communications); assert.equal(data.gifts.length, 1); assert.equal(data.gifts[0].amount, 101); assert.ok(!data.gifts[0].acknowledgment); assert.equal(data.constituents[0].preference, 'Do not contact');
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.equal(detail.status, 200); assert.deepEqual(detail.json.integrity, { unchanged: 1, changed: 0, missing: 0 });
  const report = await f.request('/custom-reports/run', { name: 'Historical interaction identity proof', entity: 'communications', columns: ['constituentName', 'subject', 'channel', 'date', 'body'] }, f.sessions.viewer); assert.equal(report.status, 200);
  assert.deepEqual(report.json.rows, [[data.constituents[0].name, interaction().subject, interaction().channel, interaction().date, interaction().body]]);
});
