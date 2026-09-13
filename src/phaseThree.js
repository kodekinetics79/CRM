import { today } from './lib.js';

// Recorded awards are commitments, not income. The as-of date scopes actual receipts.
export function grantReconciliation(grant, gifts = [], asOf = today()) {
  const requested = grant.amount || 0;
  const awarded = grant.awardedAmount || 0;
  const seen = new Set();
  const receipts = gifts.filter(gift => {
    if (!grant.id || gift.grantId !== grant.id || gift.type !== 'Grant' || gift.status === 'Voided' || gift.date > asOf || (grant.funderId && gift.constituentId !== grant.funderId) || seen.has(gift.id)) return false;
    seen.add(gift.id); return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
  const received = receipts.reduce((total, gift) => total + gift.amount, 0);
  return { requested, awarded, received, balance: Math.max(0, awarded - received), awardUnknown: ['Awarded', 'Closed'].includes(grant.stage) && awarded === 0, receiptCount: receipts.length, receipts };
}
