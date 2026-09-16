import React,{useEffect,useRef,useState} from 'react';
import {AlertTriangle,ClipboardList,RefreshCw,ShieldOff} from 'lucide-react';
import {dateLabel,money} from '../lib';

const ITEM_STATUS=['Open','In progress','Blocked','Done'];
const VENDOR_STATUS=['Considering','Confirmed','Declined'];
const BUDGET_KINDS=['Expense estimate','Income estimate'];
const emptyItem={title:'',detail:'',dueDate:'',assigneeId:''};

export default function EventPlanning({api,user,data={},notify,onDirty}){
 const [overview,setOverview]=useState(null);
 const [eventId,setEventId]=useState('');
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [conflict,setConflict]=useState('');
 const [denied,setDenied]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);
 const [checklistName,setChecklistName]=useState('');
 const [templateKey,setTemplateKey]=useState('');
 const [checklistId,setChecklistId]=useState('');
 const [item,setItem]=useState(emptyItem);
 const [budget,setBudget]=useState({kind:BUDGET_KINDS[0],category:'',description:'',amount:''});
 const [budgetProblem,setBudgetProblem]=useState('');
 const [vendor,setVendor]=useState({name:'',service:'',contactName:'',contactEmail:'',phone:'',status:VENDOR_STATUS[0],notes:''});
 const alive=useRef(true),generation=useRef(0),noticeRef=useRef(null);
 useEffect(()=>()=>{alive.current=false;generation.current++;},[]);
 const dirty=Boolean(checklistName.trim()||item.title.trim());
 useEffect(()=>{onDirty?.(dirty);},[dirty]);
 // Adding or changing a responsibility replaces the list that held the pressed
 // control, so move focus to the outcome rather than to the document.
 useEffect(()=>{if(notice)noticeRef.current?.focus?.();},[notice]);

 async function load(selected=eventId){
  const current=++generation.current;setLoading(true);setError('');
  try{
   const result=await api('/event-planning'+(selected?'?eventId='+encodeURIComponent(selected):''));
   if(!alive.current||current!==generation.current)return;
   setOverview(result);setDenied('');
  }catch(e){
   if(!alive.current||current!==generation.current)return;
   setOverview(null);
   if(e.status===401||e.status===403)setDenied(e.message||'Event planning is not available for this account.');
   else setError(e.message||'The event planning register is unavailable.');
  }finally{if(alive.current&&current===generation.current)setLoading(false);}
 }
 useEffect(()=>{load(eventId);},[api,eventId]);

 async function act(path,body,success,method='POST'){
  if(busy)return null;
  setBusy(true);setNotice('');setError('');setConflict('');
  try{
   const result=await api(path,{method,body});
   if(!alive.current)return null;
   setNotice(success);notify?.(success);
   await load(eventId);
   return result;
  }catch(e){
   if(!alive.current)return null;
   if(e.status===409){setConflict(e.message);await load(eventId).catch(()=>{});}
   else if(e.status===401||e.status===403)setDenied(e.message||'You no longer have permission for this action.');
   else setError(e.message||'This action could not be completed.');
   return null;
  }finally{if(alive.current)setBusy(false);}
 }

 const canWrite=overview?.canWrite===true;
 const events=overview?.events||[];
 const selectedEvent=events.find(e=>e.id===eventId)||null;
 const checklists=overview?.checklists||[];
 const items=overview?.items||[];
 const unresolved=overview?.unresolved||[];
 const users=overview?.assignableUsers||[];
 const checklist=checklists.find(c=>c.id===checklistId)||null;

 return <>
  <div className="page-header"><div>
   <h1>Event planning</h1>
   <p>Checklists of responsibilities, workflow assignments, planning estimates and vendor notes. Unresolved work is always listed.</p>
  </div></div>
  <p className="table-note">{overview?.scope||'Planning estimates and vendor notes only.'}</p>
  <div className="programs-toolbar">
   <label className="field">Event
    <select value={eventId} onChange={e=>{setEventId(e.target.value);setChecklistId('');}} disabled={busy}>
     <option value="">All events</option>
     {events.map(row=><option key={row.id} value={row.id}>{row.name} · {row.date}</option>)}
    </select>
   </label>
   <button type="button" className="btn btn-secondary" disabled={busy||loading} onClick={()=>{setNotice('');setConflict('');load(eventId);}}><RefreshCw size={16} aria-hidden="true"/>Refresh planning</button>
  </div>
  {notice&&<p className="scope-banner" role="status" ref={noticeRef} tabIndex={-1}>{notice}</p>}
  {conflict&&<p className="error-banner" role="alert"><AlertTriangle size={15} aria-hidden="true"/> {conflict} The latest planning records have been reloaded.</p>}
  {denied&&<p className="error-banner" role="alert"><ShieldOff size={15} aria-hidden="true"/> {denied} Ask an administrator if you need to change event planning for this workspace.</p>}
  {error&&<p className="error-banner" role="alert">{error} <button type="button" className="text-btn" onClick={()=>load(eventId)}>Try again</button></p>}
  {loading&&<section className="panel" role="status">Loading event planning…</section>}
  {!loading&&!overview&&!denied&&<section className="panel"><p className="empty-state" role="status">Planning records could not be read. Nothing is assumed to be empty.</p></section>}

  {overview&&<>
   <section className="panel" aria-labelledby="unresolved-heading">
    <h2 id="unresolved-heading">Unresolved responsibilities</h2>
    <p className="table-note">Open work with nobody responsible, an owner whose account changed, or a date that has passed.</p>
    {unresolved.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Unresolved event responsibilities</caption>
     <thead><tr><th scope="col">Responsibility</th><th scope="col">Event</th><th scope="col">Agreed date</th><th scope="col">Why it is unresolved</th></tr></thead>
     <tbody>{unresolved.map(row=><tr key={row.id}>
      <td data-label="Responsibility">{row.title}</td>
      <td data-label="Event">{events.find(e=>e.id===row.eventId)?.name||'Unavailable event'}</td>
      <td data-label="Agreed date">{dateLabel(row.dueDate)}</td>
      <td data-label="Why it is unresolved">{row.unresolvedReasons.join('; ')}</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state" role="status">Every open responsibility has a current owner and an agreed date that has not passed.</p>}
   </section>

   <section className="panel" aria-labelledby="checklists-heading">
    <h2 id="checklists-heading">Checklists</h2>
    {canWrite?<form className="programs-form" onSubmit={async e=>{
     e.preventDefault();
     if(!selectedEvent||!checklistName.trim())return;
     const result=await act('/event-planning/checklists',{eventId:selectedEvent.id,eventVersion:selectedEvent.version,name:checklistName.trim(),templateKey:templateKey||null},'Checklist created.');
     if(result){setChecklistName('');setTemplateKey('');setChecklistId(result.checklist.id);}
    }}>
     <fieldset disabled={busy||!selectedEvent}>
      <legend className="sr-only">Create a checklist</legend>
      <label className="field">Checklist name<input value={checklistName} onChange={e=>setChecklistName(e.target.value)} maxLength={250} required placeholder="Run of show"/></label>
      <label className="field">Start from a template
       <select value={templateKey} onChange={e=>setTemplateKey(e.target.value)}>
        <option value="">No template — start empty</option>
        {(overview.templates||[]).map(row=><option key={row.key} value={row.key}>{row.name} ({row.itemCount} responsibilities)</option>)}
       </select>
       <small>A template creates dated responsibilities relative to the event date. The event owns them from then on.</small>
      </label>
      <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={busy||!selectedEvent||!checklistName.trim()}><ClipboardList size={16} aria-hidden="true"/>Create checklist</button></div>
      {!selectedEvent&&<p className="subtle">Choose one event above before creating a checklist.</p>}
     </fieldset>
    </form>:<p className="table-note">You have read-only access. Checklists and assignments are changed by administrators and staff.</p>}
    {checklists.length?<label className="field">Open a checklist
     <select value={checklistId} onChange={e=>setChecklistId(e.target.value)}>
      <option value="">Choose a checklist…</option>
      {checklists.map(row=><option key={row.id} value={row.id}>{row.name}{row.templateKey?' · from template':''}</option>)}
     </select>
    </label>:<p className="empty-state">No checklists exist for this selection yet.</p>}
   </section>

   {checklist&&<section className="panel" aria-labelledby="checklist-items-heading">
    <h2 id="checklist-items-heading">{checklist.name}</h2>
    <div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Responsibilities in {checklist.name}</caption>
     <thead><tr><th scope="col">Responsibility</th><th scope="col">Agreed date</th><th scope="col">Responsible</th><th scope="col">State</th><th scope="col">Change</th></tr></thead>
     <tbody>{items.filter(row=>row.checklistId===checklist.id).map(row=><tr key={row.id}>
      <td data-label="Responsibility">{row.title}{row.detail?<small className="subtle">{row.detail}</small>:null}</td>
      <td data-label="Agreed date">{dateLabel(row.dueDate)}{row.overdue?' · passed':''}</td>
      <td data-label="Responsible">{row.assignee?row.assignee.name:'Nobody yet'}{row.assignee&&!row.assignmentCurrent?' · account changed':''}</td>
      <td data-label="State">{row.status}</td>
      <td data-label="Change">{canWrite?<div className="programs-row-actions">
       <label className="sr-only" htmlFor={'assign-'+row.id}>Responsible for {row.title}</label>
       <select id={'assign-'+row.id} value={row.assignee?.id||''} disabled={busy||row.status==='Done'} onChange={e=>{
        const chosen=users.find(u=>u.id===e.target.value)||null;
        act('/event-planning/items/'+row.id+'/assign',{version:row.version,assigneeId:chosen?chosen.id:null,assigneeVersion:chosen?chosen.version:null,reason:'Responsibility set from the event planning screen'},chosen?'Responsibility assigned.':'Owner cleared. It is listed as unresolved.');
       }}>
        <option value="">Nobody</option>
        {users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
       </select>
       <label className="sr-only" htmlFor={'status-'+row.id}>State of {row.title}</label>
       {/* The server accepts a move away from Done, so the screen must not lock the
           row: a mistaken keyboard change here would otherwise be unrecoverable. */}
       <select id={'status-'+row.id} value={row.status} disabled={busy} onChange={e=>act('/event-planning/items/'+row.id+'/status',{version:row.version,status:e.target.value,reason:'State changed from the event planning screen'},'Responsibility recorded as '+e.target.value+'.')}>
        {ITEM_STATUS.map(value=><option key={value} value={value}>{value}</option>)}
       </select>
      </div>:<span className="subtle">Read only</span>}</td>
     </tr>)}</tbody>
    </table></div>
    {canWrite&&<p className="table-note">Choosing a person or a state in the Change column saves as soon as you choose it. Every change is retained with its reason, and any state can be chosen again.</p>}
    {!items.some(row=>row.checklistId===checklist.id)&&<p className="empty-state">This checklist has no responsibilities yet.</p>}
    {canWrite&&<form className="programs-form" onSubmit={async e=>{
     e.preventDefault();
     if(!item.title.trim()||!item.dueDate)return;
     const chosen=users.find(u=>u.id===item.assigneeId)||null;
     const result=await act('/event-planning/checklists/'+checklist.id+'/items',{version:checklist.version,title:item.title.trim(),detail:item.detail.trim(),dueDate:item.dueDate,assigneeId:chosen?chosen.id:null,assigneeVersion:chosen?chosen.version:null},'Responsibility added.');
     if(result)setItem(emptyItem);
    }}>
     <fieldset disabled={busy}>
      <legend>Add a responsibility</legend>
      <label className="field">What must happen<input value={item.title} onChange={e=>setItem({...item,title:e.target.value})} maxLength={250} required/></label>
      <label className="field">Detail<input value={item.detail} onChange={e=>setItem({...item,detail:e.target.value})} maxLength={2000}/></label>
      <label className="field">Agreed date<input type="date" value={item.dueDate} onChange={e=>setItem({...item,dueDate:e.target.value})} required/></label>
      <label className="field">Responsible
       <select value={item.assigneeId} onChange={e=>setItem({...item,assigneeId:e.target.value})}>
        <option value="">Decide later — it will be listed as unresolved</option>
        {users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
       </select>
      </label>
      <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={busy||!item.title.trim()||!item.dueDate}>Add responsibility</button></div>
     </fieldset>
    </form>}
   </section>}

   <section className="panel" aria-labelledby="budget-heading">
    <h2 id="budget-heading">Planning estimates</h2>
    <p className="table-note">{overview.budgetTotals.meaning}</p>
    <p>Expense estimate {money(overview.budgetTotals.expenseEstimate)} · Income estimate {money(overview.budgetTotals.incomeEstimate)}</p>
    {overview.budgetLines.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Event planning estimates</caption>
     <thead><tr><th scope="col">Kind</th><th scope="col">Category</th><th scope="col">Description</th><th scope="col">Estimate</th></tr></thead>
     <tbody>{overview.budgetLines.map(row=><tr key={row.id}>
      <td data-label="Kind">{row.kind}</td>
      <td data-label="Category">{row.category}</td>
      <td data-label="Description">{row.description||'—'}</td>
      <td data-label="Estimate">{money(row.plannedCents)}</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state">No planning estimates have been recorded.</p>}
    {canWrite&&selectedEvent&&<form className="programs-form" onSubmit={async e=>{
     e.preventDefault();
     if(!/^\d+(\.\d{1,2})?$/.test(budget.amount.trim())){setBudgetProblem('Enter an amount with no more than two decimal places.');return;}
     setBudgetProblem('');
     const [whole,fraction='']=budget.amount.trim().split('.');
     const saved=await act('/event-planning/budget-lines',{eventId:selectedEvent.id,eventVersion:selectedEvent.version,kind:budget.kind,category:budget.category.trim(),description:budget.description.trim(),plannedCents:Number(whole)*100+Number(fraction.padEnd(2,'0'))},'Planning estimate recorded. No revenue or expense is posted.');
     if(saved)setBudget({kind:BUDGET_KINDS[0],category:'',description:'',amount:''});
    }}>
     <fieldset disabled={busy}>
      <legend>Add a planning estimate</legend>
      <label className="field">Kind<select value={budget.kind} onChange={e=>setBudget({...budget,kind:e.target.value})}>{BUDGET_KINDS.map(k=><option key={k} value={k}>{k}</option>)}</select></label>
      <label className="field">Category<input value={budget.category} onChange={e=>setBudget({...budget,category:e.target.value})} maxLength={250} required/></label>
      <label className="field">Description<input value={budget.description} onChange={e=>setBudget({...budget,description:e.target.value})} maxLength={2000}/></label>
      <label className="field">Estimated amount · USD<input value={budget.amount} onChange={e=>setBudget({...budget,amount:e.target.value})} inputMode="decimal" required/></label>
      {budgetProblem&&<p className="error-banner" role="alert">{budgetProblem}</p>}
      <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={busy||!budget.category.trim()||!budget.amount.trim()}>Add estimate</button></div>
     </fieldset>
    </form>}
   </section>

   <section className="panel" aria-labelledby="vendor-heading">
    <h2 id="vendor-heading">Vendors</h2>
    <p className="table-note">A planning contact list. A vendor here is never a constituent identity, an agreement or a payment.</p>
    {overview.vendors.length?<div className="table-wrap"><table className="programs-table">
     <caption className="sr-only">Event vendors under consideration</caption>
     <thead><tr><th scope="col">Vendor</th><th scope="col">Service</th><th scope="col">Contact</th><th scope="col">State</th></tr></thead>
     <tbody>{overview.vendors.map(row=><tr key={row.id}>
      <td data-label="Vendor">{row.name}</td>
      <td data-label="Service">{row.service||'—'}</td>
      <td data-label="Contact">{[row.contactName,row.contactEmail,row.phone].filter(Boolean).join(' · ')||'—'}</td>
      <td data-label="State">{row.status}</td>
     </tr>)}</tbody>
    </table></div>:<p className="empty-state">No vendors are listed.</p>}
    {canWrite&&selectedEvent&&<form className="programs-form" onSubmit={async e=>{
     e.preventDefault();
     const saved=await act('/event-planning/vendors',{eventId:selectedEvent.id,eventVersion:selectedEvent.version,...vendor},'Vendor added to the planning list.');
     if(saved)setVendor({name:'',service:'',contactName:'',contactEmail:'',phone:'',status:VENDOR_STATUS[0],notes:''});
    }}>
     <fieldset disabled={busy}>
      <legend>Add a vendor</legend>
      <label className="field">Vendor name<input value={vendor.name} onChange={e=>setVendor({...vendor,name:e.target.value})} maxLength={250} required/></label>
      <label className="field">Service<input value={vendor.service} onChange={e=>setVendor({...vendor,service:e.target.value})} maxLength={250}/></label>
      <label className="field">Contact name<input value={vendor.contactName} onChange={e=>setVendor({...vendor,contactName:e.target.value})} maxLength={250}/></label>
      <label className="field">Contact email<input type="email" value={vendor.contactEmail} onChange={e=>setVendor({...vendor,contactEmail:e.target.value})} maxLength={254}/></label>
      <label className="field">Phone<input value={vendor.phone} onChange={e=>setVendor({...vendor,phone:e.target.value})} maxLength={250}/></label>
      <label className="field">State<select value={vendor.status} onChange={e=>setVendor({...vendor,status:e.target.value})}>{VENDOR_STATUS.map(s=><option key={s} value={s}>{s}</option>)}</select></label>
      <label className="field">Notes<input value={vendor.notes} onChange={e=>setVendor({...vendor,notes:e.target.value})} maxLength={2000}/></label>
      <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={busy||!vendor.name.trim()}>Add vendor</button></div>
     </fieldset>
    </form>}
   </section>
  </>}
 </>;
}
