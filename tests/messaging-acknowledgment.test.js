import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {createTestOnlyMessagingTransport} from '../server/messaging.js';

const TENANT='99999999-9999-4999-8999-999999999999';
const ackTemplate={name:'Reviewed acknowledgment',kind:'Acknowledgment',subject:'Thank you {{recipientName}}',body:'{{organizationName}} thanks {{recipientName}} for {{giftType}} on {{giftDate}}. Monetary: {{monetaryAmount}}. Noncash: {{noncashValue}}. Ref {{giftReference}}.'};

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-messaging-ack-'));
 let app,server,base,time=Date.parse('2026-09-14T12:00:00.000Z');
 const transport=createTestOnlyMessagingTransport();
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',tenantId:TENANT,extensions:{messaging:{clock:()=>time,mode:'TEST_ONLY',channels:['Email'],fromAddress:'receipts@foundation.example',webhookSecret:'synthetic-messaging-callback-secret-key-0001',authorization:{approved:true,reference:'Synthetic TEST_ONLY authorization',reviewedAt:'2026-09-13T00:00:00.000Z'},rateLimitPerMinute:60,maxRecipients:50,transport}}});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrfToken;}const r=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json()};}
 async function login(email='alex@foundation.example'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 const admin=await login(),staff=await login('staff@foundation.example');
 async function create(path,body,session=staff){const r=await request(path,{method:'POST',session,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json;}
 const fund=(await create('/records/designations',{name:'Acknowledgment fund',accountCode:'ACK-4100'})).record;
 async function person(name){return (await create('/records/constituents',{name,type:'Individual',email:name.toLowerCase().replace(/[^a-z]/g,'')+'@example.test',preference:'Email'})).record;}
 async function gift(constituentId,amount=10001){return (await create('/records/gifts',{constituentId,amount,type:'Cash',method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount}]})).record;}
 async function consent(p,purpose='Transactional'){return request('/messaging/consent',{method:'POST',session:staff,body:{constituentId:p.id,constituentVersion:p.version,channel:'Email',purpose,state:'Granted',basis:'Synthetic recorded consent evidence',confirmed:true}});}
 return {request,admin,staff,create,fund,person,gift,consent,transport,advance:ms=>{time+=ms;},
  giftRow:key=>app.locals.db.prepare("SELECT data FROM records WHERE collection='gifts' AND id=?").get(key).data,
  get db(){return app.locals.db;}};
}
async function finalizedAcknowledgment(f,gifts){
 const template=(await f.create('/correspondence/templates',ackTemplate)).template;
 const prepared=(await f.create('/correspondence/prepare',{templateId:template.id,templateVersion:template.version,channel:'Email draft',giftIds:gifts.map(g=>g.id)})).correspondence;
 const final=await f.request('/correspondence/'+prepared.id+'/finalize',{method:'POST',session:f.staff,body:{version:1,preparationDigest:prepared.preparationDigest,confirmed:true}});
 assert.equal(final.status,200,JSON.stringify(final.json));
 return {template,prepared};
}
async function ackCampaign(f,prepared,{name='Reviewed acknowledgment send'}={}){
 return f.request('/messaging/campaigns',{method:'POST',session:f.staff,body:{name,classification:'Acknowledgment',channel:'Email',preparationId:prepared.id,preparationDigest:prepared.preparationDigest,reason:'Reviewed finalized acknowledgment',confirmed:true}});
}

test('only a finalized acknowledgment with its exact digest can become a messaging source',async t=>{
 const f=await fixture(t),donor=await f.person('Ack Donor'),g=await f.gift(donor.id);
 const template=(await f.create('/correspondence/templates',ackTemplate)).template;
 const prepared=(await f.create('/correspondence/prepare',{templateId:template.id,templateVersion:template.version,channel:'Email draft',giftIds:[g.id]})).correspondence;
 const unfinalized=await ackCampaign(f,prepared);
 assert.equal(unfinalized.status,409,JSON.stringify(unfinalized.json));
 assert.match(unfinalized.json.error,/finalized/i);
 assert.equal((await f.request('/correspondence/'+prepared.id+'/finalize',{method:'POST',session:f.staff,body:{version:1,preparationDigest:prepared.preparationDigest,confirmed:true}})).status,200);
 assert.equal((await ackCampaign(f,{...prepared,preparationDigest:'0'.repeat(64)})).status,409);
 for(const body of [{classification:'Marketing'},{channel:'SMS'}]){
  const r=await f.request('/messaging/campaigns',{method:'POST',session:f.staff,body:{name:'Wrong shape',classification:'Acknowledgment',channel:'Email',preparationId:prepared.id,preparationDigest:prepared.preparationDigest,reason:'Wrong shape',confirmed:true,...body}});
  assert.equal(r.status,400,JSON.stringify(r.json));
 }
 assert.equal((await ackCampaign(f,prepared)).status,201);
 assert.equal(f.transport.sent.length,0);
});

test('acknowledgment email reaches only explicitly selected consented recipients and leaves the Not sent ledger intact',async t=>{
 const f=await fixture(t),selected=await f.person('Selected Donor'),skipped=await f.person('Unselected Donor');
 const first=await f.gift(selected.id,10001),second=await f.gift(skipped.id,25000);
 const {prepared}=await finalizedAcknowledgment(f,[first,second]);
 assert.equal(prepared.items.length,2);
 assert.equal((await f.consent(selected)).status,201);
 const campaign=(await ackCampaign(f,prepared)).json.campaign;
 const unconsented=await f.request('/messaging/campaigns/'+campaign.id+'/review',{method:'POST',session:f.staff,body:{version:campaign.version,constituentIds:[selected.id,skipped.id],reason:'Both donors',confirmed:true}});
 assert.equal(unconsented.status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_recipients').get().n,0);
 const reviewed=await f.request('/messaging/campaigns/'+campaign.id+'/review',{method:'POST',session:f.staff,body:{version:campaign.version,constituentIds:[selected.id],reason:'Only the explicitly selected consented donor',confirmed:true}});
 assert.equal(reviewed.status,200,JSON.stringify(reviewed.json));
 assert.equal(reviewed.json.campaign.recipientCount,1);
 const giftsBefore=[first,second].map(g=>f.giftRow(g.id)),communicationsBefore=f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='communications'").get().n;
 const executed=await f.request('/messaging/campaigns/'+campaign.id+'/execute',{method:'POST',session:f.admin,body:{version:reviewed.json.campaign.version,snapshotDigest:reviewed.json.campaign.snapshotDigest,idempotencyKey:globalThis.crypto.randomUUID(),reason:'Reviewed acknowledgment execution',confirmed:true}});
 assert.equal(executed.status,200,JSON.stringify(executed.json));
 assert.equal(executed.json.sent,1);
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.transport.sent[0].to,selected.email);
 assert.match(f.transport.sent[0].body,/\$100\.01/);
 assert.doesNotMatch(JSON.stringify(f.transport.sent),new RegExp(skipped.email));
 // Finalization and a transport handoff are not the acknowledgment ledger.
 assert.deepEqual([first,second].map(g=>f.giftRow(g.id)),giftsBefore);
 assert.equal(JSON.parse(f.giftRow(first.id)).acknowledgment,undefined);
 const retained=(await f.request('/correspondence/'+prepared.id,{session:f.staff})).json.correspondence;
 assert.equal(retained.delivery,'Not sent');
 assert.deepEqual(retained.fulfillments,[]);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='communications'").get().n,communicationsBefore);
 assert.match(executed.json.delivery,/No provider transmission/);
});

test('a gift changed after finalization refuses the acknowledgment send instead of using stale wording',async t=>{
 const f=await fixture(t),donor=await f.person('Changing Donor'),g=await f.gift(donor.id);
 const {prepared}=await finalizedAcknowledgment(f,[g]);
 assert.equal((await f.consent(donor)).status,201);
 const campaign=(await ackCampaign(f,prepared)).json.campaign;
 const reviewed=await f.request('/messaging/campaigns/'+campaign.id+'/review',{method:'POST',session:f.staff,body:{version:campaign.version,constituentIds:[donor.id],reason:'Reviewed exact wording',confirmed:true}});
 assert.equal(reviewed.status,200);
 const edit=await f.request('/records/gifts/'+g.id,{method:'PATCH',session:f.staff,body:{version:g.version,notes:'Approved business note added after finalization'}});
 assert.equal(edit.status,200);
 const refused=await f.request('/messaging/campaigns/'+campaign.id+'/execute',{method:'POST',session:f.admin,body:{version:reviewed.json.campaign.version,snapshotDigest:reviewed.json.campaign.snapshotDigest,idempotencyKey:globalThis.crypto.randomUUID(),reason:'Attempted send on stale wording',confirmed:true}});
 assert.equal(refused.status,409,JSON.stringify(refused.json));
 assert.match(refused.json.error,/Nothing was sent/);
 assert.equal(f.transport.sent.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_deliveries').get().n,0);
 assert.equal((await f.request('/messaging/campaigns/'+campaign.id,{session:f.staff})).json.campaign.status,'ReviewRequired');
});

test('campaign attribution links posted revenue once, never creates a gift and drops a voided source from reporting',async t=>{
 const f=await fixture(t),donor=await f.person('Attributing Donor'),stranger=await f.person('Other Donor');
 const template=(await f.create('/correspondence/templates',{name:'Reviewed messaging',kind:'Messaging',subject:'News {{recipientName}}',body:'Hello {{recipientName}} from {{organizationName}}.'})).template;
 const record=(await f.create('/records/campaigns',{name:'Autumn appeal',type:'Annual',goal:100000,status:'Active',startDate:'2026-07-01',endDate:'2027-06-30',description:'Synthetic appeal'})).record;
 assert.equal((await f.consent(donor,'Marketing')).status,201);
 const created=await f.request('/messaging/campaigns',{method:'POST',session:f.staff,body:{name:'Autumn appeal email',classification:'Marketing',channel:'Email',templateId:template.id,templateVersion:template.version,campaignRecordId:record.id,reason:'Reviewed appeal',confirmed:true}});
 assert.equal(created.status,201,JSON.stringify(created.json));
 const reviewed=await f.request('/messaging/campaigns/'+created.json.campaign.id+'/review',{method:'POST',session:f.staff,body:{version:1,constituentIds:[donor.id],reason:'Reviewed consented donor',confirmed:true}});
 assert.equal(reviewed.status,200,JSON.stringify(reviewed.json));
 const executed=await f.request('/messaging/campaigns/'+created.json.campaign.id+'/execute',{method:'POST',session:f.admin,body:{version:reviewed.json.campaign.version,snapshotDigest:reviewed.json.campaign.snapshotDigest,idempotencyKey:globalThis.crypto.randomUUID(),reason:'Reviewed execution',confirmed:true}});
 assert.equal(executed.status,200,JSON.stringify(executed.json));
 const campaign=executed.json.campaign,recipient=campaign.recipients[0];
 const responded=await f.gift(donor.id,25050),unrelated=await f.gift(stranger.id,7500);
 const giftsBefore=f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='gifts'").get().n,rawBefore=f.giftRow(responded.id);
 const path='/messaging/campaigns/'+campaign.id+'/attributions';
 const body=(changes={})=>({version:campaign.version,recipientId:recipient.id,giftId:responded.id,giftVersion:responded.version,reason:'Donor gave after this campaign',confirmed:true,...changes});
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:body({giftId:unrelated.id})})).status,409,'a gift from another donor cannot be attributed');
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:body({giftVersion:9})})).status,409);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,csrf:false,body:body()})).status,403);
 const linked=await f.request(path,{method:'POST',session:f.staff,body:body()});
 assert.equal(linked.status,201,JSON.stringify(linked.json));
 assert.equal(linked.json.revenueCreated,false);
 assert.equal(linked.json.attribution.attributedCents,25050);
 assert.equal((await f.request(path,{method:'POST',session:f.staff,body:body()})).status,409,'one gift never carries two messaging attributions');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='gifts'").get().n,giftsBefore);
 assert.equal(f.giftRow(responded.id),rawBefore,'attribution never edits the gift record');
 let report=(await f.request('/messaging/report',{session:f.admin})).json;
 assert.equal(report.campaigns[0].attributedGiftCount,1);
 assert.equal(report.campaigns[0].attributedCents,25050);
 assert.equal(report.campaigns[0].handedToTransport,1);
 assert.match(report.revenueStatement,/never creates, re-posts or duplicates income/);
 const voided=await f.request('/gifts/'+responded.id+'/void',{method:'POST',session:f.staff,body:{version:responded.version,reason:'Synthetic reversal'}});
 assert.equal(voided.status,200,JSON.stringify(voided.json));
 report=(await f.request('/messaging/report',{session:f.admin})).json;
 assert.equal(report.campaigns[0].attributedGiftCount,0,'voided revenue leaves the attributed total');
 assert.equal(report.campaigns[0].attributedCents,0);
 assert.equal(report.campaigns[0].staleAttributionCount,1);
 assert.throws(()=>f.db.prepare('DELETE FROM messaging_attributions').run(),/retained/i);
});
