import {MIGRATION_COLLECTIONS,MIGRATION_REQUIRED,MIGRATION_LIMITS} from './migrationContract.js';

export const MIGRATION_QUEUE_LIMITS=Object.freeze({csvBytes:10*1024*1024,totalRows:100000,parts:2000});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
function orderParents(file){
 if(!['constituents','designations'].includes(file.collection))return file.rows;
 const key=file.mapping.sourceId,parent=file.mapping.parentSourceId,lookup=new Map(),edges=new Map(),incoming=new Map();
 for(const row of file.rows){const id=String(row[key]??'').trim();if(!id||id.length>100||lookup.has(id))throw Error('Each '+file.collection+' source ID must be nonblank and unique in this export.');lookup.set(id,row);incoming.set(id,0);}
 if(!parent)return file.rows;
 for(const [id,row]of lookup){const parentId=String(row[parent]??'').trim();if(parentId&&lookup.has(parentId)){incoming.set(id,1);const children=edges.get(parentId)||[];children.push(id);edges.set(parentId,children);}}
 const ready=[...incoming].filter(([,count])=>count===0).map(([id])=>id),ordered=[];
 for(let head=0;head<ready.length;head++){const id=ready[head];ordered.push(lookup.get(id));for(const child of edges.get(id)||[]){incoming.set(child,incoming.get(child)-1);if(incoming.get(child)===0)ready.push(child);}}
 if(ordered.length!==file.rows.length)throw Error('Parent relationships contain a cycle. Correct the source hierarchy before importing.');
 return ordered;
}

// Preparation only: native source/schema validation and every commit remain server-side.
export async function prepareMigrationQueue({source,fileKey,files}){
 source=source.trim();fileKey=fileKey.trim();
 if(!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(source)||!fileKey||fileKey.length>128)throw Error('Provide a valid stable source and an import key of at most 128 characters.');
 if(!files.length||files.length>MIGRATION_COLLECTIONS.length||files.some(file=>!MIGRATION_COLLECTIONS.includes(file.collection))||new Set(files.map(file=>file.collection)).size!==files.length)throw Error('Choose one nonempty source file per supported record type.');
 const totalRows=files.reduce((sum,file)=>sum+file.rows.length,0);
 if(totalRows>MIGRATION_QUEUE_LIMITS.totalRows)throw Error('Guided imports support at most 100,000 rows per preparation. Keep larger source inventories separate.');
 const ordered=MIGRATION_COLLECTIONS.map(type=>files.find(file=>file.collection===type)).filter(Boolean).map(file=>{
  if(!file.rows.length||MIGRATION_REQUIRED[file.collection].some(field=>!file.mapping[field]))throw Error('Map required columns for '+file.collection+' before preparing parts.');
  if(file.collection==='constituents'&&(!file.mapping.preference||file.rows.some(row=>!String(row[file.mapping.preference]??'').trim())))throw Error('Guided constituent imports require an explicit nonblank contact preference for every row. Preserve opt-outs; Email is not marketing consent.');
  for(const row of file.rows)if(Object.keys(row).length>MIGRATION_LIMITS.columnsPerRow)throw Error('Each source row supports at most 30 columns.');
  const ids=file.rows.map(row=>String(row[file.mapping.sourceId]??'').trim());
  if(ids.some(id=>!id||id.length>100)||new Set(ids).size!==ids.length)throw Error('Each '+file.collection+' source ID must be nonblank and unique in this export.');
  return {collection:file.collection,mapping:file.mapping,rows:orderParents(file)};
 });
 const encoded=new TextEncoder().encode(JSON.stringify(canonical({source,fileKey,files:ordered}))),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)),v=>v.toString(16).padStart(2,'0')).join('');
 const parts=[];
 for(const file of ordered){
  let rows=[],rowBytes=0;
  const payload=items=>({source,fileKey:fileKey+'~'+digest.slice(0,16)+'~'+String(parts.length+1).padStart(6,'0'),files:[{collection:file.collection,mapping:file.mapping,rows:items}]});
  const flush=()=>{if(rows.length){parts.push(payload(rows));rows=[];rowBytes=0;if(parts.length>MIGRATION_QUEUE_LIMITS.parts)throw Error('The prepared import has too many parts. Reduce unusually large cells or use separate source inventories.');}};
  for(const row of file.rows){const size=bytes(row),base=bytes({...payload([]),previewDigest:'0'.repeat(64)});if(rows.length===MIGRATION_LIMITS.rowsPerBatch||base+rowBytes+size+rows.length>MIGRATION_LIMITS.requestBytes)flush();if(bytes({...payload([]),previewDigest:'0'.repeat(64)})+size>MIGRATION_LIMITS.requestBytes)throw Error('One mapped row exceeds the request size. Prepare a smaller source copy.');rows.push(row);rowBytes+=size;}
  flush();
 }
 return {source,fileKey,digest,totalRows,parts,counts:Object.fromEntries(ordered.map(file=>[file.collection,file.rows.length])),scope:'Each part is reviewed and committed atomically. The entire import is not one transaction. Re-upload the same source files and mappings to replay saved parts safely; retained source reconciliation does not prove the complete buyer export.'};
}
