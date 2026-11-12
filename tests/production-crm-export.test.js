import test from 'node:test';
import assert from 'node:assert/strict';
import {csvFromRows,formulaSafeText} from '../server/production/crmReportingService.js';

test('formula-safe text neutralizes dangerous first non-whitespace characters',()=>{
 for(const value of ['=1+1',' +SUM(A1:A2)','-2','@cmd','\t=1','\r=1','\n=1'])assert.ok(formulaSafeText(value).includes("'"),value);
 assert.equal(formulaSafeText('ordinary'),'ordinary');
});

test('CSV export is RFC4180 complete and preserves typed numbers',()=>{
 const result=csvFromRows([{name:'=HYPERLINK("x")',note:'a,b\nline',amountCents:12500}],['name','note','amountCents']);
 assert.equal(result.rowCount,1);
 assert.match(result.csv,/^name,note,amountCents\r\n/);
 assert.match(result.csv,/"'=HYPERLINK\(""x""\)"/);
 assert.match(result.csv,/"a,b\nline"/);
 assert.match(result.csv,/,12500\r\n$/);
});

test('CSV export refuses row or byte overflow instead of truncating',()=>{
 assert.throws(()=>csvFromRows(Array.from({length:2},()=>({name:'x'})),['name'],{maxRows:1,maxBytes:100}),/limit/i);
 assert.throws(()=>csvFromRows([{name:'x'.repeat(200)}],['name'],{maxRows:10,maxBytes:50}),/limit/i);
});
