import React,{useEffect,useRef,useState} from 'react';
import {RefreshCw,ArrowUpRight} from 'lucide-react';
import {money} from '../lib.js';
// Reviewed local campaigns only. Nothing on this screen claims provider
// delivery: a recorded handoff to the TEST_ONLY transport is not a send.
const none=[];
const newCampaign=()=>({name:'',classification:'Marketing',channel:'Email',templateId:''});
const newConsent=()=>({constituentId:'',channel:'Email',purpose:'Marketing',state:'Granted',basis:''});
const utc=value=>value?new Date(value).toISOString().replace('T',' ').replace('Z',' UTC'):'—';
const purposeOf=classification=>classification==='Marketing'?'Marketing':'Transactional';

export default function Messaging({api,user,data,notify,onDirty,onOpen,onCommitted}){
 const allowed=['admin','staff'].includes(user?.role),isAdmin=user?.role==='admin',people=data?.constituents||none;
 const [accessDenied,setAccessDenied]=useState(false),[status,setStatus]=useState(null),[templates,setTemplates]=useState([]),[campaigns,setCampaigns]=useState([]),[detail,setDetail]=useState(null),[suppressions,setSuppressions]=useState([]),[queue,setQueue]=useState([]),[queueReason,setQueueReason]=useState(''),[queueConfirmed,setQueueConfirmed]=useState(false);
 const [draft,setDraft]=useState(newCampaign),[consentDraft,setConsentDraft]=useState(newConsent),[selection,setSelection]=useState([]),[reviewReason,setReviewReason]=useState(''),[reviewConfirmed,setReviewConfirmed]=useState(false);
 const [sendReason,setSendReason]=useState(''),[sendConfirmed,setSendConfirmed]=useState(false),[gift,setGift]=useState({recipientId:'',giftId:'',reason:''});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(''),[notice,setNotice]=useState(''),[blocked,setBlocked]=useState(false);
 const alive=useRef(true),generation=useRef(0),working=useRef(false),loaded=useRef(false),executionKey=useRef(null),writeBlocked=useRef(false),registerRef=useRef(null);
 const dirty=Boolean(draft.name||draft.templateId||consentDraft.constituentId||consentDraft.basis||selection.length||reviewReason||sendReason||queueReason||gift.giftId||gift.reason);
 useEffect(()=>{onDirty?.(dirty);},[dirty,onDirty]);useEffect(()=>()=>onDirty?.(false),[onDirty]);
 const block=value=>{writeBlocked.current=value;setBlocked(value);};
 const current=epoch=>alive.current&&epoch===generation.current;
 const selected=allowed?detail?.campaign:null;
 const ready=Boolean(status?.enabled&&status.mode==='TEST_ONLY');

 async function read(path,epoch){try{return await api(path);}catch(e){if(current(epoch)&&[401,403].includes(e.status)){setAccessDenied(true);setDetail(null);setCampaigns([]);setStatus(null);block(true);}throw e;}}
 async function load(id=selected?.id){
  const epoch=++generation.current;
  const [provider,list,templateList,denials,queued,saved]=await Promise.all([read('/messaging/status',epoch),read('/messaging/campaigns',epoch),read('/correspondence/templates',epoch),read('/messaging/suppressions',epoch),read('/messaging/queue',epoch),id?read('/messaging/campaigns/'+id,epoch):Promise.resolve(null)]);
  if(!current(epoch))return null;
  setStatus(provider);setCampaigns(list.campaigns);setTemplates((templateList.templates||[]).filter(t=>t.kind==='Messaging'));setSuppressions(denials.suppressions||[]);setQueue(queued.queue||[]);setDetail(saved);loaded.current=true;block(false);setConflict('');
  return true;
 }
 async function perform(fn){if(working.current)return;working.current=true;setBusy(true);setError('');setConflict('');const epoch=generation.current;try{await fn();}catch(e){if(current(epoch)){if(e.status===409)setConflict(e.message);else setError(e.status?e.message:'The workspace did not respond. Reload saved campaigns before retrying; nothing is repeated automatically.');}}finally{working.current=false;if(alive.current)setBusy(false);}}
 async function commit(path,body,message,{resetKey=true}={}){
  if(working.current||writeBlocked.current)return;
  working.current=true;setBusy(true);setError('');setConflict('');setNotice('');
  const epoch=generation.current;
  try{
   const result=await api(path,{method:'POST',body});
   if(!current(epoch))return;
   const id=result.campaign?.id||result.attribution?.campaignId||selected?.id;
   setDraft(newCampaign());setConsentDraft(newConsent());setSelection([]);setReviewReason('');setSendReason('');setQueueReason('');setReviewConfirmed(false);setSendConfirmed(false);setQueueConfirmed(false);setGift({recipientId:'',giftId:'',reason:''});
   if(resetKey)executionKey.current=null;
   setNotice(message);notify?.(message);
   try{await load(id);}catch{block(true);setError('The change was saved, but saved campaigns could not refresh. Reload before any further action.');}
   if(result.attribution)await Promise.resolve(onCommitted?.()).catch(()=>{});
  }catch(e){
   if(current(epoch)){
    if(e.status===409)setConflict(e.message+' Reload the saved campaign and review it again.');
    else if(e.status===429)setError('The messaging rate limit for this minute is reached. Nothing further was handed to the transport.');
    else if(e.status)setError(e.message);
    else {block(true);setError('The response was not confirmed. Reload saved campaigns and inspect retained handoff evidence before retrying; nothing is repeated automatically.');}
   }
  }finally{working.current=false;if(alive.current)setBusy(false);}
 }
 useEffect(()=>{alive.current=true;working.current=false;loaded.current=false;setAccessDenied(false);setDetail(null);setCampaigns([]);setStatus(null);executionKey.current=null;
  if(allowed)perform(()=>load(null));
  return()=>{alive.current=false;generation.current++;working.current=false;};},[api,allowed,user?.id]);

 const toggle=id=>{setSelection(old=>old.includes(id)?old.filter(x=>x!==id):[...old,id]);setReviewConfirmed(false);};
 const eligible=people.filter(p=>!p.mergedInto&&p.preference!=='Do not contact');
 const recipientsOf=selected?.recipients||none;
 const canReview=selected?.status==='Draft',canSend=['Reviewed','Executing'].includes(selected?.status),canAttribute=['Executing','Executed'].includes(selected?.status);
 function startExecution(){if(!executionKey.current)executionKey.current=globalThis.crypto.randomUUID();return executionKey.current;}

 if(!allowed)return <section className="panel messaging-denied"><h1>Email &amp; SMS campaigns</h1><p role="alert">Reviewing and sending messages requires staff or administrator access. Your role can read prepared correspondence instead.</p></section>;
 if(accessDenied)return <section className="panel messaging-denied"><h1>Email &amp; SMS campaigns</h1><p role="alert">Your account access changed. Sign in again to review retained messaging evidence. No recipient details are shown.</p></section>;

 return <div className="messaging-workspace">
  <div className="page-header"><div><h1>Email &amp; SMS campaigns</h1><p>Record consent, review an exact recipient set, then execute only through an explicitly configured transport.</p></div>
   <div className="header-actions"><button type="button" className="btn btn-secondary" disabled={busy||dirty} onClick={()=>perform(()=>load())}><RefreshCw size={16} aria-hidden="true"/>Refresh saved campaigns</button></div></div>
  <p className="scope-banner">Consent and suppression are explicit ledgers. Contact preference is not marketing consent, a retained suppression is never cleared here, and a recorded transport handoff is not provider delivery, an open or human readership.</p>

  <section className="panel messaging-transport" aria-labelledby="messaging-transport-heading">
   <h2 id="messaging-transport-heading">Transport</h2>
   {status===null?<p role="status" className="empty-state">{busy?'Checking the configured transport…':'Transport readiness is unavailable. Refresh saved campaigns to verify it.'}</p>:
    ready?<dl className="messaging-facts"><div><dt>Mode</dt><dd>{status.mode}</dd></div><div><dt>Channels</dt><dd>{(status.channels||none).join(' · ')||'None'}</dd></div><div><dt>Authorization</dt><dd>{status.authorizationReference||'Not recorded'}</dd></div><div><dt>Rate limit</dt><dd>{status.rateLimitPerMinute} per minute</dd></div></dl>:
    <p role="status">No messaging transport is configured for this workspace. Campaigns can still be drafted and reviewed; nothing can be sent. Production transports stay refused until a provider, residency review and authorization are recorded on the server.</p>}
  </section>

  {error&&<div role="alert" className="error-banner messaging-alert"><p>{error}</p>{blocked&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setDraft(newCampaign());setSelection([]);perform(()=>load());}}>Discard inputs and reload saved campaigns</button>}</div>}
  {conflict&&<div role="alert" className="messaging-conflict"><p>{conflict}</p><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>perform(()=>load(selected?.id))}>Reload the saved campaign</button></div>}
  {notice&&<p role="status" className="table-note messaging-notice">{notice}</p>}

  <section className="panel" aria-labelledby="messaging-register-heading">
   <div className="section-title"><div><h2 id="messaging-register-heading" ref={registerRef} tabIndex={-1}>Reviewed campaigns</h2><p>Open a campaign to inspect its frozen recipient set, retained handoff evidence and outcomes.</p></div>
    <button type="button" className="btn btn-secondary" disabled={busy||dirty} onClick={()=>{setDetail(null);setSelection([]);}}>New campaign</button></div>
   {campaigns.length?<div className="table-wrap"><table className="messaging-register" aria-label="Reviewed messaging campaigns"><thead><tr><th scope="col">Campaign</th><th scope="col">Purpose</th><th scope="col">Channel</th><th scope="col">State</th><th scope="col" className="numeric">Recipients</th><th scope="col">Updated</th></tr></thead>
    <tbody>{campaigns.map(row=><tr key={row.id}><td data-label="Campaign"><button type="button" className="record-link" disabled={busy||dirty} onClick={()=>perform(async()=>{const saved=await read('/messaging/campaigns/'+row.id,generation.current);if(saved){setDetail(saved);setNotice('');}})}>{row.name}</button><small className="cell-detail">v{row.version}</small></td>
     <td data-label="Purpose">{row.classification}</td><td data-label="Channel">{row.channel}</td><td data-label="State">{row.status}</td><td data-label="Recipients" className="numeric">{row.recipientCount}</td><td data-label="Updated">{utc(row.updatedAt)}</td></tr>)}</tbody></table></div>:
    <p className="empty-state">{busy?'Loading saved campaigns…':!loaded.current?'The saved campaign register is unavailable. Reload it to verify what exists.':'No campaign has been reviewed in this workspace.'}</p>}
  </section>

  <section className="panel" aria-labelledby="messaging-consent-heading">
   <h2 id="messaging-consent-heading">Consent and suppression ledgers</h2>
   <p>Consent is recorded per channel and purpose. A withdrawal, complaint, bounce or opt-out is retained permanently and cannot be cleared here.</p>
   <form onSubmit={e=>{e.preventDefault();if(consentDraft.constituentId&&consentDraft.basis.trim())return commit('/messaging/consent',{constituentId:consentDraft.constituentId,constituentVersion:people.find(p=>p.id===consentDraft.constituentId)?.version,channel:consentDraft.channel,purpose:consentDraft.purpose,state:consentDraft.state,basis:consentDraft.basis.trim(),confirmed:true},'Consent evidence recorded. It does not override a retained suppression.');}}>
    <fieldset disabled={busy||blocked}><legend className="sr-only">Record consent evidence</legend><div className="form-grid">
     <label className="field">Constituent<select required value={consentDraft.constituentId} onChange={e=>setConsentDraft({...consentDraft,constituentId:e.target.value})}><option value="">Choose a constituent</option>{eligible.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
     <label className="field">Channel<select value={consentDraft.channel} onChange={e=>setConsentDraft({...consentDraft,channel:e.target.value})}><option>Email</option><option>SMS</option></select></label>
     <label className="field">Purpose<select value={consentDraft.purpose} onChange={e=>setConsentDraft({...consentDraft,purpose:e.target.value})}><option>Marketing</option><option>Transactional</option></select></label>
     <label className="field">Recorded state<select value={consentDraft.state} onChange={e=>setConsentDraft({...consentDraft,state:e.target.value})}><option>Granted</option><option>Withdrawn</option></select></label>
     <label className="field field-wide">Evidence of this decision<input required maxLength={500} value={consentDraft.basis} onChange={e=>setConsentDraft({...consentDraft,basis:e.target.value})} placeholder="Where and when the constituent gave or withdrew this permission"/></label>
    </div><div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy||blocked||!consentDraft.constituentId||!consentDraft.basis.trim()}>Record consent evidence</button></div></fieldset></form>
   {suppressions.length?<ul className="messaging-suppressions">{suppressions.map(s=><li key={s.id}><strong>{s.reason}</strong><span>{s.channel} · {s.addressMasked} · applies to {s.scope==='All'?'every message':'marketing only'}</span><small>{utc(s.at)}</small></li>)}</ul>:<p className="empty-state">No suppression is retained for this workspace.</p>}
  </section>

  <section className="panel" aria-labelledby="messaging-queue-heading">
   <h2 id="messaging-queue-heading">Operational reminder queue</h2>
   <p>Transactional reminders requested by the volunteer, event and task services. They never use marketing consent, a marketing unsubscribe never blocks one, and a queued row is a durable request, not a sent message.</p>
   {queue.length?<div className="table-wrap"><table className="messaging-queue" aria-label="Operational reminder queue"><thead><tr><th scope="col">Reminder</th><th scope="col">Channel</th><th scope="col">State</th><th scope="col">Queued</th></tr></thead>
    <tbody>{queue.map(row=><tr key={row.id}><td data-label="Reminder">{row.purpose}<small className="cell-detail">{row.reference} · {row.classification}</small></td><td data-label="Channel">{row.channel}</td><td data-label="State">{row.status}<small className="cell-detail">{row.delivery}</small>{row.lastError?<small className="cell-detail">{row.lastError}</small>:null}</td><td data-label="Queued">{utc(row.queuedAt)}</td></tr>)}</tbody></table></div>:
    <p className="empty-state">{busy?'Loading the operational reminder queue…':!loaded.current?'The operational reminder queue is unavailable. Reload saved campaigns to verify it.':'No operational reminder is queued.'}</p>}
   {isAdmin&&queue.some(row=>row.status==='Queued')&&(ready?
    <form onSubmit={e=>{e.preventDefault();if(queueConfirmed&&queueReason.trim())return commit('/messaging/queue/execute',{reason:queueReason.trim(),confirmed:true},'Queued operational reminders were handed to the transport. Retained evidence records a handoff only, never provider delivery.');}}>
     <fieldset disabled={busy||blocked}><legend className="sr-only">Hand queued operational reminders to the transport</legend>
      <label className="field field-wide">Reason for running the queue<textarea required rows={2} maxLength={2000} value={queueReason} onChange={e=>{setQueueReason(e.target.value);setQueueConfirmed(false);}}/></label>
      <label className="check-field"><input type="checkbox" checked={queueConfirmed} onChange={e=>setQueueConfirmed(e.target.checked)}/>Contact preference, address and retained suppression are checked again for each reminder now. Anything denied is refused and recorded, never sent.</label>
      <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy||blocked||!queueConfirmed||!queueReason.trim()}>Hand queued reminders to the transport</button></div></fieldset></form>:
    <p role="status">No transport is configured, so queued reminders stay queued. They are retained and nothing is sent.</p>)}
  </section>

  {!selected&&<section className="panel" aria-labelledby="messaging-new-heading">
   <h2 id="messaging-new-heading">Draft a campaign</h2>
   <p>Wording comes from a reviewed Messaging template. Drafting and reviewing never send anything.</p>
   <form onSubmit={e=>{e.preventDefault();if(draft.name.trim()&&draft.templateId)return commit('/messaging/campaigns',{name:draft.name.trim(),classification:draft.classification,channel:draft.channel,templateId:draft.templateId,templateVersion:templates.find(t=>t.id===draft.templateId)?.version,reason:'Reviewed draft campaign',confirmed:true},'Campaign drafted. Review its recipients before anything can be sent.');}}>
    <fieldset disabled={busy||blocked}><legend className="sr-only">Draft a reviewed campaign</legend><div className="form-grid">
     <label className="field">Campaign name<input required maxLength={250} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
     <label className="field">Purpose<select value={draft.classification} onChange={e=>setDraft({...draft,classification:e.target.value})}><option>Marketing</option><option>Transactional</option></select><small>Recipients must hold explicit {purposeOf(draft.classification).toLowerCase()} consent for the chosen channel.</small></label>
     <label className="field">Channel<select value={draft.channel} onChange={e=>setDraft({...draft,channel:e.target.value})}>{(status?.channels||['Email']).map(channel=><option key={channel}>{channel}</option>)}</select></label>
     <label className="field">Reviewed template<select required value={draft.templateId} onChange={e=>setDraft({...draft,templateId:e.target.value})}><option value="">Choose a Messaging template</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}</select>{!templates.length&&<small>No Messaging template exists yet. Create one on the Letters &amp; statements screen.</small>}</label>
    </div><div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy||blocked||!draft.name.trim()||!draft.templateId}>Draft campaign</button></div></fieldset></form>
  </section>}

  {selected&&<>
   <section className="panel" aria-labelledby="messaging-detail-heading">
    <div className="section-title"><div><h2 id="messaging-detail-heading">{selected.name}</h2><p>{selected.status} · v{selected.version} · {selected.classification} · {selected.channel}</p></div>
     <button type="button" className="btn btn-secondary" disabled={busy||dirty} onClick={()=>{setDetail(null);setSelection([]);registerRef.current?.focus?.();}}>Close campaign</button></div>
    <dl className="messaging-facts">
     <div><dt>Reviewed recipients</dt><dd>{selected.recipientCount}</dd></div>
     <div><dt>Handed to transport</dt><dd>{selected.sentCount??0}</dd></div>
     <div><dt>Still reviewed</dt><dd>{selected.pendingCount??0}</dd></div>
     <div><dt>Refused or failed</dt><dd>{selected.failedCount??0}</dd></div>
     <div><dt>Reviewed sources</dt><dd>{selected.recipientCount===0?'No recipient reviewed':selected.sourceCurrent?'Current':'Changed — review again'}</dd></div>
     <div><dt>Transport authorization</dt><dd>{selected.configCurrent?'Unchanged since review':'Changed since review'}</dd></div>
    </dl>
    <p className="table-note">{selected.delivery}</p>
    {selected.staleRecipients?.length>0&&<p role="alert" className="messaging-conflict">{selected.staleRecipients.length} reviewed recipient(s) changed after review: {selected.staleRecipients[0].reason}. Execution refuses the whole campaign rather than skipping anyone.</p>}
    {recipientsOf.length>0&&<div className="table-wrap"><table className="messaging-recipients" aria-label="Reviewed recipient snapshot"><thead><tr><th scope="col">Recipient</th><th scope="col">Address</th><th scope="col">State</th><th scope="col" className="numeric">Attempts</th></tr></thead>
     <tbody>{recipientsOf.map(r=><tr key={r.id}><td data-label="Recipient">{people.find(p=>p.id===r.constituentId)?.name||'Retained recipient'}<small className="cell-detail">source v{r.constituentVersion}</small></td><td data-label="Address">{r.addressMasked}</td><td data-label="State">{r.status}{r.lastError?<small className="cell-detail">{r.lastError}</small>:null}</td><td data-label="Attempts" className="numeric">{r.attemptCount}</td></tr>)}</tbody></table></div>}
   </section>

   {canReview&&<section className="panel" aria-labelledby="messaging-review-heading">
    <h2 id="messaging-review-heading">Review the exact recipient set</h2>
    <p>Only explicitly selected, eligible and consented constituents are frozen. If any selection is ineligible, nothing is reviewed.</p>
    <form onSubmit={e=>{e.preventDefault();if(selection.length&&reviewConfirmed&&reviewReason.trim())return commit('/messaging/campaigns/'+selected.id+'/review',{version:selected.version,constituentIds:selection,reason:reviewReason.trim(),confirmed:true},'Recipient set, consent state and source versions frozen. Nothing has been sent.');}}>
     <fieldset disabled={busy||blocked}><legend className="sr-only">Select reviewed recipients</legend>
      <ul className="messaging-selection">{eligible.map(p=><li key={p.id}><label><input type="checkbox" aria-label={'Select recipient '+p.name} checked={selection.includes(p.id)} onChange={()=>toggle(p.id)}/><span>{p.name}</span><small>source v{p.version}</small></label></li>)}</ul>
      {!eligible.length&&<p className="empty-state">No constituent is currently contactable. Record consent and a contact preference first.</p>}
      <label className="field field-wide">Reason for this reviewed selection<textarea required rows={2} maxLength={2000} value={reviewReason} onChange={e=>{setReviewReason(e.target.value);setReviewConfirmed(false);}}/></label>
      <label className="check-field"><input type="checkbox" checked={reviewConfirmed} onChange={e=>setReviewConfirmed(e.target.checked)}/>I reviewed these {selection.length} recipients, their recorded {purposeOf(selected.classification).toLowerCase()} consent and their current source versions.</label>
      <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy||blocked||!selection.length||!reviewConfirmed||!reviewReason.trim()}>Freeze reviewed recipients</button></div></fieldset></form>
   </section>}

   {canSend&&<section className="panel" aria-labelledby="messaging-execute-heading">
    <h2 id="messaging-execute-heading">Execute the reviewed campaign</h2>
    {!isAdmin?<p role="status">Executing a reviewed campaign requires administrator access. The reviewed snapshot is retained until an administrator executes or cancels it.</p>:
     !ready?<p role="status">No transport is configured, so this reviewed campaign cannot be executed. Nothing will be sent.</p>:
     <form onSubmit={e=>{e.preventDefault();if(sendConfirmed&&sendReason.trim())return commit('/messaging/campaigns/'+selected.id+'/execute',{version:selected.version,snapshotDigest:selected.snapshotDigest,idempotencyKey:startExecution(),reason:sendReason.trim(),confirmed:true},'Execution finished. Retained evidence records a transport handoff only, never provider delivery.',{resetKey:true});}}>
      <fieldset disabled={busy||blocked}><legend className="sr-only">Execute the reviewed campaign</legend>
       <p className="table-note">Tenant status, your authority, the reviewing account, consent, suppression, wording and every source version are checked again now. Anything stale refuses the whole execution; no recipient is silently skipped, and no recipient is ever handed to the transport twice.</p>
       <label className="field field-wide">Reason for executing this reviewed campaign<textarea required rows={2} maxLength={2000} value={sendReason} onChange={e=>{setSendReason(e.target.value);setSendConfirmed(false);}}/></label>
       <label className="check-field"><input type="checkbox" checked={sendConfirmed} onChange={e=>setSendConfirmed(e.target.checked)}/>I am executing {selected.pendingCount??0} reviewed recipient(s) through the {status?.mode} transport. This records a local handoff, not delivery.</label>
       <div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy||blocked||!sendConfirmed||!sendReason.trim()||!selected.sourceCurrent||!selected.configCurrent}>Execute reviewed campaign</button>
        <button type="button" className="btn btn-danger" disabled={busy||blocked} onClick={()=>commit('/messaging/campaigns/'+selected.id+'/cancel',{version:selected.version,reason:sendReason.trim()||'Reviewed campaign cancelled before handoff',confirmed:true},'Campaign cancelled. Reviewed recipients that were not handed to the transport are refused and retained.')}>Cancel this campaign</button></div>
       {executionKey.current&&<p className="table-note">Pinned execution key: {executionKey.current}. Re-using it never hands a second message to any recipient.</p>}
      </fieldset></form>}
   </section>}

   {canAttribute&&<section className="panel" aria-labelledby="messaging-attribution-heading">
    <h2 id="messaging-attribution-heading">Campaign attribution</h2>
    <p>Link an existing posted gift to this campaign for reporting. Attribution never creates, edits or duplicates a gift.</p>
    <form onSubmit={e=>{e.preventDefault();if(gift.recipientId&&gift.giftId&&gift.reason.trim())return commit('/messaging/campaigns/'+selected.id+'/attributions',{version:selected.version,recipientId:gift.recipientId,giftId:gift.giftId,giftVersion:(data?.gifts||none).find(g=>g.id===gift.giftId)?.version,reason:gift.reason.trim(),confirmed:true},'Existing posted revenue linked to this campaign. No gift was created or changed.');}}>
     <fieldset disabled={busy||blocked}><legend className="sr-only">Attribute an existing posted gift</legend><div className="form-grid">
      <label className="field">Reviewed recipient<select required value={gift.recipientId} onChange={e=>setGift({...gift,recipientId:e.target.value})}><option value="">Choose a recipient with retained handoff evidence</option>{recipientsOf.filter(r=>r.status==='Sent').map(r=><option key={r.id} value={r.id}>{people.find(p=>p.id===r.constituentId)?.name||r.constituentId}</option>)}</select></label>
      <label className="field">Existing posted gift<select required value={gift.giftId} onChange={e=>setGift({...gift,giftId:e.target.value})}><option value="">Choose a posted gift</option>{(data?.gifts||none).filter(g=>g.status==='Posted').map(g=><option key={g.id} value={g.id}>{money(g.amount)} · {g.date}</option>)}</select></label>
      <label className="field field-wide">Reason for this attribution<input required maxLength={2000} value={gift.reason} onChange={e=>setGift({...gift,reason:e.target.value})}/></label>
     </div><div className="form-actions"><button type="submit" className="btn btn-primary" disabled={busy||blocked||!gift.recipientId||!gift.giftId||!gift.reason.trim()}>Attribute existing gift</button></div></fieldset></form>
    {detail.attributions?.length?<ul className="messaging-attributions">{detail.attributions.map(a=><li key={a.id}><strong>{money(a.attributedCents)}</strong><span>{a.sourceCurrent?'Current posted gift':'Gift changed since attribution — excluded from reporting'}</span>{onOpen&&<button type="button" className="text-btn" disabled={busy} onClick={()=>onOpen('gifts',a.giftId,a.giftVersion)}>Open the gift<ArrowUpRight size={14} aria-hidden="true"/></button>}</li>)}</ul>:<p className="empty-state">No gift is attributed to this campaign.</p>}
   </section>}

   <section className="panel" aria-labelledby="messaging-history-heading">
    <h2 id="messaging-history-heading">Retained outcomes</h2>
    <p className="table-note">{detail.outcomeCount==null?'Reload the campaign to verify retained outcome counts.':detail.outcomes.length+' of '+detail.outcomeCount+' retained outcomes'}</p>
    {detail.outcomes?.length?<ol className="messaging-history">{detail.outcomes.map(o=><li key={o.id}><strong>{o.status} · v{o.campaignVersion}</strong><p>{o.reason}</p><small>{utc(o.at)} · {o.actor}{o.retryAt?' · retry '+utc(o.retryAt):''}</small></li>)}</ol>:<p className="empty-state">No outcome is retained for this campaign yet.</p>}
   </section></>}
 </div>;
}
