import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-tributes-'));let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:''});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}/api`;}
 async function close(){if(server)await new Promise(r=>server.close(r));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const r=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,json:await r.json(),headers:r.headers};}
 async function login(email='alex@foundation.example'){const r=await request('/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200);return {...r.json,cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(collection,body){const r=await request('/records/'+collection,{method:'POST',session:staff,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const donor=await create('constituents',{name:'Tribute donor',type:'Individual',email:'tributedonor@example.test',preference:'Email'}),honoree=await create('constituents',{name:'Honored person',type:'Individual'}),recipient=await create('constituents',{name:'Selected family recipient',type:'Individual',email:'family@example.test',preference:'Post'}),softCredit=await create('constituents',{name:'Separate soft credit',type:'Individual'}),fund=await create('designations',{name:'Tribute fund',accountCode:'TRIB-101'});
 async function gift(changes={}){return create('gifts',{constituentId:donor.id,amount:10001,type:'Cash',method:'Check',date:'2025-09-13',allocations:[{designationId:fund.id,amount:10001}],softCreditId:softCredit.id,...changes});}
 const source=await gift();
 const definition=(changes={})=>({giftId:source.id,type:'Honor',honoreeName:'',honoreeId:honoree.id,notificationRecipientId:recipient.id,message:'A personal remembrance <script>literal</script>',notes:'Internal record note',visibility:'Team',donorDisclosureApproved:true,...changes});
 async function tribute(changes={}){const r=await request('/tributes',{method:'POST',session:staff,body:definition(changes)});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.tribute;}
 async function prepare(record,channel='Print'){const r=await request('/tributes/'+record.id+'/notifications/prepare',{method:'POST',session:staff,body:{version:record.version,channel}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.notification;}
 const finalize=(n,changes={})=>request('/tribute-notifications/'+n.id+'/finalize',{method:'POST',session:staff,body:{version:1,preparationDigest:n.preparationDigest,confirmed:true,...changes}});
 async function patch(collection,record,changes){return request('/records/'+collection+'/'+record.id,{method:'PATCH',session:staff,body:{version:record.version,...changes}});}
 const edit=(record,changes)=>request('/tributes/'+record.id,{method:'PATCH',session:staff,body:{version:record.version,...changes}});
 return {request,login,admin,staff,viewer,create,donor,honoree,recipient,softCredit,fund,source,gift,definition,tribute,prepare,finalize,patch,edit,restart:async()=>{await close();await open();},get db(){return app.locals.db;}};
}

test('honor and memorial definitions retain versions and original source facts without changing income or donor credit',async t=>{
 const f=await fixture(t),before=f.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY id").all();const honor=await f.tribute(),memory=await f.tribute({type:'Memory',honoreeId:null,honoreeName:'Remembered loved one'});assert.equal(memory.type,'Memory');
 const edited=await f.edit(honor,{message:'Revised remembrance',notes:'Updated internal notes'});assert.equal(edited.status,200);assert.equal(edited.json.tribute.version,2);assert.equal((await f.edit(honor,{notes:'Stale edit'})).status,409);
 const detail=await f.request('/tributes/'+honor.id,{session:f.viewer});assert.equal(detail.status,200);assert.equal(detail.json.revisions.length,2);const first=detail.json.revisions[0];assert.equal(first.source.gift.amount,10001);assert.equal(first.source.donor.id,f.donor.id);assert.equal(first.source.honoree.id,f.honoree.id);assert.equal(first.definition.message,f.definition().message);assert.deepEqual(f.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY id").all(),before);
 assert.equal((await f.edit(edited.json.tribute,{giftId:(await f.gift()).id})).status,409);assert.throws(()=>f.db.exec("DELETE FROM tribute_versions"),/retained/);
});

test('notifications name only the approved donor, honoree and selected recipient and finalization never sends or writes income',async t=>{
 const f=await fixture(t);await f.patch('constituents',f.recipient,{contacts:[{name:'Undisclosed secondary',email:'secondary@example.test',role:'Family'}]});const r=await f.tribute(),before=f.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY id").all(),n=await f.prepare(r);
 assert.equal(n.status,'Draft');assert.equal(n.delivery,'Not sent');assert.equal(n.recipient.id,f.recipient.id);assert.equal(n.recipient.email,'');assert.match(n.body,/Tribute donor/);assert.match(n.body,/<script>literal<\/script>/);assert.doesNotMatch(JSON.stringify(n),/Separate soft credit|secondary@example|Undisclosed secondary|10001|\$100\.01|Internal record note/);assert.equal(n.references.find(x=>x.collection==='gifts').version,1);
 assert.equal((await f.finalize(n,{confirmed:false})).status,400);assert.equal((await f.finalize(n,{preparationDigest:'0'.repeat(64)})).status,409);const done=await f.finalize(n);assert.equal(done.status,200);assert.equal(done.json.notification.status,'Finalized');assert.equal(done.json.notification.delivery,'Not sent');assert.equal((await f.finalize(n)).status,409);assert.deepEqual(f.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY id").all(),before);assert.equal(JSON.parse(before.find(x=>JSON.parse(x.data).id===f.source.id).data).acknowledgment,undefined);
 assert.throws(()=>f.db.exec("UPDATE tribute_notifications SET snapshot='{}'"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM tribute_notification_finalizations'),/retained/);
});

test('recipient channel preferences, donor disclosure review and opt-outs block drafts and stale finalization',async t=>{
 const f=await fixture(t),r=await f.tribute({donorDisclosureApproved:false});assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:1,channel:'Print'}})).status,403);
 const approved=(await f.edit(r,{donorDisclosureApproved:true})).json.tribute;assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:2,channel:'Email draft'}})).status,400);const n=await f.prepare(approved);
 const email=(await f.patch('constituents',f.recipient,{preference:'Email'})).json.record;assert.equal((await f.finalize(n)).status,400);const emailDraft=await f.prepare(approved,'Email draft');assert.equal(emailDraft.recipient.email,'family@example.test');await f.patch('constituents',email,{preference:'Do not contact'});assert.equal((await f.finalize(emailDraft)).status,403);
 assert.equal((await f.request('/tributes/'+approved.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:approved.version,channel:'Email draft'}})).status,403);
 const donorBlocked=await f.tribute({notificationRecipientId:f.honoree.id});await f.patch('constituents',f.donor,{preference:'Do not contact'});assert.equal((await f.request('/tributes/'+donorBlocked.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:1,channel:'Print'}})).status,403);assert.equal(f.db.prepare('SELECT count(*) n FROM tribute_notification_finalizations').get().n,0);
});

test('private current records and private retained versions/notifications never leak to viewers after visibility changes',async t=>{
 const f=await fixture(t),r=await f.tribute({visibility:'Staff only',message:'Private family wording'}),n=await f.prepare(r);assert.equal((await f.request('/tributes/'+r.id,{session:f.viewer})).status,404);assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.viewer})).status,404);assert.equal((await f.request('/tributes',{session:f.viewer})).json.tributes.length,0);assert.equal((await f.request('/tribute-notifications',{session:f.viewer})).json.notifications.length,0);
 const publicRecord=(await f.edit(r,{visibility:'Team',message:'Shared tribute text'})).json.tribute;const detail=await f.request('/tributes/'+r.id,{session:f.viewer});assert.equal(detail.status,200);assert.equal(detail.json.revisions.length,1);assert.doesNotMatch(JSON.stringify(detail.json),/Private family wording/);assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.viewer})).status,404);
 const publicNotification=await f.prepare(publicRecord);assert.equal((await f.request('/tribute-notifications/'+publicNotification.id,{session:f.viewer})).status,200);await f.edit(publicRecord,{visibility:'Staff only'});assert.equal((await f.request('/tribute-notifications/'+publicNotification.id,{session:f.viewer})).status,404);assert.equal((await f.request('/tribute-notifications',{session:f.viewer})).json.notifications.length,0);assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.staff})).status,200);
});

test('future, void and fee sources are excluded and source or tribute changes invalidate review snapshots',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,8,13,12)});const f=await fixture(t),future=await f.gift({date:'2026-12-31'}),fee=await f.gift({type:'Fee payment'}),voided=await f.gift();await f.request('/gifts/'+voided.id+'/void',{method:'POST',session:f.staff,body:{version:1,reason:'Source reversed'}});
 for(const g of [future,fee,voided])assert.equal((await f.request('/tributes',{method:'POST',session:f.staff,body:f.definition({giftId:g.id})})).status,409);
 const r=await f.tribute(),n=await f.prepare(r);const changed=(await f.patch('gifts',f.source,{notes:'Source note changed'})).json.record;assert.equal((await f.finalize(n)).status,409);const fresh=await f.prepare(r);const revised=(await f.edit(r,{honoreeName:'Updated honoree wording'})).json.tribute;assert.equal((await f.finalize(fresh)).status,409);const current=await f.prepare(revised);assert.equal((await f.patch('gifts',changed,{date:'2026-12-31',correctionReason:'Correct the source transaction date'})).status,200);assert.equal((await f.finalize(current)).status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM tribute_notification_finalizations').get().n,0);
});

test('retained source identities cannot be deleted, reclassified, merged or rewritten through encoded paths',async t=>{
 const f=await fixture(t),r=await f.tribute(),other=await f.create('constituents',{name:'Other identity',type:'Individual'}),n=await f.prepare(r);assert.equal((await f.finalize(n)).status,200);
 for(const p of [f.donor,f.honoree,f.recipient,f.softCredit]){const encoded='%'+p.id.charCodeAt(0).toString(16)+p.id.slice(1);assert.equal((await f.request('/records/constituents/'+encoded,{method:'DELETE',session:f.admin,body:{version:p.version}})).status,409);assert.equal((await f.patch('constituents',p,{type:'Business'})).status,409);assert.equal((await f.request('/identity/merge/preview',{method:'POST',session:f.admin,body:{sourceId:p.id,targetId:other.id,sourceVersion:p.version,targetVersion:other.version,reason:'Historical duplicate'}})).status,409);}
 const enc='%'+f.source.id.charCodeAt(0).toString(16)+f.source.id.slice(1);for(const changes of [{constituentId:other.id},{softCreditId:other.id},{amount:1,allocations:[{designationId:f.fund.id,amount:1}]},{date:'2025-01-01'}])assert.equal((await f.request('/records/gifts/'+enc,{method:'PATCH',session:f.staff,body:{version:1,...changes}})).status,409);
 const note=(await f.patch('gifts',f.source,{notes:'Allowed ordinary note'})).json.record;assert.equal(note.version,2);assert.equal((await f.request('/gifts/'+note.id+'/school-year',{method:'POST',session:f.staff,body:{version:2,schoolYear:'2024–2025',reason:'Authorized fiscal assignment'}})).status,200);
});

test('already merged honorees and recipients cannot be selected, even when a source retained old Email preference',async t=>{
 const f=await fixture(t),source=await f.create('constituents',{name:'Merged email source',type:'Individual',email:'merged@example.test',preference:'Email'}),target=await f.create('constituents',{name:'DNC survivor',type:'Individual',preference:'Do not contact'}),p={sourceId:source.id,targetId:target.id,sourceVersion:1,targetVersion:1,reason:'Reviewed duplicate'};const preview=await f.request('/identity/merge/preview',{method:'POST',session:f.admin,body:p});assert.equal(preview.status,200);assert.equal((await f.request('/identity/merge',{method:'POST',session:f.admin,body:{...p,previewDigest:preview.json.preview.previewDigest}})).status,200);
 for(const changes of [{honoreeId:source.id},{notificationRecipientId:source.id}])assert.equal((await f.request('/tributes',{method:'POST',session:f.staff,body:f.definition(changes)})).status,409);
});

test('actual authentication, role, CSRF, strict inputs and restart protect durable reviewed history and audit',async t=>{
 const f=await fixture(t);for(const [options,status] of [[{body:f.definition()},401],[{session:f.viewer,body:f.definition()},403],[{session:f.staff,csrf:false,body:f.definition()},403],[{session:f.staff,body:f.definition({deductibleAmount:100})},400],[{session:f.staff,body:f.definition({honoreeId:null,honoreeName:''})},400]])assert.equal((await f.request('/tributes',{method:'POST',...options})).status,status);
 const r=await f.tribute(),n=await f.prepare(r),done=await f.finalize(n);assert.equal(done.status,200);assert.equal((await f.request('/tributes/'+r.id,{method:'PATCH',session:f.viewer,body:{version:1,notes:'Forbidden'}})).status,403);assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.viewer,body:{version:1,channel:'Print'}})).status,403);assert.equal((await f.request('/tributes/'+r.id,{method:'DELETE',session:f.staff,body:{version:1}})).status,403);assert.equal((await f.request('/tribute-notifications')).status,401);
 const audits=f.db.prepare("SELECT details FROM audit WHERE action LIKE '%tribute%'").all();assert.doesNotMatch(JSON.stringify(audits),/Tribute donor|family@example|personal remembrance|Internal record|password|csrf/);await f.restart();const session=await f.login('staff@foundation.example');assert.deepEqual((await f.request('/tribute-notifications/'+n.id,{session})).json.notification,done.json.notification);assert.equal((await f.request('/tributes/'+r.id,{session})).json.revisions.length,1);
});

test('failed audit writes roll back tribute creation, drafts and finalization without unaudited retained records',async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER tribute_audit_fault BEFORE INSERT ON audit WHEN NEW.action='create_tribute' BEGIN SELECT RAISE(ABORT,'fixture tribute audit fault'); END;");assert.equal((await f.request('/tributes',{method:'POST',session:f.staff,body:f.definition()})).status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM tributes').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM tribute_versions').get().n,0);f.db.exec('DROP TRIGGER tribute_audit_fault');const r=await f.tribute();f.db.exec("CREATE TRIGGER tribute_audit_fault BEFORE INSERT ON audit WHEN NEW.action='prepare_tribute_notification' BEGIN SELECT RAISE(ABORT,'fixture tribute audit fault'); END;");assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:1,channel:'Print'}})).status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM tribute_notifications').get().n,0);f.db.exec('DROP TRIGGER tribute_audit_fault');const n=await f.prepare(r);f.db.exec("CREATE TRIGGER tribute_audit_fault BEFORE INSERT ON audit WHEN NEW.action='finalize_tribute_notification' BEGIN SELECT RAISE(ABORT,'fixture tribute audit fault'); END;");assert.equal((await f.finalize(n)).status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM tribute_notification_finalizations').get().n,0);
});

test('revoked donor disclosure hides donor-containing draft and finalized originals and source history from viewers',async t=>{
 const f=await fixture(t),r=await f.tribute(),draft=await f.prepare(r),finalized=await f.prepare(r);assert.equal((await f.finalize(finalized)).status,200);
 assert.equal((await f.request('/tribute-notifications/'+draft.id,{session:f.viewer})).status,200);
 const revoked=(await f.edit(r,{donorDisclosureApproved:false})).json.tribute;assert.equal(revoked.visibility,'Team');
 for(const n of [draft,finalized]){const denied=await f.request('/tribute-notifications/'+n.id,{session:f.viewer});assert.equal(denied.status,404);assert.doesNotMatch(JSON.stringify(denied.json),/Tribute donor|tributedonor@example/);assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.staff})).status,200);}
 assert.equal((await f.request('/tribute-notifications',{session:f.viewer})).json.notifications.length,0);const history=await f.request('/tributes/'+r.id,{session:f.viewer});assert.equal(history.status,200);assert.deepEqual(history.json.revisions,[]);assert.doesNotMatch(JSON.stringify(history.json),/Tribute donor|tributedonor@example/);assert.equal((await f.request('/tributes/'+r.id,{session:f.staff})).json.revisions.length,2);
 await f.restart();const viewer=await f.login('board@foundation.example');assert.equal((await f.request('/tribute-notifications/'+draft.id,{session:viewer})).status,404);assert.deepEqual((await f.request('/tributes/'+r.id,{session:viewer})).json.revisions,[]);
 const restored=(await f.edit(revoked,{donorDisclosureApproved:true})).json.tribute;const visible=await f.request('/tributes/'+r.id,{session:viewer});assert.deepEqual(visible.json.revisions.map(v=>v.version),[1,3]);assert.equal(restored.version,3);assert.equal((await f.request('/tribute-notifications/'+draft.id,{session:viewer})).status,200);
});

const notificationWithdrawBody=(n,changes={})=>({version:n.version,preparationDigest:n.preparationDigest,reason:'Wrong unsent wording; retained original replaced after source review',confirmedNotSent:true,...changes});
const encodedNoticeId=key=>'%'+key.charCodeAt(0).toString(16)+key.slice(1);

test('unsent finalized notification withdrawal requires writable role, CSRF, current version, original digest and explicit reasoned confirmation',async t=>{
 const f=await fixture(t),r=await f.tribute(),n=await f.prepare(r),path='/tribute-notifications/'+encodedNoticeId(n.id)+'/withdraw';
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:notificationWithdrawBody(n)})).status,409);
 const final=(await f.finalize(n)).json.notification;
 for(const [options,status] of [[{},401],[{session:f.viewer},403],[{session:f.staff,csrf:false},403]])assert.equal((await f.request(path,{method:'POST',body:notificationWithdrawBody(final),...options})).status,status);
 for(const changes of [{reason:' '},{reason:'x'.repeat(2001)},{confirmedNotSent:false},{extra:'Not allowed'}])assert.equal((await f.request(path,{method:'POST',session:f.staff,body:notificationWithdrawBody(final,changes)})).status,400);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:notificationWithdrawBody(final,{version:2})})).status,409);assert.equal((await f.request(path,{method:'POST',session:f.staff,body:notificationWithdrawBody(final,{preparationDigest:'0'.repeat(64)})})).status,409);
 const original=f.db.prepare('SELECT * FROM tribute_notifications WHERE id=?').get(n.id),finalization=f.db.prepare('SELECT * FROM tribute_notification_finalizations WHERE notification_id=?').get(n.id),giftBefore=f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(f.source.id);
 const withdrawn=await f.request(path,{method:'POST',session:f.admin,body:notificationWithdrawBody(final)});assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.json));const current=withdrawn.json.notification;
 assert.equal(current.status,'Withdrawn');assert.equal(current.version,2);assert.equal(current.delivery,'Not sent');assert.equal(current.body,final.body);assert.equal(current.preparationDigest,final.preparationDigest);assert.equal(current.finalizedAt,final.finalizedAt);assert.equal(current.withdrawal.reason,notificationWithdrawBody(final).reason);assert.equal(current.withdrawal.actor,f.admin.user.id);assert.equal(current.withdrawal.confirmedNotSent,true);
 assert.deepEqual(f.db.prepare('SELECT * FROM tribute_notifications WHERE id=?').get(n.id),original);assert.deepEqual(f.db.prepare('SELECT * FROM tribute_notification_finalizations WHERE notification_id=?').get(n.id),finalization);assert.deepEqual(f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(f.source.id),giftBefore);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:notificationWithdrawBody(final)})).status,409);assert.equal((await f.finalize(n)).status,409);assert.throws(()=>f.db.exec("UPDATE tribute_notification_withdrawals SET reason='Rewrite'"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM tribute_notification_withdrawals'),/retained/);
 await f.restart();const staff=await f.login('staff@foundation.example');assert.deepEqual((await f.request('/tribute-notifications/'+n.id,{session:staff})).json.notification,current);
});

test('all active finalized notices must withdraw before reasoned source correction, and replacement requires fresh current-source review',async t=>{
 const f=await fixture(t),r=await f.tribute(),one=await f.prepare(r),two=await f.prepare(r),staleDraft=await f.prepare(r);assert.equal((await f.finalize(one)).status,200);assert.equal((await f.finalize(two)).status,200);
 const corrections={amount:12002,allocations:[{designationId:f.fund.id,amount:12002}],method:'ACH',correctionReason:'Checked source evidence and corrected amount and method'};
 assert.equal((await f.patch('gifts',f.source,corrections)).status,409);
 const withdraw=n=>f.request('/tribute-notifications/'+n.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(n)});
 assert.equal((await withdraw(one)).status,200);assert.equal((await f.patch('gifts',f.source,corrections)).status,409);assert.equal((await withdraw(two)).status,200);
 const corrected=await f.patch('gifts',f.source,corrections);assert.equal(corrected.status,200,JSON.stringify(corrected.json));assert.equal(corrected.json.record.amount,12002);assert.equal(corrected.json.record.version,2);assert.equal((await f.finalize(staleDraft)).status,409);
 const fresh=await f.prepare(r);assert.equal(fresh.status,'Draft');assert.equal(fresh.references.find(v=>v.collection==='gifts').version,2);assert.notEqual(fresh.preparationDigest,one.preparationDigest);assert.equal((await f.finalize(fresh,{confirmed:false})).status,400);assert.equal((await f.finalize(fresh)).status,200);
 assert.equal((await f.patch('gifts',corrected.json.record,{date:'2025-09-14',correctionReason:'Another correction requires active notice disposition'})).status,409);
 const history=(await f.request('/tribute-notifications?tributeId='+r.id,{session:f.staff})).json.notifications;assert.equal(history.filter(n=>n.status==='Withdrawn').length,2);assert.equal(history.filter(n=>n.status==='Finalized').length,1);assert.equal(history.find(n=>n.id===one.id).references.find(v=>v.collection==='gifts').version,1);
 assert.equal((await f.patch('gifts',corrected.json.record,{softCreditId:null,correctionReason:'Identity retention remains protected'})).status,409);
});

test('withdrawn originals preserve saved/current disclosure privacy and hide internal withdrawal reasons from viewers',async t=>{
 const f=await fixture(t),r=await f.tribute({visibility:'Staff only',message:'Private retained family wording'}),n=await f.prepare(r);assert.equal((await f.finalize(n)).status,200);const reason='Sensitive internal staff withdrawal reason';
 assert.equal((await f.request('/tribute-notifications/'+n.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(n,{reason})})).status,200);assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.viewer})).status,404);
 const shared=(await f.edit(r,{visibility:'Team',message:'Shared replacement wording'})).json.tribute;assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.viewer})).status,404);assert.doesNotMatch(JSON.stringify((await f.request('/tribute-notifications',{session:f.viewer})).json),/Private retained family wording|Sensitive internal/);
 const sharedNotice=await f.prepare(shared);assert.equal((await f.finalize(sharedNotice)).status,200);assert.equal((await f.request('/tribute-notifications/'+sharedNotice.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(sharedNotice,{reason})})).status,200);
 const viewerRead=await f.request('/tribute-notifications/'+sharedNotice.id,{session:f.viewer});assert.equal(viewerRead.status,200);assert.equal(viewerRead.json.notification.status,'Withdrawn');assert.equal(viewerRead.json.notification.withdrawal.reason,undefined);assert.doesNotMatch(JSON.stringify(viewerRead.json),/Sensitive internal/);
 const revoked=(await f.edit(shared,{donorDisclosureApproved:false})).json.tribute;assert.equal((await f.request('/tribute-notifications/'+sharedNotice.id,{session:f.viewer})).status,404);assert.equal((await f.request('/tribute-notifications',{session:f.viewer})).json.notifications.length,0);assert.equal((await f.request('/tributes/'+r.id,{session:f.viewer})).json.revisions.length,0);
 assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:revoked.version,channel:'Print'}})).status,403);
 await f.restart();const viewer=await f.login('board@foundation.example');assert.equal((await f.request('/tribute-notifications/'+sharedNotice.id,{session:viewer})).status,404);assert.equal((await f.request('/tribute-notifications/'+n.id,{session:viewer})).status,404);
});

test('withdrawal audit failure rolls back disposition and preserves the active source lock',async t=>{
 const f=await fixture(t),r=await f.tribute(),n=await f.prepare(r);const finalized=await f.finalize(n);assert.equal(finalized.status,200);const auditBefore=f.db.prepare('SELECT COUNT(*) n FROM audit').get().n;
 f.db.exec("CREATE TRIGGER synthetic_withdrawal_audit_fault BEFORE INSERT ON audit WHEN NEW.action='withdraw_tribute_notification' BEGIN SELECT RAISE(ABORT,'Synthetic withdrawal audit fault'); END;");
 assert.equal((await f.request('/tribute-notifications/'+n.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(n)})).status,500);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tribute_notification_withdrawals').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit').get().n,auditBefore);assert.deepEqual((await f.request('/tribute-notifications/'+n.id,{session:f.staff})).json.notification,finalized.json.notification);assert.equal((await f.patch('gifts',f.source,{date:'2025-09-14',correctionReason:'Still protected after failed withdrawal'})).status,409);
 f.db.exec('DROP TRIGGER synthetic_withdrawal_audit_fault');assert.equal((await f.request('/tribute-notifications/'+n.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(n)})).status,200);assert.equal((await f.patch('gifts',f.source,{date:'2025-09-14',correctionReason:'Successful retained withdrawal releases financial correction'})).status,200);
});

test('withdrawal does not waive current donor/recipient opt-outs for replacement preparation',async t=>{
 const f=await fixture(t),r=await f.tribute(),n=await f.prepare(r);assert.equal((await f.finalize(n)).status,200);assert.equal((await f.request('/tribute-notifications/'+n.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(n)})).status,200);
 const blocked=(await f.patch('constituents',f.recipient,{preference:'Do not contact'})).json.record;assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:r.version,channel:'Print'}})).status,403);
 const restored=(await f.patch('constituents',blocked,{preference:'Post'})).json.record;const draft=await f.prepare(r);await f.patch('constituents',restored,{preference:'Do not contact'});assert.equal((await f.finalize(draft)).status,403);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tribute_notification_finalizations').get().n,1);
 const audits=f.db.prepare("SELECT details FROM audit WHERE action='withdraw_tribute_notification'").all();assert.doesNotMatch(JSON.stringify(audits),/Wrong unsent wording|Tribute donor|family@example|Internal record/);
});

test('separately controlled gift void remains distinct from notification withdrawal and exposes retained source status',async t=>{
 const f=await fixture(t),r=await f.tribute(),n=await f.prepare(r);const final=await f.finalize(n);assert.equal(final.status,200);assert.equal(final.json.notification.currentSourceStatus,'Posted');
 const original=f.db.prepare('SELECT snapshot,digest FROM tribute_notifications WHERE id=?').get(n.id);assert.equal((await f.request('/gifts/'+f.source.id+'/void',{method:'POST',session:f.staff,body:{version:f.source.version,reason:'Actual source record reversed; unsent wording retained for review'}})).status,200);
 const retained=await f.request('/tribute-notifications/'+n.id,{session:f.staff});assert.equal(retained.status,200);assert.equal(retained.json.notification.currentSourceStatus,'Voided');assert.equal(retained.json.notification.status,'Finalized');assert.equal(retained.json.notification.body,n.body);assert.deepEqual(f.db.prepare('SELECT snapshot,digest FROM tribute_notifications WHERE id=?').get(n.id),original);
 assert.equal((await f.request('/tributes/'+r.id+'/notifications/prepare',{method:'POST',session:f.staff,body:{version:r.version,channel:'Print'}})).status,409);
 const withdrawn=await f.request('/tribute-notifications/'+n.id+'/withdraw',{method:'POST',session:f.staff,body:notificationWithdrawBody(n)});assert.equal(withdrawn.status,200);assert.equal(withdrawn.json.notification.currentSourceStatus,'Voided');assert.equal(withdrawn.json.notification.status,'Withdrawn');assert.equal((await f.finalize(n)).status,409);
});

test('corrupt retained withdrawal evidence fails closed and cannot silently release a financial source lock',async t=>{
 const f=await fixture(t),r=await f.tribute(),n=await f.prepare(r);assert.equal((await f.finalize(n)).status,200);
 f.db.prepare('INSERT INTO tribute_notification_withdrawals VALUES(?,?,?,?,?,?,?)').run(n.id,2,'0'.repeat(64),'Synthetic corrupted evidence',f.staff.user.id,new Date().toISOString(),1);
 assert.equal((await f.request('/tribute-notifications/'+n.id,{session:f.staff})).status,503);assert.equal((await f.patch('gifts',f.source,{date:'2025-09-14',correctionReason:'Corrupt evidence must not unlock financial edits'})).status,409);assert.equal(JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(f.source.id).data).version,1);
});
