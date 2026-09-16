import { useId, useMemo, useState } from 'react';
import { CalendarDays, FileCheck2, Plus, Search } from 'lucide-react';
import { dateLabel, money, nameOf, today } from '../lib';
import { grantReconciliation } from '../phaseThree';
import { Status } from '../components/Fields';
import DataTable from '../components/DataTable';
import {grantDeadlineState,unresolvedGrantDeadlines} from '../grantDeadlines';

const STAGES = ['Prospect', 'Preparing', 'Submitted', 'Awarded', 'Declined', 'Closed'];
const dayDistance = (date, from) => date ? Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) : null;

export default function GrantWorkspace({ data, grantMilestones=[], onCreate, onOpen, canWrite }) {
  const prefix = useId();
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('All');
  const [deadlineView, setDeadlineView] = useState('All');
  const asOf = today();
  const grants = useMemo(() => (data.grants || []).map(grant => ({ grant, reconciliation: grantReconciliation(grant, data.gifts, asOf), funder: nameOf(data, 'constituents', grant.funderId) })), [data, asOf]);
  const rows = grants.filter(({ grant, funder }) => {
    if ((stage !== 'All' && grant.stage !== stage) || !`${grant.name} ${funder} ${grant.notes || ''}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (deadlineView === 'All') return true;
    const deadlines=unresolvedGrantDeadlines(grant,grantMilestones);
    if (deadlineView === 'Past due') return deadlines.some(d=>d.date<asOf);
    const kind=deadlineView==='Application due'?'Application':'Report';
    return deadlines.some(d=>d.kind===kind&&dayDistance(d.date,asOf)>=0&&dayDistance(d.date,asOf)<=30);
  });
  const pipeline = grants.filter(({ grant }) => ['Prospect', 'Preparing', 'Submitted'].includes(grant.stage));
  const warnings = rows.filter(({ reconciliation }) => reconciliation.awardUnknown).length;
  const relevantDeadlines = rows.flatMap(({grant})=>unresolvedGrantDeadlines(grant,grantMilestones)).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,5);
  const columns = [
    { key: 'name', label: 'Grant / funder', mobilePriority: 0, sort: row => row.grant.name, render: row => <>{row.grant.name}<small className="cell-detail">{row.grant.funderId ? row.funder : 'Funder not recorded'}</small></> },
    { key: 'stage', label: 'Stage', mobilePriority: 1, sort: row => row.grant.stage, render: row => <Status value={row.grant.stage} /> },
    { key: 'requested', label: 'Requested', money: true, sort: row => row.reconciliation.requested, render: row => money(row.reconciliation.requested) },
    { key: 'awarded', label: 'Recorded award', money: true, sort: row => row.reconciliation.awarded, render: row => row.reconciliation.awardUnknown ? 'Unknown' : money(row.reconciliation.awarded) },
    { key: 'received', label: 'Receipts', money: true, mobilePriority: 2, sort: row => row.reconciliation.received, render: row => money(row.reconciliation.received) },
    { key: 'balance', label: 'Award balance', money: true, sort: row => row.reconciliation.balance, render: row => row.reconciliation.awardUnknown ? 'Unknown' : money(row.reconciliation.balance) },
    { key: 'deadline', label: 'Application due', sort: row => row.grant.deadline, render: row => <>{dateLabel(row.grant.deadline)}<small className="cell-detail">{grantDeadlineState(row.grant,'Application',row.grant.deadline,grantMilestones).status}</small></> },
    { key: 'reportDue', label: 'Report due', sort: row => row.grant.reportDue, render: row => <>{dateLabel(row.grant.reportDue)}{row.grant.reportDue&&<small className="cell-detail">{grantDeadlineState(row.grant,'Report',row.grant.reportDue,grantMilestones).status}</small>}</> },
  ];
  return <section className="grant-workspace" aria-labelledby={`${prefix}-title`}>
    <div className="page-header"><div><h1 id={`${prefix}-title`}>Grants</h1><p>Follow each request from application to recorded award and actual receipts.</p></div>{canWrite && <button type="button" className="btn btn-primary" onClick={onCreate}><Plus size={16} aria-hidden="true" /> New grant <kbd>C</kbd></button>}</div>
    <div className="grant-context"><div><h2>Keep the funding story clear</h2><p>Requested funding and recorded awards represent different stages. Only posted, linked grant gifts are received contributions.</p></div><div className="grant-pipeline-context"><span>Open pipeline · {pipeline.length} {pipeline.length === 1 ? 'request' : 'requests'}</span><strong>{money(pipeline.reduce((total, row) => total + row.reconciliation.requested, 0))}</strong><small>Requested value, not received income</small></div></div>
    <div className="summary-strip grant-financials" aria-label="Recorded grant lifecycle values through today"><div><span>Recorded awards · all grants</span><strong>{money(grants.reduce((total, row) => total + row.reconciliation.awarded, 0))}</strong><small>Commitments, not income</small></div><div><span>Linked receipts through today</span><strong>{money(grants.reduce((total, row) => total + row.reconciliation.received, 0))}</strong><small>Posted Grant gifts only</small></div><div><span>Known award balance</span><strong>{money(grants.reduce((total, row) => total + row.reconciliation.balance, 0))}</strong><small>Does not include unknown legacy awards</small></div></div>
    <section className="panel" aria-labelledby={`${prefix}-records`}>
      <h2 id={`${prefix}-records`} className="section-title"><FileCheck2 size={18} aria-hidden="true" /> Grant records</h2>
      <div className="toolbar"><label className="search-control" htmlFor={`${prefix}-search`}><Search size={16} aria-hidden="true" /><span className="sr-only">Search grants or funders</span><input id={`${prefix}-search`} type="search" placeholder="Search grants or funders" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="filter-control"><label className="sr-only" htmlFor={`${prefix}-stage`}>Grant stage</label><select id={`${prefix}-stage`} value={stage} onChange={event => setStage(event.target.value)}><option value="All">All stages</option>{STAGES.map(value => <option key={value}>{value}</option>)}</select></div><div className="filter-control"><label className="sr-only" htmlFor={`${prefix}-deadline`}>Deadline view</label><select id={`${prefix}-deadline`} value={deadlineView} onChange={event => setDeadlineView(event.target.value)}><option value="All">All deadlines</option><option value="Application due">Applications due in 30 days</option><option value="Report due">Reports due in 30 days</option><option value="Past due">Past due dates</option></select></div><span className="record-count" role="status">{rows.length} {rows.length === 1 ? 'grant' : 'grants'}</span></div>
      {warnings > 0 && <p className="grant-unknown-award table-note" role="status">{warnings} {warnings === 1 ? 'record is' : 'records are'} marked Awarded or Closed without a recorded award amount. Their requested amounts have not been substituted as awards.</p>}
      <p className="table-note">Receipts through {dateLabel(asOf)}. Summary values above include all grants; records below follow your filters.</p>
      {rows.length ? <DataTable columns={columns} rows={rows.map(row => ({ ...row, id: row.grant.id, name: row.grant.name }))} label="Grant funding lifecycle" onOpen={row => onOpen(row.grant)} /> : <div className="empty-state"><FileCheck2 size={30} aria-hidden="true" /><h3>{grants.length ? 'No grants match this view' : 'Track your first funding request'}</h3><p>{grants.length ? 'Change the stage, deadline view or search term.' : 'Record the request and deadlines first, then add a confirmed award and link receipts as they arrive.'}</p>{!grants.length && canWrite && <button type="button" className="btn btn-primary" onClick={onCreate}>Create a grant</button>}</div>}
      <p className="table-note grant-reconciliation-note">Voided, fee and in-kind gifts do not count as grant receipts. Grants do not collect payments, submit applications or verify bank settlements.</p>
    </section>
    {relevantDeadlines.length > 0 && <section className="panel" aria-labelledby={`${prefix}-dates`}><h2 id={`${prefix}-dates`} className="section-title"><CalendarDays size={16} aria-hidden="true" /> Dates in this view</h2><div className="grant-deadline-list">{relevantDeadlines.map(({ grant, date, kind }) => <button type="button" key={`${grant.id}-${kind}`} className="interaction-row" onClick={() => onOpen(grant)}><span><strong>{grant.name}</strong><small>{kind} deadline · {dateLabel(date)}</small></span><span className="grant-deadline-label">{date < asOf ? 'Past due date' : date === asOf ? 'Due today' : `${dayDistance(date, asOf)} days`}</span></button>)}</div><p className="table-note">These are unresolved recorded obligations. Completed evidence clears only the same grant, obligation type and due date. Open Grant operations to record completion or reopen it; recording evidence does not submit it externally.</p></section>}
  </section>;
}
