import { useId, useRef, useState } from 'react';
import { Clock3, Pencil, Save, X } from 'lucide-react';
import { nameOf } from '../lib';

export default function VolunteerLedger({ volunteer, data, onCorrect, canWrite, notify }) {
  const prefix = useId();
  const [editing, setEditing] = useState(null);
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const hoursRef = useRef(null);
  const entries = (data.volunteerTime || []).filter(entry => entry.volunteerId === volunteer.id);
  const historical = entries.filter(entry => entry.source === 'Historical' || !entry.startAt);
  const dated = entries.filter(entry => entry.source !== 'Historical' && entry.startAt).sort((a, b) => b.startAt.localeCompare(a.startAt));
  const total = entries.reduce((value, entry) => value + entry.hours, 0);
  const time = value => value ? `${value.slice(0, 10)} ${value.slice(11, 19)} UTC` : 'Undated';
  const edit = entry => { setEditing(entry.id); setHours(String(entry.hours)); setReason(''); setError(''); requestAnimationFrame(() => hoursRef.current?.focus()); };
  const save = async event => {
    event.preventDefault();
    const amount = Number(hours);
    if (!hours.trim() || !Number.isFinite(amount) || amount < 0 || amount > 1e6) { setError('Enter valid hours between 0 and 1,000,000.'); return; }
    if (!reason.trim()) { setError('Explain why the hours need correction.'); return; }
    const entry = entries.find(value => value.id === editing);
    if (!entry) { setError('This time entry is unavailable. Close the correction and refresh.'); return; }
    setBusy(true); setError('');
    try { await onCorrect(entry, { version: entry.version, hours: amount, reason: reason.trim() }); setEditing(null); notify?.('Volunteer time correction saved.'); } catch (failure) { setError(failure.message || 'The correction could not be saved. Refresh the ledger before retrying.'); } finally { setBusy(false); }
  };
  const table = (rows, undated) => <div className="table-wrap"><table><caption>{undated ? 'Historical hours retained from the earlier total; no date was recorded.' : 'Completed clock intervals. Corrections change hours while preserving original dates.'}</caption><thead><tr>{[undated ? 'Period' : 'Start', ...(undated ? [] : ['End']), 'Event', 'Hours', 'Correction history', ...(canWrite ? ['Action'] : [])].map(header => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>{rows.map(entry => <tr key={entry.id}><td>{undated ? 'Date unknown' : time(entry.startAt)}</td>{!undated && <td>{time(entry.endAt)}</td>}<td>{nameOf(data, 'events', entry.eventId)}</td><td className="money">{entry.hours.toFixed(2)}</td><td>{entry.correctionReason ? <><span>Originally {Number(entry.originalHours ?? entry.hours).toFixed(2)} hours</span><br /><span className="subtle">{entry.correctionReason}</span></> : <span className="subtle">{entry.notes || 'No corrections'}</span>}</td>{canWrite && <td><button type="button" className="text-btn" onClick={() => edit(entry)} disabled={busy} aria-label={`Correct ${undated ? 'historical' : time(entry.startAt)} hours`}><Pencil size={14} aria-hidden="true" /> Correct</button></td>}</tr>)}</tbody></table></div>;
  return <section aria-labelledby={`${prefix}-title`}>
    <h2 className="section-title" id={`${prefix}-title`}><Clock3 size={18} aria-hidden="true" /> Volunteer time ledger</h2>
    <div className="summary-strip"><div><span>Dated hours</span><strong>{dated.reduce((sum, entry) => sum + entry.hours, 0).toFixed(2)}</strong></div><div><span>Undated historical hours</span><strong>{historical.reduce((sum, entry) => sum + entry.hours, 0).toFixed(2)}</strong></div><div><span>Reconciled total hours</span><strong>{total.toFixed(2)}</strong></div></div>
    {volunteer.clockIn && <p className="subtle" role="status">Clock running since {time(volunteer.clockIn)}. The interval enters this ledger when you clock out.</p>}
    {editing && <form className="allocation-section" onSubmit={save} aria-labelledby={`${prefix}-correct`}><h3 id={`${prefix}-correct`}>Correct recorded hours</h3><p className="subtle">The original hours and your reason remain in the record. Dates cannot be changed.</p>{error && <p role="alert" className="error-banner">{error}</p>}<div className="form-grid"><div className="field"><label htmlFor={`${prefix}-hours`}>Corrected hours</label><input ref={hoursRef} id={`${prefix}-hours`} type="number" min="0" max="1000000" step="any" value={hours} onChange={event => setHours(event.target.value)} required disabled={busy} /></div><div className="field"><label htmlFor={`${prefix}-reason`}>Correction reason</label><textarea id={`${prefix}-reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} required disabled={busy} rows={3} /></div></div><div className="form-actions"><button className="btn btn-secondary" type="button" onClick={() => setEditing(null)} disabled={busy}><X size={15} aria-hidden="true" /> Cancel correction</button><button className="btn btn-primary" type="submit" disabled={busy}><Save size={15} aria-hidden="true" /> {busy ? 'Saving…' : 'Save correction'}</button></div></form>}
    {dated.length ? table(dated, false) : <p className="subtle">No completed dated intervals yet. Use clock in and clock out to record time.</p>}
    {historical.length > 0 && <div className="allocation-section"><h3>Undated historical hours</h3>{table(historical, true)}</div>}
  </section>;
}
