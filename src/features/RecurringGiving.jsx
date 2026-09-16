import React,{useEffect,useRef,useState} from 'react';
import {RefreshCw,ArrowUpRight} from 'lucide-react';
import {cents,money} from '../lib.js';

const none=[],FREQUENCIES=['Monthly','Quarterly','Annual'],METHODS=['Check','Cash','Credit card','ACH','Payroll'];
const initial=()=>({kind:'Pledge',donorId:'',campaignId:'',designationId:'',amount:'',frequency:'Monthly',startDate:'',occurrences:'12',reason:''});
const utc=value=>value?new Date(value).toISOString().replace('T',' ').replace('Z',' UTC'):'—';
const KIND_LABEL={Pledge:'Pledge — a commitment',RecurringPayment:'Recurring payment — a collection instruction'};
const DUNNING_LABEL={None:'No recovery in progress',Retrying:'Bounded recovery in progress',Exhausted:'Recovery attempts exhausted — review required'};

export default function RecurringGiving({api,user,data,notify,onDirty,onOpen,onCommitted,onRefreshSources}){
 const role=user?.role,allowed=['admin','staff'].includes(role),canWrite=role==='admin';
 const people=data?.constituents||none,campaigns=data?.campaigns||none,funds=data?.designations||none;
 const [accessDenied,setAccessDenied]=useState(false),[provider,setProvider]=useState(null),[intentions,setIntentions]=useState([]),[cursor,setCursor]=useState(null),[detail,setDetail]=useState(null);
 const [draft,setDraft]=useState(initial),[review,setReview]=useState(null),[confirmed,setConfirmed]=useState(false);
 const [action,setAction]=useState(null),[reason,setReason]=useState(''),[manual,setManual]=useState({method:'Check',receivedDate:''});
 const [busy,setBusy]=useState(false),[blocked,setBlocked]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(''),[notice,setNotice]=useState(''),[link,setLink]=useState(null);
 const alive=useRef(true),generation=useRef(0),working=useRef(false),job=useRef(0),baseline=useRef(null),loaded=useRef(false),requestId=useRef(null),writeBlocked=useRef(false),actionReasonRef=useRef(null);
 const block=value=>{writeBlocked.current=value;setBlocked(value);};
 const selected=allowed?detail?.intention:null;
 const dirty=Boolean(draft.donorId||draft.campaignId||draft.designationId||draft.amount||draft.reason||reason||action);
 useEffect(()=>{onDirty?.(dirty);},[dirty,onDirty]);useEffect(()=>()=>onDirty?.(false),[onDirty]);
 const invalidate=()=>{setReview(null);setConfirmed(false);};
 const clear=(resetRequest=false)=>{if(resetRequest)requestId.current=null;setDraft(initial());setReason('');setAction(null);setLink(null);invalidate();};

 // An actual source revision change invalidates any pinned review immediately.
 useEffect(()=>{const fingerprint=JSON.stringify([people,campaigns,funds].map(rows=>rows.map(r=>[r.id,r.version]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))));
  if(fingerprint===baseline.current)return;baseline.current=fingerprint;generation.current++;invalidate();
  if(loaded.current){block(true);setNotice('Source records changed. Discard inputs, refresh workspace sources, then review current source versions again.');}},[people,campaigns,funds]);

 const current=epoch=>alive.current&&epoch===generation.current;
 async function read(path,epoch){try{const result=await api(path);return current(epoch)?result:null;}
  catch(e){if(current(epoch)&&[401,403,404].includes(e.status)){if([401,403].includes(e.status))setAccessDenied(true);setDetail(null);setIntentions([]);setProvider(null);block(true);}throw e;}}
 async function load(id=selected?.id,after=null){
  const epoch=++generation.current;
  const [status,list,saved]=await Promise.all([read('/recurring-giving/status',epoch),read('/recurring-giving/intentions?limit=100'+(after?'&after='+encodeURIComponent(after):''),epoch),id?read('/recurring-giving/intentions/'+id,epoch):Promise.resolve(null)]);
  if(!current(epoch)||!status||!list)return;
  if(after&&list.intentions.some(r=>intentions.some(old=>old.id===r.id&&old.version!==r.version))){block(true);throw new Error('Saved recurring intentions changed between pages. Reload saved history before continuing.');}
  setProvider(status);setIntentions(old=>after?[...old,...list.intentions.filter(r=>!old.some(x=>x.id===r.id))]:list.intentions);
  setCursor(list.nextCursor);setDetail(saved);block(false);setConflict('');loaded.current=true;requestId.current=null;return true;
 }
 async function perform(fn){if(working.current)return;const task=++job.current;working.current=true;setBusy(true);setError('');let epoch=generation.current;
  try{const pending=fn();epoch=generation.current;await pending;}catch(e){if(current(epoch)){setError(e.message);invalidate();}}
  finally{if(task===job.current){working.current=false;if(alive.current)setBusy(false);}}}
 useEffect(()=>{alive.current=true;working.current=false;clear(true);setProvider(null);setDetail(null);setIntentions([]);loaded.current=false;setAccessDenied(false);
  if(allowed)perform(()=>load(null));
  return()=>{alive.current=false;generation.current++;job.current++;working.current=false;};},[api,allowed,user?.id]);

 const collectionReady=allowed&&provider?.enabled===true&&provider.mode==='TEST_ONLY';
 const change=patch=>{setDraft(old=>({...old,...patch}));invalidate();};

 function reviewIntention(){setError('');setConflict('');
  try{
   const donor=people.find(r=>r.id===draft.donorId),campaign=campaigns.find(r=>r.id===draft.campaignId),fund=funds.find(r=>r.id===draft.designationId),amountCents=cents(draft.amount);
   if(!donor||donor.mergedInto||!campaign||campaign.status!=='Active'||!fund)throw new Error('Choose existing donor, active campaign and designation records.');
   if(amountCents<100||amountCents>1e8)throw new Error('Use an exact amount from $1.00 to $1,000,000.00.');
   if(!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate))throw new Error('Choose the first scheduled date.');
   const occurrences=draft.occurrences===''?null:Number(draft.occurrences);
   if(occurrences!==null&&(!Number.isInteger(occurrences)||occurrences<1||occurrences>120))throw new Error('Choose 1 to 120 committed occurrences, or leave it open-ended.');
   if(draft.kind==='RecurringPayment'&&!collectionReady)throw new Error('A collection instruction needs a configured test adapter. Record a pledge commitment and enter its gifts manually.');
   if(!draft.reason.trim())throw new Error('Record the reason for this reviewed commitment.');
   requestId.current??=globalThis.crypto.randomUUID();
   setReview({requestId:requestId.current,kind:draft.kind,donorId:donor.id,donorVersion:donor.version,campaignId:campaign.id,campaignVersion:campaign.version,designationId:fund.id,designationVersion:fund.version,amountCents,currency:'usd',frequency:draft.frequency,startDate:draft.startDate,occurrences,reason:draft.reason.trim(),reviewConfirmed:true});
   setConfirmed(false);
  }catch(e){setError(e.message);invalidate();}}

 async function commit(path,body,message,{refreshSources=false}={}){
  if(working.current||writeBlocked.current)return;
  const task=++job.current;working.current=true;setBusy(true);setError('');setConflict('');setNotice('');
  const epoch=generation.current;
  try{
   const result=await api(path,{method:'POST',body});
   if(!current(epoch))return;
   clear(true);setNotice(message);
   if(result.token)setLink({token:result.token,expiresAt:result.expiresAt});
   const syncEpoch=generation.current+1;let refreshed=false;
   try{refreshed=await load(result.intention?.id||result.collection?.intentionId||selected?.id);}
   catch{if(current(syncEpoch)){block(true);setError('The change was saved, but saved history could not refresh. Inspect saved history before any further action.');}}
   if(refreshed&&current(syncEpoch)&&refreshSources)Promise.resolve(onCommitted?.()).catch(()=>{if(current(syncEpoch)){block(true);setError('The gift was recorded, but workspace sources could not refresh. Refresh workspace sources before opening it.');}});
   if(refreshed&&current(syncEpoch))notify?.(message);
  }catch(e){
   if(current(epoch)){
    invalidate();block(true);
    if(e.status===409){setConflict('This action conflicts with the saved record: '+e.message+' Reload saved history and review current facts before retrying.');}
    else if([401,403].includes(e.status)){setAccessDenied(true);setDetail(null);setIntentions([]);}
    else setError(e.status?'The action was not confirmed: '+e.message+' Inspect saved history before retrying.':'The response was not confirmed. Inspect saved history before retrying; nothing is repeated automatically.');
   }
  }finally{if(task===job.current){working.current=false;if(alive.current)setBusy(false);}}
 }
 async function inspect(id){await perform(async()=>{const epoch=++generation.current,result=await read('/recurring-giving/intentions/'+id,epoch);if(result){clear(true);setDetail(result);block(false);setNotice('');setConflict('');}});}

 const donor=people.find(r=>r.id===selected?.donorId),campaign=campaigns.find(r=>r.id===selected?.campaignId),fund=funds.find(r=>r.id===selected?.designationId);
 const sourceReady=Boolean(selected?.sourceCurrent&&donor&&campaign&&fund);
 const actionable=canWrite&&!busy&&!blocked&&!dirty;
 function actionBody(){
  if(!action)return null;
  if(action.type==='record-gift')return {version:action.collection.version,donorVersion:donor?.version,campaignVersion:campaign?.version,designationVersion:fund?.version,reason:reason.trim(),reviewConfirmed:true,...(selected.kind==='Pledge'?{method:manual.method,receivedDate:manual.receivedDate}:{})};
  if(action.type==='collect')return {version:action.collection.version,reason:reason.trim(),testModeConfirmed:true};
  if(action.type==='donor-link')return {version:selected.version,reason:reason.trim(),expiresInDays:30};
  return {version:selected.version,reason:reason.trim()};
 }
 function actionPath(){
  if(action.type==='record-gift'||action.type==='collect')return '/recurring-giving/collections/'+action.collection.id+'/'+action.type;
  return '/recurring-giving/intentions/'+selected.id+'/'+action.type;
 }
 const actionValid=()=>{
  if(!action||!reason.trim())return false;
  if(action.type==='record-gift'&&selected.kind==='Pledge')return Boolean(manual.method&&/^\d{4}-\d{2}-\d{2}$/.test(manual.receivedDate));
  if(action.type==='record-gift')return Boolean(donor&&campaign&&fund);
  return true;
 };
 const startAction=(type,collection=null)=>{setAction({type,collection});setReason('');setConfirmed(false);setManual({method:'Check',receivedDate:''});setError('');setConflict('');};
 // A reviewed action opens a panel below the register, so focus has to follow it.
 useEffect(()=>{if(action)actionReasonRef.current?.focus?.();},[action?.type,action?.collection?.id]);

 if(!allowed||accessDenied)return <section className="panel"><h1>Recurring giving</h1><p role="alert">Recurring giving requires administrator or staff access. No recurring records are loaded for this account.</p></section>;

 return <div className="recurring-giving">
  <div className="page-header"><div><h1>Recurring giving</h1><p>Distinguish a pledge commitment from a collection instruction, recover failed collections and settle each collection to exactly one reviewed gift.</p></div>
   <div className="header-actions">
    <button type="button" className="btn btn-secondary" disabled={busy||dirty||!onRefreshSources} onClick={()=>{if(!busy&&!dirty)onRefreshSources?.();}}>Refresh workspace sources</button>
    <button type="button" className="btn btn-secondary" disabled={busy||dirty} onClick={()=>perform(()=>load())}><RefreshCw size={16} aria-hidden="true"/>Refresh saved intentions</button>
   </div>
  </div>

  <p className="scope-banner">Manual entry and import remain the primary way to record giving. A schedule, a pledge commitment or a simulated collection is never income: income exists only when an explicit reviewed settlement posts one gift. No live payment provider is connected and no provider acceptance is claimed.</p>

  {provider&&!collectionReady&&<section className="panel"><h2>Simulated collection is unavailable</h2>
   <p>No test collection adapter is configured, so collection instructions cannot be created or attempted here. Pledge commitments remain available and their installments are recorded by reviewed manual entry.</p>
   <p className="table-note">Mode: {provider.mode} · configuration result: {provider.reasonCode||'Not ready'}. Retained history stays inspectable; no simulated payment is substituted.</p></section>}

  {error&&<div role="alert" className="error-banner"><p>{error}</p>
   {blocked&&requestId.current&&<p className="table-note">Retained review request: {requestId.current}. Inspect saved intentions before preparing another.</p>}
   {blocked&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{clear(true);perform(()=>load());}}>Discard inputs and inspect saved history</button>}</div>}
  {conflict&&<div role="alert" className="conflict-banner"><p>{conflict}</p>
   <button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{clear(true);perform(()=>load(selected?.id));}}>Reload saved history</button></div>}
  {notice&&!error&&!conflict&&<p role="status" className="table-note">{notice}</p>}
  {busy&&<p role="status" className="table-note">Working… no action is repeated automatically.</p>}

  <section className="panel"><div className="section-title"><div><h2>Recurring register</h2><p>Open a commitment or instruction to review its schedule, recovery state and settlements.</p></div>
   {canWrite&&<button type="button" className="btn btn-secondary" disabled={busy||dirty||blocked} onClick={()=>{clear(true);setDetail(null);}}>New recurring intention</button>}</div>
   {intentions.length?<div className="table-wrap"><table className="recurring-register"><caption className="sr-only">Saved recurring commitments and collection instructions</caption>
    <thead><tr><th scope="col">Donor / kind</th><th scope="col">Schedule</th><th scope="col">Status</th><th scope="col" className="money">Each</th><th scope="col" className="money">Recorded</th><th scope="col">Updated</th></tr></thead>
    <tbody>{intentions.map(i=><tr key={i.id}>
     <td data-label="Donor / kind"><button type="button" className="record-link" disabled={busy||dirty} onClick={()=>inspect(i.id)}>{i.donorName}</button><small className="cell-detail">{i.commitmentOnly?'Pledge':'Recurring payment'} · v{i.version}</small></td>
     <td data-label="Schedule">{i.frequency}{i.occurrences?' × '+i.occurrences:' · open-ended'}<small className="cell-detail">{i.nextDue?'Next '+i.nextDue:'No further dates'}</small></td>
     <td data-label="Status">{i.status}{i.dunning!=='None'&&<small className="cell-detail">{DUNNING_LABEL[i.dunning]}</small>}</td>
     <td data-label="Each" className="money">{money(i.amountCents)}</td><td data-label="Recorded" className="money">{money(i.recordedCashCents)}</td><td data-label="Updated">{utc(i.updatedAt)}</td></tr>)}</tbody></table></div>
    :<p className="empty-state">{busy?'Loading saved recurring history…':!loaded.current?'The saved recurring register is unavailable. Reload saved history to verify it.':'No recurring intentions are recorded. This is not a record of money received.'}</p>}
   {cursor&&<button type="button" className="btn btn-secondary" disabled={busy||dirty} onClick={()=>perform(()=>load(selected?.id,cursor))}>Load more intentions</button>}
  </section>

  {!selected&&canWrite&&<section className="panel"><h2>Review a new recurring intention</h2>
   <p>A pledge is a commitment to give. A recurring payment is an instruction to collect. Choose deliberately: neither records income.</p>
   {!loaded.current&&<p className="scope-banner" role="status">The saved recurring register could not be read, so an existing commitment for this donor cannot be shown here. Reload saved intentions before recording a new one, so the same commitment is not entered twice.</p>}
   <form onSubmit={e=>{e.preventDefault();if(review&&confirmed&&!blocked&&loaded.current)return commit('/recurring-giving/intentions',review,'Recurring intention saved. No income has been recorded.');}}>
    <fieldset disabled={busy||blocked||!loaded.current}><legend className="sr-only">New recurring intention</legend>
     <div className="form-grid">
      <label className="field">Intention kind<select value={draft.kind} onChange={e=>change({kind:e.target.value})}>
       <option value="Pledge">{KIND_LABEL.Pledge}</option>
       <option value="RecurringPayment" disabled={!collectionReady}>{KIND_LABEL.RecurringPayment}{collectionReady?'':' — unavailable'}</option></select>
       <small>{draft.kind==='Pledge'?'Installments are recorded by reviewed manual entry.':'Each occurrence is attempted through the configured test adapter and settled explicitly.'}</small></label>
      <label className="field">Donor<select required value={draft.donorId} onChange={e=>change({donorId:e.target.value})}>
       <option value="">Choose donor</option>{people.filter(r=>!r.mergedInto).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="field">Campaign<select required value={draft.campaignId} onChange={e=>change({campaignId:e.target.value})}>
       <option value="">Choose campaign</option>{campaigns.filter(r=>r.status==='Active').map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="field">Designation<select required value={draft.designationId} onChange={e=>change({designationId:e.target.value})}>
       <option value="">Choose designation</option>{funds.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="field">Amount each time · USD<input required inputMode="decimal" value={draft.amount} onChange={e=>change({amount:e.target.value})} placeholder="100.01"/><small>Exact cents. $1.00–$1,000,000.00.</small></label>
      <label className="field">Frequency<select value={draft.frequency} onChange={e=>change({frequency:e.target.value})}>{FREQUENCIES.map(f=><option key={f} value={f}>{f}</option>)}</select></label>
      <label className="field">First scheduled date<input required type="date" value={draft.startDate} onChange={e=>change({startDate:e.target.value})}/></label>
      <label className="field">Committed occurrences<input inputMode="numeric" value={draft.occurrences} onChange={e=>change({occurrences:e.target.value})} placeholder="12"/><small>Leave empty for an open-ended instruction.</small></label>
      <label className="field field-wide">Reason for this reviewed commitment<textarea required maxLength={2000} rows={2} value={draft.reason} onChange={e=>change({reason:e.target.value})}/></label>
     </div>
     <div className="form-actions">
      <button type="button" className="btn btn-secondary" onClick={reviewIntention}>Review this intention</button>
      <button type="button" className="text-btn" onClick={()=>clear(true)}>Cancel inputs</button></div>
     {review&&<div className="recurring-review"><h3>Review exact facts</h3>
      <p>{KIND_LABEL[review.kind]}<br/>{people.find(r=>r.id===review.donorId)?.name} · donor v{review.donorVersion}<br/>{campaigns.find(r=>r.id===review.campaignId)?.name} · campaign v{review.campaignVersion}<br/>{funds.find(r=>r.id===review.designationId)?.name} · designation v{review.designationVersion}</p>
      <strong className="money">{money(review.amountCents)} USD · {review.frequency}{review.occurrences?' × '+review.occurrences+' = '+money(review.amountCents*review.occurrences)+' committed':' · open-ended'}</strong>
      <p className="table-note">Saving this records a commitment or instruction only. It records no gift, sends nothing and issues no receipt.</p>
      <label className="recurring-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I reviewed these sources, the exact amount and the pledge versus recurring-payment distinction.</label></div>}
     <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={!review||!confirmed||busy||blocked}>Save reviewed intention</button></div>
    </fieldset></form></section>}

  {selected&&<>
   <section className="panel"><div className="section-title"><div><h2>{selected.donorName}</h2>
    <p>{KIND_LABEL[selected.kind]} · {selected.status} · v{selected.version}</p></div>
    <strong className="money">{money(selected.amountCents)} USD {selected.frequency.toLowerCase()}</strong></div>
    <dl className="recurring-facts">
     <div><dt>Campaign</dt><dd>{selected.campaignName} · source v{selected.sourceVersions?.campaign}</dd></div>
     <div><dt>Designation</dt><dd>{selected.designationName} · source v{selected.sourceVersions?.designation}</dd></div>
     <div><dt>Donor</dt><dd>{selected.donorName} · source v{selected.sourceVersions?.donor}</dd></div>
     <div><dt>Current sources</dt><dd>{selected.sourceCurrent?'Current':'Changed — review required'}</dd></div>
     <div><dt>Next scheduled date</dt><dd>{selected.nextDue||'No further dates'}</dd></div>
     <div><dt>Recovery state</dt><dd>{DUNNING_LABEL[selected.dunning]}</dd></div>
     <div><dt>Committed total</dt><dd>{selected.committedCents==null?'Open-ended':money(selected.committedCents)}</dd></div>
     <div><dt>Recorded income</dt><dd>{money(selected.recordedCashCents)}</dd></div>
    </dl>
    {!selected.sourceCurrent&&<p className="scope-banner" role="alert">The original donor, campaign, designation or recovery authority changed. No collection or settlement is offered until this is reviewed.</p>}
    {canWrite&&<div className="form-actions">
     {selected.status==='Active'&&<button type="button" className="btn btn-secondary" disabled={!actionable} onClick={()=>startAction('pause')}>Review pause</button>}
     {['Paused','ReviewRequired'].includes(selected.status)&&<button type="button" className="btn btn-secondary" disabled={!actionable||!sourceReady} onClick={()=>startAction('resume')}>Review resume</button>}
     {selected.status!=='Cancelled'&&<button type="button" className="btn btn-secondary" disabled={!actionable} onClick={()=>startAction('cancel')}>Review cancellation</button>}
     {selected.status!=='Cancelled'&&!selected.donorTokenIssued&&<button type="button" className="btn btn-secondary" disabled={!actionable} onClick={()=>startAction('donor-link')}>Issue donor self-service link</button>}
    </div>}
    {link&&<div className="recurring-link"><h3>Donor self-service link</h3>
     <p className="table-note">Shown once and never stored in readable form. Nothing has been sent: share it through a reviewed channel. It only views or cancels this one intention.</p>
     <code className="recurring-token">{link.token}</code><p className="table-note">Expires {utc(link.expiresAt)}</p></div>}
   </section>

   <section className="panel"><h2>Scheduled collections</h2>
    <p className="table-note">Each scheduled occurrence settles to at most one posted gift. A simulated collection is evidence, not income.</p>
    {selected.collections.length?<div className="table-wrap"><table className="recurring-collections"><caption className="sr-only">Scheduled occurrences for this recurring intention</caption>
     <thead><tr><th scope="col">#</th><th scope="col">Scheduled</th><th scope="col">Status</th><th scope="col" className="money">Amount</th><th scope="col">Attempts</th><th scope="col">Gift</th>{canWrite&&<th scope="col">Reviewed action</th>}</tr></thead>
     <tbody>{selected.collections.map(c=><tr key={c.id}>
      <td data-label="Occurrence">{c.sequence}</td><td data-label="Scheduled">{c.scheduledFor}</td>
      <td data-label="Status">{c.status}{c.lastErrorCode&&<small className="cell-detail">{c.lastErrorCode}</small>}</td>
      <td data-label="Amount" className="money">{money(c.amountCents)}</td>
      <td data-label="Attempts">{c.attemptCount} of {c.maxAttempts}{c.nextAttempt&&<small className="cell-detail">Retry after {utc(c.nextAttempt)}</small>}</td>
      <td data-label="Gift">{c.giftId?<button type="button" className="record-link" disabled={busy||dirty||!onOpen} onClick={()=>perform(()=>onOpen?.('gifts',c.giftId,c.giftVersion))}>Open gift · {money(c.recordedCashCents)}<ArrowUpRight size={14} aria-hidden="true"/></button>:'Not recorded'}</td>
      {canWrite&&<td data-label="Reviewed action">
       {selected.kind==='RecurringPayment'&&['Scheduled','AttemptFailed','Unknown'].includes(c.status)&&<button type="button" className="btn btn-secondary" disabled={!actionable||!sourceReady||!collectionReady||selected.status!=='Active'} onClick={()=>startAction('collect',c)}>Attempt collection</button>}
       {(selected.kind==='Pledge'?c.status==='Scheduled':c.status==='Collected')&&!c.giftId&&<button type="button" className="btn btn-primary" disabled={!actionable||!sourceReady} onClick={()=>startAction('record-gift',c)}>Review settlement</button>}
       {c.status==='ReviewRequired'&&<span className="cell-detail">Manual financial review required</span>}
      </td>}</tr>)}</tbody></table></div>
     :<p className="empty-state">No occurrences are scheduled yet.</p>}
   </section>

   {action&&canWrite&&<section className="panel"><h2>{{pause:'Review pause',resume:'Review resume',cancel:'Review cancellation','donor-link':'Issue donor self-service link',collect:'Review simulated collection','record-gift':'Review settlement'}[action.type]}</h2>
    <p>{{
     pause:'Pausing stops future scheduling. Retained history and any posted gifts are unchanged.',
     resume:'Resuming moves the schedule forward to the next future date. It posts no income and creates no missed back-charges.',
     cancel:'Cancelling is permanent and cannot be reversed. Gifts already posted are retained and unchanged.',
     'donor-link':'This mints one signed link that lets the donor view or cancel only this intention. It cannot browse constituents, see other donors or change consent. Issuing it sends nothing.',
     collect:'This attempts one simulated collection through the configured test adapter. It records evidence only and never posts income. A failure schedules a bounded retry.',
     'record-gift':'This posts exactly one gift for this one occurrence. Authority, tenant status and source revisions are rechecked at execution. It issues no receipt and sends no acknowledgment.'}[action.type]}</p>
    {action.type==='record-gift'&&<p className="recurring-review"><strong className="money">{money(action.collection.amountCents)} USD</strong> · {donor?.name||'Donor unavailable'} v{donor?.version??'—'} · {campaign?.name||'Campaign unavailable'} v{campaign?.version??'—'} · {fund?.name||'Designation unavailable'} v{fund?.version??'—'}</p>}
    <form onSubmit={e=>{e.preventDefault();if(actionValid()&&!blocked)return commit(actionPath(),actionBody(),{pause:'Recurring intention paused.',resume:'Recurring intention resumed.',cancel:'Recurring intention cancelled. Posted gifts are unchanged.','donor-link':'Donor self-service link issued. Nothing was sent.',collect:'Simulated collection attempted. No income was recorded.','record-gift':'One gift was recorded for this occurrence.'}[action.type],{refreshSources:action.type==='record-gift'});}}>
     <fieldset disabled={busy||blocked}><legend className="sr-only">Reviewed recurring action</legend>
      {action.type==='record-gift'&&selected.kind==='Pledge'&&<div className="form-grid">
       <label className="field">Payment method actually received<select value={manual.method} onChange={e=>setManual(o=>({...o,method:e.target.value}))}>{METHODS.map(m=><option key={m} value={m}>{m}</option>)}</select></label>
       <label className="field">Date actually received<input required type="date" value={manual.receivedDate} onChange={e=>setManual(o=>({...o,receivedDate:e.target.value}))}/></label></div>}
      <label className="field">Reason for this reviewed action<textarea ref={actionReasonRef} required maxLength={2000} rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <div className="form-actions">
       <button type="button" className="btn btn-secondary" onClick={()=>{setAction(null);setReason('');}}>Cancel this action</button>
       <button type="submit" className="btn btn-primary" disabled={!actionValid()||busy||blocked}>{action.type==='record-gift'?'Record one reviewed gift':'Confirm reviewed action'}</button></div>
     </fieldset></form></section>}

   <section className="panel"><h2>Retained history</h2>
    <p className="table-note">{detail.historyCount==null?'Reload saved history to verify action counts.':detail.history.length+' of '+detail.historyCount+' actions · latest '+(detail.historyLimit||100)}</p>
    {detail.history?.length?<ol className="recurring-history">{detail.history.map(h=><li key={h.id}>
     <strong>{h.action} · {h.status} · v{h.version}</strong><p>{h.reason}</p>
     <small>{utc(h.at)} · {h.actor}{h.errorCode?' · '+h.errorCode:''}</small></li>)}</ol>
     :<p className="empty-state">{detail.historyCount==null?'History is awaiting refresh; no empty-history claim is made.':'No history actions returned.'}</p>}
   </section></>}
 </div>;
}
