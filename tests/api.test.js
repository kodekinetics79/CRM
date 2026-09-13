import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

const password = 'FoundationDemo!2026';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'foundation-api-'));
  const app = createApp({ dbPath: join(dir, 'test.sqlite'), seed: true });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (app.locals.close) app.locals.close(); else app.locals.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, session, csrf = true, origin } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers.Cookie = session.cookie;
    if (session && csrf) headers['X-CSRF-Token'] = typeof csrf === 'string' ? csrf : session.csrfToken;
    if (origin) headers.Origin = origin;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { assert.fail(`Expected JSON for ${method} ${path}: ${text.slice(0, 160)}`); }
    return { status: response.status, json, headers: response.headers };
  }
  async function login(email = 'alex@foundation.example') {
    const response = await request('/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const rawCookie = response.headers.get('set-cookie');
    assert.ok(rawCookie);
    assert.match(rawCookie, /httponly/i);
    assert.match(rawCookie, /samesite=strict/i);
    assert.ok(response.json.csrfToken);
    return { ...response.json, cookie: rawCookie.split(';')[0] };
  }
  const admin = await login();
  async function create(collection, body) {
    const response = await request(`/api/records/${collection}`, { method: 'POST', body, session: admin });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response.json));
    assert.ok(response.json.record.id);
    assert.ok(Number.isInteger(response.json.record.version));
    return response.json.record;
  }
  async function workspace(session = admin) {
    const response = await request('/api/workspace', { session });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return response.json;
  }
  return { app, request, login, admin, create, workspace };
}

const constituent = (name = 'Integration donor') => ({ name, email: 'donor@example.test', phone: '', type: 'Individual', household: '', parentId: null, contacts: [], segments: '', preference: 'Email', notes: '' });
const designation = name => ({ name, school: 'Synthetic School', parentId: null, accountCode: '', description: '' });
const event = capacity => ({ name: 'Integration benefit', date: '2026-10-03', location: 'Synthetic Hall', capacity, ticketPrice: 2500, sponsorGoal: 100000, notes: '' });
const gift = (donor, fund, changes = {}) => ({ constituentId: donor.id, amount: 101, type: 'Cash', method: 'Check', date: '2026-09-13', campaignId: null, allocations: [{ designationId: fund.id, amount: 101 }], externalRef: '', notes: '', tribute: '', softCreditId: null, pledge: '', giftKind: 'One-time', ...changes });
const rejected = response => assert.ok([400, 409].includes(response.status), `Expected validation/conflict, got ${response.status}: ${JSON.stringify(response.json)}`);

test('anonymous clients cannot read business data, backup, users or mutate', async t => {
  const f = await fixture(t);
  for (const path of ['/api/auth/me', '/api/workspace', '/api/backup', '/api/users']) {
    const r = await f.request(path);
    assert.equal(r.status, 401, path);
    assert.ok(r.json.error);
    assert.equal(r.json.data, undefined);
  }
  assert.equal((await f.request('/api/records/constituents', { method: 'POST', body: constituent() })).status, 401);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { email: 'alex@foundation.example', password: 'wrong' } })).status, 401);
});

test('mutations require the session CSRF token and disallow foreign origins', async t => {
  const f = await fixture(t);
  const before = await f.workspace();
  for (const csrf of [false, 'incorrect-token']) {
    assert.equal((await f.request('/api/records/constituents', { method: 'POST', session: f.admin, csrf, body: constituent() })).status, 403);
  }
  assert.equal((await f.request('/api/records/constituents', { method: 'POST', session: f.admin, origin: 'https://untrusted.example', body: constituent() })).status, 403);
  assert.equal((await f.workspace()).data.constituents.length, before.data.constituents.length);
  const logout = await f.request('/api/auth/logout', { method: 'POST', session: f.admin });
  assert.ok([200, 204].includes(logout.status));
  assert.equal((await f.request('/api/workspace', { session: f.admin })).status, 401);
});

test('viewer can read but cannot mutate, and staff cannot access admin controls', async t => {
  const f = await fixture(t);
  const viewer = await f.login('board@foundation.example');
  const staff = await f.login('staff@foundation.example');
  const data = await f.workspace(viewer);
  const donor = await f.create('constituents', constituent());
  assert.equal((await f.request('/api/records/constituents', { method: 'POST', session: viewer, body: constituent() })).status, 403);
  assert.equal((await f.request(`/api/records/constituents/${donor.id}`, { method: 'PATCH', session: viewer, body: { version: donor.version, name: 'Unauthorized edit' } })).status, 403);
  assert.equal((await f.request(`/api/records/constituents/${donor.id}`, { method: 'DELETE', session: viewer, body: { version: donor.version } })).status, 403);
  for (const session of [viewer, staff]) {
    assert.equal((await f.request('/api/users', { session })).status, 403);
    assert.equal((await f.request('/api/backup', { session })).status, 403);
    assert.equal((await f.request('/api/settings', { method: 'PATCH', session, body: { organizationName: 'Unauthorized', fiscalStartMonth: 7 } })).status, 403);
  }
  assert.ok(!data.audit || data.audit.length === 0, 'Viewer must not receive admin audit data');
  assert.equal(typeof data.settings.organizationName, 'string');
  assert.ok(Number.isInteger(data.settings.fiscalStartMonth));
  assert.deepEqual(Object.keys(data.settings).sort(), ['fiscalStartMonth', 'organizationName']);
  const r = await f.request('/api/records/constituents', { method: 'POST', session: staff, body: constituent('Staff donor') });
  assert.ok([200, 201].includes(r.status));
});

test('split gifts round-trip integer cents and reject mismatched or fractional money', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const a = await f.create('designations', designation('Fund A'));
  const b = await f.create('designations', designation('Fund B'));
  const created = await f.create('gifts', gift(donor, a, { allocations: [{ designationId: a.id, amount: 33 }, { designationId: b.id, amount: 68 }] }));
  const persisted = (await f.workspace()).data.gifts.find(g => g.id === created.id);
  assert.equal(persisted.amount, 101);
  assert.deepEqual(persisted.allocations.map(a => a.amount), [33, 68]);
  assert.equal(persisted.status, 'Posted');
  for (const changes of [{ allocations: [{ designationId: a.id, amount: 100 }] }, { amount: 1.01 }, { allocations: [{ designationId: a.id, amount: 101.01 }] }, { amount: 0 }, { amount: Number.MAX_SAFE_INTEGER + 1 }]) {
    rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, a, changes) }));
  }
});

test('invalid calendar dates and missing references leave gifts unchanged', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Validation fund'));
  const count = (await f.workspace()).data.gifts.length;
  for (const changes of [{ date: '2026-02-30' }, { date: '2026-13-01' }, { constituentId: 'missing-donor' }, { campaignId: 'missing-campaign' }, { softCreditId: 'missing-person' }, { allocations: [{ designationId: 'missing-fund', amount: 101 }] }]) {
    rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, fund, changes) }));
  }
  assert.equal((await f.workspace()).data.gifts.length, count);
  await f.create('gifts', gift(donor, fund, { date: '2024-02-29' }));
});

test('optimistic versions preserve the winner and reject stale update and delete', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const update = await f.request(`/api/records/constituents/${donor.id}`, { method: 'PATCH', session: f.admin, body: { version: donor.version, name: 'Winner' } });
  assert.equal(update.status, 200, JSON.stringify(update.json));
  assert.equal(update.json.record.version, donor.version + 1);
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await f.request(`/api/records/constituents/${donor.id}`, { method, session: f.admin, body: { version: donor.version, name: 'Stale loser' } })).status, 409);
  }
  assert.equal((await f.workspace()).data.constituents.find(c => c.id === donor.id).name, 'Winner');
});

test('gift references block donor and designation deletion, including after void', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Retained ledger fund'));
  const donation = await f.create('gifts', gift(donor, fund));
  for (const [collection, record] of [['constituents', donor], ['designations', fund]]) {
    rejected(await f.request(`/api/records/${collection}/${record.id}`, { method: 'DELETE', session: f.admin, body: { version: record.version } }));
  }
  const voided = await f.request(`/api/gifts/${donation.id}/void`, { method: 'POST', session: f.admin, body: { version: donation.version, reason: 'Synthetic correction' } });
  assert.equal(voided.status, 200);
  rejected(await f.request(`/api/records/constituents/${donor.id}`, { method: 'DELETE', session: f.admin, body: { version: donor.version } }));
});

test('designation hierarchies reject cycles and referenced parents cannot delete', async t => {
  const f = await fixture(t);
  const parent = await f.create('designations', designation('Parent'));
  const child = await f.create('designations', { ...designation('Child'), parentId: parent.id });
  rejected(await f.request(`/api/records/designations/${parent.id}`, { method: 'PATCH', session: f.admin, body: { version: parent.version, parentId: child.id } }));
  rejected(await f.request(`/api/records/designations/${child.id}`, { method: 'PATCH', session: f.admin, body: { version: child.version, parentId: child.id } }));
  rejected(await f.request(`/api/records/designations/${parent.id}`, { method: 'DELETE', session: f.admin, body: { version: parent.version } }));
});

test('gift imports are atomic across invalid rows and duplicate external references', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Import fund'));
  const original = await f.workspace();
  const rows = [gift(donor, fund, { externalRef: 'atomic-1' }), gift(donor, fund, { externalRef: 'atomic-2', date: '2026-02-30' })];
  rejected(await f.request('/api/gifts/import', { method: 'POST', session: f.admin, body: { rows } }));
  assert.equal((await f.workspace()).data.gifts.length, original.data.gifts.length);
  assert.equal((await f.workspace()).audit.length, original.audit.length, 'Rolled-back import must not append a mutation audit');
  const duplicateRows = [gift(donor, fund, { externalRef: 'duplicate-in-file' }), gift(donor, fund, { externalRef: 'duplicate-in-file' })];
  assert.equal((await f.request('/api/gifts/import', { method: 'POST', session: f.admin, body: { rows: duplicateRows } })).status, 409);
  const good = await f.request('/api/gifts/import', { method: 'POST', session: f.admin, body: { rows: [gift(donor, fund, { externalRef: 'existing-ref' }), gift(donor, fund, { externalRef: 'other-ref' })] } });
  assert.ok([200, 201].includes(good.status), JSON.stringify(good.json));
  assert.equal(good.json.imported, 2);
  const beforeDuplicate = (await f.workspace()).data.gifts.length;
  assert.equal((await f.request('/api/gifts/import', { method: 'POST', session: f.admin, body: { rows: [gift(donor, fund, { externalRef: 'new-before-duplicate' }), gift(donor, fund, { externalRef: 'existing-ref' })] } })).status, 409);
  const after = await f.workspace();
  assert.equal(after.data.gifts.length, beforeDuplicate);
  assert.ok(!after.data.gifts.some(g => g.externalRef === 'new-before-duplicate'));
});

test('event registrations enforce capacity, duplicate rules and check-in membership', async t => {
  const f = await fixture(t);
  const a = await f.create('constituents', constituent('Guest A'));
  const b = await f.create('constituents', constituent('Guest B'));
  const benefit = await f.create('events', event(1));
  rejected(await f.request(`/api/events/${benefit.id}/checkin`, { method: 'POST', session: f.admin, body: { constituentId: a.id } }));
  const registered = await f.request(`/api/events/${benefit.id}/register`, { method: 'POST', session: f.admin, body: { constituentId: a.id, seating: 'Table 3' } });
  assert.ok([200, 201].includes(registered.status));
  assert.equal(registered.json.record.registrations.length, 1);
  for (const constituentId of [a.id, b.id]) rejected(await f.request(`/api/events/${benefit.id}/register`, { method: 'POST', session: f.admin, body: { constituentId, seating: '' } }));
  const checked = await f.request(`/api/events/${benefit.id}/checkin`, { method: 'POST', session: f.admin, body: { constituentId: a.id } });
  assert.equal(checked.status, 200);
  assert.equal(checked.json.record.registrations[0].checkedIn, true);
  const cancelled = await f.request(`/api/events/${benefit.id}/register/${a.id}`, { method: 'DELETE', session: f.admin });
  assert.ok([200, 204].includes(cancelled.status));
  assert.ok([200, 201].includes((await f.request(`/api/events/${benefit.id}/register`, { method: 'POST', session: f.admin, body: { constituentId: b.id, seating: '' } })).status));
  const persisted = (await f.workspace()).data.events.find(e => e.id === benefit.id);
  assert.deepEqual(persisted.registrations.map(r => r.constituentId), [b.id]);
});

test('volunteer clock is persisted, rejects repeated operations and protected edits', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent('Volunteer'));
  const v = await f.create('volunteers', { constituentId: donor.id, skills: 'Setup', shift: 'Morning', eventId: null, hours: 2, notes: '' });
  rejected(await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { action: 'out', version: v.version } }));
  const started = await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { action: 'in', version: v.version } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.ok(started.json.record.clockIn);
  assert.ok((await f.workspace()).data.volunteers.find(r => r.id === v.id).clockIn);
  rejected(await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { action: 'in', version: started.json.record.version } }));
  for (const body of [{ hours: 999 }, { clockIn: '2020-01-01T00:00:00Z' }]) {
    const r = await f.request(`/api/records/volunteers/${v.id}`, { method: 'PATCH', session: f.admin, body: { version: started.json.record.version, ...body } });
    if (r.status === 200) {
      assert.notEqual(r.json.record.hours, 999);
      assert.notEqual(r.json.record.clockIn, '2020-01-01T00:00:00Z');
    } else rejected(r);
  }
  const current = (await f.workspace()).data.volunteers.find(r => r.id === v.id);
  const ended = await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { action: 'out', version: current.version } });
  assert.equal(ended.status, 200);
  assert.ok(!ended.json.record.clockIn);
  assert.ok(ended.json.record.hours >= 2);
  rejected(await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { action: 'out', version: ended.json.record.version } }));
});

test('void retains the financial ledger and excludes its amount from posted totals', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Void fund'));
  const total = gifts => gifts.filter(g => g.status !== 'Voided').reduce((sum, g) => sum + g.amount, 0);
  const before = total((await f.workspace()).data.gifts);
  const donation = await f.create('gifts', gift(donor, fund, { amount: 12345, allocations: [{ designationId: fund.id, amount: 12345 }] }));
  assert.equal(total((await f.workspace()).data.gifts), before + 12345);
  assert.equal((await f.request(`/api/records/gifts/${donation.id}`, { method: 'DELETE', session: f.admin, body: { version: donation.version } })).status, 403);
  rejected(await f.request(`/api/gifts/${donation.id}/void`, { method: 'POST', session: f.admin, body: { version: donation.version, reason: '' } }));
  const r = await f.request(`/api/gifts/${donation.id}/void`, { method: 'POST', session: f.admin, body: { version: donation.version, reason: 'Duplicate synthetic entry' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const data = await f.workspace();
  const retained = data.data.gifts.find(g => g.id === donation.id);
  assert.equal(retained.status, 'Voided');
  assert.equal(retained.amount, 12345);
  assert.equal(total(data.data.gifts), before);
  assert.ok(data.audit.some(a => JSON.stringify(a).includes(donation.id)), 'Financial change must have an audit entry');
  rejected(await f.request(`/api/gifts/${donation.id}/void`, { method: 'POST', session: f.admin, body: { version: retained.version, reason: 'Again' } }));
});

test('Do not contact constituents cannot receive new marketing drafts', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', { ...constituent(), preference: 'Do not contact' });
  const r = await f.request('/api/records/communications', { method: 'POST', session: f.admin, body: { constituentId: donor.id, subject: 'Annual fundraising appeal', channel: 'Email', status: 'Draft', date: '2026-09-13', body: 'Please donate', notes: '' } });
  assert.ok([400, 403, 409].includes(r.status), JSON.stringify(r.json));
});

test('admin backup retains business data but contains no credential or session material', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent('Backup marker donor'));
  const r = await f.request('/api/backup', { session: f.admin });
  assert.equal(r.status, 200);
  const serialized = JSON.stringify(r.json);
  assert.ok(serialized.includes(donor.id));
  assert.ok(serialized.includes('Backup marker donor'));
  assert.ok(!serialized.includes(password));
  assert.ok(!serialized.includes(f.admin.csrfToken));
  assert.ok(!serialized.includes(f.admin.cookie.split('=')[1]));
  function inspect(value) {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/password|credential|session|csrf|tokenhash|salt|scrypt/i.test(key), `Sensitive backup key: ${key}`);
      inspect(child);
    }
  }
  inspect(r.json);
  const users = await f.request('/api/users', { session: f.admin });
  assert.equal(users.status, 200);
  inspect(users.json);
});

test('protected financial and identity fields cannot be supplied by callers', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Protected fund'));
  const create = await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: { ...gift(donor, fund), id: 'caller-chosen-id', version: 999, status: 'Voided', schoolYear: '1900-1901', createdAt: '1900-01-01' } });
  if ([200, 201].includes(create.status)) {
    assert.notEqual(create.json.record.id, 'caller-chosen-id');
    assert.notEqual(create.json.record.version, 999);
    assert.equal(create.json.record.status, 'Posted');
    assert.notEqual(create.json.record.schoolYear, '1900-1901');
    assert.notEqual(create.json.record.createdAt, '1900-01-01');
  } else rejected(create);
  const posted = await f.create('gifts', gift(donor, fund));
  const patch = await f.request(`/api/records/gifts/${posted.id}`, { method: 'PATCH', session: f.admin, body: { version: posted.version, status: 'Voided', id: 'replacement-id', schoolYear: '1900-1901' } });
  if (patch.status !== 200) rejected(patch);
  const persisted = (await f.workspace()).data.gifts.find(g => g.id === posted.id);
  assert.ok(persisted);
  assert.equal(persisted.status, 'Posted');
  assert.notEqual(persisted.schoolYear, '1900-1901');
});

test('viewer cannot bypass readonly permissions through specialized workflow routes', async t => {
  const f = await fixture(t);
  const viewer = await f.login('board@foundation.example');
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Readonly fund'));
  const donation = await f.create('gifts', gift(donor, fund));
  const benefit = await f.create('events', event(2));
  const volunteer = await f.create('volunteers', { constituentId: donor.id, skills: '', shift: '', eventId: benefit.id, hours: 0, notes: '' });
  const routes = [
    ['/api/gifts/import', { rows: [gift(donor, fund)] }],
    [`/api/gifts/${donation.id}/void`, { version: donation.version, reason: 'Unauthorized' }],
    [`/api/volunteers/${volunteer.id}/clock`, { version: volunteer.version, action: 'in' }],
    [`/api/events/${benefit.id}/register`, { constituentId: donor.id, seating: '' }],
    [`/api/events/${benefit.id}/checkin`, { constituentId: donor.id }],
  ];
  for (const [path, body] of routes) assert.equal((await f.request(path, { method: 'POST', session: viewer, body })).status, 403, path);
});

test('persisted school years follow fiscal boundaries and recompute for January', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Fiscal fund'));
  const june = await f.create('gifts', gift(donor, fund, { date: '2026-06-30' }));
  const july = await f.create('gifts', gift(donor, fund, { date: '2026-07-01' }));
  assert.equal(june.schoolYear, '2025–2026');
  assert.equal(july.schoolYear, '2026–2027');
  const settings = await f.request('/api/settings', { method: 'PATCH', session: f.admin, body: { organizationName: 'Fiscal test foundation', fiscalStartMonth: 1 } });
  assert.equal(settings.status, 200);
  const workspace = await f.workspace();
  for (const id of [june.id, july.id]) {
    const persisted = workspace.data.gifts.find(g => g.id === id);
    assert.equal(persisted.schoolYear, '2026');
    assert.equal(persisted.version, 2, 'Fiscal change invalidates stale gift edits');
  }
  assert.equal((await f.create('gifts', gift(donor, fund, { date: '2027-01-01' }))).schoolYear, '2027');
});

test('in-kind gifts require the in-kind method and cash cannot masquerade as noncash', async t => {
  const f = await fixture(t);
  const donor = await f.create('constituents', constituent());
  const fund = await f.create('designations', designation('Noncash fund'));
  const count = (await f.workspace()).data.gifts.length;
  for (const changes of [{ type: 'In-kind', method: 'Check' }, { type: 'Cash', method: 'In-kind' }]) rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, fund, changes) }));
  assert.equal((await f.workspace()).data.gifts.length, count);
  const goods = await f.create('gifts', gift(donor, fund, { type: 'In-kind', method: 'In-kind' }));
  rejected(await f.request(`/api/records/gifts/${goods.id}`, { method: 'PATCH', session: f.admin, body: { version: goods.version, method: 'Cash' } }));
  assert.equal((await f.workspace()).data.gifts.find(g => g.id === goods.id).method, 'In-kind');
});

test('event-linked tasks validate the event and prevent removal while referenced', async t => {
  const f = await fixture(t);
  const benefit = await f.create('events', event(10));
  const task = { title: 'Arrange event seating', dueDate: '2026-10-01', owner: 'Alex', status: 'Open', priority: 'Normal', constituentId: null, eventId: benefit.id, notes: '' };
  rejected(await f.request('/api/records/tasks', { method: 'POST', session: f.admin, body: { ...task, eventId: 'missing-event' } }));
  const created = await f.create('tasks', task);
  assert.equal(created.eventId, benefit.id);
  rejected(await f.request(`/api/records/events/${benefit.id}`, { method: 'DELETE', session: f.admin, body: { version: benefit.version } }));
  assert.equal((await f.request(`/api/records/tasks/${created.id}`, { method: 'PATCH', session: f.admin, body: { version: created.version, eventId: null } })).status, 200);
  assert.equal((await f.request(`/api/records/events/${benefit.id}`, { method: 'DELETE', session: f.admin, body: { version: benefit.version } })).status, 200);
});

test('production rejects unsafe origins and HTTP, and trusts TLS forwarding only explicitly', async t => {
  const keys = ['NODE_ENV', 'APP_ORIGIN', 'ALLOW_DEMO', 'TRUST_PROXY', 'ADMIN_EMAIL', 'ADMIN_NAME', 'ADMIN_PASSWORD'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_DEMO = 'false';
  process.env.ADMIN_EMAIL = 'admin@production.example.test';
  process.env.ADMIN_NAME = 'Production test administrator';
  process.env.ADMIN_PASSWORD = 'ProductionTest!2026';
  const dir = await mkdtemp(join(tmpdir(), 'foundation-production-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const origin of ['http://crm.example.test', 'https://crm.example.test/path', 'https://crm.example.test?query=1', 'https://user:pass@crm.example.test', 'https://crm.example.test/']) {
    process.env.APP_ORIGIN = origin;
    assert.throws(() => createApp({ dbPath: join(dir, 'test.sqlite'), seed: false }), /HTTPS origin/);
  }
  process.env.APP_ORIGIN = 'https://crm.example.test';
  for (const trusted of [false, true]) {
    process.env.TRUST_PROXY = String(trusted);
    const app = createApp({ dbPath: join(dir, 'test.sqlite'), seed: false });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const http = await fetch(base + '/api/workspace');
      assert.equal(http.status, 403);
      assert.equal(http.headers.get('cache-control'), 'no-store');
      const forwarded = await fetch(base + '/api/workspace', { headers: { 'X-Forwarded-Proto': 'https', Origin: process.env.APP_ORIGIN } });
      assert.equal(forwarded.status, trusted ? 401 : 403);
      if (trusted) {
        for (const origin of ['https://attacker.example.test', 'http://localhost:5173']) {
          const denied = await fetch(base + '/api/workspace', { headers: { 'X-Forwarded-Proto': 'https', Origin: origin } });
          assert.equal(denied.status, 403);
          assert.equal(denied.headers.get('access-control-allow-origin'), null);
        }
        const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Origin: process.env.APP_ORIGIN }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
        assert.equal(login.status, 200);
        assert.match(login.headers.get('set-cookie'), /secure/i);
        assert.equal(login.headers.get('access-control-allow-origin'), process.env.APP_ORIGIN);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      app.locals.close();
    }
  }
});
