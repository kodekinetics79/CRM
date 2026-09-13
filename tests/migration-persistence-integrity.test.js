import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const operator = { name: 'Synthetic persistence verification operator', email: 'persistence.operator@example.test', password: 'PersistenceSourceFixture!2026' };
const file = (collection, rows) => { const keys = [...new Set(rows.flatMap(row => Object.keys(row)))]; return { collection, mapping: Object.fromEntries(keys.map(key => [key, key])), rows: rows.map(row => Object.fromEntries(keys.map(key => [key, row[key] ?? '']))) }; };
const input = (files, fileKey = 'persistence-source-1') => ({ source: 'Synthetic normalized integrity export', fileKey, files });
const people = () => file('constituents', [{ sourceId: 'person-1', name: '  Synthetic donor  ', type: 'Staff', email: 'donor.persistence@example.test', preference: 'Do not contact', contacts: JSON.stringify([{ name: 'Robin Parker', email: '', role: ' Original role ' }]), notes: ' Literal identity note ' }, { sourceId: 'person-2', name: 'Synthetic organization', type: 'Business', email: 'organization.persistence@example.test', contacts: '[]' }]);
const funds = () => file('designations', [{ sourceId: 'fund-1', name: '  Synthetic designation  ', accountCode: 'INTEGRITY-101', description: ' Literal designation description ' }, { sourceId: 'fund-2', name: 'Second designation', parentSourceId: 'fund-1', accountCode: 'INTEGRITY-102' }]);
const campaigns = () => file('campaigns', [{ sourceId: 'campaign-1', name: '  Synthetic campaign  ', type: 'Annual', goal: '1000.01', startDate: '2016-01-01', endDate: '2016-12-31', status: 'Completed', description: ' Literal campaign description ' }]);
const gifts = (changes = {}) => file('gifts', [{ sourceId: 'gift-1', donorSourceId: 'person-1', campaignSourceId: 'campaign-1', allocations: JSON.stringify([{ designationSourceId: 'fund-1', amount: '1.01' }, { designationSourceId: 'fund-2', amount: '1.01' }]), amount: '2.02', type: 'Cash', method: 'Check', date: '2016-09-13', externalRef: 'SOURCE-INTEGRITY-GIFT', notes: ' Literal gift note ', softCreditSourceId: 'person-2', ...changes }]);
const interactions = () => file('communications', [{ sourceId: 'interaction-1', constituentSourceId: 'person-1', subject: '  Original meeting  ', channel: 'Meeting', status: 'Logged', accessScope: 'Workspace', date: '2016-09-13', body: ' Original body\n{{name}} <markup> ', notes: ' Literal interaction note ' }]);
const all = () => input([gifts(), interactions(), campaigns(), funds(), people()]);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-persistence-verification-')), dbPath = join(dir, 'workspace.sqlite');
  let app, server, base, sessions;
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, body, session = sessions?.admin, method = body === undefined ? 'GET' : 'POST', extra = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login(email = operator.email) { const result = await request('/auth/login', { email, password: operator.password }, null); assert.equal(result.status, 200); return { ...result.json, cookie: result.headers.get('set-cookie').split(';')[0] }; }
  async function open() { app = createApp({ dbPath, seed: false, initialAdmin: operator }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; sessions = { admin: await login() }; }
  await open();
  for (const role of ['staff', 'viewer']) assert.equal((await request('/users', { name: 'Synthetic ' + role, email: role + '.persistence@example.test', password: operator.password, role })).status, 201);
  sessions.staff = await login('staff.persistence@example.test'); sessions.viewer = await login('viewer.persistence@example.test');
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const snapshot = () => Object.fromEntries(['records', 'migration_mapping', 'import_batches', 'audit'].map(table => [table, app.locals.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  const counts = () => ({ records: app.locals.db.prepare('SELECT count(*) n FROM records').get().n, mappings: app.locals.db.prepare('SELECT count(*) n FROM migration_mapping').get().n, batches: app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n, audit: app.locals.db.prepare('SELECT count(*) n FROM audit').get().n });
  async function commit(source) { const preview = await request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true, JSON.stringify(preview.json)); return request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); }
  return { request, commit, counts, snapshot, get app() { return app; }, get sessions() { return sessions; }, restart: async () => { await close(); await open(); sessions.staff = await login('staff.persistence@example.test'); sessions.viewer = await login('viewer.persistence@example.test'); } };
}
async function workspace(f, session) { const result = await f.request('/workspace', undefined, session || f.sessions.admin); assert.equal(result.status, 200); return result.json.data; }

test('native normalization and exact supported values persist before authoritative mappings are hashed', async t => {
  const f = await fixture(t), source = all(), saved = await f.commit(source); assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const data = await workspace(f); assert.equal(data.constituents.find(row => row.type === 'Staff').name, 'Synthetic donor'); assert.equal(data.communications[0].subject, 'Original meeting');
  assert.equal(data.constituents.find(row => row.type === 'Staff').contacts[0].role, ' Original role '); assert.equal(data.communications[0].body, ' Original body\n{{name}} <markup> ');
  assert.equal(data.campaigns[0].goal, 100001); assert.equal(data.gifts[0].amount, 202); assert.equal(data.gifts[0].schoolYear, '2016–2017'); assert.equal(data.gifts[0].status, 'Posted');
  assert.deepEqual(data.gifts[0].allocations.map(row => row.amount), [101, 101]);
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.deepEqual(detail.json.integrity, { unchanged: 7, changed: 0, missing: 0 });
  const mappings = f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all(); await f.restart();
  const replay = await f.request('/migration/commit', { ...source, previewDigest: saved.json.previewDigest }); assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.reconciliation, saved.json.reconciliation);
  const reuse = await f.commit({ ...source, fileKey: 'native-values-reused' }); assert.equal(reuse.status, 201); assert.equal(reuse.json.recordIds.length, 0); assert.deepEqual(f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all(), mappings);
});

test('post-save nonfinancial, dependency, lifecycle and ordered allocation corruption cannot pass matching money totals', async t => {
  const f = await fixture(t), source = all();
  const faults = [
    ['constituents', "json_set(NEW.data,'$.contacts[0].role','Wrong role')"],
    ['designations', "json_set(NEW.data,'$.description','Wrong description')"],
    ['campaigns', "json_set(NEW.data,'$.goal',100002)"],
    ['gifts', "json_set(NEW.data,'$.campaignId',NULL)"],
    ['gifts', "json_set(NEW.data,'$.constituentId',(SELECT id FROM records WHERE collection='constituents' AND json_extract(data,'$.type')='Business'))"],
    ['gifts', "json_set(NEW.data,'$.allocations',json_array(json_extract(NEW.data,'$.allocations[1]'),json_extract(NEW.data,'$.allocations[0]')))"],
    ['gifts', "json_set(NEW.data,'$.status','Voided')"],
    ['gifts', "json_set(NEW.data,'$.schoolYear','2017–2018')"],
    ['gifts', "json_set(NEW.data,'$.acknowledgment',json_object('status','Sent'))"],
    ['communications', "json_set(NEW.data,'$.body','Wrong retained text')"],
    ['communications', "json_set(NEW.data,'$.providerMessageId','Unverified delivery')"],
    ['communications', "json_set(NEW.data,'$.version',2)"],
  ];
  for (const [collection, expression] of faults) {
    f.app.locals.db.exec(`CREATE TRIGGER corrupt_synthetic_persisted_row AFTER INSERT ON records WHEN NEW.collection='${collection}' BEGIN UPDATE records SET data=${expression} WHERE collection=NEW.collection AND id=NEW.id; END`);
    const before = f.snapshot(), preview = await f.request('/migration/preview', source); assert.equal(preview.json.valid, true);
    const result = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(result.status, 409, collection + ': ' + JSON.stringify(result.json)); assert.match(result.json.error, /persisted|retained/); assert.deepEqual(f.snapshot(), before);
    f.app.locals.db.exec('DROP TRIGGER corrupt_synthetic_persisted_row');
  }
  assert.equal((await f.commit(source)).status, 201);
});

test('a later native create cannot silently alter an earlier source identity or designation', async t => {
  const f = await fixture(t), source = all();
  f.app.locals.db.exec("CREATE TRIGGER corrupt_synthetic_earlier_parent AFTER INSERT ON records WHEN NEW.collection='communications' BEGIN UPDATE records SET data=json_set(data,'$.preference','Email') WHERE collection='constituents' AND json_extract(data,'$.type')='Staff'; UPDATE records SET data=json_set(data,'$.parentId',NULL) WHERE collection='designations' AND json_extract(data,'$.accountCode')='INTEGRITY-102'; END");
  const before = f.snapshot(), preview = await f.request('/migration/preview', source); assert.equal(preview.json.valid, true);
  const result = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(result.status, 409); assert.deepEqual(f.snapshot(), before);
});

test('mapped dependencies and same-batch reused rows remain unchanged when a subsequent gift create corrupts them', async t => {
  const f = await fixture(t), initial = input([people(), funds(), campaigns()], 'retained-source'), saved = await f.commit(initial); assert.equal(saved.status, 201);
  f.app.locals.db.exec("CREATE TRIGGER corrupt_synthetic_retained_dependency AFTER INSERT ON records WHEN NEW.collection='gifts' BEGIN UPDATE records SET data=json_set(data,'$.notes','Changed by later persistence') WHERE collection='constituents' AND json_extract(data,'$.type')='Staff'; END");
  for (const files of [[gifts()], [gifts(), people()]]) {
    const source = input(files, files.length === 1 ? 'mapped-dependency-fault' : 'reused-identity-fault'), before = f.snapshot(), preview = await f.request('/migration/preview', source); assert.equal(preview.json.valid, true);
    const result = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(result.status, 409); assert.match(result.json.error, /retained record or dependency/); assert.deepEqual(f.snapshot(), before);
  }
  f.app.locals.db.exec('DROP TRIGGER corrupt_synthetic_retained_dependency');
  const good = await f.commit(input([gifts()], 'clean-mapped-dependencies')); assert.equal(good.status, 201);
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.deepEqual(detail.json.integrity, { unchanged: 5, changed: 0, missing: 0 });
});
