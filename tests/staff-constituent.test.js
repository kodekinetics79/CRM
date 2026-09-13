import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

const operator = { name: 'Synthetic operator', email: 'operator.staff-fixture@example.test', password: 'StaffJourneyFixture!2026' };
const person = (changes = {}) => ({ name: 'Synthetic foundation staff donor', email: 'person.staff-fixture@example.test', type: 'Staff', ...changes });
const designation = { name: 'Synthetic classroom program', accountCode: 'STAFF-101', school: 'Synthetic school' };
const shift = { name: 'Synthetic staff volunteering', date: '2026-10-15', startTime: '09:00', endTime: '10:00', location: 'Synthetic venue', capacity: 4, status: 'Open' };
const gift = (donor, fund, changes = {}) => ({ constituentId: donor.id, amount: 12345, type: 'Cash', method: 'Check', date: '2026-09-01', allocations: [{ designationId: fund.id, amount: 12345 }], externalRef: 'STAFF-JOURNEY-GIFT', ...changes });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-staff-person-')), dbPath = join(dir, 'workspace.sqlite');
  let app, server, base, sessions;
  async function open() {
    app = createApp({ dbPath, seed: false, initialAdmin: operator });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function request(path, body, session = sessions?.admin, method = body === undefined ? 'GET' : 'POST', extra = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login(email = operator.email) {
    const result = await request('/auth/login', { email, password: operator.password }, null);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return { ...result.json, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  async function signInAll() { sessions = { admin: await login(), staff: await login('writer.staff-fixture@example.test'), viewer: await login('viewer.staff-fixture@example.test') }; }
  async function create(collection, body, session = sessions.admin) {
    const result = await request('/records/' + collection, body, session);
    assert.equal(result.status, 201, JSON.stringify(result.json)); return result.json.record;
  }
  await open(); sessions = { admin: await login() };
  for (const role of ['staff', 'viewer']) {
    const email = role === 'staff' ? 'writer.staff-fixture@example.test' : 'viewer.staff-fixture@example.test';
    assert.equal((await request('/users', { name: 'Synthetic ' + role, email, password: operator.password, role })).status, 201);
  }
  await signInAll(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  return { request, create, login, restart: async () => { await close(); await open(); await signInAll(); }, get app() { return app; }, get sessions() { return sessions; }, workspace: async () => (await request('/workspace')).json };
}

async function run(f, entity, columns, extra = {}) {
  const result = await f.request('/custom-reports/run', { name: 'Synthetic Staff identity proof', entity, columns, ...extra }, f.sessions.viewer);
  assert.equal(result.status, 200, JSON.stringify(result.json)); return result.json;
}

test('one Staff constituent retains giving, corrected volunteer time, reservations, household and report identity after restart', async t => {
  const f = await fixture(t), accountsBefore = f.app.locals.db.prepare('SELECT count(*) n FROM users').get().n;
  const donor = await f.create('constituents', person(), f.sessions.staff), fund = await f.create('designations', designation);
  const posted = await f.create('gifts', gift(donor, fund), f.sessions.staff);
  const volunteer = await f.create('volunteers', { constituentId: donor.id, skills: 'Synthetic welcome desk', shift: 'Historical source', hours: 2.5 }, f.sessions.staff);
  const time = (await f.workspace()).data.volunteerTime.find(row => row.volunteerId === volunteer.id);
  assert.equal(time.constituentId, donor.id); assert.equal(time.source, 'Historical'); assert.equal(time.startAt, null);
  const corrected = await f.request('/volunteer-time/' + time.id + '/correct', { version: time.version, hours: 2.75, reason: 'Synthetic approved correction from source timesheet' }, f.sessions.staff);
  assert.equal(corrected.status, 200); assert.equal(corrected.json.record.originalHours, 2.5); assert.equal(corrected.json.volunteer.hours, 2.75);
  const scheduled = await f.create('volunteerShifts', shift);
  const reservation = await f.create('shiftReservations', { shiftId: scheduled.id, constituentId: donor.id, status: 'Reserved' }, f.sessions.staff);
  const household = await f.request('/households', { name: 'Synthetic Staff household', address: 'Synthetic address', memberIds: [donor.id] });
  assert.equal(household.status, 201, JSON.stringify(household.json));
  const current = (await f.workspace()).data.constituents.find(row => row.id === donor.id);
  const edited = await f.request('/records/constituents/' + donor.id, { version: current.version, notes: 'Synthetic profile update preserves Staff reservation and household identity' }, f.sessions.staff, 'PATCH');
  assert.equal(edited.status, 200, JSON.stringify(edited.json)); assert.equal(edited.json.record.type, 'Staff');
  await f.restart(); const data = (await f.workspace()).data;
  assert.equal(data.constituents.length, 1); assert.equal(data.constituents[0].id, donor.id); assert.equal(data.constituents[0].type, 'Staff');
  assert.equal(data.gifts[0].id, posted.id); assert.equal(data.gifts[0].constituentId, donor.id);
  assert.equal(data.volunteers[0].constituentId, donor.id); assert.equal(data.volunteers[0].hours, 2.75);
  assert.equal(data.volunteerTime[0].constituentId, donor.id); assert.equal(data.volunteerTime[0].originalHours, 2.5);
  assert.equal(data.shiftReservations[0].id, reservation.id); assert.equal(data.shiftReservations[0].constituentId, donor.id);
  const households = await f.request('/households'); assert.equal(households.status, 200); assert.deepEqual(households.json.households[0].memberIds, [donor.id]);
  assert.deepEqual((await run(f, 'constituents', ['id', 'name', 'type'], { filters: [{ field: 'type', op: 'eq', value: 'Staff' }] })).rows, [[donor.id, donor.name, 'Staff']]);
  assert.deepEqual((await run(f, 'gifts', ['donorName', 'amount'], { filters: [{ field: 'constituentId', op: 'eq', value: donor.id }] })).rows, [[donor.name, 12345]]);
  assert.deepEqual((await run(f, 'volunteers', ['constituentName', 'hours'], { filters: [{ field: 'constituentId', op: 'eq', value: donor.id }] })).rows, [[donor.name, 2.75]]);
  assert.equal(f.app.locals.db.prepare('SELECT count(*) n FROM users').get().n, accountsBefore);
  assert.equal(f.app.locals.db.prepare('SELECT count(*) n FROM users WHERE email=?').get(donor.email).n, 0);
  assert.equal((await f.request('/auth/login', { email: donor.email, password: operator.password }, null)).status, 401);
});

test('Staff category preserves person history, organization eligibility, permissions and explicit Employee-only annual receipt rules', async t => {
  const f = await fixture(t), donor = await f.create('constituents', person()), organization = await f.create('constituents', person({ name: 'Synthetic business', email: 'business.staff-fixture@example.test', type: 'Business' }));
  const fund = await f.create('designations', designation), scheduled = await f.create('volunteerShifts', shift);
  await f.create('shiftReservations', { shiftId: scheduled.id, constituentId: donor.id, status: 'Reserved' });
  assert.equal((await f.request('/households', { name: 'Synthetic household', address: '', memberIds: [donor.id] })).status, 201);
  const current = (await f.workspace()).data.constituents.find(row => row.id === donor.id);
  assert.equal((await f.request('/records/constituents/' + donor.id, { version: current.version, type: 'Business' }, f.sessions.admin, 'PATCH')).status, 409);
  assert.equal((await f.request('/records/shiftReservations', { shiftId: scheduled.id, constituentId: organization.id, status: 'Reserved' })).status, 400);
  assert.equal((await f.request('/households', { name: 'Invalid business household', address: '', memberIds: [organization.id] })).status, 400);
  const before = f.app.locals.db.prepare('SELECT count(*) n FROM records').get().n;
  assert.equal((await f.request('/records/constituents', person({ email: 'denied.staff-fixture@example.test' }), f.sessions.viewer)).status, 403);
  assert.equal((await f.request('/records/constituents', person({ email: 'csrf.staff-fixture@example.test' }), f.sessions.staff, 'POST', { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await f.request('/records/constituents', person({ email: 'invalid.staff-fixture@example.test', type: 'Staff member' }))).status, 400);
  assert.equal(f.app.locals.db.prepare('SELECT count(*) n FROM records').get().n, before);
  assert.equal((await f.request('/users', { name: 'No category role inference', email: 'invalid-role.staff-fixture@example.test', password: operator.password, role: 'Staff' })).status, 400);
  const payroll = await f.create('gifts', gift(donor, fund, { type: 'Employee giving', method: 'Payroll', externalRef: 'STAFF-PAYROLL-NOT-EMPLOYEE-INFERENCE' }));
  assert.equal((await f.request('/receipt-profile', { version: 0, organizationName: 'Synthetic fixture only', address: 'Synthetic address', taxIdentifier: 'SYNTHETIC-NOT-REAL', signatureLabel: 'Synthetic signer', customFooter: '', approved: true }, f.sessions.admin, 'PUT')).status, 200);
  const annual = await f.request('/receipts/prepare', { kind: 'Annual employee', constituentId: donor.id, year: 2026, profileVersion: 1 });
  assert.equal(annual.status, 400); assert.match(annual.json.error, /Employee constituent/);
  const matching = await f.request('/fundraising', { kind: 'matching', name: 'Invalid Staff as employer', campaignId: null, originalGiftId: payroll.id, originalGiftVersion: payroll.version, matchingOrganizationId: donor.id, ratioNumerator: 1, ratioDenominator: 1, capAmount: null, status: 'Eligible', notes: '' });
  assert.equal(matching.status, 400); assert.match(matching.json.error, /business, foundation or community partner/);
});

const sourceFile = (collection, rows) => ({ collection, mapping: Object.fromEntries(Object.keys(rows[0]).map(key => [key, key])), rows });

test('Staff source conversion preserves one original identity and exact gift controls through replay and restart', async t => {
  const f = await fixture(t);
  const input = { source: 'Synthetic normalized Staff source', fileKey: 'staff-source-1', files: [
    sourceFile('constituents', [{ sourceId: 'staff-source-person', name: 'Synthetic migrated Staff', email: 'migrated.staff-fixture@example.test', type: 'Staff' }]),
    sourceFile('designations', [{ sourceId: 'staff-source-fund', name: 'Synthetic migrated fund', school: 'Synthetic school', accountCode: 'STAFF-MIGRATED-101' }]),
    sourceFile('gifts', [{ sourceId: 'staff-source-gift', donorSourceId: 'staff-source-person', designationSourceId: 'staff-source-fund', amount: '0.30', type: 'Cash', method: 'Check', date: '2016-09-13', externalRef: 'STAFF-MIGRATED-GIFT' }]),
  ] };
  const preview = await f.request('/migration/preview', input); assert.equal(preview.status, 200); assert.equal(preview.json.valid, true);
  const saved = await f.request('/migration/commit', { ...input, previewDigest: preview.json.previewDigest });
  assert.equal(saved.status, 201, JSON.stringify(saved.json)); assert.equal(saved.json.reconciliation.actualNewGiftCents, '30');
  const personId = saved.json.sourceRecords.find(row => row.collection === 'constituents').recordId;
  await f.create('volunteers', { constituentId: personId, hours: 1, skills: 'Synthetic source-linked Staff volunteering' });
  await f.restart();
  const replay = await f.request('/migration/commit', { ...input, previewDigest: preview.json.previewDigest });
  assert.equal(replay.status, 200); assert.equal(replay.json.replayed, true); assert.deepEqual(replay.json.sourceRecords, saved.json.sourceRecords);
  const data = (await f.workspace()).data; assert.equal(data.constituents.length, 1); assert.equal(data.gifts.length, 1);
  assert.equal(data.constituents[0].type, 'Staff'); assert.equal(data.constituents[0].id, personId);
  assert.equal(data.gifts[0].constituentId, personId); assert.equal(data.gifts[0].amount, 30); assert.equal(data.gifts[0].date, '2016-09-13');
  assert.equal(data.volunteers[0].constituentId, personId);
  const detail = await f.request('/migration/batches/' + saved.json.batchId); assert.equal(detail.status, 200); assert.deepEqual(detail.json.integrity, { unchanged: 3, changed: 0, missing: 0 });
  assert.deepEqual((await run(f, 'constituents', ['id', 'type'], { filters: [{ field: 'type', op: 'eq', value: 'Staff' }] })).rows, [[personId, 'Staff']]);
});
