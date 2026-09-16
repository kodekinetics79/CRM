import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ShieldCheck,AlertTriangle,RefreshCw} from 'lucide-react';
import {api as defaultApi} from '../api.js';
import {money as formatMoney} from '../lib.js';

// Phase 9 review surface. Everything here is a proposal with its evidence
// attached. No control on this screen merges, posts, sends, acknowledges,
// issues or approves anything: the only thing a person can save here is their
// own review decision, and every decision is confirmed explicitly.
const TABS=[['duplicates','Duplicate candidates'],['stewardship','Stewardship'],['followups','Grants & pledges'],['quality','Record quality'],['narrative','Report narrative']];
const NARRATIVES=[['giving-summary','Giving summary'],['grant-pipeline','Community grant pipeline'],['pledge-balances','Pledge balances']];
const DECISIONS=['Accepted for review','Dismissed','Reopened'];
const KIND_OF={duplicates:'duplicate',stewardship:'stewardship',followups:'followup',quality:'quality'};
const kindOf=status=>status===409?'conflict':status===403?'permission':status===401?'session':status===503?'source':status===404?'missing':'failure';
const TITLES={conflict:'This changed while you were working',permission:'You cannot do this',session:'Your sign-in changed',source:'Saved records need review',missing:'That is no longer available',failure:'That did not work'};
const money=value=>typeof value!=='number'||!Number.isFinite(value)?'—':formatMoney(value);

function Sources({sources,onOpen}){
 if(!sources?.length)return null;
 return <details className="quality-sources"><summary>What this is based on ({sources.length} saved {sources.length===1?'record':'records'})</summary>
  <ul>{sources.slice(0,40).map(source=><li key={source.collection+source.id+source.version}>
   <span className="quality-source-kind">{source.collection}</span>
   <button type="button" className="text-btn" onClick={()=>onOpen?.(source.collection,source.id)}>Open this record</button>
   <span className="quality-source-version">version {source.version}</span>
  </li>)}</ul>
  {sources.length>40&&<p className="quality-note">{sources.length-40} further cited records are not listed here.</p>}
 </details>;
}

export default function DataQuality({api=defaultApi,data,notify,onDirty,onOpen}){
 const [tab,setTab]=useState('duplicates');
 const [overview,setOverview]=useState(null),[panel,setPanel]=useState(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [error,setError]=useState(null),[done,setDone]=useState('');
 const [decision,setDecision]=useState(null);
 const [form,setForm]=useState({kind:'giving-summary',from:'',to:'',designationId:''});
 const [narrative,setNarrative]=useState(null);
 const reasonRef=useRef(null);

 const path=useMemo(()=>({duplicates:'/data-quality/duplicates?limit=100',stewardship:'/data-quality/stewardship',followups:'/data-quality/followups',quality:'/data-quality/quality'}[tab]),[tab]);
 const refresh=useCallback(async()=>{
  const base=await api('/data-quality');
  setOverview(base);
  setPanel(path?await api(path):null);
  return base;
 },[api,path]);
 useEffect(()=>{let active=true;setLoading(true);setError(null);
  refresh().catch(e=>{if(active)setError({message:e.message,kind:kindOf(e.status)});}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};},[refresh]);
 useEffect(()=>()=>{onDirty?.(false);},[onDirty]);
 useEffect(()=>{if(decision)reasonRef.current?.focus();},[decision]);

 const reload=()=>{setError(null);setLoading(true);refresh().catch(e=>setError({message:e.message,kind:kindOf(e.status)})).finally(()=>setLoading(false));};
 const act=async(message,run)=>{
  setBusy(true);setError(null);setDone('');
  try{const result=await run();await refresh();setDone(message);notify?.(message);onDirty?.(false);return result;}
  catch(e){setError({message:e.message,kind:kindOf(e.status)});return null;}
  finally{setBusy(false);}
 };
 const saveDecision=async event=>{
  event.preventDefault();
  if(!decision?.reason.trim())return setError({message:'Say why you are recording this decision. The reason is kept with the decision.',kind:'failure'});
  const saved=await act('Decision recorded. Nothing was merged, posted, sent or changed.',()=>api('/data-quality/reviews',{method:'POST',body:{kind:decision.kind,findingKey:decision.key,sourceDigest:decision.digest,decision:decision.decision,reason:decision.reason.trim()}}));
  if(saved)setDecision(null);
 };
 const compose=async event=>{
  event.preventDefault();
  setNarrative(null);
  const body={kind:form.kind,from:form.from,to:form.to,...(form.designationId?{designationId:form.designationId}:{})};
  setBusy(true);setError(null);setDone('');
  try{const result=await api('/data-quality/narrative',{method:'POST',body});setNarrative(result);setDone('Narrative composed from the cited saved records. Review it before use.');onDirty?.(false);}
  catch(e){setError({message:e.message,kind:kindOf(e.status)});}
  finally{setBusy(false);}
 };

 const provider=overview?.provider;
 const findings=tab==='duplicates'?panel?.candidates:panel?.findings;
 const designations=(data?.designations||[]).slice().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));

 if(error?.kind==='permission'&&!overview)return <><div className="page-header"><div><h1>Data quality &amp; assistance</h1><p>Review duplicate, stewardship and record-quality findings before acting on them.</p></div></div>
  <section className="panel"><div className="empty-state" role="status"><h3>You cannot open this review surface</h3><p>{error.message}</p><p>Duplicate and stewardship findings compare saved identity and financial records, so they are limited to administrator and staff accounts. Ask an administrator if you need access. A board viewer keeps full access to reports.</p></div></section></>;

 return <div className="data-quality">
 <div className="page-header"><div><h1>Data quality &amp; assistance</h1><p>Review duplicate, stewardship and record-quality findings before acting on them.</p></div><ShieldCheck size={24} aria-hidden="true"/></div>

 <p className="quality-notice">Everything on this screen is a proposal with its evidence attached. Wimblo does not merge identities, post gifts, send communications, change consent, issue receipts or change permissions here. Findings are recomputed from saved records each time you open them; a finding whose cited records have changed is withdrawn rather than shown stale.</p>

 {error&&<div className="error-banner" role="alert"><AlertTriangle size={16} aria-hidden="true"/> <strong>{TITLES[error.kind]}.</strong> {error.message}{['conflict','source','missing'].includes(error.kind)&&<> <button className="text-btn" type="button" onClick={reload}>Reload current findings</button></>}</div>}
 <p role="status" aria-live="polite" className="quality-status">{busy?'Working…':done||(loading?'Recomputing findings from saved records…':overview?`Recomputed ${overview.computedFor}. Nothing is cached.`:'')}</p>

 {loading&&!overview?<section className="panel" aria-busy="true"><p>Recomputing findings from saved records…</p></section>:
  !overview?<section className="panel"><div className="empty-state"><h3>These findings are unavailable</h3><p>Reopen this screen to try again.</p><button className="btn btn-secondary" type="button" onClick={reload}><RefreshCw size={15} aria-hidden="true"/> Try again</button></div></section>:<>

 <div className="quality-tabs" role="tablist" aria-label="Data quality views">
  {TABS.map(([key,text])=><button key={key} type="button" role="tab" id={'quality-tab-'+key} aria-selected={tab===key} aria-controls={'quality-panel-'+key} tabIndex={tab===key?0:-1}
   className={'quality-tab'+(tab===key?' is-active':'')} onClick={()=>{setTab(key);setDecision(null);setDone('');}}
   onKeyDown={event=>{const order=TABS.map(([id])=>id);const at=order.indexOf(tab);
    const move={ArrowRight:at+1,ArrowLeft:at+order.length-1,Home:0,End:order.length-1};
    if(event.key in move){event.preventDefault();const next=order[move[event.key]%order.length];setTab(next);setDecision(null);document.getElementById('quality-tab-'+next)?.focus();}}}>
   {text}{key!=='narrative'&&<span className="quality-count"> ({overview.counts[key]??0})</span>}
  </button>)}
 </div>

 {tab!=='narrative'&&<section className="panel" id={'quality-panel-'+tab} role="tabpanel" aria-labelledby={'quality-tab-'+tab} tabIndex={-1}>
  {tab==='duplicates'&&<p className="quality-note">{panel?.method}</p>}
  {tab==='followups'&&<p className="quality-note">{panel?.scope}</p>}
  {tab==='stewardship'&&<p className="quality-note">{panel?.scope}</p>}
  {tab==='quality'&&<p className="quality-note">{panel?.scope}</p>}

  {loading?<p aria-busy="true">Recomputing…</p>:
   !findings?.length?<div className="empty-state"><h3>Nothing to review here</h3><p>No finding of this kind comes out of the records saved right now. This is a result, not a failure — reopen the screen after records change.</p></div>:
   <ul className="quality-list">{findings.map(finding=>{
    const key=finding.key,reviewKind=KIND_OF[tab];
    const open=decision&&decision.key===key;
    return <li key={key} className={'quality-item'+(finding.blocked?' is-blocked':'')}>
     <div className="quality-item-head">
      <h3>{tab==='duplicates'?'Possible duplicate: '+finding.left.name+' and '+finding.right.name:finding.title}</h3>
      <p className="quality-meta">{tab==='duplicates'?(finding.blocked?'Blocked — cannot be merged':finding.confidence+' candidate'):finding.severity==='attention'?'Needs attention':'For review'}</p>
     </div>

     {tab==='duplicates'?<>
      <dl className="quality-pair">
       <div><dt>Record A</dt><dd>{finding.left.name} · {finding.left.type}{finding.left.household?' · '+finding.left.household:''} · version {finding.left.version} <button type="button" className="text-btn" onClick={()=>onOpen?.('constituents',finding.left.id)}>Open</button></dd></div>
       <div><dt>Record B</dt><dd>{finding.right.name} · {finding.right.type}{finding.right.household?' · '+finding.right.household:''} · version {finding.right.version} <button type="button" className="text-btn" onClick={()=>onOpen?.('constituents',finding.right.id)}>Open</button></dd></div>
      </dl>
      <h4 className="quality-subhead">Why these were proposed</h4>
      <ul className="quality-signals">{finding.signals.map(signal=><li key={signal.type}><strong>{signal.type}</strong> — {signal.why} <span className="quality-normalized">Normalised value: {signal.normalized}</span> <span className="quality-raw">Saved values: “{signal.left.value}” and “{signal.right.value}”</span></li>)}</ul>
     </>:<p className="quality-detail">{finding.detail}</p>}

     {tab==='followups'&&finding.schedule&&<dl className="quality-figures">
      <div><dt>Recorded commitment</dt><dd>{money(finding.committedCents)}</dd></div>
      <div><dt>Posted fulfilment gifts</dt><dd>{money(finding.receivedCents)}</dd></div>
      <div><dt>Recorded outstanding balance</dt><dd>{money(finding.balanceCents)}</dd></div>
      <div><dt>Next scheduled date</dt><dd>{finding.schedule.nextScheduledDate||'Not stated'}</dd></div>
      <div className="quality-figures-note"><dt>Derived from</dt><dd>{finding.schedule.derivedFrom.join(', ')}. {finding.schedule.note}</dd></div>
     </dl>}
     {tab==='quality'&&finding.fields&&<p className="quality-detail">Flagged fields: {finding.fields.map(field=>field.field+' ('+field.patterns.join(', ')+')').join('; ')}. The saved text itself is not repeated here.</p>}

     {finding.blockers?.length>0&&<><h4 className="quality-subhead">Why this cannot be merged</h4><ul className="quality-blockers">{finding.blockers.map((blocker,index)=><li key={index}>{blocker.reason}</li>)}</ul></>}

     <p className="quality-next"><strong>Next action (yours):</strong> {finding.nextAction.label}. Wimblo will not do this for you.</p>
     <Sources sources={finding.sources} onOpen={onOpen}/>

     {finding.review&&<p className="quality-review">Recorded decision: {finding.review.decision} by {finding.review.actor} on {finding.review.at.slice(0,10)}. {finding.review.current?'It was taken on the records cited above.':'It was taken on earlier versions of these records, so it is not current.'}</p>}

     {overview.canReview&&(open?
      <form className="quality-decision" onSubmit={saveDecision} aria-busy={busy}>
       <fieldset disabled={busy}><legend>Record your decision about this finding</legend>
        <label className="field"><span>Decision</span>
         <select value={decision.decision} onChange={event=>setDecision({...decision,decision:event.target.value})}>{DECISIONS.map(value=><option key={value} value={value}>{value}</option>)}</select>
        </label>
        <label className="field"><span>Why</span>
         <input ref={reasonRef} required maxLength={500} value={decision.reason} onChange={event=>{setDecision({...decision,reason:event.target.value});onDirty?.(true);}}/>
         <span className="subtle">Kept with the decision. This records a judgment only: no record, consent, receipt or permission changes.</span>
        </label>
        <div className="quality-decision-actions">
         <button className="btn btn-primary" type="submit">Confirm: record this decision only</button>
         <button className="btn btn-secondary" type="button" onClick={()=>{setDecision(null);onDirty?.(false);}}>Cancel</button>
        </div>
       </fieldset>
      </form>:
      <button className="btn btn-secondary quality-decide" type="button" onClick={()=>setDecision({key,kind:reviewKind,digest:finding.digest,decision:'Accepted for review',reason:''})}>Record a review decision…</button>)}
    </li>;
   })}</ul>}
  {panel&&findings?.length>0&&<p className="quality-note">Showing {findings.length} of {panel.matched} findings recomputed for {panel.computedFor||overview.computedFor}.</p>}
 </section>}

 {tab==='narrative'&&<section className="panel" id="quality-panel-narrative" role="tabpanel" aria-labelledby="quality-tab-narrative" tabIndex={-1}>
  <div className="section-title"><div><h2>Report narrative</h2><p>{provider?.reason}</p></div></div>
  {!provider?.available?<div className="empty-state"><h3>Assistance is off for this workspace</h3><p>{provider?.reason}</p><p>Every other finding on this screen is rule-based and stays available without it. No hosted model is contacted in any configuration.</p></div>:<>
   <p className="quality-note">Every figure below is an exact integer-cent value taken from the cited saved records. If a figure cannot be verified against those records, the narrative is refused rather than approximated.</p>
   <form onSubmit={compose} aria-busy={busy}><fieldset disabled={busy}><legend className="sr-only">Compose a narrative</legend><div className="form-grid">
    <label className="field"><span>Narrative</span><select value={form.kind} onChange={event=>{setForm({...form,kind:event.target.value});setNarrative(null);}}>{NARRATIVES.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>
    <label className="field"><span>Period starts</span><input type="date" required value={form.from} onChange={event=>{setForm({...form,from:event.target.value});onDirty?.(true);}}/><span className="subtle">At most three years, and every counted record is cited.</span></label>
    <label className="field"><span>Period ends</span><input type="date" required value={form.to} onChange={event=>{setForm({...form,to:event.target.value});onDirty?.(true);}}/></label>
    {form.kind==='giving-summary'&&<label className="field"><span>Designation (optional)</span><select value={form.designationId} onChange={event=>setForm({...form,designationId:event.target.value})}><option value="">All designations</option>{designations.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
   </div>
   <div className="quality-decision-actions"><button className="btn btn-primary" type="submit">Compose from saved records</button></div>
   </fieldset></form>

   {narrative&&<article className="quality-narrative" aria-label="Composed narrative">
    <p className="quality-narrative-text">{narrative.text}</p>
    <h4 className="quality-subhead">Every figure and where it came from</h4>
    <div className="quality-table-scroll"><table className="quality-figures-table"><caption className="sr-only">Figures in this narrative and the records they were taken from</caption>
     <thead><tr><th scope="col">Figure</th><th scope="col">Value</th><th scope="col">Cited records</th></tr></thead>
     <tbody>{narrative.figures.map(figure=><tr key={figure.key}><th scope="row" data-label="Figure">{figure.key}</th><td data-label="Value">{figure.rendered}</td><td data-label="Cited records">{figure.sources.length} saved {figure.sources.length===1?'record':'records'}</td></tr>)}</tbody>
    </table></div>
    <Sources sources={narrative.sources} onOpen={onOpen}/>
    <p className="quality-note">{narrative.statement} Composed by {narrative.provider}; no network request and no hosted model were used.</p>
   </article>}
  </>}
 </section>}

 {!overview.canReview&&<p className="quality-note">You can read every finding here. Recording a review decision requires an administrator or staff account.</p>}
 </>}
 </div>;
}
