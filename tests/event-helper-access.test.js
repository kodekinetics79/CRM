import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { totp } from '../server/mfa.js';
import { backupWorkspace, restoreWorkspace } from '../server/backup.js';

const password = 'SyntheticHelperAcceptance!2026', poison = 'PRIVATE_DONOR_FINANCE_HISTORY_MARKER', mfaKey = '6'.repeat(64);
const keys = value => Object.keys(value).sort();
const eventKeys = ['id', 'name', 'date', 'location', 'version'].sort();
const ticketKeys = ['id', 'attendeeName', 'version', 'checkedIn', 'checkedInAt'].sort();

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wimblo-helper-acceptance-')), dbPath = join(dir, 'tenant.sqlite'), tenantId = randomUUID();
  const initialAdmin = { name: 'Synthetic full administrator', email: 'admin.helper@example.test', password };
  let app, server, base, active = true, time = Date.now();
  async function close() { if (server) await new Promise(resolve => server.close(resolve)); server = null; app?.locals.close(); app = null; }
  async function open(path = dbPath) { app = createApp({ dbPath: path, seed: false, tenantId, initialAdmin, mfaKey, mfaClock: () => time, isTenantActive: () => active }); server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; }
  await open(); t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session, csrf = true } = {}) {
    const response = await fetch(base + '/api' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  }
  async function login(email = initialAdmin.email) {
    const result = await request('/auth/login', { method: 'POST', body: { email, password } }); assert.equal(result.status, 200, result.text);
    return { ...result.json, cookie: result.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  const admin = await login(), users = {};
  for (const [name, role] of [['secondAdmin', 'admin'], ['staff', 'staff'], ['viewer', 'viewer'], ['helper', 'event-helper'], ['otherHelper', 'event-helper']]) {
    const result = await request('/users', { method: 'POST', session: admin, body: { name: 'Synthetic ' + name, email: name.toLowerCase() + '.helper@example.test', password, role } }); assert.equal(result.status, 201, result.text);
    users[name] = await login(name.toLowerCase() + '.helper@example.test');
  }
  async function create(collection, body) { const result = await request('/records/' + collection, { method: 'POST', session: admin, body }); assert.equal(result.status, 201, result.text); return result.json.record; }
  async function workspace() { const result = await request('/workspace', { session: admin }); assert.equal(result.status, 200, result.text); return result.json.data; }
  const attendees = [];
  for (const name of ['Synthetic attendee one', 'Synthetic attendee two', 'Synthetic attendee three']) attendees.push(await create('constituents', { name, type: 'Individual', email: name.replaceAll(' ', '.').toLowerCase() + '@example.test', phone: poison, notes: poison, contacts: [{ name: poison, email: 'private@example.test', role: poison }] }));
  const events = [];
  for (const name of ['Assigned synthetic event', 'Unassigned synthetic event']) {
    const event = await create('events', { name, date: '2026-09-01', location: 'Synthetic venue', capacity: 10, ticketPrice: 10001, sponsorGoal: 99999, notes: poison });
    for (const attendee of attendees) assert.equal((await request('/events/' + event.id + '/register', { method: 'POST', session: admin, body: { constituentId: attendee.id } })).status, 200);
    events.push(event);
  }
  const currentEvent = async id => (await workspace()).events.find(event => event.id === id);
  async function issue(eventId, attendee = attendees[0]) { const result = await request('/event-operations/events/' + eventId + '/tickets', { method: 'POST', session: users.staff, body: { eventVersion: (await currentEvent(eventId)).version, constituentId: attendee.id } }); assert.equal(result.status, 201, result.text); return result.json.ticket; }
  const tickets = []; for (const attendee of attendees) tickets.push(await issue(events[0].id, attendee)); const foreignEventTicket = await issue(events[1].id);
  const tables = () => app.locals.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => Object.fromEntries(tables().filter(name => !['sessions', 'mfa_verification_limits', 'mfa_disable_limits'].includes(name)).map(name => [name, app.locals.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
  async function grant(eventIds, session = users.helper, reason = 'Assigned event-day ticket check-in duty') { const current = await request('/users/' + session.user.id + '/event-access', { session: admin }); assert.equal(current.status, 200, current.text); return request('/users/' + session.user.id + '/event-access', { method: 'PATCH', session: admin, body: { version: current.json.version, eventIds, reason } }); }
  async function assigned() { const result = await grant([events[0].id]); assert.equal(result.status, 200, result.text); users.helper = await login('helper.helper@example.test'); return users.helper; }
  const roster = session => request('/event-checkin/events/' + events[0].id, { session: session || users.helper });
  return { dir, dbPath, tenantId, admin, users, attendees, events, tickets, foreignEventTicket, request, login, create, workspace, currentEvent, issue, grant, assigned, roster, snapshot, tables, close, open, get db() { return app.locals.db; }, set active(value) { active = value; }, get time() { return time; } };
}

test('unassigned helpers have no business visibility and every remaining direct, encoded, unknown or alternate-method API is denied', async t => {
  const f = await fixture(t), before = f.snapshot(), helper = f.users.helper;
  assert.equal(f.db.prepare("SELECT count(*) n FROM users WHERE role='event-helper'").get().n, 2); assert.equal(f.db.prepare("SELECT count(*) n FROM users WHERE role<>'event-helper'").get().n, 4);
  assert.equal((await f.request('/event-checkin/events')).status, 401);
  const empty = await f.request('/event-checkin/events', { session: helper }); assert.equal(empty.status, 200); assert.deepEqual(empty.json.events, []); assert.equal(empty.headers.get('cache-control'), 'no-store');
  const paths = ['/workspace', '/records/constituents', '/records/events/' + f.events[0].id, '/event-operations', '/event-operations/tickets/' + f.tickets[0].id + '/checkin', '/events/' + f.events[0].id + '/register', '/events/' + f.events[0].id + '/checkin', '/users', '/settings', '/identity', '/timeline', '/migration/batches', '/backup', '/intelligence', '/reports', '/custom-reports/catalog', '/report-schedules', '/receipts', '/receipt-profile', '/documents', '/correspondence/templates', '/fundraising', '/grants', '/evaluations', '/completely-unknown', '/%77orkspace', '/%72ecords/constituents', '/event-checkin/unknown', '/event-checkin/events/unknown/extra'];
  for (const path of paths) for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
    const result = await f.request(path, { method, session: helper, ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { body: {} } : {}) }); assert.equal(result.status, 403, method + ' ' + path + ': ' + result.text); assert.ok(!result.text.includes(poison)); assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) for (const path of ['/event-checkin/events', '/event-checkin/events/' + f.events[0].id]) assert.equal((await f.request(path, { method, ...(method === 'HEAD' ? {} : { body: {} }), session: helper })).status, 403);
  assert.equal((await f.request('/event-checkin/events/' + f.events[0].id, { session: helper })).status, 404); assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.request('/auth/me', { session: helper })).json.user.role, 'event-helper'); assert.equal((await f.request('/auth/mfa/status', { session: helper })).status, 200);
  for (const full of [f.admin, f.users.secondAdmin, f.users.staff, f.users.viewer]) assert.equal((await f.request('/workspace', { session: full })).status, 200);
});

test('assigned rosters use exact minimal projections, stable bounded pagination and no poisoned identity or financial history', async t => {
  const f = await fixture(t), helper = await f.assigned(), list = await f.request('/event-checkin/events', { session: helper }); assert.equal(list.status, 200); assert.equal(list.json.events.length, 1); assert.deepEqual(keys(list.json.events[0]), eventKeys); assert.ok(!list.text.includes(poison));
  const seen = [], limit = 1; let after = null;
  do {
    const result = await f.request('/event-checkin/events/' + f.events[0].id + '?limit=' + limit + (after ? '&after=' + after : ''), { session: helper }); assert.equal(result.status, 200, result.text); assert.deepEqual(keys(result.json.event), eventKeys); assert.ok(!result.text.includes(poison)); assert.equal(result.json.tickets.length, 1);
    for (const ticket of result.json.tickets) { assert.deepEqual(keys(ticket), ticketKeys); assert.equal(ticket.checkedIn, false); seen.push(ticket.id); }
    after = result.json.nextCursor;
  } while (after);
  assert.deepEqual(seen, f.tickets.map(ticket => ticket.id).sort()); assert.equal(new Set(seen).size, 3);
  for (const query of ['?limit=0', '?limit=101', '?after=bad', '?unknown=true']) assert.equal((await f.request('/event-checkin/events/' + f.events[0].id + query, { session: helper })).status, 400);
  for (const id of [f.events[1].id, randomUUID()]) { const result = await f.request('/event-checkin/events/' + id, { session: helper }); assert.equal(result.status, 404); assert.ok(!result.text.includes(poison)); assert.ok(!result.text.includes('Unassigned synthetic event')); }
});

test('check-in requires exact scoped identities, CSRF and both versions and changes only native attendance with retained helper actor', async t => {
  const f = await fixture(t), helper = await f.assigned(), roster = await f.roster(), ticket = roster.json.tickets.find(row => row.id === f.tickets[0].id), event = roster.json.event;
  const path = '/event-checkin/events/' + event.id + '/tickets/' + ticket.id + '/checkin', body = { version: ticket.version, eventVersion: event.version };
  for (const [badPath, badBody, csrf, status] of [[path, body, false, 403], [path, { ...body, version: 99 }, true, 409], [path, { ...body, eventVersion: 99 }, true, 409], [path, { ...body, constituentId: f.attendees[1].id }, true, 400], ['/event-checkin/events/' + event.id + '/tickets/' + f.foreignEventTicket.id + '/checkin', body, true, 404], ['/event-checkin/events/' + event.id + '/tickets/' + randomUUID() + '/checkin', body, true, 404], ['/event-checkin/events/' + f.events[1].id + '/tickets/' + ticket.id + '/checkin', body, true, 404]]) {
    const before = f.snapshot(), result = await f.request(badPath, { method: 'POST', session: helper, body: badBody, csrf }); assert.equal(result.status, status, result.text); assert.ok(!result.text.includes(poison)); assert.deepEqual(f.snapshot(), before);
  }
  const before = f.snapshot(), result = await f.request(path, { method: 'POST', session: helper, body }); assert.equal(result.status, 200, result.text); assert.ok(!result.text.includes(poison)); assert.deepEqual(keys(result.json), ['event', 'ticket']); assert.deepEqual(keys(result.json.event), ['id', 'version']); assert.deepEqual(keys(result.json.ticket), ticketKeys); assert.equal(result.json.ticket.checkedIn, true); assert.ok(result.json.ticket.checkedInAt);
  const after = f.snapshot();
  for (const table of f.tables()) if (!['records', 'event_tickets', 'event_ticket_transitions', 'audit', 'sessions'].includes(table)) assert.deepEqual(after[table], before[table], table);
  const changedRecords = after.records.filter((row, index) => row.data !== before.records[index].data); assert.equal(changedRecords.length, 1); assert.equal(changedRecords[0].id, event.id);
  const savedEvent = JSON.parse(changedRecords[0].data); assert.equal(savedEvent.version, event.version + 1); assert.equal(savedEvent.registrations.find(row => row.constituentId === f.attendees[0].id).checkedIn, true); assert.equal(savedEvent.registrations.filter(row => row.checkedIn).length, 1);
  const savedTicket = after.event_tickets.find(row => row.id === ticket.id); assert.equal(savedTicket.version, ticket.version + 1); assert.equal(savedTicket.price, 10001); assert.equal(savedTicket.status, 'Issued'); assert.equal(savedTicket.checked_in_at, result.json.ticket.checkedInAt);
  assert.equal(after.event_ticket_transitions.length, before.event_ticket_transitions.length + 1); assert.equal(JSON.parse(after.event_ticket_transitions.at(-1).actor_json).id, helper.user.id);
  assert.ok(after.audit.slice(before.audit.length).some(row => row.actor === helper.user.id));
  const duplicateBefore = f.snapshot(), duplicate = await f.request(path, { method: 'POST', session: helper, body: { version: savedTicket.version, eventVersion: savedEvent.version } }); assert.equal(duplicate.status, 409); assert.deepEqual(f.snapshot(), duplicateBefore);
});

test('versioned reasoned assignment replacement revokes current sessions and rejects stale, invalid and nonhelper grants atomically', async t => {
  const f = await fixture(t), original = f.users.helper, access = await f.request('/users/' + original.user.id + '/event-access', { session: f.admin }); assert.equal(access.status, 200);
  const path = '/users/' + original.user.id + '/event-access', body = { version: access.json.version, eventIds: [f.events[0].id], reason: 'Explicit event duty grant' };
  for (const bad of [{ ...body, reason: ' ' }, { ...body, eventIds: [f.events[0].id, f.events[0].id] }, { ...body, eventIds: [randomUUID()] }, { ...body, version: 99 }, { ...body, extra: true }]) {
    const before = f.snapshot(), result = await f.request(path, { method: 'PATCH', session: f.admin, body: bad }); assert.ok([400, 404, 409].includes(result.status), result.text); assert.deepEqual(f.snapshot(), before);
  }
  assert.equal((await f.request('/users/' + f.users.staff.user.id + '/event-access', { method: 'PATCH', session: f.admin, body })).status, 409);
  assert.equal((await f.request(path, { method: 'PATCH', session: f.users.staff, body })).status, 403); assert.equal((await f.request(path, { method: 'PATCH', session: f.admin, body, csrf: false })).status, 403);
  const granted = await f.request(path, { method: 'PATCH', session: f.admin, body }); assert.equal(granted.status, 200, granted.text); assert.equal(granted.json.version, access.json.version + 1); assert.deepEqual(granted.json.eventIds, [f.events[0].id]);
  assert.equal((await f.request('/event-checkin/events', { session: original })).status, 401);
  f.users.helper = await f.login('helper.helper@example.test'); assert.equal((await f.roster()).status, 200); const loaded = f.users.helper;
  const revoked = await f.grant([]); assert.equal(revoked.status, 200); assert.equal((await f.roster(loaded)).status, 401); f.users.helper = await f.login('helper.helper@example.test'); assert.deepEqual((await f.request('/event-checkin/events', { session: f.users.helper })).json.events, []); assert.equal((await f.roster()).status, 404);
});

test('cancelled, merged and inconsistent registration records are absent from helper rosters and fail check-in without private reasons', async t => {
  const f = await fixture(t), helper = await f.assigned();
  const cancel = await f.request('/event-operations/tickets/' + f.tickets[0].id + '/cancel', { method: 'POST', session: f.users.staff, body: { version: 1, reason: poison } }); assert.equal(cancel.status, 200, cancel.text);
  // Simulate an inconsistent restored/source record independently of normal guards.
  f.db.prepare("UPDATE records SET data=json_set(data,'$.mergedInto',?) WHERE collection='constituents' AND id=?").run(f.attendees[0].id, f.attendees[1].id);
  const event = await f.currentEvent(f.events[0].id); event.registrations = event.registrations.filter(row => row.constituentId !== f.attendees[2].id);
  f.db.prepare("UPDATE records SET data=? WHERE collection='events' AND id=?").run(JSON.stringify(event), event.id);
  const roster = await f.roster(); assert.equal(roster.status, 200); assert.deepEqual(roster.json.tickets, []); assert.ok(!roster.text.includes(poison));
  for (const [index, ticket] of f.tickets.entries()) {
    const before = f.snapshot(), result = await f.request('/event-checkin/events/' + event.id + '/tickets/' + ticket.id + '/checkin', { method: 'POST', session: helper, body: { version: index === 0 ? 2 : 1, eventVersion: event.version } }); assert.equal(result.status, 409, result.text); assert.ok(!result.text.includes(poison)); assert.match(result.json.error, /Refresh the event roster/); assert.deepEqual(f.snapshot(), before);
  }
});

test('two assigned helpers cannot overwrite a concurrent attendance change and must refresh before a deliberate retry', async t => {
  const f = await fixture(t), helper = await f.assigned(); assert.equal((await f.grant([f.events[0].id], f.users.otherHelper)).status, 200); const second = await f.login('otherhelper.helper@example.test'), roster = await f.roster();
  const before = f.snapshot(), event = roster.json.event;
  const outcomes = await Promise.all([helper, second].map((session, index) => f.request('/event-checkin/events/' + event.id + '/tickets/' + f.tickets[index].id + '/checkin', { method: 'POST', session, body: { version: 1, eventVersion: event.version } })));
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]); assert.equal((await f.currentEvent(event.id)).registrations.filter(row => row.checkedIn).length, 1);
  const loser = outcomes.findIndex(result => result.status === 409), refreshed = await f.roster(loser === 0 ? helper : second), ticket = refreshed.json.tickets.find(row => row.id === f.tickets[loser].id); assert.equal(ticket.checkedIn, false);
  const retried = await f.request('/event-checkin/events/' + event.id + '/tickets/' + ticket.id + '/checkin', { method: 'POST', session: loser === 0 ? helper : second, body: { version: ticket.version, eventVersion: refreshed.json.event.version } }); assert.equal(retried.status, 200); assert.equal((await f.currentEvent(event.id)).registrations.filter(row => row.checkedIn).length, 2);
  const after = f.snapshot(); for (const table of f.tables()) if (!['records', 'event_tickets', 'event_ticket_transitions', 'audit', 'sessions'].includes(table)) assert.deepEqual(after[table], before[table], table);
});

test('helper role changes retire grants permanently and retained assignment history protects event deletion', async t => {
  const f = await fixture(t), helper = await f.assigned(), initial = f.db.prepare('SELECT * FROM users WHERE id=?').get(helper.user.id);
  const promoted = await f.request('/users/' + helper.user.id, { method: 'PATCH', session: f.admin, body: { version: initial.version, role: 'staff', active: true } }); assert.equal(promoted.status, 200); assert.equal((await f.roster(helper)).status, 401);
  assert.equal(f.db.prepare('SELECT active FROM event_helper_assignments WHERE user_id=? AND event_id=?').get(helper.user.id, f.events[0].id).active, 0);
  const demoted = await f.request('/users/' + helper.user.id, { method: 'PATCH', session: f.admin, body: { version: promoted.json.user.version, role: 'event-helper', active: true } }); assert.equal(demoted.status, 200);
  const current = await f.login('helper.helper@example.test'); assert.deepEqual((await f.request('/event-checkin/events', { session: current })).json.events, []);
  const accessHistory = f.db.prepare('SELECT * FROM event_helper_access_changes WHERE user_id=? ORDER BY to_version').all(helper.user.id); assert.equal(accessHistory.length, 2); assert.deepEqual(JSON.parse(accessHistory[1].after_json), []); assert.equal(JSON.parse(accessHistory[1].actor_json).id, f.admin.user.id);
  assert.throws(() => f.db.prepare('DELETE FROM event_helper_access_changes WHERE user_id=?').run(helper.user.id), /retained/);
  assert.throws(() => f.db.prepare('UPDATE event_helper_access_changes SET reason=? WHERE user_id=?').run('Changed', helper.user.id), /immutable/);
  const event = await f.currentEvent(f.events[0].id); assert.equal((await f.request('/records/events/' + event.id, { method: 'DELETE', session: f.admin, body: { version: event.version } })).status, 409);
});

test('native attendance and assignment changes roll back fully when their actor audit cannot persist', async t => {
  const f = await fixture(t), helper = await f.assigned(), roster = await f.roster(), ticket = roster.json.tickets[0];
  f.db.exec("CREATE TRIGGER fail_synthetic_helper_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic helper audit fault'); END");
  let before = f.snapshot(); const result = await f.request('/event-checkin/events/' + f.events[0].id + '/tickets/' + ticket.id + '/checkin', { method: 'POST', session: helper, body: { version: ticket.version, eventVersion: roster.json.event.version } }); assert.equal(result.status, 500); assert.deepEqual(f.snapshot(), before);
  const sessionRows = f.db.prepare('SELECT token_hash,user_id,account_binding FROM sessions ORDER BY token_hash').all(); before = f.snapshot(); const revoke = await f.grant([]); assert.equal(revoke.status, 500); assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.db.prepare('SELECT token_hash,user_id,account_binding FROM sessions ORDER BY token_hash').all(), sessionRows);
  f.db.exec('DROP TRIGGER fail_synthetic_helper_audit'); assert.equal((await f.roster(helper)).status, 200);
});

test('helper own MFA remains usable but scope changes invalidate pending challenges and account or tenant suspension denies old access', async t => {
  const f = await fixture(t), helper = await f.assigned(), enrollment = await f.request('/auth/mfa/enroll', { method: 'POST', session: helper, body: { password } }); assert.equal(enrollment.status, 200, enrollment.text);
  const confirmed = await f.request('/auth/mfa/confirm', { method: 'POST', session: helper, body: { code: totp(enrollment.json.secret, f.time) } }); assert.equal(confirmed.status, 200); assert.ok(confirmed.json.recoveryCodes.length > 0); assert.equal((await f.roster(helper)).status, 401);
  const pending = await f.login('helper.helper@example.test'); assert.equal(pending.mfaRequired, true); assert.equal((await f.grant([])).status, 200);
  const expired = await f.request('/auth/mfa/verify', { method: 'POST', body: { challengeToken: pending.challengeToken, code: confirmed.json.recoveryCodes[0] } }); assert.equal(expired.status, 401);
  const challenge = await f.login('helper.helper@example.test'), verified = await f.request('/auth/mfa/verify', { method: 'POST', body: { challengeToken: challenge.challengeToken, code: confirmed.json.recoveryCodes[0] } }); assert.equal(verified.status, 200, verified.text);
  const fresh = { ...verified.json, cookie: verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }; assert.deepEqual((await f.request('/event-checkin/events', { session: fresh })).json.events, []);
  await f.grant([f.events[0].id], f.users.otherHelper); f.users.otherHelper = await f.login('otherhelper.helper@example.test'); assert.equal((await f.roster(f.users.otherHelper)).status, 200); f.active = false; const suspended = await f.roster(f.users.otherHelper); assert.ok([403, 404].includes(suspended.status), suspended.text); f.active = true;
  const account = f.db.prepare('SELECT version FROM users WHERE id=?').get(f.users.otherHelper.user.id); const disabled = await f.request('/users/' + f.users.otherHelper.user.id, { method: 'PATCH', session: f.admin, body: { version: account.version, role: 'event-helper', active: false } }); assert.equal(disabled.status, 200); assert.equal((await f.roster(f.users.otherHelper)).status, 401);
});

test('tenant-specific cookies and foreign event or ticket identifiers cannot cross helper assignment boundaries', async t => {
  const f = await fixture(t), other = await fixture(t), helper = await f.assigned(), foreign = await other.assigned();
  const before = f.snapshot(); assert.equal((await f.request('/event-checkin/events', { session: foreign })).status, 401);
  for (const path of ['/event-checkin/events/' + other.events[0].id, '/event-checkin/events/' + f.events[0].id + '/tickets/' + other.tickets[0].id + '/checkin']) {
    const result = await f.request(path, { session: helper, ...(path.endsWith('/checkin') ? { method: 'POST', body: { version: 1, eventVersion: (await f.currentEvent(f.events[0].id)).version } } : {}) }); assert.equal(result.status, 404, result.text); assert.ok(!result.text.includes(poison));
  }
  assert.deepEqual(f.snapshot(), before);
});

test('complete native recovery preserves helper grants and retained change history but clears sessions and pending MFA challenges', async t => {
  const f = await fixture(t), helper = await f.assigned(); await f.grant([f.events[1].id], f.users.otherHelper); await f.grant([], f.users.otherHelper);
  const enrollment = await f.request('/auth/mfa/enroll', { method: 'POST', session: helper, body: { password } }); assert.equal(enrollment.status, 200); const confirmed = await f.request('/auth/mfa/confirm', { method: 'POST', session: helper, body: { code: totp(enrollment.json.secret, f.time) } }); assert.equal(confirmed.status, 200); assert.equal((await f.login('helper.helper@example.test')).mfaRequired, true);
  const helperTables = ['event_helper_assignments', 'event_helper_access_changes']; assert.ok(helperTables.every(name => f.tables().includes(name)));
  const originals = Object.fromEntries(helperTables.map(name => [name, f.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]));
  const archivePath = join(f.dir, 'helper.wbackup'), destinationPath = join(f.dir, 'restored.sqlite'), encryptionKey = randomBytes(32).toString('hex');
  const backup = await backupWorkspace({ db: f.db, outputPath: archivePath, tenantId: f.tenantId, encryptionKey }); assert.ok(helperTables.every(name => backup.tables.some(table => table.name === name)));
  const restored = await restoreWorkspace({ archivePath, destinationPath, expectedTenantId: f.tenantId, encryptionKey }); assert.ok(restored.cleared.sessions > 0); assert.equal(restored.cleared.mfaChallenges, 1);
  const copy = new DatabaseSync(destinationPath, { readOnly: true }); try { for (const name of helperTables) assert.deepEqual(copy.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all(), originals[name]); assert.equal(copy.prepare('SELECT count(*) n FROM sessions').get().n, 0); assert.equal(copy.prepare('SELECT count(*) n FROM mfa_challenges').get().n, 0); } finally { copy.close(); }
  await f.close(); await f.open(destinationPath); assert.equal((await f.request('/auth/me', { session: f.admin })).status, 401);
  const admin = await f.login(), access = await f.request('/users/' + helper.user.id + '/event-access', { session: admin }); assert.equal(access.status, 200); assert.deepEqual(access.json.eventIds, [f.events[0].id]);
});
