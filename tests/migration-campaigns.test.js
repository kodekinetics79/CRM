import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const operator = { name: 'Synthetic campaign conversion operator', email: 'campaign.operator@example.test', password: 'CampaignSourceFixture!2026' };
const file = (collection, rows) => ({ collection, mapping: Object.fromEntries(Object.keys(rows[0]).map(key => [key, key])), rows });
const people = () => file('constituents', [{ sourceId: 'person-1', name: 'Synthetic historical donor', type: 'Individual', email: 'campaign.person@example.test' }]);
const funds = () => file('designations', [{ sourceId: 'fund-1', name: 'Synthetic historical designation', accountCode: 'CAMPAIGN-101' }]);
const campaign = (changes = {}) => ({ sourceId: 'campaign-1', name: 'Synthetic historical campaign', type: 'Annual', goal: '1000.01', startDate: '2016-01-01', endDate: '2016-12-31', status: 'Completed', description: 'Original source description', ...changes });
const revenue = (changes = {}) => ({ sourceId: 'gift-1', donorSourceId: 'person-1', designationSourceId: 'fund-1', campaignSourceId: 'campaign-1', amount: '1.01', type: 'Cash', method: 'Check', date: '2016-09-13', externalRef: 'CAMPAIGN-SOURCE-GIFT', ...changes });
const input = (files, fileKey = 'campaign-source-1') => ({ source: 'Synthetic normalized campaign export', fileKey, files });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-campaign-conversion-')), dbPath = join(dir, 'workspace.sqlite');
  let app, server, base, admin, staff, viewer;
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, body, session = admin, method = body === undefined ? 'GET' : 'POST', extra = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login(email = operator.email) {
    const result = await request('/auth/login', { email, password: operator.password }, null); assert.equal(result.status, 200);
    return { ...result.json, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  async function open() { app = createApp({ dbPath, seed: false, initialAdmin: operator }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; admin = await login(); }
  await open();
  for (const role of ['staff', 'viewer']) assert.equal((await request('/users', { name: 'Synthetic ' + role, email: role + '.campaign@example.test', password: operator.password, role })).status, 201);
  staff = await login('staff.campaign@example.test'); viewer = await login('viewer.campaign@example.test');
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const counts = () => ({ records: app.locals.db.prepare('SELECT count(*) n FROM records').get().n, mappings: app.locals.db.prepare('SELECT count(*) n FROM migration_mapping').get().n, batches: app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n, audit: app.locals.db.prepare('SELECT count(*) n FROM audit').get().n });
  async function commit(source) { const preview = await request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true, JSON.stringify(preview.json)); return request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); }
  return { request, commit, counts, get app() { return app; }, get sessions() { return { admin, staff, viewer }; }, restart: async () => { await close(); await open(); staff = await login('staff.campaign@example.test'); viewer = await login('viewer.campaign@example.test'); } };
}

async function workspace(f) { const result = await f.request('/workspace'); assert.equal(result.status, 200); return result.json.data; }

test('same-batch historical campaign dependencies resolve in arbitrary order while goals remain separate from gift revenue', async t => {
  const f = await fixture(t);
  const source = input([file('gifts', [revenue()]), file('campaigns', [campaign(), campaign({ sourceId: 'campaign-zero', goal: '0.00' })]), funds(), people()]);
  const before = f.counts(), preview = await f.request('/migration/preview', source);
  assert.equal(preview.status, 200); assert.equal(preview.json.valid, true); assert.deepEqual(f.counts(), before);
  assert.equal(preview.json.summary.campaigns, 2); assert.equal(preview.json.summary.giftTotalCents, '101');
  assert.equal(preview.json.summary.newGiftTotalCents, '101'); assert.equal(preview.json.summary.createCounts.campaigns, 2);
  const saved = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.reconciliation.actualCreateCounts, { constituents: 1, designations: 1, campaigns: 2, gifts: 1 });
  assert.equal(saved.json.reconciliation.actualNewGiftCents, '101');
  const data = await workspace(f), original = data.campaigns.find(row => row.goal === 100001);
  assert.equal(data.campaigns.length, 2); assert.equal(data.campaigns.find(row => row.id !== original.id).goal, 0);
  assert.equal(original.startDate, '2016-01-01'); assert.equal(original.endDate, '2016-12-31'); assert.equal(original.status, 'Completed'); assert.equal(original.description, 'Original source description');
  assert.equal(data.gifts[0].campaignId, original.id); assert.equal(data.gifts[0].amount, 101);
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.equal(detail.status, 200); assert.deepEqual(detail.json.integrity, { unchanged: 5, changed: 0, missing: 0 });
});

test('campaign goals and calendar contracts reject invalid inputs without inventing defaults or partially creating records', async t => {
  const f = await fixture(t);
  const invalid = [{ goal: '-1' }, { goal: '0.001' }, { goal: '1e3' }, { goal: '$10' }, { goal: '' }, { goal: '10000000000.01' }, { startDate: '' }, { startDate: '2016-02-30' }, { endDate: '2015-12-31' }, { type: 'Unknown campaign type' }, { status: '' }];
  for (const changes of invalid) {
    const source = input([file('campaigns', [campaign(changes)])], 'bad-' + JSON.stringify(changes)), before = f.counts();
    const preview = await f.request('/migration/preview', source); assert.equal(preview.status, 200); assert.equal(preview.json.valid, false, JSON.stringify(changes)); assert.equal(preview.json.previewDigest, null);
    assert.equal((await f.request('/migration/commit', { ...source, previewDigest: '0'.repeat(64) })).status, 400); assert.deepEqual(f.counts(), before);
  }
  const missing = campaign(); delete missing.startDate;
  assert.equal((await f.request('/migration/preview', input([file('campaigns', [missing])]))).status, 400);
  const maximal = await f.commit(input([file('campaigns', [campaign({ goal: '10000000000.00' })])], 'max-goal')); assert.equal(maximal.status, 201);
  assert.equal((await workspace(f)).campaigns[0].goal, 1000000000000); assert.equal(maximal.json.reconciliation.actualNewGiftCents, '0');
});

test('gift campaign references require same-source mapping and unchanged current campaign dependencies', async t => {
  const f = await fixture(t);
  assert.equal((await f.commit(input([people(), funds(), file('campaigns', [campaign()])], 'foundational-campaign-source'))).status, 201);
  const source = input([file('gifts', [revenue()])], 'campaign-gifts-only'), preview = await f.request('/migration/preview', source);
  assert.equal(preview.json.valid, true); assert.deepEqual(preview.json.summary.createCounts, { constituents: 0, designations: 0, gifts: 1 }); assert.ok(!Object.hasOwn(preview.json.summary, 'campaigns'));
  const unknown = await f.request('/migration/preview', input([file('gifts', [revenue({ campaignSourceId: 'missing-source-campaign' })])], 'unknown-campaign'));
  assert.equal(unknown.json.valid, false); assert.match(unknown.json.rows[0].error, /Unmapped campaigns source identifier/);
  const otherSource = await f.request('/migration/preview', { ...source, source: 'Another source namespace' }); assert.equal(otherSource.json.valid, false);
  const original = (await workspace(f)).campaigns[0];
  const changed = await f.request('/records/campaigns/' + original.id, { version: original.version, description: 'Explicit staff correction after preview' }, f.sessions.admin, 'PATCH'); assert.equal(changed.status, 200);
  const before = f.counts(), stale = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(stale.status, 400); assert.deepEqual(f.counts(), before);
  const current = await f.request('/migration/preview', source); assert.equal(current.json.valid, false); assert.match(current.json.rows[0].error, /Previously mapped dependency changed/);
});

test('campaign source identifiers reject duplicates or changed reuse without inferring identity from identical names', async t => {
  const f = await fixture(t);
  const duplicate = await f.request('/migration/preview', input([file('campaigns', [campaign(), campaign()])])); assert.equal(duplicate.json.valid, false); assert.equal(duplicate.json.summary.errorRows, 2);
  const saved = await f.commit(input([file('campaigns', [campaign(), campaign({ sourceId: 'campaign-other', goal: '0' })])], 'same-name-distinct-source')); assert.equal(saved.status, 201); assert.equal((await workspace(f)).campaigns.length, 2);
  const changed = await f.request('/migration/preview', input([file('campaigns', [campaign({ goal: '1000.02' })])], 'source-value-conflict')); assert.equal(changed.json.valid, false); assert.match(changed.json.rows[0].error, /already imported with different values/);
});

test('campaign create failure rolls back records, mappings, batch and audit atomically; access and CSRF remain administrator-only', async t => {
  const f = await fixture(t), source = input([people(), funds(), file('campaigns', [campaign()]), file('gifts', [revenue()])]);
  for (const session of [f.sessions.staff, f.sessions.viewer]) {
    assert.equal((await f.request('/migration/preview', source, session)).status, 403);
    assert.equal((await f.request('/migration/commit', { ...source, previewDigest: '0'.repeat(64) }, session)).status, 403);
  }
  assert.equal((await f.request('/migration/preview', source, null)).status, 401);
  assert.equal((await f.request('/migration/preview', source, f.sessions.admin, 'POST', { 'X-CSRF-Token': 'invalid' })).status, 403);
  f.app.locals.db.exec("CREATE TRIGGER fail_synthetic_campaign_write BEFORE INSERT ON records WHEN NEW.collection='campaigns' BEGIN SELECT RAISE(ABORT,'Synthetic campaign persistence fault'); END");
  const before = f.counts(), preview = await f.request('/migration/preview', source); assert.equal(preview.json.valid, true);
  const failure = await f.request('/migration/commit', { ...source, previewDigest: preview.json.previewDigest }); assert.equal(failure.status, 500); assert.deepEqual(f.counts(), before);
});

test('campaign mapping, linked gifts and exact source replay survive restart; unmapped optional campaign field preserves prior gift fingerprints', async t => {
  const f = await fixture(t), oldGift = revenue({ sourceId: 'gift-old', externalRef: 'OLD-GIFT', notes: 'Preserved source note' }); delete oldGift.campaignSourceId;
  const legacy = input([people(), funds(), file('gifts', [oldGift])], 'legacy-three-collection-source');
  const old = await f.commit(legacy); assert.equal(old.status, 201);
  const oldSourceHash = f.app.locals.db.prepare("SELECT source_hash FROM migration_mapping WHERE collection='gifts' AND external_id='gift-old'").get().source_hash;
  // Golden fingerprint from the original three-collection normalized source
  // contract. Appending campaignSourceId:'' would change this existing identity.
  assert.equal(oldSourceHash, 'f5b6dfffd6ccd0a864ac94ea49d64ef616e37bba87ce298ee0603be3b0319379');
  assert.deepEqual(old.json.summary.createCounts, { constituents: 1, designations: 1, gifts: 1 });
  const campaignSource = input([file('campaigns', [campaign()])], 'historical-campaign-only');
  const savedCampaign = await f.commit(campaignSource); assert.equal(savedCampaign.status, 201);
  const giftSource = input([file('gifts', [revenue()])], 'linked-historical-gift'); const savedGift = await f.commit(giftSource); assert.equal(savedGift.status, 201);
  const mappings = f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all();
  await f.restart();
  for (const [source, saved] of [[legacy, old], [campaignSource, savedCampaign], [giftSource, savedGift]]) {
    const replay = await f.request('/migration/commit', { ...source, previewDigest: saved.json.previewDigest }); assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.recordIds, saved.json.recordIds);
  }
  const reused = await f.commit({ ...legacy, fileKey: 'legacy-record-reuse-after-campaign-upgrade' }); assert.equal(reused.status, 201); assert.equal(reused.json.summary.reusedRows, 3); assert.equal(reused.json.recordIds.length, 0);
  assert.deepEqual(f.app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all(), mappings);
  const explicitBlank = await f.request('/migration/preview', input([file('gifts', [{ ...oldGift, campaignSourceId: '' }])], 'explicit-new-campaign-source-field'));
  assert.equal(explicitBlank.json.valid, false); assert.match(explicitBlank.json.rows[0].error, /already imported with different values|Existing externalRef/);
  const data = await workspace(f); assert.equal(data.gifts.length, 2); assert.equal(data.gifts.reduce((sum, g) => sum + g.amount, 0), 202);
  assert.equal(data.gifts.find(row => row.externalRef === 'OLD-GIFT').campaignId, null); assert.equal(data.gifts.find(row => row.externalRef === 'CAMPAIGN-SOURCE-GIFT').campaignId, data.campaigns[0].id);
});
