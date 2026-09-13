export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
export const dateLabel = value => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value.length === 10 ? value + 'T12:00:00Z' : value)) : '—';
export function cents(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Enter an amount with no more than two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('This amount is too large.');
  return amount;
}
export function fiscalYear(date, startMonth = 7) {
  const [y, m] = date.split('-').map(Number);
  if (startMonth === 1) return String(y);
  const start = m >= startMonth ? y : y - 1;
  return `${start}–${start + 1}`;
}
export function effectiveSchoolYear(gift, startMonth = 7) {
  const override = gift.schoolYearOverride;
  if (typeof override === 'string' && /^\d{4}(?:[–-]\d{4})?$/.test(override)) {
    const start = Number(override.slice(0, 4));
    return startMonth === 1 ? String(start).padStart(4, '0') : `${String(start).padStart(4, '0')}–${String(start + 1).padStart(4, '0')}`;
  }
  return fiscalYear(gift.date, startMonth);
}
export const postedGifts = gifts => gifts.filter(g => g.status !== 'Voided');
export const contributedGifts = gifts => postedGifts(gifts).filter(g => !['Fee payment', 'In-kind'].includes(g.type));
export const sum = (rows, key = 'amount') => rows.reduce((n, row) => n + (Number(row[key]) || 0), 0);
export const byId = (data, collection, id) => data[collection]?.find(r => r.id === id);
export const nameOf = (data, collection, id) => (byId(data, collection, id)||(collection==='constituents'?data.retainedConstituents?.find(r=>r.id===id):null))?.name || (id ? 'Unavailable record' : '—');
export const match = (row, query) => !query || JSON.stringify(row).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
export function designationPath(data, id) {
  const names = []; const seen = new Set(); let record = byId(data, 'designations', id);
  while (record && !seen.has(record.id)) { seen.add(record.id); names.unshift(record.name); record = byId(data, 'designations', record.parentId); }
  return names.join(' / ');
}
export function download(name, content, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function toCSV(headers, rows) {
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (!quoted && cell.length) throw new Error('Unexpected quote in CSV. Use a quoted field for text containing commas.');
      else { quoted = !quoted; closedQuote = !quoted; }
    } else if (c === ',' && !quoted) { row.push(cell); cell = ''; closedQuote = false; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(v => v.trim())) rows.push(row); row = []; cell = ''; closedQuote = false;
    } else { if (closedQuote && !quoted) throw new Error('Unexpected text after a quoted CSV field.'); cell += c; }
  }
  if (quoted) throw new Error('A quoted CSV field is not closed.');
  row.push(cell); if (row.some(v => v.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('Include a header row and at least one gift.');
  const headers = rows.shift().map(h => h.trim());
  if (new Set(headers).size !== headers.length) throw new Error('Each CSV header must be unique.');
  return rows.map((values, i) => {
    if (values.length !== headers.length) throw new Error(`Row ${i + 2} has ${values.length} columns; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((key, n) => [key, values[n].trim()]));
  });
}
export function reportRows(data, config) {
  const { start = '', end = '9999-12-31', type = 'All', schoolYear = 'All', report = 'Contributions by donor', excludeFees = true, inactiveDays = 90, fiscalStartMonth = 7 } = config;
  const allPosted = postedGifts(data.gifts);
  const gifts = allPosted.filter(g => g.date >= start && g.date <= end && (type === 'All' || g.type === type) && (!excludeFees || g.type !== 'Fee payment') && (schoolYear === 'All' || effectiveSchoolYear(g, fiscalStartMonth) === schoolYear));
  if (report === 'Gifts by designation') {
    const grouped = new Map();
    for (const gift of gifts) for (const a of gift.allocations) {
      const key = `${a.designationId}|${gift.type}`;
      const row = grouped.get(key) || { designation: designationPath(data, a.designationId), type: gift.type, count: 0, amount: 0 };
      row.count++; row.amount += a.amount; grouped.set(key, row);
    }
    return { headers: ['Designation', 'Revenue type', 'Gifts', 'Value'], rows: [...grouped.values()].sort((a,b) => b.amount-a.amount).map(r => [r.designation, r.type, r.count, money(r.amount)]) };
  }
  if (report === 'Gift ledger') return { headers: ['Date', 'Donor', 'Revenue type', 'School year', 'Designation', 'Value'], rows: gifts.sort((a,b) => b.date.localeCompare(a.date)).map(g => [g.date,nameOf(data,'constituents',g.constituentId),g.type,effectiveSchoolYear(g,fiscalStartMonth),g.allocations.map(a => `${designationPath(data,a.designationId)} (${money(a.amount)})`).join('; '),money(g.amount)]) };
  if (report === 'Volunteer hours') return { headers: ['Volunteer', 'Skills', 'Shift', 'Hours'], rows: data.volunteers.map(v => [nameOf(data,'constituents',v.constituentId),v.skills,v.shift,Number(v.hours || 0).toFixed(2)]) };
  if (report === 'Grant pipeline') return { headers: ['Grant', 'Stage', 'Funder', 'Deadline', 'Report due', 'Requested amount'], rows: data.grants.map(g => [g.name,g.stage,nameOf(data,'constituents',g.funderId),g.deadline,g.reportDue || '—',money(g.amount)]) };
  const grouped = data.constituents.map(c => {
    const historical = allPosted.filter(g => g.constituentId === c.id && g.type !== 'Fee payment').sort((a,b) => a.date.localeCompare(b.date));
    const selected = gifts.filter(g => g.constituentId === c.id);
    const contacts = data.communications.filter(m => m.constituentId === c.id && m.status === 'Logged').sort((a,b) => b.date.localeCompare(a.date));
    return { c, first: historical[0]?.date, last: historical.at(-1)?.date, lastContact: contacts[0]?.date, selected };
  });
  if (report === 'First-time donors') return { headers: ['Donor', 'Email', 'First gift', 'Gifts in period', 'Value in period'], rows: grouped.filter(r => r.first && r.first >= start && r.first <= end && r.selected.length).map(r => [r.c.name,r.c.email,r.first,r.selected.length,money(sum(r.selected))]) };
  if (report === 'Donor follow-up') {
    const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate()-Number(inactiveDays)); const threshold = cutoff.toISOString().slice(0,10);
    return { headers: ['Donor', 'Email', 'Last gift', 'Last contact', 'Contact preference', 'Follow-up reason'], rows: grouped.filter(r => r.c.preference !== 'Do not contact' && ((!r.last || r.last < threshold) || (!r.lastContact || r.lastContact < threshold))).map(r => [r.c.name,r.c.email,r.last || 'Never',r.lastContact || 'Never',r.c.preference,[(!r.last || r.last < threshold) ? 'No recent gift' : '',(!r.lastContact || r.lastContact < threshold) ? 'No recent contact' : ''].filter(Boolean).join('; ')]) };
  }
  return { headers: ['Donor', 'Email', 'Gifts in period', 'Value in period', 'First gift', 'Last gift'], rows: grouped.filter(r => r.selected.length).sort((a,b) => sum(b.selected)-sum(a.selected)).map(r => [r.c.name,r.c.email,r.selected.length,money(sum(r.selected)),r.first,r.last]) };
}
