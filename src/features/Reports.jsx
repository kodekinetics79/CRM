import { useId, useMemo, useState } from 'react';
import { Download, Printer, FileBarChart2, Filter, Save, Trash2 } from 'lucide-react';
import { download, effectiveSchoolYear,fiscalYear, money, nameOf, postedGifts, reportRows, toCSV, today } from '../lib';
import { REPORTS, TYPES } from '../schema';
import { pledgeSchedule, recognitionReport, volunteerTimeReport } from '../phaseTwo';
import { grantReconciliation } from '../phaseThree';

const RECOGNITION = ['Soft-credit recognition', 'Organization rollup', 'Household rollup'];
const NAMES = [...new Set([...REPORTS, ...RECOGNITION, 'Pledge balances', 'Volunteer time ledger', 'Grant reconciliation'])];
export default function Reports({ data, settings, notify, onSaveView, onDeleteView, canWrite }) {
  const prefix = useId();
  const [filters, setFilters] = useState({ report: REPORTS[0], start: '', end: '', type: 'All', schoolYear: 'All', excludeFees: true, inactiveDays: 90 });
  const [viewId, setViewId] = useState('');
  const [viewName, setViewName] = useState('');
  const [viewError, setViewError] = useState('');
  const [busy, setBusy] = useState(false);
  const fiscalStartMonth = settings?.fiscalStartMonth || 7;
  const pledgeReport = filters.report === 'Pledge balances';
  const timeReport = filters.report === 'Volunteer time ledger';
  const grantReport = filters.report === 'Grant reconciliation';
  const giftReport = !['Volunteer hours', 'Grant pipeline', 'Donor follow-up', 'Pledge balances', 'Volunteer time ledger', 'Grant reconciliation'].includes(filters.report);
  const dateReport = giftReport || pledgeReport || timeReport || grantReport;
  const invalidRange = dateReport && !grantReport && filters.start && filters.end && filters.start > filters.end;
  const years = useMemo(() => [...new Set([...data.gifts.map(g => effectiveSchoolYear(g, fiscalStartMonth)), ...(data.pledges || []).map(p => fiscalYear(p.startDate, fiscalStartMonth)), ...(data.volunteerTime || []).filter(t => t.startAt).map(t => fiscalYear(t.startAt.slice(0, 10), fiscalStartMonth)), fiscalYear(today(), fiscalStartMonth)])].sort().reverse(), [data, fiscalStartMonth]);
  const config = { ...filters, end: filters.end || '9999-12-31', fiscalStartMonth };
  const result = useMemo(() => {
    const config = { ...filters, end: filters.end || '9999-12-31', fiscalStartMonth };
    if (RECOGNITION.includes(filters.report)) return recognitionReport(data, config);
    if (filters.report === 'Volunteer time ledger') return volunteerTimeReport(data, config);
    if (filters.report === 'Grant reconciliation') {
      const asOf = filters.end || today();
      return { headers: ['Grant', 'Funder', 'Stage', 'Requested', 'Recorded award', 'Posted receipts', 'Award balance', 'Award date', 'As of', 'Award information'], rows: (data.grants || []).map(grant => {
        const value = grantReconciliation(grant, data.gifts, asOf);
        return [grant.name, nameOf(data, 'constituents', grant.funderId), grant.stage, money(value.requested), money(value.awarded), money(value.received), value.awardUnknown ? 'Unknown' : money(value.balance), grant.awardDate || '—', asOf, value.awardUnknown ? 'Legacy award amount unknown; recorded value is zero' : value.awarded > 0 ? 'Recorded award; not income' : 'No award amount recorded'];
      }) };
    }
    if (filters.report === 'Pledge balances') {
      const asOf = filters.end || today();
      const pledges = (data.pledges || []).filter(p => p.startDate >= filters.start && p.startDate <= config.end && (filters.schoolYear === 'All' || fiscalYear(p.startDate, fiscalStartMonth) === filters.schoolYear));
      return { headers: ['Pledge', 'Donor', 'Status', 'Commitment', 'Received', 'Balance', 'Overdue', 'As of'], rows: pledges.map(pledge => { const schedule = pledgeSchedule(pledge, data.gifts, asOf); return [pledge.name, nameOf(data, 'constituents', pledge.constituentId), pledge.status, money(pledge.amount), money(schedule.received), money(schedule.balance), money(schedule.overdue), asOf]; }) };
    }
    return reportRows(data, config);
  }, [data, filters, fiscalStartMonth]);
  const selected = giftReport && !invalidRange ? postedGifts(data.gifts).filter(g => (!filters.start || g.date >= filters.start) && (!filters.end || g.date <= filters.end) && (filters.type === 'All' || g.type === filters.type) && (!filters.excludeFees || g.type !== 'Fee payment') && (filters.schoolYear === 'All' || effectiveSchoolYear(g, fiscalStartMonth) === filters.schoolYear)) : [];
  const cash = selected.filter(g => g.type !== 'In-kind').reduce((sum, g) => sum + g.amount, 0);
  const noncash = selected.filter(g => g.type === 'In-kind').reduce((sum, g) => sum + g.amount, 0);
  const change = (key, value) => { setFilters(previous => ({ ...previous, ...(key === 'report' && value === 'Grant reconciliation' ? { start: '', type: 'All', schoolYear: 'All', excludeFees: true } : {}), [key]: value })); setViewId(''); setViewError(''); };
  const id = key => `${prefix}-${key}`;
  const savedViews = data.reportViews || [];
  const applyView = value => {
    setViewId(value); setViewError('');
    if (!value) return;
    const view = savedViews.find(record => record.id === value);
    if (!view || !NAMES.includes(view.filters?.report)) { setViewError('This saved view is unavailable or uses an unsupported report. Choose another view.'); return; }
    const candidate = { ...filters, ...view.filters };
    if ((candidate.start && candidate.end && candidate.start > candidate.end) || !['All', ...TYPES].includes(candidate.type) || !Number.isInteger(candidate.inactiveDays) || candidate.inactiveDays < 1 || candidate.inactiveDays > 3650) { setViewError('The saved filters are invalid. Adjust the filters and save a new view.'); return; }
    setFilters(candidate); setViewName(view.name);
  };
  const saveView = async event => {
    event.preventDefault();
    if (!viewName.trim()) { setViewError('Give the saved view a name.'); return; }
    if (invalidRange) { setViewError('Correct the date range before saving.'); return; }
    setBusy(true); setViewError('');
    try { await onSaveView({ name: viewName.trim(), filters }); notify?.('Report view saved for the workspace.'); setViewName(''); setViewId(''); } catch (error) { setViewError(error.message || 'The view could not be saved. Check saved views before retrying.'); } finally { setBusy(false); }
  };
  const deleteView = async () => {
    const view = savedViews.find(record => record.id === viewId);
    if (!view || busy) return;
    setBusy(true); setViewError('');
    try { await onDeleteView(view); setViewId(''); setViewName(''); notify?.('Saved report view deleted.'); } catch (error) { setViewError(error.message || 'The view could not be deleted. Refresh and try again.'); } finally { setBusy(false); }
  };
  const exportCSV = () => {
    const rows = timeReport ? [...result.rows, ...result.historicalRows.map(row => ['Undated historical', row[0], row[1], 'Undated', 'Undated', row[2], 'Historical', row[3]])] : result.rows;
    download(`${filters.report.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${today()}.csv`, toCSV(result.headers, rows), 'text/csv;charset=utf-8');
    notify?.('Report CSV downloaded.');
  };

  return <section aria-labelledby={id('title')}>
    <div className="page-header">
      <div><h1 id={id('title')}>Reports</h1><p className="subtle">Review foundation activity and prepare a shareable record.</p></div>
      <div className="toolbar">
        <button className="btn btn-secondary" onClick={exportCSV} disabled={!!invalidRange || (!result.rows.length && !(timeReport && result.historicalRows.length))}><Download size={16} aria-hidden="true" /> Export CSV</button>
        <button className="btn btn-secondary" onClick={() => window.print()} disabled={!!invalidRange}><Printer size={16} aria-hidden="true" /> Print / save PDF</button>
      </div>
    </div>

    <div className="panel">
      <h2 className="section-title">Saved workspace views</h2>
      {viewError && <p className="error-banner" role="alert">{viewError}</p>}
      <div className="form-grid"><div className="field"><label htmlFor={id('saved')}>Apply a saved view</label><select id={id('saved')} value={viewId} onChange={event => applyView(event.target.value)} disabled={busy}><option value="">Current custom filters</option>{savedViews.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select><span className="subtle">Views store filters, not a snapshot or scheduled delivery.</span></div>{canWrite && <form onSubmit={saveView} className="field"><label htmlFor={id('name')}>Save current filters as</label><input id={id('name')} value={viewName} onChange={event => setViewName(event.target.value)} maxLength={250} required disabled={busy} placeholder="For example, annual school fund gifts" /><div className="toolbar"><button className="btn btn-secondary" type="submit" disabled={busy || !!invalidRange}><Save size={15} aria-hidden="true" /> {busy ? 'Working…' : 'Save new view'}</button>{viewId && <button className="btn btn-danger" type="button" onClick={deleteView} disabled={busy}><Trash2 size={15} aria-hidden="true" /> Delete selected view</button>}</div></form>}</div>
    </div>

    <div className="panel">
      <h2 className="section-title"><Filter size={17} aria-hidden="true" /> Report filters</h2>
      <form onSubmit={e => e.preventDefault()} className="form-grid" aria-label="Report filters">
        <div className="field"><label htmlFor={id('report')}>Report</label><select id={id('report')} value={filters.report} onChange={e => change('report', e.target.value)}>{NAMES.map(name => <option key={name}>{name}</option>)}</select></div>
        <div className="field"><label htmlFor={id('start')}>{pledgeReport ? 'Commitment start from' : 'Start date'}</label><input id={id('start')} type="date" disabled={!dateReport || grantReport} value={filters.start} onChange={e => change('start', e.target.value)} max={filters.end || undefined} /></div>
        <div className="field"><label htmlFor={id('end')}>{grantReport ? 'Receipt as-of date' : pledgeReport ? 'As-of date / commitment start to' : 'End date'}</label><input id={id('end')} type="date" disabled={!dateReport} value={filters.end} onChange={e => change('end', e.target.value)} min={!grantReport ? filters.start || undefined : undefined} /></div>
        <div className="field"><label htmlFor={id('type')}>Revenue type</label><select id={id('type')} disabled={!giftReport} value={filters.type} onChange={e => change('type', e.target.value)}><option value="All">All revenue types</option>{TYPES.map(type => <option key={type}>{type}</option>)}</select></div>
        <div className="field"><label htmlFor={id('year')}>School year</label><select id={id('year')} disabled={!dateReport || grantReport} value={filters.schoolYear} onChange={e => change('schoolYear', e.target.value)}><option value="All">All school years</option>{years.map(year => <option key={year}>{year}</option>)}</select></div>
        {filters.report === 'Donor follow-up' ? <div className="field"><label htmlFor={id('inactive')}>Days without a gift or contact</label><input id={id('inactive')} type="number" min="1" max="3650" step="1" value={filters.inactiveDays} onChange={e => change('inactiveDays', Math.min(3650, Math.max(1, Number(e.target.value) || 1)))} /><span className="subtle">Contacts marked “Do not contact” are excluded.</span></div> : <div className="field"><label htmlFor={id('fees')}><input id={id('fees')} type="checkbox" checked={filters.excludeFees} disabled={!giftReport} onChange={e => change('excludeFees', e.target.checked)} /> Exclude fee payments</label><span className="subtle">Voided gifts are always excluded.</span></div>}
      </form>
      <p className="subtle">{giftReport ? `School years use the organization’s fiscal start month (${fiscalStartMonth}). In-kind amounts represent noncash value.` : grantReport ? 'All grants are shown. The as-of date scopes posted, explicitly linked Grant receipts only; requested and recorded award values are current commitments, not income. Receipt-type, start-date and school-year filters do not apply. Zero on a legacy Awarded or Closed record is flagged as an unknown award amount.' : pledgeReport ? 'Dates and school years select pledge start dates. Received and overdue balances are calculated through the as-of date, or today if blank.' : timeReport ? 'Date and school-year filters apply to the clock-in date of completed intervals. Undated historical hours remain separate.' : filters.report === 'Donor follow-up' ? 'Follow-up uses the complete gift and logged contact history as of today.' : 'This report includes all current records; gift filters do not apply.'} Choose “Save as PDF” in the print dialog to create a PDF.</p>
      {RECOGNITION.includes(filters.report) && <p className="table-note">Recognition does not create income. Each gift counts once within a group; direct recognition takes precedence when both donor and soft-credit recipient belong to that group. Organization totals include descendants. Different groups can recognize the same gift, so group rows should not be added together as received income.</p>}
      {invalidRange && <p className="error-banner" role="alert">The end date must be on or after the start date.</p>}
    </div>

    {giftReport && !invalidRange && <div className="summary-strip" aria-label="Selected gift activity">
      <div className="stat"><span className="subtle">Posted records in filters</span><strong>{selected.length}</strong></div>
      <div className="stat"><span className="subtle">Monetary gift / revenue value</span><strong className="money">{money(cash)}</strong></div>
      <div className="stat"><span className="subtle">In-kind noncash value</span><strong className="money">{money(noncash)}</strong></div>
    </div>}

    {timeReport && !invalidRange && <div className="summary-strip"><div><span>Dated hours in filters</span><strong>{result.datedHours.toFixed(2)}</strong></div><div><span>Undated historical hours · all history</span><strong>{result.historicalHours.toFixed(2)}</strong></div><div><span>Selected dated + undated hours</span><strong>{result.totalHours.toFixed(2)}</strong></div></div>}

    <div className="panel">
      <div className="toolbar"><h2 className="section-title"><FileBarChart2 size={18} aria-hidden="true" /> {filters.report}</h2><span className="badge" role="status">{invalidRange ? 0 : result.rows.length} {result.rows.length === 1 ? 'row' : 'rows'}</span></div>
      {!invalidRange && result.rows.length ? <div className="table-wrap"><table>
        <caption className="subtle">{settings?.organizationName || 'Wimblo'} · {filters.report}{grantReport ? ` · Receipts through ${filters.end || today()}` : dateReport && (config.start || filters.end) ? ` · ${config.start || 'Beginning of history'} to ${filters.end || 'Latest activity'}` : ''}</caption>
        <thead><tr>{result.headers.map(header => <th key={header} scope="col" className={/monetary|value|commitment|received|balance|overdue|requested|receipts|^recorded award$/i.test(header) ? 'money' : undefined}>{header}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className={String(cell).startsWith('$') ? 'money' : undefined}>{cell ?? '—'}</td>)}</tr>)}</tbody>
      </table></div> : <div className="empty-state"><FileBarChart2 size={28} aria-hidden="true" /><h3>{invalidRange ? 'Correct the date range' : 'No matching activity'}</h3><p className="subtle">{invalidRange ? 'Adjust the report filters to view results.' : 'Choose another report or widen the filters to see more records.'}</p></div>}
      {timeReport && !invalidRange && result.historicalRows.length > 0 && <div className="allocation-section"><h3>Undated historical time</h3><p className="subtle">These hours have no verified date and are excluded from dated results.</p><div className="table-wrap"><table><caption>Historical hours, shown independently of date and school-year filters.</caption><thead><tr>{['Volunteer', 'Event', 'Hours', 'Notes / correction'].map(header => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>{result.historicalRows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className={column === 2 ? 'money' : undefined}>{cell}</td>)}</tr>)}</tbody></table></div></div>}
    </div>
  </section>;
}
