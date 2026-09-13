import { useId, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload, X, CheckCircle2 } from 'lucide-react';
import { cents, designationPath, download, money, parseCSV, toCSV, today } from '../lib';
import { METHODS, TYPES } from '../schema';

const HEADERS = ['donorEmail', 'amount', 'type', 'method', 'date', 'designationCode', 'campaignName', 'externalRef'];
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const exact = (records, key, value, label) => {
  const matches = records.filter(record => record[key] === value);
  if (!matches.length) throw new Error(`${label} “${value}” does not match an existing record.`);
  if (matches.length > 1) throw new Error(`${label} “${value}” matches multiple records. Use a unique identifier.`);
  return matches[0];
};

export default function ImportGifts({ data, onImport, onClose }) {
  const prefix = useId();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [errors, setErrors] = useState([]);
  const [importUncertain, setImportUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef(null);
  const previewRef = useRef(null);
  const fileRef = useRef(null);
  const fail = messages => { setPreview(null); setErrors(messages); setImportUncertain(false); requestAnimationFrame(() => errorRef.current?.focus()); };
  const updateText = value => { setText(value); setPreview(null); setErrors([]); setImportUncertain(false); };
  const sample = () => {
    const donor = data.constituents.find(c => c.email && data.constituents.filter(other => other.email === c.email).length === 1);
    const fund = data.designations.find(d => d.accountCode && data.designations.filter(other => other.accountCode === d.accountCode).length === 1);
    download('gift-import-template.csv', toCSV(HEADERS, [[donor?.email || 'existing-donor@example.test', '25.00', 'Cash', 'Check', today(), fund?.accountCode || 'EXISTING-FUND-CODE', '', '']]), 'text/csv;charset=utf-8');
  };
  const readFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { fail(['Choose a CSV file smaller than 2 MB.']); return; }
    try { updateText(await file.text()); } catch { fail(['The file could not be read. Try copying its CSV contents below.']); }
    if (fileRef.current) fileRef.current.value = '';
  };
  const validate = event => {
    event.preventDefault();
    setImportUncertain(false);
    let source;
    try {
      if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Use CSV contents smaller than 2 MB.');
      source = parseCSV(text);
      const supplied = Object.keys(source[0]);
      const missing = HEADERS.filter(header => !supplied.includes(header));
      const unknown = supplied.filter(header => !HEADERS.includes(header));
      if (missing.length || unknown.length) throw new Error([missing.length && `Missing columns: ${missing.join(', ')}.`, unknown.length && `Unexpected columns: ${unknown.join(', ')}.`].filter(Boolean).join(' '));
      if (source.length > 500) throw new Error('Import up to 500 gift rows at a time.');
    } catch (error) { fail([error.message]); return; }
    const problems = [], rows = [], refs = new Set(data.gifts.map(g => g.externalRef).filter(Boolean));
    source.forEach((row, index) => {
      try {
        if (!row.donorEmail) throw new Error('Donor email is required.');
        if (!row.designationCode) throw new Error('Designation account code is required.');
        if (row.externalRef.length > 300) throw new Error('External reference must be 300 characters or fewer.');
        const donor = exact(data.constituents, 'email', row.donorEmail, 'Donor email');
        const fund = exact(data.designations, 'accountCode', row.designationCode, 'Designation account code');
        const campaign = row.campaignName ? exact(data.campaigns, 'name', row.campaignName, 'Campaign name') : null;
        const amount = cents(row.amount);
        if (amount <= 0) throw new Error('The amount must be greater than zero.');
        if (amount > 1e12) throw new Error('The amount exceeds the maximum supported gift value.');
        if (!TYPES.includes(row.type)) throw new Error(`Revenue type must be one of: ${TYPES.join(', ')}.`);
        if (!METHODS.includes(row.method)) throw new Error(`Payment method must be one of: ${METHODS.join(', ')}.`);
        if ((row.type === 'In-kind') !== (row.method === 'In-kind')) throw new Error('In-kind gifts must use the In-kind payment method. Other revenue types cannot use the In-kind method.');
        if (!validDate(row.date)) throw new Error('Use a valid calendar date in YYYY-MM-DD format.');
        if (row.externalRef && refs.has(row.externalRef)) throw new Error(`External reference “${row.externalRef}” is duplicated in this file or already exists.`);
        if (row.externalRef) refs.add(row.externalRef);
        rows.push({ constituentId: donor.id, amount, type: row.type, method: row.method, date: row.date, campaignId: campaign?.id || null, allocations: [{ designationId: fund.id, amount }], externalRef: row.externalRef, notes: '', tribute: '', softCreditId: null, pledge: '', giftKind: 'One-time' });
      } catch (error) { problems.push(`CSV row ${index + 2}: ${error.message}`); }
    });
    if (problems.length) { fail(problems); return; }
    setErrors([]); setPreview(rows);
    requestAnimationFrame(() => previewRef.current?.focus());
  };
  const importRows = async () => {
    if (!preview?.length || busy) return;
    setBusy(true); setErrors([]); setImportUncertain(false);
    try { await onImport(preview); onClose(); } catch (error) {
      const uncertain = !error.status;
      setImportUncertain(uncertain);
      setErrors([error.message || (uncertain ? 'The connection was interrupted while confirming the import.' : 'The import failed. Review the data and try again.')]);
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { setBusy(false); }
  };
  const lookup = (collection, id) => data[collection].find(record => record.id === id);

  return <section className="panel" aria-labelledby={`${prefix}-title`} aria-busy={busy}>
    <div className="toolbar"><div><h2 id={`${prefix}-title`} className="section-title"><FileSpreadsheet size={19} aria-hidden="true" /> Import gifts</h2><p className="subtle">Preview every row before saving. An import succeeds in full or saves nothing.</p></div><button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy} aria-label="Close gift import"><X size={17} aria-hidden="true" /></button></div>
    <div className="toolbar"><button className="btn btn-secondary" type="button" onClick={sample} disabled={busy}><Download size={16} aria-hidden="true" /> Download sample CSV</button><span className="subtle">Up to 500 rows · amounts in dollars · one designation per row</span></div>
    <form onSubmit={validate}>
      <div className="form-grid">
        <div className="field"><label htmlFor={`${prefix}-file`}>Choose a local CSV file</label><input ref={fileRef} id={`${prefix}-file`} type="file" accept=".csv,text/csv" onChange={readFile} disabled={busy} /><span className="subtle">The file stays on this device until you confirm the import.</span></div>
        <div className="field"><label htmlFor={`${prefix}-csv`}>CSV contents</label><textarea id={`${prefix}-csv`} value={text} onChange={event => updateText(event.target.value)} rows={7} placeholder={HEADERS.join(',')} required disabled={busy} spellCheck={false} aria-describedby={`${prefix}-help`} /></div>
      </div>
      <p className="subtle" id={`${prefix}-help`}>Use the sample’s eight column names. Donor email, designation account code and optional campaign name must match existing records exactly. Leave campaignName and externalRef blank if unused. In-kind amounts record noncash value.</p>
      <div className="form-actions"><button className="btn btn-secondary" type="submit" disabled={busy || !text.trim()}><Upload size={16} aria-hidden="true" /> Validate and preview</button></div>
    </form>
    {errors.length > 0 && <div className="error-banner" ref={errorRef} tabIndex={-1} role="alert"><strong>Import needs attention</strong><p>{importUncertain ? 'Import could not be confirmed. Check Gifts before retrying; use unique external references to prevent duplicates.' : `No rows were imported. ${errors.length === 1 ? 'Correct the issue below.' : `Correct these ${errors.length} issues and preview again.`}`}</p><ul>{errors.slice(0, 30).map((error, index) => <li key={index}>{error}</li>)}</ul>{errors.length > 30 && <p>{errors.length - 30} more issues. Correct the first issues and validate again.</p>}</div>}
    {preview && <div ref={previewRef} tabIndex={-1} aria-labelledby={`${prefix}-preview`}>
      <h3 id={`${prefix}-preview`} className="section-title"><CheckCircle2 size={18} aria-hidden="true" /> {preview.length} {preview.length === 1 ? 'gift ready' : 'gifts ready'} to import</h3>
      <div className="summary-strip"><div className="stat"><span className="subtle">Monetary gift / revenue value</span><strong className="money">{money(preview.filter(g => g.type !== 'In-kind').reduce((sum, g) => sum + g.amount, 0))}</strong></div><div className="stat"><span className="subtle">In-kind noncash value</span><strong className="money">{money(preview.filter(g => g.type === 'In-kind').reduce((sum, g) => sum + g.amount, 0))}</strong></div></div>
      <div className="table-wrap"><table><caption>Validated gift import preview; records have not been saved.</caption><thead><tr>{['CSV row', 'Donor', 'Date', 'Revenue type', 'Method', 'Designation', 'Campaign', 'Value', 'External reference'].map(header => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>{preview.map((gift, index) => <tr key={index}><td>{index + 2}</td><td>{lookup('constituents', gift.constituentId)?.name}</td><td>{gift.date}</td><td>{gift.type}</td><td>{gift.method}</td><td>{designationPath(data, gift.allocations[0].designationId)}</td><td>{lookup('campaigns', gift.campaignId)?.name || '—'}</td><td className="money">{money(gift.amount)}</td><td>{gift.externalRef || '—'}</td></tr>)}</tbody></table></div>
      <div className="form-actions"><button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="btn btn-primary" type="button" onClick={importRows} disabled={busy}><Upload size={16} aria-hidden="true" /> {busy ? 'Importing…' : `Import ${preview.length} ${preview.length === 1 ? 'gift' : 'gifts'}`}</button></div>
    </div>}
  </section>;
}
