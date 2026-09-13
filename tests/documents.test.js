import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = Buffer.from('Evidence, owner, value\r\nSchool programme, Wimblo, 123.45\r\nUTF-8: café\n');
const file = (bytes = text, filename = 'evidence.csv') => ({ filename, contentBase64: bytes.toString('base64') });
const metadata = changes => ({ title: 'Community grant report', category: 'Report', visibility: 'Workspace', status: 'Draft', evidenceDate: null, ...changes });
const inTenYears = at => { const d = new Date(at); d.setUTCFullYear(d.getUTCFullYear() + 10); return d.toISOString(); };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-documents-')), dbPath = join(dir, 'business.sqlite');
  let app, server, base;
  async function open() { app = createApp({ dbPath, seed: true }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; }
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers.Cookie = session.cookie;
    if (session && csrf) headers['X-CSRF-Token'] = typeof csrf === 'string' ? csrf : session.csrfToken;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json(), headers: r.headers };
  }
  async function login(email = 'alex@foundation.example') {
    const r = await request('/api/auth/login', { method: 'POST', body: { email, password: 'FoundationDemo!2026' } }); assert.equal(r.status, 200);
    return { ...r.json, cookie: r.headers.get('set-cookie').split(';')[0] };
  }
  const admin = await login(), staff = await login('staff@foundation.example'), viewer = await login('board@foundation.example');
  const r = await request('/api/records/tasks', { method: 'POST', session: admin, body: { title: 'Document-linked task', dueDate: '2026-09-13', owner: '', status: 'Open' } });
  assert.equal(r.status, 201); const record = r.json.record;
  const uploadBody = changes => ({ ...metadata(), ...file(), collection: 'tasks', recordId: record.id, ...changes });
  async function upload(changes = {}, session = admin) { return request('/api/documents', { method: 'POST', session, body: uploadBody(changes) }); }
  async function create(changes = {}, session = admin) { const r = await upload(changes, session); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.document; }
  async function read(id, session = admin) { return request(`/api/documents/${id}`, { session }); }
  async function content(id, revision = 1, session = admin) { return request(`/api/documents/${id}/revisions/${revision}/content`, { session }); }
  function count() { return app.locals.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n; }
  function audits(id) { return app.locals.db.prepare('SELECT * FROM audit ORDER BY id').all().filter(a => JSON.parse(a.details).documentId === id).map(a => ({ ...a, details: JSON.parse(a.details) })); }
  return { request, admin, staff, viewer, record, uploadBody, upload, create, read, content, count, audits, get db() { return app.locals.db; }, restart: async () => { await close(); await open(); } };
}

test('uploaded UTF-8 bytes and SHA-256 round-trip exactly with audit and bounded metadata', async t => {
  const f = await fixture(t), doc = await f.create({}, f.staff);
  assert.equal(doc.collection, 'tasks'); assert.equal(doc.recordId, f.record.id); assert.equal(doc.version, 1); assert.equal(doc.archived, false);
  assert.equal(doc.retentionUntil, inTenYears(doc.createdAt));
  assert.equal(doc.revisions[0].sha256, hash(text)); assert.equal(doc.revisions[0].size, text.length); assert.equal(doc.revisions[0].actor, f.staff.user.id);
  assert.equal(doc.revisions[0].mime, 'text/csv;charset=utf-8'); assert.equal(doc.revisions[0].metadata.title, doc.title);
  assert.equal(JSON.stringify(doc).includes(text.toString('base64')), false, 'Metadata listing must not include file content');
  const downloaded = await f.content(doc.id, 1, f.viewer); assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(downloaded.json.contentBase64, 'base64'), text); assert.equal(downloaded.json.sha256, hash(text));
  assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  const list = await f.request(`/api/documents?collection=tasks&recordId=${f.record.id}`, { session: f.viewer }); assert.equal(list.status, 200); assert.equal(list.json.documents[0].id, doc.id); assert.equal(list.json.limits.maxBytes, 1024 * 1024);
  const history = f.audits(doc.id); assert.equal(history[0].action, 'upload_document'); assert.equal(history[0].actor, f.staff.user.id); assert.equal(history[0].details.sha256, hash(text)); assert.equal(history.at(-1).action, 'download_document'); assert.equal(history.at(-1).actor, f.viewer.user.id);
});

test('revision history preserves old bytes and metadata; stale revisions are atomic', async t => {
  const f = await fixture(t), doc = await f.create(); const nextBytes = Buffer.from('Approved report version two\n');
  const body = { ...metadata({ title: 'Approved community grant report', status: 'Final' }), ...file(nextBytes, 'approved.txt'), version: 1 };
  const revised = await f.request(`/api/documents/${doc.id}/revisions`, { method: 'POST', session: f.staff, body }); assert.equal(revised.status, 200, JSON.stringify(revised.json));
  const next = revised.json.document; assert.equal(next.version, 2); assert.deepEqual(next.revisions.map(r => r.revision), [2, 1]); assert.deepEqual(next.revisions[1], doc.revisions[0]);
  assert.deepEqual(Buffer.from((await f.content(doc.id)).json.contentBase64, 'base64'), text); assert.deepEqual(Buffer.from((await f.content(doc.id, 2)).json.contentBase64, 'base64'), nextBytes);
  const auditCount = f.audits(doc.id).length;
  const stale = await f.request(`/api/documents/${doc.id}/revisions`, { method: 'POST', session: f.admin, body }); assert.equal(stale.status, 409);
  assert.deepEqual((await f.read(doc.id)).json.document, next); assert.equal(f.audits(doc.id).length, auditCount);
  assert.equal((await f.content(doc.id, 999)).status, 404);
  assert.throws(() => f.db.prepare('UPDATE document_revisions SET filename=? WHERE document_id=? AND revision=1').run('rewritten.txt', doc.id), /immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM document_revisions WHERE document_id=? AND revision=1').run(doc.id), /retained/);
});

test('latest revision extends ten-year retention without shortening a longer hold', async t => {
  const f = await fixture(t), doc = await f.create();
  f.db.prepare('UPDATE documents SET retention_until=? WHERE id=?').run('2020-01-01T00:00:00.000Z', doc.id);
  const body = { ...metadata(), ...file(Buffer.from('New retained revision\n'), 'revision.txt'), version: 1 };
  const revised = await f.request(`/api/documents/${doc.id}/revisions`, { method: 'POST', session: f.admin, body }); assert.equal(revised.status, 200);
  assert.ok(revised.json.document.retentionUntil >= inTenYears(revised.json.document.revisions[0].at), 'Each new revision needs at least ten years of retention');
  const future = '2099-01-01T00:00:00.000Z'; f.db.prepare('UPDATE documents SET retention_until=? WHERE id=?').run(future, doc.id);
  const again = await f.request(`/api/documents/${doc.id}/revisions`, { method: 'POST', session: f.admin, body: { ...body, version: 2 } }); assert.equal(again.status, 200); assert.equal(again.json.document.retentionUntil, future);
});

test('administrator-only visibility denies staff and viewer lists, metadata, bytes and mutation', async t => {
  const f = await fixture(t), doc = await f.create({ visibility: 'Administrators', title: 'Private evidence' });
  for (const session of [f.staff, f.viewer]) {
    assert.equal((await f.request('/api/documents', { session })).json.documents.some(d => d.id === doc.id), false);
    assert.equal((await f.request(`/api/documents?collection=tasks&recordId=${f.record.id}`, { session })).json.documents.length, 0);
    assert.equal((await f.read(doc.id, session)).status, 404); assert.equal((await f.content(doc.id, 1, session)).status, 404);
    assert.equal((await f.upload({ visibility: 'Administrators' }, session)).status, 403);
    const revision = await f.request(`/api/documents/${doc.id}/revisions`, { method: 'POST', session, body: { ...metadata(), ...file(), version: 1 } }); assert.equal(revision.status, session === f.staff ? 404 : 403);
    assert.equal((await f.request(`/api/documents/${doc.id}/archive`, { method: 'POST', session, body: { version: 1, reason: 'Unauthorized' } })).status, session === f.staff ? 404 : 403);
  }
  assert.equal((await f.read(doc.id)).status, 200); assert.equal((await f.content(doc.id)).status, 200); assert.equal(f.count(), 1);
  const publicDoc = await f.create();
  assert.equal((await f.request(`/api/documents/${publicDoc.id}/revisions`, { method: 'POST', session: f.staff, body: { ...metadata({ visibility: 'Administrators' }), ...file(), version: 1 } })).status, 403);
  assert.equal((await f.read(publicDoc.id)).json.document.version, 1);
});

test('document routes require authentication, CSRF and write authority', async t => {
  const f = await fixture(t), doc = await f.create(), revise = { ...metadata(), ...file(), version: 1 }, archive = { version: 1, reason: 'Retain superseded evidence' };
  for (const path of ['/api/documents', `/api/documents/${doc.id}`, `/api/documents/${doc.id}/revisions/1/content`]) assert.equal((await f.request(path)).status, 401);
  const writes = [['/api/documents', f.uploadBody()], [`/api/documents/${doc.id}/revisions`, revise], [`/api/documents/${doc.id}/archive`, archive]];
  for (const [path, body] of writes) {
    assert.equal((await f.request(path, { method: 'POST', body })).status, 401);
    assert.equal((await f.request(path, { method: 'POST', session: f.admin, csrf: false, body })).status, 403);
    assert.equal((await f.request(path, { method: 'POST', session: f.admin, csrf: 'wrong', body })).status, 403);
    assert.equal((await f.request(path, { method: 'POST', session: f.viewer, body })).status, 403);
  }
  assert.equal((await f.request(`/api/documents/${doc.id}`, { method: 'DELETE', session: f.admin, csrf: false })).status, 403);
  assert.equal((await f.read(doc.id)).json.document.version, 1); assert.equal(f.count(), 1);
});

test('archive keeps revisions downloadable and blocks later writes and record deletion', async t => {
  const f = await fixture(t), doc = await f.create();
  const path = `/api/documents/${doc.id}/archive`;
  for (const body of [{ version: 99, reason: 'Stale' }, { version: 1, reason: '' }]) assert.ok([400, 409].includes((await f.request(path, { method: 'POST', session: f.admin, body })).status));
  const archive = await f.request(path, { method: 'POST', session: f.staff, body: { version: 1, reason: 'Superseded but retained' } }); assert.equal(archive.status, 200); assert.equal(archive.json.document.archived, true); assert.equal(archive.json.document.version, 2);
  assert.equal((await f.request('/api/documents', { session: f.admin })).json.documents.length, 0); assert.equal((await f.request('/api/documents?archived=true', { session: f.admin })).json.documents[0].id, doc.id);
  assert.deepEqual(Buffer.from((await f.content(doc.id, 1, f.viewer)).json.contentBase64, 'base64'), text);
  assert.equal((await f.request(`/api/documents/${doc.id}/revisions`, { method: 'POST', session: f.admin, body: { ...metadata(), ...file(), version: 2 } })).status, 409);
  assert.equal((await f.request(path, { method: 'POST', session: f.admin, body: { version: 2, reason: 'Again' } })).status, 409);
  assert.equal((await f.request(`/api/documents/${doc.id}`, { method: 'DELETE', session: f.admin })).status, 403);
  assert.equal((await f.request(`/api/records/tasks/${f.record.id}`, { method: 'DELETE', session: f.admin, body: { version: f.record.version } })).status, 409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM document_revisions WHERE document_id=?').get(doc.id).n, 1);
  assert.ok(f.audits(doc.id).some(a => a.action === 'archive_document' && a.details.reason === 'Superseded but retained'));
});

test('retained active documents block reference deletion and missing or invalid linkage is rejected', async t => {
  const f = await fixture(t); await f.create();
  assert.equal((await f.request(`/api/records/tasks/${f.record.id}`, { method: 'DELETE', session: f.staff, body: { version: 1 } })).status, 409);
  assert.equal((await f.upload({ recordId: 'missing-record' })).status, 404);
  for (const collection of ['evaluations', 'reportViews', 'volunteerTime', 'shiftReservations', 'not-a-collection']) assert.equal((await f.upload({ collection })).status, 400);
  assert.equal((await f.request(`/api/documents?recordId=${f.record.id}`, { session: f.admin })).status, 400);
  assert.equal((await f.request('/api/documents?collection=tasks&recordId=missing-record', { session: f.admin })).status, 404);
  assert.equal(f.count(), 1);
});

test('file validation accepts safe formats and rejects HTML, archives, disguised content and malformed bytes', async t => {
  const f = await fixture(t);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  for (const [bytes, filename, mime] of [[pdf, 'report.PDF', 'application/pdf'], [png, 'logo.png', 'image/png'], [Buffer.from('Plain text\n'), 'notes.txt', 'text/plain;charset=utf-8']]) {
    const doc = await f.create(file(bytes, filename)); assert.equal(doc.revisions[0].mime, mime); assert.deepEqual(Buffer.from((await f.content(doc.id)).json.contentBase64, 'base64'), bytes);
  }
  const bad = [file(Buffer.from('<script>alert(1)</script>'), 'unsafe.html'), file(Buffer.from('PK\x03\x04archive'), 'archive.zip'), file(Buffer.from('MZ executable'), 'file.exe'), file(Buffer.from('<html>disguised</html>'), 'fake.pdf'), file(text, 'fake.png'), file(Buffer.from([255, 254]), 'invalid.txt'), file(Buffer.from('binary\0text'), 'binary.csv'), file(text, '../escape.csv'), file(text, 'folder\\escape.csv'), { filename: 'empty.txt', contentBase64: '' }, { filename: 'bad.txt', contentBase64: 'not!base64' }, { filename: 'noncanonical.txt', contentBase64: 'Zh==' }];
  const before = f.count(); for (const changes of bad) assert.equal((await f.upload(changes)).status, 400, changes.filename); assert.equal(f.count(), before);
});

test('size and evidence-date validation reject invalid uploads without inserting evidence', async t => {
  const f = await fixture(t); const max = Buffer.alloc(1024 * 1024, 65), doc = await f.create(file(max, 'maximum.txt')); assert.equal(doc.revisions[0].size, max.length);
  const count = f.count(); assert.equal((await f.upload(file(Buffer.alloc(max.length + 1, 65), 'oversize.txt'))).status, 400);
  for (const changes of [{ status: 'Submitted', evidenceDate: null }, { evidenceDate: '2026-02-30' }, { evidenceDate: '9999-12-31' }, { title: ' ' }, { visibility: 'Public' }, { extra: true }]) assert.equal((await f.upload(changes)).status, 400);
  assert.equal(f.count(), count);
  const submitted = await f.create({ status: 'Submitted', evidenceDate: '2020-01-01' }); assert.equal(submitted.evidenceDate, '2020-01-01'); assert.equal(submitted.revisions[0].metadata.status, 'Submitted');
});

test('document content, revision history, archive and access scope survive restart', async t => {
  const f = await fixture(t), publicDoc = await f.create(), privateDoc = await f.create({ visibility: 'Administrators' });
  const revision = await f.request(`/api/documents/${publicDoc.id}/revisions`, { method: 'POST', session: f.admin, body: { ...metadata({ status: 'Final' }), ...file(Buffer.from('Final persistent bytes\n'), 'final.txt'), version: 1 } }); assert.equal(revision.status, 200);
  const archived = await f.request(`/api/documents/${privateDoc.id}/archive`, { method: 'POST', session: f.admin, body: { version: 1, reason: 'Retain private draft' } }); assert.equal(archived.status, 200);
  const history = f.audits(publicDoc.id); await f.restart();
  assert.deepEqual((await f.read(publicDoc.id)).json.document, revision.json.document); assert.deepEqual((await f.read(privateDoc.id)).json.document, archived.json.document); assert.deepEqual(f.audits(publicDoc.id), history);
  assert.deepEqual(Buffer.from((await f.content(publicDoc.id, 1, f.viewer)).json.contentBase64, 'base64'), text); assert.equal((await f.content(privateDoc.id, 1, f.staff)).status, 404);
  assert.equal((await f.request(`/api/records/tasks/${f.record.id}`, { method: 'DELETE', session: f.admin, body: { version: 1 } })).status, 409);
});

test('download rejects storage corruption rather than returning bytes with a false digest', async t => {
  const f = await fixture(t), doc = await f.create();
  // Simulate an out-of-band storage fault after proving normal revision writes are immutable.
  f.db.exec('DROP TRIGGER document_revision_no_update');
  f.db.prepare('UPDATE document_revisions SET bytes=? WHERE document_id=? AND revision=1').run(Buffer.from('Corrupted stored file\n'), doc.id);
  const before = f.audits(doc.id).length, download = await f.content(doc.id);
  assert.equal(download.status, 503); assert.match(download.json.error, /integrity/i); assert.equal(download.json.contentBase64, undefined); assert.equal(f.audits(doc.id).length, before);
});

test('private revision metadata and bytes remain private after a public latest revision and restart',async t=>{
 const f=await fixture(t),privateBytes=Buffer.from('Restricted historic evidence bytes\n'),publicBytes=Buffer.from('Shared revised evidence bytes\n'),doc=await f.create({...metadata({visibility:'Administrators',title:'Restricted historic title'}),...file(privateBytes,'private.txt')});
 const revised=await f.request(`/api/documents/${doc.id}/revisions`,{method:'POST',session:f.admin,body:{...metadata({title:'Shared current title'}),...file(publicBytes,'public.txt'),version:1}});assert.equal(revised.status,200);assert.equal(revised.json.document.revisions.length,2);
 async function verify(staff,viewer,admin){for(const session of [staff,viewer]){
  const detail=await f.read(doc.id,session);assert.equal(detail.status,200);assert.deepEqual(detail.json.document.revisions.map(r=>r.revision),[2]);assert.doesNotMatch(JSON.stringify(detail.json),/Restricted historic title|private\.txt/);
  const listing=await f.request('/api/documents',{session});assert.deepEqual(listing.json.documents.find(d=>d.id===doc.id).revisions.map(r=>r.revision),[2]);assert.doesNotMatch(JSON.stringify(listing.json),/Restricted historic title|private\.txt/);
  const before=f.audits(doc.id).length,denied=await f.content(doc.id,1,session);assert.equal(denied.status,404);assert.equal(denied.json.contentBase64,undefined);assert.equal(f.audits(doc.id).length,before);assert.deepEqual(Buffer.from((await f.content(doc.id,2,session)).json.contentBase64,'base64'),publicBytes);
 }const original=await f.content(doc.id,1,admin);assert.equal(original.status,200);assert.deepEqual(Buffer.from(original.json.contentBase64,'base64'),privateBytes);assert.equal((await f.read(doc.id,admin)).json.document.revisions.length,2);}
 await verify(f.staff,f.viewer,f.admin);await f.restart();
 const login=async email=>{const r=await f.request('/api/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200);return {...r.json,cookie:r.headers.get('set-cookie').split(';')[0]};};await verify(await login('staff@foundation.example'),await login('board@foundation.example'),await login('alex@foundation.example'));
});
