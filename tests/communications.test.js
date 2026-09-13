import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {renderCorrespondenceText} from '../server/communications.js';

const tpl=(kind='Acknowledgment',changes={})=>({name:'Reviewed correspondence',kind,subject:'Thank you {{recipientName}}',body:kind==='Acknowledgment'?'{{organizationName}} thanks {{recipientName}} for {{giftType}} on {{giftDate}}. Monetary: {{monetaryAmount}}. Noncash: {{noncashValue}}. Ref {{giftReference}}.':kind==='Annual employee'?'{{recipientName}}: {{calendarYear}} payroll total {{annualEmployeeAmount}} across {{giftCount}} records.':'Hello {{recipientName}} at {{recipientEmail}}, from {{organizationName}}.',...changes});

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-correspondence-'));let app,server,base;
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=csrf===true?session.csrfToken:csrf;}const r=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json(),headers:r.headers};}
 async function login(email='alex@foundation.example'){const r=await request('/api/auth/login',{method:'POST',body:{email,password:'FoundationDemo!2026'}});assert.equal(r.status,200,JSON.stringify(r.json));return {...r.json,cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(path,body,session=staff){const r=await request(path,{method:'POST',body,session});assert.equal(r.status,201,JSON.stringify(r.json));return r.json;}
 async function person(name,changes={}){return (await create('/api/records/constituents',{name,type:'Individual',email:name.toLowerCase().replace(/[^a-z]/g,'')+'@example.test',preference:'Email',...changes})).record;}
 const alice=await person('Alice'),bob=await person('Bob'),fund=(await create('/api/records/designations',{name:'Correspondence fund',accountCode:'CORR-4100'})).record;
 async function gift(amount=12345,changes={}){return (await create('/api/records/gifts',{constituentId:alice.id,amount,type:'Cash',method:'Check',date:'2025-09-13',allocations:[{designationId:fund.id,amount}],...changes})).record;}
 async function template(kind='Acknowledgment',changes={}){return (await create('/api/correspondence/templates',tpl(kind,changes))).template;}
 async function prepare(t,selection,changes={}){return (await create('/api/correspondence/prepare',{templateId:t.id,templateVersion:t.version,channel:'Print',...selection,...changes})).correspondence;}
 async function finalize(c,changes={},session=staff){return request(`/api/correspondence/${c.id}/finalize`,{method:'POST',session,body:{version:1,preparationDigest:c.preparationDigest,confirmed:true,...changes}});}
 async function editPerson(p,changes){const {id,version,createdAt,updatedAt,...body}=p;const r=await request(`/api/records/constituents/${id}`,{method:'PATCH',session:staff,body:{...body,...changes,version}});assert.equal(r.status,200,JSON.stringify(r.json));return r.json.record;}
 return {request,admin,staff,viewer,alice,bob,fund,person,gift,template,prepare,finalize,editPerson,restart:async()=>{await close();await open();},get db(){return app.locals.db;}};
}

test('renderer permits only literal allowlisted placeholders and does not recursively execute substituted text',()=>{
 assert.equal(renderCorrespondenceText('Hello {{recipientName}}',{recipientName:'{{recipientEmail}} <script>literal</script>'},['recipientName']),'Hello {{recipientEmail}} <script>literal</script>');
 for(const text of ['{{recipient.email}}','{{constructor}}','{{recipientEmail}}','{{ recipientName }}','{{recipientName','{recipientName}','{{recipientName}} }'])assert.throws(()=>renderCorrespondenceText(text,{recipientName:'A'},['recipientName']),/Unsupported|listed/);
 assert.equal(renderCorrespondenceText('A {{recipientName}} / {{recipientName}}',{recipientName:'$& $`'},['recipientName']),'A $& $` / $& $`');
});

test('templates are reusable, strict, versioned and preserve immutable definition history',async t=>{
 const f=await fixture(t),r=await f.template();const update=await f.request(`/api/correspondence/templates/${r.id}`,{method:'PATCH',session:f.staff,body:{...tpl(),body:'Dear {{recipientName}}, {{monetaryAmount}}.',version:1}});assert.equal(update.status,200);assert.equal(update.json.template.version,2);
 assert.equal((await f.request(`/api/correspondence/templates/${r.id}`,{method:'PATCH',session:f.staff,body:{...tpl(),version:1}})).status,409);assert.equal((await f.request(`/api/correspondence/templates/${r.id}`,{method:'PATCH',session:f.staff,body:{...tpl('Messaging'),version:2}})).status,409);
 const read=await f.request(`/api/correspondence/templates/${r.id}`,{session:f.viewer});assert.equal(read.status,200);assert.equal(read.json.revisions.length,2);assert.equal(read.json.revisions[0].body,tpl().body);assert.equal(read.json.revisions[1].body,'Dear {{recipientName}}, {{monetaryAmount}}.');assert.throws(()=>f.db.prepare('UPDATE correspondence_template_revisions SET definition=? WHERE template_id=?').run('{}',r.id),/immutable/);
 for(const body of [tpl('Messaging',{body:'{{giftDate}}'}),tpl('Acknowledgment',{body:'{{deductibleAmount}}'}),{...tpl(),html:true},tpl('Messaging',{body:'{{recipient.password}}'})])assert.equal((await f.request('/api/correspondence/templates',{method:'POST',session:f.staff,body})).status,400);
 const catalog=await f.request('/api/correspondence/templates',{session:f.viewer});assert.equal(catalog.json.format,'Plain text');assert.deepEqual(catalog.json.mergeFields.Messaging,['recipientName','recipientEmail','organizationName']);
});

test('explicit recipient isolation omits secondary contacts and soft-credit identities and leaves acknowledgment ledger unchanged',async t=>{
 const f=await fixture(t);await f.editPerson(f.alice,{contacts:[{name:'Secret secondary',email:'secondary@example.test',role:'Contact'}]});const g=await f.gift(12345,{softCreditId:f.bob.id}),r=await f.template();const c=await f.prepare(r,{giftIds:[g.id]});
 assert.equal(c.status,'Prepared');assert.equal(c.delivery,'Not sent');assert.equal(c.items.length,1);assert.equal(c.items[0].recipient.id,f.alice.id);assert.match(c.items[0].body,/\$123\.45/);assert.doesNotMatch(JSON.stringify(c.items),/Secret secondary|secondary@example.test|Bob|bob@example.test/);assert.equal(c.items[0].references.length,2);assert.equal(c.items[0].references.find(x=>x.collection==='gifts').version,1);assert.match(c.items[0].references[0].recordDigest,/^[a-f0-9]{64}$/);
 const before=f.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get('gifts',g.id).data;const result=await f.finalize(c);assert.equal(result.status,200);assert.equal(result.json.correspondence.status,'Finalized');assert.equal(result.json.delivery,'Not sent');assert.equal(f.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get('gifts',g.id).data,before);assert.equal(JSON.parse(before).acknowledgment,undefined);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection='communications' AND json_extract(data,'$.giftId')=?").get(g.id).n,0);
 assert.equal((await f.finalize(c)).status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_finalizations').get().n,1);
});

test('selected opt-outs block entire preparation and email draft uses only primary email with explicit Email preference',async t=>{
 const f=await fixture(t),r=await f.template('Messaging'),blocked=await f.person('Blocked',{preference:'Do not contact'}),post=await f.person('Postal',{preference:'Post'}),empty=await f.person('No email',{email:''});
 for(const body of [{constituentIds:[f.alice.id,blocked.id],channel:'Print'},{constituentIds:[post.id],channel:'Email draft'},{constituentIds:[empty.id],channel:'Email draft'}]){const result=await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:r.id,templateVersion:1,...body}});assert.ok([400,403].includes(result.status));}
 assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_preparations').get().n,0);
 const c=await f.prepare(r,{constituentIds:[f.alice.id,f.bob.id]},{channel:'Email draft'});assert.equal(c.items.length,2);assert.doesNotMatch(c.items[0].body,/Bob|bob@example.test/);assert.doesNotMatch(c.items[1].body,/Alice|alice@example.test/);assert.equal(c.items[0].recipient.email,f.alice.email);
 await f.editPerson(f.bob,{preference:'Do not contact'});assert.equal((await f.finalize(c)).status,403);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_finalizations').get().n,0);
});

test('acknowledgment semantics separate noncash from monetary value; fee and void cannot become donation snapshots',async t=>{
 const f=await fixture(t),r=await f.template(),noncash=await f.gift(22222,{type:'In-kind',method:'In-kind'}),c=await f.prepare(r,{giftIds:[noncash.id]});assert.equal(c.items[0].semantics.monetaryCents,0);assert.equal(c.items[0].semantics.noncashCents,22222);assert.match(c.items[0].body,/Monetary: Not monetary support/);assert.match(c.items[0].body,/not an assessed deductible amount/);
 const fee=await f.gift(50,{type:'Fee payment'}),voided=await f.gift(100);const voidResult=await f.request(`/api/gifts/${voided.id}/void`,{method:'POST',session:f.staff,body:{version:1,reason:'Fixture reversal'}});assert.equal(voidResult.status,200);
 for(const id of [fee.id,voided.id])assert.equal((await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:r.id,templateVersion:1,channel:'Print',giftIds:[id]}})).status,409);
 assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_preparations').get().n,1);
});

test('annual employee statement sums only actual-calendar-year posted payroll giving and excludes soft-credit/fee/noncash/void cases',async t=>{
 const f=await fixture(t),employee=await f.person('Employee One',{type:'Employee'}),r=await f.template('Annual employee');const base={constituentId:employee.id,type:'Employee giving',method:'Payroll'};const a=await f.gift(10001,base),b=await f.gift(204,{...base,date:'2025-12-31'});
 await f.gift(100,{...base,date:'2026-01-01'});await f.gift(100,{...base,method:'Check'});await f.gift(100,{constituentId:employee.id,type:'Fee payment',method:'Payroll'});await f.gift(100,{constituentId:employee.id,type:'In-kind',method:'In-kind'});await f.gift(100,{softCreditId:employee.id});const reversed=await f.gift(100,base);await f.request(`/api/gifts/${reversed.id}/void`,{method:'POST',session:f.staff,body:{version:1,reason:'Payroll reversal'}});
 const c=await f.prepare(r,{constituentIds:[employee.id],year:2025});assert.equal(c.items[0].semantics.monetaryCents,10205);assert.equal(c.items[0].semantics.giftCount,2);assert.match(c.items[0].body,/2025 payroll total \$102\.05 across 2 records/);assert.deepEqual(c.items[0].references.filter(x=>x.collection==='gifts').map(x=>x.id).sort(),[a.id,b.id].sort());assert.equal((await f.finalize(c)).status,200);
 assert.equal((await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:r.id,templateVersion:1,channel:'Print',constituentIds:[f.alice.id],year:2025}})).status,400);
});

test('human finalization rejects forged digests, unreviewed snapshots, current record changes and newly added annual memberships',async t=>{
 const f=await fixture(t),r=await f.template(),g=await f.gift(),c=await f.prepare(r,{giftIds:[g.id]});assert.equal((await f.finalize(c,{confirmed:false})).status,400);assert.equal((await f.finalize(c,{preparationDigest:'0'.repeat(64)})).status,409);assert.equal((await f.finalize(c,{version:2})).status,400);
 const giftEdit=await f.request(`/api/records/gifts/${g.id}`,{method:'PATCH',session:f.staff,body:{version:1,notes:'New approved business note'}});assert.equal(giftEdit.status,200);assert.equal((await f.finalize(c)).status,409);
 const employee=await f.person('Annual review',{type:'Employee'}),annual=await f.template('Annual employee');await f.gift(10,{constituentId:employee.id,type:'Employee giving',method:'Payroll'});const prepared=await f.prepare(annual,{constituentIds:[employee.id],year:2025});await f.gift(1,{constituentId:employee.id,type:'Employee giving',method:'Payroll'});assert.equal((await f.finalize(prepared)).status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_finalizations').get().n,0);
});

test('template changes make prior preparations stale; finalized output retains its reviewed text after template and record changes',async t=>{
 const f=await fixture(t),r=await f.template('Messaging'),first=await f.prepare(r,{constituentIds:[f.alice.id]}),second=await f.prepare(r,{constituentIds:[f.bob.id]});assert.equal((await f.finalize(first)).status,200);
 const edit=await f.request(`/api/correspondence/templates/${r.id}`,{method:'PATCH',session:f.staff,body:{...tpl('Messaging',{body:'Revised {{recipientName}}'}),version:1}});assert.equal(edit.status,200);assert.equal((await f.finalize(second)).status,409);assert.equal((await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:r.id,templateVersion:1,channel:'Print',constituentIds:[f.alice.id]}})).status,409);
 await f.editPerson(f.alice,{name:'Renamed Alice'});const retained=await f.request(`/api/correspondence/${first.id}`,{session:f.viewer});assert.equal(retained.status,200);assert.equal(retained.json.correspondence.items[0].body,first.items[0].body);assert.equal(retained.json.correspondence.items[0].recipient.name,'Alice');
});

test('correspondence and template history persist, are immutable, searchable by tied records, and audit contains only metadata',async t=>{
 const f=await fixture(t),g=await f.gift(),r=await f.template('Acknowledgment',{body:'Confidential prepared wording {{recipientName}} {{monetaryAmount}}'}),c=await f.prepare(r,{giftIds:[g.id]});const done=await f.finalize(c);assert.equal(done.status,200);
 assert.throws(()=>f.db.prepare('UPDATE correspondence_preparations SET snapshot=? WHERE id=?').run('{}',c.id),/immutable/);assert.throws(()=>f.db.prepare('DELETE FROM correspondence_preparations WHERE id=?').run(c.id),/retained/);assert.throws(()=>f.db.prepare('DELETE FROM correspondence_finalizations WHERE preparation_id=?').run(c.id),/retained/);
 await f.restart();const retained=await f.request(`/api/correspondence/${c.id}`,{session:f.viewer});assert.deepEqual(retained.json.correspondence,done.json.correspondence);
 for(const query of [`q=confidential&status=Finalized`,`constituentId=${f.alice.id}`,`giftId=${g.id}`]){const read=await f.request('/api/correspondence?'+query,{session:f.viewer});assert.equal(read.status,200);assert.equal(read.json.correspondence.length,1);assert.equal(read.json.correspondence[0].id,c.id);}
 assert.equal((await f.request(`/api/correspondence?constituentId=${f.bob.id}`,{session:f.viewer})).json.correspondence.length,0);assert.equal((await f.request('/api/correspondence?unknown=true',{session:f.viewer})).status,400);
 const audits=f.db.prepare("SELECT details FROM audit WHERE action LIKE '%correspondence%'").all();assert.ok(audits.length>=3);assert.doesNotMatch(JSON.stringify(audits),/Confidential|Alice|alice@example|csrf|password|cookie/);assert.match(JSON.stringify(audits),/Not sent/);
});

test('all writes require current authentication, staff/admin and CSRF; caller cannot add recipients or delivery claims',async t=>{
 const f=await fixture(t),r=await f.template('Messaging'),body={templateId:r.id,templateVersion:1,channel:'Print',constituentIds:[f.alice.id]};
 for(const [options,status] of [[{body},401],[{body,session:f.viewer},403],[{body,session:f.staff,csrf:false},403],[{body,session:f.staff,csrf:'wrong'},403],[{body:{...body,to:'outsider@example.test'},session:f.staff},400],[{body:{...body,delivered:true},session:f.staff},400],[{body:{...body,constituentIds:[f.alice.id,f.alice.id]},session:f.staff},400],[{body:{...body,constituentIds:Array.from({length:101},(_,i)=>'id'+i)},session:f.staff},400],[{body:{...body,giftIds:['unknown']},session:f.staff},400]])assert.equal((await f.request('/api/correspondence/prepare',{method:'POST',...options})).status,status);
 assert.equal((await f.request('/api/correspondence/templates',{method:'POST',session:f.viewer,body:tpl('Messaging')})).status,403);assert.equal((await f.request(`/api/correspondence/templates/${r.id}`,{method:'PATCH',session:f.staff,csrf:false,body:{...tpl('Messaging'),version:1}})).status,403);
 const c=await f.prepare(r,{constituentIds:[f.alice.id]});assert.equal((await f.finalize(c,{},f.viewer)).status,403);assert.equal((await f.request(`/api/correspondence/${c.id}/finalize`,{method:'POST',session:f.staff,csrf:false,body:{version:1,confirmed:true,preparationDigest:c.preparationDigest}})).status,403);assert.equal((await f.finalize(c,{sent:true})).status,400);
 assert.equal((await f.request('/api/correspondence')).status,401);assert.equal((await f.request('/api/correspondence/templates')).status,401);assert.equal((await f.request(`/api/correspondence/${c.id}`)).status,401);
});

test('unexpected audit persistence failure rolls back preparation and finalization rather than retaining unaudited state',async t=>{
 const f=await fixture(t),r=await f.template('Messaging');
 f.db.exec("CREATE TRIGGER correspondence_audit_fault BEFORE INSERT ON audit WHEN NEW.action='prepare_correspondence' BEGIN SELECT RAISE(ABORT,'fixture audit fault'); END;");
 const attempt=await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:r.id,templateVersion:1,channel:'Print',constituentIds:[f.alice.id]}});assert.equal(attempt.status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_preparations').get().n,0);
 f.db.exec('DROP TRIGGER correspondence_audit_fault');const c=await f.prepare(r,{constituentIds:[f.alice.id]});
 f.db.exec("CREATE TRIGGER correspondence_audit_fault BEFORE INSERT ON audit WHEN NEW.action='finalize_correspondence' BEGIN SELECT RAISE(ABORT,'fixture audit fault'); END;");
 assert.equal((await f.finalize(c)).status,500);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_finalizations').get().n,0);assert.equal((await f.request(`/api/correspondence/${c.id}`,{session:f.viewer})).json.correspondence.status,'Prepared');f.db.exec('DROP TRIGGER correspondence_audit_fault');assert.equal((await f.finalize(c)).status,200);
});

test('a merged email source cannot bypass its surviving identity opt-out or finalize a prior draft',async t=>{
 const f=await fixture(t),template=await f.template('Messaging'),survivor=await f.person('Opted out survivor',{preference:'Do not contact'});
 const before=await f.prepare(template,{constituentIds:[f.alice.id]},{channel:'Email draft'});
 const input={sourceId:f.alice.id,targetId:survivor.id,sourceVersion:f.alice.version,targetVersion:survivor.version,reason:'Reviewed duplicate identity'};
 const preview=await f.request('/api/identity/merge/preview',{method:'POST',session:f.admin,body:input});assert.equal(preview.status,200);assert.deepEqual(preview.json.preview.blockers,[]);
 const merged=await f.request('/api/identity/merge',{method:'POST',session:f.admin,body:{...input,previewDigest:preview.json.preview.previewDigest}});assert.equal(merged.status,200);assert.equal(merged.json.target.preference,'Do not contact');assert.equal(merged.json.source.preference,'Email');
 for(const channel of ['Print','Email draft']){
  const denied=await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:template.id,templateVersion:1,channel,constituentIds:[f.alice.id]}});assert.equal(denied.status,409);assert.match(denied.json.error,/Merged identities/);
 }
 assert.equal((await f.finalize(before)).status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_finalizations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_preparations').get().n,1);
 const survivorDenied=await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:template.id,templateVersion:1,channel:'Email draft',constituentIds:[survivor.id]}});assert.equal(survivorDenied.status,403);
});

test('future support cannot be acknowledged or inflate a current-year payroll statement, including finalization rechecks',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,8,13,12)});
 const f=await fixture(t),today=new Date().toISOString().slice(0,10),year=Number(today.slice(0,4)),future=String(year)+'-12-31',ack=await f.template();
 assert.ok(today<future,'Fixture requires a future date within the current calendar year');
 const futureGift=await f.gift(90000,{date:future});const rejected=await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:ack.id,templateVersion:1,channel:'Print',giftIds:[futureGift.id]}});assert.equal(rejected.status,409);assert.match(rejected.json.error,/Future-dated/);
 const received=await f.gift(101,{date:today}),preparedAck=await f.prepare(ack,{giftIds:[received.id]});const revised=await f.request('/api/records/gifts/'+received.id,{method:'PATCH',session:f.staff,body:{version:1,date:future,correctionReason:'Correct the recorded transaction date'}});assert.equal(revised.status,200);assert.equal((await f.finalize(preparedAck)).status,409);
 const employee=await f.person('Current payroll',{type:'Employee'}),annual=await f.template('Annual employee'),base={constituentId:employee.id,type:'Employee giving',method:'Payroll'};
 const actual=await f.gift(10001,{...base,date:today});await f.gift(80000,{...base,date:future});
 const statement=await f.prepare(annual,{constituentIds:[employee.id],year});assert.equal(statement.items[0].semantics.monetaryCents,10001);assert.equal(statement.items[0].semantics.giftCount,1);assert.deepEqual(statement.items[0].references.filter(r=>r.collection==='gifts').map(r=>r.id),[actual.id]);assert.equal((await f.finalize(statement)).status,200);
 const fresh=await f.prepare(annual,{constituentIds:[employee.id],year});await f.gift(1,{...base,date:today});assert.equal((await f.finalize(fresh)).status,409);
 const futureOnly=await f.person('Future only payroll',{type:'Employee'});await f.gift(200,{constituentId:futureOnly.id,type:'Employee giving',method:'Payroll',date:future});assert.equal((await f.request('/api/correspondence/prepare',{method:'POST',session:f.staff,body:{templateId:annual.id,templateVersion:1,channel:'Print',constituentIds:[futureOnly.id],year}})).status,400);
});

const manualBody=(c,g,changes={})=>({version:g.version,date:new Date().toISOString().slice(0,10),channel:c.channel==='Print'?'Post':'Email',notes:'Synthetic staff confirmation of the actual completed action',correspondence:{preparationId:c.id,preparationDigest:c.preparationDigest,confirmed:true,reason:'Staff checked the exact reviewed wording and completed action'},...changes});

test('finalized acknowledgment manual fulfillment atomically links exact retained wording, gift source and communication without application sending, and survives restart',async t=>{
 const f=await fixture(t),g=await f.gift(),template=await f.template('Acknowledgment',{body:'Retained exact wording for {{recipientName}}: {{monetaryAmount}}'}),c=await f.prepare(template,{giftIds:[g.id]});assert.equal((await f.finalize(c)).status,200);assert.equal((await f.request(`/api/correspondence/${c.id}`,{session:f.staff})).json.correspondence.fulfillments.length,0);assert.equal(JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(g.id).data).acknowledgment,undefined);
 const revised=await f.request(`/api/correspondence/templates/${template.id}`,{method:'PATCH',session:f.staff,body:{...tpl('Acknowledgment',{body:'New future wording {{recipientName}}'}),version:template.version}});assert.equal(revised.status,200);
 const done=await f.request(`/api/gifts/${g.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c,g)});assert.equal(done.status,200,JSON.stringify(done.json));const gift=done.json.record,communication=done.json.communication,source=gift.acknowledgment.correspondence;assert.equal(gift.version,g.version+1);assert.equal(source.preparationId,c.id);assert.equal(source.preparationDigest,c.preparationDigest);assert.equal(source.finalizationDigest,c.preparationDigest);assert.equal(source.templateVersion,1);assert.equal(source.giftId,g.id);assert.equal(source.giftVersion,g.version);assert.equal(source.recipientId,f.alice.id);assert.equal(source.itemIndex,0);assert.match(source.wordingDigest,/^[a-f0-9]{64}$/);assert.deepEqual(communication.correspondence,source);assert.equal(communication.giftId,g.id);assert.equal(gift.acknowledgment.communicationId,communication.id);
 const read=(await f.request(`/api/correspondence/${c.id}`,{session:f.viewer})).json.correspondence;assert.equal(read.delivery,'Not sent');assert.equal(read.items[0].body,c.items[0].body);assert.equal(read.fulfillments.length,1);assert.equal(read.fulfillments[0].actor,f.staff.user.id);assert.equal(read.fulfillments[0].sourceGiftVersion,g.version);assert.equal(read.fulfillments[0].acknowledgmentGiftVersion,gift.version);assert.equal(read.fulfillments[0].communicationId,communication.id);assert.equal(read.fulfillments[0].source.wordingDigest,source.wordingDigest);assert.match(read.fulfillments[0].statement,/did not send, print, sign/);
 assert.throws(()=>f.db.exec("UPDATE correspondence_fulfillments SET reason='changed'"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM correspondence_fulfillments'),/retained/);const audit=f.db.prepare("SELECT details FROM audit WHERE action='fulfill_correspondence'").get();assert.doesNotMatch(audit.details,/Retained exact wording|Alice|alice@example/);assert.match(audit.details,/applicationSent/);
 assert.equal((await f.request(`/api/gifts/${g.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c,{...g,version:gift.version})})).status,409);
 await f.restart();const persisted=(await f.request(`/api/correspondence/${c.id}`,{session:f.viewer})).json.correspondence;assert.deepEqual(persisted,read);const ledger=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(g.id).data);assert.deepEqual(ledger.acknowledgment.correspondence,source);
});

test('manual correspondence confirmation requires exact finalized gift item, renewed staff authority, CSRF, valid channel/date and explicit confirmation/reason',async t=>{
 const f=await fixture(t),g=await f.gift(),other=await f.gift(777),template=await f.template(),c=await f.prepare(template,{giftIds:[g.id]});const path=`/api/gifts/${g.id}/acknowledge`,body=manualBody(c,g);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body})).status,409);assert.equal((await f.finalize(c)).status,200);
 for(const [options,status] of [[{body},401],[{body,session:f.viewer},403],[{body,session:f.staff,csrf:false},403],[{body:{...body,channel:'Email'},session:f.staff},400],[{body:{...body,date:'1900-01-01'},session:f.staff},400],[{body:{...body,date:'2999-01-01'},session:f.staff},400],[{body:{...body,date:'2026-02-30'},session:f.staff},400],[{body:{...body,correspondence:{...body.correspondence,confirmed:false}},session:f.staff},400],[{body:{...body,correspondence:{...body.correspondence,reason:' '}},session:f.staff},400],[{body:{...body,correspondence:{...body.correspondence,preparationDigest:'0'.repeat(64)}},session:f.staff},409],[{body:{...body,correspondence:{...body.correspondence,sent:true}},session:f.staff},400]])assert.equal((await f.request(path,{method:'POST',...options})).status,status);
 assert.equal((await f.request(`/api/gifts/${other.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c,other)})).status,409);
 const message=await f.template('Messaging'),msg=await f.prepare(message,{constituentIds:[f.alice.id]});assert.equal((await f.finalize(msg)).status,200);assert.equal((await f.request(path,{method:'POST',session:f.staff,body:manualBody(msg,g)})).status,409);
 assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_fulfillments').get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection='communications' AND json_extract(data,'$.giftId')=?").get(g.id).n,0);
 const email=await f.prepare(template,{giftIds:[g.id]},{channel:'Email draft'});assert.equal((await f.finalize(email)).status,200);const emailDone=await f.request(path,{method:'POST',session:f.staff,body:manualBody(email,g)});assert.equal(emailDone.status,200);assert.equal(emailDone.json.record.acknowledgment.channel,'Email');assert.equal(emailDone.json.communication.correspondence.preparedChannel,'Email draft');
});

test('current changed gift/recipient/consent, voids and separately completed gifts cannot be confirmed against stale reviewed wording',async t=>{
 const f=await fixture(t),template=await f.template();
 const changed=await f.gift(),c1=await f.prepare(template,{giftIds:[changed.id]});assert.equal((await f.finalize(c1)).status,200);const edit=await f.request(`/api/records/gifts/${changed.id}`,{method:'PATCH',session:f.staff,body:{version:changed.version,notes:'Reviewed source changed after wording'}});assert.equal(edit.status,200);assert.equal((await f.request(`/api/gifts/${changed.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c1,edit.json.record)})).status,409);
 const voided=await f.gift(),c2=await f.prepare(template,{giftIds:[voided.id]});assert.equal((await f.finalize(c2)).status,200);const reversal=await f.request(`/api/gifts/${voided.id}/void`,{method:'POST',session:f.staff,body:{version:voided.version,reason:'Synthetic reversal'}});assert.equal(reversal.status,200);assert.equal((await f.request(`/api/gifts/${voided.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c2,reversal.json.record)})).status,409);
 const recipientChanged=await f.gift(),c3=await f.prepare(template,{giftIds:[recipientChanged.id]});assert.equal((await f.finalize(c3)).status,200);let currentAlice=await f.editPerson(f.alice,{name:'Corrected Alice name'});assert.equal((await f.request(`/api/gifts/${recipientChanged.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c3,recipientChanged)})).status,409);
 const consentGift=await f.gift(),c4=await f.prepare(template,{giftIds:[consentGift.id]},{channel:'Email draft'});assert.equal((await f.finalize(c4)).status,200);currentAlice=await f.editPerson(currentAlice,{preference:'Do not contact'});assert.equal((await f.request(`/api/gifts/${consentGift.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c4,consentGift)})).status,403);
 currentAlice=await f.editPerson(currentAlice,{preference:'Email'});const completed=await f.gift(),c5=await f.prepare(template,{giftIds:[completed.id]});assert.equal((await f.finalize(c5)).status,200);const independent=await f.request(`/api/gifts/${completed.id}/acknowledge`,{method:'POST',session:f.staff,body:{version:completed.version,date:new Date().toISOString().slice(0,10),channel:'Phone',notes:'Separate actual donor conversation'}});assert.equal(independent.status,200);assert.equal((await f.request(`/api/gifts/${completed.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c5,independent.json.record)})).status,409);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_fulfillments').get().n,0);
});

test('fulfillment audit failure rolls back the acknowledgment gift, communication, immutable fulfillment and ordinary audit as one unit',async t=>{
 const f=await fixture(t),g=await f.gift(),template=await f.template(),c=await f.prepare(template,{giftIds:[g.id]});assert.equal((await f.finalize(c)).status,200);const before={gift:f.db.prepare("SELECT * FROM records WHERE collection='gifts' AND id=?").get(g.id),communications:f.db.prepare("SELECT count(*) n FROM records WHERE collection='communications'").get().n,audit:f.db.prepare('SELECT count(*) n FROM audit').get().n};f.db.exec("CREATE TRIGGER fulfillment_audit_fault BEFORE INSERT ON audit WHEN NEW.action='fulfill_correspondence' BEGIN SELECT RAISE(ABORT,'synthetic fulfillment audit fault'); END;");
 const attempt=await f.request(`/api/gifts/${g.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c,g)});assert.equal(attempt.status,500);assert.deepEqual(f.db.prepare("SELECT * FROM records WHERE collection='gifts' AND id=?").get(g.id),before.gift);assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE collection='communications'").get().n,before.communications);assert.equal(f.db.prepare('SELECT count(*) n FROM correspondence_fulfillments').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n,before.audit);f.db.exec('DROP TRIGGER fulfillment_audit_fault');assert.equal((await f.request(`/api/gifts/${g.id}/acknowledge`,{method:'POST',session:f.staff,body:manualBody(c,g)})).status,200);
});
