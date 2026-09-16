import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMigrationQueue} from '../shared/migrationQueue.js';
const mapping={sourceId:'id',name:'name',type:'type',preference:'choice',parentSourceId:'parent',contacts:'contacts'};
const person=i=>({id:'p'+i,name:'Synthetic '+i,type:'Individual',choice:i%3?'Post':'Do not contact',parent:'',contacts:'[]'});
const input=rows=>({source:'Synthetic normalized source',fileKey:'original-september-export',files:[{collection:'constituents',mapping,rows}]});
test('representative contacts prepare stable bounded parts without loss, preferences or contact mutation',async()=>{
 const rows=Array.from({length:6515},(_,i)=>person(i)),before=JSON.stringify(rows),a=await prepareMigrationQueue(input(rows)),b=await prepareMigrationQueue(input(rows));
 assert.equal(a.parts.length,14);assert.equal(a.totalRows,6515);assert.equal(a.digest,b.digest);assert.deepEqual(a.parts,b.parts);assert.equal(JSON.stringify(rows),before);
 assert.deepEqual(a.parts.flatMap(part=>part.files[0].rows),rows);assert.equal(new Set(a.parts.map(part=>part.fileKey)).size,14);
 for(const part of a.parts){assert.ok(part.fileKey.length<=160);assert.ok(part.files[0].rows.length<=500);assert.ok(new TextEncoder().encode(JSON.stringify({...part,previewDigest:'0'.repeat(64)})).length<=2097152);}
});
test('dependency order preserves cross-part parents including a reverse source hierarchy',async()=>{
 const rows=Array.from({length:1100},(_,i)=>({...person(i),parent:i?'p'+(i-1):''})).reverse(),q=await prepareMigrationQueue(input(rows));
 assert.deepEqual(q.parts.flatMap(part=>part.files[0].rows).map(row=>row.id),Array.from({length:1100},(_,i)=>'p'+i));
 const reverse={sourceId:'s',name:'name',accountCode:'code',parentSourceId:'parent'};
 const result=await prepareMigrationQueue({...input([person(0)]),files:[{collection:'designations',mapping:reverse,rows:[{s:'child',name:'Child',code:'C',parent:'root'},{s:'root',name:'Root',code:'R',parent:''}]},input([person(0)]).files[0]]});
 assert.deepEqual(result.parts.map(part=>part.files[0].collection),['constituents','designations']);assert.equal(result.parts[1].files[0].rows[0].s,'root');
});
test('guided imports reject implicit Email, blank preferences, cycles and duplicate identities before any commit',async()=>{
 for(const body of [input([{...person(0),choice:''}]),{...input([person(0)]),files:[{...input([person(0)]).files[0],mapping:{sourceId:'id',name:'name',type:'type'}}]},input([{...person(0),parent:'p1'},{...person(1),parent:'p0'}]),input([person(0),person(0)])])await assert.rejects(prepareMigrationQueue(body));
});
test('byte-based part splitting remains bounded with multibyte source values and stable replay keys',async()=>{
 const rows=Array.from({length:500},(_,i)=>({...person(i),notes:'界'.repeat(6000)}));
 const q=await prepareMigrationQueue(input(rows));assert.ok(q.parts.length>1);assert.equal(q.parts.flatMap(part=>part.files[0].rows).length,500);
 for(const part of q.parts)assert.ok(new TextEncoder().encode(JSON.stringify({...part,previewDigest:'0'.repeat(64)})).length<=2097152);
});
test('changed source cells or mappings change preparation digest while invalid types and excessive keys fail',async()=>{
 const a=await prepareMigrationQueue(input([person(0)])),b=await prepareMigrationQueue(input([{...person(0),name:'Changed source'}]));assert.notEqual(a.digest,b.digest);assert.notEqual(a.parts[0].fileKey,b.parts[0].fileKey);
 await assert.rejects(prepareMigrationQueue({...input([person(0)]),fileKey:'x'.repeat(129)}));
 await assert.rejects(prepareMigrationQueue({...input([person(0)]),files:[{collection:'unsupported',mapping,rows:[person(0)]}]}));
});
