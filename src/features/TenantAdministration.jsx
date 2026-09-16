import React,{useEffect,useRef,useState} from 'react';
import {ShieldCheck,Mail,Scale,Palette,KeyRound,RefreshCw,Building2} from 'lucide-react';
import {money,dateLabel} from '../lib';

const TABS=[['plan','Plan and seats'],['people','People and invitations'],['duties','Separation of duties'],['security','Account security'],['branding','Branding'],['federation','Federated sign-in']];
const blankInvitation={email:'',name:'',role:'staff',expiresInHours:72,reason:''};
const blankReview={duty:'gift-void',subjectId:'',summary:'',amountCents:''};
const blankControl={duty:'',enabled:false,version:1,reason:'',label:''};
const seatText=(used,limit)=>limit===null||limit===undefined?String(used)+' of unmetered':String(used)+' of '+limit;

export default function TenantAdministration({api,user,data,notify,onDirty}){
 const [overview,setOverview]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[conflict,setConflict]=useState(''),[notice,setNotice]=useState(''),[denied,setDenied]=useState(false),[busy,setBusy]=useState(false);
 const [tab,setTab]=useState('plan'),[invitation,setInvitation]=useState(blankInvitation),[issued,setIssued]=useState(null),[review,setReview]=useState(blankReview),[decision,setDecision]=useState(null),[control,setControl]=useState(blankControl),[branding,setBranding]=useState(null),[federation,setFederation]=useState(null);
 const tabRefs=useRef({}),controlReasonRef=useRef(null),decisionRef=useRef(null);
 const administrator=user.role==='admin';

 async function load(){const result=await api('/tenant-administration/overview');setOverview(result);setBranding({...result.branding});setFederation({authorizationReference:result.federation.authorizationReference||'',reason:''});}
 useEffect(()=>{let live=true;if(!administrator){setLoading(false);setDenied(true);return()=>{live=false;};}
  load().catch(e=>{if(!live)return;if(e.status===403)setDenied(true);else setError(e.message);}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};},[api,administrator]);
 // Turning a control on and deciding a review both open a form well below the
 // button that opened it. Without this, a keyboard or screen-reader user is left
 // in the table with no announcement that anything appeared.
 useEffect(()=>{if(control.duty)controlReasonRef.current?.focus?.();},[control.duty]);
 useEffect(()=>{if(decision?.id)decisionRef.current?.focus?.();},[decision?.id]);

 async function work(message,fn){setBusy(true);setError('');setConflict('');setNotice('');
  try{await fn();if(message){setNotice(message);notify?.(message);}}
  catch(e){if(e.status===409){setConflict(e.message);await load().catch(()=>{});}
   else if(e.status===403)setError(e.message);
   else setError(e.message);}
  finally{setBusy(false);}
 }
 function moveTab(event,index){
  const keys={ArrowRight:index+1,ArrowLeft:index-1,Home:0,End:TABS.length-1};
  if(!(event.key in keys))return;event.preventDefault();
  const next=TABS[(keys[event.key]+TABS.length)%TABS.length][0];setTab(next);tabRefs.current[next]?.focus();
 }
 async function issueInvitation(event){event.preventDefault();
  await work('',async()=>{const result=await api('/tenant-administration/invitations',{method:'POST',body:{email:invitation.email.trim(),name:invitation.name.trim(),role:invitation.role,expiresInHours:Number(invitation.expiresInHours),reason:invitation.reason.trim()}});
   setIssued(result);setInvitation(blankInvitation);onDirty?.(false);await load();
   setNotice('Invitation issued. Copy the single-use link now: it is shown once and no message was sent.');notify?.('Invitation issued. No message was sent.');});
 }
 const revoke=item=>work('Invitation revoked. Its link can no longer be used.',async()=>{
  await api('/tenant-administration/invitations/'+item.id+'/revoke',{method:'POST',body:{version:item.version,reason:'Revoked by an administrator from tenant administration'}});
  if(issued?.invitation?.id===item.id)setIssued(null);await load();});
 async function prepareReview(event){event.preventDefault();
  const duty=overview.duties.find(d=>d.duty===review.duty);
  const subject=duty.collection==='users'?overview.accounts.find(a=>a.id===review.subjectId):(data[duty.collection]||[]).find(r=>r.id===review.subjectId);
  if(!subject){setError('Choose a current record to review.');return;}
  await work('Review prepared. A different authorized approver must decide it.',async()=>{
   await api('/tenant-administration/reviews',{method:'POST',body:{duty:review.duty,subjectId:subject.id,subjectVersion:subject.version,summary:review.summary.trim(),...(review.amountCents===''?{}:{amountCents:Number(review.amountCents)})}});
   setReview(blankReview);onDirty?.(false);await load();});
 }
 async function decide(event){event.preventDefault();
  await work('Decision recorded with its reason and the deciding account.',async()=>{
   await api('/tenant-administration/reviews/'+decision.id+'/decision',{method:'POST',body:{version:decision.version,decision:decision.decision,reason:decision.reason.trim()}});
   setDecision(null);onDirty?.(false);await load();});
 }
 async function saveBranding(event){event.preventDefault();
  await work('Branding saved. The product identity is unchanged.',async()=>{
   const result=await api('/tenant-administration/branding',{method:'PATCH',body:{version:branding.version,enabled:branding.enabled,displayName:branding.displayName.trim(),supportEmail:branding.supportEmail.trim(),footerNote:branding.footerNote.trim()}});
   setBranding({...result.branding});onDirty?.(false);await load();});
 }
 async function saveControl(event){event.preventDefault();
  await work(control.enabled?'Control enabled. This action is now refused until a different authorized person approves it.':'Control disabled. This action behaves exactly as it did before.',async()=>{
   await api('/tenant-administration/duty-policies/'+control.duty,{method:'PATCH',body:{version:control.version,enabled:control.enabled,reason:control.reason.trim()}});
   setControl(blankControl);onDirty?.(false);await load();});
 }
 const runDiscovery=()=>work('Provider metadata and signing keys refreshed through the configured boundary.',async()=>{await api('/tenant-administration/federation/discovery',{method:'POST',body:{}});await load();});
 const setEnablement=enabled=>work(enabled?'Federated sign-in enabled as a validated boundary. It issues no workspace session.':'Federated sign-in disabled.',async()=>{
  await api('/tenant-administration/federation/enablement',{method:'POST',body:{version:overview.federation.version,enabled,authorizationReference:federation.authorizationReference.trim(),reason:federation.reason.trim()}});await load();});

 if(loading)return <section className="panel" role="status">Opening tenant administration…</section>;
 if(denied)return <><div className="page-header"><div><h1>Tenant administration</h1><p>Plan entitlements, invitations, separation of duties and account security for this workspace.</p></div></div>
  <section className="panel tenant-admin-denied" role="status"><ShieldCheck size={20} aria-hidden="true"/><div><h2>Administrator access is required</h2><p>Your account is signed in as {user.role}. Workspace administration is limited to administrator accounts; ordinary duties never grant it. Ask an administrator if you need a change here.</p></div></section></>;
 if(!overview)return <><div className="page-header"><div><h1>Tenant administration</h1></div></div>
  <section className="panel"><p className="error-banner" role="alert">{error||'Tenant administration could not be opened.'}</p><button className="btn btn-primary" type="button" onClick={()=>work('',load)}>Try again</button></section></>;

 const {entitlements,seats,billing,productIdentity,roles,accounts,invitations,reviews,duties,federation:sso}=overview;
 const duty=duties.find(d=>d.duty===review.duty)||duties[0];
 const subjects=duty.collection==='users'?accounts.filter(a=>a.active).map(a=>({id:a.id,label:a.name+' · '+a.role,version:a.version}))
  :(data[duty.collection]||[]).map(record=>({id:record.id,label:(record.name||record.title||record.number||record.id)+(record.amount?' · '+money(record.amount):''),version:record.version}));
 const panelId=key=>'tenant-admin-panel-'+key;

 return <section className="tenant-administration">
  <div className="page-header"><div><h1>Tenant administration</h1><p>{overview.workspace.name||'This workspace'} · {entitlements.label} plan · {overview.workspace.status==='active'?'Active':'Suspended'}</p></div>
   <button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>work('Workspace administration reloaded.',load)}><RefreshCw size={16} aria-hidden="true"/>Refresh workspace administration</button></div>
  {error&&<div className="error-banner" role="alert">{error}</div>}
  {conflict&&<div className="error-banner" role="alert">{conflict} The latest values have been reloaded; review them before saving again.</div>}
  {notice&&<p className="tenant-admin-notice" role="status">{notice}</p>}
  <p className="tenant-admin-identity"><Palette size={16} aria-hidden="true"/>{productIdentity.productName} by {productIdentity.providedBy}. Customer branding is optional and never replaces the product identity.</p>
  <div className="tenant-admin-tabs" role="tablist" aria-label="Tenant administration sections">
   {TABS.map(([key,label],index)=><button key={key} type="button" role="tab" id={'tenant-admin-tab-'+key} aria-controls={panelId(key)} aria-selected={tab===key} tabIndex={tab===key?0:-1}
    ref={element=>{tabRefs.current[key]=element;}} className={'tenant-admin-tab'+(tab===key?' is-active':'')} onKeyDown={event=>moveTab(event,index)} onClick={()=>setTab(key)}>{label}</button>)}
  </div>

  {tab==='plan'&&<div id={panelId('plan')} role="tabpanel" aria-labelledby="tenant-admin-tab-plan" tabIndex={0} className="tenant-admin-panel">
   <section className="panel"><div className="section-title"><div><h2>Plan entitlements</h2><p>Named entitlements are enforced when an account or invitation is created, not only displayed here.</p></div></div>
    <dl className="tenant-admin-facts">
     <div><dt>Plan</dt><dd>{entitlements.label}</dd></div>
     <div><dt>Full user seats</dt><dd>{seatText(seats.fullUsersInUse,seats.fullUserSeats)}{seats.fullInvitationsPending?' · '+seats.fullInvitationsPending+' invited':''}</dd></div>
     <div><dt>Optional helper seats</dt><dd>{seatText(seats.helperUsersInUse,seats.helperSeats)}{seats.helperInvitationsPending?' · '+seats.helperInvitationsPending+' invited':''}</dd></div>
     <div><dt>AI assistance</dt><dd>{entitlements.ai?'Included in this plan':'Not included in this plan'}</dd></div>
     <div><dt>Connectors</dt><dd>{entitlements.connectors.length?entitlements.connectors.join(', '):'None included'}</dd></div>
     <div><dt>History retention</dt><dd>{entitlements.historyRetentionYears} years</dd></div>
    </dl>
    <p className="table-note">Helper seats are non-administrator by definition. Ordinary duties such as event support, data entry and volunteer coordination never require administrator access.</p></section>
   <section className="panel"><div className="section-title"><div><h2>Billing state</h2><p>{billing.planLabel}</p></div></div>
    <p className="tenant-admin-billing"><Building2 size={16} aria-hidden="true"/>{billing.note}</p>
    <dl className="tenant-admin-facts">
     <div><dt>Billing provider</dt><dd>{billing.billingProvider||'Not connected'}</dd></div>
     <div><dt>Subscription state</dt><dd>{billing.subscriptionActive?'Active':'No billing subscription exists'}</dd></div>
     <div><dt>Invoices held</dt><dd>{billing.invoices.length}</dd></div>
     <div><dt>Provider events held</dt><dd>{billing.providerEvents.length}</dd></div>
    </dl></section>
   <section className="panel"><div className="section-title"><div><h2>Role separation</h2><p>What each sign-in role may do in this workspace.</p></div></div>
    <div className="table-wrap"><table><caption className="sr-only">Workspace roles and what each may do</caption>
     <thead><tr><th scope="col">Role</th><th scope="col">Business records</th><th scope="col">Account administration</th><th scope="col">Event check-in</th></tr></thead>
     <tbody>{roles.map(row=><tr key={row.role}><th scope="row" data-label="Role">{row.label}<small className="cell-detail">{row.summary}</small></th><td data-label="Business records">{row.businessRecords}</td><td data-label="Account administration">{row.accountAdministration?'Yes':'No'}</td><td data-label="Event check-in">{row.eventCheckIn===true?'Yes':row.eventCheckIn||'No'}</td></tr>)}</tbody></table></div>
    <p className="table-note">Sign-in role, constituent category and communication consent stay separate. An entitlement grants capacity, never consent.</p></section>
  </div>}

  {tab==='people'&&<div id={panelId('people')} role="tabpanel" aria-labelledby="tenant-admin-tab-people" tabIndex={0} className="tenant-admin-panel">
   <section className="panel"><div className="section-title"><div><h2>Invite a person</h2><p>An invitation issues one signed, single-use link. Wimblo sends no message: hand the link over through your approved secure process.</p></div></div>
    <form onSubmit={issueInvitation}><fieldset disabled={busy}><div className="form-grid">
     <label className="field">Full name<input required maxLength={250} value={invitation.name} onChange={e=>{setInvitation({...invitation,name:e.target.value});onDirty?.(true);}}/></label>
     <label className="field">Email<input required type="email" maxLength={254} autoComplete="off" value={invitation.email} onChange={e=>{setInvitation({...invitation,email:e.target.value});onDirty?.(true);}}/></label>
     <label className="field">Role<select value={invitation.role} onChange={e=>setInvitation({...invitation,role:e.target.value})}>
      <option value="admin">Administrator</option><option value="staff">Staff</option><option value="viewer">Viewer</option><option value="event-helper">Event helper (non-administrator)</option></select>
      <small>{invitation.role==='event-helper'?seatText(seats.helperUsersInUse,seats.helperSeats)+' helper seats used':seatText(seats.fullUsersInUse,seats.fullUserSeats)+' full seats used'}. The role is signed into the link and cannot be changed when it is accepted.</small></label>
     <label className="field">Link valid for<select value={invitation.expiresInHours} onChange={e=>setInvitation({...invitation,expiresInHours:e.target.value})}><option value={24}>24 hours</option><option value={72}>72 hours</option><option value={168}>7 days</option></select></label>
     <label className="field field-wide">Reason for this access<textarea required minLength={5} maxLength={1000} value={invitation.reason} onChange={e=>{setInvitation({...invitation,reason:e.target.value});onDirty?.(true);}}/></label>
    </div><div className="form-actions"><button className="btn btn-primary" type="submit">{busy?'Issuing…':'Issue invitation'}</button>
     <button className="btn btn-secondary" type="button" onClick={()=>{setInvitation(blankInvitation);onDirty?.(false);}}>Clear</button></div></fieldset></form>
    {issued&&<div className="tenant-admin-token" role="status"><h3>Single-use invitation link</h3>
     <p>Copy this now. It is shown once, it expires, and it can be revoked at any time. No message was sent.</p>
     <code>{issued.token}</code>
     <p className="table-note">Recipient: {issued.invitation.email} · Role: {issued.invitation.role} · Expires {dateLabel(issued.invitation.expiresAt)}</p>
     <button className="btn btn-secondary btn-small" type="button" onClick={()=>setIssued(null)}>Hide link</button></div>}
   </section>
   <section className="panel"><div className="section-title"><div><h2>Invitations</h2><p>Issued, accepted, revoked, expired and suppressed invitations are retained.</p></div></div>
    {invitations.length?<div className="table-wrap"><table><caption className="sr-only">Workspace invitations</caption>
     <thead><tr><th scope="col">Recipient</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col">Actions</th></tr></thead>
     <tbody>{invitations.map(item=><tr key={item.id}><th scope="row" data-label="Recipient">{item.name}<small className="cell-detail">{item.email}</small></th><td data-label="Role">{item.role}</td>
      <td data-label="Status">{item.status}{item.closedReason?<small className="cell-detail">{item.closedReason}</small>:null}</td><td data-label="Expires">{dateLabel(item.expiresAt)}</td>
      <td data-label="Actions">{item.status==='Pending'?<button className="btn btn-secondary btn-small" type="button" disabled={busy} aria-label={'Revoke the invitation for '+item.email} onClick={()=>revoke(item)}>Revoke</button>:<span className="subtle">Closed</span>}</td></tr>)}</tbody></table></div>
     :<div className="empty-state"><Mail size={24} aria-hidden="true"/><h3>No invitations yet</h3><p>Issue an invitation above when a seat is available.</p></div>}
   </section>
   <section className="panel"><div className="section-title"><div><h2>Accounts</h2><p>Accounts are created and changed on the Account access screen. This view shows how they consume the plan.</p></div></div>
    <div className="table-wrap"><table><caption className="sr-only">Workspace accounts and the seat each uses</caption>
     <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Seat</th><th scope="col">Access</th><th scope="col">Authenticator</th></tr></thead>
     <tbody>{accounts.map(item=><tr key={item.id}><th scope="row" data-label="Account">{item.name}<small className="cell-detail">{item.email}</small></th><td data-label="Role">{item.role}</td>
      <td data-label="Seat">{item.seatClass==='helper'?'Optional helper':'Full user'}</td><td data-label="Access">{item.active?'Active':'Closed'}</td><td data-label="Authenticator">{item.mfaEnabled?'Enrolled':'Not enrolled'}</td></tr>)}</tbody></table></div>
   </section>
  </div>}

  {tab==='duties'&&<div id={panelId('duties')} role="tabpanel" aria-labelledby="tenant-admin-tab-duties" tabIndex={0} className="tenant-admin-panel">
   <section className="panel"><div className="section-title"><div><h2>Two-person controls</h2><p>Each control is off unless you turn it on. While a control is off the action behaves exactly as it does today.</p></div></div>
    <div className="table-wrap"><table><caption className="sr-only">Separation-of-duties controls and whether each is enabled</caption>
     <thead><tr><th scope="col">Action</th><th scope="col">Prepared by</th><th scope="col">Approved by</th><th scope="col">Current setting</th><th scope="col">Actions</th></tr></thead>
     <tbody>{duties.map(item=><tr key={item.duty}><th scope="row" data-label="Action">{item.label}{item.reason?<small className="cell-detail">{item.reason}</small>:null}</th>
      <td data-label="Prepared by">{item.preparerRoles.join(' or ')}</td><td data-label="Approved by">A different {item.approverRoles.join(' or ')}</td>
      <td data-label="Current setting">{item.enabled?'On — a second approval is required':'Off — unchanged behaviour'}</td>
      <td data-label="Actions"><button className="btn btn-secondary btn-small" type="button" disabled={busy} aria-label={(item.enabled?'Turn off':'Turn on')+' the two-person control for '+item.label}
       onClick={()=>{setControl({duty:item.duty,enabled:!item.enabled,version:item.version,reason:'',label:item.label});setNotice('');}}>{item.enabled?'Turn off':'Turn on'}</button></td></tr>)}</tbody></table></div>
    <p className="table-note">Turning a control on cannot leave a single administrator unable to obtain an approval: a second account holding the approving role must already exist.</p>
    {control.duty&&<form onSubmit={saveControl}><fieldset disabled={busy}><div className="form-grid">
     <label className="field field-wide">Reason for {control.enabled?'enabling':'disabling'} “{control.label}”<textarea ref={controlReasonRef} required minLength={5} maxLength={1000} value={control.reason} onChange={e=>{setControl({...control,reason:e.target.value});onDirty?.(true);}}/></label>
    </div><div className="form-actions"><button className="btn btn-primary" type="submit">{busy?'Saving…':control.enabled?'Turn this control on':'Turn this control off'}</button>
     <button className="btn btn-secondary" type="button" onClick={()=>{setControl(blankControl);onDirty?.(false);}}>Cancel</button></div></fieldset></form>}
   </section>
   <section className="panel"><div className="section-title"><div><h2>Prepare a reviewable action</h2><p>The person who prepares a financially meaningful action can never be its only approver. Preparing a review is always available, whether or not the control is on.</p></div></div>
    <form onSubmit={prepareReview}><fieldset disabled={busy}><div className="form-grid">
     <label className="field">Reviewable duty<select value={review.duty} onChange={e=>setReview({...blankReview,duty:e.target.value})}>{duties.map(item=><option key={item.duty} value={item.duty}>{item.label}</option>)}</select>
      <small>Prepared by {duty.preparerRoles.join(' or ')} · decided by a different {duty.approverRoles.join(' or ')} · control {duty.enabled?'on':'off'}</small></label>
     <label className="field">Record<select required value={review.subjectId} onChange={e=>{setReview({...review,subjectId:e.target.value});onDirty?.(true);}}>
      <option value="">Choose a record</option>{subjects.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
     {duty.financiallyMeaningful&&<label className="field">Amount in cents (optional)<input inputMode="numeric" pattern="-?[0-9]*" maxLength={12} value={review.amountCents} onChange={e=>setReview({...review,amountCents:e.target.value.replace(/[^0-9-]/g,'')})}/><small>Exact integer cents. Preparing a review never posts, voids or corrects anything on its own.</small></label>}
     <label className="field field-wide">What is being proposed and why<textarea required minLength={5} maxLength={1000} value={review.summary} onChange={e=>{setReview({...review,summary:e.target.value});onDirty?.(true);}}/></label>
    </div><div className="form-actions"><button className="btn btn-primary" type="submit">{busy?'Preparing…':'Prepare for review'}</button></div></fieldset></form>
    {!subjects.length&&<p className="table-note">No current record of this kind is available to review.</p>}
   </section>
   <section className="panel"><div className="section-title"><div><h2>Reviews</h2><p>Every preparation and decision is retained with its actor and reason.</p></div></div>
    {reviews.length?<div className="table-wrap"><table><caption className="sr-only">Separation-of-duties reviews</caption>
     <thead><tr><th scope="col">Duty</th><th scope="col">Prepared by</th><th scope="col">Status</th><th scope="col">Decided by</th><th scope="col">Actions</th></tr></thead>
     <tbody>{reviews.map(item=>{const preparer=accounts.find(a=>a.id===item.preparedBy),approver=accounts.find(a=>a.id===item.approvedBy);
      return <tr key={item.id}><th scope="row" data-label="Duty">{item.dutyLabel}<small className="cell-detail">{item.summary}</small></th>
       <td data-label="Prepared by">{preparer?preparer.name:'Retained account'}</td><td data-label="Status">{item.status}{item.decisionReason?<small className="cell-detail">{item.decisionReason}</small>:null}</td>
       <td data-label="Decided by">{approver?approver.name:item.status==='Prepared'?'Awaiting a different approver':'Retained account'}</td>
       <td data-label="Actions">{item.status==='Prepared'&&item.preparedBy!==user.id?<button className="btn btn-secondary btn-small" type="button" disabled={busy} aria-label={'Decide the '+item.dutyLabel+' review'} onClick={()=>setDecision({id:item.id,version:item.version,decision:'approved',reason:'',label:item.dutyLabel})}>Decide</button>
        :item.status==='Prepared'?<span className="subtle">You prepared this</span>:<span className="subtle">Closed</span>}</td></tr>;})}</tbody></table></div>
     :<div className="empty-state"><Scale size={24} aria-hidden="true"/><h3>No reviews yet</h3><p>Prepare a reviewable action above when one is needed.</p></div>}
   </section>
   {decision&&<section className="panel"><h2>Decide: {decision.label}</h2>
    <p>Authority, the preparer’s access and the record version are all rechecked at this decision.</p>
    <form onSubmit={decide}><fieldset disabled={busy}><div className="form-grid">
     <label className="field">Decision<select ref={decisionRef} value={decision.decision} onChange={e=>setDecision({...decision,decision:e.target.value})}><option value="approved">Approve</option><option value="rejected">Reject</option></select></label>
     <label className="field field-wide">Reason for this decision<textarea required minLength={5} maxLength={1000} value={decision.reason} onChange={e=>{setDecision({...decision,reason:e.target.value});onDirty?.(true);}}/></label>
    </div><div className="form-actions"><button className="btn btn-primary" type="submit">{busy?'Recording…':'Record decision'}</button>
     <button className="btn btn-secondary" type="button" onClick={()=>{setDecision(null);onDirty?.(false);}}>Cancel</button></div></fieldset></form></section>}
  </div>}

  {tab==='security'&&<div id={panelId('security')} role="tabpanel" aria-labelledby="tenant-admin-tab-security" tabIndex={0} className="tenant-admin-panel">
   <section className="panel"><div className="section-title"><div><h2>Multi-factor enrollment</h2><p>{overview.mfaRequired?'Every interactive account must complete authenticator setup before business access.':'Every account can enroll an authenticator from Account security. Production enforces it for every role.'}</p></div></div>
    <div className="table-wrap"><table><caption className="sr-only">Authenticator enrollment by account</caption>
     <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Access</th><th scope="col">Authenticator</th><th scope="col">Unused recovery codes</th></tr></thead>
     <tbody>{accounts.map(item=><tr key={item.id}><th scope="row" data-label="Account">{item.name}<small className="cell-detail">{item.email}</small></th><td data-label="Role">{item.role}</td><td data-label="Access">{item.active?'Active':'Closed'}</td>
      <td data-label="Authenticator">{item.mfaEnabled?'Enrolled':'Setup required'}{item.mfaEnabled&&!item.mfaAvailable?<small className="cell-detail">Server key unavailable; sign-in is blocked, never bypassed.</small>:null}</td>
      <td data-label="Unused recovery codes">{item.mfaEnabled?item.recoveryCodesRemaining:'—'}</td></tr>)}</tbody></table></div>
    <p className="table-note">This view shows enrollment state only. Authenticator secrets and recovery codes are never readable here, and no administrator can disable or bypass another account’s factor. A person resets their own factor from Account security.</p></section>
  </div>}

  {tab==='branding'&&<div id={panelId('branding')} role="tabpanel" aria-labelledby="tenant-admin-tab-branding" tabIndex={0} className="tenant-admin-panel">
   <section className="panel"><div className="section-title"><div><h2>Customer branding</h2><p>Optional. {productIdentity.statement}</p></div></div>
    <form onSubmit={saveBranding}><fieldset disabled={busy}><div className="form-grid">
     <label className="field">Show your organization name<select value={String(branding.enabled)} onChange={e=>{setBranding({...branding,enabled:e.target.value==='true'});onDirty?.(true);}}><option value="false">Off</option><option value="true">On</option></select></label>
     <label className="field">Organization display name<input maxLength={120} value={branding.displayName} onChange={e=>{setBranding({...branding,displayName:e.target.value});onDirty?.(true);}}/><small>Required before branding can be turned on.</small></label>
     <label className="field">Support email<input type="email" maxLength={254} value={branding.supportEmail} onChange={e=>{setBranding({...branding,supportEmail:e.target.value});onDirty?.(true);}}/></label>
     <label className="field field-wide">Footer note<input maxLength={200} value={branding.footerNote} onChange={e=>{setBranding({...branding,footerNote:e.target.value});onDirty?.(true);}}/></label>
    </div><div className="form-actions"><button className="btn btn-primary" type="submit">{busy?'Saving…':'Save branding'}</button>
     <button className="btn btn-secondary" type="button" onClick={()=>{setBranding({...overview.branding});onDirty?.(false);}}>Reset</button></div></fieldset></form>
    <p className="tenant-admin-identity"><Palette size={16} aria-hidden="true"/>{productIdentity.productName} by {productIdentity.providedBy} remains the product identity on every screen, export and receipt.</p></section>
  </div>}

  {tab==='federation'&&<div id={panelId('federation')} role="tabpanel" aria-labelledby="tenant-admin-tab-federation" tabIndex={0} className="tenant-admin-panel">
   <section className="panel"><div className="section-title"><div><h2>Federated sign-in (optional)</h2><p>{sso.scope}</p></div></div>
    {!sso.configured&&<p className="tenant-admin-billing" role="status"><KeyRound size={16} aria-hidden="true"/>Federated sign-in is not configured on this server. No identity provider is contacted, and Wimblo credentials remain the supported sign-in.</p>}
    {sso.configured&&!sso.entitled&&<p className="tenant-admin-billing" role="status"><KeyRound size={16} aria-hidden="true"/>The {entitlements.label} plan does not include the federated sign-in connector.</p>}
    <dl className="tenant-admin-facts">
     <div><dt>State</dt><dd>{sso.enabled?'Enabled':'Disabled'}</dd></div>
     <div><dt>Issuer</dt><dd>{sso.issuer||'Not configured'}</dd></div>
     <div><dt>Client</dt><dd>{sso.clientId||'Not configured'}</dd></div>
     <div><dt>Signing keys held</dt><dd>{sso.keyCount}{sso.discoveredAt?' · discovered '+dateLabel(sso.discoveredAt):''}</dd></div>
     <div><dt>Assignable roles</dt><dd>{sso.assignableRoles.join(', ')}</dd></div>
     <div><dt>Authorization on record</dt><dd>{sso.authorizationReference||'None'}</dd></div>
    </dl>
    {sso.roleMappings.length?<div className="table-wrap"><table><caption className="sr-only">Claim to role mappings</caption>
     <thead><tr><th scope="col">Claim value in “{sso.roleClaim}”</th><th scope="col">Workspace role</th></tr></thead>
     <tbody>{sso.roleMappings.map(item=><tr key={item.claimValue}><th scope="row" data-label="Claim value">{item.claimValue}</th><td data-label="Workspace role">{item.role}</td></tr>)}</tbody></table></div>
     :<p className="table-note">No claim-to-role mapping is configured. An identity that matches no mapping is denied, and no claim can ever select an administrator.</p>}
    {sso.configured&&sso.entitled&&<form onSubmit={event=>{event.preventDefault();setEnablement(!sso.enabled);}}><fieldset disabled={busy}><div className="form-grid">
     <label className="field">Written authorization reference<input required minLength={5} maxLength={500} value={federation.authorizationReference} onChange={e=>{setFederation({...federation,authorizationReference:e.target.value});onDirty?.(true);}}/></label>
     <label className="field field-wide">Reason for this change<textarea required minLength={5} maxLength={1000} value={federation.reason} onChange={e=>{setFederation({...federation,reason:e.target.value});onDirty?.(true);}}/></label>
    </div><div className="form-actions"><button className="btn btn-primary" type="submit">{busy?'Saving…':sso.enabled?'Disable federated sign-in':'Enable federated sign-in'}</button>
     <button className="btn btn-secondary" type="button" disabled={busy} onClick={runDiscovery}>Refresh provider keys</button></div></fieldset></form>}
    <p className="table-note">Multi-factor authentication is enforced separately and is never satisfied by a federated assertion. Enabling this boundary validates an identity and maps it to a role; it issues no workspace session in this release.</p></section>
  </div>}
 </section>;
}
