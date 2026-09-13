import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';

async function fixture(t){
 const password='SyntheticPeerFinance!2026',app=createApp({seed:false,tenantId:randomUUID(),initialAdmin:{name:'Synthetic administrator',email:'peer.unit@example.test',password},workflowWorker:false,reminderWorker:false}),server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();});
 const base='http://127.0.0.1:'+server.address().port;let session;
 async function request(path,{method='GET',body,csrf=true}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();return {status:r.status,json:JSON.parse(text),text};}
 const auth=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'peer.unit@example.test',password})});assert.equal(auth.status,200);session={...await auth.json(),cookie:auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
 async function create(collection,body){const r=await request('/records/'+collection,{method:'POST',body});assert.equal(r.status,201,r.text);return r.json.record;}
 const donor=await create('constituents',{name:'Actual donor',type:'Individual',preference:'Do not contact'}),person=await create('constituents',{name:'Fundraiser identity',type:'Business'}),soft=await create('constituents',{name:'Separate recognition identity',type:'Individual'}),fund=await create('designations',{name:'Primary fund',accountCode:'SYN-P1'}),secondFund=await create('designations',{name:'Secondary fund',accountCode:'SYN-P2'}),campaign=await create('campaigns',{name:'Internal peer effort',type:'Peer-to-peer',goal:100000,startDate:'2026-01-01',endDate:'2026-12-31',status:'Active'});
 const gift=await create('gifts',{constituentId:donor.id,softCreditId:soft.id,campaignId:campaign.id,amount:10001,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount:5000},{designationId:secondFund.id,amount:5001}],giftKind:'One-time',pledge:'Legacy descriptive source label'});
 const db=app.locals.db,row=(collection,id)=>JSON.parse(db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection,id).data);
 const sourceBody={campaignId:campaign.id,campaignVersion:1,constituentId:person.id,constituentVersion:1,coordinatorId:session.user.id,coordinatorVersion:1,title:'An internal referral effort',goalCents:25000,visibility:'Workspace'};
 async function setup(changes={}){const r=await request('/peer-fundraisers',{method:'POST',body:{...sourceBody,...changes}});assert.equal(r.status,201,r.text);return r.json.fundraiser;}
 async function attribute(peer,changes={}){return request('/peer-fundraisers/'+peer.id+'/attributions',{method:'POST',body:{version:peer.version,giftId:gift.id,giftVersion:row('gifts',gift.id).version,campaignVersion:1,coordinatorVersion:1,reason:'Reviewed internal source attribution',...changes}});}
 return {app,db,request,create,donor,person,soft,fund,secondFund,campaign,gift,row,sourceBody,setup,attribute};
}

test('shared financial facts protect legacy pledge labels but allow allocation ordering and fiscal classification without changing received cents',async t=>{
 const f=await fixture(t),peer=await f.setup(),before=f.row('gifts',f.gift.id),linked=await f.attribute(peer);assert.equal(linked.status,201,linked.text);assert.deepEqual(f.row('gifts',f.gift.id),before);assert.equal(linked.json.fundraiser.progress.postedCashCents,10001);
 const protectedChange=await f.request('/records/gifts/'+f.gift.id,{method:'PATCH',body:{version:1,pledge:'Changed historical finance label',correctionReason:'Not allowed until the internal attribution is released'}});assert.equal(protectedChange.status,409,protectedChange.text);assert.deepEqual(f.row('gifts',f.gift.id),before);
 const reordered=await f.request('/records/gifts/'+f.gift.id,{method:'PATCH',body:{version:1,allocations:[...before.allocations].reverse()}});assert.equal(reordered.status,200,reordered.text);
 const fiscal=await f.request('/gifts/'+f.gift.id+'/school-year',{method:'POST',body:{version:2,schoolYear:'2025–2026',reason:'Reviewed fiscal grouping, same actual receipt'}});assert.equal(fiscal.status,200,fiscal.text);
 const detail=await f.request('/peer-fundraisers/'+peer.id);assert.equal(detail.status,200,detail.text);assert.equal(detail.json.fundraiser.progress.postedCashCents,10001);assert.equal(detail.json.fundraiser.progress.sourceChangedCount,1);assert.equal(detail.json.attributions[0].currentSource.sourceCurrent,false);assert.equal(f.row('gifts',f.gift.id).constituentId,f.donor.id);assert.equal(f.row('gifts',f.gift.id).softCreditId,f.soft.id);assert.equal(f.db.prepare('SELECT count(*) n FROM gift_financial_corrections').get().n,0);
});

test('retiring releases the active capacity and permits a distinct new effort while immutable original rows and histories remain',async t=>{
 const f=await fixture(t),peer=await f.setup(),at=new Date().toISOString();const insert=f.db.prepare('INSERT INTO peer_fundraisers VALUES(?,?,?,?,?)');
 // Capacity is a native count across all efforts, not a page-size or lifetime count.
 for(let i=0;i<99;i++)insert.run(randomUUID(),1,JSON.stringify({campaignId:f.campaign.id,constituentId:'synthetic-capacity-'+i,coordinatorId:f.sourceBody.coordinatorId,title:'Synthetic existing capacity '+i,goalCents:0,visibility:'Workspace',status:'Active'}),at,at);
 const blocked=await f.request('/peer-fundraisers',{method:'POST',body:f.sourceBody});assert.equal(blocked.status,409,blocked.text);assert.equal(f.db.prepare('SELECT count(*) n FROM peer_fundraisers').get().n,100);
 const retired=await f.request('/peer-fundraisers/'+peer.id+'/retire',{method:'POST',body:{version:1,reason:'Release unused active capacity while retaining provenance'}});assert.equal(retired.status,200,retired.text);assert.equal(retired.json.fundraiser.status,'Retired');
 const replacement=await f.setup({title:'Explicit new effort'});assert.notEqual(replacement.id,peer.id);assert.equal(f.db.prepare('SELECT count(*) n FROM peer_fundraisers').get().n,101);assert.equal(f.db.prepare("SELECT count(*) n FROM peer_fundraisers WHERE json_extract(data,'$.status')='Active'").get().n,100);
 assert.equal((await f.request('/peer-fundraisers/'+peer.id+'/retire',{method:'POST',body:{version:2,reason:'Terminal retirement cannot be replayed'}})).status,409);assert.throws(()=>f.db.prepare('DELETE FROM peer_fundraisers WHERE id=?').run(peer.id),/retained/);assert.throws(()=>f.db.prepare('UPDATE peer_fundraiser_versions SET reason=? WHERE fundraiser_id=?').run('Rewrite',peer.id),/immutable/);
});

test('retained original soft-credit identity remains protected after unlink and native gift reclassification',async t=>{
 const f=await fixture(t),peer=await f.setup(),linked=await f.attribute(peer);assert.equal(linked.status,201,linked.text);const a=linked.json.attribution;
 const unlinked=await f.request('/peer-fundraisers/'+peer.id+'/attributions/'+a.id+'/unlink',{method:'POST',body:{version:2,attributionVersion:1,giftVersion:1,reason:'Release referral before reviewed recognition correction'}});assert.equal(unlinked.status,200,unlinked.text);
 const corrected=await f.request('/records/gifts/'+f.gift.id,{method:'PATCH',body:{version:1,softCreditId:null,correctionReason:'Remove current recognition while retaining original recorded identity'}});assert.equal(corrected.status,200,corrected.text);
 assert.equal(f.app.locals.peerFundraising.hasConstituentReferences(f.soft.id),true);assert.equal((await f.request('/records/constituents/'+f.soft.id,{method:'DELETE',body:{version:1}})).status,409);assert.equal((await f.request('/identity/merge/preview',{method:'POST',body:{sourceId:f.soft.id,targetId:f.donor.id,sourceVersion:1,targetVersion:1,reason:'Original recognition custody cannot silently disappear'}})).status,409);
 const detail=await f.request('/peer-fundraisers/'+peer.id);assert.equal(detail.status,200,detail.text);assert.equal(detail.json.fundraiser.progress.postedCashCents,0);assert.equal(detail.json.fundraiser.progress.unlinkedCount,1);const original=JSON.parse(f.db.prepare('SELECT source_json FROM peer_gift_attributions WHERE id=?').get(a.id).source_json);assert.equal(original.softCreditId,f.soft.id);assert.equal(original.constituentId,f.donor.id);assert.equal(original.amount,10001);
});

test('a failed reasoned retirement leaves active status, exact version, history and capacity unchanged',async t=>{
 const f=await fixture(t),peer=await f.setup(),snapshot=()=>Object.fromEntries(['peer_fundraisers','peer_fundraiser_versions','peer_gift_attributions','peer_gift_attribution_history'].map(table=>[table,f.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),before=snapshot();
 f.db.exec("CREATE TRIGGER synthetic_peer_retire_audit_fault BEFORE INSERT ON audit WHEN NEW.action='retire_peer_fundraiser' BEGIN SELECT RAISE(ABORT,'synthetic retirement persistence failure'); END;");
 const failed=await f.request('/peer-fundraisers/'+peer.id+'/retire',{method:'POST',body:{version:1,reason:'Meaningful retirement cannot succeed without persisted audit'}});assert.equal(failed.status,500,failed.text);assert.deepEqual(snapshot(),before);
 f.db.exec('DROP TRIGGER synthetic_peer_retire_audit_fault');const fresh=await f.request('/peer-fundraisers/'+peer.id);assert.equal(fresh.json.fundraiser.version,1);assert.equal(fresh.json.fundraiser.status,'Active');assert.equal(fresh.json.revisionCount,1);
});
