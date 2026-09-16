import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const people=['Individual','Alumni','Employee','Staff'],organizations=['Business','Foundation','Community partner'],types=['Individual','Business','Foundation','Alumni','Employee','Staff','Community partner'];
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-identity-multitype-')),dbPath=join(dir,'identity.sqlite');let app,server,base;
 async function open(){app=createApp({dbPath,seed:true,reportWorker:false});server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'alex@foundation.example',password:'FoundationDemo!2026'})});assert.equal(login.status,200);const session={...await login.json(),cookie:login.headers.get('set-cookie').split(';')[0]};
 async function request(path,{method='GET',body,csrf=true}={}){const response=await fetch(base+path,{method,headers:{Cookie:session.cookie,...(body===undefined?{}:{'Content-Type':'application/json'}),...(csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,json:await response.json()};}
 const create=async(body,collection='constituents')=>{const result=await request('/api/records/'+collection,{method:'POST',body});assert.equal(result.status,201,JSON.stringify(result.json));return result.json.record;};
 const workspace=async()=>{const result=await request('/api/workspace');assert.equal(result.status,200);return result.json.data;};
 const input=(target,source)=>({targetId:target.id,sourceId:source.id,targetVersion:target.version,sourceVersion:source.version,reason:'Reviewed duplicate with overlapping constituent categories'});
 const preview=body=>request('/api/identity/merge/preview',{method:'POST',body});
 const commit=async body=>{const reviewed=await preview(body);assert.equal(reviewed.status,200,JSON.stringify(reviewed.json));return request('/api/identity/merge',{method:'POST',body:{...body,previewDigest:reviewed.json.preview.previewDigest}});};
 return {request,create,workspace,input,preview,commit,get db(){return app.locals.db;},restart:async()=>{await close();await open();}};
}

test('all seven primary categories merge only within their explicit physical family; previews do not mutate records or grant accounts',async t=>{
 const f=await fixture(t),pairs=new Map();for(const type of types){const family=people.includes(type)?people:organizations,extras=family.filter(value=>value!==type).reverse();pairs.set(type,[await f.create({name:'Synthetic target '+type,type,additionalTypes:extras}),await f.create({name:'Synthetic source '+type,type,additionalTypes:extras})]);}
 const before=await f.workspace(),users=f.db.prepare('SELECT id,role,active,version FROM users ORDER BY id').all();
 for(const targetType of types)for(const sourceType of types){const [target]=pairs.get(targetType),[,source]=pairs.get(sourceType),result=await f.preview(f.input(target,source));assert.equal(result.status,200,JSON.stringify(result.json));const sameFamily=people.includes(targetType)===people.includes(sourceType);assert.equal(result.json.preview.blockers.some(block=>/Different constituent types/.test(block.reason)),!sameFamily,targetType+' / '+sourceType);if(sameFamily){assert.equal(result.json.preview.blockers.length,0,targetType+' / '+sourceType);assert.equal(result.json.preview.mergedTarget.type,targetType);assert.deepEqual(result.json.preview.mergedTarget.additionalTypes,types.filter(value=>value!==targetType&&(people.includes(value)===people.includes(targetType))));}}
 assert.deepEqual(await f.workspace(),before);assert.deepEqual(f.db.prepare('SELECT id,role,active,version FROM users ORDER BY id').all(),users);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n,0);
});

test('person merge unions categories without primary duplication, conserves money and keeps exact legacy source alias after restart',async t=>{
 const f=await fixture(t),target=await f.create({name:'Synthetic individual survivor',type:'Individual',additionalTypes:['Staff']}),source=await f.create({name:'Synthetic employee original',type:'Employee',additionalTypes:['Alumni'],preference:'Do not contact'});
 // A pre-category legacy record is still a valid Employee; do not rewrite its retained original.
 const legacy={...source};delete legacy.additionalTypes;f.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(legacy),'constituents',source.id);
 const fund=(await f.workspace()).designations[0],gift=await f.create({constituentId:source.id,amount:10001,type:'Cash',method:'Check',date:'2026-08-01',allocations:[{designationId:fund.id,amount:10001}]},'gifts'),before=(await f.workspace()).gifts,users=f.db.prepare('SELECT id,role,active,version FROM users ORDER BY id').all();
 const result=await f.commit(f.input(target,source));assert.equal(result.status,200,JSON.stringify(result.json));assert.equal(result.json.target.type,'Individual');assert.deepEqual(result.json.target.additionalTypes,['Employee','Staff']);assert.equal(result.json.target.preference,'Do not contact');assert.equal(result.json.source.type,'Employee');assert.equal(result.json.source.additionalTypes,undefined);
 const alias=f.db.prepare('SELECT source_snapshot FROM identity_aliases WHERE source_id=?').get(source.id);assert.deepEqual(JSON.parse(alias.source_snapshot),legacy);const after=await f.workspace();assert.equal(after.gifts.find(value=>value.id===gift.id).constituentId,target.id);assert.equal(after.gifts.reduce((n,value)=>n+BigInt(value.amount),0n),before.reduce((n,value)=>n+BigInt(value.amount),0n));assert.equal(after.gifts.length,before.length);assert.deepEqual(f.db.prepare('SELECT id,role,active,version FROM users ORDER BY id').all(),users);
 await f.restart();const retained=await f.workspace();assert.deepEqual(retained.constituents.find(value=>value.id===target.id).additionalTypes,['Employee','Staff']);assert.deepEqual(JSON.parse(f.db.prepare('SELECT source_snapshot FROM identity_aliases WHERE source_id=?').get(source.id).source_snapshot),legacy);assert.throws(()=>f.db.prepare('UPDATE identity_aliases SET reason=? WHERE source_id=?').run('rewrite',source.id),/immutable/);
});

test('organization merge keeps target primary and canonical category union without person or household membership',async t=>{
 const f=await fixture(t),target=await f.create({name:'Synthetic business survivor',type:'Business',additionalTypes:['Foundation']}),source=await f.create({name:'Synthetic community organization',type:'Community partner',additionalTypes:['Foundation']});const merged=await f.commit(f.input(target,source));assert.equal(merged.status,200,JSON.stringify(merged.json));assert.equal(merged.json.target.type,'Business');assert.deepEqual(merged.json.target.additionalTypes,['Foundation','Community partner']);
 const denied=await f.request('/api/households',{method:'POST',body:{name:'Invalid organization household',address:'Synthetic',memberIds:[target.id]}});assert.equal(denied.status,400);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_members WHERE constituent_id=?').get(target.id).n,0);
});

test('category edits invalidate reviewed merge graph while acknowledged financial history remains blocked',async t=>{
 const f=await fixture(t),target=await f.create({name:'Synthetic staff survivor',type:'Staff',additionalTypes:['Alumni']}),source=await f.create({name:'Synthetic employee source',type:'Employee'}),body=f.input(target,source),reviewed=await f.preview(body);assert.equal(reviewed.status,200);
 const changed=await f.request('/api/records/constituents/'+source.id,{method:'PATCH',body:{version:source.version,additionalTypes:['Alumni']}});assert.equal(changed.status,200,JSON.stringify(changed.json));const stale=await f.request('/api/identity/merge',{method:'POST',body:{...body,previewDigest:reviewed.json.preview.previewDigest}});assert.equal(stale.status,409);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n,0);
 const current=changed.json.record,fund=(await f.workspace()).designations[0],gift=await f.create({constituentId:current.id,amount:12345,type:'Cash',method:'Check',date:'2026-08-01',allocations:[{designationId:fund.id,amount:12345}]},'gifts');const acknowledged=await f.request('/api/gifts/'+gift.id+'/acknowledge',{method:'POST',body:{version:gift.version,date:'2026-09-13',channel:'Post',notes:'Synthetic manually recorded acknowledgment'}});assert.equal(acknowledged.status,200,JSON.stringify(acknowledged.json));const before=await f.workspace(),protectedBody=f.input(target,current),blocked=await f.preview(protectedBody);assert.equal(blocked.status,200);assert.ok(blocked.json.preview.blockers.some(value=>/acknowledged/.test(value.reason)));assert.equal((await f.commit(protectedBody)).status,409);assert.deepEqual(await f.workspace(),before);
});

test('corrupt cross-family or duplicate persisted categories cannot bypass merge or household family checks',async t=>{
 const f=await fixture(t),target=await f.create({name:'Synthetic target',type:'Individual'}),source=await f.create({name:'Synthetic source',type:'Individual'});
 for(const additionalTypes of [['Business'],['Employee','Employee'],['Individual'],['Unknown category']]){const corrupt={...source,additionalTypes};f.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(JSON.stringify(corrupt),'constituents',source.id);const merged=await f.preview(f.input(target,source));assert.equal(merged.status,503,JSON.stringify(merged.json));const household=await f.request('/api/households',{method:'POST',body:{name:'Corrupt synthetic household',address:'Synthetic',memberIds:[source.id]}});assert.equal(household.status,503);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_members WHERE constituent_id=?').get(source.id).n,0);}
});
