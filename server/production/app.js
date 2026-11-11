import express from 'express';
import helmet from 'helmet';
import {promisify} from 'node:util';
import {createHmac,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {createControlRepository} from './controlRepository.js';
import {createIdentityService} from './identityService.js';
import {createGlobalMfaService} from './mfaService.js';
import {createSessionService} from './sessionService.js';
import {createModuleService} from './moduleService.js';
import {createCrmRepository} from './crmRepository.js';
import {createCrmService} from './crmService.js';
import {installCrmRoutes} from './crmRoutes.js';
import {installProductionAuthRoutes} from './authRoutes.js';
import {installModuleRoutes} from './moduleRoutes.js';

const derive=promisify(scrypt);
const nowMs=clock=>{const value=clock();const date=value instanceof Date?value:new Date(value);if(Number.isNaN(date.getTime()))throw new TypeError('Production clock is invalid.');return date.getTime();};
const passwordHash=async password=>{const salt=randomBytes(16).toString('hex'),digest=await derive(password,salt,64);return `scrypt-v1:${salt}:${digest.toString('hex')}`;};
const verifyPassword=async(password,stored)=>{try{const [version,salt,encoded]=String(stored).split(':');if(version!=='scrypt-v1'||!salt||!/^[a-f0-9]{128}$/.test(encoded))return false;const actual=await derive(password,salt,64),expected=Buffer.from(encoded,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}catch{return false;}};
const derivedSecret=(secret,purpose)=>createHmac('sha256',secret).update(`wimblo/${purpose}/v1`).digest('base64url');

function createRateLimit({clock,limit=10,windowMs=5*60_000,maxKeys=10_000}){
 const buckets=new Map();
 return (req,res,next)=>{
  const time=nowMs(clock),key=req.ip||'unknown';let bucket=buckets.get(key);
  if(!bucket||bucket.resetAt<=time){bucket={count:0,resetAt:time+windowMs};buckets.set(key,bucket);}
  bucket.count++;
  if(buckets.size>maxKeys)for(const [candidate,value] of buckets){if(value.resetAt<=time||buckets.size>maxKeys)buckets.delete(candidate);else break;}
  res.setHeader('RateLimit-Limit',String(limit));res.setHeader('RateLimit-Remaining',String(Math.max(0,limit-bucket.count)));res.setHeader('RateLimit-Reset',String(Math.ceil(bucket.resetAt/1000)));
  if(bucket.count>limit){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((bucket.resetAt-time)/1000))));return res.status(429).json({error:'Too many authentication attempts.',code:'RATE_LIMITED'});}
  next();
 };
}

function defaultServices({config,controlPool,tenantPool,clock}){
 const repository=createControlRepository({pool:controlPool,clock:()=>new Date(nowMs(clock))});
 const moduleService=createModuleService({tenantPool,clock:()=>new Date(nowMs(clock))});
 const crmRepository=createCrmRepository({tenantPool,clock:()=>new Date(nowMs(clock))});
 return {
  identityService:createIdentityService({repository,passwordHash,verifyPassword,invitationSecret:derivedSecret(config.sessionSecret,'invitation-signing'),clock:()=>new Date(nowMs(clock))}),
  mfaService:createGlobalMfaService({repository,key:config.mfaEncryptionKey,clock:()=>nowMs(clock),issuer:'Wimblo'}),
  sessionService:createSessionService({repository,clock:()=>nowMs(clock),cookieName:config.cookieName}),
  moduleService,
  crmRepository,
  crmService:createCrmService({repository:crmRepository,moduleService})
 };
}

export function createProductionApp({config,controlPool,tenantPool,clock=()=>new Date(),services=null}={}){
 if(!config||config.processRole!=='web')throw new TypeError('Production application requires the web process role.');
 if(!controlPool||typeof controlPool.healthy!=='function'||!tenantPool||typeof tenantPool.healthy!=='function')throw new TypeError('Production application requires isolated control and tenant pools.');
 const app=express(),resolved=services||defaultServices({config,controlPool,tenantPool,clock});
 app.disable('x-powered-by');app.set('trust proxy',config.limits.trustProxyHops);
 app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],baseUri:["'none'"],frameAncestors:["'none'"],objectSrc:["'none'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"]}},crossOriginEmbedderPolicy:{policy:'require-corp'}}));
 app.use((req,res,next)=>{const forwarded=req.get('X-Forwarded-Proto');if(!req.socket.encrypted&&forwarded!=='https')return res.status(400).json({error:'HTTPS is required.',code:'HTTPS_REQUIRED'});res.setHeader('Cache-Control','no-store');next();});
 app.use((req,res,next)=>{
  const origin=req.get('Origin');
  if(origin&&origin!==config.appOrigin)return res.status(403).json({error:'Origin is not allowed.',code:'ORIGIN_REFUSED'});
  if(origin===config.appOrigin){res.setHeader('Access-Control-Allow-Origin',config.appOrigin);res.setHeader('Access-Control-Allow-Credentials','true');res.vary('Origin');}
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-CSRF-Token');return res.status(204).end();}
  next();
 });
 app.use(express.json({limit:'64kb',strict:true,type:'application/json'}));
 app.get('/health',(req,res)=>res.json({status:'ok',service:'wimblo-web'}));
 app.get('/ready',async(req,res)=>{try{const [control,tenant]=await Promise.all([controlPool.healthy(),tenantPool.healthy()]);return control&&tenant?res.json({status:'ready'}):res.status(503).json({status:'unavailable'});}catch{return res.status(503).json({status:'unavailable'});}});
 app.use(['/api/auth/login','/api/auth/mfa/verify'],createRateLimit({clock}));
 const auth=installProductionAuthRoutes(app,{identityService:resolved.identityService,mfaService:resolved.mfaService,sessionService:resolved.sessionService,appOrigin:config.appOrigin});
 app.locals.moduleService=resolved.moduleService;installModuleRoutes(app,{moduleService:resolved.moduleService,requireTenantSession:auth.requireTenantSession,requireCsrf:auth.requireCsrf,requireRecentAuthentication:auth.requireRecentAuthentication});
 if(resolved.crmService)installCrmRoutes(app,{crmService:resolved.crmService,requireTenantSession:auth.requireTenantSession,requireCsrf:auth.requireCsrf,requireRecentAuthentication:auth.requireRecentAuthentication});
 app.use((req,res)=>res.status(404).json({error:'Not found.',code:'NOT_FOUND'}));
 app.use((error,req,res,next)=>{if(res.headersSent)return next(error);const candidate=error?.type==='entity.too.large'?413:error?.status,status=Number.isInteger(candidate)&&candidate>=400&&candidate<=599?candidate:500;const safe=status===413?{error:'Request body is too large.',code:'BODY_TOO_LARGE'}:status===429?{error:'Too many requests.',code:'RATE_LIMITED'}:status>=500?{error:'Internal service error.',code:'INTERNAL_ERROR'}:{error:'Request was refused.',code:'REQUEST_REFUSED'};res.status(status).json(safe);});
 return app;
}
