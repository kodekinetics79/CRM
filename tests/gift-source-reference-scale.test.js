// Buyer scale: ~35,000 gifts over ten years, 6,515 constituents, 1,622 designations.
// Index use is asserted from plans, which are deterministic; the timing bounds are only a
// coarse regression guard (before this change a 500-row import took ~91 s at this scale,
// see work/index-audit.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {RECORD_LOOKUP_INDEXES,GIFT_SOURCE_REFERENCE_INDEX,createRecordLookups} from '../server/recordLookups.js';
import {populateBuyerScale,BUYER_SCALE} from './buyer-scale-fixture.js';
import {manualGift} from './gift-source-reference-scenarios.js';

test('gift create and a 500-row import at buyer scale read through indexes, never the gift history',async t=>{
 const app=createApp({seed:true,reminderWorker:false,workflowWorker:false}),db=app.locals.db,server=app.listen(0,'127.0.0.1');
 await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();});
 const ids=populateBuyerScale(db);db.exec('ANALYZE');
 const gifts=()=>db.prepare("SELECT count(*) AS n FROM records WHERE collection='gifts'").get().n;
 assert.ok(gifts()>=BUYER_SCALE.gifts);assert.ok(db.prepare("SELECT count(*) AS n FROM records WHERE collection='constituents'").get().n>=BUYER_SCALE.constituents);
 assert.ok(db.prepare("SELECT count(*) AS n FROM records WHERE collection='designations'").get().n>=BUYER_SCALE.designations);

 // Plans at scale, after ANALYZE: every lookup and the refusal diagnosis use their index.
 const statements=[];
 const listWhere=createRecordLookups({db:{prepare:sql=>{statements.push(sql);return db.prepare(sql);}},list:()=>assert.fail('no scan fallback for a string id'),readRecord:(c,v)=>JSON.parse(v)});
 for(const [collection,fields] of Object.entries(RECORD_LOOKUP_INDEXES))for(const [path,index] of Object.entries(fields)){
  statements.length=0;listWhere(collection,path,'probe');
  const plan=db.prepare('EXPLAIN QUERY PLAN '+statements[0]).all().map(r=>r.detail);
  assert.deepEqual(plan.filter(d=>d.startsWith('SEARCH')||d.startsWith('SCAN')),[`SEARCH records USING INDEX ${index} (<expr>=?)`],`${collection}.${path}`);
 }
 const reference=db.prepare("EXPLAIN QUERY PLAN SELECT data FROM records WHERE collection='gifts' AND typeof(json_extract(data,'$.externalRef'))='text' AND json_extract(data,'$.externalRef')<>'' AND json_extract(data,'$.externalRef')=? AND id<>?").all().map(r=>r.detail);
 assert.ok(reference.some(d=>d.startsWith(`SEARCH records USING INDEX ${GIFT_SOURCE_REFERENCE_INDEX} (<expr>=?)`)),JSON.stringify(reference));

 // Observe every records read issued while real requests run.
 const reads=[];const prepare=db.prepare.bind(db);
 db.prepare=sql=>{const s=prepare(sql);if(!/\brecords\b/.test(sql))return s;return new Proxy(s,{get:(target,key)=>typeof target[key]==='function'&&['all','get','iterate'].includes(key)?(...args)=>{reads.push({sql,args});return target[key](...args);}:typeof target[key]==='function'?target[key].bind(target):target[key]});};
 t.after(()=>{delete db.prepare;});
 const base=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'alex@foundation.example',password:'FoundationDemo!2026'})});
 const session=await login.json(),cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
 const donor={id:ids.constituents[5]},fund={id:ids.designations[7]};
 const pledge=JSON.parse(db.prepare("SELECT data FROM records WHERE collection='pledges' AND id=?").get(ids.pledges[1]).data);
 const grant=JSON.parse(db.prepare("SELECT data FROM records WHERE collection='grants' AND id=?").get(ids.grants[2]).data);
 const wholeGiftHistory=()=>reads.filter(r=>/collection=\?/.test(r.sql)&&!/\bid=\?/.test(r.sql)&&r.args[0]==='gifts'||/collection='gifts'/.test(r.sql)&&!/json_extract\(data,'\$\.\w+(\.\w+)?'\)=\?|\bid=\?/.test(r.sql));

 const timed=async fn=>{const s=performance.now();const r=await fn();return {...r,ms:performance.now()-s};};
 reads.length=0;
 const created=[await timed(()=>post('/api/records/gifts',manualGift(donor,fund))),await timed(()=>post('/api/records/gifts',manualGift(donor,fund,{externalRef:'SCALE-NEW-REF'}))),await timed(()=>post('/api/records/gifts',manualGift({id:pledge.constituentId},fund,{pledgeId:pledge.id,giftKind:'Pledge fulfillment'}))),await timed(()=>post('/api/records/gifts',manualGift({id:grant.funderId},fund,{grantId:grant.id,type:'Grant'})))];
 for(const r of created)assert.equal(r.status,201,JSON.stringify(r.json));
 assert.deepEqual(wholeGiftHistory(),[],'a gift create must not read the gift history');
 assert.ok(reads.some(r=>/records_gift|json_extract\(data,'\$\.pledgeId'\)=\?/.test(r.sql)),'the pledge receipt check reads through its lookup');

 const before=gifts();reads.length=0;
 const rows=Array.from({length:500},(_,i)=>manualGift(donor,fund,{externalRef:i%3?`SCALE-IMPORT-${i}`:''}));
 const imported=await timed(()=>post('/api/gifts/import',{rows})),history=wholeGiftHistory();
 assert.equal(imported.status,201,JSON.stringify(imported.json));assert.equal(gifts(),before+500);
 assert.deepEqual(history,[],'an import must not read the gift history once per row');
 assert.ok(imported.ms<20000,`500-row import took ${imported.ms} ms at buyer scale`);

 // A reference already in ten years of history refuses the whole file, at scale.
 const refused=await post('/api/gifts/import',{rows:[...rows.slice(0,499).map((r,i)=>({...r,externalRef:r.externalRef&&`SCALE-SECOND-${i}`})),manualGift(donor,fund,{externalRef:'IMPORT-000007'})]});
 assert.equal(refused.status,409);assert.equal(refused.json.error,'Duplicate externalRef');assert.equal(gifts(),before+500);
 t.diagnostic(`buyer scale: creates ${created.map(r=>r.ms.toFixed(1)).join(', ')} ms; 500-row import ${imported.ms.toFixed(0)} ms`);
});
