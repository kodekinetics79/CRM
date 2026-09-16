import React,{useEffect,useRef,useState} from 'react';
import {AlertTriangle,Check,Link2,RefreshCw,ShieldOff,UserPlus} from 'lucide-react';
import {dateLabel} from '../lib';

const ALLOWED=['admin','staff'];
const PERSON_TYPES=['Individual','Alumni','Employee','Staff'];
const LEAD_CHOICES=[[10080,'One week before'],[2880,'Two days before'],[1440,'One day before'],[120,'Two hours before'],[60,'One hour before']];
const nameOf=(data,id)=>(data.constituents||[]).find(c=>c.id===id)?.name||'Record no longer available';
const minutesLabel=value=>value===0?'At the moment it is due':value%1440===0?(value/1440)+' day(s) before':value%60===0?(value/60)+' hour(s) before':value+' minutes before';

export default function VolunteerPortal({api,user,data={},notify,onDirty}){
 const permitted=ALLOWED.includes(user?.role);
 const [overview,setOverview]=useState(null);
 const [loading,setLoading]=useState(permitted);
 const [error,setError]=useState('');
 const [conflict,setConflict]=useState('');
 const [denied,setDenied]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);
 const [issued,setIssued]=useState(null);
 const [shiftId,setShiftId]=useState('');
 const [form,setForm]=useState({constituentId:'',days:'30',reason:''});
 const [leads,setLeads]=useState([1440,120]);
 const [claimReasons,setClaimReasons]=useState({});
 const [remindersOn,setRemindersOn]=useState(true);
 const alive=useRef(true),generation=useRef(0),noticeRef=useRef(null);
 useEffect(()=>()=>{alive.current=false;generation.current++;},[]);
 const dirty=Boolean(form.constituentId||form.reason.trim());
 useEffect(()=>{onDirty?.(dirty);},[dirty]);
 // Revoking a link, cancelling a place or deciding a claim removes the control
 // that was pressed, so move focus to the outcome rather than to the document.
 useEffect(()=>{if(notice)noticeRef.current?.focus?.();},[notice]);

 async function load(){
  if(!permitted)return;
  const request=++generation.current;setLoading(true);setError('');
  try{
   const result=await api('/volunteer-portal');
   if(!alive.current||request!==generation.current)return;
   setOverview(result);setDenied('');
  }catch(e){
   if(!alive.current||request!==generation.current)return;
   setOverview(null);
   if(e.status===401||e.status===403)setDenied(e.message||'This workspace no longer allows volunteer sign-up administration.');
   else setError(e.message||'The volunteer sign-up register is unavailable.');
  }finally{if(alive.current&&request===generation.current)setLoading(false);}
 }
 useEffect(()=>{load();},[api,user?.id]);

 async function act(path,body,success){
  if(busy)return null;
  setBusy(true);setNotice('');setError('');setConflict('');
  try{
   const result=await api(path,{method:'POST',body});
   if(!alive.current)return null;
   setNotice(success);notify?.(success);
   await load();
   return result;
  }catch(e){
   if(!alive.current)return null;
   if(e.status===409){setConflict(e.message);await load().catch(()=>{});}
   else if(e.status===401||e.status===403)setDenied(e.message||'You no longer have permission for this action.');
   else setError(e.message||'This action could not be completed.');
   return null;
  }finally{if(alive.current)setBusy(false);}
 }

 async function issueLink(e){
  e.preventDefault();
  if(!form.constituentId||!form.reason.trim())return;
  const result=await act('/volunteer-portal/access',{constituentId:form.constituentId,days:Number(form.days),reason:form.reason.trim()},'Sign-up link issued. Copy it now — it is shown once.');
  if(result){setIssued(result);setForm({constituentId:'',days:'30',reason:''});}
 }

 if(!permitted)return <><Header/><section className="panel"><p className="empty-state" role="status">Volunteer sign-up administration requires administrator or staff access. Ask an administrator if you need to issue or revoke a sign-up link.</p></section></>;

 const people=(data.constituents||[]).filter(c=>PERSON_TYPES.includes(c.type)&&!c.mergedInto);
 const shifts=overview?.shifts||[];
 const shift=shifts.find(s=>s.id===shiftId)||null;

 return <>
  <Header/>
  <p className="table-note">{overview?.scope||'Volunteer self-service administration only.'} Reminders are prepared for the configured outbox; queuing a reminder is never delivery.</p>
  <div className="programs-toolbar">
   <button type="button" className="btn btn-secondary" disabled={busy||loading} onClick={()=>{setNotice('');setConflict('');load();}}><RefreshCw size={16} aria-hidden="true"/>Refresh sign-up register</button>
   {overview&&<span className="subtle">Outbox: {overview.outbox?.mode||'Internal only'} · Times shown in UTC</span>}
  </div>
  {notice&&<p className="scope-banner" role="status" ref={noticeRef} tabIndex={-1}>{notice}</p>}
  {conflict&&<p className="error-banner" role="alert"><AlertTriangle size={15} aria-hidden="true"/> {conflict} The latest register has been reloaded.</p>}
  {denied&&<p className="error-banner" role="alert"><ShieldOff size={15} aria-hidden="true"/> {denied} Ask an administrator if you need to issue or revoke a sign-up link.</p>}
  {error&&<p className="error-banner" role="alert">{error} <button type="button" className="text-btn" onClick={load}>Try again</button></p>}
  {loading&&<section className="panel" role="status">Loading the volunteer sign-up register…</section>}
  {!loading&&!overview&&!denied&&<section className="panel"><p className="empty-state" role="status">The sign-up register could not be read. Nothing is assumed to be empty.</p></section>}

  {overview&&<>
   <section className="panel" aria-labelledby="volunteer-links-heading">
    <h2 id="volunteer-links-heading">Self-service sign-up links</h2>
    <p className="table-note">A link proves itself with an issued, expiring, revocable token. It opens only that person&rsquo;s own shifts — never constituent records, giving history or another volunteer&rsquo;s details.</p>
    <form className="programs-form" onSubmit={issueLink}>
     <fieldset disabled={busy}>
      <legend className="sr-only">Issue a volunteer sign-up link</legend>
      <label className="field">Volunteer
       <select value={form.constituentId} onChange={e=>setForm({...form,constituentId:e.target.value})} required>
        <option value="">Choose a person…</option>
        {people.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
       </select>
       <small>Volunteer identity is a person constituent. Organizations cannot hold a sign-up link.</small>
      </label>
      <label className="field">Link valid for
       <select value={form.days} onChange={e=>setForm({...form,days:e.target.value})}>
        {['7','30','90','180'].map(value=><option key={value} value={value}>{value} days</option>)}
       </select>
      </label>
      <label className="field">Reason
       <input value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} maxLength={500} required placeholder="Why this volunteer needs self-service access"/>
      </label>
      <div className="form-actions">
       <button className="btn btn-primary" type="submit" disabled={busy||!form.constituentId||!form.reason.trim()}><UserPlus size={16} aria-hidden="true"/>{busy?'Issuing…':'Issue sign-up link'}</button>
      </div>
     </fieldset>
    </form>
    {issued&&<div className="programs-issued" role="status">
     <h3><Link2 size={16} aria-hidden="true"/> Copy this link now</h3>
     <p>{issued.notice}</p>
     <label className="field">Sign-up link
      <input readOnly value={issued.linkPath} onFocus={e=>e.target.select()} aria-describedby="volunteer-issued-help"/>
     </label>
     <p id="volunteer-issued-help" className="subtle">Wimblo never sends this link. Share it through your own approved channel.</p>
     <button type="button" className="btn btn-secondary" onClick={()=>setIssued(null)}>Hide link</button>
    </div>}
    {overview.access.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Issued volunteer sign-up links</caption>
     <thead><tr><th scope="col">Volunteer</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col">Uses</th><th scope="col">Confirmations recorded</th><th scope="col">Action</th></tr></thead>
     <tbody>{overview.access.map(row=><tr key={row.id}>
      <td data-label="Volunteer">{nameOf(data,row.constituentId)}</td>
      <td data-label="Status">{row.status==='Revoked'?'Revoked':row.expired?'Expired':'Active'}</td>
      <td data-label="Expires">{dateLabel(row.expiresAt)}</td>
      <td data-label="Uses">{row.useCount}</td>
      <td data-label="Confirmations recorded">{Number.isFinite(row.confirmationsLimit)?row.confirmationsRecorded+' of '+row.confirmationsLimit:'—'}
       {row.confirmationsExhausted?<small className="cell-detail">This link has reached its confirmation limit. Revoke it and issue a new one — the volunteer&rsquo;s places and history are unaffected.</small>
        :Number.isFinite(row.confirmationsLimit)&&row.status==='Active'&&row.confirmationsLimit-row.confirmationsRecorded<=10?<small className="cell-detail">Close to its confirmation limit. Issue a new link before the volunteer meets a refusal; their places and history are unaffected either way.</small>:null}</td>
      <td data-label="Action">{row.status==='Active'?<button type="button" className="btn btn-danger" disabled={busy} aria-label={'Revoke the sign-up link for '+nameOf(data,row.constituentId)} onClick={()=>act('/volunteer-portal/access/'+row.id+'/revoke',{version:row.version,reason:'Revoked from the volunteer sign-up screen'},'Sign-up link revoked. The volunteer’s places and history are unaffected.')}>Revoke</button>:<span className="subtle">Closed</span>}</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state">No sign-up links have been issued yet.</p>}
   </section>

   <section className="panel" aria-labelledby="volunteer-shifts-heading">
    <h2 id="volunteer-shifts-heading">Shifts, places and waitlist</h2>
    {shifts.length?<>
     <label className="field">Shift
      <select value={shiftId} onChange={e=>{setShiftId(e.target.value);const found=shifts.find(s=>s.id===e.target.value);if(found){setLeads(found.reminderConfig.leadMinutes);setRemindersOn(found.reminderConfig.enabled);}}}>
       <option value="">Choose a shift…</option>
       {shifts.map(row=><option key={row.id} value={row.id}>{row.name} · {row.date} {row.startTime}–{row.endTime}</option>)}
      </select>
     </label>
     <div className="table-wrap"><table className="programs-table">
      <caption className="sr-only">Volunteer shifts with places and waitlist</caption>
      <thead><tr><th scope="col">Shift</th><th scope="col">When</th><th scope="col">Places</th><th scope="col">Waitlist</th><th scope="col">Reminders</th></tr></thead>
      <tbody>{shifts.map(row=><tr key={row.id}>
       <td data-label="Shift">{row.name}</td>
       <td data-label="When">{dateLabel(row.date)} · {row.startTime}–{row.endTime} UTC</td>
       <td data-label="Places">{row.reservedCount} of {row.capacity}{row.placesLeft===0?' · full':''}</td>
       <td data-label="Waitlist">{row.waitlistCount}</td>
       <td data-label="Reminders">{row.reminderConfig.enabled?row.reminderConfig.leadMinutes.map(minutesLabel).join(', ')||'None chosen':'Off'}</td>
      </tr>)}</tbody>
     </table></div>
    </>:<p className="empty-state">No volunteer shifts exist yet. Create a shift record first, then issue sign-up links.</p>}

    {shift&&<div className="programs-detail">
     <h3>{shift.name}</h3>
     <p className="subtle">{dateLabel(shift.date)} · {shift.startTime}–{shift.endTime} UTC · {shift.reservedCount} of {shift.capacity} places used · {shift.waitlistCount} waiting</p>
     <form className="programs-form" onSubmit={e=>{e.preventDefault();act('/volunteer-portal/shifts/'+shift.id+'/reminder-config',{leadMinutes:leads,enabled:remindersOn,reason:'Reminder schedule set from the volunteer sign-up screen'},'Reminder schedule saved. Nothing has been sent.');}}>
      <fieldset disabled={busy}>
       <legend>Automatic shift reminders</legend>
       <label className="field programs-check"><input type="checkbox" checked={remindersOn} onChange={e=>setRemindersOn(e.target.checked)}/> Prepare reminders for this shift</label>
       {LEAD_CHOICES.map(([value,label])=><label key={value} className="field programs-check">
        <input type="checkbox" checked={leads.includes(value)} disabled={!remindersOn} onChange={e=>setLeads(current=>e.target.checked?[...current,value]:current.filter(x=>x!==value))}/> {label}
       </label>)}
       <p className="subtle">A reminder is queued to the configured outbox only when the volunteer has granted consent and their contact preference permits it. Queuing is not delivery.</p>
       <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={busy}>Save reminder schedule</button>
        <button type="button" className="btn btn-secondary" disabled={busy||!shift.waitlistCount} onClick={()=>act('/volunteer-portal/shifts/'+shift.id+'/promote',{reason:'Waitlist reconciled from the volunteer sign-up screen'},'Waitlist reconciled against free places.')}>Fill free places from the waitlist</button>
       </div>
      </fieldset>
     </form>
     {shift.roster.length?<div className="table-wrap"><table className="programs-table">
      <caption className="sr-only">Roster for {shift.name}</caption>
      <thead><tr><th scope="col">Volunteer</th><th scope="col">Place</th><th scope="col">History</th><th scope="col">Action</th></tr></thead>
      <tbody>{shift.roster.map(row=><tr key={row.id}>
       <td data-label="Volunteer">{nameOf(data,row.constituentId)}</td>
       <td data-label="Place">{row.status}</td>
       <td data-label="History">{row.history.length?row.history.map(h=>h.action).join(' → '):'No recorded change'}</td>
       <td data-label="Action">{row.status==='Cancelled'?<span className="subtle">Retained</span>:<button type="button" className="btn btn-danger" disabled={busy||shift.past} aria-label={'Cancel the place held by '+nameOf(data,row.constituentId)} onClick={()=>act('/volunteer-portal/reservations/'+row.id+'/cancel',{version:row.version,reason:'Cancelled by staff from the volunteer sign-up screen'},'Place cancelled. The original place and its history are retained.')}>Cancel place</button>}</td>
      </tr>)}</tbody>
     </table></div>:<p className="empty-state">Nobody has signed up for this shift yet.</p>}
     {shift.past&&<p className="table-note">This shift has already started. Places can no longer be cancelled here; correct attendance in the volunteer time ledger instead.</p>}
    </div>}
   </section>

   <section className="panel" aria-labelledby="volunteer-claims-heading">
    <h2 id="volunteer-claims-heading">Self-reported arrival and departure</h2>
    <p className="table-note">{overview.attendance} {overview.ledger}</p>
    {(overview.claims||[]).length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Volunteer self-reported arrival and departure claims</caption>
     <thead><tr><th scope="col">Volunteer</th><th scope="col">Shift</th><th scope="col">Claimed times</th><th scope="col">State</th><th scope="col">Decision</th></tr></thead>
     <tbody>{(overview.claims||[]).map(row=>{
      const claimShift=shifts.find(s=>s.id===row.shiftId);
      const reason=claimReasons[row.id]||'';
      return <tr key={row.id}>
       <td data-label="Volunteer">{nameOf(data,row.constituentId)}</td>
       <td data-label="Shift">{claimShift?claimShift.name+' · '+dateLabel(claimShift.date):'Shift no longer listed'}</td>
       <td data-label="Claimed times">{row.arrivedAt.slice(11,16)}–{row.departedAt.slice(11,16)} UTC<small className="subtle">{row.claimedMinutes} minutes claimed · not confirmed hours</small></td>
       <td data-label="State">{row.status}{row.status==='Claimed'&&!row.sourceCurrent?' · '+row.sourceProblem:''}{row.decisionReason&&row.status!=='Claimed'?<small className="subtle">{row.decisionReason}</small>:null}</td>
       <td data-label="Decision">{row.status==='Claimed'?<div className="programs-row-actions">
        <label className="sr-only" htmlFor={'claim-reason-'+row.id}>Reason for the decision on {nameOf(data,row.constituentId)}</label>
        <input id={'claim-reason-'+row.id} value={reason} maxLength={500} placeholder="Reason for your decision" disabled={busy} onChange={e=>setClaimReasons({...claimReasons,[row.id]:e.target.value})}/>
        <button type="button" className="btn btn-primary" disabled={busy||!reason.trim()} aria-label={'Confirm the claim from '+nameOf(data,row.constituentId)}
         onClick={()=>act('/volunteer-portal/claims/'+row.id+'/confirm',{version:row.version,reason:reason.trim()},'Claim confirmed. No hours were written — record hours with the volunteer clock as a separate action.')}>Confirm</button>
        <button type="button" className="btn btn-danger" disabled={busy||!reason.trim()} aria-label={'Reject the claim from '+nameOf(data,row.constituentId)}
         onClick={()=>act('/volunteer-portal/claims/'+row.id+'/reject',{version:row.version,reason:reason.trim()},'Claim rejected and retained with your reason.')}>Reject</button>
       </div>:<span className="subtle">Closed</span>}</td>
      </tr>;
     })}</tbody>
    </table></div>:<p className="empty-state">No volunteer has recorded arrival or departure times yet.</p>}
   </section>

   <section className="panel" aria-labelledby="volunteer-reminders-heading">
    <h2 id="volunteer-reminders-heading">Prepared reminders</h2>
    <p className="table-note">{overview.delivery}</p>
    {overview.reminders.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Volunteer reminders and their recorded outcomes</caption>
     <thead><tr><th scope="col">Volunteer</th><th scope="col">Kind</th><th scope="col">Scheduled</th><th scope="col">State</th><th scope="col">Last recorded outcome</th></tr></thead>
     <tbody>{overview.reminders.map(row=><tr key={row.id}>
      <td data-label="Volunteer">{nameOf(data,row.constituentId)}</td>
      <td data-label="Kind">{row.kind}</td>
      <td data-label="Scheduled">{row.sendAt.replace('T',' ').slice(0,16)} UTC</td>
      <td data-label="State">{row.status==='Queued'?'Queued to the outbox':row.status}</td>
      <td data-label="Last recorded outcome">{row.lastOutcome?row.lastOutcome.reason:'No outcome recorded yet'}</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state">No reminders have been prepared yet.</p>}
   </section>

   <section className="panel" aria-labelledby="volunteer-history-heading">
    <h2 id="volunteer-history-heading">Cancellations and waitlist movement</h2>
    {overview.cancellations.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Retained volunteer cancellations and waitlist promotions</caption>
     <thead><tr><th scope="col">Volunteer</th><th scope="col">Change</th><th scope="col">Recorded by</th><th scope="col">Reason</th><th scope="col">When</th></tr></thead>
     <tbody>{overview.cancellations.map(row=><tr key={row.id}>
      <td data-label="Volunteer">{nameOf(data,row.constituentId)}</td>
      <td data-label="Change">{row.action}</td>
      <td data-label="Recorded by">{row.actorKind}</td>
      <td data-label="Reason">{row.reason}</td>
      <td data-label="When">{row.at.replace('T',' ').slice(0,16)} UTC</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state">No cancellations or waitlist movement has been recorded.</p>}
   </section>

   <section className="panel" aria-labelledby="volunteer-consent-heading">
    <h2 id="volunteer-consent-heading">Reminder consent</h2>
    <p className="table-note">Reminder consent is separate from contact preference and from any workspace login role. A volunteer who withdraws consent from their own link can only grant it again themselves.</p>
    {overview.consent.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Recorded volunteer reminder consent</caption>
     <thead><tr><th scope="col">Volunteer</th><th scope="col">Consent</th><th scope="col">Recorded by</th><th scope="col">Updated</th></tr></thead>
     <tbody>{overview.consent.map(row=><tr key={row.constituentId}>
      <td data-label="Volunteer">{nameOf(data,row.constituentId)}</td>
      <td data-label="Consent">{row.granted?<span><Check size={14} aria-hidden="true"/> Granted</span>:'Withdrawn'}{row.withdrawnByVolunteer&&!row.granted?' by the volunteer':''}</td>
      <td data-label="Recorded by">{row.source}</td>
      <td data-label="Updated">{row.updatedAt?row.updatedAt.replace('T',' ').slice(0,16)+' UTC':'—'}</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state">No reminder consent has been recorded yet.</p>}
   </section>
  </>}
 </>;
}

function Header(){
 return <div className="page-header"><div>
  <h1>Volunteer sign-up</h1>
  <p>Issue self-service sign-up links, review shifts and waitlists, set reminder schedules and see retained cancellations.</p>
 </div></div>;
}
