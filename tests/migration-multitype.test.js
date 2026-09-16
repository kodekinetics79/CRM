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

test('mapped overlapping person categories keep one identity and are canonical, restartable and replayable',async t=>{
 const f=await fixture(t), source=input([file('constituents',[prior({additionalTypes:'["Staff","Alumni","Employee"]'})])],'multitype-valid');
 const result=await f.commit(source);assert.equal(result.status,201);
 const people=(await workspace(f)).constituents;assert.equal(people.length,1);assert.equal(people[0].type,'Individual');assert.deepEqual(people[0].additionalTypes,['Alumni','Employee','Staff']);
 const users=f.app.locals.db.prepare('SELECT count(*) n FROM users').get().n;assert.equal(users,3);
 await f.restart();assert.deepEqual((await workspace(f)).constituents,people);
 const replay=await f.commit(source);assert.equal(replay.status,200);assert.equal(replay.json.replayed,true);
 const changed=await f.request('/migration/preview',input([file('constituents',[prior({additionalTypes:'["Alumni"]'})])],'multitype-changed'));assert.equal(changed.json.valid,false);
});
for(const value of ['null','{}','"Staff"','["Staff","Staff"]','["Individual"]','["Business"]','["Admin"]','["Staff"] trailing'])test('migration rejects invalid category cell '+value,async t=>{
 const f=await fixture(t),before=f.counts(),preview=await f.request('/migration/preview',input([file('constituents',[prior({additionalTypes:value})])],'multitype-invalid'));
 assert.equal(preview.status,200);assert.equal(preview.json.valid,false);assert.match(preview.json.rows[0].error,/Additional types/);assert.deepEqual(f.counts(),before);
});
test('omitted category mapping preserves prior source digest and explicit new category mapping does not silently remap',async t=>{
 const f=await fixture(t),source=input([file('constituents',[prior()])],'multitype-legacy'),commit=await f.commit(source);assert.equal(commit.status,201);
 const mappings=f.app.locals.db.prepare('SELECT * FROM migration_mapping').all();await f.restart();
 const replay=await f.commit(source);assert.equal(replay.status,200);assert.equal(replay.json.replayed,true);assert.deepEqual(f.app.locals.db.prepare('SELECT * FROM migration_mapping').all(),mappings);
 const explicit=await f.request('/migration/preview',input([file('constituents',[prior({additionalTypes:'[]'})])],'multitype-explicit'));assert.equal(explicit.json.valid,false);
});
