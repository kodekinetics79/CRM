import { effectiveSchoolYear,fiscalYear, money, nameOf, today } from './lib.js';

const monetary = gift => !['In-kind', 'Fee payment'].includes(gift.type);
const posted = gift => gift.status !== 'Voided';
function selectedGifts(data, config = {}) {
  const { start = '', end = '9999-12-31', type = 'All', schoolYear = 'All', excludeFees = true, fiscalStartMonth = 7 } = config;
  return (data.gifts || []).filter(gift => posted(gift) && gift.date >= start && gift.date <= (end || '9999-12-31') && (type === 'All' || gift.type === type) && (!excludeFees || gift.type !== 'Fee payment') && (schoolYear === 'All' || effectiveSchoolYear(gift, fiscalStartMonth) === schoolYear));
}

// Each installment uses the original day, so a January 31 pledge returns to March 31.
export function pledgeSchedule(pledge, gifts = [], asOf = today()) {
  const [year, month, day] = pledge.startDate.split('-').map(Number);
  const interval = { Monthly: 1, Quarterly: 3, Annual: 12 }[pledge.frequency];
  const base = Math.floor(pledge.amount / pledge.installments);
  const remainder = pledge.amount % pledge.installments;
  const receipts = gifts.filter(gift => gift.pledgeId === pledge.id && gift.constituentId === pledge.constituentId && posted(gift) && monetary(gift) && gift.date <= asOf).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const received = receipts.reduce((total, gift) => total + gift.amount, 0);
  let available = received;
  const rows = Array.from({ length: pledge.installments }, (_, index) => {
    const offset = month - 1 + index * interval;
    const dueYear = year + Math.floor(offset / 12);
    const dueMonth = offset % 12;
    const lastDay = new Date(Date.UTC(dueYear, dueMonth + 1, 0)).getUTCDate();
    const date = `${dueYear}-${String(dueMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
    const amount = base + (index < remainder ? 1 : 0);
    const applied = Math.min(amount, available);
    available -= applied;
    const balance = amount - applied;
    const status = balance === 0 ? 'Received' : pledge.status === 'Cancelled' ? 'Cancelled' : pledge.status === 'Paused' ? 'Paused' : date <= asOf ? 'Overdue' : applied > 0 ? 'Partially received' : 'Scheduled';
    return { date, amount, received: applied, balance, status };
  });
  return { received, balance: Math.max(0, pledge.amount - received), overdue: pledge.status === 'Active' ? rows.filter(row => row.date <= asOf).reduce((total, row) => total + row.balance, 0) : 0, rows };
}

export function recognitionReport(data, config = {}) {
  const constituents = data.constituents || [];
  const gifts = selectedGifts(data, config);
  const definitions = [];
  if (config.report === 'Organization rollup') {
    for (const constituent of constituents) {
      if (!['Business', 'Foundation', 'Community partner'].includes(constituent.type) && !constituents.some(child => child.parentId === constituent.id)) continue;
      const members = new Set([constituent.id]);
      const pending = [constituent.id];
      while (pending.length) {
        const parentId = pending.pop();
        for (const child of constituents) if (child.parentId === parentId && !members.has(child.id)) { members.add(child.id); pending.push(child.id); }
      }
      definitions.push({ id: constituent.id, name: constituent.name, members });
    }
  } else if (config.report === 'Household rollup') {
    const households = new Map();
    for (const constituent of constituents) {
      const household = (constituent.household || '').trim();
      if (!household) continue;
      const group = households.get(household) || { id: household, name: household, members: new Set() };
      group.members.add(constituent.id); households.set(household, group);
    }
    definitions.push(...households.values());
  } else definitions.push(...constituents.map(constituent => ({ id: constituent.id, name: constituent.name, members: new Set([constituent.id]) })));
  const groups = definitions.map(group => {
    const totals = { id: group.id, name: group.name, directMonetary: 0, softMonetary: 0, directNoncash: 0, softNoncash: 0, gifts: 0 };
    const seen = new Set();
    for (const gift of gifts) {
      if (seen.has(gift.id)) continue;
      const direct = group.members.has(gift.constituentId);
      const soft = gift.softCreditId && group.members.has(gift.softCreditId);
      if (!direct && !soft) continue;
      seen.add(gift.id); totals.gifts++;
      const key = `${direct ? 'direct' : 'soft'}${gift.type === 'In-kind' ? 'Noncash' : 'Monetary'}`;
      totals[key] += gift.amount;
    }
    return totals;
  }).filter(group => group.gifts).sort((a, b) => a.name.localeCompare(b.name));
  return {
    headers: ['Recognition group', 'Direct monetary', 'Soft monetary', 'Direct noncash value', 'Soft noncash value', 'Unique gifts'],
    rows: groups.map(group => [group.name, money(group.directMonetary), money(group.softMonetary), money(group.directNoncash), money(group.softNoncash), group.gifts]),
    groups,
  };
}

const timeLabel = timestamp => timestamp ? `${timestamp.slice(0, 10)} ${timestamp.slice(11, 19)}` : 'Undated';
export function volunteerTimeReport(data, config = {}) {
  const { start = '', end = '9999-12-31', schoolYear = 'All', fiscalStartMonth = 7 } = config;
  const entries = data.volunteerTime || [];
  const historical = entries.filter(entry => entry.source === 'Historical' || !entry.startAt);
  const dated = entries.filter(entry => entry.source !== 'Historical' && entry.startAt && entry.startAt.slice(0, 10) >= start && entry.startAt.slice(0, 10) <= (end || '9999-12-31') && (schoolYear === 'All' || fiscalYear(entry.startAt.slice(0, 10), fiscalStartMonth) === schoolYear)).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const datedHours = dated.reduce((total, entry) => total + entry.hours, 0);
  const historicalHours = historical.reduce((total, entry) => total + entry.hours, 0);
  return {
    headers: ['Date', 'Volunteer', 'Event', 'Start (UTC)', 'End (UTC)', 'Hours', 'Source', 'Correction'],
    rows: dated.map(entry => [entry.startAt.slice(0, 10), nameOf(data, 'constituents', entry.constituentId), nameOf(data, 'events', entry.eventId), timeLabel(entry.startAt), timeLabel(entry.endAt), entry.hours.toFixed(2), entry.source, entry.correctionReason || '—']),
    historicalRows: historical.map(entry => [nameOf(data, 'constituents', entry.constituentId), nameOf(data, 'events', entry.eventId), entry.hours.toFixed(2), entry.correctionReason || entry.notes || 'Imported legacy total; date unknown']),
    datedHours, historicalHours, totalHours: datedHours + historicalHours,
  };
}
