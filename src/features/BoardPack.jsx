import React,{useEffect,useRef,useState} from 'react';
import {Play,Download} from 'lucide-react';
import {api as defaultApi} from '../api.js';
import {money,dateLabel,download} from '../lib.js';

const REPORTING_ROLES=['admin','staff','viewer'];
const FORMATS=[['xlsx','Excel workbook (.xlsx)'],['pdf','PDF document (.pdf)'],['rtf','Rich text (.rtf)']];
const show=(value,column)=>value==null||value===''?'—':column.type==='money'?money(value):column.type==='date'&&Number.isFinite(Date.parse(value))?dateLabel(value):String(value);
// The file arrives as verified base64 and is decoded only after its declared
// length matches. A download is never started by a render, a timer or a hover.
const decode=(value,expected)=>{
 const binary=atob(value),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 if(bytes.length!==expected)throw new Error('The exported file did not match its declared size. Assemble the pack again before downloading.');
 return bytes;
};
// The three location-source figures are shown beside the totals so a reader can
// see how much of the board's giving is reported under an account and how much
// still falls back to the designation school field.
const summary=totals=>[['Total value',money(totals.totalCents)],['Gifts counted',String(totals.giftCount)],['Donors',String(totals.donorCount)],['Monetary support',money(totals.monetaryCents)],['In-kind support',money(totals.inKindCents)],['Smallest gift',totals.smallestGiftCents==null?'—':money(totals.smallestGiftCents)],['Largest gift',totals.largestGiftCents==null?'—':money(totals.largestGiftCents)],['First gift',totals.firstGiftDate?dateLabel(totals.firstGiftDate):'—'],['Last gift',totals.lastGiftDate?dateLabel(totals.lastGiftDate):'—'],
 ...(totals.accountLocationCents===undefined?[]:[['Account-linked value',money(totals.accountLocationCents)],['School-field value',money(totals.designationSchoolCents)],['Location not recorded',money(totals.locationUnrecordedCents)]])];

export default function BoardPack({user,api=defaultApi,notify,onDirty}){
 const [catalog,setCatalog]=useState(null),[pack,setPack]=useState(null),[range,setRange]=useState({startDate:'',endDate:''});
 const [error,setError]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[loadedAccess,setLoadedAccess]=useState(null);
 const requestGeneration=useRef(0),busyGeneration=useRef(0),authority=useRef(null);
 const accessKey=String(user?.id||'')+':'+String(user?.role||''),allowed=REPORTING_ROLES.includes(user?.role);
 authority.current={api,key:accessKey};
 useEffect(()=>{
  const generation=++requestGeneration.current;
  setCatalog(null);setPack(null);setError('');setStatus('');setBusy(false);busyGeneration.current=0;setLoadedAccess({api,key:accessKey});
  if(!allowed){setLoading(false);return ()=>{requestGeneration.current++;};}
  setLoading(true);
  api('/report-packs').then(response=>{
   if(generation!==requestGeneration.current)return;
   setCatalog(response.packs?.find(entry=>entry.id==='board')||null);setLoading(false);
  }).catch(failure=>{if(generation===requestGeneration.current){setError(failure.message);setLoading(false);}});
  return ()=>{requestGeneration.current++;};
 },[api,accessKey,allowed]);
 const currentAccess=loadedAccess?.api===api&&loadedAccess?.key===accessKey;
 const perform=async action=>{
  const generation=++requestGeneration.current,current=()=>generation===requestGeneration.current&&authority.current.api===api&&authority.current.key===accessKey;
  busyGeneration.current=generation;setBusy(true);setError('');setStatus('');
  try{await action(current);}
  catch(failure){if(current()){setError(failure.status===409?failure.message+' Assemble the pack again to continue.':failure.message);if(failure.status===409||failure.status===403||failure.status===401)setPack(null);}}
  finally{if(busyGeneration.current===generation)setBusy(false);}
 };
 const body=()=>({...(range.startDate?{startDate:range.startDate}:{}),...(range.endDate?{endDate:range.endDate}:{})});
 const assemble=event=>{
  event?.preventDefault?.();
  return perform(async current=>{
   const response=await api('/report-packs/board/run',{method:'POST',body:body()});
   if(!current())return;
   if(typeof response.sourceFingerprint!=='string'||!Array.isArray(response.sections))throw new Error('The assembled pack could not be verified. Try assembling it again.');
   setPack(response);onDirty?.(false);
   setStatus('Board pack assembled from current saved records · '+response.sections.length+' sections · '+response.totals.giftCount+' gifts counted. Choose a format to download it.');
  });
 };
 const save=format=>perform(async current=>{
  const assembled=pack;
  const response=await api('/report-packs/board/export',{method:'POST',body:{...(assembled.range||{}),format,fingerprint:assembled.sourceFingerprint}});
  if(!current())return;
  if(response.complete!==true||response.sourceFingerprint!==assembled.sourceFingerprint||typeof response.file!=='string'||typeof response.filename!=='string'||!Number.isSafeInteger(response.fileBytes)||typeof response.format?.mime!=='string')throw new Error('The exported pack could not be verified against the assembled pack. Assemble it again before downloading.');
  download(response.filename,decode(response.file,response.fileBytes),response.format.mime);
  setStatus(response.filename+' downloaded · '+response.rowCount+' rows · source proof '+response.sourceFingerprint.slice(0,12)+'… · '+response.format.standard+'. Wimblo generated this structure; how Excel, Acrobat or Word render it is not verified here.');
  notify?.('Board pack exported');
 });
 const change=patch=>{requestGeneration.current++;setRange(current=>({...current,...patch}));setPack(null);setStatus('');onDirty?.(false);};
 return <><div className="page-header"><div><h1>Board pack</h1><p>Assemble the board reporting pack from current saved gift records and export it as a typed workbook, a PDF or rich text.</p></div></div>
 {!allowed
  ?<section className="panel"><p className="empty-state" role="status">Your role cannot open reporting. Ask an administrator for a reporting role before assembling a board pack.</p></section>
  :<div className="board-pack">
   <section className="panel board-pack-period" aria-labelledby="board-pack-period-legend">
    <form onSubmit={assemble}>
     <fieldset disabled={busy}>
      <legend id="board-pack-period-legend">Pack period</legend>
      <div className="board-pack-fields">
       <label htmlFor="board-pack-start">Period start<input id="board-pack-start" type="date" value={range.startDate} aria-describedby="board-pack-period-hint" onChange={event=>change({startDate:event.target.value})}/></label>
       <label htmlFor="board-pack-end">Period end<input id="board-pack-end" type="date" value={range.endDate} aria-describedby="board-pack-period-hint" onChange={event=>change({endDate:event.target.value})}/></label>
      </div>
      <p className="board-pack-hint" id="board-pack-period-hint">Leave both dates empty to include every recorded gift date. Changing a date clears the assembled pack, because an export is pinned to the pack it was reviewed from.</p>
      <div className="board-pack-actions"><button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy||undefined}><Play size={16} aria-hidden="true"/>{busy?'Working…':'Assemble board pack'}</button></div>
     </fieldset>
    </form>
   </section>
   <p className="board-pack-status" role="status" aria-live="polite">{status}</p>
   {error&&<p className="board-pack-error" role="alert">{error}</p>}
   {loading&&<section className="panel"><p className="empty-state">Loading the board pack definition…</p></section>}
   {catalog&&currentAccess&&!pack&&!loading&&<section className="panel"><p className="empty-state">No pack is assembled yet. Assemble the board pack to see totals by campaign, support form, school location, program and donor.</p></section>}
   {pack&&currentAccess&&<>
    <section className="panel board-pack-totals" aria-labelledby="board-pack-totals-heading">
     <div className="section-title"><div><h2 id="board-pack-totals-heading">Standard totals</h2><p>{pack.range?.startDate||pack.range?.endDate?'Period '+(pack.range.startDate||'earliest recorded')+' to '+(pack.range.endDate||'latest recorded'):'All recorded gift dates'} · source proof {pack.sourceFingerprint.slice(0,12)}…</p></div></div>
     <dl className="board-pack-summary">{summary(pack.totals).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
     <p className="board-pack-note">{pack.scope}</p>
     {pack.accountStructure&&<p className="board-pack-note">{pack.accountStructure.available
      ?'School location rows use the location/function account where a designation is linked ('+pack.accountStructure.linkedDesignations+' linked) and the designation school field where it is not. Every row states which source it came from and the two are never combined.'
      :'No location/function account structure is recorded in this workspace, so every school location row uses the designation school field.'}</p>}
     <div className="board-pack-actions board-pack-exports">
      {FORMATS.map(([format,label])=><button key={format} type="button" className="btn btn-secondary" disabled={busy} aria-busy={busy||undefined} onClick={()=>save(format)}><Download size={16} aria-hidden="true"/>{label}</button>)}
     </div>
     <p className="board-pack-note">A download starts only when you choose a format here. Each file carries the pack period, the source proof, your user and role, and exact values in United States dollars from saved integer cents.</p>
    </section>
    {pack.sections.map(section=><section className="panel board-pack-section" key={section.id} aria-labelledby={'board-pack-'+section.id}>
     <div className="section-title"><div><h2 id={'board-pack-'+section.id}>{section.title}</h2><p>{section.description}</p></div></div>
     {section.rowCount===0
      ?<p className="empty-state">No gift matched this section in the pack period.</p>
      :<><div className="board-pack-table"><table>
        <caption>{section.title} · {section.rowCount} {section.rowCount===1?'row':'rows'}{section.truncated?' · showing the first '+section.displayedRows:''}</caption>
        <thead><tr>{section.columns.map(column=><th key={column.key} scope="col" className={['money','number'].includes(column.type)?'numeric':undefined}>{column.label}{column.type==='money'?' (USD)':''}</th>)}</tr></thead>
        <tbody>{section.rows.map((row,index)=><tr key={section.id+':'+index}>{row.map((value,cell)=><td key={section.columns[cell].key} data-label={section.columns[cell].label} className={['money','number'].includes(section.columns[cell].type)?'numeric':undefined}>{show(value,section.columns[cell])}</td>)}</tr>)}</tbody>
       </table></div>
       {section.truncated&&<p className="board-pack-note">Showing the first {section.displayedRows} of {section.rowCount} rows on screen. Every row is included in a downloaded file.</p>}</>}
    </section>)}
   </>}
  </div>}
 </>;
}
