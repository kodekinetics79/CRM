import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Building2,Link2,AlertTriangle,RefreshCw} from 'lucide-react';
import {api as defaultApi} from '../api.js';
import {money} from '../lib.js';

// A8.8 / A8.1. Locations are unique; one function may serve many locations and each
// location/function pair is one unique account. A designation carries at most one
// account, so a gift allocated once is reported once in every rollup here.
const TABS=[['structure','Locations & accounts'],['designations','Designation links'],['rollups','Rollups']];
const GROUPS=[['location','By location'],['function','By function'],['pair','By account']];
const kindOf=status=>status===409?'conflict':status===403?'permission':status===401?'session':status===503?'source':'failure';
const TITLES={conflict:'This changed while you were working',permission:'You cannot make this change',session:'Your sign-in changed',source:'Saved records need review',failure:'That did not save'};

export default function AccountStructure({api=defaultApi,user,notify,onDirty}){
 const [tab,setTab]=useState('structure');
 const [groupBy,setGroupBy]=useState('location');
 const [filters,setFilters]=useState({locationId:'',functionId:'',link:'All',search:''});
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [overview,setOverview]=useState(null),[pairs,setPairs]=useState(null),[rollup,setRollup]=useState(null),[funds,setFunds]=useState(null);
 const [error,setError]=useState(null),[done,setDone]=useState('');
 const [newLocation,setNewLocation]=useState({code:'',name:''}),[newFunction,setNewFunction]=useState({code:'',name:''}),[newPair,setNewPair]=useState({locationId:'',functionId:''});
 const [linkForm,setLinkForm]=useState({designationId:'',pairId:'',reason:''});
 // Retiring, reinstating and unlinking all need a retained reason. They used a
 // native window.prompt, which is unlabelled for assistive technology and does
 // nothing at all — with no feedback — where a browser suppresses dialogs.
 const [lifecycle,setLifecycle]=useState(null);
 const lifecycleRef=useRef(null);

 const query=useMemo(()=>{const parts=['limit=100'];if(filters.locationId)parts.push('locationId='+filters.locationId);if(filters.functionId)parts.push('functionId='+filters.functionId);if(filters.link!=='All')parts.push('link='+filters.link);if(filters.search.trim())parts.push('search='+encodeURIComponent(filters.search.trim()));return '?'+parts.join('&');},[filters]);
 const refresh=useCallback(async()=>{
  const base=await api('/account-structure');
  const [pairPage,rollupData,fundPage]=await Promise.all([api('/account-structure/pairs?limit=500'),api('/account-structure/rollups?groupBy='+groupBy),api('/account-structure/designations'+query)]);
  setOverview(base);setPairs(pairPage);setRollup(rollupData);setFunds(fundPage);
  return base;
 },[api,groupBy,query]);
 useEffect(()=>{let active=true;setLoading(true);refresh().catch(e=>{if(active)setError({message:e.message,kind:kindOf(e.status)});}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[refresh]);
 useEffect(()=>()=>{onDirty?.(false);},[onDirty]);
 useEffect(()=>{if(lifecycle)lifecycleRef.current?.focus?.();},[lifecycle?.path]);

 const canManage=overview?.canManage===true||user?.role==='admin';
 const act=async(message,run,after)=>{
  setBusy(true);setError(null);setDone('');
  try{await run();await refresh();setDone(message);notify?.(message);after?.();onDirty?.(false);}
  catch(e){setError({message:e.message,kind:kindOf(e.status)});}
  finally{setBusy(false);}
 };
 const createLocation=e=>{e.preventDefault();act('Location '+newLocation.code+' added.',()=>api('/account-structure/locations',{method:'POST',body:{code:newLocation.code.trim(),name:newLocation.name.trim()}}),()=>setNewLocation({code:'',name:''}));};
 const createFunction=e=>{e.preventDefault();act('Function '+newFunction.code+' added.',()=>api('/account-structure/functions',{method:'POST',body:{code:newFunction.code.trim(),name:newFunction.name.trim()}}),()=>setNewFunction({code:'',name:''}));};
 const createPair=e=>{e.preventDefault();
  const location=overview.locations.find(l=>l.id===newPair.locationId),fn=overview.functions.find(x=>x.id===newPair.functionId);
  if(!location||!fn)return setError({message:'Choose an active location and an active function.',kind:'failure'});
  act('Account '+location.code+'-'+fn.code+' added.',()=>api('/account-structure/pairs',{method:'POST',body:{locationId:location.id,locationVersion:location.version,functionId:fn.id,functionVersion:fn.version}}),()=>setNewPair({locationId:'',functionId:''}));
 };
 const changeStatus=(kind,row,status)=>{setError(null);setDone('');setLifecycle({
  reason:'',path:'/account-structure/'+kind+'/'+row.id+'/status',body:{version:row.version,status},
  title:(status==='Retired'?'Retire ':'Reinstate ')+(row.code||row.name),
  detail:status==='Retired'?'Retiring closes this to new links only. Its history is kept and every posted gift keeps reporting exactly where it does now.':'Reinstating opens this for new links again. No posted gift moves and no total changes.',
  confirm:status==='Retired'?'Retire it':'Reinstate it',
  message:(status==='Retired'?'Retired ':'Reinstated ')+(row.code||row.name)+'.'});};
 const submitLink=e=>{e.preventDefault();
  const fund=funds.designations.find(d=>d.id===linkForm.designationId),pair=pairs.pairs.find(p=>p.id===linkForm.pairId);
  if(!fund||!pair)return setError({message:'Choose a designation from this list and an open account.',kind:'failure'});
  act(fund.name+' now reports to account '+pair.code+'.',()=>api('/account-structure/designations/'+fund.id+'/link',{method:'POST',body:{designationVersion:fund.version,pairId:pair.id,pairVersion:pair.version,reason:linkForm.reason.trim()}}),()=>setLinkForm({designationId:'',pairId:'',reason:''}));
 };
 const removeLink=fund=>{setError(null);setDone('');setLifecycle({
  reason:'',path:'/account-structure/designations/'+fund.id+'/unlink',body:{version:fund.account.linkVersion},
  title:'Remove the account link for '+fund.name,
  detail:'Posted gifts stay exactly where they are. Only reporting for new allocations under this account is affected.',
  confirm:'Remove the link',
  message:'Removed the account link for '+fund.name+'.'});};
 const submitLifecycle=e=>{e.preventDefault();
  if(!lifecycle||!lifecycle.reason.trim())return;
  const run=lifecycle;setLifecycle(null);
  act(run.message,()=>api(run.path,{method:'POST',body:{...run.body,reason:run.reason.trim()}}));
 };

 const openPairs=pairs?pairs.pairs.filter(p=>p.open):[];
 const activeLocations=overview?overview.locations.filter(l=>l.status==='Active'):[];
 const activeFunctions=overview?overview.functions.filter(x=>x.status==='Active'):[];
 const totals=rollup?.totals;

 return <><div className="page-header"><div><h1>Accounts &amp; locations</h1><p>Link designations to locations and functions without duplicating revenue.</p></div><Building2 size={24} aria-hidden="true"/></div>

 <p className="table-note">Locations are unique. One function can serve many locations, and every location and function pair is one separate account. A designation reports to one account only, so a gift allocated once is counted once everywhere below. Account structure grants no permission and no consent.</p>

 {error&&<div className="error-banner" role="alert"><AlertTriangle size={16} aria-hidden="true"/> <strong>{TITLES[error.kind]}.</strong> {error.message}{['conflict','source'].includes(error.kind)&&<> <button className="text-btn" type="button" onClick={()=>{setError(null);setLoading(true);refresh().catch(e=>setError({message:e.message,kind:kindOf(e.status)})).finally(()=>setLoading(false));}}>Reload current values</button></>}</div>}
 <p role="status" aria-live="polite" className="table-note">{busy?'Saving…':done||(loading?'Loading account structure…':'')}</p>

 {loading&&!overview?<section className="panel" aria-busy="true"><p>Loading locations, accounts and rollups…</p></section>:
  !overview?<section className="panel"><div className="empty-state"><h3>Account structure is unavailable</h3><p>Reopen this screen to try again.</p></div></section>:<>

 {!canManage&&<p className="table-note">You can review every location, account and rollup here. Only an administrator can add, retire or relink accounts.</p>}

 <div className="operations-tabs" role="tablist" aria-label="Account structure views">
  {TABS.map(([key,text])=><button key={key} type="button" role="tab" id={'account-tab-'+key} aria-selected={tab===key} aria-controls={'account-panel-'+key} tabIndex={tab===key?0:-1} className="text-btn" onClick={()=>setTab(key)}>{text}</button>)}
 </div>

 {lifecycle&&<section className="panel" aria-labelledby="account-lifecycle-heading">
  <h2 id="account-lifecycle-heading">{lifecycle.title}</h2>
  <p>{lifecycle.detail}</p>
  <form onSubmit={submitLifecycle} aria-busy={busy}><fieldset disabled={busy}><legend className="sr-only">{lifecycle.title}</legend><div className="form-grid">
   <label className="field field-wide"><span>Reason</span><input ref={lifecycleRef} name="lifecycleReason" required maxLength={500} value={lifecycle.reason} onChange={e=>setLifecycle({...lifecycle,reason:e.target.value})}/><span className="subtle">Kept in retained account history with your account and the exact version this was decided on.</span></label>
  </div><div className="form-actions">
   <button className="btn btn-primary" type="submit" disabled={busy||!lifecycle.reason.trim()}>{lifecycle.confirm}</button>
   <button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>setLifecycle(null)}>Cancel</button>
  </div></fieldset></form>
 </section>}

 {tab==='structure'&&<section className="panel" id="account-panel-structure" role="tabpanel" aria-labelledby="account-tab-structure" tabIndex={-1}>
  <div className="section-title"><div><h2>Locations, functions and accounts</h2><p>{overview.counts.activeLocations} of {overview.counts.locations} locations active · {overview.counts.activeFunctions} of {overview.counts.functions} functions active · {overview.counts.pairs} accounts · {overview.counts.linkedDesignations} designations linked.</p></div></div>

  {canManage&&<><form onSubmit={createLocation} aria-busy={busy}><fieldset disabled={busy}><legend className="sr-only">Add a location</legend><div className="form-grid">
   <label className="field"><span>Location code</span><input name="locationCode" required inputMode="numeric" pattern="[0-9]{3}" maxLength={3} value={newLocation.code} onChange={e=>{setNewLocation({...newLocation,code:e.target.value});onDirty?.(true);}}/><span className="subtle">Three digits, unique across the workspace.</span></label>
   <label className="field"><span>Location name</span><input name="locationName" required maxLength={120} value={newLocation.name} onChange={e=>{setNewLocation({...newLocation,name:e.target.value});onDirty?.(true);}}/><span className="subtle">One school, department or district-wide place.</span></label>
   <div className="form-actions"><button className="btn btn-primary" type="submit">Add location</button></div>
  </div></fieldset></form>
  <form onSubmit={createFunction} aria-busy={busy}><fieldset disabled={busy}><legend className="sr-only">Add a function</legend><div className="form-grid">
   <label className="field"><span>Function code</span><input name="functionCode" required inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={newFunction.code} onChange={e=>{setNewFunction({...newFunction,code:e.target.value});onDirty?.(true);}}/><span className="subtle">Four digits. One function may serve many locations.</span></label>
   <label className="field"><span>Function name</span><input name="functionName" required maxLength={120} value={newFunction.name} onChange={e=>{setNewFunction({...newFunction,name:e.target.value});onDirty?.(true);}}/></label>
   <div className="form-actions"><button className="btn btn-primary" type="submit">Add function</button></div>
  </div></fieldset></form>
  <form onSubmit={createPair} aria-busy={busy}><fieldset disabled={busy||!activeLocations.length||!activeFunctions.length}><legend className="sr-only">Open an account for a location and function</legend><div className="form-grid">
   <label className="field"><span>Location</span><select name="pairLocation" required value={newPair.locationId} onChange={e=>setNewPair({...newPair,locationId:e.target.value})}><option value="">Choose a location</option>{activeLocations.map(l=><option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>
   <label className="field"><span>Function</span><select name="pairFunction" required value={newPair.functionId} onChange={e=>setNewPair({...newPair,functionId:e.target.value})}><option value="">Choose a function</option>{activeFunctions.map(x=><option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
   <div className="form-actions"><button className="btn btn-secondary" type="submit">Open account</button></div>
  </div></fieldset></form></>}

  <h3>Locations</h3>
  {!overview.locations.length?<div className="empty-state"><h3>No locations yet</h3><p>Add a three-digit location for each school, department or district-wide place.</p></div>:<>
  <div className="table-wrap"><table className="desktop-record-table" aria-label="Locations"><caption>Retiring a location keeps its history and every posted gift.</caption>
   <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Status</th><th scope="col" className="money">Accounts</th>{canManage&&<th scope="col">Lifecycle</th>}</tr></thead>
   <tbody>{overview.locations.map(l=><tr key={l.id}><td>{l.code}</td><td>{l.name}</td><td>{l.status}</td><td className="money">{pairs?pairs.pairs.filter(p=>p.locationId===l.id).length:'—'}</td>{canManage&&<td><button className="text-btn" type="button" disabled={busy} onClick={()=>changeStatus('locations',l,l.status==='Active'?'Retired':'Active')}>{l.status==='Active'?'Retire':'Reinstate'}<span className="sr-only"> location {l.code} {l.name}</span></button></td>}</tr>)}</tbody></table></div>
  <div className="mobile-records" aria-label="Locations mobile list">{overview.locations.map(l=><article key={l.id}><div className="mobile-record-primary"><strong>{l.code} · {l.name}</strong></div><dl><div><dt>Status</dt><dd>{l.status}</dd></div><div><dt>Accounts</dt><dd className="money">{pairs?pairs.pairs.filter(p=>p.locationId===l.id).length:'—'}</dd></div></dl>{canManage&&<button className="text-btn" type="button" disabled={busy} onClick={()=>changeStatus('locations',l,l.status==='Active'?'Retired':'Active')}>{l.status==='Active'?'Retire':'Reinstate'}<span className="sr-only"> location {l.code} {l.name}</span></button>}</article>)}</div></>}

  <h3>Functions</h3>
  {!overview.functions.length?<div className="empty-state"><h3>No functions yet</h3><p>Add a four-digit function such as classroom support or student pantry.</p></div>:
  <><div className="table-wrap"><table className="desktop-record-table" aria-label="Functions"><caption>A function may serve several locations; each pairing is a separate account.</caption>
   <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Status</th><th scope="col" className="money">Locations served</th>{canManage&&<th scope="col">Lifecycle</th>}</tr></thead>
   <tbody>{overview.functions.map(x=><tr key={x.id}><td>{x.code}</td><td>{x.name}</td><td>{x.status}</td><td className="money">{pairs?pairs.pairs.filter(p=>p.functionId===x.id).length:'—'}</td>{canManage&&<td><button className="text-btn" type="button" disabled={busy} onClick={()=>changeStatus('functions',x,x.status==='Active'?'Retired':'Active')}>{x.status==='Active'?'Retire':'Reinstate'}<span className="sr-only"> function {x.code} {x.name}</span></button></td>}</tr>)}</tbody></table></div>
  <div className="mobile-records" aria-label="Functions mobile list">{overview.functions.map(x=><article key={x.id}><div className="mobile-record-primary"><strong>{x.code} · {x.name}</strong></div><dl><div><dt>Status</dt><dd>{x.status}</dd></div><div><dt>Locations served</dt><dd className="money">{pairs?pairs.pairs.filter(p=>p.functionId===x.id).length:'—'}</dd></div></dl>{canManage&&<button className="text-btn" type="button" disabled={busy} onClick={()=>changeStatus('functions',x,x.status==='Active'?'Retired':'Active')}>{x.status==='Active'?'Retire':'Reinstate'}<span className="sr-only"> function {x.code} {x.name}</span></button>}</article>)}</div></>}

  <h3>Accounts</h3>
  {!pairs||!pairs.pairs.length?<div className="empty-state"><h3>No accounts yet</h3><p>Open an account by pairing one location with one function.</p></div>:<>
  <div className="table-wrap"><table className="desktop-record-table" aria-label="Location and function accounts"><caption>{pairs.matched} accounts. Each location and function pairing is unique.</caption>
   <thead><tr><th scope="col">Account</th><th scope="col">Location</th><th scope="col">Function</th><th scope="col">Status</th><th scope="col" className="money">Designations</th>{canManage&&<th scope="col">Lifecycle</th>}</tr></thead>
   <tbody>{pairs.pairs.map(p=><tr key={p.id}><td>{p.code}</td><td>{p.locationCode} · {p.locationName}{p.locationStatus!=='Active'&&' (retired)'}</td><td>{p.functionCode} · {p.functionName}{p.functionStatus!=='Active'&&' (retired)'}</td><td>{p.status}{p.open?'':' · closed to new links'}</td><td className="money">{p.linkedDesignations}</td>{canManage&&<td><button className="text-btn" type="button" disabled={busy} onClick={()=>changeStatus('pairs',p,p.status==='Active'?'Retired':'Active')}>{p.status==='Active'?'Retire':'Reinstate'}<span className="sr-only"> account {p.code}</span></button></td>}</tr>)}</tbody></table></div>
  <div className="mobile-records" aria-label="Accounts mobile list">{pairs.pairs.map(p=><article key={p.id}><div className="mobile-record-primary"><strong>{p.code}</strong></div><dl><div><dt>Location</dt><dd>{p.locationCode} · {p.locationName}</dd></div><div><dt>Function</dt><dd>{p.functionCode} · {p.functionName}</dd></div><div><dt>Status</dt><dd>{p.status}</dd></div><div><dt>Designations</dt><dd className="money">{p.linkedDesignations}</dd></div></dl>{canManage&&<button className="text-btn" type="button" disabled={busy} onClick={()=>changeStatus('pairs',p,p.status==='Active'?'Retired':'Active')}>{p.status==='Active'?'Retire':'Reinstate'}<span className="sr-only"> account {p.code}</span></button>}</article>)}</div></>}
 </section>}

 {tab==='designations'&&<section className="panel" id="account-panel-designations" role="tabpanel" aria-labelledby="account-tab-designations" tabIndex={-1}>
  <div className="section-title"><div><h2>Designation links</h2><p>{funds?`${funds.matched} of ${funds.total} designations match. ${funds.hierarchy.roots} top-level, deepest level ${funds.hierarchy.maxDepth}.`:'Loading designations…'}</p></div></div>
  {funds?.hierarchy.cycles>0&&<p className="table-note" role="alert">{funds.hierarchy.cycles} designations sit in an inconsistent parent and child chain. Their own totals stay exact, but their subtree totals and linking are held back until the hierarchy is corrected.</p>}
  <div className="toolbar"><div className="form-grid">
   <label className="field"><span>Location</span><select name="filterLocation" value={filters.locationId} onChange={e=>setFilters({...filters,locationId:e.target.value})}><option value="">All locations</option>{overview.locations.map(l=><option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}</select></label>
   <label className="field"><span>Function</span><select name="filterFunction" value={filters.functionId} onChange={e=>setFilters({...filters,functionId:e.target.value})}><option value="">All functions</option>{overview.functions.map(x=><option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></label>
   <label className="field"><span>Account link</span><select name="filterLink" value={filters.link} onChange={e=>setFilters({...filters,link:e.target.value})}>{['All','Linked','Unlinked'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
   <label className="field"><span>Search name or code</span><input name="filterSearch" value={filters.search} maxLength={120} onChange={e=>setFilters({...filters,search:e.target.value})}/></label>
  </div></div>

  {canManage&&<form onSubmit={submitLink} aria-busy={busy}><fieldset disabled={busy||!openPairs.length||!funds?.designations.length}><legend className="sr-only">Link a designation to an account</legend><div className="form-grid">
   <label className="field"><span>Designation</span><select name="linkDesignation" required value={linkForm.designationId} onChange={e=>{setLinkForm({...linkForm,designationId:e.target.value});onDirty?.(true);}}><option value="">Choose a designation from this list</option>{funds?.designations.map(d=><option key={d.id} value={d.id}>{d.accountCode?d.accountCode+' · ':''}{d.name}</option>)}</select></label>
   <label className="field"><span>Account</span><select name="linkPair" required value={linkForm.pairId} onChange={e=>setLinkForm({...linkForm,pairId:e.target.value})}><option value="">Choose an open account</option>{openPairs.map(p=><option key={p.id} value={p.id}>{p.code} · {p.locationName} · {p.functionName}</option>)}</select></label>
   <label className="field field-wide"><span>Reason</span><input name="linkReason" required maxLength={500} value={linkForm.reason} onChange={e=>setLinkForm({...linkForm,reason:e.target.value})}/><span className="subtle">Kept in retained account history. Linking never changes a designation, its parent or a posted gift.</span></label>
   <div className="form-actions"><button className="btn btn-primary" type="submit"><Link2 size={15} aria-hidden="true"/>Link designation</button></div>
  </div></fieldset></form>}
  {canManage&&!openPairs.length&&<p className="table-note">Open at least one account before linking designations.</p>}

  {!funds?<p aria-busy="true">Loading designations…</p>:!funds.designations.length?<div className="empty-state"><h3>No designations match</h3><p>Clear the location, function or search filters to see more.</p></div>:<>
  <div className="table-wrap"><table className="desktop-record-table" aria-label="Designations and their accounts"><caption>Own value is this designation&apos;s own allocations and adds up without overlap. With subaccounts includes descendants and must not be added across levels.</caption>
   <thead><tr><th scope="col">Account code</th><th scope="col">Designation</th><th scope="col">Parent</th><th scope="col">Account</th><th scope="col" className="money">Own value</th><th scope="col" className="money">With subaccounts</th>{canManage&&<th scope="col">Link</th>}</tr></thead>
   <tbody>{funds.designations.map(d=><tr key={d.id}><td>{d.accountCode||'—'}</td><td>{d.name}{d.hierarchyIssue&&<span className="cell-detail"> Hierarchy needs review</span>}</td><td>{d.parentName||'Top level'}</td><td>{d.account?`${d.account.pairCode} · ${d.account.locationName} · ${d.account.functionName}`:'Not linked'}</td><td className="money">{money(d.directCents)}</td><td className="money">{d.subtreeCents===null?'—':money(d.subtreeCents)}</td>{canManage&&<td>{d.account?<button className="text-btn" type="button" disabled={busy} onClick={()=>removeLink(d)}>Remove link<span className="sr-only"> for {d.name}</span></button>:<span className="cell-detail">—</span>}</td>}</tr>)}</tbody></table></div>
  <div className="mobile-records" aria-label="Designations mobile list">{funds.designations.map(d=><article key={d.id}><div className="mobile-record-primary"><strong>{d.accountCode?d.accountCode+' · ':''}{d.name}</strong></div><dl>
   <div><dt>Account</dt><dd>{d.account?d.account.pairCode:'Not linked'}</dd></div>
   <div><dt>Parent</dt><dd>{d.parentName||'Top level'}</dd></div>
   <div><dt>Own value</dt><dd className="money">{money(d.directCents)}</dd></div>
   <div><dt>With subaccounts</dt><dd className="money">{d.subtreeCents===null?'—':money(d.subtreeCents)}</dd></div>
  </dl>{canManage&&d.account&&<button className="text-btn" type="button" disabled={busy} onClick={()=>removeLink(d)}>Remove link<span className="sr-only"> for {d.name}</span></button>}</article>)}</div>
  <p className="table-note">Showing {funds.returned} of {funds.matched} matching designations. Matched own value {money(funds.matchedTotals.directCents)} across {funds.matchedTotals.directAllocations} allocations.</p></>}
 </section>}

 {tab==='rollups'&&<section className="panel" id="account-panel-rollups" role="tabpanel" aria-labelledby="account-tab-rollups" tabIndex={-1}>
  <div className="section-title"><div><h2>Rollups</h2><p>Posted gift allocations in exact cents. Voided gifts are excluded and nothing is created or moved here.</p></div>
   <label className="field"><span>Group by</span><select name="groupBy" value={groupBy} onChange={e=>setGroupBy(e.target.value)}>{GROUPS.map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></label></div>
  {!rollup?<p aria-busy="true">Loading rollups…</p>:<>
  <dl className="reconciliation-summary">
   <div><dt>Posted gifts</dt><dd>{money(totals.postedGiftCents)}</dd></div>
   <div><dt>Allocated</dt><dd>{money(totals.allocationCents)}</dd></div>
   <div><dt>In a location and function account</dt><dd>{money(totals.linkedCents)}</dd></div>
   <div><dt>Not yet linked</dt><dd>{money(totals.unlinkedCents)}</dd></div>
  </dl>
  <p className="table-note" role={rollup.reconciliation.reconciled?undefined:'alert'}>{rollup.reconciliation.reconciled
   ?`Reconciled exactly: every allocation is counted once. Grouped total ${money(rollup.groupCents)} plus unlinked ${money(totals.unlinkedCents)} equals the posted allocation total ${money(totals.allocationCents)}.`
   :`These rollups do not reconcile to the posted ledger (${money(rollup.reconciliation.duplicatedCents)} unaccounted). Do not use them until the saved records are reviewed.`}</p>
  {!rollup.groups?<p className="table-note">{rollup.groupCount} groups exceed the {rollup.groupLimit} group display limit. The totals above stay exact.</p>:
   !rollup.groups.length?<div className="empty-state"><h3>Nothing linked yet</h3><p>Link designations to accounts to see location and function rollups.</p></div>:<>
   <div className="table-wrap"><table className="desktop-record-table" aria-label={'Rollup '+groupBy}><caption>{rollup.groupCount} groups. A function serving several locations is counted once per location, never twice.</caption>
    <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col">Status</th><th scope="col" className="money">{groupBy==='function'?'Locations':groupBy==='location'?'Accounts':'Designations'}</th><th scope="col" className="money">Gifts</th><th scope="col" className="money">Allocations</th><th scope="col" className="money">Value</th></tr></thead>
    <tbody>{rollup.groups.map(g=><tr key={g.key}><td>{g.code}</td><td>{g.name}</td><td>{g.status}</td><td className="money">{groupBy==='function'?g.locationCount:groupBy==='location'?g.pairCount:g.designations}</td><td className="money">{g.gifts}</td><td className="money">{g.allocations}</td><td className="money">{money(g.cents)}</td></tr>)}</tbody>
    <tfoot><tr><th scope="row" colSpan={6}>Linked total</th><td className="money">{money(rollup.groupCents)}</td></tr></tfoot></table></div>
   <div className="mobile-records" aria-label={'Rollup '+groupBy+' mobile list'}>{rollup.groups.map(g=><article key={g.key}><div className="mobile-record-primary"><strong>{g.code} · {g.name}</strong></div><dl>
    <div><dt>Status</dt><dd>{g.status}</dd></div>
    <div><dt>Gifts</dt><dd className="money">{g.gifts}</dd></div>
    <div><dt>Allocations</dt><dd className="money">{g.allocations}</dd></div>
    <div><dt>Value</dt><dd className="money">{money(g.cents)}</dd></div>
   </dl></article>)}</div></>}
  <p className="table-note">{rollup.scope}</p>
  <div className="form-actions"><button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>act('Rollups reloaded.',async()=>{})}><RefreshCw size={15} aria-hidden="true"/>Reload rollups</button></div></>}
 </section>}
 </>}
 </>;
}
