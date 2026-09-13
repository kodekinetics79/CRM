import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardGiving,matchesGiftScope} from '../src/dashboardData.js';
import {sum} from '../src/lib.js';
const gift=(id,changes={})=>({id,constituentId:id,amount:12345,date:'2026-09-13',type:'Cash',status:'Posted',allocations:[],...changes});
const scope={schoolYear:'2026–2027',fiscalStartMonth:7,asOf:'2026-09-13'};
test('current contributions exclude future, void, fees and noncash while future source records stay inspectable',()=>{
 const gifts=[gift('current'),gift('future',{date:'2026-09-14',amount:10001}),gift('void',{status:'Voided'}),gift('fee',{type:'Fee payment'}),gift('noncash',{type:'In-kind'}),gift('outside',{date:'2025-09-13'})];
 const result=dashboardGiving(gifts,scope);
 assert.equal(result.total,12345);assert.equal(result.donorCount,1);assert.equal(result.futureTotal,10001);
 assert.deepEqual(result.futureContributions.map(g=>g.id),['future']);assert.equal(gifts[1].status,'Posted');
 const drill=gifts.filter(g=>matchesGiftScope(g,{...scope,contributionsOnly:true,month:'2026-09'}));
 assert.equal(sum(drill),result.total);assert.deepEqual(drill.map(g=>g.id),['current']);
 const future=gifts.filter(g=>matchesGiftScope(g,{schoolYear:scope.schoolYear,fiscalStartMonth:7,futureAfter:scope.asOf,contributionsOnly:true}));
 assert.deepEqual(future.map(g=>g.id),['future']);assert.equal(sum(future),result.futureTotal);
});
test('fiscal assignment changes period scope without changing original dates or current receipt cutoff',()=>{
 const past=gift('reassigned',{date:'2025-12-01',schoolYearOverride:'2026–2027',amount:10001});
 const future=gift('future-assignment',{date:'2027-08-01',schoolYearOverride:'2026–2027',amount:22222});
 const original=JSON.stringify([past,future]);const result=dashboardGiving([past,future],scope);
 assert.equal(result.total,10001);assert.equal(result.futureTotal,22222);assert.equal(JSON.stringify([past,future]),original);
 assert.equal(matchesGiftScope(past,{...scope,month:'2026-09',contributionsOnly:true}),false);
 assert.equal(matchesGiftScope(past,{...scope,contributionsOnly:true}),true);
});
