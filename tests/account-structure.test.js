import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

async function fixture(t,{dirName='wimblo-account-structure-'}={}){
 const dir=await mkdtemp(join(tmpdir(),dirName));let app,server,base,tenantActive=true;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',isTenantActive:()=>tenantActive,reminderWorker:false,workflowWorker:false});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return {status:r.status,json,text};}
 async function login(email='alex@foundation.example',password='FoundationDemo!2026'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 let admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 const f={
  get admin(){return admin;},get staff(){return staff;},get viewer(){return viewer;},request,login,
  get db(){return app.locals.db;},
  suspend:()=>{tenantActive=false;},resume:()=>{tenantActive=true;},
  restart:async()=>{await close();await open();admin=await login();staff=await login('staff@foundation.example');viewer=await login('board@foundation.example');},
  location:async(code,name,session)=>request('/account-structure/locations',{method:'POST',session:session||admin,body:{code,name}}),
  fn:async(code,name,session)=>request('/account-structure/functions',{method:'POST',session:session||admin,body:{code,name}}),
  pair:async(location,fun,session)=>request('/account-structure/pairs',{method:'POST',session:session||admin,body:{locationId:location.id,locationVersion:location.version,functionId:fun.id,functionVersion:fun.version}}),
  link:async(designation,pair,session,changes={})=>request('/account-structure/designations/'+designation.id+'/link',{method:'POST',session:session||admin,body:{designationVersion:designation.version,pairId:pair.id,pairVersion:pair.version,reason:'Reviewed account assignment',...changes}}),
  rollups:async(groupBy='location',session)=>request('/account-structure/rollups?groupBy='+groupBy,{session:session||admin}),
  designations:async(query='',session)=>request('/account-structure/designations'+query,{session:session||admin}),
  workspace:async session=>request('/workspace',{session:session||admin})
 };
 f.designationRecords=()=>app.locals.db.prepare("SELECT data FROM records WHERE collection='designations' ORDER BY rowid").all().map(r=>JSON.parse(r.data));
 f.gift=async(body,session)=>request('/records/gifts',{method:'POST',session:session||admin,body});
 return f;
}
const ok=(r,expected=201)=>{assert.equal(r.status,expected,r.text);return r.json;};

test('locations, functions and accounts are administrator-scoped, uniquely coded and version-checked at execution',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/account-structure')).status,401);
 for(const session of [f.staff,f.viewer])assert.equal((await f.location('101','Denied school',session)).status,403);
 assert.equal((await f.request('/account-structure/locations',{method:'POST',session:f.admin,csrf:false,body:{code:'101',name:'No token'}})).status,403);
 for(const session of [f.staff,f.viewer])assert.equal((await f.request('/account-structure',{session})).status,200);

 for(const body of [{code:'1',name:'Short'},{code:'1010',name:'Long'},{code:'10a',name:'Letters'},{code:'101',name:''},{code:'101',name:'Extra',unexpected:true}])assert.equal((await f.request('/account-structure/locations',{method:'POST',session:f.admin,body})).status,400,JSON.stringify(body));
 for(const body of [{code:'400',name:'Three digits'},{code:'40000',name:'Five digits'}])assert.equal((await f.request('/account-structure/functions',{method:'POST',session:f.admin,body})).status,400,JSON.stringify(body));

 const canyon=ok(await f.location('101','Canyon View School')).location,meadow=ok(await f.location('102','Meadow Ridge School')).location;
 assert.equal(canyon.code,'101');assert.equal(canyon.status,'Active');assert.equal(canyon.version,1);
 assert.equal((await f.location('101','Different name')).status,409);
 assert.equal((await f.location('103','canyon view school')).status,409);
 const classroom=ok(await f.fn('4200','Classroom support')).function,pantry=ok(await f.fn('4300','Student pantry')).function;
 assert.equal((await f.fn('4200','Other name')).status,409);

 assert.equal((await f.pair({...canyon,version:2},classroom)).status,409);
 assert.equal((await f.pair(canyon,{...classroom,version:9})).status,409);
 const first=ok(await f.pair(canyon,classroom)).pair;
 assert.equal(first.code,'101-4200');assert.equal(first.locationCode,'101');assert.equal(first.functionCode,'4200');assert.equal(first.open,true);
 assert.equal((await f.pair(canyon,classroom)).status,409);
 // One function serves several locations; each location/function pair is one unique account.
 const second=ok(await f.pair(meadow,classroom)).pair;assert.equal(second.code,'102-4200');
 const third=ok(await f.pair(canyon,pantry)).pair;assert.equal(third.code,'101-4300');
 assert.equal(new Set([first.id,second.id,third.id]).size,3);
 const byFunction=ok(await f.request('/account-structure/pairs?functionId='+classroom.id,{session:f.admin}),200);
 assert.equal(byFunction.matched,2);assert.deepEqual(byFunction.pairs.map(p=>p.code).sort(),['101-4200','102-4200']);

 const overview=ok(await f.request('/account-structure',{session:f.viewer}),200);
 assert.equal(overview.canManage,false);assert.equal(overview.counts.locations,2);assert.equal(overview.counts.pairs,3);
 assert.equal(ok(await f.workspace(f.admin),200).accountStructure.pairs,3);
 assert.match(overview.scope,/grants no permission and no consent/);
 assert.throws(()=>f.db.prepare('DELETE FROM account_locations WHERE id=?').run(canyon.id));
 assert.throws(()=>f.db.prepare('UPDATE account_locations SET code=? WHERE id=?').run('999',canyon.id));
 assert.throws(()=>f.db.prepare('UPDATE account_pairs SET location_id=? WHERE id=?').run(meadow.id,first.id));
});

test('one allocation counts exactly once in every rollup even when a function spans several locations',async t=>{
 const f=await fixture(t);
 const canyon=ok(await f.location('101','Canyon View School')).location,meadow=ok(await f.location('102','Meadow Ridge School')).location,district=ok(await f.location('900','District wide')).location;
 const classroom=ok(await f.fn('4200','Classroom support')).function,pantry=ok(await f.fn('4300','Student pantry')).function;
 const pairs={};
 for(const [key,location,fun] of [['canyonClassroom',canyon,classroom],['meadowClassroom',meadow,classroom],['districtClassroom',district,classroom],['canyonPantry',canyon,pantry],['districtPantry',district,pantry]])pairs[key]=ok(await f.pair(location,fun)).pair;

 const designations=f.designationRecords();
 const assignments=[['SYN-101-STEM','canyonClassroom'],['SYN-101-ART','meadowClassroom'],['SYN-200','districtPantry'],['SYN-300','canyonPantry'],['SYN-101','districtClassroom']];
 for(const [code,pairKey] of assignments){const designation=designations.find(d=>d.accountCode===code);assert.ok(designation,code);ok(await f.link(designation,pairs[pairKey]));}

 // A single gift split across two designations that sit under the SAME function in
 // TWO different locations is the double-posting trap this rollup must survive.
 const donor=f.db.prepare("SELECT data FROM records WHERE collection='constituents'").all().map(r=>JSON.parse(r.data))[0];
 const stem=designations.find(d=>d.accountCode==='SYN-101-STEM'),art=designations.find(d=>d.accountCode==='SYN-101-ART');
 const split=ok(await f.gift({constituentId:donor.id,amount:100003,type:'Cash',method:'Check',date:'2026-09-10',allocations:[{designationId:stem.id,amount:33334},{designationId:art.id,amount:66669}],externalRef:'ACCOUNT-SPLIT-1'})).record;
 assert.equal(split.status,'Posted');

 const totalsOf=r=>r.totals;
 const byLocation=ok(await f.rollups('location'),200),byFunction=ok(await f.rollups('function'),200),byPair=ok(await f.rollups('pair'),200);
 for(const r of [byLocation,byFunction,byPair]){
  assert.equal(r.reconciliation.reconciled,true,JSON.stringify(r.reconciliation));
  assert.equal(r.reconciliation.duplicatedCents,0);
  assert.equal(totalsOf(r).allocationCents,totalsOf(r).postedGiftCents);
  assert.equal(totalsOf(r).linkedCents+totalsOf(r).unlinkedCents,totalsOf(r).allocationCents);
  assert.equal(r.groups.reduce((n,g)=>n+g.cents,0),totalsOf(r).linkedCents);
 }
 // The shared function totals once across both locations, never twice.
 const classroomGroup=byFunction.groups.find(g=>g.code==='4200');
 assert.equal(classroomGroup.cents,byLocation.groups.filter(g=>['101','102','900'].includes(g.code)).length&&classroomGroup.cents);
 const locationTotals=Object.fromEntries(byLocation.groups.map(g=>[g.code,g.cents])),pairTotals=Object.fromEntries(byPair.groups.map(g=>[g.code,g.cents]));
 assert.equal(pairTotals['101-4200']+pairTotals['102-4200']+pairTotals['900-4200'],classroomGroup.cents);
 assert.equal(locationTotals['101'],pairTotals['101-4200']+pairTotals['101-4300']);
 assert.equal(classroomGroup.locationCount,3);
 assert.equal(byFunction.groups.reduce((n,g)=>n+g.cents,0),byLocation.groups.reduce((n,g)=>n+g.cents,0));
 assert.equal(byPair.groups.reduce((n,g)=>n+g.allocations,0),byLocation.groups.reduce((n,g)=>n+g.allocations,0));
 assert.equal(totalsOf(byPair).unlinkedCents,0);

 // Exact integer cents, verified independently against the posted ledger.
 const ledger=f.db.prepare("SELECT data FROM records WHERE collection='gifts'").all().map(r=>JSON.parse(r.data)).filter(g=>g.status!=='Voided');
 const expected=new Map();for(const gift of ledger)for(const a of gift.allocations)expected.set(a.designationId,(expected.get(a.designationId)||0)+a.amount);
 const expectedPairs={};for(const [code,pairKey] of assignments){const designation=designations.find(d=>d.accountCode===code);expectedPairs[pairs[pairKey].code]=(expectedPairs[pairs[pairKey].code]||0)+(expected.get(designation.id)||0);}
 assert.deepEqual(pairTotals,expectedPairs);
 assert.equal(totalsOf(byPair).postedGiftCents,ledger.reduce((n,g)=>n+g.amount,0));

 // Voiding removes revenue from every rollup exactly once, without a negative row.
 const voided=ok(await f.request('/gifts/'+split.id+'/void',{method:'POST',session:f.admin,body:{version:split.version,reason:'Synthetic correction'}}),200).record;
 assert.equal(voided.status,'Voided');
 const after=ok(await f.rollups('pair'),200);
 assert.equal(after.reconciliation.reconciled,true);
 assert.equal(totalsOf(after).allocationCents,totalsOf(byPair).allocationCents-100003);
 assert.equal(after.groups.find(g=>g.code==='101-4200').cents,pairTotals['101-4200']-33334);
 assert.equal(after.groups.find(g=>g.code==='102-4200').cents,pairTotals['102-4200']-66669);
});

test('designation linkage preserves hierarchy, account codes and allocations, and one designation cannot serve two accounts',async t=>{
 const f=await fixture(t);
 const canyon=ok(await f.location('101','Canyon View School')).location,meadow=ok(await f.location('102','Meadow Ridge School')).location;
 const classroom=ok(await f.fn('4200','Classroom support')).function;
 const canyonPair=ok(await f.pair(canyon,classroom)).pair,meadowPair=ok(await f.pair(meadow,classroom)).pair;
 const before=f.designationRecords(),stem=before.find(d=>d.accountCode==='SYN-101-STEM');
 assert.ok(stem.parentId);

 assert.equal((await f.link({...stem,version:99},canyonPair)).status,409);
 assert.equal((await f.link(stem,{...canyonPair,version:99})).status,409);
 assert.equal((await f.request('/account-structure/designations/'+stem.id+'/link',{method:'POST',session:f.admin,body:{designationVersion:1,pairId:canyonPair.id,pairVersion:1}})).status,400);
 for(const session of [f.staff,f.viewer])assert.equal((await f.link(stem,canyonPair,session)).status,403);

 const linked=ok(await f.link(stem,canyonPair)).link;
 assert.equal(linked.pair.code,'101-4200');assert.equal(linked.version,1);
 assert.equal((await f.link(stem,canyonPair)).status,409);
 // Relinking moves the designation; it never holds two accounts at once.
 const moved=ok(await f.link(stem,meadowPair)).link;assert.equal(moved.pair.code,'102-4200');assert.equal(moved.version,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_designation_links WHERE designation_id=?').get(stem.id).n,1);
 assert.deepEqual(f.designationRecords(),before,'linking must not rewrite any designation record');

 const listed=ok(await f.designations('?link=Linked'),200);
 assert.equal(listed.matched,1);assert.equal(listed.designations[0].accountCode,'SYN-101-STEM');assert.equal(listed.designations[0].account.pairCode,'102-4200');
 assert.equal(listed.designations[0].parentId,stem.parentId);assert.equal(listed.designations[0].depth,1);
 const filtered=ok(await f.designations('?locationId='+meadow.id),200);assert.equal(filtered.matched,1);
 assert.equal(ok(await f.designations('?locationId='+canyon.id),200).matched,0);
 const all=ok(await f.designations(''),200);
 assert.equal(all.total,before.length);assert.equal(all.hierarchy.cycles,0);
 assert.equal(all.hierarchy.rootSubtreeCents,ok(await f.rollups('pair'),200).totals.allocationCents,'root subtree totals must equal the whole posted ledger exactly once');
 const parent=all.designations.find(d=>d.accountCode==='SYN-101');
 assert.equal(parent.subtreeCents,parent.directCents+all.designations.filter(d=>d.parentId===parent.id).reduce((n,d)=>n+d.subtreeCents,0));

 const unlinked=ok(await f.request('/account-structure/designations/'+stem.id+'/unlink',{method:'POST',session:f.admin,body:{version:2,reason:'Account reassignment under review'}}),200);
 assert.equal(unlinked.unlinked.previousPairCode,'102-4200');
 assert.equal((await f.request('/account-structure/designations/'+stem.id+'/unlink',{method:'POST',session:f.admin,body:{version:2,reason:'Repeat'}})).status,404);
 const history=ok(await f.request('/account-structure/history?subject=designation&subjectId='+stem.id,{session:f.admin}),200);
 assert.deepEqual(history.history.map(h=>h.action),['unlink','relink','link']);
 assert.throws(()=>f.db.prepare('DELETE FROM account_structure_history WHERE subject_id=?').run(stem.id));
 assert.throws(()=>f.db.prepare('UPDATE account_structure_history SET action=? WHERE subject_id=?').run('tamper',stem.id));
 assert.equal(ok(await f.rollups('pair'),200).totals.unlinkedCents,ok(await f.rollups('pair'),200).totals.allocationCents);
});

test('retirement retains history, keeps reporting posted gifts and refuses new links without orphaning anything',async t=>{
 const f=await fixture(t);
 const canyon=ok(await f.location('101','Canyon View School')).location,classroom=ok(await f.fn('4200','Classroom support')).function;
 const pair=ok(await f.pair(canyon,classroom)).pair,designations=f.designationRecords();
 const stem=designations.find(d=>d.accountCode==='SYN-101-STEM'),art=designations.find(d=>d.accountCode==='SYN-101-ART');
 ok(await f.link(stem,pair));
 const beforeCents=ok(await f.rollups('pair'),200).groups.find(g=>g.code==='101-4200').cents;
 assert.ok(beforeCents>0);

 assert.equal((await f.request('/account-structure/locations/'+canyon.id+'/status',{method:'POST',session:f.admin,body:{version:9,status:'Retired',reason:'Closed campus'}})).status,409);
 assert.equal((await f.request('/account-structure/locations/'+canyon.id+'/status',{method:'POST',session:f.staff,body:{version:1,status:'Retired',reason:'Closed campus'}})).status,403);
 const retired=ok(await f.request('/account-structure/locations/'+canyon.id+'/status',{method:'POST',session:f.admin,body:{version:1,status:'Retired',reason:'Campus closed at the end of the school year'}}),200);
 assert.equal(retired.location.status,'Retired');assert.equal(retired.location.version,2);
 assert.equal((await f.request('/account-structure/locations/'+canyon.id+'/status',{method:'POST',session:f.admin,body:{version:2,status:'Retired',reason:'Again'}})).status,409);

 // Retired structure stops accepting new work but keeps every posted allocation.
 assert.equal((await f.link(art,pair)).status,409);
 assert.equal((await f.pair({...canyon,version:2},classroom)).status,409);
 const after=ok(await f.rollups('pair'),200);
 assert.equal(after.reconciliation.reconciled,true);
 assert.equal(after.groups.find(g=>g.code==='101-4200').cents,beforeCents);
 assert.equal(after.groups.find(g=>g.code==='101-4200').status,'Active');
 assert.equal(ok(await f.rollups('location'),200).groups.find(g=>g.code==='101').status,'Retired');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_designation_links WHERE pair_id=?').get(pair.id).n,1);
 assert.equal(ok(await f.designations('?link=Linked'),200).designations[0].account.locationStatus,'Retired');

 const retiredPair=ok(await f.request('/account-structure/pairs/'+pair.id+'/status',{method:'POST',session:f.admin,body:{version:1,status:'Retired',reason:'Account closed with the campus'}}),200);
 assert.equal(retiredPair.pair.status,'Retired');assert.equal(retiredPair.pair.linkedDesignations,1);
 assert.equal((await f.request('/account-structure/pairs/'+pair.id+'/status',{method:'POST',session:f.admin,body:{version:2,status:'Active',reason:'Reopen'}})).status,409);
 assert.equal(ok(await f.rollups('pair'),200).groups.find(g=>g.code==='101-4200').cents,beforeCents);

 const reinstated=ok(await f.request('/account-structure/locations/'+canyon.id+'/status',{method:'POST',session:f.admin,body:{version:2,status:'Active',reason:'Campus reopened for the new year'}}),200);
 assert.equal(reinstated.location.status,'Active');assert.equal(reinstated.location.version,3);
 ok(await f.request('/account-structure/pairs/'+pair.id+'/status',{method:'POST',session:f.admin,body:{version:2,status:'Active',reason:'Account reopened'}}),200);
 ok(await f.link(art,{...pair,version:3}));
 const history=ok(await f.request('/account-structure/history?subject=location&subjectId='+canyon.id,{session:f.admin}),200);
 assert.deepEqual(history.history.map(h=>h.action),['reinstate','retire','create']);
 assert.equal(history.history[1].detail.reason,'Campus closed at the end of the school year');
 assert.equal(ok(await f.rollups('pair'),200).reconciliation.reconciled,true);
});

test('suspension, deactivated accounts, tenant separation and restart persistence hold',async t=>{
 const f=await fixture(t),other=await fixture(t,{dirName:'wimblo-account-structure-other-'});
 const canyon=ok(await f.location('101','Canyon View School')).location,classroom=ok(await f.fn('4200','Classroom support')).function;
 const pair=ok(await f.pair(canyon,classroom)).pair,stem=f.designationRecords().find(d=>d.accountCode==='SYN-101-STEM');
 ok(await f.link(stem,pair));
 const expected=ok(await f.rollups('pair'),200);

 // Separate workspaces never see each other's structure.
 assert.equal(ok(await other.request('/account-structure',{session:other.admin}),200).counts.locations,0);
 ok(await other.location('101','Different workspace school'));
 assert.equal(ok(await other.request('/account-structure',{session:other.admin}),200).counts.locations,1);
 assert.equal(ok(await f.request('/account-structure',{session:f.admin}),200).counts.locations,1);
 assert.equal(ok(await f.request('/account-structure',{session:f.admin}),200).locations[0].name,'Canyon View School');

 f.suspend();
 assert.equal((await f.request('/account-structure',{session:f.admin})).status,403);
 assert.equal((await f.rollups('pair')).status,403);
 assert.equal((await f.location('103','Suspended attempt')).status,403);
 f.resume();
 assert.equal((await f.request('/account-structure',{session:f.admin})).status,200);

 // A deactivated administrator loses the surface entirely.
 f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.admin.user.id);
 assert.equal((await f.request('/account-structure',{session:f.admin})).status,401);
 assert.equal((await f.location('104','Inactive attempt')).status,401);
 f.db.prepare('UPDATE users SET active=1 WHERE id=?').run(f.admin.user.id);

 await f.restart();
 const restored=ok(await f.rollups('pair'),200);
 assert.deepEqual(restored.groups,expected.groups);
 assert.deepEqual(restored.totals,expected.totals);
 assert.equal(restored.reconciliation.reconciled,true);
 assert.equal(ok(await f.request('/account-structure',{session:f.admin}),200).counts.linkedDesignations,1);
 assert.deepEqual(ok(await f.request('/account-structure/history?subject=designation',{session:f.admin}),200).history.map(h=>h.action),['link']);
});

test('a failed link or creation leaves no partial structure and no financial change',async t=>{
 const f=await fixture(t);
 const canyon=ok(await f.location('101','Canyon View School')).location,classroom=ok(await f.fn('4200','Classroom support')).function;
 const pair=ok(await f.pair(canyon,classroom)).pair,stem=f.designationRecords().find(d=>d.accountCode==='SYN-101-STEM');
 const financial=f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all();

 f.db.exec("CREATE TRIGGER synthetic_location_fault BEFORE INSERT ON audit WHEN NEW.action='create_account_location' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
 assert.equal((await f.location('102','Fault school')).status,500);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_locations').get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM account_structure_history WHERE subject='location'").get().n,1);
 f.db.exec('DROP TRIGGER synthetic_location_fault');
 assert.equal((await f.location('102','Fault school')).status,201);

 f.db.exec("CREATE TRIGGER synthetic_link_fault BEFORE INSERT ON audit WHEN NEW.action='link_account_designation' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
 assert.equal((await f.link(stem,pair)).status,500);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_designation_links').get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM account_structure_history WHERE subject='designation'").get().n,0);
 f.db.exec('DROP TRIGGER synthetic_link_fault');

 // The execution-time recheck refuses a link whose stored source drifts mid-write.
 f.db.exec("CREATE TRIGGER synthetic_designation_drift AFTER INSERT ON audit WHEN NEW.action='link_account_designation' BEGIN UPDATE records SET data=json_set(data,'$.version',json_extract(data,'$.version')+1) WHERE collection='designations' AND id=NEW.record_id; END;");
 assert.equal((await f.link(stem,pair)).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM account_designation_links').get().n,0);
 assert.equal(JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='designations' AND id=?").get(stem.id).data).version,1);
 f.db.exec('DROP TRIGGER synthetic_designation_drift');

 assert.equal((await f.link(stem,pair)).status,201);
 assert.deepEqual(f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all(),financial);
 assert.equal(ok(await f.rollups('pair'),200).reconciliation.reconciled,true);
});

test('inconsistent hierarchy and retained links are refused rather than followed',async t=>{
 const f=await fixture(t);
 const canyon=ok(await f.location('101','Canyon View School')).location,classroom=ok(await f.fn('4200','Classroom support')).function;
 const pair=ok(await f.pair(canyon,classroom)).pair,designations=f.designationRecords();
 const parent=designations.find(d=>d.accountCode==='SYN-101'),child=designations.find(d=>d.accountCode==='SYN-101-STEM');

 // The native schema already refuses a cycle on write.
 assert.equal((await f.request('/records/designations/'+parent.id,{method:'PATCH',session:f.admin,body:{version:parent.version,parentId:child.id}})).status,400);
 // A corrupted stored ancestry must be reported and never walked.
 f.db.prepare("UPDATE records SET data=json_set(data,'$.parentId',?) WHERE collection='designations' AND id=?").run(child.id,parent.id);
 const inspected=ok(await f.designations(''),200);
 assert.equal(inspected.hierarchy.cycles>=2,true);
 assert.equal(inspected.designations.find(d=>d.id===child.id).hierarchyIssue,true);
 assert.equal(inspected.designations.find(d=>d.id===child.id).subtreeCents,null);
 assert.equal(inspected.designations.find(d=>d.id===child.id).depth,null);
 assert.equal((await f.link({...child,version:1},pair)).status,409);
 assert.equal(ok(await f.rollups('pair'),200).reconciliation.reconciled,true,'direct allocation totals stay exact despite a broken hierarchy');

 f.db.prepare("UPDATE records SET data=json_set(data,'$.parentId',json('null')) WHERE collection='designations' AND id=?").run(parent.id);
 assert.equal(ok(await f.designations(''),200).hierarchy.cycles,0);
 ok(await f.link(child,pair));

 // A linked designation cannot be deleted out from under the account structure.
 const deletion=await f.request('/records/designations/'+child.id,{method:'DELETE',session:f.admin,body:{version:1}});
 assert.equal(deletion.status,409);assert.match(deletion.json.error,/account link|Retained account structure/);
 ok(await f.request('/account-structure/designations/'+child.id+'/unlink',{method:'POST',session:f.admin,body:{version:1,reason:'Removed before review'}}),200);
 const stillProtected=await f.request('/records/designations/'+child.id,{method:'DELETE',session:f.admin,body:{version:1}});
 assert.equal(stillProtected.status,409);assert.match(stillProtected.json.error,/Retained account structure history/);
});

test('stored ledger faults are refused instead of publishing an unreconciled rollup',async t=>{
 const f=await fixture(t);
 const canyon=ok(await f.location('101','Canyon View School')).location,classroom=ok(await f.fn('4200','Classroom support')).function;
 ok(await f.pair(canyon,classroom));
 assert.equal((await f.rollups('pair')).status,200);
 const gift=f.db.prepare("SELECT id,data FROM records WHERE collection='gifts' LIMIT 1").get();
 const broken=JSON.parse(gift.data);broken.allocations=[{designationId:broken.allocations[0].designationId,amount:broken.amount-1}];
 f.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(broken),'gifts',gift.id);
 assert.equal((await f.rollups('pair')).status,503);
 assert.equal((await f.designations('')).status,503);
 broken.allocations=[{designationId:broken.allocations[0].designationId,amount:broken.amount/100}];
 f.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(broken),'gifts',gift.id);
 assert.equal((await f.rollups('pair')).status,503);
 f.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(gift.data,'gifts',gift.id);
 assert.equal((await f.rollups('pair')).status,200);
});
