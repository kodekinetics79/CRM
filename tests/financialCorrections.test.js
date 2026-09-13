import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-corrections-'));let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'business.sqlite'),seed:true});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){await new Promise(resolve=>server.close(resolve));app.locals.close();}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrfToken;}const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json(),headers:r.headers};}
 async function login(email){const r=await request('/api/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200);return {...r.json,cookie:r.headers.get('set-cookie').split(';')[0]};}
 const admin=await login('alex@foundation.example'),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 const workspace=(await request('/api/workspace',{session:admin})).json.data;
 const donor=workspace.constituents[0],other=workspace.constituents[1],fund=workspace.designations[0],fund2=workspace.designations[1];
 const body={constituentId:donor.id,amount:10001,type:'Cash',method:'Check',date:'2025-09-13',allocations:[{designationId:fund.id,amount:6001},{designationId:fund2.id,amount:4000}],externalRef:'CORRECTION-QA'};
 const created=await request('/api/records/gifts',{method:'POST',session:staff,body});assert.equal(created.status,201);const gift=created.json.record;
 const current=()=>JSON.parse(app.locals.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(gift.id).data);
 const history=async(session=viewer)=>request(`/api/gifts/${gift.id}/corrections`,{session});
 const patch=(changes,options={})=>request(`/api/records/gifts/${gift.id}`,{method:'PATCH',session:staff,body:{version:current().version,...changes},...options});
 const audits=()=>app.locals.db.prepare('SELECT * FROM audit WHERE record_id=? ORDER BY id').all(gift.id);
 return {request,admin,staff,viewer,donor,other,fund,fund2,gift,current,history,patch,audits,restart:async()=>{await close();await open();},get db(){return app.locals.db;}};
}

test('financial changes require a bounded explicit reason without source/history/audit changes',async t=>{
 const f=await fixture(t),before=f.current(),audit=f.audits();
 for(const change of [{amount:10002,allocations:[{designationId:f.fund.id,amount:6002},{designationId:f.fund2.id,amount:4000}]},{date:'2026-01-01'},{method:'Cash'},{externalRef:'CORRECTED'},{constituentId:f.other.id},{softCreditId:f.other.id},{giftKind:'Recurring'}]){
  const r=await f.patch(change);assert.equal(r.status,400,JSON.stringify(r.json));assert.match(r.json.error,/correctionReason/);
 }
 for(const correctionReason of ['', ' ', 123, 'x'.repeat(2001)])assert.equal((await f.patch({date:'2026-01-01',correctionReason})).status,400);
 assert.deepEqual(f.current(),before);assert.deepEqual(f.audits(),audit);assert.deepEqual((await f.history()).json.corrections,[]);
});

test('staff correction retains complete exact before/after versions and linked source versions once',async t=>{
 const f=await fixture(t),before=f.current();const r=await f.patch({amount:10002,date:'2026-01-01',allocations:[{designationId:f.fund2.id,amount:4000},{designationId:f.fund.id,amount:6002}],notes:'Source correction explained',correctionReason:'  Original source transposed by one cent  '});
 assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.record.correctionReason,undefined);
 const [h]=(await f.history()).json.corrections;assert.deepEqual(h.before,before);assert.deepEqual(h.after,r.json.record);assert.equal(h.fromVersion,1);assert.equal(h.toVersion,2);assert.equal(h.reason,'Original source transposed by one cent');assert.deepEqual(h.changedFields,['amount','date','allocations']);assert.equal(h.actor.id,f.staff.user.id);assert.equal(h.actor.name,f.staff.user.name);assert.equal(h.at,h.after.updatedAt);
 assert.equal(h.after.allocations.reduce((n,a)=>n+a.amount,0),10002);assert.ok(h.sourceVersions.before.some(r=>r.collection==='constituents'&&r.id===f.donor.id&&r.version===f.donor.version));assert.equal(h.sourceVersions.after.filter(r=>r.collection==='designations').length,2);
 const audit=f.audits().find(r=>r.action==='correct_gift_financial_facts');assert.equal(JSON.parse(audit.details).correctionId,h.id);assert.equal(audit.actor,f.staff.user.id);
});

test('unchanged financial fields, allocation reorder, notes and dedicated year/ack changes need no correction reason',async t=>{
 const f=await fixture(t);assert.equal((await f.patch({notes:'Neutral',allocations:[...f.gift.allocations].reverse(),amount:10001})).status,200);assert.deepEqual((await f.history()).json.corrections,[]);
 const year=await f.request(`/api/gifts/${f.gift.id}/school-year`,{method:'POST',session:f.staff,body:{version:2,schoolYear:'2024–2025',reason:'Approved year classification'}});assert.equal(year.status,200);
 const ack=await f.request(`/api/gifts/${f.gift.id}/acknowledge`,{method:'POST',session:f.staff,body:{version:3,date:'2026-09-13',channel:'Post',notes:'Manually acknowledged'}});assert.equal(ack.status,200);assert.deepEqual((await f.history()).json.corrections,[]);
});

test('failed splits, stale versions, current permissions and CSRF produce no correction',async t=>{
 const f=await fixture(t),before=f.current(),audit=f.audits(),change={date:'2026-01-01',correctionReason:'Source date correction'};
 assert.equal((await f.patch({...change,allocations:[{designationId:f.fund.id,amount:1}]})).status,400);
 assert.equal((await f.patch({...change,version:99})).status,409);
 assert.equal((await f.patch(change,{session:f.viewer})).status,403);assert.equal((await f.patch(change,{session:undefined})).status,401);assert.equal((await f.patch(change,{csrf:false})).status,403);
 assert.deepEqual(f.current(),before);assert.deepEqual(f.audits(),audit);assert.deepEqual((await f.history()).json.corrections,[]);assert.equal((await f.history(f.staff)).status,200);
 assert.equal((await f.request(`/api/gifts/${f.gift.id}/corrections`)).status,401);assert.equal((await f.request('/api/gifts/missing/corrections',{session:f.viewer})).status,404);
});

test('audit failure rolls back source, generic audit and immutable revision atomically',async t=>{
 const f=await fixture(t),before=f.current(),audit=f.audits();f.db.exec("CREATE TRIGGER correction_audit_failure BEFORE INSERT ON audit WHEN NEW.action='correct_gift_financial_facts' BEGIN SELECT RAISE(ABORT,'injected correction audit failure'); END;");
 assert.equal((await f.patch({date:'2026-01-01',correctionReason:'Approved correction'})).status,500);assert.deepEqual(f.current(),before);assert.deepEqual(f.audits(),audit);assert.deepEqual((await f.history()).json.corrections,[]);
 f.db.exec('DROP TRIGGER correction_audit_failure');assert.equal((await f.patch({date:'2026-01-01',correctionReason:'Retry approved correction'})).status,200);assert.equal((await f.history()).json.corrections.length,1);
});

test('history is append-only, restart-safe and concurrent stale correction cannot overwrite it',async t=>{
 const f=await fixture(t),body={version:1,date:'2026-01-01',correctionReason:'Approved date correction'};
 const results=await Promise.all([f.patch(body),f.patch(body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const history=(await f.history()).json.corrections;
 assert.throws(()=>f.db.exec("UPDATE gift_financial_corrections SET reason='changed'"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM gift_financial_corrections'),/immutable/);
 await f.restart();assert.deepEqual((await f.history()).json.corrections,history);assert.equal(f.current().version,2);
 assert.equal((await f.patch({date:'2026-02-01',correctionReason:'Second approved correction'})).status,200);const h=(await f.history()).json.corrections;assert.equal(h.length,2);assert.deepEqual(h[1].before,h[0].after);
});

test('issued receipt remains locked through encoded routes; reason never overrides protections',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,body:{version:0,organizationName:'Fictional finance QA',address:'Test-only street',taxIdentifier:'NOT-TAX-VALID',signatureLabel:'QA signer',customFooter:'Fictional test only',approved:true}})).status,200);
 const prepared=await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Individual',giftId:f.gift.id,profileVersion:1,benefitsReviewed:true,benefitsAssessment:'None provided',revenueClassification:'Contribution'}});assert.equal(prepared.status,201,JSON.stringify(prepared.json));const receipt=prepared.json.receipt;
 const issued=await f.request(`/api/receipts/${receipt.id}/issue`,{method:'POST',session:f.staff,body:{version:1,preparationDigest:receipt.preparationDigest,channel:'Print',printed:true,handSigned:true,issueDate:'2026-09-13'}});assert.equal(issued.status,200);
 const encoded='%'+f.gift.id.charCodeAt(0).toString(16)+f.gift.id.slice(1),before=f.current();assert.equal((await f.request(`/api/records/gifts/${encoded}/`,{method:'PATCH',session:f.staff,body:{version:1,date:'2026-01-01',correctionReason:'Cannot override issued receipt'}})).status,409);assert.deepEqual(f.current(),before);assert.deepEqual((await f.history()).json.corrections,[]);
 assert.equal((await f.request(`/api/receipts/${receipt.id}/void`,{method:'POST',session:f.staff,body:{version:2,reason:'Approved correction process'}})).status,200);
 assert.equal((await f.patch({date:'2026-01-01',correctionReason:'Source correction after receipt void'})).status,200);assert.equal((await f.history()).json.corrections.length,1);const original=(await f.request(`/api/receipts/${receipt.id}`,{session:f.viewer})).json.receipt;assert.equal(original.gifts[0].date,'2025-09-13');assert.equal(original.status,'Voided');
});

test('former allocation sources referenced only by retained corrections cannot be deleted through normal or encoded trailing-slash routes',async t=>{
 const f=await fixture(t),created=await f.request('/api/records/designations',{method:'POST',session:f.staff,body:{name:'Original corrected allocation source',accountCode:'CORRECTION-HISTORY'}});assert.equal(created.status,201);const original=created.json.record;
 assert.equal((await f.patch({allocations:[{designationId:original.id,amount:10001}],correctionReason:'Original allocation evidence recorded'})).status,200);
 assert.equal((await f.patch({allocations:f.gift.allocations,correctionReason:'Correct designation based on original source'})).status,200);const history=(await f.history()).json.corrections,audit=f.db.prepare('SELECT COUNT(*) n FROM audit').get().n;
 for(const path of [original.id,'%'+original.id.charCodeAt(0).toString(16)+original.id.slice(1)+'/']){const result=await f.request('/api/records/designations/'+path,{method:'DELETE',session:f.staff,body:{version:original.version}});assert.equal(result.status,409,JSON.stringify(result.json));assert.match(result.json.error,/correction history/i);}
 assert.ok((await f.request('/api/workspace',{session:f.viewer})).json.data.designations.some(d=>d.id===original.id));assert.deepEqual((await f.history()).json.corrections,history);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit').get().n,audit);
 const viewer=await f.request('/api/records/designations/'+original.id,{method:'DELETE',session:f.viewer,body:{version:original.version}});assert.equal(viewer.status,403);
 assert.equal((await f.request('/api/records/designations/'+original.id,{method:'DELETE',session:f.staff,body:{version:original.version+1}})).status,409);
 assert.equal((await f.request('/api/records/designations/'+original.id,{method:'DELETE',session:f.staff,csrf:false,body:{version:original.version}})).status,403);
});

test('retained correction write failure rolls back exact gross cents, split allocations and generic audit before a single successful retry',async t=>{
 const f=await fixture(t),before=f.current(),audit=f.audits(),change={amount:12345,allocations:[{designationId:f.fund.id,amount:8345},{designationId:f.fund2.id,amount:4000}],correctionReason:'Source amount and allocation corrected'};f.db.exec("CREATE TRIGGER correction_history_failure BEFORE INSERT ON gift_financial_corrections BEGIN SELECT RAISE(ABORT,'injected history failure'); END;");assert.equal((await f.patch(change)).status,500);assert.deepEqual(f.current(),before);assert.deepEqual(f.audits(),audit);assert.deepEqual((await f.history()).json.corrections,[]);f.db.exec('DROP TRIGGER correction_history_failure');assert.equal((await f.patch(change)).status,200);const h=(await f.history()).json.corrections;assert.equal(h.length,1);assert.equal(h[0].after.amount,12345);assert.equal(h[0].after.allocations.reduce((n,a)=>n+a.amount,0),12345);assert.equal(f.audits().filter(a=>a.action==='correct_gift_financial_facts').length,1);
});

test('manual whole-gift void preserves gross facts and prior corrections, rolls back audit failure, and duplicate requests create no second void',async t=>{
 const f=await fixture(t);assert.equal((await f.patch({externalRef:'Corrected source reference',correctionReason:'Transcribed the original source reference'})).status,200);const before=f.current(),history=(await f.history()).json.corrections,audit=f.audits(),body={version:before.version,reason:'Duplicate manual source entered; reconciled outside the CRM'};f.db.exec("CREATE TRIGGER void_audit_failure BEFORE INSERT ON audit WHEN NEW.action='void' BEGIN SELECT RAISE(ABORT,'injected void audit failure'); END;");assert.equal((await f.request(`/api/gifts/${f.gift.id}/void`,{method:'POST',session:f.staff,body})).status,500);assert.deepEqual(f.current(),before);assert.deepEqual(f.audits(),audit);f.db.exec('DROP TRIGGER void_audit_failure');const result=await f.request(`/api/gifts/${f.gift.id}/void`,{method:'POST',session:f.staff,body});assert.equal(result.status,200);assert.equal(result.json.record.status,'Voided');assert.equal(result.json.record.amount,before.amount);assert.deepEqual(result.json.record.allocations,before.allocations);assert.equal(result.json.record.voidReason,body.reason);assert.ok(result.json.record.voidedAt);assert.deepEqual((await f.history()).json.corrections,history);const final=f.current(),finalAudit=f.audits();for(const version of [before.version,final.version])assert.equal((await f.request(`/api/gifts/${f.gift.id}/void`,{method:'POST',session:f.staff,body:{...body,version}})).status,409);assert.deepEqual(f.current(),final);assert.deepEqual(f.audits(),finalAudit);assert.equal(finalAudit.filter(a=>a.action==='void').length,1);assert.equal((await f.patch({amount:1,allocations:[{designationId:f.fund.id,amount:1}],correctionReason:'Cannot change a voided source'})).status,409);
});

test('a former soft-credit identity is retained by correction provenance and unrelated unused records remain deletable',async t=>{
 const f=await fixture(t);const create=async name=>{const r=await f.request('/api/records/constituents',{method:'POST',session:f.staff,body:{name,type:'Individual'}});assert.equal(r.status,201);return r.json.record;},former=await create('Former recognition source'),unused=await create('Unrelated unused identity');assert.equal((await f.patch({softCreditId:former.id,correctionReason:'Reviewed initial recognition source'})).status,200);assert.equal((await f.patch({softCreditId:null,correctionReason:'Correct the mistaken recognition source'})).status,200);assert.equal((await f.request('/api/records/constituents/'+former.id,{method:'DELETE',session:f.staff,body:{version:former.version}})).status,409);assert.equal((await f.request('/api/records/constituents/'+unused.id,{method:'DELETE',session:f.staff,body:{version:unused.version}})).status,200);await f.restart();assert.equal((await f.request('/api/records/constituents/'+former.id+'/',{method:'DELETE',session:f.staff,body:{version:former.version}})).status,409);
});
