import test from 'node:test';import assert from 'node:assert/strict';
import {shiftCounts,duplicateGroups,operationsQueue} from '../src/phaseFour.js';
test('shift roster treats waitlists and cancelled history separately from capacity',()=>{const c=shiftCounts({id:'s',capacity:2},[{shiftId:'s',status:'Reserved'},{shiftId:'s',status:'Waitlisted'},{shiftId:'s',status:'Cancelled'},{shiftId:'other',status:'Reserved'}]);assert.equal(c.reserved,1);assert.equal(c.available,1);assert.equal(c.waitlisted,1);assert.equal(c.rows.length,3);});
test('duplicate review normalizes exact email without merging identities or grouping missing addresses',()=>{const people=[{id:'a',email:' SAME@example.test '},{id:'b',email:'same@EXAMPLE.test'},{id:'c',email:''},{id:'d',email:''}];const groups=duplicateGroups(people);assert.equal(groups.length,1);assert.equal(groups[0].people.length,2);assert.equal(people.length,4);});
test('operations keeps completed tasks and future or opted-out acknowledgments out of due work',()=>{const data={constituents:[{id:'p',preference:'Email'},{id:'n',preference:'Do not contact'}],tasks:[{id:'done',status:'Completed',dueDate:'2026-09-01'},{id:'open',title:'Review',status:'Open',dueDate:'2026-09-13'}],gifts:[{id:'future',date:'2026-10-01',constituentId:'p',type:'Cash'},{id:'optout',date:'2026-09-01',constituentId:'n',type:'Cash'},{id:'fee',date:'2026-09-01',constituentId:'p',type:'Fee payment'},{id:'void',date:'2026-09-01',constituentId:'p',type:'Cash',status:'Voided'}]};const q=operationsQueue(data,'2026-09-13');assert.equal(q.length,1);assert.equal(q[0].recordId,'open');assert.equal(q[0].timing,'Today');});
test('operations uses pledge receipt semantics and describes grant date review without inventing completion',()=>{const q=operationsQueue({constituents:[],tasks:[],grants:[{id:'g',name:'Award',stage:'Awarded',reportDue:'2026-09-01'}],pledges:[{id:'p',name:'Commitment',status:'Active',constituentId:'d',amount:20000,startDate:'2026-08-01',installments:2,frequency:'Monthly'}],gifts:[{id:'r',pledgeId:'p',constituentId:'d',amount:10000,type:'Cash',status:'Posted',date:'2026-08-01'}]},'2026-09-13');assert.equal(q.length,2);assert.match(q.find(i=>i.kind==='Pledge').reason,/100\.00/);assert.match(q.find(i=>i.kind==='Grant reporting').reason,/no exact milestone/);});

test('grant work follows retained milestone completion and reopening without clearing unrelated legacy obligations',()=>{
 const grant={id:'g',name:'Award',stage:'Awarded',reportDue:'2026-09-01'};
 const milestone={id:'m',grantId:'g',name:'Required report',kind:'Report',dueDate:'2026-09-01',status:'Open',owner:{id:'owner',name:'QA Owner'}};
 const data={grants:[grant],grantMilestones:[milestone]};
 let queue=operationsQueue(data,'2026-09-13');assert.equal(queue.length,1);assert.equal(queue[0].id,'milestone-m');assert.equal(queue[0].view,'grant-operations');assert.match(queue[0].reason,/QA Owner/);
 milestone.status='Completed';assert.deepEqual(operationsQueue(data,'2026-09-13'),[]);
 milestone.status='Open';assert.equal(operationsQueue(data,'2026-09-13')[0].id,'milestone-m');
 milestone.status='Completed';milestone.dueDate='2026-08-01';queue=operationsQueue(data,'2026-09-13');assert.equal(queue.length,1);assert.equal(queue[0].id,'report-g');
 milestone.dueDate=grant.reportDue;milestone.kind='Agreement';assert.equal(operationsQueue(data,'2026-09-13')[0].id,'report-g');
 milestone.kind='Report';milestone.grantId='other';assert.equal(operationsQueue(data,'2026-09-13')[0].id,'report-g');
 assert.equal(grant.reportDue,'2026-09-01');
});
