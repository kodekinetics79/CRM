import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, fiscalYear, postedGifts, contributedGifts, reportRows, toCSV, parseCSV, today } from '../src/lib.js';

const donor = (id, name) => ({ id, name, email: `${id}@example.test`, preference: 'Email' });
const gift = (id, constituentId, amount, date, type = 'Cash', status = 'Posted', allocations = [{ designationId: 'school', amount }]) => ({ id, constituentId, amount, date, type, status, allocations });
const data = gifts => ({ gifts, constituents: [donor('old', 'Existing donor'), donor('new', 'New donor')], designations: [{ id: 'district', name: 'District', parentId: null }, { id: 'school', name: 'School fund', parentId: 'district' }, { id: 'classroom', name: 'Classroom fund', parentId: 'school' }], volunteers: [], grants: [], communications: [] });

test('currency input converts exact decimal dollars to safe cents and rejects ambiguity', () => {
  for (const [value, expected] of [['0', 0], ['0.01', 1], ['0.10', 10], ['1.1', 110], ['19.99', 1999], [' 1234.56 ', 123456], ['90071992547409.91', Number.MAX_SAFE_INTEGER]]) assert.equal(cents(value), expected, value);
  for (const value of ['1.001', '-1', '+1', '1e3', 'NaN', 'Infinity', '', '1,000.00', '$10', '90071992547409.92']) assert.throws(() => cents(value), undefined, value);
});

test('school year changes exactly at configured fiscal month boundaries', () => {
  assert.equal(fiscalYear('2026-06-30'), '2025–2026');
  assert.equal(fiscalYear('2026-07-01'), '2026–2027');
  assert.equal(fiscalYear('2027-06-30'), '2026–2027');
  assert.equal(fiscalYear('2027-07-01'), '2027–2028');
  assert.equal(fiscalYear('2026-08-31', 9), '2025–2026');
  assert.equal(fiscalYear('2026-09-01', 9), '2026–2027');
  assert.equal(fiscalYear('2026-12-31', 1), '2026');
  assert.equal(fiscalYear('2027-01-01', 1), '2027');
});

test('contributed income excludes void, fee and in-kind while posted valuation retains in-kind', () => {
  const gifts = [gift('cash', 'old', 10001, '2026-09-01'), gift('fee', 'old', 2500, '2026-09-02', 'Fee payment'), gift('goods', 'new', 7500, '2026-09-03', 'In-kind'), gift('void', 'old', 99999, '2026-09-04', 'Cash', 'Voided'), gift('grant', 'new', 20000, '2026-09-05', 'Grant')];
  assert.deepEqual(postedGifts(gifts).map(g => g.id), ['cash', 'fee', 'goods', 'grant']);
  assert.deepEqual(contributedGifts(gifts).map(g => g.id), ['cash', 'grant']);
  assert.equal(contributedGifts(gifts).reduce((total, g) => total + g.amount, 0), 30001);
});

test('ledger filters inclusive date boundaries, voids, fees and configured school year', () => {
  const d = data([gift('before', 'old', 100, '2026-06-30'), gift('start', 'old', 101, '2026-07-01'), gift('end', 'new', 202, '2026-09-13'), gift('after', 'new', 400, '2026-09-14'), gift('void', 'old', 10000, '2026-08-01', 'Cash', 'Voided'), gift('fee', 'old', 500, '2026-08-02', 'Fee payment'), gift('inkind', 'new', 750, '2026-08-03', 'In-kind')]);
  const config = { report: 'Gift ledger', start: '2026-07-01', end: '2026-09-13', schoolYear: '2026–2027', excludeFees: true };
  const result = reportRows(d, config);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map(r => [r[0], r[2], r[5]]), [['2026-09-13', 'Cash', '$2.02'], ['2026-08-03', 'In-kind', '$7.50'], ['2026-07-01', 'Cash', '$1.01']]);
  assert.equal(reportRows(d, { ...config, excludeFees: false }).rows.length, 4);
  assert.equal(reportRows(d, { ...config, fiscalStartMonth: 9 }).rows.length, 1);
});

test('designation reports aggregate split cents under full hierarchy and keep revenue types distinct', () => {
  const d = data([
    gift('split', 'old', 101, '2026-09-01', 'Cash', 'Posted', [{ designationId: 'school', amount: 33 }, { designationId: 'classroom', amount: 68 }]),
    gift('cash', 'new', 32, '2026-09-02', 'Cash', 'Posted', [{ designationId: 'school', amount: 32 }]),
    gift('inkind', 'new', 500, '2026-09-03', 'In-kind', 'Posted', [{ designationId: 'school', amount: 500 }]),
    gift('void', 'new', 10000, '2026-09-04', 'Cash', 'Voided'),
  ]);
  const rows = reportRows(d, { report: 'Gifts by designation' }).rows;
  assert.deepEqual(rows, [
    ['District / School fund', 'In-kind', 1, '$5.00'],
    ['District / School fund / Classroom fund', 'Cash', 1, '$0.68'],
    ['District / School fund', 'Cash', 2, '$0.65'],
  ]);
  assert.equal(rows.reduce((total, r) => total + cents(r[3].slice(1)), 0), 633);
});

test('first donor date uses full history, not just selected dates, and ignores voids and fees', () => {
  const d = data([
    gift('old-current', 'old', 20000, '2026-09-10'),
    gift('new-current', 'new', 10100, '2026-09-05'),
    gift('old-historical', 'old', 1000, '2024-01-03'),
    gift('void-new', 'new', 500, '2023-01-01', 'Cash', 'Voided'),
    gift('fee-new', 'new', 800, '2025-01-01', 'Fee payment'),
    gift('new-second', 'new', 2500, '2026-09-11'),
  ]);
  const config = { start: '2026-09-01', end: '2026-09-30' };
  const first = reportRows(d, { ...config, report: 'First-time donors' });
  assert.deepEqual(first.rows, [['New donor', 'new@example.test', '2026-09-05', 2, '$126.00']]);
  const existing = reportRows(d, { ...config, report: 'Contributions by donor' }).rows.find(r => r[0] === 'Existing donor');
  assert.deepEqual(existing, ['Existing donor', 'old@example.test', 1, '$200.00', '2024-01-03', '2026-09-10']);
});

test('CSV round-trips quoted commas, embedded quotes, newlines, empty cells and BOM', () => {
  const csv = toCSV(['name', 'notes', 'empty'], [['Smith, Avery', 'Said "hello"\nSecond line', null]]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.deepEqual(parseCSV(csv), [{ name: 'Smith, Avery', notes: 'Said "hello"\nSecond line', empty: '' }]);
  assert.deepEqual(parseCSV('\uFEFFname,amount\r\n"Avery, Smith",19.99\r\n\r\n'), [{ name: 'Avery, Smith', amount: '19.99' }]);
  assert.match(csv, /Said ""hello""/);
});

test('CSV export neutralizes spreadsheet formulas without losing the text', () => {
  const values = ['=SUM(A1:A2)', '+HYPERLINK("https://example.test")', '@SUM(1)', '-2+3', '\t=1', '\r=2'];
  const rows = parseCSV(toCSV(['value'], values.map(value => [value])));
  assert.deepEqual(rows.map(row => row.value), values.map(value => "'" + value));
});

test('CSV import rejects malformed quoting, duplicate headers and wrong row widths', () => {
  for (const csv of ['name,amount\n"Unclosed,10', 'name,name\nA,10', 'name,amount\nA', 'name,amount\nA,10,extra', 'name,amount\nUnquoted"quote,10', 'name,amount\n"A"trailing,10', 'name,amount\n"A""trailing,10', 'name,amount\n']) assert.throws(() => parseCSV(csv), undefined, csv);
});

test('follow-up includes recent donors with no recent contact and identifies why', () => {
  const d = data([gift('recent', 'old', 1000, today()), gift('older', 'new', 1000, '2020-01-01')]);
  d.constituents.push({ ...donor('optout', 'Opted-out donor'), preference: 'Do not contact' });
  d.communications = [{ constituentId: 'new', status: 'Logged', date: today() }];
  const result = reportRows(d, { report: 'Donor follow-up', inactiveDays: 90 });
  assert.deepEqual(result.headers.at(-1), 'Follow-up reason');
  const recent = result.rows.find(row => row[0] === 'Existing donor');
  assert.ok(recent, 'A recent gift does not eliminate the need for contact');
  assert.equal(recent.at(-1), 'No recent contact');
  const contacted = result.rows.find(row => row[0] === 'New donor');
  assert.ok(contacted, 'A recent contact does not eliminate an inactive gift history');
  assert.equal(contacted.at(-1), 'No recent gift');
  assert.ok(!result.rows.some(row => row[0] === 'Opted-out donor'));
});
