import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReportCatalog,runCustomReport,inspectReportSourceFields} from '../src/reportEngine.js';
const data=()=>({constituents:[{id:'one',name:'One person',type:'Individual',additionalTypes:['Alumni','Employee','Staff']},{id:'two',name:'Legacy employee',type:'Employee'},{id:'three',name:'Business',type:'Business',additionalTypes:['Foundation']}],gifts:[{id:'gift',constituentId:'one',amount:10001,type:'Employee giving',method:'Payroll',status:'Posted',date:'2026-09-13',allocations:[]}],designations:[],campaigns:[]});
const def=patch=>({name:'Category report',entity:'constituents',columns:['name','type','constituentCategories','employeeCategory'],...patch});
test('category reports use one row per identity and keep primary type separate from effective membership',()=>{
 const d=data(),r=runCustomReport(d,def({filters:[{field:'employeeCategory',op:'eq',value:1}]}));assert.equal(r.matchedRows,2);assert.equal(r.rows.length,2);assert.deepEqual(r.rows[0],['One person','Individual','["Individual","Alumni","Employee","Staff"]',1]);assert.equal(d.constituents[1].additionalTypes,undefined);
 const catalog=buildReportCatalog(d).entities.find(e=>e.id==='constituents');assert.equal(catalog.fields.find(f=>f.key==='employeeCategory').type,'number');assert.equal(catalog.fields.find(f=>f.key==='constituentCategories').aggregateable,false);
 const fields=inspectReportSourceFields(d,'constituents');assert.ok(JSON.stringify(fields).includes('staffCategory'));
});
test('several categories do not multiply gift income or misclassify revenue',()=>{
 const d=data(),r=runCustomReport(d,{name:'Exact income',entity:'gifts',columns:['amount'],aggregates:[{op:'sum',field:'amount'}]});assert.equal(r.matchedRows,1);assert.equal(r.rows[0][0],10001);assert.equal(d.gifts[0].type,'Employee giving');
});
for(const additionalTypes of [['Business'],['Staff','Staff'],['Individual'],null])test('corrupt stored category membership fails report closed '+JSON.stringify(additionalTypes),()=>{
 const d=data();d.constituents[0].additionalTypes=additionalTypes;assert.throws(()=>runCustomReport(d,def()),e=>e.status===503);assert.throws(()=>inspectReportSourceFields(d,'constituents'),e=>e.status===503);
});
