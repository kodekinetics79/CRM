// Public, unauthenticated giving surface mounted under /api/public/giving.
//
// This surface carries NO session cookie. Each request proves itself with an
// explicitly issued signed token or carries no authority at all, so browser
// CSRF does not apply and this module enforces its own strict origin checks,
// rate limits, replay defence, body-size limits and tenant scoping.
//
// Nothing here records income. A submission is a prospective request for staff
// review. A browser return or unpaid callback records no gift, no constituent,
// no consent change and no financial history. Donor self-service is strictly
// bounded to viewing and cancelling the donor's own recurring intention through
// a signed token: it can never browse constituents, see another donor, alter
// consent or change financial history.
import {randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const sha256=v=>createHash('sha256').update(v).digest('hex');
// Every table this module writes is append-only by design, so each one needs an
// explicit ceiling. An unauthenticated caller must never be able to grow retained
// evidence without bound: server/backup.js aborts the whole archive past 500,000
// rows, so an uncapped append-only table would let an anonymous request destroy
// the workspace's ability to produce a recovery archive, with no way to trim it.
const limits={bodyBytes:4096,windowMs:60000,requestsPerWindow:30,tokenAttemptsPerWindow:20,clients:2048,submissionsPerWindow:5,retainedSubmissions:5000,retainedReturns:5000,referenceChars:100,amountMin:100,amountMax:1e8};
const scope='TEST ONLY: a public giving request surface. Submitting this form records no payment, no income, no constituent record and no consent change. A district-approved payment relationship is not configured and no live provider is connected.';
const FREQUENCIES=['Monthly','Quarterly','Annual'];

export function installPublic(app,ctx){
 if(!ctx)return null;
 const {db,audit,transaction,tenantId,production,isTenantActive=()=>true,config=null}=ctx;
 const clock=config?.clock||Date.now;
 if(config){
  if(production||config.mode!=='TEST_ONLY')throw new Error('Public giving TEST_ONLY cannot enable in production');
  if(!z.uuid().safeParse(tenantId).success)throw new Error('Public giving requires an explicit test workspace tenant');
  if(typeof config.tokenSecret!=='string'||config.tokenSecret.length<16)throw new Error('Public giving requires a donor self-service signing secret');
  if(!Array.isArray(config.allowedOrigins))throw new Error('Public giving requires an explicit allowed origin list');
  for(const origin of config.allowedOrigins){let parsed;try{parsed=new URL(origin);}catch{throw new Error('Public giving allowed origins must be absolute origins');}if(parsed.origin!==origin||parsed.username||parsed.password)throw new Error('Public giving allowed origins must be bare origins without path or credentials');}
 }
 const allowedOrigins=new Set(config?.allowedOrigins||[]);
 db.exec(`CREATE TABLE IF NOT EXISTS public_giving_submissions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('Pledge','RecurringPayment','OneTime')),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),frequency TEXT,supporter_name TEXT NOT NULL,supporter_email TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('PendingStaffReview')),client_hash TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(tenant_id,request_id));
 CREATE TABLE IF NOT EXISTS public_giving_returns(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,reference TEXT NOT NULL,outcome TEXT NOT NULL,income_recorded INTEGER NOT NULL CHECK(income_recorded=0),at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS public_giving_token_uses(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,token_hash TEXT NOT NULL,action TEXT NOT NULL,nonce TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(tenant_id,nonce,action));
 CREATE TRIGGER IF NOT EXISTS public_giving_submission_no_update BEFORE UPDATE ON public_giving_submissions BEGIN SELECT RAISE(ABORT,'Public giving submissions are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS public_giving_submission_no_delete BEFORE DELETE ON public_giving_submissions BEGIN SELECT RAISE(ABORT,'Public giving submissions are retained'); END;
 CREATE TRIGGER IF NOT EXISTS public_giving_return_no_update BEFORE UPDATE ON public_giving_returns BEGIN SELECT RAISE(ABORT,'Public giving return evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS public_giving_return_no_delete BEFORE DELETE ON public_giving_returns BEGIN SELECT RAISE(ABORT,'Public giving return evidence is retained'); END;
 CREATE TRIGGER IF NOT EXISTS public_giving_token_use_no_update BEFORE UPDATE ON public_giving_token_uses BEGIN SELECT RAISE(ABORT,'Public token use evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS public_giving_token_use_no_delete BEFORE DELETE ON public_giving_token_uses BEGIN SELECT RAISE(ABORT,'Public token use evidence is retained'); END;`);
 // A browser return is genuinely idempotent per reference and outcome, so collapse
 // repeats to one retained row. This is additive (an index, not a table constraint)
 // so an already-created table gains it. It is a correctness and volume improvement,
 // NOT the bound: `reference` is caller-supplied, so a varying reference would defeat
 // it on its own. The retainedReturns ceiling below is what actually bounds the table.
 try{db.exec('CREATE UNIQUE INDEX IF NOT EXISTS public_giving_return_once ON public_giving_returns(tenant_id,reference,outcome)');}
 catch{/* Pre-existing duplicate rows: keep the workspace startable; the ceiling still bounds growth. */}

 const tx=fn=>db.isTransaction?fn():transaction(fn),time=()=>new Date(clock()).toISOString();
 const buckets=new Map();
 function rate(kind,client,max){const tick=clock();for(const [k,v] of buckets)if(v.until<tick)buckets.delete(k);const id=kind+':'+client;let bucket=buckets.get(id);if(!bucket){if(buckets.size>=limits.clients)fail(429,'Too many requests. Try again shortly');bucket={count:0,until:tick+limits.windowMs};buckets.set(id,bucket);}if(++bucket.count>max)fail(429,'Too many requests. Try again shortly');}
 const client=req=>sha256(String(req.ip||'unknown'));

 // Strict, self-enforced origin checking. No session cookie is read or issued here.
 function originAllowed(req){
  const origin=req.get('Origin');
  if(origin&&!allowedOrigins.has(origin))return false;
  const site=req.get('Sec-Fetch-Site');
  if(site&&!['same-origin','same-site','none'].includes(site))return false;
  const referer=req.get('Referer');
  if(referer){let parsed;try{parsed=new URL(referer);}catch{return false;}if(!allowedOrigins.has(parsed.origin))return false;}
  return true;
 }
 function guard(req,res,next){
  try{
   res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');res.set('X-Robots-Tag','noindex');
   if(req.get('Cookie'))res.set('Clear-Site-Data','"cookies"');
   if(!config)fail(503,'Public giving is not configured for this workspace');
   if(!isTenantActive())fail(503,'This page is unavailable. Try again later');
   if(!originAllowed(req))fail(403,'Request origin is not permitted');
   const declared=Number(req.get('Content-Length')||0);
   if(declared>limits.bodyBytes)fail(413,'Request too large');
   if(req.method!=='GET'&&JSON.stringify(req.body??null).length>limits.bodyBytes)fail(413,'Request too large');
   rate('request',client(req),limits.requestsPerWindow);
   next();
  }catch(e){next(e);}
 }
 const route=fn=>(req,res,next)=>{try{fn(req,res);}catch(e){next(e);}};
 // The public seam installs before the authenticated modules exist, and the seam
 // spreads its context, so a `services` getter is captured empty at install time.
 // Resolve the live service per request instead of binding it once.
 const service=()=>{const s=app.locals.extensions?.services?.recurringGiving||ctx.services?.recurringGiving;if(!s)fail(503,'Donor self-service is unavailable');return s;};

 // Signed, expiring, tenant-scoped donor token. The public page keeps it in the
 // URL fragment, so it is never sent in a request line, log or Referer header.
 function verifyToken(req,value){
  rate('token',client(req),limits.tokenAttemptsPerWindow);
  if(typeof value!=='string'||value.length<40||value.length>800)fail(400,'This link is not valid');
  const parts=value.split('.');
  if(parts.length!==3||parts[0]!=='v1')fail(400,'This link is not valid');
  const expected=Buffer.from(createHmac('sha256',config.tokenSecret).update(parts[0]+'.'+parts[1]).digest('hex'),'utf8'),supplied=Buffer.from(parts[2],'utf8');
  if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))fail(403,'This link is not valid');
  let payload;try{payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}catch{fail(400,'This link is not valid');}
  if(!payload||payload.t!==tenantId||typeof payload.i!=='string'||typeof payload.n!=='string'||!Number.isSafeInteger(payload.e))fail(403,'This link is not valid');
  if(payload.e<clock())fail(403,'This link has expired. Ask the foundation office for a new one');
  return {hash:sha256(value),nonce:payload.n};
 }
 // First use of each action is retained. A donor reloading their own link must not
 // hit a unique-constraint failure, and repeats must not grow an append-only table:
 // the nonce is inside the signed token, so one link can retain at most one row per action.
 function recordUse(token,action){db.prepare('INSERT INTO public_giving_token_uses VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(randomUUID(),tenantId,token.hash,action,token.nonce,time());}

 app.use('/api/public/giving',guard);
 app.get('/api/public/giving/status',route((req,res)=>res.json({enabled:true,mode:'TEST_ONLY',acceptsPayment:false,incomeRecorded:false,manualEntryPrimary:true,frequencies:FREQUENCIES,minimumCents:limits.amountMin,maximumCents:limits.amountMax,scope})));

 // A prospective request for staff review. No gift, constituent or consent is created.
 app.post('/api/public/giving/submissions',route((req,res)=>{
  const p=z.object({requestId:z.uuid(),kind:z.enum(['Pledge','RecurringPayment','OneTime']),amountCents:z.number().int().min(limits.amountMin).max(limits.amountMax),frequency:z.enum(FREQUENCIES).nullable().default(null),supporterName:z.string().trim().min(1).max(120),supporterEmail:z.email().max(254),message:z.string().trim().max(1000).default(''),acknowledged:z.literal(true)}).strict().parse(req.body);
  if((p.kind==='OneTime')===(p.frequency!==null))fail(400,'Choose a frequency for a recurring request, or none for a one-time request');
  rate('submission',client(req),limits.submissionsPerWindow);
  const result=tx(()=>{
   const existing=db.prepare('SELECT * FROM public_giving_submissions WHERE tenant_id=? AND request_id=?').get(tenantId,p.requestId);
   if(existing){if(existing.amount_cents!==p.amountCents||existing.kind!==p.kind)fail(409,'This request was already received with different details');return {id:existing.id,replayed:true};}
   if(db.prepare('SELECT COUNT(*) n FROM public_giving_submissions WHERE tenant_id=?').get(tenantId).n>=limits.retainedSubmissions)fail(503,'This page is temporarily unavailable. Please contact the foundation office');
   const id=randomUUID();
   db.prepare('INSERT INTO public_giving_submissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,tenantId,p.requestId,p.kind,p.amountCents,p.frequency,p.supporterName,p.supporterEmail,p.message,'PendingStaffReview',client(req),time());
   audit(null,'receive_public_giving_submission',null,id,{submissionId:id,kind:p.kind,amountCents:p.amountCents,currency:'usd',channel:'Public unauthenticated page',income:'None recorded',constituent:'None created',consent:'Unchanged'});
   return {id,replayed:false};
  });
  res.status(201).json({received:true,submissionId:result.id,replayed:result.replayed,status:'PendingStaffReview',incomeRecorded:false,paymentTaken:false,nextStep:'A staff member reviews this request. Nothing has been charged and no gift has been recorded.',scope});
 }));

 // Browser return or unpaid callback. It never records income under any outcome.
 //
 // This endpoint is unauthenticated and takes no token, so its retained evidence is
 // bounded twice: repeats collapse on (tenant_id,reference,outcome), and the table
 // stops growing at retainedReturns. Past the ceiling the caller still gets the same
 // truthful answer — the browser must always be told no payment was verified — but
 // nothing further is retained, and the append-only audit is written only when a row
 // is actually recorded, so neither table can be grown without bound from outside.
 app.get('/api/public/giving/return',route((req,res)=>{
  const q=z.object({reference:z.string().trim().min(1).max(limits.referenceChars).regex(/^[A-Za-z0-9._:-]+$/,'Unsupported reference').default('none'),outcome:z.enum(['returned','cancelled','unpaid','failed']).default('returned')}).strict().parse(req.query);
  const retained=tx(()=>{
   if(db.prepare('SELECT COUNT(*) n FROM public_giving_returns WHERE tenant_id=?').get(tenantId).n>=limits.retainedReturns)return false;
   const written=db.prepare('INSERT INTO public_giving_returns VALUES(?,?,?,?,0,?) ON CONFLICT DO NOTHING').run(randomUUID(),tenantId,q.reference,q.outcome,time()).changes>0;
   if(written)audit(null,'record_public_giving_return',null,null,{reference:q.reference,outcome:q.outcome,income:'None recorded',gift:'None created'});
   return written;
  });
  res.json({outcome:q.outcome,incomeRecorded:false,giftRecorded:false,paymentVerified:false,evidenceRetained:retained,message:'Returning to this page does not verify a payment or record a gift.',scope});
 }));

 app.post('/api/public/giving/self-service/view',route((req,res)=>{
  const p=z.object({token:z.string().min(40).max(800)}).strict().parse(req.body);
  const token=verifyToken(req,p.token);
  const result=tx(()=>{const view=service().donorView(token.hash);recordUse(token,'view');return view;});
  res.json({intention:result,canCancel:result.status!=='Cancelled',scope});
 }));

 app.post('/api/public/giving/self-service/cancel',route((req,res)=>{
  const p=z.object({token:z.string().min(40).max(800),version:z.number().int().positive(),reason:z.string().trim().min(1).max(500)}).strict().parse(req.body);
  const token=verifyToken(req,p.token);
  const result=tx(()=>{const cancelled=service().donorCancel(token.hash,{version:p.version,reason:p.reason});recordUse(token,'cancel');return cancelled;});
  res.json({...result,consentChanged:false,financialHistoryChanged:false,message:'This recurring intention is cancelled. Gifts already recorded are unchanged.',scope});
 }));

 app.use('/api/public/giving',(req,res)=>res.status(404).json({error:'Endpoint not found'}));
 return {close(){buckets.clear();}};
}
