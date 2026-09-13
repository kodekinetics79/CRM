import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { backupWorkspace, restoreWorkspace } from '../server/backup.js';

const password = 'SyntheticDocumentMigrationAcceptance!2026';
const bytes = Buffer.from('Original agreement\r\nUTF-8: café\nExact clause: <unchanged>\t123.45\r\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const nativeTables = ['records', 'documents', 'document_revisions', 'document_revision_storage'];

function privateStorage() {
  const objects = new Map(), deleted = []; let hooks = {}, corrupt = false, cleanupFails = false;
  const storage = {
    scope: { provider: 's3', bucket: 'synthetic-migration-private', namespace: 'synthetic-contracts' },
    async verifyReadiness() { return { verified: true }; },
    stage(p) { return { ...p, ...this.scope, key: 'synthetic/' + p.tenantId + '/' + p.documentId + '/' + p.revision + '/' + p.attemptId, version: null }; },
    async put(ref, value) { await hooks.put?.(ref); const stored = { ...ref, version: randomUUID(), encryption: 'AES256' }; objects.set(ref.key, { ref: stored, bytes: Buffer.from(value) }); return stored; },
    async get(ref) { await hooks.get?.(ref); const found = objects.get(ref.key); if (!found || found.ref.version !== ref.version || found.ref.tenantId !== ref.tenantId) throw Object.assign(new Error('Synthetic exact-version lookup rejected'), { status: 503 }); return corrupt ? Buffer.alloc(found.bytes.length, 88) : found.bytes; },
    async deleteStaged(ref) { if (cleanupFails) throw Error('Synthetic cleanup unavailable'); deleted.push(ref); objects.delete(ref.key); }
  };
  return { storage, objects, deleted, set(value) { if (value.hooks !== undefined) hooks = value.hooks; if (value.corrupt !== undefined) corrupt = value.corrupt; if (value.cleanupFails !== undefined) cleanupFails = value.cleanupFails; } };
}

async function fixture(t, { object = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-document-migration-integrity-')), dbPath = join(dir, 'workspace.sqlite'), tenantId = randomUUID(), store = privateStorage();
  const initialAdmin = { name: 'Synthetic contract importer', email: 'contracts.admin@example.test', password };
  let app, server, base, active = true, sessions = {};
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, { method = 'GET', body, session = sessions.admin, csrf = true } = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function login(email = initialAdmin.email) { const r = await request('/auth/login', { method: 'POST', session: null, body: { email, password } }); assert.equal(r.status, 200, r.text); return { ...r.json, cookie: r.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }; }
  async function open(path = dbPath) { app = createApp({ dbPath: path, seed: false, tenantId, initialAdmin, isTenantActive: () => active, documentStorage: object ? store.storage : null, documentTenantId: tenantId }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; sessions.admin = await login(); }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  for (const role of ['staff', 'viewer', 'event-helper']) { const email = role + '.contracts@example.test'; assert.equal((await request('/users', { method: 'POST', body: { name: 'Synthetic ' + role, role, email, password } })).status, 201); sessions[role] = await login(email); }
  const record = await request('/records/tasks', { method: 'POST', body: { title: 'Contract-linked synthetic task', dueDate: '2026-09-13', status: 'Open' } }); assert.equal(record.status, 201, record.text);
  const payload = (changes = {}) => ({ source: { namespace: 'SyntheticContracts', documentId: 'contract-1', revisionId: 'revision-1', visibility: 'Administrators', originalDate: '2016-09-13' }, document: { title: 'PRIVATE_ORIGINAL_AGREEMENT', category: 'Agreement', status: 'Submitted', visibility: 'Administrators', evidenceDate: '2016-09-13', filename: 'original.txt', contentBase64: bytes.toString('base64'), collection: 'tasks', recordId: record.json.record.id, recordVersion: 1 }, sha256: sha(bytes), size: bytes.length, ...changes });
  const snapshot = tables => Object.fromEntries((tables || nativeTables).map(table => [table, app.locals.db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all()]));
  return { dir, dbPath, tenantId, store, record: record.json.record, payload, request, login, close, open, snapshot, get db() { return app.locals.db; }, get app() { return app; }, get sessions() { return sessions; }, set active(value) { active = value; } };
}

const preview = (f, body = f.payload(), session = f.sessions.admin) => f.request('/document-migration/preview', { method: 'POST', body, session });
const commit = (f, body, proof, session = f.sessions.admin) => f.request('/document-migration/commit', { method: 'POST', body: { ...body, proof }, session });
async function converted(f, body = f.payload()) { const p = await preview(f, body); assert.equal(p.status, 200, p.text); assert.equal(p.json.valid, true); const saved = await commit(f, body, p.json.proof); assert.equal(saved.status, 201, saved.text); const doc = f.db.prepare('SELECT * FROM documents ORDER BY rowid DESC LIMIT 1').get(); return { preview: p.json, result: saved.json, doc }; }
function lineageTables(f) { return f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'document_migration%' ORDER BY name").all().map(row => row.name); }

// This fixture proves only the supported normalized file slice, never actual source custody.
test('contract conversion preserves exact source bytes and native linked evidence without inventing original actors', async t => {
  const f = await fixture(t), source = f.payload(), saved = await converted(f, source), doc = saved.doc;
  assert.equal(doc.collection, 'tasks'); assert.equal(doc.record_id, f.record.id); assert.equal(doc.version, 1); assert.equal(doc.visibility, 'Administrators'); assert.equal(doc.category, 'Agreement'); assert.equal(doc.evidence_date, '2016-09-13');
  const revision = f.db.prepare('SELECT * FROM document_revisions WHERE document_id=?').get(doc.id);
  assert.deepEqual(Buffer.from(revision.bytes), bytes); assert.equal(revision.sha256, sha(bytes)); assert.equal(revision.actor, f.sessions.admin.user.id); assert.ok(revision.at > '2016-09-13T23:59:59Z');
  const content = await f.request('/documents/' + doc.id + '/revisions/1/content'); assert.equal(content.status, 200); assert.deepEqual(Buffer.from(content.json.contentBase64, 'base64'), bytes);
  assert.deepEqual(saved.preview.reconciliation, { sourceRevisions: 1, sourceBytes: bytes.length, nativeRevisions: 1, nativeBytes: bytes.length });
  const history = await f.request('/document-migration/history?limit=20'); assert.equal(history.status, 200, history.text); assert.equal(history.json.reconciliations.length, 1); assert.match(JSON.stringify(history.json), /2016-09-13/); assert.match(JSON.stringify(history.json), /contract-1/); assert.doesNotMatch(JSON.stringify(history.json), /contentBase64|synthetic-migration-private|synthetic\/|Original agreement/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection IN ('gifts','communications')").get().n, 0);
});

test('restricted conversion APIs and retained private first revisions never leak through a public latest revision', async t => {
  const f = await fixture(t), body = f.payload(), saved = await converted(f, body), doc = saved.doc;
  for (const role of ['staff', 'viewer', 'event-helper']) {
    const session = f.sessions[role];
    for (const path of ['/document-migration/history', '/document-migration/unknown']) for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) { const r = await f.request(path, { method, session, ...(method === 'HEAD' || method === 'GET' ? {} : { body }) }); assert.equal(r.status, 403, role + ' ' + method + ' ' + path + ': ' + r.text); }
    assert.equal((await preview(f, body, session)).status, 403); assert.equal((await commit(f, body, saved.preview.proof, session)).status, 403);
  }
  assert.equal((await preview(f, body, null)).status, 401);
  assert.equal((await f.request('/document-migration/preview', { method: 'POST', body, csrf: false })).status, 403);
  const publicBytes = Buffer.from('Shared later agreement revision\r\n'), next = f.payload({ source: { ...body.source, revisionId: 'revision-2', originalDate: '2017-09-13', visibility: 'Workspace' }, document: { ...body.document, title: 'Shared latest agreement', visibility: 'Workspace', evidenceDate: '2017-09-13', filename: 'shared.txt', contentBase64: publicBytes.toString('base64'), targetDocumentId: doc.id, targetVersion: 1 }, sha256: sha(publicBytes), size: publicBytes.length });
  assert.equal((await preview(f, next)).status, 409, 'Private conversion chain cannot be relaxed through migration');
  const appended = await f.request('/documents/' + doc.id + '/revisions', { method: 'POST', body: { title: 'Shared latest agreement', category: 'Agreement', status: 'Submitted', visibility: 'Workspace', evidenceDate: '2017-09-13', filename: 'shared.txt', contentBase64: publicBytes.toString('base64'), version: 1 } }); assert.equal(appended.status, 200, appended.text); assert.equal(appended.json.document.version, 2);
  for (const role of ['staff', 'viewer']) {
    const session = f.sessions[role], detail = await f.request('/documents/' + doc.id, { session }); assert.equal(detail.status, 200); assert.deepEqual(detail.json.document.revisions.map(r => r.revision), [2]); assert.doesNotMatch(detail.text, /PRIVATE_ORIGINAL_AGREEMENT|original\.txt/);
    assert.equal((await f.request('/documents/' + doc.id + '/revisions/1/content', { session })).status, 404);
    const content = await f.request('/documents/' + doc.id + '/revisions/2/content', { session }); assert.deepEqual(Buffer.from(content.json.contentBase64, 'base64'), publicBytes);
    const report = await f.request('/custom-reports/run', { method: 'POST', session, body: { name: 'Safe contract history', entity: 'documentRevisions', columns: ['documentId', 'revision', 'filename', 'size'] } }); assert.equal(report.status, 200, report.text); assert.deepEqual(report.json.rows, [[doc.id, 2, 'shared.txt', publicBytes.length]]);
  }
  assert.deepEqual(Buffer.from((await f.request('/documents/' + doc.id + '/revisions/1/content')).json.contentBase64, 'base64'), bytes);
});

test('invalid file, date, classification, link versions and altered review facts cannot create native evidence', async t => {
  const f = await fixture(t), original = f.payload(), initial = f.snapshot();
  const changes = [
    { sha256: '0'.repeat(64) }, { size: bytes.length + 1 },
    { source: { ...original.source, visibility: 'Administrators' }, document: { ...original.document, visibility: 'Workspace' } },
    { source: { ...original.source, originalDate: '2026-02-30' } },
    { source: { ...original.source, originalDate: '2999-01-01' } },
    { document: { ...original.document, evidenceDate: null } },
    { document: { ...original.document, category: 'Proposal' } },
    { document: { ...original.document, filename: 'original.docx' } },
    { document: { ...original.document, recordVersion: 2 } },
    { document: { ...original.document, targetDocumentId: randomUUID() } },
    { document: { ...original.document, contentBase64: Buffer.from('Corrupted replacement').toString('base64') } },
  ];
  for (const change of changes) { const r = await preview(f, { ...original, ...change }); assert.ok([400, 404, 409].includes(r.status), r.text); assert.deepEqual(f.snapshot(), initial); }
  const p = await preview(f, original); assert.equal(p.status, 200, p.text);
  for (const change of [{ document: { ...original.document, title: 'Changed after review' } }, { source: { ...original.source, revisionId: 'changed-source-revision' } }, { source: { ...original.source, originalDate: '2016-09-12' } }]) { const r = await commit(f, { ...original, ...change }, p.json.proof); assert.equal(r.status, 409, r.text); assert.deepEqual(f.snapshot(), initial); }
  const changed = await f.request('/records/tasks/' + f.record.id, { method: 'PATCH', body: { version: 1, title: 'Linked source changed after review' } }); assert.equal(changed.status, 200);
  assert.equal((await commit(f, original, p.json.proof)).status, 409);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get().n, 0);
});

test('exact source replay, explicit append and restart retain one source mapping per original revision', async t => {
  const f = await fixture(t), source = f.payload(), first = await converted(f, source), baseline = f.snapshot([...nativeTables, ...lineageTables(f)]);
  const replayPreview = await preview(f, source); assert.equal(replayPreview.json.operation, 'Replay');
  const replay = await commit(f, source, replayPreview.json.proof); assert.equal(replay.status, 200, replay.text); assert.equal(replay.json.replayed, true); assert.deepEqual(f.snapshot([...nativeTables, ...lineageTables(f)]), baseline);
  const altered = { ...source, document: { ...source.document, title: 'Changed original title' } }; assert.equal((await preview(f, altered)).status, 409);
  const newerBytes = Buffer.from('Restricted original revision two\r\n'), next = f.payload({ source: { ...source.source, revisionId: 'revision-2', originalDate: null }, document: { ...source.document, title: 'Restricted current agreement', status: 'Final', evidenceDate: null, filename: 'second.txt', contentBase64: newerBytes.toString('base64'), targetDocumentId: first.doc.id, targetVersion: 1 }, sha256: sha(newerBytes), size: newerBytes.length });
  assert.equal((await preview(f, { ...next, document: { ...next.document, targetDocumentId: undefined, targetVersion: undefined } })).status, 409);
  const second = await converted(f, next); assert.equal(second.doc.id, first.doc.id); assert.equal(second.doc.version, 2); assert.equal(f.db.prepare('SELECT count(*) n FROM document_migration_mappings').get().n, 2);
  const beforeRestart = f.snapshot([...nativeTables, ...lineageTables(f)]); await f.close(); await f.open();
  for (const original of [source, next]) { const p = await preview(f, original); assert.equal(p.status, 200, p.text); assert.equal(p.json.operation, 'Replay'); const r = await commit(f, original, p.json.proof); assert.equal(r.status, 200, r.text); assert.equal(r.json.replayed, true); }
  assert.deepEqual(f.snapshot([...nativeTables, ...lineageTables(f)]), beforeRestart);
  assert.deepEqual(Buffer.from((await f.request('/documents/' + first.doc.id + '/revisions/1/content')).json.contentBase64, 'base64'), bytes);
  assert.deepEqual(Buffer.from((await f.request('/documents/' + first.doc.id + '/revisions/2/content')).json.contentBase64, 'base64'), newerBytes);
  const history = await f.request('/document-migration/history?limit=1'); assert.equal(history.json.reconciliations.length, 1); assert.ok(history.json.nextCursor); const older = await f.request('/document-migration/history?limit=1&after=' + history.json.nextCursor); assert.equal(older.json.reconciliations.length, 1); assert.notEqual(older.json.reconciliations[0].id, history.json.reconciliations[0].id); assert.equal(older.json.nextCursor, null);
  for (const suffix of ['?limit=0', '?limit=101', '?after=invalid', '?after=' + randomUUID(), '?unexpected=true']) assert.equal((await f.request('/document-migration/history' + suffix)).status, 400);
  assert.throws(() => f.db.exec("UPDATE document_migration_mappings SET source_hash='changed'"), /immutable/); assert.throws(() => f.db.exec('DELETE FROM document_migration_reconciliations'), /retained/);
  assert.throws(() => f.db.exec("UPDATE document_revisions SET filename='changed.txt'"), /immutable/); assert.equal((await f.request('/records/tasks/' + f.record.id, { method: 'DELETE', body: { version: 1 } })).status, 409);
});

test('async staged conversion rechecks linked source, administrator session and tenant before committing', async t => {
  for (const change of ['source', 'session', 'account', 'tenant']) {
    const f = await fixture(t, { object: true }), source = f.payload(), p = await preview(f, source); assert.equal(p.status, 200, p.text);
    f.store.set({ hooks: { put: async () => {
      if (change === 'source') f.db.prepare("UPDATE records SET data=json_set(data,'$.title','Concurrent source change','$.version',2) WHERE collection='tasks' AND id=?").run(f.record.id);
      if (change === 'session') f.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.sessions.admin.user.id);
      if (change === 'account') f.db.prepare("UPDATE users SET role='staff',version=version+1 WHERE id=?").run(f.sessions.admin.user.id);
      if (change === 'tenant') f.active = false;
    } } });
    const result = await commit(f, source, p.json.proof); assert.ok([401, 403, 409].includes(result.status), change + ': ' + result.text);
    for (const table of ['documents', 'document_revisions', 'document_revision_storage', ...lineageTables(f)]) assert.equal(f.db.prepare('SELECT count(*) n FROM ' + table).get().n, 0, table);
    assert.equal(f.store.objects.size, 0); assert.equal(f.store.deleted.length, 1); assert.equal(f.db.prepare('SELECT state FROM document_upload_attempts').get().state, 'Failed'); assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='import_document_revision'").get().n, 0);
  }
});

test('corrupt private readback and native/audit persistence faults retain truthful cleanup without source completion', async t => {
  const f = await fixture(t, { object: true }), source = f.payload();
  f.store.set({ corrupt: true }); let p = await preview(f, source); assert.equal(p.status, 200); assert.equal((await commit(f, source, p.json.proof)).status, 503); assert.equal(f.store.objects.size, 0);
  f.store.set({ corrupt: false });
  for (const fault of [
    "CREATE TRIGGER synthetic_import_fault AFTER INSERT ON documents BEGIN UPDATE documents SET title='Wrong persisted agreement' WHERE id=NEW.id; END",
    "CREATE TRIGGER synthetic_import_fault BEFORE INSERT ON audit WHEN NEW.action='import_document_revision' BEGIN SELECT RAISE(ABORT,'Synthetic reconciliation audit fault'); END",
  ]) {
    f.db.exec(fault); const before = f.snapshot([...nativeTables, ...lineageTables(f)]); p = await preview(f, source); assert.equal(p.status, 200); const result = await commit(f, source, p.json.proof); assert.ok([409, 500].includes(result.status), result.text); assert.deepEqual(f.snapshot([...nativeTables, ...lineageTables(f)]), before); assert.equal(f.store.objects.size, 0); f.db.exec('DROP TRIGGER synthetic_import_fault');
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM document_upload_attempts WHERE state='Committed'").get().n, 0);
  f.store.set({ cleanupFails: true }); f.db.exec("CREATE TRIGGER synthetic_import_fault BEFORE INSERT ON audit WHEN NEW.action='import_document_revision' BEGIN SELECT RAISE(ABORT,'Synthetic cleanup fault'); END"); p = await preview(f, source); assert.equal((await commit(f, source, p.json.proof)).status, 500);
  assert.equal(f.db.prepare("SELECT count(*) n FROM document_upload_attempts WHERE state='Orphaned'").get().n, 1); assert.equal(f.store.objects.size, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM document_migration_mappings').get().n, 0);
});

test('deferred final COMMIT failure rolls back documents and source lineage after verified staging', async t => {
  const f = await fixture(t, { object: true }), source = f.payload();
  f.db.exec(`CREATE TABLE synthetic_commit_parent(id TEXT PRIMARY KEY); CREATE TABLE synthetic_commit_child(id TEXT REFERENCES synthetic_commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_final_commit_fault AFTER INSERT ON document_migration_reconciliations BEGIN INSERT INTO synthetic_commit_child VALUES('absent'); END`);
  const before = f.snapshot([...nativeTables, ...lineageTables(f)]), p = await preview(f, source), result = await commit(f, source, p.json.proof); assert.equal(result.status, 500, result.text); assert.deepEqual(f.snapshot([...nativeTables, ...lineageTables(f)]), before); assert.equal(f.store.objects.size, 0); assert.equal(f.db.prepare('SELECT state FROM document_upload_attempts').get().state, 'Failed'); assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='import_document_revision'").get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM synthetic_commit_child').get().n, 0);
  f.db.exec('DROP TRIGGER synthetic_final_commit_fault'); assert.equal((await converted(f, source)).doc.version, 1);
});

test('later reconciliation persistence cannot silently alter the reviewed linked source', async t => {
  const f = await fixture(t), source = f.payload(), before = f.snapshot([...nativeTables, ...lineageTables(f)]);
  f.db.exec("CREATE TRIGGER synthetic_later_source_fault AFTER INSERT ON audit WHEN NEW.action='import_document_revision' BEGIN UPDATE records SET data=json_set(data,'$.title','Changed after native write','$.version',2) WHERE collection='tasks'; END");
  const p = await preview(f, source); assert.equal(p.status, 200); const result = await commit(f, source, p.json.proof); assert.equal(result.status, 409, result.text); assert.deepEqual(f.snapshot([...nativeTables, ...lineageTables(f)]), before);
});

test('encrypted recovery retains imported source lineage, exact revisions and guarded native history while clearing sessions', async t => {
  const f = await fixture(t), saved = await converted(f), tables = [...nativeTables, ...lineageTables(f)], original = f.snapshot(tables), archivePath = join(f.dir, 'source.backup'), destinationPath = join(f.dir, 'restored.sqlite'), encryptionKey = randomBytes(32).toString('base64');
  const backup = await backupWorkspace({ db: f.db, outputPath: archivePath, tenantId: f.tenantId, encryptionKey }); assert.ok(backup.tables.some(row => row.name === 'document_migration_mappings'));
  const restored = await restoreWorkspace({ archivePath, destinationPath, expectedTenantId: f.tenantId, encryptionKey }); assert.ok(restored.cleared.sessions > 0);
  const copy = new DatabaseSync(destinationPath); try { for (const table of tables) assert.deepEqual(copy.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all(), original[table], table); assert.equal(copy.prepare('SELECT count(*) n FROM sessions').get().n, 0); assert.throws(() => copy.exec('DELETE FROM document_migration_mappings'), /retained/); assert.deepEqual(Buffer.from(copy.prepare('SELECT bytes FROM document_revisions WHERE document_id=?').get(saved.doc.id).bytes), bytes); } finally { copy.close(); }
});

test('replay cannot accept an altered private custody reference even when replacement bytes are identical', async t => {
  const f = await fixture(t, { object: true }), source = f.payload(), saved = await converted(f, source), stored = f.db.prepare('SELECT * FROM document_revision_storage WHERE document_id=?').get(saved.doc.id), original = f.store.objects.get(stored.object_key);
  const replacement = { ...original.ref, key: original.ref.key + '/unapproved-replacement', version: randomUUID() }; f.store.objects.set(replacement.key, { ref: replacement, bytes: Buffer.from(original.bytes) });
  // Simulate an out-of-band custody/storage fault; ordinary mutation is separately denied.
  assert.throws(() => f.db.prepare('UPDATE document_revision_storage SET object_key=? WHERE document_id=?').run(replacement.key, saved.doc.id), /immutable/);
  f.db.exec('DROP TRIGGER document_storage_no_update'); f.db.prepare('UPDATE document_revision_storage SET object_key=?,object_version=? WHERE document_id=?').run(replacement.key, replacement.version, saved.doc.id);
  const p = await preview(f, source); assert.ok([409, 503].includes(p.status), 'Changed custody was signed: ' + p.text); assert.equal(f.db.prepare('SELECT count(*) n FROM document_migration_mappings').get().n, 1);
});

test('preview never signs a retained source mapping whose reconciliation is explicitly from another tenant', async t => {
  const f = await fixture(t), source = f.payload(), saved = await converted(f, source), poisonedSource = { ...source, source: { ...source.source, namespace: 'PoisonedSyntheticContracts' } }, unregisteredPreview = await preview(f, poisonedSource); assert.equal(unregisteredPreview.status, 200);
  const original = f.db.prepare('SELECT * FROM document_migration_reconciliations').get(), poison = { ...original, id: randomUUID(), tenant_id: randomUUID(), source_namespace: poisonedSource.source.namespace, source_hash: unregisteredPreview.json.contentHash };
  const columns = Object.keys(poison); f.db.prepare('INSERT INTO document_migration_reconciliations (' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')').run(...columns.map(key => poison[key]));
  f.db.prepare('INSERT INTO document_migration_mappings VALUES(?,?,?,?,?,?,?,?)').run(poison.source_namespace, poison.source_document_id, poison.source_revision_id, saved.doc.id, 1, poison.id, poison.source_hash, poison.native_hash);
  const result = await preview(f, poisonedSource); assert.equal(result.status, 409, 'Foreign reconciliation was signed: ' + result.text);
});

test('simultaneous staged commits cannot duplicate a source revision and clean only the rejected staged object', async t => {
  const f = await fixture(t, { object: true }), source = f.payload(), p = await preview(f, source); let arrivals = 0, release; const barrier = new Promise(resolve => { release = resolve; });
  f.store.set({ hooks: { put: async () => { if (++arrivals === 2) release(); await barrier; } } });
  const results = await Promise.all([commit(f, source, p.json.proof), commit(f, source, p.json.proof)]); assert.deepEqual(results.map(r => r.status).sort(), [201, 409], results.map(r => r.text).join('\n'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get().n, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM document_revisions').get().n, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM document_migration_mappings').get().n, 1); assert.equal(f.store.objects.size, 1); assert.equal(f.store.deleted.length, 1);
  assert.deepEqual(f.db.prepare('SELECT state FROM document_upload_attempts ORDER BY state').all().map(row => row.state), ['Committed', 'Failed']); assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='import_document_revision'").get().n, 1);
});
