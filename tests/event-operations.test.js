import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-event-operations-')),dbPath=join(dir,'business.sqlite');let app,server,base;
 async function open(){app=createApp({dbPath,seed:true});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session)headers.Cookie=session.cookie;if(session&&csrf)headers['X-CSRF-Token']=session.csrfToken;const r=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json()};}
 async function login(email){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 const admin=await login('alex@foundation.example'),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function create(collection,body){const r=await request('/records/'+collection,{method:'POST',session:admin,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const first=await create('constituents',{name:'Ticket attendee one',type:'Individual'}),second=await create('constituents',{name:'Ticket attendee two',type:'Individual'}),unregistered=await create('constituents',{name:'Unregistered buyer',type:'Individual'}),sponsor=await create('constituents',{name:'Community event sponsor',type:'Business'});
 const createdEvent=await create('events',{name:'Offline community benefit',date:'2026-10-01',location:'Synthetic hall',capacity:4,ticketPrice:10001,sponsorGoal:50000});
 for(const c of [first,second])assert.equal((await request(`/events/${createdEvent.id}/register`,{method:'POST',session:admin,body:{constituentId:c.id}})).status,200);
 async function workspace(){const r=await request('/workspace',{session:admin});assert.equal(r.status,200);return r.json.data;}
 async function event(){return (await workspace()).events.find(e=>e.id===createdEvent.id);}
 async function state(asOf){const r=await request('/event-operations?eventId='+createdEvent.id+(asOf?'&asOf='+asOf:''),{session:admin});assert.equal(r.status,200,JSON.stringify(r.json));return r.json;}
 async function native(path,body,options={}){return request('/event-operations'+path,{method:'POST',session:staff,body:path==='/payments'?{giftVersion:1,...body}:body,...options});}
 async function table(seats=2,name='Community table'){const r=await native(`/events/${createdEvent.id}/seating`,{eventVersion:(await event()).version,name,seats});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.seating;}
 async function ticket(c=first){const r=await native(`/events/${createdEvent.id}/tickets`,{eventVersion:(await event()).version,constituentId:c.id});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.ticket;}
 async function agreement(amount=50000){const r=await native('/sponsorships',{eventId:createdEvent.id,eventVersion:(await event()).version,sponsorId:sponsor.id,name:'Community sponsorship',amount,benefits:[{name:'Event recognition',completed:false}]});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.sponsorship;}
 async function item(){const r=await native('/auction-items',{eventId:createdEvent.id,eventVersion:(await event()).version,name:'Classroom artwork',startingBid:10001,minIncrement:500,description:'Synthetic donated item'});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.item;}
 async function gift(c,amount,type='Cash',changes={}){const fund=(await workspace()).designations[0];return create('gifts',{constituentId:c.id,amount,type,method:'Check',date:'2026-09-01',allocations:[{designationId:fund.id,amount}],...changes});}
 return {request,native,create,admin,staff,viewer,first,second,unregistered,sponsor,event,state,workspace,table,ticket,agreement,item,gift,get db(){return app.locals.db;},restart:async()=>{await close();await open();}};
}

test('event operations require authentication, writable role, CSRF, bounded exact inputs and current event version',async t=>{
 const f=await fixture(t),e=await f.event(),path=`/event-operations/events/${e.id}/seating`,body={eventVersion:e.version,name:'Role controlled table',seats:2};
 assert.equal((await f.request('/event-operations')).status,401);assert.equal((await f.request(path,{method:'POST',body})).status,401);assert.equal((await f.request(path,{method:'POST',session:f.viewer,body})).status,403);assert.equal((await f.request(path,{method:'POST',session:f.admin,csrf:false,body})).status,403);assert.equal((await f.request(path,{method:'POST',session:f.admin,body:{...body,eventVersion:1}})).status,409);
 for(const changes of [{seats:1.5},{seats:0},{name:' '},{extra:true}])assert.equal((await f.request(path,{method:'POST',session:f.admin,body:{...body,...changes}})).status,400);
 assert.equal((await f.state()).seating.length,0);assert.equal((await f.request('/event-operations?eventId='+e.id,{session:f.viewer})).status,200);
});

test('seating inventory enforces total capacity and assignments are registered, unique and versioned',async t=>{
 const f=await fixture(t),table=await f.table(),e=await f.event();
 assert.equal((await f.native(`/events/${e.id}/seating`,{eventVersion:e.version,name:'Excess table',seats:3})).status,409);
 assert.equal((await f.native(`/events/${e.id}/seating`,{eventVersion:e.version,name:table.name,seats:1})).status,409);
 const body={tableVersion:table.version,eventVersion:e.version,constituentId:f.first.id,seatNumber:1};
 assert.equal((await f.native(`/seating/${table.id}/assign`,{...body,constituentId:f.unregistered.id})).status,409);assert.equal((await f.native(`/seating/${table.id}/assign`,{...body,seatNumber:3})).status,400);
 const assigned=await f.native(`/seating/${table.id}/assign`,body);assert.equal(assigned.status,201);assert.equal(assigned.json.assignment.seatNumber,1);
 assert.equal((await f.native(`/seating/${table.id}/assign`,{...body,constituentId:f.second.id,seatNumber:2})).status,409);
 const current=(await f.state()).seating[0];const requests=await Promise.all([1,2].map(()=>f.native(`/seating/${table.id}/assign`,{tableVersion:current.version,eventVersion:e.version,constituentId:f.second.id,seatNumber:2})));assert.deepEqual(requests.map(r=>r.status).sort(),[201,409]);
 assert.equal((await f.state()).seatAssignments.filter(r=>r.status==='Assigned').length,2);
 assert.equal((await f.request(`/event-operations/seating/${table.id}`,{method:'PATCH',session:f.admin,body:{version:3,name:'Changed table',seats:2}})).status,409);
 assert.equal((await f.request(`/records/events/${e.id}`,{method:'PATCH',session:f.admin,body:{version:e.version,capacity:1}})).status,409);
});

test('seat cancellation retains reason/history, permits safe reassignment and keeps inventory locked',async t=>{
 const f=await fixture(t),table=await f.table(),e=await f.event();
 const r=await f.native(`/seating/${table.id}/assign`,{tableVersion:1,eventVersion:e.version,constituentId:f.first.id,seatNumber:1});assert.equal(r.status,201);const a=r.json.assignment;
 assert.equal((await f.native(`/seat-assignments/${a.id}/cancel`,{version:1,reason:''})).status,400);
 const cancelled=await f.native(`/seat-assignments/${a.id}/cancel`,{version:1,reason:'Attendee seating changed'});assert.equal(cancelled.status,200);assert.equal(cancelled.json.assignment.status,'Cancelled');assert.equal(cancelled.json.assignment.cancelReason,'Attendee seating changed');
 const version=(await f.state()).seating[0].version;assert.equal((await f.native(`/seating/${table.id}/assign`,{tableVersion:version,eventVersion:e.version,constituentId:f.second.id,seatNumber:1})).status,201);
 assert.equal((await f.state()).seatAssignments.length,2);
 assert.equal((await f.request(`/event-operations/seating/${table.id}`,{method:'PATCH',session:f.admin,body:{version:version+1,name:'Alter history',seats:1}})).status,409);
});

test('ticket issue is unique; cancellations retain issue history and cannot bypass check-in controls',async t=>{
 const f=await fixture(t),e=await f.event(),body={eventVersion:e.version,constituentId:f.first.id};
 assert.equal((await f.native(`/events/${e.id}/tickets`,{...body,constituentId:f.unregistered.id})).status,409);
 const responses=await Promise.all([1,2].map(()=>f.native(`/events/${e.id}/tickets`,body)));assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);const issued=responses.find(r=>r.status===201).json.ticket;assert.equal(issued.price,10001);
 assert.equal((await f.request(`/records/events/${e.id}`,{method:'PATCH',session:f.admin,body:{version:e.version,ticketPrice:20000}})).status,409);
 const cancelled=await f.native(`/tickets/${issued.id}/cancel`,{version:1,reason:'Attendee ticket reissued'});assert.equal(cancelled.status,200);assert.equal(cancelled.json.ticket.checkedIn,false);
 assert.equal((await f.request(`/events/${e.id}/checkin`,{method:'POST',session:f.admin,body:{constituentId:f.first.id}})).status,409);
 const replacement=await f.ticket(),checked=await f.native(`/tickets/${replacement.id}/checkin`,{version:1,eventVersion:e.version});assert.equal(checked.status,200);assert.ok(checked.json.ticket.checkedInAt);assert.equal(checked.json.ticket.checkedIn,true);assert.equal((await f.event()).registrations.find(r=>r.constituentId===f.first.id).checkedIn,true);
 assert.equal((await f.native(`/tickets/${replacement.id}/cancel`,{version:2,reason:'Cannot erase attendance'})).status,409);assert.equal((await f.native(`/tickets/${replacement.id}/checkin`,{version:2,eventVersion:e.version+1})).status,409);
 const history=(await f.state()).tickets;assert.equal(history.length,2);assert.equal(history.find(t=>t.id===issued.id).checkedIn,false);assert.equal(history.find(t=>t.id===issued.id).cancelReason,'Attendee ticket reissued');
});

test('sponsorship agreements are commitments; only actual matching receipts reduce balances and benefits remain versioned',async t=>{
 const f=await fixture(t),before=await f.workspace(),a=await f.agreement();assert.equal(a.received,0);assert.equal(a.balance,50000);assert.equal((await f.request(`/records/constituents/${f.sponsor.id}`,{method:'PATCH',session:f.admin,body:{version:1,type:'Individual'}})).status,409);assert.deepEqual((await f.workspace()).gifts,before.gifts);
 const good=await f.gift(f.sponsor,20001,'Sponsorship'),wrong=await f.gift(f.first,10001,'Sponsorship');
 const body={ownerType:'sponsorship',ownerId:a.id,version:1,giftId:good.id,revenueCase:'Sponsorship'};
 assert.equal((await f.native('/payments',{...body,giftId:wrong.id})).status,400);assert.equal((await f.native('/payments',{...body,revenueCase:'Cash'})).status,400);
 const paid=await f.native('/payments',body);assert.equal(paid.status,201);assert.equal(paid.json.record.received,20001);assert.equal(paid.json.record.balance,29999);
 assert.equal((await f.request(`/event-operations/sponsorships/${a.id}`,{method:'PATCH',session:f.admin,body:{version:2,amount:20001}})).status,409);
 const benefit=await f.request(`/event-operations/sponsorships/${a.id}`,{method:'PATCH',session:f.staff,body:{version:2,benefits:[{name:'Event recognition',completed:true}]}});assert.equal(benefit.status,200);assert.equal(benefit.json.sponsorship.benefits[0].completed,true);
 assert.equal((await f.request(`/event-operations/sponsorships/${a.id}`,{method:'PATCH',session:f.staff,body:{version:2,name:'Stale edit'}})).status,409);
 const excess=await f.gift(f.sponsor,30000,'Sponsorship');assert.equal((await f.native('/payments',{...body,version:3,giftId:excess.id})).status,409);
});

test('a gift cannot be counted across event commitments and linked financial identity is protected',async t=>{
 const f=await fixture(t),a=await f.agreement(),b=await f.agreement(),g=await f.gift(f.sponsor,10001,'Sponsorship'),body={ownerType:'sponsorship',ownerId:a.id,version:1,giftId:g.id,revenueCase:'Sponsorship'};
 assert.equal((await f.native('/payments',{...body,giftVersion:99})).status,409);assert.equal((await f.native('/payments',body)).status,201);assert.equal((await f.native('/payments',{...body,ownerId:b.id})).status,409);
 for(const changes of [{amount:12000,allocations:[{designationId:g.allocations[0].designationId,amount:12000}]},{constituentId:f.first.id},{type:'Cash'},{giftKind:'Planned gift'},{pledgeId:'other-commitment'}])assert.equal((await f.request(`/records/gifts/${g.id}`,{method:'PATCH',session:f.admin,body:{version:1,...changes}})).status,409);
 assert.equal((await f.request(`/records/gifts/${g.id}`,{method:'PATCH',session:f.admin,body:{version:1,notes:'Financial facts preserved'}})).status,200);
 assert.throws(()=>f.db.prepare('DELETE FROM event_payment_links WHERE gift_id=?').run(g.id),/retained/);assert.throws(()=>f.db.prepare('UPDATE event_payment_links SET revenue_case=? WHERE gift_id=?').run('Cash',g.id),/immutable/);
});

test('future receipt links are not received as of today; void releases balance and retains replacement trail',async t=>{
 const f=await fixture(t),a=await f.agreement(),future=await f.gift(f.sponsor,15000,'Sponsorship',{date:'2099-01-01'});
 const body={ownerType:'sponsorship',ownerId:a.id,version:1,giftId:future.id,revenueCase:'Sponsorship'};const attached=await f.native('/payments',body);assert.equal(attached.status,201);assert.equal(attached.json.record.received,0);assert.equal(attached.json.record.balance,50000);assert.equal(attached.json.record.payments[0].futureDated,true);
 assert.equal((await f.request(`/gifts/${future.id}/void`,{method:'POST',session:f.admin,body:{version:1,reason:'Incorrect future record'}})).status,200);
 const replacement=await f.gift(f.sponsor,50000,'Sponsorship');const paid=await f.native('/payments',{...body,version:2,giftId:replacement.id});assert.equal(paid.status,201);assert.equal(paid.json.record.received,50000);assert.equal(paid.json.record.payments.length,2);assert.equal(paid.json.record.payments.find(p=>p.giftId===future.id).status,'Voided');
 const historical=(await f.state('2026-08-31')).sponsorships[0];assert.equal(historical.received,0);assert.equal(historical.balance,50000);
});

test('auction bids use integer cents, increasing minimums and immutable history with confirmed current winner',async t=>{
 const f=await fixture(t),item=await f.item(),before=await f.workspace();
 for(const amount of [10000,10001.5])assert.equal((await f.native(`/auction-items/${item.id}/bids`,{version:1,bidderId:f.first.id,amount})).status,400);
 const first=await f.native(`/auction-items/${item.id}/bids`,{version:1,bidderId:f.first.id,amount:10001});assert.equal(first.status,201);assert.equal(first.json.item.version,2);
 assert.equal((await f.native(`/auction-items/${item.id}/bids`,{version:2,bidderId:f.second.id,amount:10500})).status,400);assert.equal((await f.native(`/auction-items/${item.id}/bids`,{version:1,bidderId:f.second.id,amount:10501})).status,409);
 const next=await f.native(`/auction-items/${item.id}/bids`,{version:2,bidderId:f.second.id,amount:10501});assert.equal(next.status,201);const winning=next.json.item.bids[0];
 assert.equal((await f.native(`/auction-items/${item.id}/close`,{version:3,winningBidId:first.json.item.bids[0].id,confirmed:true})).status,409);assert.equal((await f.native(`/auction-items/${item.id}/close`,{version:3,winningBidId:winning.id,confirmed:false})).status,400);
 const closed=await f.native(`/auction-items/${item.id}/close`,{version:3,winningBidId:winning.id,confirmed:true});assert.equal(closed.status,200);assert.equal(closed.json.item.winner.bidderId,f.second.id);assert.equal(closed.json.item.balance,10501);assert.equal(closed.json.item.received,0);assert.deepEqual((await f.workspace()).gifts,before.gifts);
 assert.equal((await f.native(`/auction-items/${item.id}/bids`,{version:4,bidderId:f.first.id,amount:11001})).status,409);assert.throws(()=>f.db.prepare('UPDATE event_auction_bids SET amount=1 WHERE id=?').run(winning.id),/immutable/);
});

test('auction manual payment requires matching winner, exact recorded amount and explicit actual revenue case',async t=>{
 const f=await fixture(t),item=await f.item();const bid=await f.native(`/auction-items/${item.id}/bids`,{version:1,bidderId:f.first.id,amount:10001});assert.equal(bid.status,201);assert.equal((await f.native(`/auction-items/${item.id}/close`,{version:2,winningBidId:bid.json.item.bids[0].id,confirmed:true})).status,200);
 const wrong=await f.gift(f.second,10001,'Fee payment'),small=await f.gift(f.first,10000,'Fee payment'),correct=await f.gift(f.first,10001,'Fee payment'),body={ownerType:'auction',ownerId:item.id,version:3,giftId:correct.id,revenueCase:'Fee payment'};
 assert.equal((await f.native('/payments',{...body,giftId:wrong.id})).status,400);assert.equal((await f.native('/payments',{...body,giftId:small.id})).status,409);assert.equal((await f.native('/payments',{...body,revenueCase:'Cash'})).status,400);
 const paid=await f.native('/payments',body);assert.equal(paid.status,201);assert.equal(paid.json.record.received,10001);assert.equal(paid.json.record.balance,0);assert.equal(paid.json.record.payments[0].revenueCase,'Fee payment');
 assert.equal((await f.request(`/gifts/${correct.id}/void`,{method:'POST',session:f.admin,body:{version:1,reason:'Manual payment reversed'}})).status,200);assert.equal((await f.state()).auctionItems[0].balance,10001);
});

test('event operational references block source deletion/merge and retained tables survive restart',async t=>{
 const f=await fixture(t),ticket=await f.ticket(),agreement=await f.agreement(),g=await f.gift(f.sponsor,10001,'Sponsorship');assert.equal((await f.native('/payments',{ownerType:'sponsorship',ownerId:agreement.id,version:1,giftId:g.id,revenueCase:'Sponsorship'})).status,201);
 const e=await f.event();for(const [collection,key,v] of [['constituents',f.first.id,1],['constituents',f.sponsor.id,1],['events',e.id,e.version],['gifts',g.id,1]])assert.equal((await f.request(`/records/${collection}/${key}`,{method:'DELETE',session:f.admin,body:{version:v}})).status,409);
 assert.equal((await f.request(`/event-operations/tickets/${ticket.id}`,{method:'DELETE',session:f.admin})).status,403);
 const pair={targetId:f.second.id,sourceId:f.first.id,targetVersion:1,sourceVersion:1,reason:'Operational identity history must remain retained'},p=await f.request('/identity/merge/preview',{method:'POST',session:f.admin,body:pair});assert.equal(p.status,409);assert.match(p.json.error,/event|ticket|sponsorship|auction/i);
 const before=await f.state(),records=await f.workspace();await f.restart();assert.deepEqual(await f.state(),before);assert.deepEqual(await f.workspace(),records);
});

test('ticket payments link one actual exact receipt, prevent paid cancellation and retain void reversal',async t=>{
 const f=await fixture(t),ticket=await f.ticket(),small=await f.gift(f.first,10000,'Fee payment'),correct=await f.gift(f.first,10001,'Fee payment'),body={ownerType:'ticket',ownerId:ticket.id,version:1,giftId:correct.id,revenueCase:'Fee payment'};
 const before=await f.workspace();assert.equal((await f.native('/payments',{...body,giftId:small.id})).status,409);
 const paid=await f.native('/payments',body);assert.equal(paid.status,201);assert.equal(paid.json.record.received,10001);assert.equal(paid.json.record.balance,0);assert.deepEqual((await f.workspace()).gifts,before.gifts);
 assert.equal((await f.native(`/tickets/${ticket.id}/cancel`,{version:2,reason:'Unreconciled payment'})).status,409);
 assert.equal((await f.request(`/gifts/${correct.id}/void`,{method:'POST',session:f.admin,body:{version:1,reason:'Manual ticket payment reversed'}})).status,200);
 const cancelled=await f.native(`/tickets/${ticket.id}/cancel`,{version:2,reason:'Payment voided, attendee cancelled'});assert.equal(cancelled.status,200);assert.equal(cancelled.json.ticket.balance,0);assert.equal(cancelled.json.ticket.payments.length,1);assert.equal(cancelled.json.ticket.payments[0].status,'Voided');
});

test('event payments cannot simultaneously fulfill pledges or non-one-time fundraising cases',async t=>{
 const f=await fixture(t),ticket=await f.ticket();
 const pledge=await f.create('pledges',{name:'Another financial commitment',constituentId:f.first.id,amount:10001,startDate:'2026-09-01',installments:1,frequency:'Monthly'}),linked=await f.gift(f.first,10001,'Cash',{pledgeId:pledge.id}),recurring=await f.gift(f.first,10001,'Cash',{giftKind:'Recurring'}),planned=await f.gift(f.first,10001,'Cash',{giftKind:'Planned gift'});
 for(const g of [linked,recurring,planned])assert.equal((await f.native('/payments',{ownerType:'ticket',ownerId:ticket.id,version:1,giftId:g.id,revenueCase:'Cash'})).status,409);
 assert.equal((await f.state()).tickets[0].payments.length,0);assert.equal((await f.state()).tickets[0].received,0);
});

const encodedId=key=>'%'+key.charCodeAt(0).toString(16).toUpperCase()+key.slice(1);

test('percent-encoded IDs cannot bypass linked payment, sponsor, inventory or retained deletion guards',async t=>{
 const f=await fixture(t),ticket=await f.ticket(),g=await f.gift(f.first,10001,'Cash'),table=await f.table(4),a=await f.agreement(),e=await f.event();
 assert.equal((await f.native('/payments',{ownerType:'ticket',ownerId:ticket.id,version:1,giftId:g.id,revenueCase:'Cash'})).status,201);
 const pledge=await f.create('pledges',{name:'Independent pledge',constituentId:f.first.id,amount:10001,startDate:'2026-09-01',installments:1,frequency:'Monthly'});
 const before=await f.workspace();
 for(const changes of [{pledgeId:pledge.id},{giftKind:'Planned gift'},{grantId:'another-grant'},{constituentId:f.second.id},{type:'Fee payment'},{amount:12000,allocations:[{designationId:g.allocations[0].designationId,amount:12000}]}]){
  for(const path of [`/records/gifts/${encodedId(g.id)}`,`/records/gifts/${encodedId(g.id)}/`,`/Records/Gifts/${encodedId(g.id)}`]){const r=await f.request(path,{method:'PATCH',session:f.admin,body:{version:1,...changes}});assert.equal(r.status,path.startsWith('/Records/')?404:409,JSON.stringify(r.json));}
 }
 assert.deepEqual((await f.workspace()).gifts,before.gifts);assert.equal((await f.state()).tickets[0].received,10001);
 assert.equal((await f.request(`/records/events/${encodedId(e.id)}`,{method:'PATCH',session:f.admin,body:{version:e.version,capacity:2}})).status,409);
 assert.equal((await f.request(`/records/events/${encodedId(e.id)}`,{method:'PATCH',session:f.admin,body:{version:e.version,ticketPrice:20001}})).status,409);
 assert.equal((await f.request(`/records/constituents/${encodedId(f.sponsor.id)}`,{method:'PATCH',session:f.admin,body:{version:1,type:'Individual'}})).status,409);
 for(const [collection,key,v] of [['gifts',g.id,1],['events',e.id,e.version],['constituents',f.sponsor.id,1]])assert.equal((await f.request(`/records/${collection}/${encodedId(key)}`,{method:'DELETE',session:f.admin,body:{version:v}})).status,409);
 const safe=await f.request(`/records/gifts/${encodedId(g.id)}`,{method:'PATCH',session:f.admin,body:{version:1,notes:'Encoded route preserves safe edits'}});assert.equal(safe.status,200);assert.equal(safe.json.record.id,g.id);assert.equal(safe.json.record.pledgeId,null);
 assert.equal((await f.state()).sponsorships.find(r=>r.id===a.id).sponsorId,f.sponsor.id);assert.equal((await f.state()).seating.find(r=>r.id===table.id).seats,4);
});

test('decoded event registration/check-in contexts retain active tickets and seats and reject malformed encoding',async t=>{
 const f=await fixture(t),ticket=await f.ticket(),table=await f.table(),e=await f.event();
 const assigned=await f.native(`/seating/${table.id}/assign`,{tableVersion:1,eventVersion:e.version,constituentId:f.second.id,seatNumber:1});assert.equal(assigned.status,201);
 assert.equal((await f.request(`/events/${encodedId(e.id)}/checkin`,{method:'POST',session:f.admin,body:{constituentId:f.first.id}})).status,409);
 for(const c of [f.first,f.second])assert.equal((await f.request(`/events/${encodedId(e.id)}/register/${encodedId(c.id)}`,{method:'DELETE',session:f.admin})).status,409);
 assert.equal((await f.request(`/events/${encodedId(e.id)}/checkin`,{method:'POST',session:f.admin,body:{}})).status,400);
 assert.equal((await f.request('/records/events/%ZZ',{method:'PATCH',session:f.admin,body:{version:e.version,capacity:1}})).status,400);
 const checked=await f.native(`/tickets/${encodedId(ticket.id)}/checkin`,{version:1,eventVersion:e.version});assert.equal(checked.status,200);assert.equal(checked.json.ticket.checkedIn,true);
 assert.equal((await f.request(`/events/${encodedId(e.id)}/register/${encodedId(f.first.id)}`,{method:'DELETE',session:f.admin})).status,409);
 const cancelled=await f.native(`/seat-assignments/${encodedId(assigned.json.assignment.id)}/cancel`,{version:1,reason:'Attendee has cancelled; release seat before registration'});assert.equal(cancelled.status,200);
 assert.equal((await f.request(`/events/${encodedId(e.id)}/register/${encodedId(f.second.id)}`,{method:'DELETE',session:f.admin})).status,200);
 assert.equal((await f.event()).registrations.length,1);assert.equal((await f.state()).seatAssignments[0].status,'Cancelled');assert.equal((await f.state()).tickets[0].checkedIn,true);
});
