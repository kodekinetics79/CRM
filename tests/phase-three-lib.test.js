import test from 'node:test';
import assert from 'node:assert/strict';
import { grantReconciliation } from '../src/phaseThree.js';

const grant = changes => ({ id: 'grant-A', name: 'Classroom grant', amount: 30001, awardedAmount: 20000, awardDate: '2026-08-01', funderId: 'funder', stage: 'Awarded', ...changes });
const gift = (id, amount, changes = {}) => ({ id, grantId: 'grant-A', constituentId: 'funder', amount, type: 'Grant', method: 'Check', date: '2026-09-13', status: 'Posted', ...changes });

test('requested and awarded values remain distinct and never become received funds', () => {
  const result = grantReconciliation(grant(), [], '2026-09-13');
  assert.equal(result.requested, 30001);
  assert.equal(result.awarded, 20000);
  assert.equal(result.received, 0);
  assert.equal(result.balance, 20000);
  assert.equal(result.receiptCount, 0);
  assert.equal(result.awardUnknown, false);
});

test('grant reconciliation uses explicit posted grant receipts from the correct funder through an inclusive as-of date', () => {
  const gifts = [gift('first', 6001, { date: '2026-08-15' }), gift('boundary', 3999), gift('future', 2000, { date: '2026-09-14' }), gift('void', 4000, { status: 'Voided' }), gift('other-grant', 2000, { grantId: 'grant-B' }), gift('unlinked', 3000, { grantId: null }), gift('named-but-unlinked', 1000, { grantId: null, notes: 'Classroom grant' }), gift('wrong-donor', 1000, { constituentId: 'other', softCreditId: 'funder' }), gift('cash', 2000, { type: 'Cash' }), gift('noncash', 3000, { type: 'In-kind', method: 'In-kind' }), gift('fee', 5000, { type: 'Fee payment' })];
  const result = grantReconciliation(grant(), gifts, '2026-09-13');
  assert.equal(result.requested, 30001);
  assert.equal(result.awarded, 20000);
  assert.equal(result.received, 10000);
  assert.equal(result.balance, 10000);
  assert.equal(result.receiptCount, 2);
  assert.deepEqual(result.receipts.map(r => r.id).sort(), ['boundary', 'first']);
});

test('void reversals and as-of cutoffs reopen the correct grant balance', () => {
  const a = gift('first', 12345, { date: '2026-08-15' });
  const b = gift('last', 7655, { date: '2026-09-13' });
  const fullyReceived = grantReconciliation(grant(), [a, b], '2026-09-13');
  assert.equal(fullyReceived.received, 20000);
  assert.equal(fullyReceived.balance, 0);
  const earlier = grantReconciliation(grant(), [a, b], '2026-08-31');
  assert.equal(earlier.received, 12345);
  assert.equal(earlier.balance, 7655);
  const reversed = grantReconciliation(grant(), [a, { ...b, status: 'Voided' }], '2026-09-13');
  assert.equal(reversed.received, 12345);
  assert.equal(reversed.balance, 7655);
});

test('unknown legacy awards are not inferred from requested values or historical gift descriptions', () => {
  for (const stage of ['Awarded', 'Closed']) {
    const old = grant({ amount: 750000, awardedAmount: 0, awardDate: null, stage });
    const result = grantReconciliation(old, [gift('historic-unlinked', 750000, { grantId: null, notes: 'Historical support for Classroom grant' })], '2026-09-13');
    assert.equal(result.requested, 750000);
    assert.equal(result.awarded, 0);
    assert.equal(result.received, 0);
    assert.equal(result.balance, 0);
    assert.equal(result.awardUnknown, true);
  }
});

test('a verified recorded award is independent of receipt as-of and a missing funder does not invent a donor restriction', () => {
  const recorded = grant({ funderId: null, awardDate: '2026-10-01' });
  const result = grantReconciliation(recorded, [gift('linked', 1001, { constituentId: 'actual-donor', date: '2026-09-13' }), gift('unlinked', 2000, { constituentId: 'actual-donor', grantId: null })], '2026-09-13');
  assert.equal(result.awarded, 20000, 'As-of cutoff applies to receipts, not the recorded award field');
  assert.equal(result.received, 1001);
  assert.equal(result.balance, 18999);
});

test('a duplicated source receipt identifier is counted once in reconciliation', () => {
  const received = gift('same-financial-record', 10001);
  const result = grantReconciliation(grant(), [received, { ...received }], '2026-09-13');
  assert.equal(result.received, 10001);
  assert.equal(result.balance, 9999);
  assert.equal(result.receiptCount, 1);
});

test('grant pipeline labels request separately from the recorded award reconciliation', async()=>{
 const {reportRows}=await import('../src/lib.js');const g=grant({amount:2500000,awardedAmount:1500000,deadline:'2026-10-15',reportDue:null});
 const pipeline=reportRows({gifts:[],grants:[g],constituents:[{id:'funder',name:'Synthetic funder'}]},{report:'Grant pipeline'});
 assert.equal(pipeline.headers.at(-1),'Requested amount');assert.equal(pipeline.rows[0].at(-1),'$25,000.00');
 const reconciled=grantReconciliation(g,[gift('receipt',500000)],'2026-09-13');assert.equal(reconciled.awarded,1500000);assert.equal(reconciled.received,500000);assert.equal(reconciled.balance,1000000);
});
