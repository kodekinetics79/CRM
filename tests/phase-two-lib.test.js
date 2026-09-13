import test from 'node:test';
import assert from 'node:assert/strict';
import { pledgeSchedule, recognitionReport, volunteerTimeReport } from '../src/phaseTwo.js';

const pledge = changes => ({ id: 'pledge-A', name: 'Evaluator commitment', constituentId: 'donor', amount: 10001, startDate: '2024-01-31', installments: 4, frequency: 'Monthly', status: 'Active', ...changes });
const receipt = (id, amount, date, changes = {}) => ({ id, constituentId: 'donor', pledgeId: 'pledge-A', amount, date, type: 'Cash', status: 'Posted', ...changes });

test('monthly pledge dates preserve the original month-end anchor and every cent', () => {
  const result = pledgeSchedule(pledge(), [], '2024-01-30');
  assert.deepEqual(result.rows.map(r => r.date), ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
  assert.deepEqual(result.rows.map(r => r.amount), [2501, 2500, 2500, 2500]);
  assert.equal(result.rows.reduce((n, r) => n + r.amount, 0), 10001);
  assert.equal(result.received, 0);
  assert.equal(result.balance, 10001);
  assert.equal(result.overdue, 0);
  assert.ok(result.rows.every(r => Number.isInteger(r.amount) && Number.isInteger(r.balance)));
});

test('quarterly and annual schedules clamp each date without accumulating February drift', () => {
  assert.deepEqual(pledgeSchedule(pledge({ frequency: 'Quarterly' }), [], '2024-01-01').rows.map(r => r.date), ['2024-01-31', '2024-04-30', '2024-07-31', '2024-10-31']);
  assert.deepEqual(pledgeSchedule(pledge({ frequency: 'Annual', startDate: '2024-02-29' }), [], '2024-01-01').rows.map(r => r.date), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
  assert.deepEqual(pledgeSchedule(pledge({ frequency: 'Monthly', startDate: '2026-12-31', installments: 3, amount: 10 }), [], '2026-12-01').rows.map(r => [r.date, r.amount]), [['2026-12-31', 4], ['2027-01-31', 3], ['2027-02-28', 3]]);
});

test('only valid linked received gifts through the as-of date fulfill oldest installments', () => {
  const gifts = [receipt('later', 5000, '2024-03-02'), receipt('received', 4000, '2024-03-01'), receipt('voided', 7000, '2024-02-01', { status: 'Voided' }), receipt('fee', 3000, '2024-02-01', { type: 'Fee payment' }), receipt('goods', 2000, '2024-02-01', { type: 'In-kind' }), receipt('other', 1000, '2024-02-01', { pledgeId: 'pledge-B' }), receipt('legacy-text-only', 1000, '2024-02-01', { pledgeId: null, pledge: 'Evaluator commitment' })];
  const result = pledgeSchedule(pledge(), gifts, '2024-03-01');
  assert.equal(result.received, 4000);
  assert.equal(result.balance, 6001);
  assert.equal(result.overdue, 1001);
  assert.deepEqual(result.rows.map(r => r.received), [2501, 1499, 0, 0]);
  assert.deepEqual(result.rows.map(r => r.balance), [0, 1001, 2500, 2500]);
  assert.equal(result.rows[0].status, 'Received');
  assert.equal(result.rows[2].status, 'Scheduled');
  assert.equal(result.rows.reduce((n, r) => n + r.received, 0), result.received);
});

test('void reversals reopen balance and paused/cancelled commitments are not overdue', () => {
  const p = pledge({ amount: 12000, installments: 3, startDate: '2026-07-31' });
  const paid = receipt('first', 4000, '2026-07-31');
  const received = pledgeSchedule(p, [paid], '2026-08-31');
  assert.equal(received.balance, 8000);
  assert.equal(received.overdue, 4000);
  const reversed = pledgeSchedule(p, [{ ...paid, status: 'Voided' }], '2026-08-31');
  assert.equal(reversed.balance, 12000);
  assert.equal(reversed.overdue, 8000);
  for (const status of ['Paused', 'Cancelled']) {
    const schedule = pledgeSchedule({ ...p, status }, [paid], '2026-09-30');
    assert.equal(schedule.received, 4000);
    assert.equal(schedule.balance, 8000);
    assert.equal(schedule.overdue, 0);
  }
});

const c = (id, name, type = 'Individual', parentId = null, household = '') => ({ id, name, type, parentId, household, email: `${id}@example.test` });
const g = (id, constituentId, amount, type = 'Cash', softCreditId = null, changes = {}) => ({ id, constituentId, amount, type, softCreditId, status: 'Posted', date: '2026-09-13', ...changes });
const recognitionData = () => ({
  constituents: [c('root', 'Parent company', 'Business', null, 'Town partners'), c('sub', 'Subsidiary', 'Business', 'root', 'Town partners'), c('leaf', 'Employee donor', 'Individual', 'sub', 'Smith household'), c('influencer', 'Volunteer donor', 'Individual', null, 'Smith household'), c('other', 'Other foundation', 'Foundation', null, 'Town partners')],
  gifts: [g('direct-and-soft', 'sub', 10000, 'Cash', 'root'), g('goods', 'leaf', 5000, 'In-kind', 'root'), g('cash', 'leaf', 20000, 'Cash', 'other'), g('influence', 'influencer', 3000, 'Cash', 'leaf'), g('void', 'sub', 90000, 'Cash', null, { status: 'Voided' }), g('fee', 'sub', 800, 'Fee payment'), g('after', 'leaf', 700, 'Cash', null, { date: '2026-09-16' }), g('before', 'leaf', 600, 'Cash', null, { date: '2026-06-30' })],
});
const config = report => ({ report, start: '2026-07-01', end: '2026-09-15', type: 'All', schoolYear: '2026–2027', excludeFees: true, fiscalStartMonth: 7 });
const group = (report, id) => {
  const result = report.groups.find(r => r.id === id);
  assert.ok(result, `Missing recognition group ${id}`);
  return result;
};

test('organization recognition traverses descendants and counts direct/soft overlaps once per group', () => {
  const result = recognitionReport(recognitionData(), config('Organization rollup'));
  const parent = group(result, 'root');
  assert.equal(parent.directMonetary, 30000);
  assert.equal(parent.softMonetary, 3000);
  assert.equal(parent.directNoncash, 5000);
  assert.equal(parent.softNoncash, 0);
  assert.equal(parent.gifts, 4);
  const subsidiary = group(result, 'sub');
  assert.equal(subsidiary.directMonetary, 30000);
  assert.equal(subsidiary.gifts, 4);
  assert.equal(group(result, 'other').softMonetary, 20000);
  assert.ok(!JSON.stringify(result.rows).includes('$900.00'));
});

test('household recognition trims labels and separates monetary/noncash without counting a shared gift twice', () => {
  const data = recognitionData();
  data.constituents.find(r => r.id === 'leaf').household = ' Smith household ';
  const result = recognitionReport(data, config('Household rollup'));
  const smith = result.groups.find(r => r.name === 'Smith household');
  assert.ok(smith);
  assert.equal(smith.directMonetary, 23000);
  assert.equal(smith.softMonetary, 0);
  assert.equal(smith.directNoncash, 5000);
  assert.equal(smith.gifts, 3);
  const town = result.groups.find(r => r.name === 'Town partners');
  assert.equal(town.directMonetary, 10000);
  assert.equal(town.softMonetary, 20000);
  assert.equal(town.softNoncash, 5000);
  assert.equal(town.gifts, 3);
});

test('soft-credit recognition retains donor identity and does not turn influence into cash received', () => {
  const result = recognitionReport(recognitionData(), config('Soft-credit recognition'));
  assert.equal(group(result, 'root').directMonetary, 0);
  assert.equal(group(result, 'root').softMonetary, 10000);
  assert.equal(group(result, 'root').softNoncash, 5000);
  assert.equal(group(result, 'leaf').directMonetary, 20000);
  assert.equal(group(result, 'leaf').softMonetary, 3000);
  assert.equal(result.groups.reduce((n, r) => n + r.directMonetary, 0), 33000);
  const self = { constituents: [c('self', 'Self credit')], gifts: [g('same-person', 'self', 101, 'Cash', 'self')] };
  const counted = group(recognitionReport(self, config('Soft-credit recognition')), 'self');
  assert.equal(counted.directMonetary, 101);
  assert.equal(counted.softMonetary, 0);
  assert.equal(counted.gifts, 1);
});

test('recognition revenue and fiscal filters are shared and corrupted hierarchy cycles terminate', () => {
  const data = recognitionData();
  const inkind = recognitionReport(data, { ...config('Organization rollup'), type: 'In-kind' });
  assert.equal(group(inkind, 'root').directMonetary, 0);
  assert.equal(group(inkind, 'root').directNoncash, 5000);
  assert.equal(group(inkind, 'root').gifts, 1);
  const earlierYear = recognitionReport(data, { ...config('Organization rollup'), start: '', end: '', schoolYear: '2025–2026' });
  assert.equal(group(earlierYear, 'root').directMonetary, 600);
  const january = recognitionReport(data, { ...config('Organization rollup'), schoolYear: '2026', fiscalStartMonth: 1 });
  assert.equal(group(january, 'root').directMonetary, 30000);
  data.constituents.find(r => r.id === 'root').parentId = 'sub';
  const cyclic = recognitionReport(data, config('Organization rollup'));
  assert.equal(group(cyclic, 'root').directMonetary, 30000);
  assert.equal(group(cyclic, 'root').gifts, 4);
});

const timeData = () => ({
  constituents: [c('volunteer', 'Evaluator volunteer')],
  volunteers: [{ id: 'vol-record', constituentId: 'volunteer', shift: 'Setup', hours: 14 }],
  events: [{ id: 'benefit', name: 'School benefit' }],
  volunteerTime: [
    { id: 'historical', volunteerId: 'vol-record', constituentId: 'volunteer', eventId: null, startAt: null, endAt: null, hours: 8, source: 'Historical', notes: '' },
    { id: 'boundary', volunteerId: 'vol-record', constituentId: 'volunteer', eventId: 'benefit', startAt: '2026-06-30T23:30:00Z', endAt: '2026-07-01T00:00:00Z', hours: 0.5, source: 'Clock', notes: '' },
    { id: 'corrected', volunteerId: 'vol-record', constituentId: 'volunteer', eventId: 'benefit', startAt: '2026-07-01T10:00:00Z', endAt: '2026-07-01T12:00:00Z', hours: 1.5, originalHours: 2, correctionReason: 'Supervisor adjustment', source: 'Clock', notes: '' },
    { id: 'after', volunteerId: 'vol-record', constituentId: 'volunteer', eventId: null, startAt: '2026-08-01T10:00:00Z', endAt: '2026-08-01T14:00:00Z', hours: 4, source: 'Clock', notes: '' },
  ],
});

test('dated volunteer filters use recorded dates and corrections while keeping history separately undated', () => {
  const result = volunteerTimeReport(timeData(), { start: '2026-07-01', end: '2026-07-31', schoolYear: '2026–2027', fiscalStartMonth: 7 });
  assert.equal(result.datedHours, 1.5);
  assert.equal(result.historicalHours, 8);
  assert.equal(result.totalHours, 9.5);
  assert.equal(result.rows.length, 1);
  assert.equal(result.historicalRows.length, 1);
  assert.ok(JSON.stringify(result.rows).includes('2026-07-01'));
  assert.ok(!JSON.stringify(result.historicalRows).includes('2026-07-01'));
  assert.equal(timeData().volunteerTime.find(r => r.id === 'corrected').originalHours, 2);
});

test('volunteer fiscal-boundary and no-match reports never assign dates to historical totals', () => {
  const data = timeData();
  const previous = volunteerTimeReport(data, { start: '', end: '', schoolYear: '2025–2026', fiscalStartMonth: 7 });
  assert.equal(previous.datedHours, 0.5);
  assert.equal(previous.historicalHours, 8);
  const calendar = volunteerTimeReport(data, { start: '', end: '', schoolYear: '2026', fiscalStartMonth: 1 });
  assert.equal(calendar.datedHours, 6);
  assert.equal(calendar.totalHours, 14);
  const future = volunteerTimeReport(data, { start: '2030-01-01', end: '2030-12-31', schoolYear: 'All', fiscalStartMonth: 7 });
  assert.equal(future.datedHours, 0);
  assert.equal(future.historicalHours, 8);
  assert.equal(future.rows.length, 0);
});
