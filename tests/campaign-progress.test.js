import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignProgress} from '../src/campaignData.js';
const gift=(id,amount,date,extra={})=>({id,amount,date,campaignId:'annual',status:'Posted',type:'Cash',...extra});
const options={campaignId:'annual',goalCents:100000,asOf:'2026-09-13'};

test('lifetime raised includes original past/today dates across fiscal assignments, while future remains a separate source fact',()=>{
 const gifts=[gift('prior',12345,'2022-06-30'),gift('today',10001,'2026-09-13'),gift('assigned',7654,'2025-12-01',{schoolYearOverride:'2030–2031'}),gift('future',40000,'2026-09-14'),gift('other',99999,'2026-09-12',{campaignId:'other'})];
 const original=structuredClone(gifts);const result=campaignProgress(gifts,options);
 assert.equal(result.currentAmountCents,30000);assert.equal(result.progressPercent,30);assert.equal(result.futureAmountCents,40000);
 assert.deepEqual(result.currentGifts.map(g=>g.id),['prior','today','assigned']);assert.deepEqual(result.sourceGifts.map(g=>g.id),['prior','today','assigned','future']);assert.deepEqual(gifts,original);
 const tomorrow=campaignProgress(gifts,{...options,asOf:'2026-09-14'});assert.equal(tomorrow.currentAmountCents,70000);assert.equal(tomorrow.futureAmountCents,0);
});

test('cash, employee, grant and sponsor receipts count once while fee/noncash/void/unposted values never become raised or future raised',()=>{
 const gifts=[gift('cash',101,'2026-09-01'),gift('payroll',202,'2026-09-02',{type:'Employee giving',method:'Payroll'}),gift('grant',303,'2026-09-03',{type:'Grant'}),gift('sponsor',404,'2026-09-04',{type:'Sponsorship'}),gift('fee',999,'2026-09-05',{type:'Fee payment'}),gift('noncash',999,'2026-09-05',{type:'In-kind'}),gift('void',999,'2026-09-05',{status:'Voided'}),gift('unposted',999,'2026-09-05',{status:'Pending'}),gift('future-fee',999,'2026-10-01',{type:'Fee payment'}),gift('future-void',999,'2026-10-01',{status:'Voided'})];
 const result=campaignProgress(gifts,options);assert.equal(result.currentAmountCents,1010);assert.equal(result.futureAmountCents,0);assert.equal(result.sourceGifts.length,10);assert.equal(result.currentGifts.length,4);
});

test('goal is a plan rather than receipt money; zero goal and over-goal receipts preserve exact cents',()=>{
 assert.equal(campaignProgress([], {...options,goalCents:0}).progressPercent,0);
 const result=campaignProgress([gift('exact',12345,'2026-01-01')],{...options,goalCents:10000});assert.equal(result.currentAmountCents,12345);assert.ok(Math.abs(result.progressPercent-123.45)<0.000001);assert.equal(result.goalCents,10000);
});

test('invalid dates, fractional cents and unsafe financial totals fail rather than fabricate a trustworthy campaign metric',()=>{
 for(const asOf of [undefined,'2026-02-30','not-a-date'])assert.throws(()=>campaignProgress([], {...options,asOf}),/as-of/);
 assert.throws(()=>campaignProgress([gift('date',100,'2026-02-30')],options),/source dates/);
 assert.throws(()=>campaignProgress([gift('fraction',100.5,'2026-01-01')],options),/integer cents/);
 assert.throws(()=>campaignProgress([gift('large',Number.MAX_SAFE_INTEGER,'2026-01-01'),gift('one',1,'2026-01-02')],options),/total exceeds/);
 assert.throws(()=>campaignProgress([],{...options,goalCents:1.5}),/integer cents/);
});
