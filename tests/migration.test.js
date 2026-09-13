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
    put(collection, record); audit(user, 'create', collection, record.id);
    if (options.failCreate === creates) throw new Error('Synthetic persistence failure');
    return record;
  };
  const transaction = callback => { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { const role = req.get('Test-Role'); if (!role) return res.status(401).json({ error: 'Authentication required' }); req.user = { id: 'test-admin', role }; next(); });
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator required' });
  const csrf = (req, res, next) => req.get('X-CSRF-Token') === 'test-csrf' ? next() : res.status(403).json({ error: 'Invalid CSRF' });
  installMigrationRoutes(app, { list, get, create, put, validate, audit, csrf, admin, transaction, db, collections: ['constituents', 'designations', 'gifts'], schoolYear: () => '2026–2027' });
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
  return { db, request, list, get, put, counts, close };
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
