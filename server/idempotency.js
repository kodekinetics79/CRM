import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';

// Request idempotency (IDEMPOTENCY-AND-INDEXING-DESIGN.md, Part A).
// A1: the middleware only RESERVES a key. commitIdempotencyMarker(), called by the shared transaction() helper
//     immediately before COMMIT, stamps committed_at on the reservation inside the business transaction, so the
//     marker commits or rolls back with the write it describes. It is the only authority on whether the operation
//     happened; the stored response is a convenience layered on top of it.
// A2: an expired in-progress lease with no marker is re-executable; with a marker it is completed-without-body.
// A3: different fingerprint 422, concurrent 409, oversized or credential-bearing response completed without body,
//     401/403/404/405/429/5xx release the reservation unless the marker proves the write committed.
// A5: operational, not evidentiary: rows expire and are deleted in bounded, opportunistic batches.
const context=new AsyncLocalStorage();
const MUTATING=new Set(['POST','PUT','PATCH','DELETE']);
const RELEASED=new Set([401,403,404,405,429]);
const KEY=/^[\x21-\x7e]{1,255}$/;
const REPLAY_HEADERS=['content-type','content-disposition','location'];
// Secrets shown once (for example invitation tokens) must not be copied into a 24-hour replay store.
const CREDENTIAL_FIELDS=new Set(['token','secret','password','passwordhash','recoverycodes','apikey','accesstoken','refreshtoken','clientsecret','privatekey']);
const DEFAULTS={leaseMs:5*60*1000,retentionMs:24*60*60*1000,maxResponseBytes:256*1024,pruneBatch:500,pruneIntervalMs:60*1000};
const sha=v=>createHash('sha256').update(v).digest('hex');
export const canonicalJson=v=>Array.isArray(v)?'['+v.map(canonicalJson).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonicalJson(v[k])).join(',')+'}':JSON.stringify(v)??'null';
const carriesCredential=(v,depth=0)=>depth<12&&!!v&&typeof v==='object'&&(Array.isArray(v)?v.some(x=>carriesCredential(x,depth+1)):Object.entries(v).some(([k,x])=>CREDENTIAL_FIELDS.has(k.toLowerCase())||carriesCredential(x,depth+1)));
const refuse=(res,status,code,error,{replayed=false,retryAfter=null}={})=>{if(replayed)res.setHeader('Idempotent-Replayed','true');if(retryAfter)res.setHeader('Retry-After',String(retryAfter));return res.status(status).json({error,code});};
const trace=entry=>{const file=process.env.WIMBLO_IDEMPOTENCY_TRACE;if(!file)return;try{appendFileSync(file,JSON.stringify(entry)+'\n');}catch{}};
const MESSAGES={
 reused:'This Idempotency-Key was already used for a different request. Nothing was changed by this request. Reload to check what was saved, then start the new action again.',
 progress:'The same request is still being processed. Wait a moment, then reload to see whether it was saved before trying again.',
 completed:'This request already completed, but its response cannot be shown again. Reload to see the saved result; do not submit it again.',
 lost:'This attempt lost its reservation to a retry of the same request, so nothing from it was saved. Reload to see the current result.',
 unavailable:'Duplicate-submission protection is temporarily unavailable, so nothing was changed. Try again shortly.',
 invalid:'Idempotency-Key must be 1 to 255 visible ASCII characters.',
 body:'Requests with an Idempotency-Key must send a JSON body.'
};

export function createIdempotencyMiddleware({db,audit=()=>{},tenantId=null,clock=Date.now,options=null}={}){
 const o={...DEFAULTS,...(options||{})},time=()=>Number((o.clock||clock)()),stats={pruned:0,pruneFailures:0,lastPruneAt:-Infinity};
 db.exec(`CREATE TABLE IF NOT EXISTS idempotency_requests(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,key_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('InProgress','Completed')),lease_token TEXT NOT NULL,reserved_at INTEGER NOT NULL,lease_expires INTEGER NOT NULL,committed_at INTEGER,completed_at INTEGER,expires_at INTEGER NOT NULL,response_status INTEGER,response_headers TEXT,response_body TEXT,body_stored INTEGER NOT NULL DEFAULT 0 CHECK(body_stored IN (0,1)),UNIQUE(tenant_id,user_id,method,path,key_hash));
 CREATE INDEX IF NOT EXISTS idempotency_requests_expiry ON idempotency_requests(expires_at);`);
 const find=(scope,keyHash)=>db.prepare('SELECT * FROM idempotency_requests WHERE tenant_id=? AND user_id=? AND method=? AND path=? AND key_hash=?').get(...scope,keyHash);
 // A5: never throws into a request, never runs inside an open transaction, deletes at most pruneBatch rows per interval.
 function prune(){const t=time();if(t-stats.lastPruneAt<o.pruneIntervalMs||db.isTransaction)return;stats.lastPruneAt=t;try{stats.pruned+=Number(db.prepare("DELETE FROM idempotency_requests WHERE id IN (SELECT id FROM idempotency_requests WHERE expires_at<=? AND (state='Completed' OR lease_expires<=?) ORDER BY expires_at LIMIT ?)").run(t,t,o.pruneBatch).changes||0);}catch(e){stats.pruneFailures++;console.error('Idempotency record pruning failed; requests continue.',e?.message);}}
 function replay(res,row){if(!row.body_stored)return refuse(res,409,'IDEMPOTENCY_COMPLETED_RELOAD',MESSAGES.completed,{replayed:true});for(const [k,v]of Object.entries(JSON.parse(row.response_headers||'{}')))res.setHeader(k,v);res.setHeader('Idempotent-Replayed','true');res.statusCode=row.response_status;return res.end(Buffer.from(row.response_body||'','base64'));}
 function finalize(ctx,req,res,body){
  ctx.finalized=true;const status=res.statusCode,route=req.route?.path?String(req.route.path):ctx.path;
  try{
   const row=db.prepare('SELECT committed_at FROM idempotency_requests WHERE id=? AND lease_token=?').get(ctx.id,ctx.lease);
   if(!row){trace({method:req.method,route,status,outcome:'lease-lost'});return;}
   const t=time(),marked=row.committed_at!=null;
   if((RELEASED.has(status)||status>=500)&&!marked){db.prepare("DELETE FROM idempotency_requests WHERE id=? AND lease_token=? AND state='InProgress' AND committed_at IS NULL").run(ctx.id,ctx.lease);trace({method:req.method,route,status,outcome:'released',marked});return;}
   let stored=!!body&&!RELEASED.has(status)&&status<500;
   if(stored&&/json/i.test(String(res.getHeader('content-type')||''))){try{if(carriesCredential(JSON.parse(body.toString('utf8'))))stored=false;}catch{}}
   const headers=Object.fromEntries(REPLAY_HEADERS.filter(h=>res.getHeader(h)!==undefined).map(h=>[h,String(res.getHeader(h))]));
   db.prepare("UPDATE idempotency_requests SET state='Completed',completed_at=?,expires_at=?,response_status=?,response_headers=?,response_body=?,body_stored=? WHERE id=? AND lease_token=? AND state='InProgress'").run(t,t+o.retentionMs,status,stored?JSON.stringify(headers):null,stored?body.toString('base64'):null,stored?1:0,ctx.id,ctx.lease);
   trace({method:req.method,route,status,outcome:stored?'stored':'completed-without-body',marked});
  }catch(e){console.error('Idempotency outcome could not be recorded; the reservation is recovered after its lease.',e?.message);}
 }
 const middleware=(req,res,next)=>{
  if(!MUTATING.has(req.method))return next();
  const key=req.get('Idempotency-Key');if(key===undefined)return next();
  if(!KEY.test(key))return refuse(res,400,'IDEMPOTENCY_KEY_INVALID',MESSAGES.invalid);
  if(!req.user?.id)return next();
  if(req.body===undefined&&(Number(req.get('content-length'))>0||req.get('transfer-encoding')))return refuse(res,415,'IDEMPOTENCY_BODY_UNSUPPORTED',MESSAGES.body);
  prune();
  const path=req.baseUrl+req.path,scope=[tenantId||'',req.user.id,req.method,path],keyHash=sha(key),query=req.query&&Object.keys(req.query).length?req.query:null;
  const fingerprint=sha(canonicalJson(query?{body:req.body??null,query}:req.body??null)),lease=randomUUID();
  let id=null;
  try{
   for(let attempt=0;attempt<2&&!id;attempt++){
    const t=time(),candidate=randomUUID();
    if(db.prepare("INSERT INTO idempotency_requests(id,tenant_id,user_id,method,path,key_hash,fingerprint,state,lease_token,reserved_at,lease_expires,expires_at) VALUES(?,?,?,?,?,?,?,'InProgress',?,?,?,?) ON CONFLICT DO NOTHING").run(candidate,...scope,keyHash,fingerprint,lease,t,t+o.leaseMs,t+o.retentionMs).changes){id=candidate;break;}
    const row=find(scope,keyHash);
    if(!row)continue;
    if(row.fingerprint!==fingerprint)return refuse(res,422,'IDEMPOTENCY_KEY_REUSED',MESSAGES.reused);
    if(row.state==='Completed'){if(row.expires_at>t)return replay(res,row);db.prepare("DELETE FROM idempotency_requests WHERE id=? AND state='Completed' AND expires_at<=?").run(row.id,t);continue;}
    if(row.lease_expires>t)return refuse(res,409,'IDEMPOTENCY_IN_PROGRESS',MESSAGES.progress,{retryAfter:1});
    if(row.committed_at!=null){
     // A2: the marker proves the earlier attempt committed; its response was lost. Never re-execute.
     if(db.prepare("UPDATE idempotency_requests SET state='Completed',completed_at=?,expires_at=?,body_stored=0,response_status=NULL,response_headers=NULL,response_body=NULL WHERE id=? AND lease_token=? AND state='InProgress'").run(t,t+o.retentionMs,row.id,row.lease_token).changes)audit(req.user,'idempotency_lease_expired_committed',null,null,{method:req.method,path,reservedAt:new Date(Number(row.reserved_at)).toISOString()});
     return refuse(res,409,'IDEMPOTENCY_COMPLETED_RELOAD',MESSAGES.completed,{replayed:true});
    }
    // A2: no marker proves the earlier attempt never committed, so taking over its lease and re-executing is safe.
    if(!db.prepare("UPDATE idempotency_requests SET lease_token=?,reserved_at=?,lease_expires=?,expires_at=? WHERE id=? AND lease_token=? AND state='InProgress' AND committed_at IS NULL").run(lease,t,t+o.leaseMs,t+o.retentionMs,row.id,row.lease_token).changes)return refuse(res,409,'IDEMPOTENCY_IN_PROGRESS',MESSAGES.progress,{retryAfter:1});
    audit(req.user,'idempotency_lease_recovered',null,null,{method:req.method,path,reservedAt:new Date(Number(row.reserved_at)).toISOString()});
    id=row.id;
   }
  }catch(e){console.error('Idempotency reservation failed.',e?.message);return refuse(res,503,'IDEMPOTENCY_UNAVAILABLE',MESSAGES.unavailable);}
  if(!id)return refuse(res,409,'IDEMPOTENCY_IN_PROGRESS',MESSAGES.progress,{retryAfter:1});
  const ctx={db,id,lease,path,time,finalized:false};
  const chunks=[],write=res.write,end=res.end;let size=0,overflow=false;
  const capture=(chunk,encoding)=>{if(overflow||chunk==null||typeof chunk==='function')return;const b=Buffer.isBuffer(chunk)?chunk:ArrayBuffer.isView(chunk)?Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength):Buffer.from(String(chunk),typeof encoding==='string'?encoding:'utf8');size+=b.length;if(size>o.maxResponseBytes){overflow=true;chunks.length=0;}else chunks.push(b);};
  res.write=function(chunk,encoding,cb){if(!ctx.finalized)capture(chunk,encoding);return write.call(this,chunk,encoding,cb);};
  res.end=function(chunk,encoding,cb){if(!ctx.finalized){capture(chunk,encoding);finalize(ctx,req,res,overflow?null:Buffer.concat(chunks));}return end.call(this,chunk,encoding,cb);};
  return context.run(ctx,next);
 };
 middleware.stats=stats;middleware.prune=prune;
 return middleware;
}

// Called by the shared transaction() helper immediately before COMMIT, inside the same transaction as the business
// write. Outside a keyed request, after the response was recorded, or for a different database it does nothing.
export function commitIdempotencyMarker(db){
 const ctx=context.getStore();if(!ctx||ctx.finalized||ctx.db!==db)return;
 if(!db.prepare('UPDATE idempotency_requests SET committed_at=COALESCE(committed_at,?) WHERE id=? AND lease_token=?').run(ctx.time(),ctx.id,ctx.lease).changes){const e=new Error(MESSAGES.lost);e.status=409;throw e;}
}
