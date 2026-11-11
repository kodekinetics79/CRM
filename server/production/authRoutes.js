import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

const cookieValue=(header,name)=>String(header||'').split(';').map(value=>value.trim()).map(value=>value.split('=')).find(([key])=>key===name)?.slice(1).join('=')||null;
const forbidden=message=>persistenceFail(PERSISTENCE_CODES.ISOLATION,message);
const unauthenticated=()=>{const error=new Error('Authentication is required.');error.status=401;error.code='AUTHENTICATION_REQUIRED';throw error;};

export function requireIdentitySession(sessionService,{allowUnverifiedMfa=true}={}){
 return async(req,res,next)=>{try{const token=cookieValue(req.headers.cookie,sessionService.cookieName),session=await sessionService.authenticate(token,{allowUnverifiedMfa});if(!session)return unauthenticated();req.productionSession=session;req.productionSessionToken=token;next();}catch(error){next(error);}};
}
export function requireTenantSession(sessionService){return requireIdentitySession(sessionService,{allowUnverifiedMfa:false});}
export function requireCsrf(sessionService,appOrigin){
 return (req,res,next)=>{try{if(req.get('Origin')!==appOrigin)return forbidden('The request origin was refused.');if(!sessionService.verifyCsrf(req.productionSession,req.get('X-CSRF-Token')))return forbidden('CSRF verification failed.');next();}catch(error){next(error);}};
}
export function requireRecentAuthentication(sessionService){return(req,res,next)=>{try{if(!sessionService.isRecent(req.productionSession))return forbidden('Recent authentication is required.');next();}catch(error){next(error);}};}

export function installProductionAuthRoutes(app,{identityService,mfaService,sessionService,appOrigin}){
 if(!app||typeof app.get!=='function'||!sessionService)throw new TypeError('Production auth routes require an Express app and session service.');
 const identity=requireIdentitySession(sessionService),tenant=requireTenantSession(sessionService),csrf=requireCsrf(sessionService,appOrigin),recent=requireRecentAuthentication(sessionService);
 app.post('/api/auth/login',async(req,res)=>{
  const account=await identityService.authenticatePassword(req.body||{}),memberships=await identityService.listActiveMemberships(account.identityId);
  if(!memberships.length)return forbidden('No active tenant membership is available.');
  const factor=await mfaService.status(account.identityId);
  if(factor.enabled){const challenge=await mfaService.createChallenge(account.identityId);return res.json({mfaRequired:true,...challenge});}
  const issued=await sessionService.issue({identity:account,membership:memberships[0],mfaVerifiedAt:null,recentAuthenticatedAt:new Date()});res.setHeader('Set-Cookie',issued.cookie);res.json({mfaEnrollmentRequired:true,csrfToken:issued.csrfToken});
 });
 app.post('/api/auth/mfa/verify',async(req,res)=>{const verified=await mfaService.verifyChallenge(req.body?.challengeToken,req.body?.code),memberships=await identityService.listActiveMemberships(verified.identity.identityId);if(!memberships.length)return forbidden('No active tenant membership is available.');const issued=await sessionService.issue({identity:verified.identity,membership:memberships[0],mfaVerifiedAt:new Date(),recentAuthenticatedAt:new Date()});res.setHeader('Set-Cookie',issued.cookie);res.json({ok:true,csrfToken:issued.csrfToken});});
 app.post('/api/auth/mfa/enroll',identity,csrf,recent,async(req,res)=>res.json(await mfaService.beginEnrollment(req.productionSession.identityId)));
 app.post('/api/auth/mfa/confirm',identity,csrf,recent,async(req,res)=>{const result=await mfaService.confirmEnrollment(req.productionSession.identityId,req.body?.code);const ended=await sessionService.logout(req.productionSessionToken);res.setHeader('Set-Cookie',ended.cookie);res.json(result);});
 app.get('/api/auth/tenants',tenant,async(req,res)=>res.json({memberships:await identityService.listActiveMemberships(req.productionSession.identityId)}));
 app.post('/api/auth/tenant',tenant,csrf,async(req,res)=>{const issued=await sessionService.switchTenant(req.productionSessionToken,req.body?.membershipId);res.setHeader('Set-Cookie',issued.cookie);res.json({csrfToken:issued.csrfToken,tenantId:issued.session.tenantId});});
 app.get('/api/auth/me',tenant,(req,res)=>res.json({identity:req.productionSession.identity,membership:req.productionSession.membership,mfaVerifiedAt:req.productionSession.mfaVerifiedAt}));
 app.post('/api/auth/logout',identity,csrf,async(req,res)=>{const result=await sessionService.logout(req.productionSessionToken);res.setHeader('Set-Cookie',result.cookie);res.json({ok:true});});
 return {requireIdentitySession:identity,requireTenantSession:tenant,requireCsrf:csrf,requireRecentAuthentication:recent};
}
