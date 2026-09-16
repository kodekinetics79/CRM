import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { prepareMigrationQueue } from '../shared/migrationQueue.js';
import { MIGRATION_COLLECTIONS, MIGRATION_LIMITS } from '../shared/migrationContract.js';

const operator = { name: 'Synthetic representative conversion operator', email: 'scale.operator@example.test', password: 'RepresentativeConversion!2026' };
const source = 'Synthetic representative 6515 contacts 1622 funds';
const file = (collection, rows) => ({ collection, mapping: Object.fromEntries(Object.keys(rows[0]).map(k => [k,k])), rows });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const types = ['Business','Individual','Foundation','Staff','Employee','Alumni','Community partner'];
const preferences = ['Email','Phone','Post','Do not contact'];
function representative() {
  const people = Array.from({length:6515},(_,i) => ({sourceId:'c'+String(i).padStart(5,'0'),name:'Synthetic original constituent '+i,type:types[i%types.length],email:'synthetic'+i+'.scale@example.test',phone:'',household:i%2?'Original household '+i:'',parentSourceId:i?'c00000':'',segments:'Original segment '+i%9,preference:preferences[i%preferences.length],notes:'Original source note '+i,contacts:JSON.stringify(i%3?[]:[{name:'Original contact '+i,email:'contact'+i+'.scale@example.test',role:'Original contact role\nline two'},{name:'Original second contact '+i,email:'',role:''}])}));
  const funds = Array.from({length:1622},(_,i) => ({sourceId:'d'+String(i).padStart(5,'0'),name:'Synthetic original designation '+i,accountCode:'ORIGINAL-'+String(i).padStart(5,'0'),school:'Original school '+i%60,parentSourceId:i?'d00000':'',description:'Original account description '+i}));
  return {people,funds};
}
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'wimblo-representative-conversion-')),dbPath=join(dir,'workspace.sqlite');let app,server,base,sessions;
  async function request(path,body,session=sessions?.admin,method=body===undefined?'GET':'POST',csrf=true) {
    const response=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();let json;try{json=JSON.parse(text);}catch{}return {status:response.status,json,text,headers:response.headers};
  }
  async function login(email) {const r=await request('/auth/login',{email,password:operator.password},null);assert.equal(r.status,200,r.text);return {...r.json,cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};}
  async function open() {app=createApp({dbPath,seed:false,initialAdmin:operator,reminderWorker:false,workflowWorker:false});server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;sessions={admin:await login(operator.email)};}
  async function close(){if(server)await new Promise(r=>server.close(r));server=null;app?.locals.close();app=null;}
  await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
  for(const role of ['staff','viewer','event-helper']) {const email=role.replace('-','')+'.scale@example.test';const r=await request('/users',{name:'Synthetic '+role,email,password:operator.password,role});assert.equal(r.status,201,r.text);sessions[role]=await login(email);}
  async function commit(input) {const preview=await request('/migration/preview',input);assert.equal(preview.status,200,preview.text);assert.equal(preview.json.valid,true,JSON.stringify(preview.json.rows));const r=await request('/migration/commit',{...input,previewDigest:preview.json.previewDigest});assert.ok([200,201].includes(r.status),r.text);return r;}
  const receipt=(namespace=source,session=sessions.admin)=>request('/migration/source-reconciliation?source='+encodeURIComponent(namespace),undefined,session);
  const counts=()=>({records:app.locals.db.prepare('SELECT count(*) n FROM records').get().n,mappings:app.locals.db.prepare('SELECT count(*) n FROM migration_mapping').get().n,batches:app.locals.db.prepare('SELECT count(*) n FROM import_batches').get().n,audit:app.locals.db.prepare('SELECT count(*) n FROM audit').get().n});
  return {request,commit,receipt,counts,get db(){return app.locals.db;},get sessions(){return sessions;},restart:async()=>{await close();await open();for(const role of ['staff','viewer','event-helper'])sessions[role]=await login(role.replace('-','')+'.scale@example.test');}};
}
function group(rows,field) {const groups=new Map();for(const row of rows)groups.set(row[field],(groups.get(row[field])||0)+1);return [...groups].map(([key,count])=>({key,count})).sort((a,b)=>a.key.localeCompare(b.key));}

// These are the buyer's reported identity/fund counts, not invented historical
// transaction totals. Financial/interaction rows below are a separately named
// small synthetic relationship sample, not a ten-year export or volume claim.
test('6515 constituents and 1622 designations safely continue as reviewed native bounded parts with replay/restart and exact contact/code controls',async t=>{
  const f=await fixture(t),data=representative(),prepared={source,fileKey:'Original prepared identity and account export',files:[file('designations',data.funds),file('constituents',data.people)]};
  const queue=await prepareMigrationQueue(prepared);assert.deepEqual(queue.counts,{constituents:6515,designations:1622});assert.equal(queue.totalRows,8137);assert.equal(queue.parts.length,18);
  for(const part of queue.parts) {assert.ok(part.files.reduce((n,x)=>n+x.rows.length,0)<=MIGRATION_LIMITS.rowsPerBatch);assert.ok(part.files.length<=MIGRATION_LIMITS.filesPerBatch);assert.ok(Buffer.byteLength(JSON.stringify({...part,previewDigest:'0'.repeat(64)}))<=MIGRATION_LIMITS.requestBytes);}
  const before=f.counts(),early=await f.request('/migration/preview',queue.parts[1]);assert.equal(early.status,200);assert.equal(early.json.valid,false);assert.ok(early.json.rows.some(r=>/Unmapped/.test(r.error)));assert.deepEqual(f.counts(),before);
  const first=await f.commit(queue.parts[0]);assert.equal(first.status,201);assert.equal(first.json.reconciliation.actualCreateCounts.constituents,500);
  const paused=await f.receipt();assert.equal(paused.status,200);assert.equal(paused.json.mappingCount,500);assert.equal(paused.json.integrity.reconciled,true);assert.equal(paused.json.constituents.profileCount,500);assert.equal(paused.json.designations.recordCount,0);assert.match(paused.json.scope,/not.*completeness|not completeness/);
  const stale=await f.request('/migration/preview',queue.parts[1]);assert.equal(stale.json.valid,true);
  await f.restart();const unreviewed=f.counts(),expired=await f.request('/migration/commit',{...queue.parts[1],previewDigest:stale.json.previewDigest});assert.equal(expired.status,409);assert.deepEqual(f.counts(),unreviewed);
  const replay=await f.commit(queue.parts[0]);assert.equal(replay.status,200);assert.equal(replay.json.replayed,true);assert.equal(replay.json.batchId,first.json.batchId);
  const resumed=await prepareMigrationQueue(prepared);assert.deepEqual(resumed.parts,queue.parts);assert.equal(resumed.digest,queue.digest);
  for(const part of resumed.parts.slice(1)){const committed=await f.commit(part);assert.equal(committed.status,201);assert.deepEqual(committed.json.reconciliation.actualCreateCounts,committed.json.reconciliation.expectedCreateCounts);assert.equal(committed.json.reconciliation.actualNewGiftCents,'0');}
  const completed=await f.receipt();assert.equal(completed.status,200,completed.text);const r=completed.json;
  assert.equal(r.batchCount,18);assert.equal(r.mappingCount,8137);assert.deepEqual(r.mappedCounts,{constituents:6515,designations:1622,campaigns:0,gifts:0,communications:0});assert.deepEqual(r.currentCounts,r.mappedCounts);assert.deepEqual(r.integrity,{unchanged:8137,changed:0,missing:0,duplicateTargets:0,reconciled:true});
  assert.deepEqual(r.constituents,{profileCount:6515,contactCount:4344,profilesWithContacts:2172,parentLinkCount:6514,byType:group(data.people,'type'),byPreference:group(data.people,'preference')});
  assert.equal(r.designations.recordCount,1622);assert.equal(r.designations.accountCodeCount,1622);assert.equal(r.designations.parentLinkCount,1621);assert.equal(r.designations.accountCodeDigest,hash(data.funds.map(row=>({sourceId:row.sourceId,accountCode:row.accountCode}))));
  assert.equal(r.gifts.totalCents,'0');assert.equal(r.gifts.allocationTotalCents,'0');assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n,4);
  const records=new Map(f.db.prepare('SELECT id,data FROM records').all().map(row=>[row.id,JSON.parse(row.data)]));const mappings=f.db.prepare('SELECT * FROM migration_mapping WHERE source=?').all(source);const sourceMap=new Map(mappings.map(m=>[m.collection+':'+m.external_id,m.record_id]));
  for(const row of data.people){const record=records.get(sourceMap.get('constituents:'+row.sourceId));assert.equal(record.name,row.name);assert.equal(record.email,row.email);assert.equal(record.preference,row.preference);assert.equal(record.segments,row.segments);assert.equal(record.household,row.household);assert.equal(record.notes,row.notes);assert.deepEqual(record.contacts,JSON.parse(row.contacts));assert.equal(record.parentId,row.parentSourceId?sourceMap.get('constituents:'+row.parentSourceId):null);}
  for(const row of data.funds){const record=records.get(sourceMap.get('designations:'+row.sourceId));assert.equal(record.accountCode,row.accountCode);assert.equal(record.school,row.school);assert.equal(record.description,row.description);assert.equal(record.parentId,row.parentSourceId?sourceMap.get('designations:'+row.parentSourceId):null);}
  for(const mapping of mappings)assert.equal(mapping.record_hash,hash(records.get(mapping.record_id)));
  assert.doesNotMatch(completed.text,/synthetic\d+\.scale@example|Original contact|Original household|Original source note|record_hash|source_hash/);
  const allBefore=f.counts();for(const part of resumed.parts){const again=await f.commit(part);assert.equal(again.status,200);assert.equal(again.json.replayed,true);}assert.deepEqual(f.counts(),allBefore);
  const batch=await f.request('/migration/batches/'+first.json.batchId);assert.equal(batch.status,200);assert.equal(batch.json.integrity.unchanged,500);assert.equal(batch.json.lineageCoverage,'All batch source rows');

  const campaign={sourceId:'sample-campaign',name:'Synthetic relationship sample',type:'Matching gifts',goal:'0.00',startDate:'2026-01-01',endDate:'2026-12-31',status:'Active',description:'Sample only, not revenue'};
  const base={date:'2026-08-31',campaignSourceId:campaign.sourceId,notes:'Synthetic financial relationship sample',tribute:'',softCreditSourceId:'',giftKind:'One-time'};
  const gifts=[
    {...base,sourceId:'sample-split',donorSourceId:'c06514',amount:'125.01',type:'Cash',method:'Credit card',externalRef:'SAMPLE-SPLIT',softCreditSourceId:'c01234',allocations:JSON.stringify([{designationSourceId:'d00000',amount:'12.34'},{designationSourceId:'d01621',amount:'112.67'}])},
    {...base,sourceId:'sample-payroll',donorSourceId:'c00004',amount:'184.99',type:'Employee giving',method:'Payroll',externalRef:'SAMPLE-PAYROLL',giftKind:'Recurring',allocations:JSON.stringify([{designationSourceId:'d00000',amount:'184.99'}])},
    {...base,sourceId:'sample-noncash',donorSourceId:'c00001',amount:'10.00',type:'In-kind',method:'In-kind',externalRef:'SAMPLE-NONCASH',allocations:JSON.stringify([{designationSourceId:'d00001',amount:'10.00'}])},
    {...base,sourceId:'sample-fee',donorSourceId:'c00001',amount:'10.01',type:'Fee payment',method:'Check',externalRef:'SAMPLE-FEE',allocations:JSON.stringify([{designationSourceId:'d01621',amount:'10.01'}])},
    {...base,sourceId:'sample-matching',donorSourceId:'c00002',amount:'100.02',type:'Cash',method:'ACH',externalRef:'SAMPLE-MATCHING',giftKind:'Matching gift',allocations:JSON.stringify([{designationSourceId:'d00000',amount:'100.02'}])}
  ];
  const communication={sourceId:'sample-history',constituentSourceId:'c00003',subject:'Original historical interaction',channel:'Phone',status:'Logged',accessScope:'Workspace',date:'2026-08-30',body:'Original source interaction body',notes:'Original note; no consent or sending inferred'};
  const financialQueue=await prepareMigrationQueue({source,fileKey:'Separate synthetic financial interaction sample',files:[file('gifts',gifts),file('communications',[communication]),file('campaigns',[campaign])]});
  for(const part of financialQueue.parts)assert.equal((await f.commit(part)).status,201);
  const finance=(await f.receipt()).json;assert.equal(finance.mappingCount,8144);assert.equal(finance.integrity.unchanged,8144);assert.equal(finance.gifts.giftCount,5);assert.equal(finance.gifts.allocationCount,6);assert.equal(finance.gifts.totalCents,'43003');assert.equal(finance.gifts.allocationTotalCents,'43003');assert.equal(finance.gifts.monetaryContributionCents,'41002');assert.equal(finance.gifts.noncashValueCents,'1000');assert.equal(finance.gifts.feePaymentCents,'1001');assert.equal(finance.communications.recordCount,1);assert.equal(finance.campaigns.recordCount,1);
  assert.deepEqual(finance.gifts.byType,[{key:'Cash',giftCount:2,totalCents:'22503'},{key:'Employee giving',giftCount:1,totalCents:'18499'},{key:'Fee payment',giftCount:1,totalCents:'1001'},{key:'In-kind',giftCount:1,totalCents:'1000'}]);
  assert.equal(finance.gifts.designationControlDigest,hash([{sourceId:'d00000',accountCode:'ORIGINAL-00000',allocationCount:3,totalCents:'29735'},{sourceId:'d00001',accountCode:'ORIGINAL-00001',allocationCount:1,totalCents:'1000'},{sourceId:'d01621',accountCode:'ORIGINAL-01621',allocationCount:2,totalCents:'12268'}]));
  const posted=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND json_extract(data,'$.externalRef')='SAMPLE-SPLIT'").get().data);assert.equal(posted.constituentId,sourceMap.get('constituents:c06514'));assert.equal(posted.softCreditId,sourceMap.get('constituents:c01234'));assert.equal(posted.status,'Posted');assert.equal(posted.schoolYear,'2026–2027');
  const doNotContact=JSON.parse(f.db.prepare('SELECT data FROM records WHERE id=?').get(sourceMap.get('constituents:c00003')).data);assert.equal(doNotContact.preference,'Do not contact');assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection='communications' AND json_extract(data,'$.status')='Logged'").get().n,1);
  const beforeRestart=f.counts();await f.restart();for(const part of financialQueue.parts)assert.equal((await f.commit(part)).status,200);assert.deepEqual(f.counts(),beforeRestart);assert.deepEqual((await f.receipt()).json,finance);
});

test('source receipt is administrator-only, strict namespace scoped and withholds exact controls after source changes/missing or duplicate targets',async t=>{
  const f=await fixture(t),input={source,fileKey:'Small source integrity',files:[file('constituents',[{sourceId:'person-1',name:'Synthetic protected identity',type:'Staff',preference:'Do not contact',contacts:'[]'}]),file('designations',[{sourceId:'fund-1',name:'Synthetic protected account',accountCode:'EXACT-01'}])]};
  await f.commit(input);
  for(const role of ['staff','viewer','event-helper'])assert.equal((await f.receipt(source,f.sessions[role])).status,403);
  assert.equal((await f.request('/migration/source-reconciliation?source='+encodeURIComponent(source),undefined,null)).status,401);
  for(const query of ['', '?source=Invalid%2Fnamespace', '?source='+encodeURIComponent(source)+'&unexpected=1'])assert.equal((await f.request('/migration/source-reconciliation'+query)).status,400);
  const empty=(await f.receipt('Different source')).json;assert.equal(empty.mappingCount,0);assert.equal(empty.gifts.totalCents,'0');
  const m=f.db.prepare("SELECT * FROM migration_mapping WHERE source=? AND collection='constituents'").get(source),original=f.db.prepare('SELECT data FROM records WHERE id=?').get(m.record_id).data,person=JSON.parse(original);
  const changed=await f.request('/records/constituents/'+person.id,{version:person.version,notes:'Reasoned changed native notes'},f.sessions.admin,'PATCH');assert.equal(changed.status,200,changed.text);
  const guarded=(await f.receipt()).json;assert.equal(guarded.integrity.changed,1);assert.equal(guarded.integrity.reconciled,false);assert.equal(guarded.constituents,null);assert.equal(guarded.gifts,null);
  assert.equal((await f.commit(input)).status,200); // historical exact part replay is retained, not an update.
  f.db.prepare('UPDATE records SET data=? WHERE id=?').run(original,person.id);
  f.db.prepare('INSERT INTO migration_mapping VALUES(?,?,?,?,?,?,?)').run(source,'constituents','invalid-alias',m.record_id,m.source_hash,m.record_hash,m.batch_id);
  const duplicate=(await f.receipt()).json;assert.equal(duplicate.integrity.duplicateTargets,1);assert.equal(duplicate.integrity.reconciled,false);assert.equal(duplicate.designations,null);
  f.db.prepare('DELETE FROM migration_mapping WHERE source=? AND external_id=?').run(source,'invalid-alias');f.db.prepare('DELETE FROM records WHERE id=?').run(person.id);
  const missing=(await f.receipt()).json;assert.equal(missing.integrity.missing,1);assert.equal(missing.currentCounts.constituents,0);assert.equal(missing.mappedCounts.constituents,1);assert.equal(missing.gifts,null);
});

test('guided preparation preserves explicit preference and strict contacts, rejects unsafe rows, and keeps native hard caps unchanged',async t=>{
  const f=await fixture(t),row={sourceId:'safe-1',name:'Synthetic safe original',type:'Staff',preference:'Do not contact',contacts:'[]'};
  for(const bad of [{...row,preference:''},(({preference,...rest})=>rest)(row)])await assert.rejects(prepareMigrationQueue({source,fileKey:'Explicit preference',files:[file('constituents',[bad])]}),/explicit nonblank contact preference/);
  const valid=await prepareMigrationQueue({source,fileKey:'Strict contact validation',files:[file('constituents',[row,{...row,sourceId:'unsafe-2',contacts:JSON.stringify([{name:'Bad contact',email:'',role:'',accountRole:'admin'}])}])]});const before=f.counts();
  const preview=await f.request('/migration/preview',valid.parts[0]);assert.equal(preview.status,200);assert.equal(preview.json.valid,false);assert.match(preview.json.rows[1].error,/Contacts/);assert.deepEqual(f.counts(),before);
  assert.equal((await f.request('/migration/commit',{...valid.parts[0],previewDigest:'0'.repeat(64)})).status,400);assert.deepEqual(f.counts(),before);
  const overflow={source,fileKey:'Native limit unchanged',files:[file('constituents',Array.from({length:501},(_,i)=>({...row,sourceId:'limit-'+i})))]};assert.equal((await f.request('/migration/preview',overflow)).status,400);
  assert.equal(MIGRATION_LIMITS.rowsPerBatch,500);assert.equal(MIGRATION_LIMITS.filesPerBatch,10);assert.deepEqual(MIGRATION_COLLECTIONS,['constituents','designations','campaigns','gifts','communications']);
});

test('failed continuation COMMIT preserves the saved prefix and exact replay resumes one stable pending part without duplicated records',async t=>{
  const f=await fixture(t),parent={sourceId:'original-parent',name:'Synthetic original parent',type:'Business',preference:'Do not contact',contacts:'[]'},child={sourceId:'original-child',name:'Synthetic original child',type:'Staff',parentSourceId:parent.sourceId,preference:'Post',contacts:JSON.stringify([{name:'Original child contact',email:'',role:'Original source role'}])};
  const first={source,fileKey:'Stable saved prefix',files:[file('constituents',[parent])]},pending={source,fileKey:'Stable pending continuation',files:[file('constituents',[child])]};
  const prefix=await f.commit(first);assert.equal(prefix.status,201);const before=f.counts(),beforeReceipt=(await f.receipt()).json;
  f.db.exec(`CREATE TABLE synthetic_continuation_parent(id TEXT PRIMARY KEY);CREATE TABLE synthetic_continuation_child(parent_id TEXT REFERENCES synthetic_continuation_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER synthetic_continuation_commit_fault AFTER INSERT ON import_batches WHEN NEW.file_key='Stable pending continuation' BEGIN INSERT INTO synthetic_continuation_child(parent_id) VALUES('missing'); END;`);
  const preview=await f.request('/migration/preview',pending);assert.equal(preview.json.valid,true);const failed=await f.request('/migration/commit',{...pending,previewDigest:preview.json.previewDigest});assert.equal(failed.status,500,failed.text);
  assert.deepEqual(f.counts(),before);assert.deepEqual((await f.receipt()).json,beforeReceipt);assert.equal(f.db.prepare('SELECT count(*) n FROM synthetic_continuation_child').get().n,0);
  f.db.exec('DROP TRIGGER synthetic_continuation_commit_fault');await f.restart();assert.equal((await f.commit(first)).status,200);const resumed=await f.commit(pending);assert.equal(resumed.status,201);assert.equal(resumed.json.reconciliation.actualCreateCounts.constituents,1);
  const saved=f.counts();assert.equal((await f.commit(pending)).status,200);assert.deepEqual(f.counts(),saved);const receipt=(await f.receipt()).json;assert.equal(receipt.mappingCount,2);assert.equal(receipt.batchCount,2);assert.equal(receipt.constituents.contactCount,1);assert.equal(receipt.constituents.parentLinkCount,1);assert.deepEqual(receipt.constituents.byPreference,[{key:'Do not contact',count:1},{key:'Post',count:1}]);assert.equal(receipt.integrity.reconciled,true);
});
