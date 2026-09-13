import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { installMigrationRoutes } from '../server/migration.js';

async function fixture(t, options = {}) {
  const db = new DatabaseSync(options.dbPath || ':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS records(collection TEXT,id TEXT,data TEXT,PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action TEXT,details TEXT)');
  const list = collection => db.prepare('SELECT data FROM records WHERE collection=? ORDER BY rowid').all(collection).map(r => JSON.parse(r.data));
  const get = (collection, id) => { const row = list(collection).find(r => r.id === id); if (!row) throw Object.assign(new Error('Missing record'), { status: 400 }); return row; };
  const put = (collection, record) => db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data').run(collection, record.id, JSON.stringify(record));
  const audit = (user, action, collection, id, details = {}) => db.prepare('INSERT INTO audit(action,details) VALUES(?,?)').run(action, JSON.stringify(details));
  const validate = (collection, record, recordId) => {
    if (record.parentId) get(collection, record.parentId);
    if (collection === 'gifts') {
      get('constituents', record.constituentId);
      if (record.softCreditId) get('constituents', record.softCreditId);
      for (const allocation of record.allocations) get('designations', allocation.designationId);
      if (record.allocations.reduce((n, a) => n + a.amount, 0) !== record.amount) throw new Error('Invalid allocations');
      if (record.externalRef && list(collection).some(r => r.id !== recordId && r.externalRef === record.externalRef)) throw new Error('Duplicate external reference');
    }
    return record;
  };
  let creates = 0;
  const create = (collection, fields, user) => {
    validate(collection, fields); creates++;
    const record = { ...fields, id: randomUUID(), version: 1, createdAt: '2026-09-13T12:00:00Z', updatedAt: '2026-09-13T12:00:00Z', ...(collection === 'gifts' ? { status: 'Posted', schoolYear: '2026–2027' } : {}) };
    put(collection, options.corruptPersisted && collection === 'gifts' ? options.corruptPersisted(record, list) : record); audit(user, 'create', collection, record.id);
    if (options.failCreate === creates) throw new Error('Synthetic persistence failure');
    return record;
  };
  const transaction = callback => { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { const role = req.get('Test-Role'); if (!role) return res.status(401).json({ error: 'Authentication required' }); req.user = { id: 'test-admin', role }; next(); });
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator required' });
  const csrf = (req, res, next) => req.get('X-CSRF-Token') === 'test-csrf' ? next() : res.status(403).json({ error: 'Invalid CSRF' });
  const listCalls = [];
  const migrationList = collection => { listCalls.push(collection); return list(collection); };
  installMigrationRoutes(app, { list: migrationList, get, create, put, validate, audit, csrf, admin, transaction, db, collections: ['constituents', 'designations', 'gifts'], schoolYear: () => '2026–2027' });
  app.use((error, req, res, next) => res.status(error.status || (error.name === 'ZodError' ? 400 : 500)).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  let closed = false;
  async function close() { if (closed) return; closed = true; await new Promise(resolve => server.close(resolve)); db.close(); }
  t.after(close);
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, body, { role = 'admin', token = 'test-csrf' } = {}) {
    const response = await fetch(base + '/api/migration/' + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(role ? { 'Test-Role': role } : {}), ...(token ? { 'X-CSRF-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  }
  const counts = () => ({ records: db.prepare('SELECT COUNT(*) AS n FROM records').get().n, mappings: db.prepare('SELECT COUNT(*) AS n FROM migration_mapping').get().n, batches: db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n, audit: db.prepare('SELECT COUNT(*) AS n FROM audit').get().n });
  return { db, request, list, get, put, counts, close, listCalls };
}
const file = (collection, rows) => ({ collection, mapping: Object.fromEntries(Object.keys(rows[0]).map(k => [k, k])), rows });
const donors = () => file('constituents', [{ sourceId: 'donor-1', name: 'Fictional donor', type: 'Individual', email: 'migration@example.test', notes: 'Actual source note' }]);
const funds = () => file('designations', [{ sourceId: 'fund-1', name: 'School program', accountCode: 'SCHOOL-101' }]);
const gifts = (changes = {}) => file('gifts', [{ sourceId: 'gift-1', donorSourceId: 'donor-1', designationSourceId: 'fund-1', amount: '123.45', type: 'Cash', method: 'Check', date: '2016-09-13', externalRef: 'SOURCE-RECEIPT-1', ...changes }]);
const batch = (changes = {}) => ({ source: 'NonProfitEasy', fileKey: 'export-set-1', files: [donors(), funds(), gifts()], ...changes });
async function previewAndCommit(f, input) { const preview = await f.request('preview', input); assert.equal(preview.status, 200, JSON.stringify(preview.json)); assert.equal(preview.json.valid, true, JSON.stringify(preview.json)); return f.request('commit', { ...input, previewDigest: preview.json.previewDigest }); }

test('migration preview is read-only and same-batch gift dependencies preserve exact historical values', async t => {
  const f = await fixture(t); const before = f.counts(); const changes = f.db.prepare('SELECT total_changes() AS n').get().n;
  const input = batch({ files: [gifts(), funds(), donors()] });
  const preview = await f.request('preview', input);
  assert.equal(preview.status, 200); assert.equal(preview.json.valid, true, JSON.stringify(preview.json));
  assert.deepEqual(f.counts(), before); assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(preview.json.summary.giftTotalCents, '12345'); assert.equal(preview.json.summary.accountCodeCount, 1);
  const committed = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest }); assert.equal(committed.status, 201, JSON.stringify(committed.json));
  assert.deepEqual(f.counts(), { records: 3, mappings: 3, batches: 1, audit: 4 });
  assert.equal(f.list('gifts')[0].amount, 12345); assert.equal(f.list('gifts')[0].date, '2016-09-13');
  assert.equal(f.list('constituents')[0].notes, 'Actual source note');
  assert.equal(f.list('gifts')[0].constituentId, f.list('constituents')[0].id);
  assert.equal(committed.json.reconciliation.actualNewGiftCents, committed.json.reconciliation.expectedNewGiftCents);
  assert.match(committed.json.scope, /full NonProfitEasy history are not converted/);
});

test('source mappings persist across files/restarts and exact whole-batch reruns are idempotent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-migration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let f = await fixture(t, { dbPath: join(dir, 'test.sqlite') });
  const foundation = batch({ fileKey: 'people-and-funds', files: [donors(), funds()] });
  const committed = await previewAndCommit(f, foundation); assert.equal(committed.status, 201);
  await f.close(); f = await fixture(t, { dbPath: join(dir, 'test.sqlite') });
  const giftBatch = batch({ fileKey: 'gifts-only', files: [gifts()] });
  assert.equal((await previewAndCommit(f, giftBatch)).status, 201);
  assert.equal((await f.request('preview', batch({ fileKey: 'another-gift-preview', files: [gifts({ sourceId: 'gift-2', externalRef: 'OTHER-REF' })] }))).json.summary.accountCodeCount, 1);
  const before = f.counts();
  const replay = await f.request('commit', { ...foundation, previewDigest: committed.json.previewDigest });
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(f.counts(), before);
  const newFile = batch({ fileKey: 'repeated-records-new-file' });
  const reused = await previewAndCommit(f, newFile); assert.equal(reused.status, 201, JSON.stringify(reused.json));
  assert.equal(reused.json.summary.reusedRows, 3); assert.equal(reused.json.summary.newGiftTotalCents, '0'); assert.equal(f.counts().records, 3);
});

test('migration blocks duplicate source IDs, emails, account codes and financial references without writes', async t => {
  const f = await fixture(t);
  for (const [collection, original, duplicate] of [
    ['constituents', donors().rows[0], { ...donors().rows[0] }],
    ['constituents', donors().rows[0], { ...donors().rows[0], sourceId: 'donor-2', email: 'MIGRATION@example.test' }],
    ['designations', funds().rows[0], { ...funds().rows[0], sourceId: 'fund-2' }],
    ['gifts', gifts().rows[0], { ...gifts().rows[0], sourceId: 'gift-2' }],
  ]) {
    const files = batch().files.filter(f => f.collection !== collection); files.push(file(collection, [original, duplicate]));
    const result = await f.request('preview', batch({ files })); assert.equal(result.status, 200); assert.equal(result.json.valid, false); assert.ok(result.json.summary.errorRows >= 2);
  }
  assert.deepEqual(f.counts(), { records: 0, mappings: 0, batches: 0, audit: 0 });
  await previewAndCommit(f, batch());
  const conflict = await f.request('preview', batch({ fileKey: 'new-conflicting-file', files: [file('constituents', [{ ...donors().rows[0], sourceId: 'different-donor' }])] }));
  assert.equal(conflict.json.valid, false); assert.match(conflict.json.rows[0].error, /Existing email/);
});

test('invalid decimal/date/type/reference/allocation rows cannot partially commit', async t => {
  const f = await fixture(t);
  for (const change of [{ amount: '0.001' }, { amount: '1e3' }, { amount: '$10' }, { amount: '0' }, { amount: '10000000000.01' }, { date: '' }, { date: '2026-02-30' }, { donorSourceId: 'unknown' }, { designationSourceId: 'unknown' }, { type: 'In-kind' }, { method: 'In-kind' }]) {
    const input = batch({ files: [donors(), funds(), gifts(change)] });
    const preview = await f.request('preview', input); assert.equal(preview.status, 200); assert.equal(preview.json.valid, false, JSON.stringify(change));
    assert.equal(preview.json.previewDigest, null);
    assert.equal((await f.request('commit', { ...input, previewDigest: '0'.repeat(64) })).status, 400);
  }
  const row = { ...gifts().rows[0], allocations: JSON.stringify([{ designationSourceId: 'fund-1', amount: '100.00' }]) }; delete row.designationSourceId;
  const input = batch({ files: [donors(), funds(), file('gifts', [row])] });
  assert.equal((await f.request('preview', input)).json.valid, false);
  assert.deepEqual(f.counts(), { records: 0, mappings: 0, batches: 0, audit: 0 });
});

test('stale preview binds source, mapping and current dependency versions; reused fileKey conflicts block', async t => {
  const f = await fixture(t); await previewAndCommit(f, batch({ files: [donors(), funds()], fileKey: 'foundation' }));
  const input = batch({ files: [gifts()], fileKey: 'new-gifts' });
  const preview = await f.request('preview', input); assert.equal(preview.json.valid, true);
  const donor = f.list('constituents')[0]; f.put('constituents', { ...donor, version: 2, notes: 'Authorized staff change' });
  const before = f.counts();
  assert.ok([400, 409].includes((await f.request('commit', { ...input, previewDigest: preview.json.previewDigest })).status));
  assert.deepEqual(f.counts(), before);
  f.put('constituents', donor);
  assert.equal((await f.request('commit', { ...input, files: [gifts({ amount: '123.46' })], previewDigest: preview.json.previewDigest })).status, 409);
  assert.equal((await f.request('commit', { ...input, previewDigest: 'f'.repeat(64) })).status, 409);
  assert.equal((await f.request('preview', batch({ files: [donors(), funds()], fileKey: 'foundation', source: 'NonProfitEasy' }))).status, 200);
  const changedFoundation = batch({ files: [file('constituents', [{ ...donors().rows[0], name: 'Changed' }]), funds()], fileKey: 'foundation' });
  assert.equal((await f.request('preview', changedFoundation)).status, 409);
  const changedSourceId = batch({ files: [file('constituents', [{ ...donors().rows[0], name: 'Changed' }])], fileKey: 'different-file' });
  assert.equal((await f.request('preview', changedSourceId)).json.valid, false);
});

test('source hierarchy ordering/split allocations work, but cycles and double allocations block', async t => {
  const f = await fixture(t);
  const parent = { sourceId: 'school', name: 'School', accountCode: 'SCHOOL' };
  const child = { ...funds().rows[0], parentSourceId: 'school' };
  const fundRows = [{ ...child }, { ...parent, parentSourceId: '' }];
  const row = { ...gifts().rows[0], allocations: JSON.stringify([{ designationSourceId: 'school', amount: '23.45' }, { designationSourceId: 'fund-1', amount: '100.00' }]) }; delete row.designationSourceId;
  const input = batch({ files: [donors(), file('designations', fundRows), file('gifts', [row])] });
  const committed = await previewAndCommit(f, input); assert.equal(committed.status, 201, JSON.stringify(committed.json));
  assert.equal(f.list('designations').find(r => r.accountCode === 'SCHOOL-101').parentId, f.list('designations').find(r => r.accountCode === 'SCHOOL').id);
  assert.equal(f.list('gifts')[0].allocations.length, 2); assert.equal(committed.json.summary.allocationCount, 2);
  const cyclic = batch({ fileKey: 'cycles', files: [file('designations', [{ sourceId: 'a', name: 'A', accountCode: 'A', parentSourceId: 'b' }, { sourceId: 'b', name: 'B', accountCode: 'B', parentSourceId: 'a' }])] });
  assert.equal((await f.request('preview', cyclic)).json.valid, false);
  const duplicate = { ...row, sourceId: 'gift-2', externalRef: 'OTHER', allocations: JSON.stringify([{ designationSourceId: 'school', amount: '23.45' }, { designationSourceId: 'school', amount: '100.00' }]) };
  assert.equal((await f.request('preview', batch({ fileKey: 'duplicate-split', files: [file('gifts', [duplicate])] }))).json.valid, false);
});

test('unexpected persistence failure rolls back records, mappings, audit and batch result atomically', async t => {
  const f = await fixture(t, { failCreate: 2 }); const input = batch();
  const preview = await f.request('preview', input); assert.equal(preview.json.valid, true);
  const committed = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest }); assert.equal(committed.status, 500);
  assert.deepEqual(f.counts(), { records: 0, mappings: 0, batches: 0, audit: 0 });
});

test('migration enforces admin/CSRF, strict mapping/string format and total row limits', async t => {
  const f = await fixture(t); const input = batch();
  for (const path of ['preview', 'commit', 'batches']) {
    const body = path === 'batches' ? undefined : path === 'commit' ? { ...input, previewDigest: '0'.repeat(64) } : input;
    assert.equal((await f.request(path, body, { role: null })).status, 401);
    for (const role of ['staff', 'viewer']) assert.equal((await f.request(path, body, { role })).status, 403);
    if (body) assert.equal((await f.request(path, body, { token: null })).status, 403);
  }
  const invalid = [
    { ...input, unexpected: 'metadata' },
    { ...input, files: [{ ...donors(), mapping: { ...donors().mapping, password_hash: 'notes' } }] },
    { ...input, files: [file('constituents', [{ ...donors().rows[0], name: 42 }])] },
    { ...input, files: [{ ...donors(), collection: 'users' }] },
    { ...input, files: [{ ...donors(), rows: Array.from({ length: 500 }, (_, i) => ({ ...donors().rows[0], sourceId: String(i) })) }, funds()] },
    { ...input, files: [{ ...donors(), rows: [JSON.parse('{"__proto__":"unsafe","sourceId":"a","name":"A","type":"Individual"}')] }] },
  ];
  for (const body of invalid) assert.equal((await f.request('preview', body)).status, 400);
  assert.deepEqual(f.counts(), { records: 0, mappings: 0, batches: 0, audit: 0 });
});

test('concurrent identical commits create one batch and secret-free reconciliation history', async t => {
  const f = await fixture(t); const input = batch(); const preview = await f.request('preview', input);
  const commits = await Promise.all([1, 2].map(() => f.request('commit', { ...input, previewDigest: preview.json.previewDigest })));
  assert.deepEqual(commits.map(r => r.status).sort(), [200, 201]); assert.equal(f.counts().batches, 1); assert.equal(f.counts().records, 3);
  const history = await f.request('batches'); assert.equal(history.status, 200); assert.equal(history.json.batches.length, 1);
  const audit = f.db.prepare('SELECT * FROM audit WHERE action=?').get('migration_commit');
  assert.equal(JSON.parse(audit.details).giftTotalCents, '12345'); assert.ok(!/password|csrf|session|Actual source note/.test(audit.details));
  assert.equal(history.json.batches[0].reconciliation.actualNewGiftCents, '12345');
});

test('all revenue classes reconcile exact allocations while noncash and fees stay separate', async t => {
  const f = await fixture(t);
  const types = ['Cash', 'In-kind', 'Grant', 'Fee payment', 'Employee giving', 'Sponsorship'];
  const rows = types.map((type, i) => ({ ...gifts().rows[0], sourceId: 'revenue-' + i, externalRef: 'REVENUE-' + i, amount: '0.10', type, method: type === 'In-kind' ? 'In-kind' : type === 'Employee giving' ? 'Payroll' : 'Check' }));
  const input = batch({ files: [donors(), funds(), file('gifts', rows)] });
  const preview = await f.request('preview', input); assert.equal(preview.json.valid, true, JSON.stringify(preview.json));
  assert.equal(preview.json.summary.giftTotalCents, '60'); assert.equal(preview.json.summary.allocationTotalCents, '60');
  assert.equal(preview.json.summary.monetaryContributionCents, '40'); assert.equal(preview.json.summary.noncashValueCents, '10'); assert.equal(preview.json.summary.feePaymentCents, '10');
  const committed = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest }); assert.equal(committed.status, 201);
  assert.equal(committed.json.reconciliation.actualNewGiftCents, '60'); assert.equal(f.list('gifts').length, 6);
});


test('actual mapped source records cannot be deleted through plain or encoded IDs and replay retains existing source dependencies',async t=>{
 const app=createApp({seed:true}),server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();});const base='http://127.0.0.1:'+server.address().port;
 const signed=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'alex@foundation.example',password:'FoundationDemo!2026'})});assert.equal(signed.status,200);const session=await signed.json(),cookie=signed.headers.get('set-cookie').split(';')[0];
 const call=async(path,method,body)=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});return {status:response.status,json:await response.json()};};
 for(const [collection,sourceFile] of [['constituents',donors()],['designations',funds()]]){
  const input={source:'Retained QA source',fileKey:collection+'-only',files:[sourceFile]},preview=await call('/api/migration/preview','POST',input);assert.equal(preview.status,200);const saved=await call('/api/migration/commit','POST',{...input,previewDigest:preview.json.previewDigest});assert.equal(saved.status,201);const record=saved.json.recordIds[0];
  for(const id of [record.recordId,'%'+record.recordId.charCodeAt(0).toString(16)+record.recordId.slice(1)]){const denied=await call('/api/records/'+collection+'/'+id,'DELETE',{version:1});assert.equal(denied.status,409);assert.match(denied.json.error,/source mappings/);}
  const replay=await call('/api/migration/preview','POST',input);assert.equal(replay.status,200);assert.equal(replay.json.replayed,true);assert.ok(app.locals.db.prepare('SELECT 1 FROM records WHERE collection=? AND id=?').get(collection,record.recordId));assert.deepEqual(replay.json.recordIds,saved.json.recordIds);
 }
});


test('migration financial controls split exact cents by revenue, method and designation for new and reused gifts', async t => {
  const f = await fixture(t);
  const fund2 = { sourceId: 'fund-2', name: 'Second program', accountCode: 'SECOND-202' };
  const split = { ...gifts().rows[0], amount: '0.30', allocations: JSON.stringify([{ designationSourceId: 'fund-1', amount: '0.10' }, { designationSourceId: 'fund-2', amount: '0.20' }]) };
  delete split.designationSourceId;
  const noncash = { ...split, sourceId: 'noncash', externalRef: 'NONCASH', amount: '1.10', type: 'In-kind', method: 'In-kind', allocations: JSON.stringify([{ designationSourceId: 'fund-2', amount: '1.10' }]) };
  const input = batch({ files: [donors(), file('designations', [funds().rows[0], fund2]), file('gifts', [split, noncash])] });
  const preview = await f.request('preview', input);
  const controls = preview.json.summary.controlTotals;
  assert.deepEqual(controls.all.byType, [{ key: 'Cash', giftCount: 1, totalCents: '30' }, { key: 'In-kind', giftCount: 1, totalCents: '110' }]);
  assert.deepEqual(controls.all.byMethod, [{ key: 'Check', giftCount: 1, totalCents: '30' }, { key: 'In-kind', giftCount: 1, totalCents: '110' }]);
  assert.deepEqual(controls.all.byDesignation, [{ sourceId: 'fund-1', accountCode: 'SCHOOL-101', allocationCount: 1, totalCents: '10' }, { sourceId: 'fund-2', accountCode: 'SECOND-202', allocationCount: 2, totalCents: '130' }]);
  assert.deepEqual(controls.new, controls.all); assert.deepEqual(controls.reused.byType, []);
  const committed = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest }); assert.equal(committed.status, 201, JSON.stringify(committed.json));
  assert.deepEqual(committed.json.reconciliation.actualNewControlTotals, controls.all);
  const repeat = await previewAndCommit(f, { ...input, fileKey: 'same-rows-new-batch' });
  assert.equal(repeat.status, 201); assert.deepEqual(repeat.json.summary.controlTotals.reused, controls.all); assert.deepEqual(repeat.json.summary.controlTotals.new.byType, []);
  assert.deepEqual(repeat.json.reconciliation.actualNewControlTotals.byDesignation, []); assert.equal(f.list('gifts').length, 2);
  const replay = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest });
  assert.equal(replay.status, 200); assert.deepEqual(replay.json.summary.controlTotals, controls);
});

test('same-grand-total posting to the wrong revenue class or payment method rolls back conversion', async t => {
  for (const change of [{ type: 'Grant' }, { method: 'Cash' }]) {
    const f = await fixture(t, { corruptPersisted: record => ({ ...record, ...change }) });
    const input = batch(); const preview = await f.request('preview', input);
    const before = f.counts();
    const committed = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest });
    assert.equal(committed.status, 409); assert.match(committed.json.error, /reconciliation failed/); assert.deepEqual(f.counts(), before);
  }
});

test('same-grand-total allocation misposting rolls back source records and lineage atomically', async t => {
  const f = await fixture(t, { corruptPersisted: record => ({ ...record, allocations: record.allocations.map(a => ({ ...a, amount: a.amount === 10000 ? 2345 : 10000 })) }) });
  const row = { ...gifts().rows[0], allocations: JSON.stringify([{ designationSourceId: 'fund-1', amount: '100.00' }, { designationSourceId: 'fund-2', amount: '23.45' }]) }; delete row.designationSourceId;
  const input = batch({ files: [donors(), file('designations', [funds().rows[0], { sourceId: 'fund-2', name: 'Other fund', accountCode: 'SECOND-202' }]), file('gifts', [row])] });
  const preview = await f.request('preview', input); assert.equal(preview.json.valid, true);
  const committed = await f.request('commit', { ...input, previewDigest: preview.json.previewDigest });
  assert.equal(committed.status, 409); assert.match(committed.json.error, /reconciliation failed/);
  assert.deepEqual(f.counts(), { records: 0, mappings: 0, batches: 0, audit: 0 });
});

test('batch detail preserves immutable financial reconciliation and reports current source lineage separately', async t => {
  const f = await fixture(t); const input = batch(); const committed = await previewAndCommit(f, input);
  const initial = await f.request('batches/' + committed.json.batchId);
  assert.equal(initial.status, 200); assert.deepEqual(initial.json.batch, committed.json);
  assert.deepEqual(initial.json.integrity, { unchanged: 3, changed: 0, missing: 0 });
  assert.equal(initial.json.lineageCoverage, 'All batch source rows'); assert.match(initial.json.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(initial.json.batch.sourceFiles[0], { file: 1, collection: 'constituents', rowCount: 1, mapping: donors().mapping });
  assert.ok(!JSON.stringify(initial.json).includes('Actual source note'));
  const gift = f.list('gifts')[0]; f.put('gifts', { ...gift, version: 2, notes: 'Authorized later correction' });
  const detail = await f.request('batches/' + committed.json.batchId);
  assert.deepEqual(detail.json.batch, committed.json); assert.deepEqual(detail.json.integrity, { unchanged: 2, changed: 1, missing: 0 });
  assert.equal(detail.json.lineage.find(r => r.collection === 'gifts').status, 'Changed');
  assert.equal(detail.json.lineage.find(r => r.collection === 'gifts').originalBatchId, committed.json.batchId);
  const replay = await f.request('preview', input); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.reconciliation, committed.json.reconciliation);
  const donor = f.list('constituents')[0]; f.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run('constituents', donor.id);
  assert.deepEqual((await f.request('batches/' + committed.json.batchId)).json.integrity, { unchanged: 1, changed: 1, missing: 1 });
});

test('reused batch lineage points to its original source batch and legacy history discloses limited coverage', async t => {
  const f = await fixture(t); const first = await previewAndCommit(f, batch());
  const second = await previewAndCommit(f, batch({ fileKey: 'reused-source-batch' }));
  const detail = await f.request('batches/' + second.json.batchId);
  assert.equal(detail.json.lineage.length, 3); assert.ok(detail.json.lineage.every(r => r.reused && r.originalBatchId === first.json.batchId));
  const legacy = { ...first.json }; delete legacy.sourceRecords; delete legacy.sourceFiles;
  f.db.prepare('UPDATE import_batches SET result=? WHERE id=?').run(JSON.stringify(legacy), first.json.batchId);
  const old = await f.request('batches/' + first.json.batchId);
  assert.equal(old.json.lineageCoverage, 'Newly created rows only'); assert.equal(old.json.lineage.length, 3);
});

test('batch detail rejects invalid and unknown identifiers and never exposes conversion history to staff', async t => {
  const f = await fixture(t); const committed = await previewAndCommit(f, batch());
  assert.equal((await f.request('batches/not-an-id')).status, 400);
  assert.equal((await f.request('batches/' + randomUUID())).status, 404);
  for (const role of ['staff', 'viewer']) assert.equal((await f.request('batches/' + committed.json.batchId, undefined, { role })).status, 403);
  assert.equal((await f.request('batches/' + committed.json.batchId, undefined, { role: null })).status, 401);
});


test('mounted first import invalidates preview when a February fiscal start changes to March in an empty workspace', async t => {
  const credentials = { name: 'Migration operator', email: 'migration.operator@example.test', password: 'MigrationFixture!2026' };
  const app = createApp({ seed: false, initialAdmin: credentials });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const signed = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: credentials.email, password: credentials.password }) });
  assert.equal(signed.status, 200); const session = await signed.json(), cookie = signed.headers.get('set-cookie').split(';')[0];
  const call = async (path, method, body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM records').get().n, 0);
  assert.equal((await call('/api/settings', 'PATCH', { organizationName: 'Wimblo', fiscalStartMonth: 2 })).status, 200);
  const input = batch({ files: [donors(), funds(), gifts({ date: '2026-02-15' })] });
  const first = await call('/api/migration/preview', 'POST', input); assert.equal(first.status, 200); assert.equal(first.json.valid, true);
  assert.equal((await call('/api/settings', 'PATCH', { organizationName: 'Wimblo', fiscalStartMonth: 3 })).status, 200);
  const auditBefore = app.locals.db.prepare('SELECT count(*) n FROM audit').get().n;
  const stale = await call('/api/migration/commit', 'POST', { ...input, previewDigest: first.json.previewDigest });
  assert.equal(stale.status, 409); assert.match(stale.json.error, /Preview changed or expired/);
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM records').get().n, 0);
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM migration_mapping').get().n, 0);
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n, 0);
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM audit').get().n, auditBefore);
  const fresh = await call('/api/migration/preview', 'POST', input);
  assert.equal(fresh.status, 200); assert.notEqual(fresh.json.previewDigest, first.json.previewDigest);
  const committed = await call('/api/migration/commit', 'POST', { ...input, previewDigest: fresh.json.previewDigest });
  assert.equal(committed.status, 201, JSON.stringify(committed.json));
  const record = JSON.parse(app.locals.db.prepare("SELECT data FROM records WHERE collection='gifts'").get().data);
  assert.equal(record.date, '2026-02-15'); assert.equal(record.schoolYear, '2025–2026');
});


function insertHistory(f, id, time, index, extra = {}) {
  const result = { batchId: id, source: 'History fixture', fileKey: 'history-' + index, committedAt: time, valid: true, replayed: false,
    summary: { rowCount: 500, giftTotalCents: '10', newGiftTotalCents: '10' }, reconciliation: { expectedNewGiftCents: '10', actualNewGiftCents: '10' }, ...extra };
  f.db.prepare('INSERT INTO import_batches VALUES(?,?,?,?,?,?,?,?)').run(id, result.source, result.fileKey, 'a'.repeat(64), 'b'.repeat(64), time, 'test-admin', JSON.stringify(result));
  return result;
}

test('migration history keyset pages every older batch once with stable timestamp ties and a bounded compact list', async t => {
  const f = await fixture(t); const expected = [];
  for (let i = 0; i < 113; i++) {
    const id = randomUUID(), time = i < 60 ? '2026-09-13T12:00:00.000Z' : '2026-09-12T12:00:00.000Z';
    insertHistory(f, id, time, i, { summary: { rowCount: 500, giftTotalCents: '10', newGiftTotalCents: '10', controlTotals: { all: { byDesignation: [{ description: 'x'.repeat(8000) }] } } }, reconciliation: { expectedNewGiftCents: '10', actualNewGiftCents: '10', expectedNewControlTotals: { byDesignation: [{ description: 'x'.repeat(8000) }] }, actualNewControlTotals: { byDesignation: [{ description: 'x'.repeat(8000) }] } }, rows: [{ notes: 'x'.repeat(8000) }], sourceRecords: [{ collection: 'constituents', sourceId: 'Not in compact list', recordId: randomUUID(), reused: false }], sourceFiles: [{ mapping: { notes: 'Private source column' } }], recordIds: [{ recordId: randomUUID() }] });
    expected.push({ id, time });
  }
  expected.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
  const seen = []; let cursor = null, pages = 0;
  do {
    const page = await f.request('batches' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(page.status, 200); assert.ok(page.json.batches.length <= 25);
    assert.ok(JSON.stringify(page.json).length < 20000);
    for (const row of page.json.batches) {
      assert.equal(row.summary.giftTotalCents, '10'); assert.equal(row.reconciliation.actualNewGiftCents, '10');
      assert.ok(!Object.hasOwn(row.summary, 'controlTotals')); assert.ok(!Object.hasOwn(row.reconciliation, 'expectedNewControlTotals')); assert.ok(!Object.hasOwn(row.reconciliation, 'actualNewControlTotals'));
      for (const field of ['rows', 'recordIds', 'sourceFiles', 'sourceRecords', 'previewDigest']) assert.ok(!Object.hasOwn(row, field));
      seen.push(row.batchId);
    }
    cursor = page.json.nextCursor; pages++;
  } while (cursor);
  assert.equal(pages, 5); assert.deepEqual(seen, expected.map(r => r.id)); assert.equal(new Set(seen).size, 113);
  const detail = await f.request('batches/' + seen.at(-1)); assert.equal(detail.status, 200); assert.equal(detail.json.batch.rows[0].notes.length, 8000); assert.equal(detail.json.batch.summary.controlTotals.all.byDesignation[0].description.length, 8000);
  const max = await f.request('batches?limit=100'); assert.equal(max.status, 200); assert.equal(max.json.batches.length, 100); assert.ok(max.json.nextCursor);
  const plan = f.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM import_batches WHERE (committed_at,id)<(?,?) ORDER BY committed_at DESC,id DESC LIMIT ?').all('2026-09-13T12:00:00.000Z', seen[0], 26);
  assert.ok(plan.some(r => /SEARCH .*import_batches_history/.test(r.detail)), JSON.stringify(plan));
});

test('history cursor does not repeat rows when a newer batch arrives between pages or the cursor row is removed', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) insertHistory(f, randomUUID(), '2026-09-13T12:00:00.000Z', i);
  const first = await f.request('batches?limit=4'); assert.equal(first.json.batches.length, 4);
  const newest = randomUUID(); insertHistory(f, newest, '2026-09-14T12:00:00.000Z', 8);
  f.db.prepare('DELETE FROM import_batches WHERE id=?').run(first.json.batches.at(-1).batchId);
  const second = await f.request('batches?limit=4&cursor=' + first.json.nextCursor);
  assert.equal(second.status, 200); assert.equal(second.json.batches.length, 4); assert.equal(second.json.nextCursor, null);
  assert.ok(!second.json.batches.some(row => first.json.batches.some(old => old.batchId === row.batchId)));
  assert.ok(!second.json.batches.some(row => row.batchId === newest));
  assert.equal((await f.request('batches?limit=1')).json.batches[0].batchId, newest);
});

test('migration history rejects malformed and oversized pagination before exposing batches', async t => {
  const f = await fixture(t); await previewAndCommit(f, batch());
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const invalid = ['?limit=0', '?limit=101', '?limit=1.5', '?limit=NaN', '?limit=1&limit=2', '?unknown=1', '?cursor=', '?cursor=' + 'x'.repeat(401), '?cursor=!!!!',
    '?cursor=' + encoded({ committedAt: 'not-a-date', id: randomUUID() }), '?cursor=' + encoded({ committedAt: '2026-09-13T12:00:00.000Z', id: 'not-a-uuid' }),
    '?cursor=' + encoded({ committedAt: '2026-09-13T12:00:00.000Z', id: randomUUID(), limit: 999 }), '?cursor=' + Buffer.from('not-json').toString('base64url')];
  for (const query of invalid) assert.equal((await f.request('batches' + query)).status, 400, query);
  for (const role of ['staff', 'viewer']) assert.equal((await f.request('batches?limit=2', undefined, { role })).status, 403);
  assert.equal((await f.request('batches?limit=2', undefined, { role: null })).status, 401);
});

test('empty migration history returns a terminal page without a cursor or count query', async t => {
  const f = await fixture(t); const page = await f.request('batches');
  assert.equal(page.status, 200); assert.deepEqual(page.json.batches, []); assert.equal(page.json.nextCursor, null);
});


test('indexed duplicate checking preserves all conflicting rows, mixed case/trimmed values and bounded planning collection reads', async t => {
  const f = await fixture(t);
  const donorRows = Array.from({ length: 250 }, (_, i) => ({ sourceId: 'large-person-' + i, name: 'Synthetic person ' + i, type: 'Individual', email: 'large-person-' + i + '@example.test' }));
  const fundRows = Array.from({ length: 250 }, (_, i) => ({ sourceId: 'large-fund-' + i, name: 'Synthetic fund ' + i, accountCode: 'LARGE-CODE-' + i }));
  donorRows[249].email = donorRows[0].email.toUpperCase(); fundRows[249].accountCode = '  large-code-0  ';
  const input = batch({ fileKey: 'large-mixed-collision', files: [file('constituents', donorRows), file('designations', fundRows)] });
  const before = f.counts(); f.listCalls.length = 0;
  const preview = await f.request('preview', input); assert.equal(preview.status, 200); assert.equal(preview.json.valid, false); assert.equal(preview.json.summary.errorRows, 4);
  assert.equal(preview.json.rows.filter(row => row.error === 'Duplicate email in this batch').length, 2);
  assert.equal(preview.json.rows.filter(row => row.error === 'Duplicate accountCode in this batch').length, 2);
  assert.deepEqual(f.listCalls.sort(), ['constituents', 'designations', 'gifts']); assert.deepEqual(f.counts(), before);
  donorRows[249].email = 'large-person-249@example.test'; fundRows[249].accountCode = 'LARGE-CODE-249'; f.listCalls.length = 0;
  const valid = await f.request('preview', input); assert.equal(valid.json.valid, true); assert.equal(valid.json.summary.validRows, 500);
  assert.deepEqual(f.listCalls.sort(), ['constituents', 'designations', 'gifts']); assert.deepEqual(f.counts(), before);
});

test('indexed collisions exclude source-reused nodes from new groups but keep their current stored values as existing conflicts', async t => {
  const f = await fixture(t); const committed = await previewAndCommit(f, batch()); assert.equal(committed.status, 201);
  const input = batch({ fileKey: 'mapped-and-new-conflicts', files: [
    file('constituents', [donors().rows[0], { ...donors().rows[0], sourceId: 'new-donor', email: donors().rows[0].email.toUpperCase() }]),
    file('designations', [funds().rows[0], { ...funds().rows[0], sourceId: 'new-fund', accountCode: '  school-101  ' }]),
    file('gifts', [gifts().rows[0], { ...gifts().rows[0], sourceId: 'new-gift', externalRef: '  source-receipt-1  ' }]),
  ] });
  const before = f.counts(), preview = await f.request('preview', input); assert.equal(preview.json.valid, false);
  for (const sourceId of ['donor-1', 'fund-1', 'gift-1']) assert.equal(preview.json.rows.find(row => row.sourceId === sourceId).status, 'Already mapped');
  for (const sourceId of ['new-donor', 'new-fund', 'new-gift']) assert.match(preview.json.rows.find(row => row.sourceId === sourceId).error, /^Existing /);
  assert.equal(preview.json.rows.some(row => /^Duplicate /.test(row.error)), false); assert.deepEqual(f.counts(), before);
});

test('indexed duplicate checks retain legacy raw-empty versus whitespace-only key boundaries', async t => {
  const f = await fixture(t); assert.equal((await previewAndCommit(f, batch({ fileKey: 'blank-keys-foundation', files: [donors(), funds()] }))).status, 201);
  const giftRows = Array.from({ length: 3 }, (_, i) => ({ ...gifts().rows[0], sourceId: 'blank-gift-' + i, externalRef: '' }));
  const input = batch({ fileKey: 'blank-gifts', files: [file('gifts', giftRows)] });
  assert.equal((await f.request('preview', input)).json.valid, true);
  giftRows[0].externalRef = '   ';
  const whitespace = await f.request('preview', input); assert.equal(whitespace.json.valid, false);
  assert.equal(whitespace.json.rows.filter(row => row.error === 'Duplicate externalRef in this batch').length, 3);
  const donor = f.list('constituents')[0], fund = f.list('designations')[0];
  f.put('gifts', { id: randomUUID(), constituentId: donor.id, amount: 12345, type: 'Cash', method: 'Check', date: '2016-09-13', status: 'Posted', allocations: [{ designationId: fund.id, amount: 12345 }], externalRef: '' });
  const one = await f.request('preview', batch({ fileKey: 'one-whitespace-gift', files: [gifts({ sourceId: 'white-single', externalRef: ' ' })] }));
  assert.equal(one.json.valid, false); assert.match(one.json.rows[0].error, /^Existing externalRef/);
  const whitespaceFunds = file('designations', [{ sourceId: 'whitespace-fund-1', name: 'Synthetic blank-code fund 1', accountCode: ' ' }, { sourceId: 'whitespace-fund-2', name: 'Synthetic blank-code fund 2', accountCode: '  ' }]);
  const codes = await f.request('preview', batch({ fileKey: 'white-account-codes', files: [whitespaceFunds] }));
  assert.equal(codes.json.valid, false); assert.equal(codes.json.rows.filter(row => row.error === 'Duplicate accountCode in this batch').length, 2);
});

test('mounted 500-row source batch rejects normalized collisions then preserves exact mapped identity, replay and reordered source keys after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-large-migration-')); const dbPath = join(dir, 'workspace.sqlite');
  const credentials = { name: 'Synthetic conversion operator', email: 'large.operator@example.test', password: 'LargeSourceFixture!2026' };
  let app, server, base, session;
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function call(path, body) {
    const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function open() {
    app = createApp({ dbPath, seed: false, initialAdmin: credentials }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; session = null;
    const signed = await call('/auth/login', { email: credentials.email, password: credentials.password }); assert.equal(signed.status, 200); session = { ...signed.json, cookie: signed.headers.get('set-cookie').split(';')[0] };
  }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const people = Array.from({ length: 250 }, (_, i) => ({ sourceId: 'mounted-person-' + i, name: 'Synthetic migrated person ' + i, type: i % 20 === 0 ? 'Staff' : 'Individual', email: 'mounted-person-' + i + '@example.test' }));
  const revenue = Array.from({ length: 249 }, (_, i) => ({ ...gifts().rows[0], sourceId: 'mounted-gift-' + i, donorSourceId: people[i].sourceId, amount: '0.10', externalRef: 'MOUNTED-REVENUE-' + i }));
  const input = batch({ fileKey: 'mounted-large-source', files: [file('constituents', people), funds(), file('gifts', revenue)] });
  people[249].email = people[0].email.toUpperCase(); revenue[248].externalRef = '  mounted-revenue-0  ';
  const invalid = await call('/migration/preview', input); assert.equal(invalid.status, 200); assert.equal(invalid.json.valid, false);
  assert.equal(invalid.json.rows.filter(row => row.error === 'Duplicate email in this batch').length, 2);
  assert.equal(invalid.json.rows.filter(row => row.error === 'Duplicate externalRef in this batch').length, 2);
  const rejected = await call('/migration/commit', { ...input, previewDigest: '0'.repeat(64) }); assert.equal(rejected.status, 400);
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM records').get().n, 0); assert.equal(app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n, 0);
  people[249].email = 'mounted-person-249@example.test'; revenue[248].externalRef = 'MOUNTED-REVENUE-248';
  const preview = await call('/migration/preview', input); assert.equal(preview.json.valid, true);
  const saved = await call('/migration/commit', { ...input, previewDigest: preview.json.previewDigest }); assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.reconciliation.actualCreateCounts, { constituents: 250, designations: 1, gifts: 249 }); assert.equal(saved.json.reconciliation.actualNewGiftCents, '2490');
  const mappingsBefore = app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all();
  await close(); await open();
  const reverseKeys = object => Object.fromEntries(Object.entries(object).reverse());
  const reordered = { ...input, files: input.files.map(source => ({ ...source, mapping: reverseKeys(source.mapping), rows: source.rows.map(reverseKeys) })) };
  const replay = await call('/migration/commit', { ...reordered, previewDigest: preview.json.previewDigest }); assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true);
  assert.deepEqual(app.locals.db.prepare('SELECT * FROM migration_mapping ORDER BY collection,external_id').all(), mappingsBefore);
  const reusedPreview = await call('/migration/preview', { ...reordered, fileKey: 'mounted-large-reuse' }); assert.equal(reusedPreview.json.valid, true, JSON.stringify(reusedPreview.json)); assert.equal(reusedPreview.json.summary.reusedRows, 500); assert.equal(reusedPreview.json.summary.newGiftTotalCents, '0');
  const reuse = await call('/migration/commit', { ...reordered, fileKey: 'mounted-large-reuse', previewDigest: reusedPreview.json.previewDigest }); assert.equal(reuse.status, 201); assert.equal(reuse.json.recordIds.length, 0);
  const data = (await call('/workspace')).json.data; assert.equal(data.constituents.length, 250); assert.equal(data.designations.length, 1); assert.equal(data.gifts.length, 249); assert.equal(data.gifts.reduce((sum, g) => sum + g.amount, 0), 2490);
  const mapped = data.constituents.find(row => row.email === people[0].email); assert.equal(mapped.type, 'Staff'); assert.equal(data.gifts.find(row => row.externalRef === revenue[0].externalRef).constituentId, mapped.id);
  const collision = await call('/migration/preview', batch({ fileKey: 'post-restart-existing-collision', files: [file('constituents', [{ ...people[0], sourceId: 'different-new-id', email: people[0].email.toUpperCase() }])] }));
  assert.equal(collision.json.valid, false); assert.match(collision.json.rows[0].error, /^Existing email/);
});
