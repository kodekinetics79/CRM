import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {normalizeName,normalizeEmail,normalizePhone,normalizeAddress,normalizeNameOrder} from '../server/dataQuality.js';

const ADMIN={name:'Data quality administrator',email:'dq.admin@example.test',password:'DataQualityAdmin!2026'};
const STAFF={name:'Data quality staff',email:'dq.staff@example.test',password:'DataQualityStaff!2026'};
const VIEWER={name:'Data quality viewer',email:'dq.viewer@example.test',password:'DataQualityViewer!2026'};
const ok=(r,expected=200)=>{assert.equal(r.status,expected,r.text);return r.json;};

// One workspace built from explicit records, so every cent, date and candidate
// asserted below is one this test wrote. Nothing is seeded or inferred.
async function fixture(t,{ai={mode:'local'},build=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-data-quality-'));
 let app,server,base,tenantActive=true;
 async function open(){
  app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:false,mfaKey:'',initialAdmin:ADMIN,isTenantActive:()=>tenantActive,reminderWorker:false,workflowWorker:false,extensions:{dataQuality:{ai}}});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 }
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{}
  return {status:response.status,json,text};
 }
 async function login(account){
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:account.email,password:account.password})});
  assert.equal(response.status,200,'login '+account.email);
  return {...await response.json(),cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')};
 }
 let admin=await login(ADMIN);
 for(const account of [STAFF,VIEWER])if(!(await request('/users',{session:admin})).json.users.some(user=>user.email===account.email))
  ok(await request('/users',{method:'POST',session:admin,body:{name:account.name,email:account.email,password:account.password,role:account===STAFF?'staff':'viewer'}}),201);
 let staff=await login(STAFF),viewer=await login(VIEWER);
 const f={
  request,login,dir,
  get admin(){return admin;},get staff(){return staff;},get viewer(){return viewer;},get db(){return app.locals.db;},
  suspend(){tenantActive=false;},resume(){tenantActive=true;},
  async restart(){await close();await open();admin=await login(ADMIN);staff=await login(STAFF);viewer=await login(VIEWER);},
  create:(collection,body,session)=>request('/records/'+collection,{method:'POST',session:session||admin,body}),
  patch:(collection,record,changes,session)=>request('/records/'+collection+'/'+record.id,{method:'PATCH',session:session||admin,body:{version:record.version,...changes}}),
  quality:(path='',session)=>request('/data-quality'+path,{session:session||admin}),
  narrative:(body,session)=>request('/data-quality/narrative',{method:'POST',session:session||admin,body}),
  review:(body,session)=>request('/data-quality/reviews',{method:'POST',session:session||admin,body}),
  records(collection){return app.locals.db.prepare("SELECT data FROM records WHERE collection=? ORDER BY id").all(collection).map(row=>JSON.parse(row.data));},
  audits(){return app.locals.db.prepare('SELECT actor,action,collection,record_id,details FROM audit ORDER BY id').all();}
 };
 if(build)Object.assign(f,await populate(f));
 return f;
}

async function populate(f){
 const fund=ok(await f.create('designations',{name:'Classroom fund',school:'Canyon View',accountCode:'101-4200',description:'Synthetic designation'}),201).record;
 const person=async(patch)=>ok(await f.create('constituents',{name:'Unnamed',email:'',phone:'',type:'Individual',household:'',segments:'',preference:'Email',notes:'',contacts:[],additionalTypes:[],parentId:null,...patch}),201).record;
 const people={
  janeA:await person({name:'Jane Doe',email:'Jane.Doe+news@Example.test',household:'Doe household'}),
  janeB:await person({name:'Jane  Doe',email:'jane.doe@example.test',household:'Doe household'}),
  mariaA:await person({name:'Dr. María Núñez',phone:'(555) 010-2030',household:'Nunez household'}),
  mariaB:await person({name:'Maria Nunez',phone:'+1 555 010 2030',household:'Nunez household'}),
  foundation:await person({name:'Núñez Family Foundation, Inc.',type:'Foundation',phone:'555.010.2030'}),
  spouseA:await person({name:'Alex Rivera',email:'alex.rivera@example.test',household:'Rivera household'}),
  spouseB:await person({name:'Sam Rivera',email:'sam.rivera@example.test',household:'Rivera household'}),
  chrisA:await person({name:'Chris Stone',email:'chris.stone@example.test'}),
  chrisB:await person({name:'Chris Stone',email:'chris.stone+old@example.test'}),
  quiet:await person({name:'Quiet Donor',email:'quiet.donor@example.test',preference:'Do not contact'})
 };
 const gift=async(constituentId,amount,date,patch={})=>ok(await f.create('gifts',{constituentId,amount,type:'Cash',method:'Check',date,allocations:[{designationId:fund.id,amount}],...patch}),201).record;
 const gifts={
  jane:await gift(people.janeA.id,12500,'2026-03-01'),
  maria:await gift(people.mariaA.id,789,'2026-04-15'),
  voided:await gift(people.spouseA.id,99900,'2026-05-01'),
  fee:await gift(people.spouseB.id,1500,'2026-05-02',{type:'Fee payment',method:'Cash'}),
  outside:await gift(people.janeB.id,4444,'2025-01-05'),
  acknowledged:await gift(people.chrisA.id,2500,'2026-02-02')
 };
 ok(await f.request('/gifts/'+gifts.voided.id+'/void',{method:'POST',session:f.admin,body:{version:gifts.voided.version,reason:'Synthetic void for retained-history evidence'}}));
 ok(await f.request('/gifts/'+gifts.acknowledged.id+'/acknowledge',{method:'POST',session:f.admin,body:{version:gifts.acknowledged.version,date:'2026-02-03',channel:'Post',notes:'Synthetic staff-completed acknowledgment'}}));
 const grant=ok(await f.create('grants',{name:'Community literacy grant',funderId:people.foundation.id,amount:1500000,awardedAmount:0,awardDate:null,stage:'Preparing',deadline:'2026-05-20',reportDue:null,notes:''}),201).record;
 const pledge=ok(await f.create('pledges',{name:'Doe annual pledge',constituentId:people.janeA.id,amount:120000,startDate:'2026-01-15',installments:12,frequency:'Monthly',designationId:fund.id,campaignId:null,status:'Active',notes:''}),201).record;
 return {fund,people,gifts,grant,pledge};
}

test('normalisation is deterministic and explainable', ()=>{
 assert.equal(normalizeName('Dr. María  Núñez',true),'maria nunez');
 assert.equal(normalizeName('Maria Nunez',true),'maria nunez');
 assert.equal(normalizeName('Núñez Family Foundation, Inc.',false),'nunez family foundation');
 assert.equal(normalizeNameOrder('Nunez, Maria',true),'maria nunez');
 assert.equal(normalizeEmail('Jane.Doe+news@Example.test'),'jane.doe@example.test');
 assert.equal(normalizeEmail('jane.doe@example.test'),'jane.doe@example.test');
 assert.equal(normalizeEmail('not-an-address'),'');
 assert.equal(normalizePhone('(555) 010-2030'),'5550102030');
 assert.equal(normalizePhone('+1 555 010 2030'),'5550102030');
 assert.equal(normalizePhone('555-0102'),'');
 assert.equal(normalizeAddress('12 N. Maple St. #3'),'12 north maple street apartment 3');
 assert.equal(normalizeAddress('12 North Maple Street Apartment 3'),'12 north maple street apartment 3');
});

test('data quality review is role scoped, CSRF protected, tenant scoped and refused while suspended',async t=>{
 const f=await fixture(t);
 const paths=['','/duplicates','/stewardship','/followups','/quality','/reviews'];
 for(const path of paths)assert.equal((await f.request('/data-quality'+path)).status,401,'anonymous '+path);
 for(const path of paths)assert.equal((await f.request('/data-quality'+path,{session:f.viewer})).status,403,'viewer '+path);
 for(const path of paths)for(const session of [f.admin,f.staff])assert.equal((await f.request('/data-quality'+path,{session})).status,200,'allowed '+path);
 assert.equal((await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'},f.viewer)).status,403);
 assert.equal((await f.request('/data-quality/narrative',{method:'POST',session:f.admin,csrf:false,body:{kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'}})).status,403);
 assert.equal((await f.request('/data-quality/reviews',{method:'POST',session:f.admin,csrf:false,body:{kind:'duplicate',findingKey:'x',sourceDigest:'a'.repeat(64),decision:'Dismissed',reason:'no'}})).status,403);
 assert.equal((await f.quality('?unexpected=1')).status,400);
 f.suspend();
 for(const path of paths)assert.equal((await f.request('/data-quality'+path,{session:f.admin})).status,403,'suspended '+path);
 assert.equal((await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'})).status,403);
 f.resume();
 assert.equal((await f.quality()).status,200);
});

test('a second workspace never sees the first workspace records or findings',async t=>{
 const a=await fixture(t),b=await fixture(t,{build:false});
 const mine=ok(await a.quality('/duplicates')).candidates;
 assert.ok(mine.length>0);
 const theirs=ok(await b.quality('/duplicates'));
 assert.equal(theirs.matched,0);
 assert.equal(theirs.scanned,0);
 assert.equal(ok(await b.quality('/stewardship')).matched,0);
 assert.equal(ok(await b.quality('/followups')).matched,0);
 const ids=new Set(Object.values(a.people).map(person=>person.id));
 const body=JSON.stringify([await b.quality(''),await b.quality('/duplicates'),await b.quality('/stewardship'),await b.quality('/followups'),await b.quality('/quality')]);
 for(const id of ids)assert.equal(body.includes(id),false,'tenant leak for '+id);
 assert.equal(body.includes('Jane Doe'),false);
 assert.equal((await b.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'})).status,409);
});

test('duplicate detection proposes explainable candidates, never merges, and blocks what cannot merge',async t=>{
 const f=await fixture(t);
 const result=ok(await f.quality('/duplicates?limit=200'));
 const key=(a,b)=>[a.id,b.id].sort().join('|');
 const find=k=>result.candidates.find(candidate=>candidate.key===k);

 // Normalised email plus normalised name across two saved records.
 const jane=find(key(f.people.janeA,f.people.janeB));
 assert.ok(jane,'expected the normalised-email candidate');
 assert.equal(jane.blocked,false);
 assert.equal(jane.confidence,'Strong');
 assert.deepEqual(jane.signals.map(signal=>signal.type).sort(),['email','household-label','name']);
 assert.equal(jane.signals.find(signal=>signal.type==='email').normalized,'jane.doe@example.test');
 assert.equal(jane.nextAction.requiresHuman,true);
 assert.equal(jane.nextAction.performedByWimblo,false);
 assert.equal(jane.nextAction.performed,false);
 assert.ok(jane.sources.some(source=>source.collection==='constituents'&&source.id===f.people.janeA.id&&source.version===f.people.janeA.version));

 // Normalised phone plus diacritic-folded name.
 const maria=find(key(f.people.mariaA,f.people.mariaB));
 assert.ok(maria,'expected the normalised-phone candidate');
 assert.equal(maria.blocked,false);
 assert.ok(maria.signals.some(signal=>signal.type==='phone'&&signal.normalized==='5550102030'));

 // A person and an organization share a phone number: proposed for review, and
 // permanently blocked from ever becoming one physical identity.
 const cross=find(key(f.people.mariaA,f.people.foundation));
 assert.ok(cross,'expected the cross-family candidate');
 assert.equal(cross.blocked,true);
 assert.match(cross.blockers.map(blocker=>blocker.reason).join(' '),/person and an organization can never become one physical identity/);
 assert.match(cross.nextAction.label,/cannot be merged/);

 // Two people who share a household are not one identity.
 assert.equal(find(key(f.people.spouseA,f.people.spouseB)),undefined,'a shared household alone must never propose a merge');

 // Retained protected history blocks the proposal instead of hiding it.
 const chris=find(key(f.people.chrisA,f.people.chrisB));
 assert.ok(chris,'expected the protected-history candidate');
 assert.equal(chris.blocked,true);
 assert.match(chris.blockers.map(blocker=>blocker.reason).join(' '),/acknowledged gift keeps this identity/);
 assert.ok(chris.sources.some(source=>source.collection==='gifts'));

 // A detection is not a merge: no record moved and no merge was audited.
 const before=f.records('constituents').map(record=>record.id+':'+record.version).sort();
 ok(await f.quality('/duplicates'));ok(await f.quality('/stewardship'));ok(await f.quality('/followups'));ok(await f.quality('/quality'));ok(await f.quality(''));
 assert.deepEqual(f.records('constituents').map(record=>record.id+':'+record.version).sort(),before);
 assert.equal(f.records('constituents').some(record=>record.mergedInto),false);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n,0);
 assert.equal(f.audits().some(row=>['merge_identity','merge_rewire','create','update'].includes(row.action)&&row.action.startsWith('merge')),false);
});

test('stewardship and follow-up suggestions cite exact records, restate saved money and propose only human next steps',async t=>{
 const f=await fixture(t);
 const stewardship=ok(await f.quality('/stewardship'));
 assert.equal(stewardship.cached,false);
 const gap=stewardship.findings.find(finding=>finding.key==='acknowledgment:'+f.gifts.jane.id);
 assert.ok(gap,'expected the unacknowledged posted gift');
 assert.equal(gap.amountCents,12500);
 assert.ok(gap.sources.some(source=>source.collection==='gifts'&&source.id===f.gifts.jane.id&&source.version===1));
 assert.equal(gap.nextAction.performedByWimblo,false);
 assert.equal(stewardship.findings.some(finding=>finding.key==='acknowledgment:'+f.gifts.acknowledged.id),false,'an acknowledged gift is not a gap');
 assert.equal(stewardship.findings.some(finding=>finding.key==='acknowledgment:'+f.gifts.voided.id),false,'a voided gift is not posted revenue');
 assert.equal(stewardship.findings.some(finding=>finding.key==='acknowledgment:'+f.gifts.fee.id),false,'a fee payment is not posted revenue');

 const followups=ok(await f.quality('/followups'));
 assert.match(followups.scope,/Community grants only/);
 const grant=followups.findings.find(finding=>finding.key==='grant-deadline:'+f.grant.id);
 assert.ok(grant);
 assert.equal(grant.deadline,'2026-05-20');
 assert.equal(grant.requestedCents,1500000);
 assert.equal(grant.stage,'Preparing');
 const pledge=followups.findings.find(finding=>finding.key==='pledge:'+f.pledge.id);
 assert.ok(pledge);
 assert.equal(pledge.committedCents,120000);
 assert.equal(pledge.receivedCents,0);
 assert.equal(pledge.balanceCents,120000);
 assert.equal(pledge.schedule.installmentCents,10000);
 assert.equal(pledge.schedule.startDate,'2026-01-15');
 assert.equal(pledge.schedule.nextScheduledDate,'2026-01-15');
 assert.deepEqual(pledge.schedule.derivedFrom,['pledges.startDate','pledges.frequency','pledges.installments','pledges.amount','gifts.pledgeId','gifts.amount']);
 for(const finding of [...stewardship.findings,...followups.findings])assert.equal(finding.nextAction.requiresHuman,true);

 // A posted fulfilment gift changes the recorded balance; nothing is predicted.
 ok(await f.create('gifts',{constituentId:f.people.janeA.id,amount:10000,type:'Cash',method:'Check',date:'2026-01-15',pledgeId:f.pledge.id,giftKind:'Pledge fulfillment',allocations:[{designationId:f.fund.id,amount:10000}]}),201);
 const updated=ok(await f.quality('/followups')).findings.find(finding=>finding.key==='pledge:'+f.pledge.id);
 assert.equal(updated.receivedCents,10000);
 assert.equal(updated.balanceCents,110000);
 assert.equal(updated.schedule.installmentsCovered,1);
 assert.equal(updated.schedule.nextScheduledDate,'2026-02-15');
});

test('a review decision is recorded, withdrawn when its sources move, retained across restart and never acts',async t=>{
 const f=await fixture(t);
 const candidate=ok(await f.quality('/duplicates?limit=200')).candidates.find(item=>item.key===[f.people.janeA.id,f.people.janeB.id].sort().join('|'));
 assert.ok(candidate);
 assert.equal((await f.review({kind:'duplicate',findingKey:candidate.key,sourceDigest:'0'.repeat(64),decision:'Dismissed',reason:'Wrong digest'})).status,409);
 assert.equal((await f.review({kind:'duplicate',findingKey:'duplicate:missing',sourceDigest:candidate.digest,decision:'Dismissed',reason:'Unknown finding'})).status,409);
 assert.equal((await f.review({kind:'duplicate',findingKey:candidate.key,sourceDigest:candidate.digest,decision:'Merge these records',reason:'Not a supported decision'})).status,400);
 assert.equal((await f.review({kind:'duplicate',findingKey:candidate.key,sourceDigest:candidate.digest,decision:'Dismissed',reason:'ok',action:'merge'})).status,400);
 assert.equal((await f.review({kind:'duplicate',findingKey:candidate.key,sourceDigest:candidate.digest,decision:'Dismissed',reason:'ok'},f.viewer)).status,403);

 const saved=ok(await f.review({kind:'duplicate',findingKey:candidate.key,sourceDigest:candidate.digest,decision:'Accepted for review',reason:'Assigned to the identity reviewer'}),201);
 assert.equal(saved.performed,'none');
 assert.equal(saved.review.performed,'none');
 assert.match(saved.note,/No constituent was merged/);
 assert.equal(f.records('constituents').some(record=>record.mergedInto),false);

 const shown=ok(await f.quality('/duplicates?limit=200')).candidates.find(item=>item.key===candidate.key);
 assert.equal(shown.review.decision,'Accepted for review');
 assert.equal(shown.review.current,true);

 // The cited record moves: the decision is retained but no longer current, and a
 // stale digest can no longer be used to decide.
 ok(await f.patch('constituents',f.people.janeB,{name:'Jane Doe',email:'jane.doe@example.test',phone:'',type:'Individual',household:'Doe household',segments:'reviewed',preference:'Email',notes:'',contacts:[],additionalTypes:[],parentId:null}));
 const after=ok(await f.quality('/duplicates?limit=200')).candidates.find(item=>item.key===candidate.key);
 assert.notEqual(after.digest,candidate.digest);
 assert.equal(after.review.decision,'Accepted for review');
 assert.equal(after.review.current,false,'a decision taken on older sources is not shown as current');
 assert.equal((await f.review({kind:'duplicate',findingKey:candidate.key,sourceDigest:candidate.digest,decision:'Dismissed',reason:'Stale digest'})).status,409);

 // Retained and immutable.
 assert.throws(()=>f.db.prepare('DELETE FROM data_quality_reviews').run(),/retained/i);
 assert.throws(()=>f.db.prepare("UPDATE data_quality_reviews SET decision='Dismissed'").run(),/immutable/i);
 const audited=f.audits().filter(row=>row.action==='data_quality_review');
 assert.equal(audited.length,1);
 assert.equal(JSON.parse(audited[0].details).performed,'none');

 await f.restart();
 const history=ok(await f.quality('/reviews?kind=duplicate')).reviews;
 assert.equal(history.length,1);
 assert.equal(history[0].decision,'Accepted for review');
 assert.equal(history[0].performed,'none');
 assert.equal(f.records('constituents').some(record=>record.mergedInto),false);
});

test('report narratives state exact integer cents from cited records and are withdrawn rather than shown stale',async t=>{
 const f=await fixture(t);
 const first=ok(await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'}));
 assert.equal(first.provider,'local-deterministic');
 assert.equal(first.network,false);
 assert.equal(first.hosted,false);
 assert.equal(first.generated,false);
 assert.equal(first.reviewRequired,true);
 assert.equal(first.performed,'none');
 // 12500 + 789 + 2500; the voided gift, the fee payment and the 2025 gift are excluded.
 assert.match(first.text,/Posted monetary gifts recorded in this period: 3, totalling \$157\.89 in exact recorded cents\./);
 assert.equal(first.figures.find(figure=>figure.key==='posted-cents').cents,15789);
 assert.equal(first.figures.find(figure=>figure.key==='posted-count').count,3);
 assert.equal(first.text.includes('99900'),false);
 assert.equal(first.text.includes('999.00'),false);
 for(const source of first.sources)assert.ok(Number.isInteger(source.version)&&source.version>=1);
 assert.ok(first.sources.some(source=>source.id===f.gifts.jane.id));
 assert.equal(first.sources.some(source=>source.id===f.gifts.voided.id),false);
 assert.equal(first.sources.some(source=>source.id===f.gifts.fee.id),false);
 assert.equal(first.sources.some(source=>source.id===f.gifts.outside.id),false);

 const designation=ok(await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30',designationId:f.fund.id}));
 assert.match(designation.text,/Classroom fund — posted allocations recorded in this period: 3, totalling \$157\.89\./);

 const grants=ok(await f.narrative({kind:'grant-pipeline',from:'2026-01-01',to:'2026-06-30'}));
 assert.match(grants.text,/Community grants with a saved deadline in this period: 1, with \$15,000\.00 recorded as the requested total\./);
 const pledges=ok(await f.narrative({kind:'pledge-balances',from:'2026-01-01',to:'2026-06-30'}));
 assert.match(pledges.text,/Recorded commitments total \$1,200\.00, posted fulfilment gifts total \$0\.00, and the recorded outstanding balance is \$1,200\.00\./);

 // A cited record moves: the same request with the earlier digest is withdrawn.
 ok(await f.request('/gifts/'+f.gifts.maria.id+'/void',{method:'POST',session:f.admin,body:{version:1,reason:'Synthetic correction after the narrative was read'}}));
 const stale=await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30',expectedDigest:first.sourceDigest});
 assert.equal(stale.status,409,stale.text);
 assert.match(stale.json.error,/withdrawn/i);
 const fresh=ok(await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'}));
 assert.match(fresh.text,/Posted monetary gifts recorded in this period: 2, totalling \$150\.00 in exact recorded cents\./);

 // An empty period cites nothing, so nothing is narrated rather than estimated.
 const empty=await f.narrative({kind:'giving-summary',from:'2019-01-01',to:'2019-12-31'});
 assert.equal(empty.status,409);
 assert.match(empty.json.error,/nothing to cite/);
 assert.equal((await f.narrative({kind:'giving-summary',from:'2026-06-30',to:'2026-01-01'})).status,400);
 assert.equal((await f.narrative({kind:'donor-total',from:'2026-01-01',to:'2026-06-30'})).status,400);

 const audited=f.audits().filter(row=>row.action==='data_quality_narrative');
 assert.ok(audited.length>=4);
 for(const row of audited){const details=JSON.parse(row.details);assert.equal(details.network,false);assert.equal(details.hosted,false);assert.equal(details.performed,'none');}
 assert.equal(JSON.stringify(audited).includes('$157.89'),false,'narrative text is not copied into the audit trail');
});

test('a narrative is refused rather than approximated when a saved figure cannot be verified',async t=>{
 const f=await fixture(t);
 ok(await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'}));
 const row=f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(f.gifts.jane.id);
 const corrupted=JSON.parse(row.data);corrupted.amount=125.5;
 f.db.prepare("UPDATE records SET data=? WHERE collection='gifts' AND id=?").run(JSON.stringify(corrupted),f.gifts.jane.id);
 const refused=await f.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'});
 assert.equal(refused.status,503,refused.text);
 assert.match(refused.json.error,/refused rather than approximated/);
 assert.equal(refused.json.text,undefined);
});

test('the assistance provider is off unless the workspace configures the local mode, and deterministic findings survive without it',async t=>{
 const off=await fixture(t,{ai:{}});
 const overview=ok(await off.quality(''));
 assert.equal(overview.provider.mode,'off');
 assert.equal(overview.provider.available,false);
 assert.equal(overview.provider.hosted,false);
 assert.equal(overview.provider.network,false);
 assert.equal(overview.assistance.available,false);
 const refused=await off.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'});
 assert.equal(refused.status,503);
 assert.match(refused.json.error,/off for this workspace/i);
 // The rule-based findings do not depend on the provider at all.
 assert.ok(ok(await off.quality('/duplicates')).matched>0);
 assert.ok(ok(await off.quality('/followups')).matched>0);

 const hosted=await fixture(t,{ai:{mode:'ollama'},build:false});
 const describe=ok(await hosted.quality('')).provider;
 assert.equal(describe.mode,'off');
 assert.equal(describe.requestedMode,'ollama');
 assert.equal(describe.supported,false);
 assert.match(describe.reason,/hosted or unrecognised provider is never contacted/);
 assert.equal((await hosted.narrative({kind:'giving-summary',from:'2026-01-01',to:'2026-06-30'})).status,503);
});
