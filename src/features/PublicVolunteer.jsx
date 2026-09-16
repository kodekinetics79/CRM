import React,{useEffect,useRef,useState} from 'react';
import {dateLabel} from '../lib';

// Public, unauthenticated surface served at /volunteer. It carries no workspace
// session and no cookie: the signed sign-up link in the address bar is the only
// proof of identity, and it is sent as a request header, never in a URL we fetch.
// The token stays in the address bar so a reload still works; it is expiring,
// revocable and scoped to one person's own shifts, and the server answers this
// surface with Referrer-Policy: no-referrer so it is not passed onward.
const PATH='/api/public/volunteer';
const tokenFromLocation=()=>{try{return new URLSearchParams(window.location.search).get('t')||'';}catch{return '';}};
const newRequestId=()=>globalThis.crypto?.randomUUID?globalThis.crypto.randomUUID():'00000000-0000-4000-8000-'+String(Date.now()).padStart(12,'0').slice(-12);

async function callPortal(token,path,{method='GET',body}={}){
 const response=await fetch(PATH+path,{method,credentials:'omit',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),'X-Volunteer-Token':token},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const payload=await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
 if(!response.ok){const error=new Error(payload.error||'This action could not be completed.');error.status=response.status;throw error;}
 return payload;
}

export default function PublicVolunteer({token=tokenFromLocation(),request}){
 const call=request||((path,options)=>callPortal(token,path,options));
 const [view,setView]=useState(null);
 const [loading,setLoading]=useState(Boolean(token));
 const [error,setError]=useState('');
 const [blocked,setBlocked]=useState('');
 const [conflict,setConflict]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);
 const [times,setTimes]=useState({});
 const alive=useRef(true),generation=useRef(0),noticeRef=useRef(null);
 useEffect(()=>()=>{alive.current=false;generation.current++;},[]);
 // Signing up, cancelling or recording times replaces the list that held the
 // pressed button, so focus would otherwise fall back to the top of the document.
 useEffect(()=>{if(notice)noticeRef.current?.focus?.();},[notice]);

 async function load(){
  if(!token)return;
  const current=++generation.current;setLoading(true);setError('');
  try{
   const result=await call('');
   if(!alive.current||current!==generation.current)return;
   setView(result);setBlocked('');
  }catch(e){
   if(!alive.current||current!==generation.current)return;
   setView(null);
   if(e.status===401||e.status===403)setBlocked(e.message||'This sign-up link is not usable. Ask staff for a new link.');
   else setError(e.message||'Your shifts could not be loaded right now.');
  }finally{if(alive.current&&current===generation.current)setLoading(false);}
 }
 useEffect(()=>{load();},[token,request]);

 async function act(path,body,success){
  if(busy)return;
  setBusy(true);setNotice('');setError('');setConflict('');
  try{
   const result=await call(path,{method:'POST',body});
   if(!alive.current)return;
   setView(result);setNotice(result.replayed?'That confirmation was already recorded. Nothing changed.':success);
  }catch(e){
   if(!alive.current)return;
   if(e.status===409){setConflict(e.message);await load().catch(()=>{});}
   else if(e.status===401||e.status===403){setBlocked(e.message||'This sign-up link is no longer usable.');setView(null);}
   else setError(e.message||'That could not be saved. Nothing was changed.');
  }finally{if(alive.current)setBusy(false);}
 }

 if(!token)return <Shell><section className="panel"><h2>You need your personal sign-up link</h2><p role="status">Open the sign-up link your organization sent you. This page shows your own volunteer shifts only, and it cannot be opened without that link.</p></section></Shell>;
 if(loading&&!view)return <Shell><section className="panel" role="status">Loading your volunteer shifts…</section></Shell>;
 if(blocked)return <Shell><section className="panel"><h2>This link cannot be used</h2><p role="alert">{blocked}</p><p>Your organization can issue a new link. Nothing about your record has changed.</p></section></Shell>;
 if(!view)return <Shell><section className="panel"><h2>Your shifts are unavailable</h2><p role="alert">{error||'Your shifts could not be read. Nothing is assumed to be empty.'}</p><button type="button" className="btn btn-primary" onClick={load}>Try again</button></section></Shell>;

 // A sign-up link records a bounded number of confirmations. Show that state
 // before a volunteer hits it, and never let a refusal read as lost history.
 const link=view.link||null;
 const counted=link&&Number.isFinite(link.confirmationsRecorded)&&Number.isFinite(link.confirmationsLimit);
 const exhausted=Boolean(counted&&link.confirmationsRecorded>=link.confirmationsLimit);
 const nearLimit=Boolean(counted&&!exhausted&&link.confirmationsLimit-link.confirmationsRecorded<=10);
 const active=view.reservations.filter(r=>r.status!=='Cancelled');
 const past=view.reservations.filter(r=>r.status==='Cancelled');
 const taken=new Set(active.map(r=>r.shift?.id));
 // A started shift may carry one self-reported claim. It is a claim, never hours.
 const claimable=active.filter(row=>row.status==='Reserved'&&row.shift&&row.shift.past&&(!row.claim||['Rejected','Suppressed'].includes(row.claim.status)));

 return <Shell name={view.volunteer.name}>
  {notice&&<p className="scope-banner" role="status" ref={noticeRef} tabIndex={-1}>{notice}</p>}
  {conflict&&<p className="error-banner" role="alert">{conflict}</p>}
  {error&&<p className="error-banner" role="alert">{error}</p>}
  {exhausted&&<p className="error-banner" role="status">This sign-up link has recorded its limit of {link.confirmationsLimit} confirmations. Ask staff for a new link; everything you have already confirmed stays exactly as it is.</p>}
  {nearLimit&&<p className="scope-banner" role="status">This sign-up link has recorded {link.confirmationsRecorded} of {link.confirmationsLimit} confirmations. Ask staff for a new link before it reaches the limit; everything you have already confirmed stays exactly as it is.</p>}
  <section className="panel" aria-labelledby="my-shifts-heading">
   <h2 id="my-shifts-heading">Your shifts</h2>
   {active.length?<ul className="volunteer-list">{active.map(row=><li key={row.id}>
    <div>
     <strong>{row.shift?row.shift.name:'This shift is no longer listed'}</strong>
     <small>{row.shift?dateLabel(row.shift.date)+' · '+row.shift.startTime+'–'+row.shift.endTime+' UTC':''}{row.shift?.location?' · '+row.shift.location:''}</small>
     <small>{row.status==='Reserved'?'Your place is confirmed.':'You are on the waitlist. We will confirm if a place opens.'}</small>
     {row.claim&&<small>{row.claim.status==='Claimed'?'You recorded arriving at '+row.claim.arrivedAt.slice(11,16)+' and leaving at '+row.claim.departedAt.slice(11,16)+' UTC. Staff have not confirmed it yet.':row.claim.status==='Confirmed'?'Staff confirmed what you recorded. Your hours are added separately by staff.':row.claim.status==='Rejected'?'Staff could not confirm what you recorded: '+row.claim.decisionReason:'What you recorded no longer matches this shift, so it was set aside.'}</small>}
    </div>
    <button type="button" className="btn btn-secondary" disabled={busy||!row.shift||row.shift.past}
     aria-label={row.shift&&row.shift.past?(row.shift.name+' has already started, so this place can no longer be cancelled here'):('Cancel your place on '+(row.shift?row.shift.name:'this shift'))}
     onClick={()=>act('/reservations/'+row.id+'/cancel',{requestId:newRequestId(),version:row.version,reason:'Cancelled by the volunteer'},'Your place is cancelled. Your record of it is kept.')}>
     {row.shift&&row.shift.past?'Already started':'Cancel my place'}
    </button>
   </li>)}</ul>:<p className="empty-state" role="status">You have no volunteer shifts booked yet. Choose one below.</p>}
  </section>

  <section className="panel" aria-labelledby="open-shifts-heading">
   <h2 id="open-shifts-heading">Shifts you can join</h2>
   {view.shifts.length?<ul className="volunteer-list">{view.shifts.map(row=>{
    const mine=taken.has(row.id),full=row.placesLeft===0;
    return <li key={row.id}>
     <div>
      <strong>{row.name}</strong>
      <small>{dateLabel(row.date)} · {row.startTime}–{row.endTime} UTC{row.location?' · '+row.location:''}</small>
      <small>{full?'This shift is full. '+row.waitlistCount+' on the waitlist.':row.placesLeft+' of '+row.capacity+' places left.'}</small>
     </div>
     {mine?<span className="subtle">Already on your list</span>:<button type="button" className="btn btn-primary" disabled={busy}
      aria-label={(full?'Join the waitlist for ':'Sign up for ')+row.name}
      onClick={()=>act('/reservations',{requestId:newRequestId(),shiftId:row.id,join:full?'Waitlisted':'Reserved'},full?'You are on the waitlist.':'Your place is confirmed.')}>
      {full?'Join the waitlist':'Sign up'}
     </button>}
    </li>;
   })}</ul>:<p className="empty-state" role="status">No open shifts are listed right now. Check the link again later.</p>}
  </section>

  {claimable.length>0&&<section className="panel" aria-labelledby="attendance-heading">
   <h2 id="attendance-heading">Tell us when you arrived and left</h2>
   <p>{view.attendance}</p>
   <ul className="volunteer-list">{claimable.map(row=>{
    const entry=times[row.id]||{arrived:row.shift.startTime,departed:row.shift.endTime};
    const ready=/^\d{2}:\d{2}$/.test(entry.arrived)&&/^\d{2}:\d{2}$/.test(entry.departed);
    return <li key={row.id}>
     <div>
      <strong>{row.shift.name}</strong>
      <small>{dateLabel(row.shift.date)} · times are recorded in UTC</small>
      <label className="field">I arrived at<input type="time" value={entry.arrived} disabled={busy} onChange={e=>setTimes({...times,[row.id]:{...entry,arrived:e.target.value}})}/></label>
      <label className="field">I left at<input type="time" value={entry.departed} disabled={busy} onChange={e=>setTimes({...times,[row.id]:{...entry,departed:e.target.value}})}/></label>
     </div>
     <button type="button" className="btn btn-primary" disabled={busy||!ready}
      aria-label={'Record when you arrived and left '+row.shift.name}
      onClick={()=>act('/reservations/'+row.id+'/attendance',{requestId:newRequestId(),version:row.version,arrivedAt:row.shift.date+'T'+entry.arrived+':00.000Z',departedAt:row.shift.date+'T'+entry.departed+':00.000Z'},'Thank you. Staff will confirm this; it is not confirmed hours yet.')}>
      Record my times
     </button>
    </li>;
   })}</ul>
  </section>}

  <section className="panel" aria-labelledby="reminder-heading">
   <h2 id="reminder-heading">Shift reminders</h2>
   <p>{view.consent.granted?'You have asked for reminders about shifts you have booked.':'You have not asked for shift reminders.'}</p>
   {view.contactPreference==='Do not contact'&&<p role="status">Your record is marked <strong>do not contact</strong>, so no reminder is prepared even while consent is recorded. Ask staff if that is wrong.</p>}
   <button type="button" className="btn btn-secondary" disabled={busy}
    aria-label={view.consent.granted?'Turn off shift reminders for me':'Turn on shift reminders for me'}
    onClick={()=>act('/consent',{requestId:newRequestId(),granted:!view.consent.granted},view.consent.granted?'Your reminder choice is recorded: reminders are off.':'Your reminder choice is recorded: reminders are on.')}>
    {view.consent.granted?'Turn off shift reminders':'Turn on shift reminders'}
   </button>
   <p className="subtle">This records your choice. Your organization prepares each reminder, and whether one reaches you depends on the messaging your organization has set up. This choice covers shift reminders only. It is separate from how your organization contacts you about anything else.</p>
  </section>

  {past.length>0&&<section className="panel" aria-labelledby="past-heading">
   <h2 id="past-heading">Places you cancelled</h2>
   <p className="subtle">Your organization keeps a record of every place you held and cancelled.</p>
   <ul className="volunteer-list">{past.map(row=><li key={row.id}><div>
    <strong>{row.shift?row.shift.name:'Shift no longer listed'}</strong>
    <small>{row.shift?dateLabel(row.shift.date):''} · Cancelled</small>
   </div></li>)}</ul>
  </section>}

  <p className="subtle volunteer-footer">{view.scope}{counted?' This link has recorded '+link.confirmationsRecorded+' of '+link.confirmationsLimit+' confirmations.':''}</p>
 </Shell>;
}

function Shell({name,children}){
 return <main className="public-layout volunteer-public">
  <a className="skip-link" href="#volunteer-main">Skip to your shifts</a>
  <header className="volunteer-header">
   <h1>Volunteer sign-up</h1>
   {name?<p>Signed in as {name} using your personal sign-up link.</p>:<p>Your own shifts and sign-ups.</p>}
  </header>
  <div id="volunteer-main" tabIndex={-1}>{children}</div>
 </main>;
}
