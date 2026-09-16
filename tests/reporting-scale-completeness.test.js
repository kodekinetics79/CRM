import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installReportingRoutes} from '../server/reporting.js';
import {installReportScheduleRoutes} from '../server/reportSchedule.js';
import {toCSV} from '../src/lib.js';

const donor=randomUUID(),fundA=randomUUID(),fundB=randomUUID(),campaign=randomUUID();
const body=patch=>({name:'Complete saved facts',entity:'gifts',columns:['id','amount'],...patch});
const gift=(n,patch={})=>({id:randomUUID(),version:1,constituentId:donor,campaignId:campaign,amount:10001,date:'2026-09-13',type:'Cash',method:'Check',status:'Posted',externalRef:String(n),allocations:[{designationId:fundA,amount:6000},{designationId:fundB,amount:4001}],...patch});
async function fixture(t){
 const db=new DatabaseSync(':memory:'),data={constituents:[{id:donor,name:'Synthetic donor'}],gifts:[],designations:[{id:fundA,name:'First fund'},{id:fundB,name:'Second fund'}],campaigns:[{id:campaign,name:'Synthetic campaign'}],tasks:[],events:[],grants:[],pledges:[]};
 const users={admin:{id:randomUUID(),name:'Synthetic admin',role:'admin',active:1},staff:{id:randomUUID(),name:'Synthetic staff',role:'staff',active:1},viewer:{id:randomUUID(),name:'Synthetic viewer',role:'viewer',active:1}};
 db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,version INTEGER DEFAULT 1)');for(const u of Object.values(users))db.prepare('INSERT INTO users(id,name,email,role,active) VALUES(?,?,?,?,?)').run(u.id,u.name,u.role+'@example.test',u.role,1);
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=users[req.get('X-Role')||'staff'];req.tenantId=req.get('X-Tenant')||'first';next();});
 const csrf=(req,res,next)=>next(),write=(req,res,next)=>['admin','staff'].includes(req.user?.role)?next():res.status(403).json({error:'Readonly'}),audit=()=>{};
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const reporter=installReportingRoutes(app,{db,collections:Object.keys(data),list:(c,req)=>(req?.tenantId==='other'&&c==='constituents'?[{id:donor,name:'Other tenant donor'}]:data[c])||[],csrf,write,audit,transaction});
 const scheduler=installReportScheduleRoutes(app,{db,...reporter,runReport:(id,user)=>reporter.runReport(id,user,{tenantId:'first'}),csrf,write,audit,worker:false});
 app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{scheduler.close();await new Promise(resolve=>server.close(resolve));db.close();});
 async function request(path,{method='GET',payload,role='staff',tenant='first'}={}){const r=await fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Role':role,'X-Tenant':tenant},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:r.status,json:await r.json()};}
 const run=(payload,query='',options={})=>request('/custom-reports/run'+query,{method:'POST',payload,...options});
 return {db,data,users,request,run,reporter,scheduler,transaction};
}
function documents(f){
 f.db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,collection TEXT,record_id TEXT,title TEXT,category TEXT,visibility TEXT,status TEXT,evidence_date TEXT,archived INTEGER,created_at TEXT,updated_at TEXT,retention_until TEXT);
 CREATE TABLE document_revisions(document_id TEXT,revision INTEGER,filename TEXT,mime TEXT,bytes BLOB,sha256 TEXT,actor TEXT,at TEXT,metadata TEXT,PRIMARY KEY(document_id,revision));`);
 const id=randomUUID(),task=randomUUID();f.data.tasks.push({id:task,title:'Shared source task'});
 f.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'tasks',task,'Shared current document','Attachment','Workspace','Draft',null,0,'2026-09-13','2026-09-13',null);
 const insert=f.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?,?,?,?,?)');
 return {id,insert,add:(revision,visibility='Workspace')=>insert.run(id,revision,visibility==='Workspace'?'shared.txt':'PRIVATE_NAME.txt','text/plain',Buffer.from('PRIVATE_BYTES'),'1'.repeat(64),f.users.admin.id,'2026-09-13',JSON.stringify({title:visibility==='Workspace'?'Shared revision':'PRIVATE_TITLE',category:'Attachment',status:'Draft',visibility,evidenceDate:null}))};
}

test('filters include a relevant gift beyond 10,000 source rows and exact totals cover every match',async t=>{
 const f=await fixture(t);f.data.gifts=Array.from({length:10001},(_,i)=>gift(i));f.data.gifts[10000].externalRef='late-match';
 const late=await f.run(body({columns:['externalRef','amount'],filters:[{field:'externalRef',op:'eq',value:'late-match'}]}));assert.equal(late.status,200,JSON.stringify(late.json));assert.deepEqual(late.json.rows,[['late-match',10001]]);assert.equal(late.json.sourceRows,10001);assert.equal(late.json.totalsComplete,true);
 const total=await f.run(body({aggregates:[{op:'count'},{op:'sum',field:'amount'}]}));assert.equal(total.status,200);assert.deepEqual(total.json.rows,[[10001,100020001]]);assert.equal(total.json.matchedRows,10001);assert.equal(total.json.totalResultRows,1);
 const split=await f.run(body({entity:'giftAllocations',columns:['allocationAmount'],groupBy:['designationId'],aggregates:[{op:'sum',field:'allocationAmount'},{op:'count'}]}));assert.equal(split.status,200);assert.equal(split.json.matchedRows,20002);assert.deepEqual(split.json.rows.map(r=>r.slice(1)),[[60006000,10001],[40014001,10001]]);assert.equal(split.json.rows.reduce((n,r)=>n+r[1],0),total.json.rows[0][1]);
});

test('detail and grouped pages are complete, nonoverlapping and retain CSV formula safety',async t=>{
 const f=await fixture(t);f.data.gifts=Array.from({length:301},(_,i)=>gift(i,{externalRef:i===300?'=HYPERLINK("unsafe")':String(i)}));const definition=body({columns:['id','externalRef','amount']});
 const first=await f.run(definition);assert.equal(first.status,200);assert.equal(first.json.rows.length,250);assert.equal(first.json.totalResultRows,301);assert.equal(first.json.page.nextOffset,250);
 const last=await f.run(first.json.definition,`?offset=250&fingerprint=${first.json.sourceFingerprint}`);assert.equal(last.status,200);assert.equal(last.json.rows.length,51);assert.equal(last.json.page.nextOffset,null);assert.equal(last.json.matchedRows,301);assert.equal(last.json.sourceFingerprint,first.json.sourceFingerprint);assert.equal(new Set([...first.json.rows,...last.json.rows].map(r=>r[0])).size,301);assert.equal([...first.json.rows,...last.json.rows].reduce((n,r)=>n+r[2],0),3010301);assert.match(toCSV(last.json.columns.map(c=>c.label),last.json.rows),/'=HYPERLINK/);
 const grouped=body({columns:['externalRef'],groupBy:['externalRef'],aggregates:[{op:'sum',field:'amount'},{op:'count'}]}),g1=await f.run(grouped),g2=await f.run(g1.json.definition,`?offset=250&fingerprint=${g1.json.sourceFingerprint}`);assert.equal(g2.status,200);assert.equal(g1.json.totalResultRows,301);assert.equal([...g1.json.rows,...g2.json.rows].reduce((n,r)=>n+r[1],0),3010301);assert.equal([...g1.json.rows,...g2.json.rows].reduce((n,r)=>n+r[2],0),301);
});

test('pagination rejects changed facts, definition, tenant, role and missing or malformed page proof',async t=>{
 const f=await fixture(t);f.data.gifts=Array.from({length:260},(_,i)=>gift(i));const first=await f.run(body()),query=`?offset=250&fingerprint=${first.json.sourceFingerprint}`;
 assert.equal((await f.run(body(),'?offset=250')).status,409);assert.equal((await f.run(body(),'?offset=-1')).status,400);assert.equal((await f.run(body(),'?limit=251')).status,400);assert.equal((await f.run(body(),query+'&offset=251')).status,400);
 for(const options of [{tenant:'other'},{role:'viewer'},{role:'admin'}])assert.equal((await f.run(body(),query,options)).status,409);
 assert.equal((await f.run(body({name:'Changed name'}),query)).status,409);f.data.gifts[259].amount=10002;assert.equal((await f.run(body(),query)).status,409);
 const fresh=await f.run(body());assert.equal(fresh.status,200);assert.notEqual(fresh.json.sourceFingerprint,first.json.sourceFingerprint);assert.equal((await f.run(fresh.json.definition,`?offset=250&fingerprint=${fresh.json.sourceFingerprint}`)).status,200);
});

test('private early revisions cannot silently hide a later shared matching revision',async t=>{
 const f=await fixture(t),d=documents(f);f.transaction(()=>{for(let i=1;i<=10001;i++)d.add(i,'Administrators');d.add(10002);});
 const result=await f.run(body({entity:'documentRevisions',columns:['revision','filename'],filters:[{field:'revision',op:'eq',value:10002}]}));assert.equal(result.status,200,JSON.stringify(result.json));assert.deepEqual(result.json.rows,[[10002,'shared.txt']]);assert.deepEqual(result.json.documentRevisionSources,[{documentId:d.id,revision:10002}]);assert.doesNotMatch(JSON.stringify(result.json),/PRIVATE_BYTES|PRIVATE_TITLE|PRIVATE_NAME/);
 const catalog=await f.request('/custom-reports/catalog');assert.equal(catalog.status,200);assert.equal(catalog.json.metadataSchemaSampleRows,100);assert.doesNotMatch(JSON.stringify(catalog.json),/PRIVATE_BYTES|PRIVATE_TITLE|PRIVATE_NAME/);
});

test('selected-source overflow is explicit while unrelated large metadata does not block gift reports',async t=>{
 const f=await fixture(t);f.db.exec('CREATE TABLE audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,collection TEXT,record_id TEXT,at TEXT,details TEXT)');const insert=f.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)');f.transaction(()=>{for(let i=0;i<100001;i++)insert.run(i,f.users.admin.id,'Synthetic history','gifts',null,'2026-09-13','{}');});f.data.gifts=[gift(1)];
 const catalog=await f.request('/custom-reports/catalog',{role:'admin'});assert.equal(catalog.status,200,JSON.stringify(catalog.json));const giftResult=await f.run(body(),'',{role:'admin'});assert.equal(giftResult.status,200);assert.equal(giftResult.json.matchedRows,1);
 const oversized=await f.run(body({entity:'auditHistory',columns:['action'],filters:[{field:'action',op:'eq',value:'not present'}]}),'',{role:'admin'});assert.equal(oversized.status,413);assert.match(oversized.json.error,/No complete result/);assert.equal(oversized.json.rows,undefined);assert.equal((await f.run(body({entity:'auditHistory',columns:['action']}))).status,403);
 f.data.gifts=Array.from({length:100001},(_,i)=>gift(i));const core=await f.run(body({filters:[{field:'externalRef',op:'eq',value:'100000'}]}));assert.equal(core.status,413);assert.match(core.json.error,/No complete result/);assert.equal(core.json.rows,undefined);
});

test('saved definition pagination and scheduled results preserve complete counts and all-matched privacy history',async t=>{
 const f=await fixture(t),d=documents(f);f.transaction(()=>{for(let i=1;i<=301;i++)d.add(i);});const definition=body({entity:'documentRevisions',columns:['revision','filename']});
 const saved=await f.request('/custom-reports',{method:'POST',payload:definition});assert.equal(saved.status,201);const id=saved.json.report.id,first=await f.request('/custom-reports/'+id+'/run'),last=await f.request('/custom-reports/'+id+'/run?offset=250&fingerprint='+first.json.sourceFingerprint);assert.equal(last.status,200);assert.equal(last.json.rows.length,51);assert.equal(first.json.documentRevisionSources.length,301);assert.equal(last.json.documentRevisionSources.length,301);
 const startAt=new Date(Date.now()+30000).toISOString(),schedule=await f.request('/report-schedules',{method:'POST',payload:{reportId:id,name:'Full history checks',cadence:'Daily',startAt}});assert.equal(schedule.status,201);assert.equal(f.scheduler.runDueReports(Date.parse(startAt)+1).produced,1);const retained=f.db.prepare('SELECT id,result FROM report_deliveries').get(),snapshot=JSON.parse(retained.result);assert.equal(snapshot.matchedRows,301);assert.equal(snapshot.rows.length,250);assert.equal(snapshot.page.nextOffset,250);assert.equal(snapshot.totalsComplete,true);assert.equal(snapshot.documentRevisionSources.length,301);assert.equal((await f.request('/report-deliveries/'+retained.id)).status,200);
 f.db.prepare('UPDATE document_revisions SET metadata=? WHERE revision=301').run(JSON.stringify({visibility:'Administrators'}));assert.equal((await f.request('/report-deliveries/'+retained.id)).status,403);assert.equal((await f.request('/custom-reports/'+id+'/run?offset=250&fingerprint='+first.json.sourceFingerprint)).status,409);const current=await f.request('/custom-reports/'+id+'/run');assert.equal(current.json.matchedRows,300);assert.equal((await f.request('/custom-reports/'+id+'/run',{tenant:'other'})).status,404);
});


test('oversized complete provenance and processing payload fail closed rather than publish partial totals',async t=>{
 const f=await fixture(t),d=documents(f);f.transaction(()=>{for(let i=1;i<=16001;i++)d.add(i);});
 const history=await f.run(body({entity:'documentRevisions',columns:['revision'],aggregates:[{op:'count'}]}));assert.equal(history.status,413);assert.match(history.json.error,/privacy provenance/);assert.equal(history.json.matchedRows,undefined);assert.equal(history.json.documentRevisionSources,undefined);
 f.data.gifts=Array.from({length:8},(_,i)=>gift(i,{notes:'x'.repeat(8000001)}));const large=await f.run(body({filters:[{field:'externalRef',op:'eq',value:'no match'}],aggregates:[{op:'sum',field:'amount'}]}));assert.equal(large.status,413);assert.match(large.json.error,/64 MB/);assert.equal(large.json.rows,undefined);
});

test('saved exact monetary cutoff round-trips across scale without changing future or noncash semantics',async t=>{
 const f=await fixture(t);f.data.gifts=Array.from({length:10001},(_,i)=>gift(i));f.data.gifts.push(gift('future',{date:'2027-01-01'}),gift('noncash',{type:'In-kind'}),gift('void',{status:'Voided'}));
 const definition=body({filters:[{field:'date',op:'lte',value:'2026-09-13'},{field:'type',op:'eq',value:'Cash'},{field:'amount',op:'eq',value:10001}],aggregates:[{op:'count'},{op:'sum',field:'amount'}]}),saved=await f.request('/custom-reports',{method:'POST',payload:definition});assert.equal(saved.status,201);
 const read=await f.request('/custom-reports');assert.deepEqual(read.json.reports[0].filters,definition.filters);const result=await f.request('/custom-reports/'+saved.json.report.id+'/run');assert.equal(result.status,200);assert.deepEqual(result.json.rows,[[10001,100020001]]);assert.equal(result.json.sourceRows,10003);assert.match(result.json.scope,/future-dated records/);
 f.data.gifts[0].allocations[0].amount++;assert.equal((await f.run(body({entity:'giftAllocations',columns:['allocationAmount'],aggregates:[{op:'sum',field:'allocationAmount'}]}))).status,400);
});

function harness(){let index=0,state=[],effects=[],keys=[],cleanup=[];const mock={...React,useState(initial){const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v];},useRef(initial){return state[index++]??=({current:initial});},useEffect(effect,deps){const i=index++;if(!keys[i]||deps.some((d,j)=>d!==keys[i][j])){keys[i]=deps;effects.push(()=>{cleanup[i]?.();cleanup[i]=effect();});}}};const module={exports:{}},require=id=>id==='react'?mock:id==='../lib.js'?{money:v=>String(v),cents:v=>Math.round(Number(v)*100),dateLabel:String,download:()=>{},toCSV}:new Proxy({},{get:()=>()=>null});new Function('React','require','module','exports',transformSync(readFileSync(new URL('../src/features/CustomReports.jsx',import.meta.url),'utf8'),{loader:'jsx',format:'cjs'}).code)(React,require,module,module.exports);return props=>{index=0;const tree=module.exports.default(props),pending=effects;effects=[];pending.forEach(e=>e());return tree;};}
function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of React.Children.toArray(tree.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
const label=element=>React.Children.toArray(element.props.children).filter(c=>typeof c==='string').join(''),button=(tree,text)=>find(tree,e=>e.type==='button'&&label(e)===text),flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const catalog={entities:[{id:'gifts',label:'Gifts',fields:['date','donorName','amount'].map(key=>({key,label:key,type:key==='amount'?'money':'text',aggregateable:key==='amount',groupable:true}))}]};
function result(offset=0){return {definition:body({columns:['amount'],filters:[{field:'amount',op:'eq',value:10001}]}),columns:[{key:'amount',label:'Amount',type:'money'}],rows:Array.from({length:offset===0?250:1},()=>[10001]),recordReferences:[],matchedRows:251,totalResultRows:251,page:{offset,limit:250,nextOffset:offset===0?250:null},sourceFingerprint:'1'.repeat(64),sourcePreview:{columns:[],rows:[],recordReferences:[]},scope:'Saved facts',totalsComplete:true};}

test('report UI requests the next verified page using exact normalized monetary filters',async()=>{
 const render=harness(),calls=[];const api=async(path,options)=>{calls.push([path,options]);return path==='/custom-reports/catalog'?catalog:path==='/custom-reports'?{reports:[]}:result(path.includes('offset=250')?250:0);},props={api,user:{id:'staff',role:'staff'}};render(props);await flush();let tree=render(props);await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});await flush();tree=render(props);assert.equal(button(tree,'Previous page').props.disabled,true);await button(tree,'Next page').props.onClick();await flush();tree=render(props);const pageCall=calls.find(([path])=>path.includes('offset=250'));assert.equal(pageCall[1].body.filters[0].value,10001);assert.match(pageCall[0],/fingerprint=1{64}/);assert.equal(button(tree,'Next page').props.disabled,true);assert.match(renderToStaticMarkup(tree),/CSV exports only the displayed page/);assert.match(renderToStaticMarkup(tree),/Rows 251–251 of 251/);
});

test('late report-page response cannot republish results after editing or switching account authority',async()=>{
 const render=harness();let resolve;const pending=new Promise(r=>resolve=r),api=async path=>path==='/custom-reports/catalog'?catalog:path==='/custom-reports'?{reports:[]}:path.includes('offset=250')?pending:result(),props={api,user:{id:'staff',role:'staff'}};render(props);await flush();let tree=render(props);await find(tree,e=>e.type==='form').props.onSubmit({preventDefault(){}});await flush();tree=render(props);const pagePromise=button(tree,'Next page').props.onClick();find(tree,e=>e.type==='input'&&e.props.maxLength===120).props.onChange({target:{value:'Changed reviewed definition'}});resolve(result(250));await pagePromise;await flush();assert.equal(button(render(props),'Next page'),null);
 tree=render({...props,user:{id:'other-user',role:'viewer'}});assert.equal(button(tree,'Export visible CSV'),null);await flush();assert.equal(button(render({...props,user:{id:'other-user',role:'viewer'}}),'Next page'),null);
});


test('byte-bounded report pages advance by actual rows and the UI returns to the visited previous page',async t=>{
 const f=await fixture(t),columns=Array.from({length:20},(_,i)=>'businessText'+i),facts=Object.fromEntries(columns.map(key=>[key,'x'.repeat(8000)]));f.data.gifts=Array.from({length:8},(_,i)=>gift(i,facts));const definition=body({columns}),first=await f.run(definition);assert.equal(first.status,200);assert.ok(first.json.rows.length>0&&first.json.rows.length<250);const next=await f.run(first.json.definition,`?offset=${first.json.page.nextOffset}&fingerprint=${first.json.sourceFingerprint}`);assert.equal(next.status,200);assert.equal(next.json.page.offset,first.json.rows.length);assert.equal(next.json.totalResultRows,8);
 const render=harness(),calls=[],api=async path=>{calls.push(path);if(path==='/custom-reports/catalog')return catalog;if(path==='/custom-reports')return {reports:[]};const offset=Number(new URL('http://example.test'+path).searchParams.get('offset')||0);return {...result(offset),rows:Array.from({length:offset===6?2:3},()=>[10001]),page:{offset,limit:250,nextOffset:offset===6?null:offset+3},totalResultRows:8,matchedRows:8};},props={api,user:{id:'staff',role:'staff'}};
 render(props);await flush();await find(render(props),e=>e.type==='form').props.onSubmit({preventDefault(){}});await flush();await button(render(props),'Next page').props.onClick();await flush();await button(render(props),'Next page').props.onClick();await flush();await button(render(props),'Previous page').props.onClick();await flush();assert.match(calls.at(-1),/offset=3&/);assert.match(renderToStaticMarkup(render(props)),/Rows 4–6 of 8/);
});

test('page failure preserves the prior saved page without false empty counts, while stale proof requires rerun',async()=>{
 const render=harness();let stale=false;const api=async path=>{if(path==='/custom-reports/catalog')return catalog;if(path==='/custom-reports')return {reports:[]};if(path.includes('offset=250'))throw Object.assign(new Error(stale?'Sources changed. Rerun from first page.':'Page request failed; saved page is unchanged.'),{status:stale?409:503});return result();},props={api,user:{id:'staff',role:'staff'}};
 render(props);await flush();await find(render(props),e=>e.type==='form').props.onSubmit({preventDefault(){}});await flush();await button(render(props),'Next page').props.onClick();await flush();let html=renderToStaticMarkup(render(props));assert.match(html,/Rows 1–250 of 251/);assert.match(html,/251 matching source rows/);assert.match(html,/saved page is unchanged/);assert.equal(button(render(props),'Next page').props.disabled,false);stale=true;await button(render(props),'Next page').props.onClick();await flush();html=renderToStaticMarkup(render(props));assert.match(html,/Rerun from first page/);assert.equal(button(render(props),'Export visible CSV'),null);
});
