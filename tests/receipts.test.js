import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const profile=(changes={})=>({version:0,organizationName:'Receipt test organization',address:'123 Test Street, Test City',taxIdentifier:'TEST-ONLY-ID',signatureLabel:'Authorized receipt signer',customFooter:'Client approval pending; fictional test organization.',approved:true,...changes});
async function fixture(t,{configure=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-receipts-'));let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=csrf===true?session.csrfToken:csrf;}const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json(),headers:r.headers};}
 async function login(email='alex@foundation.example'){const r=await request('/api/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200,JSON.stringify(r.json));return {...r.json,cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(path,body){const r=await request(path,{method:'POST',body,session:staff});assert.equal(r.status,201,JSON.stringify(r.json));return r.json;}
 async function person(name,changes={}){return (await create('/api/records/constituents',{name,type:'Individual',preference:'Email',email:name.toLowerCase().replace(/[^a-z]/g,'')+'@example.test',...changes})).record;}
 const donor=await person('Receipt donor'),other=await person('Other donor'),fund=(await create('/api/records/designations',{name:'Receipts fund',accountCode:'RECEIPTS-4100'})).record;
 if(configure){const r=await request('/api/receipt-profile',{method:'PUT',session:admin,body:profile()});assert.equal(r.status,200,JSON.stringify(r.json));}
 async function gift(amount=12345,changes={}){return (await create('/api/records/gifts',{constituentId:donor.id,amount,type:'Cash',method:'Check',date:'2025-09-13',allocations:[{designationId:fund.id,amount}],...changes})).record;}
 async function prepare(selection,changes={}){return (await create('/api/receipts/prepare',{kind:'Individual',profileVersion:1,...selection,...changes})).receipt;}
 async function issue(r,changes={},session=staff){return request(`/api/receipts/${r.id}/issue`,{method:'POST',session,body:{version:1,preparationDigest:r.preparationDigest,channel:'Print',printed:true,handSigned:true,issueDate:'2026-09-13',...changes}});}
 async function voidReceipt(r,changes={}){return request(`/api/receipts/${r.id}/void`,{method:'POST',session:staff,body:{version:r.version,reason:'Approved correction',...changes}});}
 async function read(id,session=viewer){return request(`/api/receipts/${id}`,{session});}
 return {request,admin,staff,viewer,donor,other,fund,person,gift,prepare,issue,voidReceipt,read,restart:async()=>{await close();await open();},get db(){return app.locals.db;}};
}

test('no default tax identity or profile exists; explicit admin approval is strict, versioned and retained',async t=>{
 const f=await fixture(t,{configure:false});const initial=await f.request('/api/receipt-profile',{session:f.viewer});assert.equal(initial.status,200);assert.equal(initial.json.configured,false);assert.equal(initial.json.profile,null);const g=await f.gift();assert.equal((await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Individual',giftId:g.id,profileVersion:1}})).status,409);
 for(const body of [profile({approved:false}),profile({taxIdentifier:''}),{...profile(),legalCertified:true}])assert.equal((await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,body})).status,400);
 const first=await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,body:profile()});assert.equal(first.status,200);assert.equal(first.json.profile.version,1);assert.equal(first.json.profile.approvedBy,f.admin.user.id);assert.equal((await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,body:profile()})).status,409);
 const second=await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,body:profile({version:1,address:'Revised test address'})});assert.equal(second.status,200);const history=await f.request('/api/receipt-profile',{session:f.admin});assert.equal(history.json.revisions.length,2);assert.equal(history.json.revisions[0].address,profile().address);assert.throws(()=>f.db.prepare('DELETE FROM receipt_profile_revisions').run(),/retained/);
});

test('individual receipt preserves exact monetary facts and numbers only explicit staff-confirmed printing and hand-signing',async t=>{
 const f=await fixture(t),g=await f.gift(12345,{softCreditId:f.other.id}),r=await f.prepare({giftId:g.id});assert.equal(r.status,'Prepared');assert.equal(r.number,null);assert.equal(r.monetaryCents,12345);assert.equal(r.recipient.id,f.donor.id);assert.equal(r.references.find(x=>x.collection==='gifts').version,1);assert.doesNotMatch(JSON.stringify(r.recipient),/Other donor/);assert.equal(r.taxDeductibility,'Not determined');
 for(const change of [{printed:false},{handSigned:false},{channel:'Email'},{issueDate:'2027-09-13'},{issueDate:'2025-01-01'},{preparationDigest:'0'.repeat(64)},{version:2}])assert.ok([400,409].includes((await f.issue(r,change)).status));assert.equal(f.db.prepare('SELECT value FROM receipt_number_sequence').get().value,0);
 const before=f.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get('gifts',g.id).data;const issued=await f.issue(r);assert.equal(issued.status,200);assert.equal(issued.json.receipt.number,'R-00000001');assert.equal(issued.json.receipt.version,2);assert.equal(issued.json.receipt.issue.channel,'Print');assert.equal(issued.json.receipt.issue.handSigned,true);assert.equal(f.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get('gifts',g.id).data,before);assert.equal(JSON.parse(before).acknowledgment,undefined);assert.equal((await f.issue(r)).status,409);assert.equal(f.db.prepare('SELECT value FROM receipt_number_sequence').get().value,1);
});

test('active issued receipts reject financial changes and gift voids, permit notes, and release protection only after logged receipt void',async t=>{
 const f=await fixture(t),g=await f.gift(),r=await f.prepare({giftId:g.id}),issued=(await f.issue(r)).json.receipt;
 for(const body of [{version:1,date:'2025-09-14'},{version:1,constituentId:f.other.id},{version:1,amount:12346,allocations:[{designationId:f.fund.id,amount:12346}]},{version:1,type:'Sponsorship'}]){const edit=await f.request(`/api/records/gifts/${g.id}`,{method:'PATCH',session:f.staff,body});assert.equal(edit.status,409);assert.equal(edit.json.receiptId,r.id);assert.match(edit.json.error,/Void the receipt/);}
 assert.equal((await f.request(`/api/gifts/${g.id}/void`,{method:'POST',session:f.staff,body:{version:1,reason:'Correction'}})).status,409);const note=await f.request(`/api/records/gifts/${g.id}`,{method:'PATCH',session:f.staff,body:{version:1,notes:'Nonfinancial note'}});assert.equal(note.status,200);assert.equal((await f.read(r.id)).json.receipt.monetaryCents,12345);
 const receiptVoid=await f.voidReceipt(issued);assert.equal(receiptVoid.status,200);assert.equal(receiptVoid.json.receipt.status,'Voided');assert.equal(receiptVoid.json.receipt.version,3);assert.equal((await f.voidReceipt(issued)).status,409);
 const edit=await f.request(`/api/records/gifts/${g.id}`,{method:'PATCH',session:f.staff,body:{version:2,amount:12346,allocations:[{designationId:f.fund.id,amount:12346}]}});assert.equal(edit.status,200);assert.equal((await f.read(r.id)).json.receipt.monetaryCents,12345);assert.equal((await f.read(r.id)).json.receipt.number,'R-00000001');
});

test('fees and voids cannot issue, noncash requires description without assigned value, and sponsors explicitly disclose benefits',async t=>{
 const f=await fixture(t),fee=await f.gift(100,{type:'Fee payment'}),voided=await f.gift(100);await f.request(`/api/gifts/${voided.id}/void`,{method:'POST',session:f.staff,body:{version:1,reason:'Source void'}});
 for(const id of [fee.id,voided.id])assert.equal((await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Individual',giftId:id,profileVersion:1}})).status,409);
 const noncash=await f.gift(33333,{type:'In-kind',method:'In-kind'});assert.equal((await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Individual',giftId:noncash.id,profileVersion:1}})).status,400);const nr=await f.prepare({giftId:noncash.id,noncashDescription:'Three donated classroom desks'});assert.equal(nr.monetaryCents,0);assert.equal(nr.gifts[0].monetaryCents,0);assert.equal(nr.noncashDescription,'Three donated classroom desks');assert.doesNotMatch(JSON.stringify(nr),/\"amount\":33333|noncashCents|deductibleCents/);assert.equal((await f.issue(nr)).status,200);
 const sponsor=await f.gift(20000,{type:'Sponsorship'});assert.equal((await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Individual',giftId:sponsor.id,profileVersion:1}})).status,400);const sr=await f.prepare({giftId:sponsor.id,benefitsDescription:'Two event tickets',benefitValueCents:5000});assert.deepEqual(sr.benefits,{description:'Two event tickets',valueCents:5000});assert.equal(sr.monetaryCents,20000);assert.equal(sr.taxDeductibility,'Not determined');assert.equal(Object.hasOwn(sr,'deductibleCents'),false);assert.equal((await f.issue(sr)).status,200);
});

test('annual employee receipts use exact actual-calendar-year posted Payroll Employee giving and protect all linked gifts',async t=>{
 const f=await fixture(t),employee=await f.person('Payroll employee',{type:'Employee'}),base={constituentId:employee.id,type:'Employee giving',method:'Payroll'},a=await f.gift(10001,base),b=await f.gift(204,{...base,date:'2025-12-31'});await f.gift(100,{...base,date:'2026-01-01'});await f.gift(100,{...base,method:'Check'});await f.gift(100,{constituentId:employee.id,type:'Fee payment',method:'Payroll'});await f.gift(100,{constituentId:employee.id,type:'In-kind',method:'In-kind'});await f.gift(100,{softCreditId:employee.id});const reversed=await f.gift(100,base);await f.request(`/api/gifts/${reversed.id}/void`,{method:'POST',session:f.staff,body:{version:1,reason:'Reversed payroll'}});
 await f.request(`/api/gifts/${a.id}/school-year`,{method:'POST',session:f.staff,body:{version:1,schoolYear:'2024–2025',reason:'School-year assignment does not alter tax calendar'}});
 const r=await f.prepare({kind:'Annual employee',constituentId:employee.id,year:2025});assert.equal(r.monetaryCents,10205);assert.equal(r.giftCount,2);assert.equal(r.calendarYear,2025);assert.deepEqual(r.gifts.map(g=>g.id).sort(),[a.id,b.id].sort());assert.equal((await f.issue(r)).status,200);
 assert.equal((await f.request(`/api/records/gifts/${b.id}`,{method:'PATCH',session:f.staff,body:{version:1,date:'2026-01-01'}})).status,409);
 assert.equal((await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Annual employee',constituentId:f.donor.id,year:2025,profileVersion:1}})).status,400);
});

test('source/profile/current recipient versions and annual membership changes block stale issuance without consuming numbers',async t=>{
 const f=await fixture(t),g=await f.gift(),r=await f.prepare({giftId:g.id});const edit=await f.request(`/api/records/gifts/${g.id}`,{method:'PATCH',session:f.staff,body:{version:1,notes:'Source changed after preparation'}});assert.equal(edit.status,200);assert.equal((await f.issue(r)).status,409);
 const fresh=await f.prepare({giftId:g.id});const update=await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,body:profile({version:1,customFooter:'Revised client wording'})});assert.equal(update.status,200);assert.equal((await f.issue(fresh)).status,409);
 const employee=await f.person('Stale employee',{type:'Employee'});await f.gift(10,{constituentId:employee.id,type:'Employee giving',method:'Payroll'});const annual=await f.prepare({kind:'Annual employee',constituentId:employee.id,year:2025},{profileVersion:2});await f.gift(1,{constituentId:employee.id,type:'Employee giving',method:'Payroll'});assert.equal((await f.issue(annual)).status,409);assert.equal(f.db.prepare('SELECT value FROM receipt_number_sequence').get().value,0);
});

test('void/reissue keeps numbered original and correction reason, replacement uses current source, and concurrent/repeated issues cannot duplicate',async t=>{
 const f=await fixture(t),g=await f.gift(),prepared=await f.prepare({giftId:g.id}),original=(await f.issue(prepared)).json.receipt;
 assert.equal((await f.request(`/api/receipts/${original.id}/reissue`,{method:'POST',session:f.staff,body:{profileVersion:1,reason:'Correction'}})).status,409);assert.equal((await f.voidReceipt(original)).status,200);
 await f.request(`/api/records/gifts/${g.id}`,{method:'PATCH',session:f.staff,body:{version:1,amount:12346,allocations:[{designationId:f.fund.id,amount:12346}]}});
 const first=await f.request(`/api/receipts/${original.id}/reissue`,{method:'POST',session:f.staff,body:{profileVersion:1,reason:'Correct source amount'}});assert.equal(first.status,201);const replacement=first.json.receipt;assert.equal(replacement.priorReceiptId,original.id);assert.equal(replacement.reissueReason,'Correct source amount');assert.equal(replacement.monetaryCents,12346);assert.equal(replacement.number,null);
 const competing=await f.request(`/api/receipts/${original.id}/reissue`,{method:'POST',session:f.staff,body:{profileVersion:1,reason:'Competing correction'}});assert.equal(competing.status,201);
 const results=await Promise.all([f.issue(replacement),f.issue(replacement)]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(results.find(x=>x.status===200).json.receipt.number,'R-00000002');assert.equal((await f.issue(competing.json.receipt)).status,409);assert.equal(f.db.prepare('SELECT value FROM receipt_number_sequence').get().value,2);
 const retained=(await f.read(original.id)).json.receipt;assert.equal(retained.status,'Voided');assert.equal(retained.number,'R-00000001');assert.equal(retained.monetaryCents,12345);assert.ok(retained.replacements.includes(replacement.id));
});

test('overlapping prepared receipts cannot both issue for the same source gift',async t=>{
 const f=await fixture(t),g=await f.gift(),a=await f.prepare({giftId:g.id}),b=await f.prepare({giftId:g.id});assert.equal((await f.issue(a)).status,200);assert.equal((await f.issue(b)).status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM receipt_issues').get().n,1);
});

test('retained numbered history/profile/source links survive restart and searchable history exposes exact original facts',async t=>{
 const f=await fixture(t),g=await f.gift(),r=await f.prepare({giftId:g.id}),issued=(await f.issue(r)).json.receipt;await f.restart();assert.deepEqual((await f.read(r.id)).json.receipt,issued);
 for(const query of [`giftId=${g.id}`,`constituentId=${f.donor.id}`,`q=R-00000001&status=Issued`]){const h=await f.request('/api/receipts?'+query,{session:f.viewer});assert.equal(h.status,200);assert.equal(h.json.receipts.length,1);assert.equal(h.json.receipts[0].monetaryCents,12345);}
 assert.throws(()=>f.db.prepare('UPDATE receipt_preparations SET snapshot=? WHERE id=?').run('{}',r.id),/immutable/);assert.throws(()=>f.db.prepare('DELETE FROM receipt_issues WHERE receipt_id=?').run(r.id),/retained/);assert.throws(()=>f.db.prepare('DELETE FROM receipt_source_links WHERE receipt_id=?').run(r.id),/retained/);
 const next=await f.prepare({giftId:(await f.gift(2)).id});assert.equal((await f.issue(next)).json.receipt.number,'R-00000002');assert.equal((await f.request('/api/receipts?unknown=true',{session:f.viewer})).status,400);
});

test('receipt permissions require current auth, CSRF, staff issuance and administrator profile approval; payload cannot claim email or tax certification',async t=>{
 const f=await fixture(t),g=await f.gift(),body={kind:'Individual',giftId:g.id,profileVersion:1};for(const [options,status] of [[{body},401],[{body,session:f.viewer},403],[{body,session:f.staff,csrf:false},403],[{body,session:f.staff,csrf:'wrong'},403],[{body:{...body,recipientId:f.other.id},session:f.staff},400],[{body:{...body,deductibleCents:12345},session:f.staff},400]])assert.equal((await f.request('/api/receipts/prepare',{method:'POST',...options})).status,status);
 assert.equal((await f.request('/api/receipt-profile',{method:'PUT',session:f.staff,body:profile({version:1})})).status,403);assert.equal((await f.request('/api/receipt-profile',{method:'PUT',session:f.admin,csrf:false,body:profile({version:1})})).status,403);
 const r=await f.prepare({giftId:g.id});assert.equal((await f.issue(r,{},f.viewer)).status,403);assert.equal((await f.issue(r,{delivered:true})).status,400);assert.equal((await f.issue(r,{taxCertified:true})).status,400);assert.equal((await f.request(`/api/receipts/${r.id}/issue`,{method:'POST',session:f.staff,csrf:false,body:{version:1,preparationDigest:r.preparationDigest,channel:'Print',printed:true,handSigned:true,issueDate:'2026-09-13'}})).status,403);assert.equal((await f.request('/api/receipts')).status,401);assert.equal((await f.request('/api/receipt-profile')).status,401);
});

test('audit write failures roll back preparation, issue number and void; audit retains metadata rather than tax identifiers or custom wording',async t=>{
 const f=await fixture(t),g=await f.gift();f.db.exec("CREATE TRIGGER receipt_audit_fault BEFORE INSERT ON audit WHEN NEW.action='prepare_receipt' BEGIN SELECT RAISE(ABORT,'fixture receipt audit fault'); END;");const bad=await f.request('/api/receipts/prepare',{method:'POST',session:f.staff,body:{kind:'Individual',giftId:g.id,profileVersion:1}});assert.equal(bad.status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM receipt_preparations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM receipt_source_links').get().n,0);f.db.exec('DROP TRIGGER receipt_audit_fault');
 const r=await f.prepare({giftId:g.id});f.db.exec("CREATE TRIGGER receipt_audit_fault BEFORE INSERT ON audit WHEN NEW.action='issue_receipt' BEGIN SELECT RAISE(ABORT,'fixture receipt audit fault'); END;");assert.equal((await f.issue(r)).status,500);assert.equal(f.db.prepare('SELECT value FROM receipt_number_sequence').get().value,0);assert.equal(f.db.prepare('SELECT count(*) n FROM receipt_issues').get().n,0);f.db.exec('DROP TRIGGER receipt_audit_fault');const issued=(await f.issue(r)).json.receipt;
 f.db.exec("CREATE TRIGGER receipt_audit_fault BEFORE INSERT ON audit WHEN NEW.action='void_receipt' BEGIN SELECT RAISE(ABORT,'fixture receipt audit fault'); END;");assert.equal((await f.voidReceipt(issued)).status,500);assert.equal((await f.read(r.id)).json.receipt.status,'Issued');f.db.exec('DROP TRIGGER receipt_audit_fault');assert.equal((await f.voidReceipt(issued)).status,200);
 const metadata=f.db.prepare("SELECT details FROM audit WHERE action LIKE '%receipt%'").all();assert.doesNotMatch(JSON.stringify(metadata),/TEST-ONLY-ID|123 Test Street|Receipt donor|fictional test|csrf|password/);
});

test('identity merge protects both source and target issued recipients and catches issuance after a prior merge preview',async t=>{
 const f=await fixture(t),g=await f.gift(),r=await f.prepare({giftId:g.id});const payload={targetId:f.other.id,sourceId:f.donor.id,targetVersion:1,sourceVersion:1,reason:'Reconcile duplicate identity'};
 const preview=await f.request('/api/identity/merge/preview',{method:'POST',session:f.admin,body:payload});assert.equal(preview.status,200);assert.equal(preview.json.preview.blockers.length,0);const issued=(await f.issue(r)).json.receipt;
 for(const body of [payload,{...payload,targetId:f.donor.id,sourceId:f.other.id}]){const denied=await f.request('/api/identity/merge/preview',{method:'POST',session:f.admin,body});assert.equal(denied.status,409);assert.equal(denied.json.receiptId,r.id);assert.match(denied.json.error,/Void the affected receipt/);}
 const commit=await f.request('/api/identity/merge',{method:'POST',session:f.admin,body:{...payload,previewDigest:preview.json.preview.previewDigest}});assert.equal(commit.status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM identity_aliases').get().n,0);
 assert.equal((await f.voidReceipt(issued)).status,200);const released=await f.request('/api/identity/merge/preview',{method:'POST',session:f.admin,body:payload});assert.equal(released.status,200);assert.equal(released.json.preview.blockers.length,0);
});

test('identity merge blocks active receipt source soft-credit rewrites, while prepared-only merge invalidates stale receipt issuance',async t=>{
 const f=await fixture(t),third=await f.person('Third identity'),g=await f.gift(100,{softCreditId:f.other.id}),r=await f.prepare({giftId:g.id}),issued=(await f.issue(r)).json.receipt;
 const softMerge={targetId:third.id,sourceId:f.other.id,targetVersion:1,sourceVersion:1,reason:'Reconcile soft-credit identity'};assert.equal((await f.request('/api/identity/merge/preview',{method:'POST',session:f.admin,body:softMerge})).status,409);await f.voidReceipt(issued);
 const donorOnly=await f.person('Prepared only donor'),target=await f.person('Prepared target'),unissuedGift=await f.gift(20,{constituentId:donorOnly.id}),prepared=await f.prepare({giftId:unissuedGift.id});const payload={targetId:target.id,sourceId:donorOnly.id,targetVersion:1,sourceVersion:1,reason:'Merge before receipt issuance'};
 const preview=await f.request('/api/identity/merge/preview',{method:'POST',session:f.admin,body:payload});assert.equal(preview.status,200);assert.equal(preview.json.preview.blockers.length,0);const merge=await f.request('/api/identity/merge',{method:'POST',session:f.admin,body:{...payload,previewDigest:preview.json.preview.previewDigest}});assert.equal(merge.status,200);assert.equal((await f.issue(prepared)).status,409);assert.equal((await f.read(prepared.id)).json.receipt.recipient.id,donorOnly.id);const fresh=await f.prepare({giftId:unissuedGift.id});assert.equal(fresh.recipient.id,target.id);assert.equal((await f.issue(fresh)).status,200);
});
