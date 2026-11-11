import {randomUUID} from 'node:crypto';

// Buyer-scale workspace contents, written straight into `records` (and `audit`) so a
// 35,000-gift history is built in seconds rather than through 35,000 API calls. The
// stored shapes are the shapes create() persists, including the real manual-gift
// shape: an empty externalRef. Volumes named by the buyer: ~35,000 gifts over ten
// years, 6,515 constituents, 1,622 designations. The remaining volumes are stated
// assumptions, chosen to be plausible rather than flattering.
export const BUYER_SCALE={gifts:35000,constituents:6515,designations:1622,campaigns:40,pledges:600,grants:150,events:120,volunteers:800,volunteerShifts:500,shiftReservations:5000,volunteerTime:12000,communications:20000};

const at='2026-09-01T12:00:00.000Z';
const meta=id=>({id,version:1,createdAt:at,updatedAt:at});
const pad=(n,w=5)=>String(n).padStart(w,'0');

// options.scale multiplies every volume (1 = buyer scale). Returns the ids a caller
// needs to exercise write paths against the populated history.
export function populateBuyerScale(db,{scale=1,schoolYear=d=>(+d.slice(5,7)>=7?`${d.slice(0,4)}–${+d.slice(0,4)+1}`:`${+d.slice(0,4)-1}–${d.slice(0,4)}`)}={}){
 const n=key=>Math.max(1,Math.round(BUYER_SCALE[key]*scale));
 const insert=db.prepare('INSERT INTO records(collection,id,data) VALUES(?,?,?)');
 const trail=db.prepare('INSERT INTO audit(actor,action,collection,record_id,at,details) VALUES(?,?,?,?,?,?)');
 const put=(collection,record)=>{insert.run(collection,record.id,JSON.stringify(record));trail.run('system','create',collection,record.id,at,'{}');return record;};
 const types=['Individual','Individual','Individual','Business','Foundation','Employee','Alumni','Individual'];
 const ids={constituents:[],people:[],designations:[],campaigns:[],pledges:[],grants:[],events:[],volunteers:[],volunteerShifts:[]};
 db.exec('BEGIN');
 try{
  for(let i=0;i<n('constituents');i++){const type=types[i%types.length];const r=put('constituents',{name:`Scale constituent ${pad(i)}`,email:`scale.${i}@example.test`,phone:'',type,additionalTypes:[],household:i%9===0?`Household ${i%700}`:'',parentId:null,contacts:[],segments:'',preference:i%40===0?'Do not contact':'Email',notes:'',...meta(randomUUID())});ids.constituents.push(r.id);if(['Individual','Employee','Alumni'].includes(type))ids.people.push(r.id);}
  for(let i=0;i<n('designations');i++){const r=put('designations',{name:`Scale designation ${pad(i)}`,school:`School ${i%60}`,parentId:i>=60&&i%5===0?ids.designations[i%60]:null,accountCode:`SCALE-${pad(i)}`,description:'',...meta(randomUUID())});ids.designations.push(r.id);}
  for(let i=0;i<n('campaigns');i++){const y=2016+i%10;const r=put('campaigns',{name:`Scale campaign ${i}`,type:'Annual',goal:10000000,startDate:`${y}-07-01`,endDate:`${y+1}-06-30`,status:'Completed',description:'',...meta(randomUUID())});ids.campaigns.push(r.id);}
  const pledgeDonor=[],grantFunder=[];
  for(let i=0;i<n('pledges');i++){const donor=ids.constituents[(i*7)%ids.constituents.length];const r=put('pledges',{name:`Scale pledge ${i}`,constituentId:donor,amount:100000000,startDate:'2020-07-01',installments:12,frequency:'Monthly',designationId:ids.designations[i%ids.designations.length],campaignId:null,status:'Active',notes:'',...meta(randomUUID())});ids.pledges.push(r.id);pledgeDonor.push(donor);}
  for(let i=0;i<n('grants');i++){const funder=ids.constituents[(i*13+3)%ids.constituents.length];const r=put('grants',{name:`Scale grant ${i}`,funderId:funder,amount:100000000,awardedAmount:100000000,awardDate:'2020-01-01',stage:'Awarded',deadline:'2020-01-01',reportDue:null,notes:'',...meta(randomUUID())});ids.grants.push(r.id);grantFunder.push(funder);}
  const methods=['Check','Credit card','ACH','Cash'];
  for(let i=0;i<n('gifts');i++){
   const year=2016+Math.floor(i*10/n('gifts')),date=`${year}-${String(1+i%12).padStart(2,'0')}-${String(1+i%28).padStart(2,'0')}`,amount=2500+(i%400)*125;
   const pledged=i%20===0&&ids.pledges.length,granted=!pledged&&i%97===0&&ids.grants.length;
   const constituentId=pledged?pledgeDonor[(i/20)%ids.pledges.length]:granted?grantFunder[i%ids.grants.length]:ids.constituents[i%ids.constituents.length];
   // 70% manual gifts with the empty reference; 30% imported with a unique source reference.
   const externalRef=i%10<7?'':`IMPORT-${pad(i,6)}`;
   const gift={constituentId,amount,type:granted?'Grant':'Cash',method:methods[i%methods.length],date,campaignId:ids.campaigns[i%ids.campaigns.length],allocations:[{designationId:ids.designations[i%ids.designations.length],amount}],externalRef,notes:'',tribute:'',softCreditId:null,pledge:'',pledgeId:pledged?ids.pledges[(i/20)%ids.pledges.length]:null,grantId:granted?ids.grants[i%ids.grants.length]:null,giftKind:pledged?'Pledge fulfillment':'One-time',...meta(randomUUID()),status:i%33===0?'Voided':'Posted',schoolYear:schoolYear(date)};
   if(gift.status==='Voided'){gift.voidReason='Scale fixture reversal';gift.voidedAt=at;}
   put('gifts',gift);
  }
  for(let i=0;i<n('events');i++){const r=put('events',{name:`Scale event ${i}`,date:`${2016+i%10}-10-03`,location:'',capacity:500,ticketPrice:0,sponsorGoal:0,notes:'',registrations:[],...meta(randomUUID())});ids.events.push(r.id);}
  for(let i=0;i<n('volunteers');i++){const r=put('volunteers',{constituentId:ids.people[i%ids.people.length],skills:'',shift:'',eventId:ids.events[i%ids.events.length],hours:0,notes:'',clockIn:null,...meta(randomUUID())});ids.volunteers.push(r);}
  for(let i=0;i<n('volunteerShifts');i++){const r=put('volunteerShifts',{name:`Scale shift ${i}`,date:`${2016+i%10}-${String(1+i%12).padStart(2,'0')}-10`,startTime:'09:00',endTime:'12:00',location:'',capacity:50,eventId:null,status:'Open',notes:'',...meta(randomUUID())});ids.volunteerShifts.push(r.id);}
  for(let i=0;i<n('shiftReservations');i++)put('shiftReservations',{shiftId:ids.volunteerShifts[i%ids.volunteerShifts.length],constituentId:ids.people[(i*3)%ids.people.length],status:i%9===0?'Cancelled':'Reserved',notes:'',...meta(randomUUID())});
  for(let i=0;i<n('volunteerTime');i++){const v=ids.volunteers[i%ids.volunteers.length];put('volunteerTime',{volunteerId:v.id,constituentId:v.constituentId,eventId:v.eventId,startAt:null,endAt:null,hours:1.5,source:'Historical',notes:'',...meta(randomUUID())});}
  for(let i=0;i<n('communications');i++)put('communications',{constituentId:ids.constituents[i%ids.constituents.length],subject:`Scale note ${i}`,channel:'Email',status:'Logged',date:`${2016+i%10}-05-05`,body:'',notes:'',...meta(randomUUID())});
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return {...ids,volunteers:ids.volunteers.map(v=>v.id)};
}
