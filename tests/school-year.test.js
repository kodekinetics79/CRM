import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { effectiveSchoolYear, reportRows, toCSV } from '../src/lib.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-school-year-'));
  const dbPath = join(dir, 'business.sqlite');
  let app, server, base;
  async function open() {
    app = createApp({ dbPath, seed: true }); server = app.listen(0, '127.0.0.1');
    await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() { await new Promise(resolve => server.close(resolve)); app.locals.close(); }
  await open();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers.Cookie = session.cookie;
    if (session && csrf) headers['X-CSRF-Token'] = session.csrfToken;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function login(email = 'alex@foundation.example') {
    const response = await request('/api/auth/login', { method: 'POST', body: { email, password: 'FoundationDemo!2026' } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return { ...response.json, cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const admin = await login();
  async function workspace() {
    const r = await request('/api/workspace', { session: admin }); assert.equal(r.status, 200); return r.json;
  }
  const data = (await workspace()).data;
  const giftBody = { constituentId: data.constituents[0].id, amount: 12345, type: 'Cash', method: 'Check', date: '2026-07-01', campaignId: null, allocations: [{ designationId: data.designations[0].id, amount: 12345 }], externalRef: '', notes: '', tribute: '', softCreditId: null, pledge: '', giftKind: 'One-time' };
  const r = await request('/api/records/gifts', { method: 'POST', session: admin, body: giftBody });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const gift = r.json.record;
  async function assign(body, options = {}) { return request(`/api/gifts/${gift.id}/school-year`, { method: 'POST', session: admin, body, ...options }); }
  async function current() { return (await workspace()).data.gifts.find(g => g.id === gift.id); }
  function audits() { return app.locals.db.prepare("SELECT * FROM audit WHERE record_id=? AND action IN ('reassign_school_year','reset_school_year','reformat_school_year') ORDER BY id").all(gift.id).map(a => ({ ...a, details: JSON.parse(a.details) })); }
  async function settings(month, session = admin) { return request('/api/settings', { method: 'PATCH', session, body: { organizationName: 'Wimblo', fiscalStartMonth: month } }); }
  return { request, login, admin, workspace, gift, giftBody, assign, current, audits, settings, restart: async () => { await close(); await open(); } };
}

test('authorized assignment is audited and preserves monetary and transaction facts', async t => {
  const f = await fixture(t), staff = await f.login('staff@foundation.example');
  const r = await f.assign({ version: 1, schoolYear: '2025-2026', reason: 'Approved school-year correction' }, { session: staff });
  assert.equal(r.status, 200); const next = r.json.record;
  assert.equal(next.schoolYear, '2025–2026'); assert.equal(next.schoolYearOverride, '2025–2026'); assert.equal(next.version, 2);
  for (const key of ['amount', 'allocations', 'date', 'constituentId', 'type', 'method', 'status']) assert.deepEqual(next[key], f.gift[key], key);
  assert.equal(next.schoolYearAssignment.actorId, staff.user.id); assert.equal(next.schoolYearAssignment.reason, 'Approved school-year correction');
  const [audit] = f.audits(); assert.equal(audit.actor, staff.user.id); assert.equal(audit.action, 'reassign_school_year');
  assert.equal(audit.details.previousSchoolYear, '2026–2027'); assert.equal(audit.details.schoolYear, '2025–2026'); assert.equal(audit.details.reason, next.schoolYearAssignment.reason);
  assert.ok(audit.at); assert.equal(audit.collection, 'gifts');
});

test('invalid, unauthorized and stale assignments leave record and audit unchanged', async t => {
  const f = await fixture(t), viewer = await f.login('board@foundation.example');
  const good = { version: 1, schoolYear: '2025–2026', reason: 'Correction' };
  assert.equal((await f.assign(good, { session: undefined })).status, 401);
  assert.equal((await f.assign(good, { session: viewer })).status, 403);
  assert.equal((await f.assign(good, { csrf: false })).status, 403);
  assert.equal((await f.assign({ ...good, version: 99 })).status, 409);
  for (const schoolYear of ['2025', '2025–2027', '25–26', '2025/2026', '9999–10000', 'bad']) assert.equal((await f.assign({ ...good, schoolYear })).status, 400, schoolYear);
  for (const body of [{ ...good, reason: ' ' }, { ...good, injected: true }, { ...good, version: 0 }, { ...good, schoolYear: undefined }]) assert.equal((await f.assign(body)).status, 400);
  assert.deepEqual(await f.current(), f.gift); assert.deepEqual(f.audits(), []);
  assert.equal((await f.assign(good)).status, 200);
  const before = await f.current(), history = f.audits();
  assert.equal((await f.assign({ ...good, schoolYear: null })).status, 409);
  assert.deepEqual(await f.current(), before); assert.deepEqual(f.audits(), history);
});

test('protected assignment fields cannot bypass the dedicated endpoint', async t => {
  const f = await fixture(t);
  for (const field of ['schoolYear', 'schoolYearOverride', 'schoolYearAssignment']) {
    const value = field === 'schoolYearAssignment' ? { reason: 'Forged', actorId: 'forged' } : '2020–2021';
    assert.equal((await f.request('/api/records/gifts', { method: 'POST', session: f.admin, body: { ...f.giftBody, [field]: value } })).status, 400, field);
    assert.equal((await f.request(`/api/records/gifts/${f.gift.id}`, { method: 'PATCH', session: f.admin, body: { version: 1, [field]: value } })).status, 400, field);
  }
  assert.deepEqual(await f.current(), f.gift); assert.deepEqual(f.audits(), []);
});

test('date edits retain assignment; explicit reset restores the date-derived year', async t => {
  const f = await fixture(t);
  assert.equal((await f.assign({ version: 1, schoolYear: '2024–2025', reason: 'Finance reassignment' })).status, 200);
  const edited = await f.request(`/api/records/gifts/${f.gift.id}`, { method: 'PATCH', session: f.admin, body: { version: 2, date: '2027-08-01', notes: 'Updated transaction date' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json)); assert.equal(edited.json.record.schoolYear, '2024–2025'); assert.equal(edited.json.record.version, 3);
  const reset = await f.assign({ version: 3, schoolYear: null, reason: 'Use the corrected transaction date' });
  assert.equal(reset.status, 200); assert.equal(reset.json.record.schoolYear, '2027–2028'); assert.equal(reset.json.record.schoolYearOverride, null); assert.equal(reset.json.record.version, 4);
  const audit = f.audits().at(-1); assert.equal(audit.action, 'reset_school_year'); assert.equal(audit.details.previousOverride, '2024–2025'); assert.equal(audit.details.reason, 'Use the corrected transaction date');
});

test('fiscal settings preserve assigned start-year anchor with audited canonical reformats', async t => {
  const f = await fixture(t), staff = await f.login('staff@foundation.example');
  assert.equal((await f.assign({ version: 1, schoolYear: '2025–2026', reason: 'Retain finance reporting year' })).status, 200);
  const provenance = (await f.current()).schoolYearAssignment;
  assert.equal((await f.settings(1, staff)).status, 403);
  assert.equal((await f.settings(9)).status, 200); assert.equal((await f.current()).schoolYear, '2025–2026');
  assert.equal((await f.settings(1)).status, 200); let gift = await f.current(); assert.equal(gift.schoolYearOverride, '2025'); assert.equal(gift.schoolYear, '2025');
  assert.deepEqual(gift.schoolYearAssignment, provenance); assert.equal(f.audits().at(-1).action, 'reformat_school_year'); assert.equal(f.audits().at(-1).details.previousOverride, '2025–2026');
  assert.equal((await f.assign({ version: gift.version, schoolYear: '2024–2025', reason: 'Invalid calendar format' })).status, 400);
  assert.equal((await f.settings(7)).status, 200); gift = await f.current(); assert.equal(gift.schoolYear, '2025–2026'); assert.equal(gift.schoolYearOverride, '2025–2026'); assert.deepEqual(gift.schoolYearAssignment, provenance);
  assert.equal(f.audits().filter(a => a.action === 'reformat_school_year').length, 2);
  assert.equal((await f.settings(1)).status, 200); gift = await f.current();
  const assigned = await f.assign({ version: gift.version, schoolYear: '2024', reason: 'Calendar-year correction' }); assert.equal(assigned.status, 200); assert.equal(assigned.json.record.schoolYear, '2024');
});

test('assignment, history and session persist through restart; voided gifts stay locked', async t => {
  const f = await fixture(t);
  assert.equal((await f.assign({ version: 1, schoolYear: '2025–2026', reason: 'Persistent correction' })).status, 200);
  const before = await f.current(), history = f.audits(); await f.restart();
  assert.deepEqual(await f.current(), before); assert.deepEqual(f.audits(), history);
  const voided = await f.request(`/api/gifts/${f.gift.id}/void`, { method: 'POST', session: f.admin, body: { version: 2, reason: 'Duplicate transaction' } }); assert.equal(voided.status, 200);
  assert.equal((await f.assign({ version: 3, schoolYear: null, reason: 'Cannot rewrite voided history' })).status, 409);
  assert.deepEqual(await f.current(), voided.json.record); assert.deepEqual(f.audits(), history);
});

test('reports select assigned years while date filters and cash totals retain transaction semantics', async t => {
  const f = await fixture(t); await f.assign({ version: 1, schoolYear: '2025–2026', reason: 'Reporting correction' });
  const gift = await f.current(), original = f.gift, workspace = await f.workspace();
  const data = { ...workspace.data, gifts: [gift] };
  const ledger = reportRows(data, { report: 'Gift ledger', schoolYear: '2025–2026' });
  assert.equal(ledger.rows.length, 1); assert.equal(ledger.rows[0][0], '2026-07-01'); assert.equal(ledger.rows[0][3], '2025–2026'); assert.equal(ledger.rows[0][5], '$123.45');
  assert.match(toCSV(ledger.headers, ledger.rows), /2025–2026/);
  assert.equal(reportRows(data, { report: 'Gift ledger', schoolYear: '2026–2027' }).rows.length, 0);
  assert.equal(reportRows(data, { report: 'Gift ledger', schoolYear: '2025–2026', end: '2026-06-30' }).rows.length, 0);
  assert.equal(reportRows(data, { report: 'Gifts by designation', schoolYear: '2025–2026' }).rows[0][3], '$123.45');
  assert.equal(reportRows(data, { report: 'Contributions by donor', schoolYear: '2025–2026' }).rows[0][3], '$123.45');
  assert.deepEqual(reportRows(data, { report: 'Contributions by donor' }), reportRows({ ...data, gifts: [original] }, { report: 'Contributions by donor' }));
  await f.assign({ version: 2, schoolYear: null, reason: 'Restore derived reporting' });
  assert.equal(reportRows({ ...data, gifts: [await f.current()] }, { report: 'Gift ledger', schoolYear: '2026–2027' }).rows.length, 1);
});

test('effective year supports legacy date-derived gifts and configured fiscal formats', () => {
  assert.equal(effectiveSchoolYear({ date: '2026-07-01', schoolYear: 'stale stored value' }, 9), '2025–2026');
  assert.equal(effectiveSchoolYear({ date: '2026-07-01', schoolYearOverride: null }, 7), '2026–2027');
  assert.equal(effectiveSchoolYear({ date: '2026-07-01', schoolYearOverride: '2024–2025' }, 1), '2024');
  assert.equal(effectiveSchoolYear({ date: '2026-07-01', schoolYearOverride: '2024' }, 7), '2024–2025');
});
