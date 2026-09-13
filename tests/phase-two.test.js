import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'everbright-phase-two-'));
  const dbPath = join(dir, 'test.sqlite');
  let app;
  let server;
  let base;
  async function open() {
    app = createApp({ dbPath, seed: true });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
    if (app) { app.locals.close(); app = null; }
  }
  await open();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) {
      headers.Cookie = session.cookie;
      if (csrf) headers['X-CSRF-Token'] = typeof csrf === 'string' ? csrf : session.csrfToken;
    }
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, json, headers: response.headers };
  }
  async function login(email = 'alex@foundation.example') {
    const r = await request('/api/auth/login', { method: 'POST', body: { email, password: 'FoundationDemo!2026' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { ...r.json, cookie: r.headers.get('set-cookie').split(';')[0] };
  }
  let admin = await login();
  async function workspace(session = admin) {
    const r = await request('/api/workspace', { session });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  }
  async function create(collection, body, session = admin) {
    const r = await request(`/api/records/${collection}`, { method: 'POST', session, body });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.json));
    return r.json.record;
  }
  async function patch(collection, record, changes, session = admin) {
    return request(`/api/records/${collection}/${record.id}`, { method: 'PATCH', session, body: { version: record.version, ...changes } });
  }
  async function restart() { await close(); await open(); admin = await login(); return workspace(); }
  return { request, login, workspace, create, patch, restart, get admin() { return admin; }, get app() { return app; } };
}

const person = (name = 'Phase two donor', preference = 'Email') => ({ name, email: 'phase-two@example.test', type: 'Individual', preference, household: '', contacts: [], parentId: null, segments: '', phone: '', notes: '' });
const pledge = (donor, changes = {}) => ({ name: 'Classroom pledge', constituentId: donor.id, amount: 10000, startDate: '2026-01-31', installments: 4, frequency: 'Monthly', designationId: null, campaignId: null, status: 'Active', notes: '', ...changes });
const gift = (donor, fund, amount = 1000, changes = {}) => ({ constituentId: donor.id, amount, date: '2026-09-13', type: 'Cash', method: 'Check', campaignId: null, allocations: [{ designationId: fund.id, amount }], externalRef: '', notes: '', tribute: '', softCreditId: null, pledge: '', pledgeId: null, giftKind: 'Pledge fulfillment', ...changes });
const filters = changes => ({ report: 'Contributions by donor', start: '', end: '', type: 'All', schoolYear: 'All', excludeFees: true, inactiveDays: 90, ...changes });
const rejected = r => assert.ok([400, 403, 409].includes(r.status), `Expected rejection, got ${r.status}: ${JSON.stringify(r.json)}`);
const sameRecord = (workspace, collection, id) => workspace.data[collection].find(r => r.id === id);

async function setup(t) {
  const f = await fixture(t);
  const donor = await f.create('constituents', person());
  const fund = await f.create('designations', { name: 'Phase two school fund', school: 'Synthetic school', parentId: null, accountCode: 'PHASE2', description: '' });
  return { f, donor, fund };
}

test('pledges validate real schedules, keep optimistic versions, and obey role boundaries', async t => {
  const { f, donor } = await setup(t);
  const staff = await f.login('staff@foundation.example');
  const viewer = await f.login('board@foundation.example');
  const p = await f.create('pledges', pledge(donor), staff);
  assert.equal(sameRecord(await f.workspace(viewer), 'pledges', p.id).amount, 10000);
  for (const changes of [{ amount: 0 }, { amount: 1.5 }, { installments: 0 }, { installments: 121 }, { installments: 1.5 }, { startDate: '2026-02-30' }, { constituentId: 'unknown-donor' }, { designationId: 'unknown-fund' }]) {
    rejected(await f.request('/api/records/pledges', { method: 'POST', session: staff, body: pledge(donor, changes) }));
  }
  assert.equal((await f.request('/api/records/pledges', { method: 'POST', session: viewer, body: pledge(donor) })).status, 403);
  assert.equal((await f.patch('pledges', p, { name: 'Forbidden' }, viewer)).status, 403);
  assert.equal((await f.patch('pledges', p, { name: 'Missing CSRF' }, { ...staff, csrfToken: 'wrong' })).status, 403);
  const updated = await f.patch('pledges', p, { status: 'Paused' }, staff);
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.record.version, p.version + 1);
  assert.equal((await f.patch('pledges', p, { name: 'Stale change' }, staff)).status, 409);
  assert.equal((await f.request(`/api/records/pledges/${p.id}`, { method: 'DELETE', session: staff, body: { version: p.version } })).status, 409);
  assert.equal(sameRecord(await f.workspace(), 'pledges', p.id).status, 'Paused');
});

test('linked receipts reject another donor, fees, noncash, missing pledges and overfulfillment', async t => {
  const { f, donor, fund } = await setup(t);
  const other = await f.create('constituents', person('Other donor'));
  const p = await f.create('pledges', pledge(donor));
  const before = await f.workspace();
  for (const changes of [{ constituentId: other.id }, { type: 'Fee payment' }, { type: 'In-kind', method: 'In-kind' }, { pledgeId: 'unknown-pledge' }]) {
    rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, fund, 1000, { pledgeId: p.id, ...changes }) }));
  }
  rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, fund, 10001, { pledgeId: p.id }) }));
  assert.equal((await f.workspace()).data.gifts.length, before.data.gifts.length);
  assert.equal((await f.workspace()).audit.length, before.audit.length);
});

test('pledge edits and receipt edits cannot invalidate fulfillment, while voids release balance', async t => {
  const { f, donor, fund } = await setup(t);
  const other = await f.create('constituents', person('Different pledge donor'));
  const p = await f.create('pledges', pledge(donor));
  const a = await f.create('gifts', gift(donor, fund, 6000, { pledgeId: p.id }));
  const b = await f.create('gifts', gift(donor, fund, 4000, { pledgeId: p.id }));
  rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, fund, 1, { pledgeId: p.id }) }));
  rejected(await f.patch('gifts', a, { amount: 6001, allocations: [{ designationId: fund.id, amount: 6001 }] }));
  rejected(await f.patch('gifts', a, { constituentId: other.id }));
  rejected(await f.patch('pledges', p, { amount: 9999 }));
  rejected(await f.patch('pledges', p, { constituentId: other.id }));
  const voided = await f.request(`/api/gifts/${b.id}/void`, { method: 'POST', session: f.admin, body: { version: b.version, reason: 'Replace duplicate pledge receipt' } });
  assert.equal(voided.status, 200, JSON.stringify(voided.json));
  const replacement = await f.create('gifts', gift(donor, fund, 4000, { pledgeId: p.id }));
  const state = await f.workspace();
  const receipts = state.data.gifts.filter(g => g.pledgeId === p.id && g.status === 'Posted');
  assert.equal(receipts.reduce((n, g) => n + g.amount, 0), 10000);
  assert.equal(sameRecord(state, 'gifts', b.id).status, 'Voided');
  assert.ok(receipts.some(g => g.id === replacement.id));
  rejected(await f.request(`/api/records/pledges/${p.id}`, { method: 'DELETE', session: f.admin, body: { version: p.version } }));
});

test('moving a receipt transfers fulfillment without double-counting and checks the destination limit', async t => {
  const { f, donor, fund } = await setup(t);
  const a = await f.create('pledges', pledge(donor, { name: 'Pledge A', amount: 5000 }));
  const b = await f.create('pledges', pledge(donor, { name: 'Pledge B', amount: 5000 }));
  const receipt = await f.create('gifts', gift(donor, fund, 3000, { pledgeId: a.id }));
  assert.equal((await f.patch('gifts', receipt, { pledgeId: b.id })).status, 200);
  await f.create('gifts', gift(donor, fund, 5000, { pledgeId: a.id }));
  rejected(await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: gift(donor, fund, 2001, { pledgeId: b.id }) }));
  await f.create('gifts', gift(donor, fund, 2000, { pledgeId: b.id }));
  const state = await f.workspace();
  for (const p of [a, b]) assert.equal(state.data.gifts.filter(g => g.pledgeId === p.id && g.status === 'Posted').reduce((n, g) => n + g.amount, 0), 5000);
});

test('an overfulfilled import batch rolls back all receipts and mutation audits', async t => {
  const { f, donor, fund } = await setup(t);
  const p = await f.create('pledges', pledge(donor, { amount: 1000 }));
  const before = await f.workspace();
  const rows = [gift(donor, fund, 600, { pledgeId: p.id, externalRef: 'pledge-batch-A' }), gift(donor, fund, 600, { pledgeId: p.id, externalRef: 'pledge-batch-B' })];
  rejected(await f.request('/api/gifts/import', { method: 'POST', session: f.admin, body: { rows } }));
  const after = await f.workspace();
  assert.equal(after.data.gifts.length, before.data.gifts.length);
  assert.equal(after.audit.length, before.audit.length);
  assert.ok(!after.data.gifts.some(g => g.externalRef.startsWith('pledge-batch-')));
});

test('manual acknowledgment atomically links a completed contact and cannot be duplicated or forged', async t => {
  const { f, donor, fund } = await setup(t);
  const staff = await f.login('staff@foundation.example');
  const g = await f.create('gifts', gift(donor, fund));
  const before = await f.workspace();
  rejected(await f.request(`/api/gifts/${g.id}/acknowledge`, { method: 'POST', session: staff, body: { version: g.version, date: '2026-02-30', channel: 'Phone', notes: 'Invalid date' } }));
  assert.equal((await f.workspace()).data.communications.length, before.data.communications.length);
  const acknowledged = await f.request(`/api/gifts/${g.id}/acknowledge`, { method: 'POST', session: staff, body: { version: g.version, date: '2026-09-13', channel: 'Phone', notes: 'Manually completed thank-you call' } });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.json));
  const state = await f.workspace();
  const recorded = sameRecord(state, 'gifts', g.id);
  assert.equal(recorded.acknowledgment.channel, 'Phone');
  assert.equal(recorded.acknowledgment.notes, 'Manually completed thank-you call');
  assert.equal(recorded.version, g.version + 1);
  const contact = sameRecord(state, 'communications', recorded.acknowledgment.communicationId);
  assert.ok(contact, 'Manual completed action must have a real linked contact record');
  assert.equal(contact.status, 'Logged');
  assert.equal(contact.constituentId, donor.id);
  assert.equal(contact.date, '2026-09-13');
  assert.equal(state.data.communications.length, before.data.communications.length + 1);
  rejected(await f.request(`/api/gifts/${g.id}/acknowledge`, { method: 'POST', session: staff, body: { version: recorded.version, date: '2026-09-14', channel: 'Email', notes: 'Duplicate' } }));
  rejected(await f.patch('gifts', recorded, { acknowledgment: null }));
  assert.equal((await f.workspace()).data.communications.length, state.data.communications.length);
  assert.ok(sameRecord(await f.workspace(), 'gifts', g.id).acknowledgment);
});

test('acknowledgment protects opt-outs, fees, voids, viewer access and CSRF', async t => {
  const { f, donor, fund } = await setup(t);
  const optout = await f.create('constituents', person('Do not contact donor', 'Do not contact'));
  const opted = await f.create('gifts', gift(optout, fund));
  const fee = await f.create('gifts', gift(donor, fund, 1000, { type: 'Fee payment' }));
  const voidGift = await f.create('gifts', gift(donor, fund));
  const voided = await f.request(`/api/gifts/${voidGift.id}/void`, { method: 'POST', session: f.admin, body: { version: voidGift.version, reason: 'Evaluator void' } });
  assert.equal(voided.status, 200);
  const viewer = await f.login('board@foundation.example');
  const before = await f.workspace();
  for (const g of [opted, fee, voided.json.record]) rejected(await f.request(`/api/gifts/${g.id}/acknowledge`, { method: 'POST', session: f.admin, body: { version: g.version, date: '2026-09-13', channel: 'Meeting', notes: 'Not allowed' } }));
  const eligible = await f.create('gifts', gift(donor, fund));
  const body = { version: eligible.version, date: '2026-09-13', channel: 'Email', notes: '' };
  assert.equal((await f.request(`/api/gifts/${eligible.id}/acknowledge`, { method: 'POST', session: viewer, body })).status, 403);
  assert.equal((await f.request(`/api/gifts/${eligible.id}/acknowledge`, { method: 'POST', session: f.admin, csrf: false, body })).status, 403);
  assert.equal((await f.workspace()).data.communications.length, before.data.communications.length);
});

test('clock intervals create a dated ledger and corrections reconcile hours without changing dates', async t => {
  const { f, donor } = await setup(t);
  const volunteer = await f.create('volunteers', { constituentId: donor.id, skills: 'Setup', shift: 'Evaluator shift', eventId: null, hours: 0, notes: '' });
  const current = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: current });
  const started = await f.request(`/api/volunteers/${volunteer.id}/clock`, { method: 'POST', session: f.admin, body: { version: volunteer.version, action: 'in' } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  t.mock.timers.setTime(current + 600000);
  const ended = await f.request(`/api/volunteers/${volunteer.id}/clock`, { method: 'POST', session: f.admin, body: { version: started.json.record.version, action: 'out' } });
  assert.equal(ended.status, 200, JSON.stringify(ended.json));
  const state = await f.workspace();
  const entries = state.data.volunteerTime.filter(entry => entry.volunteerId === volunteer.id);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.source, 'Clock');
  assert.equal(entry.constituentId, donor.id);
  assert.equal(Date.parse(entry.endAt) - Date.parse(entry.startAt), 600000);
  assert.ok(Math.abs(entry.hours - 1 / 6) < 0.000001);
  assert.ok(Math.abs(sameRecord(state, 'volunteers', volunteer.id).hours - entry.hours) < 0.000001);
  const staff = await f.login('staff@foundation.example');
  const corrected = await f.request(`/api/volunteer-time/${entry.id}/correct`, { method: 'POST', session: staff, body: { version: entry.version, hours: 1.5, reason: 'Supervisor verified total' } });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
  const updated = sameRecord(await f.workspace(), 'volunteerTime', entry.id);
  assert.equal(updated.hours, 1.5);
  assert.equal(updated.originalHours, entry.hours);
  assert.equal(updated.correctionReason, 'Supervisor verified total');
  assert.equal(updated.startAt, entry.startAt);
  assert.equal(updated.endAt, entry.endAt);
  assert.equal(sameRecord(await f.workspace(), 'volunteers', volunteer.id).hours, 1.5);
  assert.equal((await f.request(`/api/volunteer-time/${entry.id}/correct`, { method: 'POST', session: staff, body: { version: entry.version, hours: 2, reason: 'Stale correction' } })).status, 409);
  for (const changes of [{ hours: -1, reason: 'Invalid negative' }, { hours: 2, reason: '' }, { hours: 2, reason: '   ' }]) rejected(await f.request(`/api/volunteer-time/${entry.id}/correct`, { method: 'POST', session: staff, body: { version: updated.version, ...changes } }));
  const second = await f.request(`/api/volunteer-time/${entry.id}/correct`, { method: 'POST', session: staff, body: { version: updated.version, hours: 2, reason: 'Final supervisor correction' } });
  assert.equal(second.status, 200);
  const final = await f.workspace();
  assert.equal(sameRecord(final, 'volunteerTime', entry.id).originalHours, entry.hours);
  assert.equal(sameRecord(final, 'volunteers', volunteer.id).hours, 2);
  assert.ok(final.audit.some(a => JSON.stringify(a).includes(entry.id) && /correct/i.test(a.action)));
});

test('a person cannot clock simultaneously through separate volunteer records', async t => {
  const { f, donor } = await setup(t);
  const body = { constituentId: donor.id, skills: '', shift: '', eventId: null, hours: 0, notes: '' };
  const a = await f.create('volunteers', body);
  const b = await f.create('volunteers', body);
  const started = await f.request(`/api/volunteers/${a.id}/clock`, { method: 'POST', session: f.admin, body: { version: a.version, action: 'in' } });
  assert.equal(started.status, 200);
  rejected(await f.request(`/api/volunteers/${b.id}/clock`, { method: 'POST', session: f.admin, body: { version: b.version, action: 'in' } }));
  assert.equal(sameRecord(await f.workspace(), 'volunteers', b.id).clockIn, null);
  assert.equal((await f.request(`/api/volunteers/${a.id}/clock`, { method: 'POST', session: f.admin, body: { version: started.json.record.version, action: 'out' } })).status, 200);
  assert.equal((await f.request(`/api/volunteers/${b.id}/clock`, { method: 'POST', session: f.admin, body: { version: b.version, action: 'in' } })).status, 200);
});

test('time ledger cannot be fabricated, overwritten, deleted, or corrected by a viewer', async t => {
  const f = await fixture(t);
  const state = await f.workspace();
  assert.ok(state.data.volunteerTime.length, 'Seeded historical hours must be preserved');
  const entry = state.data.volunteerTime[0];
  const viewer = await f.login('board@foundation.example');
  rejected(await f.request('/api/records/volunteerTime', { method: 'POST', session: f.admin, body: { volunteerId: entry.volunteerId, constituentId: entry.constituentId, eventId: null, startAt: null, endAt: null, hours: 999, source: 'Historical', notes: '' } }));
  rejected(await f.patch('volunteerTime', entry, { hours: 999 }));
  rejected(await f.request(`/api/records/volunteerTime/${entry.id}`, { method: 'DELETE', session: f.admin, body: { version: entry.version } }));
  assert.equal((await f.request(`/api/volunteer-time/${entry.id}/correct`, { method: 'POST', session: viewer, body: { version: entry.version, hours: 999, reason: 'Unauthorized correction' } })).status, 403);
  assert.equal(sameRecord(await f.workspace(), 'volunteerTime', entry.id).hours, entry.hours);
});

test('saved report views are shared, strictly validated, versioned and readonly to viewers', async t => {
  const f = await fixture(t);
  const staff = await f.login('staff@foundation.example');
  const viewer = await f.login('board@foundation.example');
  const view = await f.create('reportViews', { name: 'School-year recognition', filters: filters({ report: 'Organization rollup', start: '2026-07-01', end: '2027-06-30', schoolYear: '2026–2027' }) }, staff);
  assert.deepEqual(sameRecord(await f.workspace(viewer), 'reportViews', view.id).filters, view.filters);
  for (const invalid of [{ report: 'Unknown report' }, { start: '2026-02-30' }, { start: '2026-10-01', end: '2026-09-01' }, { inactiveDays: 0 }, { inactiveDays: 90.5 }, { injected: 'unexpected property' }]) rejected(await f.request('/api/records/reportViews', { method: 'POST', session: staff, body: { name: 'Invalid view', filters: filters(invalid) } }));
  assert.equal((await f.patch('reportViews', view, { name: 'Forbidden' }, viewer)).status, 403);
  const updated = await f.patch('reportViews', view, { name: 'Revised shared report' }, staff);
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal((await f.patch('reportViews', view, { name: 'Stale report name' }, staff)).status, 409);
  assert.equal((await f.request(`/api/records/reportViews/${view.id}`, { method: 'DELETE', session: viewer, body: { version: updated.json.record.version } })).status, 403);
  assert.equal((await f.request(`/api/records/reportViews/${view.id}`, { method: 'DELETE', session: staff, body: { version: updated.json.record.version } })).status, 200);
  assert.equal(sameRecord(await f.workspace(), 'reportViews', view.id), undefined);
});

test('restarting preserves phase-two data, custom settings, and does not duplicate upgrade history or seed', async t => {
  const { f, donor } = await setup(t);
  const p = await f.create('pledges', pledge(donor, { name: 'Persistent custom commitment' }));
  const view = await f.create('reportViews', { name: 'Persistent saved view', filters: filters({ report: 'Pledge balances' }) });
  assert.equal((await f.request('/api/settings', { method: 'PATCH', session: f.admin, body: { organizationName: 'Custom foundation preserved', fiscalStartMonth: 9 } })).status, 200);
  const before = await f.workspace();
  for (let i = 0; i < 2; i++) {
    const after = await f.restart();
    assert.equal(after.settings.organizationName, 'Custom foundation preserved');
    assert.equal(after.settings.fiscalStartMonth, 9);
    assert.equal(sameRecord(after, 'pledges', p.id).name, p.name);
    assert.deepEqual(sameRecord(after, 'reportViews', view.id).filters, view.filters);
    assert.deepEqual(after.data.pledges.map(r => r.id).sort(), before.data.pledges.map(r => r.id).sort());
    assert.deepEqual(after.data.volunteerTime.map(r => r.id).sort(), before.data.volunteerTime.map(r => r.id).sort());
    for (const historical of after.data.volunteerTime.filter(r => r.source === 'Historical')) {
      assert.equal(historical.startAt, null);
      assert.equal(historical.endAt, null);
    }
    for (const volunteer of after.data.volunteers) {
      const recorded = after.data.volunteerTime.filter(r => r.volunteerId === volunteer.id).reduce((n, r) => n + r.hours, 0);
      assert.ok(Math.abs(recorded - volunteer.hours) < 0.000001, 'Each preserved historical total reconciles once');
    }
  }
});

test('acknowledgment records cannot be relabeled or moved after completion, and future completion is rejected', async t => {
  const { f, donor, fund } = await setup(t);
  const other = await f.create('constituents', person('Unrelated recipient'));
  const g = await f.create('gifts', gift(donor, fund));
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const future = await f.request(`/api/gifts/${g.id}/acknowledge`, { method: 'POST', session: f.admin, body: { version: g.version, date: tomorrow, channel: 'Phone', notes: 'Not completed yet' } });
  rejected(future);
  assert.equal(sameRecord(await f.workspace(), 'gifts', g.id).acknowledgment, undefined);
  const action = await f.request(`/api/gifts/${g.id}/acknowledge`, { method: 'POST', session: f.admin, body: { version: g.version, date: '2026-09-13', channel: 'Phone', notes: 'Completed call' } });
  assert.equal(action.status, 200, JSON.stringify(action.json));
  const recorded = action.json.record;
  const linked = action.json.communication;
  assert.equal(linked.giftId, g.id);
  for (const changes of [{ constituentId: other.id }, { type: 'Fee payment' }]) assert.equal((await f.patch('gifts', recorded, changes)).status, 409);
  for (const changes of [{ constituentId: other.id }, { status: 'Draft' }, { date: '2026-09-12' }, { channel: 'Email' }]) assert.equal((await f.patch('communications', linked, changes)).status, 409);
  rejected(await f.request(`/api/records/communications/${linked.id}`, { method: 'DELETE', session: f.admin, body: { version: linked.version } }));
  const notes = await f.patch('communications', linked, { body: 'Expanded factual notes', notes: 'Supervisor review' });
  assert.equal(notes.status, 200, JSON.stringify(notes.json));
  assert.equal(notes.json.record.giftId, g.id);
  assert.equal(notes.json.record.status, 'Logged');
  assert.equal(sameRecord(await f.workspace(), 'gifts', g.id).constituentId, donor.id);
});

test('recorded volunteer identity is stable and active clocks cannot switch person or event', async t => {
  const { f, donor } = await setup(t);
  const other = await f.create('constituents', person('Different volunteer'));
  const eventBody = name => ({ name, date: '2026-10-03', location: 'Synthetic Hall', capacity: 10, ticketPrice: 0, sponsorGoal: 0, notes: '' });
  const a = await f.create('events', eventBody('Event A'));
  const b = await f.create('events', eventBody('Event B'));
  const v = await f.create('volunteers', { constituentId: donor.id, eventId: a.id, hours: 0, skills: '', shift: '', notes: '' });
  const started = await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { version: v.version, action: 'in' } });
  assert.equal(started.status, 200);
  const active = started.json.record;
  assert.equal((await f.patch('volunteers', active, { constituentId: other.id })).status, 409);
  assert.equal((await f.patch('volunteers', active, { eventId: b.id })).status, 409);
  const ended = await f.request(`/api/volunteers/${v.id}/clock`, { method: 'POST', session: f.admin, body: { version: active.version, action: 'out' } });
  assert.equal(ended.status, 200);
  const dated = (await f.workspace()).data.volunteerTime.find(entry => entry.volunteerId === v.id);
  assert.equal(dated.eventId, a.id);
  assert.equal((await f.patch('volunteers', ended.json.record, { constituentId: other.id })).status, 409);
  const eventChange = await f.patch('volunteers', ended.json.record, { eventId: b.id });
  assert.equal(eventChange.status, 200, JSON.stringify(eventChange.json));
  assert.equal(sameRecord(await f.workspace(), 'volunteerTime', dated.id).eventId, a.id, 'Historical interval retains its original event');
});

test('a phase-one-shaped database upgrades legacy hours and the old default name exactly once', async t => {
  const { f, donor, fund } = await setup(t);
  const marker = await f.create('gifts', gift(donor, fund, 12345, { externalRef: 'legacy-preserved-gift', giftKind: 'One-time' }));
  const before = await f.workspace();
  const originalHours = new Map(before.data.volunteers.map(v => [v.id, v.hours]));
  // Remove only phase-two data to reconstruct the persisted phase-one state.
  // Business records and access controls remain the real application's records.
  const db = f.app.locals.db;
  db.prepare('DELETE FROM records WHERE collection IN (?, ?, ?)').run('volunteerTime', 'pledges', 'reportViews');
  for (const row of db.prepare('SELECT id, data FROM records WHERE collection=?').all('gifts')) {
    const old = JSON.parse(row.data); delete old.pledgeId;
    db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(old), 'gifts', row.id);
  }
  db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify({ organizationName: 'Foundation CRM · Evaluator pilot', fiscalStartMonth: 7 }));
  const upgraded = await f.restart();
  assert.equal(upgraded.settings.organizationName, 'Jordan Education Foundation');
  assert.equal(upgraded.data.constituents.length, before.data.constituents.length);
  assert.equal(upgraded.data.gifts.length, before.data.gifts.length);
  const retained = sameRecord(upgraded, 'gifts', marker.id);
  assert.equal(retained.amount, 12345);
  assert.equal(retained.externalRef, marker.externalRef);
  assert.equal(retained.status, 'Posted');
  for (const [id, hours] of originalHours) {
    const history = upgraded.data.volunteerTime.filter(entry => entry.volunteerId === id);
    assert.equal(history.length, hours > 0 ? 1 : 0);
    if (hours > 0) {
      assert.equal(history[0].source, 'Historical');
      assert.equal(history[0].hours, hours);
      assert.equal(history[0].startAt, null);
      assert.equal(history[0].endAt, null);
    }
    assert.equal(sameRecord(upgraded, 'volunteers', id).hours, hours);
  }
  const reopened = await f.restart();
  assert.deepEqual(reopened.data.volunteerTime.map(r => r.id).sort(), upgraded.data.volunteerTime.map(r => r.id).sort());
  assert.deepEqual(reopened.data.pledges.map(r => r.id).sort(), upgraded.data.pledges.map(r => r.id).sort());
  assert.equal(reopened.audit.filter(a => a.action === 'upgrade_brand').length, 1);
});
