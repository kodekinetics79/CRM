import React,{useEffect,useRef,useState} from 'react';
import {cents,dateLabel,money} from '../lib.js';

// Public, unauthenticated page served at /give. It carries no workspace session
// and no session cookie. Submitting this form charges nothing, records no gift,
// creates no constituent record and changes no contact preference. A donor
// self-service link views or cancels only that donor's own recurring intention.
//
// The self-service token is read from the URL fragment, which browsers never
// place in a request line, server log or Referer header.
const FREQUENCIES=['Monthly','Quarterly','Annual'];
const initial=()=>({kind:'OneTime',amount:'',frequency:'Monthly',supporterName:'',supporterEmail:'',message:'',acknowledged:false});

async function defaultApi(path,options){
 const response=await fetch('/api/public/giving'+path,{method:options?.method||'GET',credentials:'omit',referrerPolicy:'no-referrer',headers:options?.body?{'Content-Type':'application/json'}:{},...(options?.body?{body:JSON.stringify(options.body)}:{})});
 let payload=null;try{payload=await response.json();}catch{payload=null;}
 if(!response.ok)throw Object.assign(new Error(payload?.error||'This page is temporarily unavailable.'),{status:response.status});
 return payload;
}

export default function PublicGiving({api=defaultApi,location=typeof window==='undefined'?{hash:'',search:''}:window.location}){
 const token=(()=>{const raw=String(location.hash||'');const match=/(?:^#|[#&])token=([^&]+)/.exec(raw);try{return match?decodeURIComponent(match[1]):'';}catch{return '';}})();
 const returned=(()=>{const match=/[?&]outcome=([^&]+)/.exec(String(location.search||''));return match?decodeURIComponent(match[1]):'';})();
 const [status,setStatus]=useState(null),[loading,setLoading]=useState(true),[unavailable,setUnavailable]=useState('');
 const [draft,setDraft]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(''),[receipt,setReceipt]=useState(null);
 const [intention,setIntention]=useState(null),[linkError,setLinkError]=useState(''),[cancelReason,setCancelReason]=useState(''),[cancelling,setCancelling]=useState(false),[cancelled,setCancelled]=useState(false);
 const alive=useRef(true),requestId=useRef(null),working=useRef(false);

 useEffect(()=>{alive.current=true;
  (async()=>{
   try{const result=await api('/status');if(alive.current){setStatus(result);setUnavailable('');}}
   catch(e){if(alive.current)setUnavailable(e.status===503?'Online giving is not available for this foundation right now. Please contact the foundation office to give by check or in person.':'This page could not load. Please try again later.');}
   finally{if(alive.current)setLoading(false);}
   if(returned){try{await api('/return?outcome='+encodeURIComponent(['returned','cancelled','unpaid','failed'].includes(returned)?returned:'returned'));}catch{}}
   if(token){try{const result=await api('/self-service/view',{method:'POST',body:{token}});if(alive.current){setIntention(result.intention);setLinkError('');}}
    catch(e){if(alive.current)setLinkError(e.status===403?'This link is not valid or has expired. Please ask the foundation office for a new one.':e.status===404?'This link is not available.':'Your recurring giving details could not be loaded. Please try again later.');}}
  })();
  return()=>{alive.current=false;};},[api,token,returned]);

 async function submit(event){
  event.preventDefault();
  if(working.current)return;
  setError('');setConflict('');
  let amountCents;
  try{
   amountCents=cents(draft.amount);
   if(amountCents<(status?.minimumCents||100)||amountCents>(status?.maximumCents||1e8))throw new Error('Please enter an amount between $1.00 and $1,000,000.00.');
   if(!draft.supporterName.trim())throw new Error('Please enter your name.');
   if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.supporterEmail.trim()))throw new Error('Please enter a valid email address.');
   if(!draft.acknowledged)throw new Error('Please confirm you understand that this form takes no payment.');
  }catch(e){setError(e.message);return;}
  working.current=true;setBusy(true);
  requestId.current??=globalThis.crypto.randomUUID();
  try{
   const result=await api('/submissions',{method:'POST',body:{requestId:requestId.current,kind:draft.kind,amountCents,frequency:draft.kind==='OneTime'?null:draft.frequency,supporterName:draft.supporterName.trim(),supporterEmail:draft.supporterEmail.trim(),message:draft.message.trim(),acknowledged:true}});
   if(!alive.current)return;
   // The receipt keeps the frequency that was actually submitted. Reading it back
   // from the cleared draft would tell a quarterly supporter they asked for monthly.
   setReceipt({...result,amountCents,kind:draft.kind,frequency:draft.kind==='OneTime'?null:draft.frequency});setDraft(initial());requestId.current=null;
  }catch(e){
   if(!alive.current)return;
   if(e.status===409)setConflict('This request was already received with different details. Please reload this page and start again.');
   else if(e.status===429)setError('Too many requests from this connection. Please wait a moment and try again.');
   else if(e.status===413)setError('That message is too long. Please shorten it and try again.');
   else if(e.status===403)setError('This request could not be accepted from this page.');
   else setError(e.status?'Your request was not accepted: '+e.message:'Your request was not confirmed. Nothing was submitted twice; please try again.');
  }finally{working.current=false;if(alive.current)setBusy(false);}
 }

 async function cancelIntention(event){
  event.preventDefault();
  if(working.current||!intention)return;
  setLinkError('');setConflict('');working.current=true;setBusy(true);
  try{
   const result=await api('/self-service/cancel',{method:'POST',body:{token,version:intention.version,reason:cancelReason.trim()||'Cancelled by the donor'}});
   if(!alive.current)return;
   setIntention(result.intention);setCancelled(true);setCancelling(false);setCancelReason('');
  }catch(e){
   if(!alive.current)return;
   if(e.status===409)setConflict('Your recurring giving details changed. Please reload this page and try again.');
   else setLinkError(e.status===403?'This link is not valid or has expired. Please ask the foundation office for a new one.':'Your request was not confirmed. Please reload this page and try again.');
  }finally{working.current=false;if(alive.current)setBusy(false);}
 }

 // role="status" belongs on the message, never on <main>: an ARIA role on the
 // landmark replaces it, so a screen-reader user loses the main landmark.
 if(loading)return <main className="public-giving"><h1>Give</h1><p role="status" aria-live="polite">Loading…</p></main>;
 if(unavailable)return <main className="public-giving"><h1>Give</h1><p role="alert" className="public-notice">{unavailable}</p></main>;

 return <main className="public-giving">
  <h1>Give</h1>
  <p className="public-scope">This form does not take a payment. It records your request for the foundation office to review, and a staff member will contact you about how to complete your gift. Nothing is charged here, nothing is emailed, and no gift is recorded by submitting it.</p>
  {returned&&<p role="status" className="public-notice">Returning to this page does not verify a payment or record a gift.</p>}

  {token&&<section className="public-panel"><h2>Your recurring giving</h2>
   {linkError?<p role="alert" className="public-notice">{linkError}</p>
   :!intention?<p role="status">Loading your recurring giving details…</p>
   :<>
    {cancelled&&<p role="status" className="public-notice">Your recurring giving is cancelled. Gifts you have already given are unchanged.</p>}
    <dl className="public-facts">
     <div><dt>Kind</dt><dd>{intention.commitmentOnly?'Pledge commitment':'Recurring payment'}</dd></div>
     <div><dt>Amount</dt><dd>{money(intention.amountCents)} {intention.frequency.toLowerCase()}</dd></div>
     <div><dt>Supporting</dt><dd>{intention.designationName}</dd></div>
     <div><dt>Status</dt><dd>{intention.status}</dd></div>
     <div><dt>Next date</dt><dd>{intention.nextDue?dateLabel(intention.nextDue):'No further dates'}</dd></div>
    </dl>
    <p className="public-note">This link shows only your own recurring giving. It cannot see other supporters, change your contact preferences or change gifts already recorded.</p>
    {conflict&&<p role="alert" className="public-notice">{conflict}</p>}
    {intention.status!=='Cancelled'&&(cancelling
     ?<form onSubmit={cancelIntention}><label className="public-field">Reason (optional)<textarea maxLength={500} rows={2} value={cancelReason} onChange={e=>setCancelReason(e.target.value)}/></label>
      <div className="public-actions"><button type="button" className="btn btn-secondary" onClick={()=>setCancelling(false)}>Keep my recurring giving</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy?'Cancelling…':'Confirm cancellation'}</button></div></form>
     :<div className="public-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>setCancelling(true)}>Cancel my recurring giving</button></div>)}
   </>}
  </section>}

  {!token&&(receipt
   ?<section className="public-panel"><h2>Thank you — your request was received</h2>
    <p role="status">We received your request for {money(receipt.amountCents)}{receipt.frequency?' '+String(receipt.frequency).toLowerCase():''}. Reference {receipt.submissionId}.</p>
    <p className="public-note">No payment has been taken and no gift has been recorded. A staff member will review your request and contact you.</p>
    <div className="public-actions"><button type="button" className="btn btn-secondary" onClick={()=>{setReceipt(null);setError('');setConflict('');}}>Submit another request</button></div></section>
   :<section className="public-panel"><h2>Tell us how you would like to give</h2>
    {error&&<p role="alert" className="public-notice">{error}</p>}
    {conflict&&<p role="alert" className="public-notice">{conflict}</p>}
    <form onSubmit={submit}><fieldset disabled={busy}><legend className="sr-only">Your giving request</legend>
     <div className="public-grid">
      <label className="public-field">How often<select value={draft.kind} onChange={e=>setDraft(o=>({...o,kind:e.target.value}))}>
       <option value="OneTime">Once</option><option value="Pledge">A pledge I will pay over time</option><option value="RecurringPayment">Regularly</option></select></label>
      {draft.kind!=='OneTime'&&<label className="public-field">Frequency<select value={draft.frequency} onChange={e=>setDraft(o=>({...o,frequency:e.target.value}))}>{FREQUENCIES.map(f=><option key={f} value={f}>{f}</option>)}</select></label>}
      <label className="public-field">Amount · USD<input required inputMode="decimal" value={draft.amount} onChange={e=>setDraft(o=>({...o,amount:e.target.value}))} placeholder="25.00"/></label>
      <label className="public-field">Your name<input required maxLength={120} autoComplete="name" value={draft.supporterName} onChange={e=>setDraft(o=>({...o,supporterName:e.target.value}))}/></label>
      <label className="public-field">Your email<input required type="email" maxLength={254} autoComplete="email" value={draft.supporterEmail} onChange={e=>setDraft(o=>({...o,supporterEmail:e.target.value}))}/></label>
      <label className="public-field public-field-wide">Anything you would like us to know (optional)<textarea maxLength={1000} rows={3} value={draft.message} onChange={e=>setDraft(o=>({...o,message:e.target.value}))}/></label>
     </div>
     <label className="public-confirm"><input type="checkbox" checked={draft.acknowledged} onChange={e=>setDraft(o=>({...o,acknowledged:e.target.checked}))}/>I understand this form takes no payment and records no gift.</label>
     <div className="public-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy?'Submitting…':'Submit my request'}</button></div>
    </fieldset></form></section>)}

  <p className="public-note">Prefer to give by check or in person? Please contact the foundation office. Staff record every gift directly in the foundation's records.</p>
 </main>;
}
