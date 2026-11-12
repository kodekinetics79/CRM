import express from 'express';
import helmet from 'helmet';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {createHmac,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {createControlRepository} from './controlRepository.js';
import {createIdentityService} from './identityService.js';
import {createGlobalMfaService} from './mfaService.js';
import {createSessionService} from './sessionService.js';
import {createModuleService} from './moduleService.js';
import {createCrmRepository} from './crmRepository.js';
import {createCrmService} from './crmService.js';
import {createCrmReportingService} from './crmReportingService.js';
import {createCrmImportService} from './crmImportService.js';
import {createJobRepository} from './jobRepository.js';
import {installCrmRoutes} from './crmRoutes.js';
import {installProductionAuthRoutes} from './authRoutes.js';
import {installModuleRoutes} from './moduleRoutes.js';

const derive=promisify(scrypt);
const nowMs=clock=>{const value=clock();const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))throw new TypeError('Production clock is invalid.');return date.getTime();};
const passwordHash=async password=>{const salt=randomBytes(16).toString('hex'),digest=await derive(password,salt,64);return `scrypt-v1:${salt}:${digest.toString('hex')}`;};
const verifyPassword=async(password,stored)=>{try{const [version,salt,encoded]=String(stored).split(':');if(version!=='scrypt-v1'||!salt||!/^[a-f0-9]{128}$/.test(encoded))return false;const actual=await derive(password,salt,64),expected=Buffer.from(encoded,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}catch{return false;}};
const derivedSecret=(secret,purpose)=>createHmac('sha256',secret).update(`wimblo/${purpose}/v1`).digest('base64url');

function createRateLimit({clock,limit=10,windowMs=5*60_000,maxKeys=10_000,keyFor=req=>req.ip||'unknown',rejectAtCapacity=false}){
 const buckets=new Map();
 return (req,res,next)=>{
  const time=nowMs(clock),key=String(keyFor(req));let bucket=buckets.get(key);
  if(bucket?.resetAt<=time){buckets.delete(key);bucket=null;}
  if(!bucket){for(const [candidate,value] of buckets)if(value.resetAt<=time)buckets.delete(candidate);if(buckets.size>=maxKeys){if(rejectAtCapacity){res.setHeader('RateLimit-Limit',String(limit));res.setHeader('RateLimit-Remaining','0');res.setHeader('RateLimit-Reset',String(Math.ceil((time+windowMs)/1000)));res.setHeader('Retry-After',String(Math.max(1,Math.ceil(windowMs/1000))));return res.status(429).json({error:'Too many authentication attempts.',code:'RATE_LIMITED'});}buckets.delete(buckets.keys().next().value);}bucket={count:0,resetAt:time+windowMs};buckets.set(key,bucket);}
  bucket.count++;
  res.setHeader('RateLimit-Limit',String(limit));res.setHeader('RateLimit-Remaining',String(Math.max(0,limit-bucket.count)));res.setHeader('RateLimit-Reset',String(Math.ceil(bucket.resetAt/1000)));
  if(bucket.count>limit){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((bucket.resetAt-time)/1000))));return res.status(429).json({error:'Too many authentication attempts.',code:'RATE_LIMITED'});}
  next();
 };
}

function defaultServices({config,controlPool,tenantPool,clock}){
 const repository=createControlRepository({pool:controlPool,clock:()=>new Date(nowMs(clock))});
 const identityService=createIdentityService({repository,passwordHash,verifyPassword,invitationSecret:derivedSecret(config.sessionSecret,'invitation-signing'),clock:()=>new Date(nowMs(clock))});
 const moduleService=createModuleService({tenantPool,clock:()=>new Date(nowMs(clock))});
 const jobRepository=createJobRepository({tenantPool,clock:()=>new Date(nowMs(clock))});
 const crmRepository=createCrmRepository({tenantPool,jobRepository,clock:()=>new Date(nowMs(clock))});
 return {
  identityService,
  mfaService:createGlobalMfaService({repository,key:config.mfaEncryptionKey,clock:()=>nowMs(clock),issuer:'Wimblo'}),
  sessionService:createSessionService({repository,clock:()=>nowMs(clock),cookieName:config.cookieName}),
  moduleService,
  crmRepository,
  crmService:createCrmService({repository:crmRepository,moduleService,memberDirectory:identityService}),
  crmReportingService:createCrmReportingService({tenantPool,moduleService,clock:()=>new Date(nowMs(clock))}),
  crmImportService:createCrmImportService({tenantPool,moduleService,reconciliationSecret:derivedSecret(config.sessionSecret,'crm-import-reconciliation'),clock:()=>new Date(nowMs(clock))})
 };
}

export function createProductionApp({config,controlPool,tenantPool,clock=()=>new Date(),services=null}={}){
 if(!config||config.processRole!=='web')throw new TypeError('Production application requires the web process role.');
 if(!controlPool||typeof controlPool.healthy!=='function'||!tenantPool||typeof tenantPool.healthy!=='function')throw new TypeError('Production application requires isolated control and tenant pools.');
 const renderProxy=config.network?.trustedProxyProvider==='render';
 if(!renderProxy&&(!Array.isArray(config.network?.trustedProxyCidrs)||!config.network.trustedProxyCidrs.length))throw new TypeError('Production application requires an explicit trusted proxy allowlist.');
 const app=express(),resolved=services||defaultServices({config,controlPool,tenantPool,clock});
 app.disable('x-powered-by');app.set('trust proxy',renderProxy?true:config.network.trustedProxyCidrs);
 app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],baseUri:["'none'"],frameAncestors:["'none'"],objectSrc:["'none'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"]}},crossOriginEmbedderPolicy:{policy:'require-corp'}}));
 app.get('/health',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json({status:'ok',service:'wimblo-web'});});
 app.use((req,res,next)=>{const forwarded=req.get('X-Forwarded-Proto');if(forwarded!==undefined&&!/^(?:http|https)$/.test(forwarded))return res.status(400).json({error:'HTTPS is required.',code:'HTTPS_REQUIRED'});if(!req.secure)return res.status(400).json({error:'HTTPS is required.',code:'HTTPS_REQUIRED'});res.setHeader('Cache-Control','no-store');next();});
 app.use((req,res,next)=>{
  const origin=req.get('Origin');
  if(origin&&origin!==config.appOrigin)return res.status(403).json({error:'Origin is not allowed.',code:'ORIGIN_REFUSED'});
  if(origin===config.appOrigin){res.setHeader('Access-Control-Allow-Origin',config.appOrigin);res.setHeader('Access-Control-Allow-Credentials','true');res.vary('Origin');}
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-CSRF-Token,Idempotency-Key,X-Source-System,If-Match,X-Source-SHA256');return res.status(204).end();}
  next();
 });
 app.use('/api/crm/imports',express.text({limit:'1mb',type:'text/csv'}));
 app.use(express.json({limit:'64kb',strict:true,type:'application/json'}));
 app.get('/ready',async(req,res)=>{try{const [control,tenant]=await Promise.all([controlPool.healthy(),tenantPool.healthy()]);return control&&tenant?res.json({status:'ready'}):res.status(503).json({status:'unavailable'});}catch{return res.status(503).json({status:'unavailable'});}});
 app.use(['/api/auth/login','/api/auth/mfa/verify'],createRateLimit({clock}));
 const mfaConfirmationRateLimit=createRateLimit({clock,rejectAtCapacity:true,keyFor:req=>req.productionSession?.identityId?`identity:${req.productionSession.identityId}`:`ip:${req.ip||'unknown'}`});
 const auth=installProductionAuthRoutes(app,{identityService:resolved.identityService,mfaService:resolved.mfaService,sessionService:resolved.sessionService,appOrigin:config.appOrigin,mfaConfirmationRateLimit});
 app.locals.moduleService=resolved.moduleService;installModuleRoutes(app,{moduleService:resolved.moduleService,requireTenantSession:auth.requireTenantSession,requireCsrf:auth.requireCsrf,requireRecentAuthentication:auth.requireRecentAuthentication});
 if(resolved.crmService)installCrmRoutes(app,{crmService:resolved.crmService,crmReportingService:resolved.crmReportingService,crmImportService:resolved.crmImportService,requireTenantSession:auth.requireTenantSession,requireCsrf:auth.requireCsrf,requireRecentAuthentication:auth.requireRecentAuthentication});
 if(typeof config.root==='string')app.use(express.static(join(config.root,'dist'),{dotfiles:'deny',fallthrough:true,index:'index.html'}));
 app.use((req,res)=>res.status(404).json({error:'Not found.',code:'NOT_FOUND'}));
 app.use((error,req,res,next)=>{if(res.headersSent)return next(error);const candidate=error?.type==='entity.too.large'?413:error?.status,status=Number.isInteger(candidate)&&candidate>=400&&candidate<=599?candidate:500;const safe=status===413?{error:'Request body is too large.',code:'BODY_TOO_LARGE'}:status===429?{error:'Too many requests.',code:'RATE_LIMITED'}:status>=500?{error:'Internal service error.',code:'INTERNAL_ERROR'}:{error:'Request was refused.',code:'REQUEST_REFUSED'};res.status(status).json(safe);});
 return app;
}
