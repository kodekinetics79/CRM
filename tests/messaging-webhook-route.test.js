import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {createApp} from '../server/app.js';
import {createTestOnlyMessagingTransport} from '../server/messaging.js';

// The public provider callback is mounted in server/app.js before express.json so
// the raw bytes stay verifiable. Nothing here authenticates a workspace user, so
// the signature, the workspace scope and the bounded body are the only authority.
const TENANT='33333333-3333-4333-8333-333333333333',SECRET='synthetic-messaging-callback-secret-key-0002';

async function fixture(t,{enabled=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-messaging-webhook-'));
 const time=Date.parse('2026-09-15T12:00:00.000Z'),transport=createTestOnlyMessagingTransport();
 const messaging=enabled?{mode:'TEST_ONLY',channels:['Email'],fromAddress:'news@foundation.example',webhookSecret:SECRET,authorization:{approved:true,reference:'Synthetic TEST_ONLY authorization',reviewedAt:'2026-09-13T00:00:00.000Z'},transport,clock:()=>time}:{clock:()=>time};
 const app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',tenantId:TENANT,extensions:{messaging}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();await rm(dir,{recursive:true,force:true});});
 const sign=(payload,secret=SECRET)=>{const stamp=Math.floor(time/1000);return 't='+stamp+',v1='+createHmac('sha256',secret).update(String(stamp)+'.').update(Buffer.from(payload,'utf8')).digest('hex');};
 async function callback(body,{signature,origin,contentType='application/json'}={}){
  const payload=typeof body==='string'?body:JSON.stringify(body);
  const r=await fetch(base+'/api/messaging/webhook',{method:'POST',headers:{'Content-Type':contentType,'X-Wimblo-Signature':signature??sign(payload),...(origin?{Origin:origin}:{})},body:payload});
  return {status:r.status,json:await r.json().catch(()=>({}))};
 }
 const event=(changes={})=>({tenantId:TENANT,type:'Unsubscribed',channel:'Email',address:'callback.donor@example.test',...changes});
 return {callback,event,sign};
}

test('signed provider callback is accepted once and replays are recognised without a second effect',async t=>{
 const f=await fixture(t),payload=f.event();
 const first=await f.callback(payload);
 assert.equal(first.status,200,JSON.stringify(first.json));
 assert.equal(first.json.received,true);
 assert.notEqual(first.json.replayed,true);
 assert.equal(first.json.suppressionReason,'Unsubscribed');
 const replay=await f.callback(payload);
 assert.equal(replay.status,200);
 assert.equal(replay.json.replayed,true,'an identical raw body must be recognised as a replay');
 assert.equal(replay.json.eventId,first.json.eventId,'a replay must not create a second retained event');
});

test('callback refuses a browser origin, a wrong signature, a foreign workspace and an unbounded body',async t=>{
 const f=await fixture(t);
 assert.equal((await f.callback(f.event(),{origin:'https://donor.example.test'})).status,403);
 assert.equal((await f.callback(f.event({address:'other@example.test'}),{signature:'t=1757937600,v1='+'a'.repeat(64)})).status,400);
 assert.equal((await f.callback(f.event({address:'malformed@example.test'}),{signature:'not-a-signature-header'})).status,400);
 const foreign=await f.callback(f.event({tenantId:'44444444-4444-4444-8444-444444444444',address:'foreign@example.test'}));
 assert.equal(foreign.status,404,'a callback for another workspace must not be retained here');
 const oversize=await f.callback(JSON.stringify({...f.event({address:'big@example.test'}),padding:'x'.repeat(300*1024)}));
 assert.ok([400,413].includes(oversize.status),'an oversize raw body must be refused, not parsed: '+oversize.status);
});

test('callback route reports unavailable rather than failing open when messaging is not configured',async t=>{
 const f=await fixture(t,{enabled:false});
 const result=await f.callback(f.event());
 assert.equal(result.status,503,JSON.stringify(result.json));
 assert.match(result.json.error,/configured|unavailable/i);
 assert.match(result.json.error,/Nothing can be sent|unavailable/i);
});
