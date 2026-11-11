import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createSessionService} from '../server/production/sessionService.js';
import {installProductionAuthRoutes} from '../server/production/authRoutes.js';

const start=Date.parse('2026-11-11T15:00:00.000Z');

function fixture(){
 let time=start;
 const tenantA=randomUUID(),tenantB=randomUUID(),identityId=randomUUID();
 const identity={identityId,normalizedEmail:'person@example.com',displayName:'Person',status:'active',securityVersion:1};
 const memberships=new Map([
  ['a',{membershipId:randomUUID(),tenantId:tenantA,identityId,role:'owner',status:'active',version:1}],
  ['b',{membershipId:randomUUID(),tenantId:tenantB,identityId,role:'viewer',status:'active',version:1}]
 ]),tenants=new Map([[tenantA,{tenantId:tenantA,status:'active',lifecycleVersion:1}],[tenantB,{tenantId:tenantB,status:'active',lifecycleVersion:1}]]),sessions=new Map();
 const repository={
  created:[],revoked:[],
  async createSession(input){this.created.push(input);const row={tenantId:input.tenantId,identityId:input.identityId,membershipVersion:input.membershipVersion,securityVersion:input.securityVersion,mfaVerifiedAt:input.mfaVerifiedAt,recentAuthenticatedAt:input.recentAuthenticatedAt,csrfHash:input.csrfHash,createdAt:new Date(time).toISOString(),expiresAt:new Date(input.expiresAt).toISOString(),revokedAt:null};sessions.set(input.token,row);return {...row};},
  async getSession(token){const row=sessions.get(token);return row?{...row}:null;},
  async revokeSessions({identityId:target,tenantId=null,token=null}){let count=0;for(const [key,row] of sessions)if(row.identityId===target&&(!tenantId||row.tenantId===tenantId)&&(!token||key===token)&&!row.revokedAt){row.revokedAt=new Date(time).toISOString();count++;}this.revoked.push({target,tenantId,token,count});return {revoked:count};},
  async getIdentity(){return {...identity};},
  async getMembership(id){const row=[...memberships.values()].find(value=>value.membershipId===id);return row&&{...row};},
  async listMemberships(){return [...memberships.values()].map(value=>({...value}));},
  async getTenantState(id){return {...tenants.get(id)};}
 };
 const service=createSessionService({repository,clock:()=>time,sessionTtlMs:60*60*1000,cookieName:'wimblo_session'});
 return {repository,service,identity,memberships,tenants,tenantA,tenantB,advance:ms=>time+=ms};
}

test('issued sessions use opaque tokens and a host-only hardened cookie',async()=>{
 const f=fixture(),membership=f.memberships.get('a');
 const issued=await f.service.issue({identity:f.identity,membership,mfaVerifiedAt:new Date(start),recentAuthenticatedAt:new Date(start)});
 assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);
 assert.match(issued.csrfToken,/^[A-Za-z0-9_-]{43}$/);
 assert.match(issued.cookie,/^wimblo_session=/);
 for(const flag of ['Secure','HttpOnly','SameSite=Lax','Path=/'])assert.match(issued.cookie,new RegExp(flag));
 assert.doesNotMatch(issued.cookie,/Domain=/i);
 assert.equal(f.repository.created[0].token,issued.token);
 assert.notEqual(f.repository.created[0].csrfHash,issued.csrfToken);
});

test('tenant switching requires an active membership and rotates the session token',async()=>{
 const f=fixture(),first=await f.service.issue({identity:f.identity,membership:f.memberships.get('a'),mfaVerifiedAt:new Date(start),recentAuthenticatedAt:new Date(start)});
 const switched=await f.service.switchTenant(first.token,f.memberships.get('b').membershipId);
 assert.notEqual(switched.token,first.token);
 assert.equal(switched.session.tenantId,f.tenantB);
 assert.equal((await f.service.authenticate(first.token)),null);
 const current=await f.service.issue({identity:f.identity,membership:f.memberships.get('a'),mfaVerifiedAt:new Date(start),recentAuthenticatedAt:new Date(start)});
 f.memberships.get('b').status='suspended';
 await assert.rejects(()=>f.service.switchTenant(current.token,f.memberships.get('b').membershipId),/active membership/i);
});

test('logout revokes the current session and all state-changing middleware requires exact origin and CSRF',async t=>{
 const f=fixture(),issued=await f.service.issue({identity:f.identity,membership:f.memberships.get('a'),mfaVerifiedAt:new Date(start),recentAuthenticatedAt:new Date(start)});
 const app=express();app.use(express.json());installProductionAuthRoutes(app,{sessionService:f.service,identityService:{},mfaService:{},appOrigin:'https://app.wimblo.example'});app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`;
 const request=(origin,csrf)=>fetch(`${base}/api/auth/logout`,{method:'POST',headers:{Cookie:`wimblo_session=${issued.token}`,Origin:origin,...(csrf?{'X-CSRF-Token':csrf}:{})}});
 assert.equal((await request('https://evil.example',issued.csrfToken)).status,403);
 assert.equal((await request('https://app.wimblo.example','wrong')).status,403);
 assert.equal((await request('https://app.wimblo.example',issued.csrfToken)).status,200);
 assert.equal(await f.service.authenticate(issued.token),null);
});

test('every stale session mutation is refused and revoked on its next protected use',async()=>{
 const scenarios=[
  ['membership role/version',f=>{const row=f.memberships.get('a');row.role='staff';row.version++;}],
  ['membership suspension',f=>{const row=f.memberships.get('a');row.status='suspended';row.version++;}],
  ['tenant suspension',f=>{f.tenants.get(f.tenantA).status='suspended';}],
  ['password security version',f=>{f.identity.securityVersion++;}],
  ['MFA security version',f=>{f.identity.securityVersion++;}]
 ];
 for(const [name,mutate] of scenarios){
  const f=fixture(),issued=await f.service.issue({identity:f.identity,membership:f.memberships.get('a'),mfaVerifiedAt:new Date(start),recentAuthenticatedAt:new Date(start)});mutate(f);
  assert.equal(await f.service.authenticate(issued.token),null,name);
  assert.ok(f.repository.revoked.some(entry=>entry.token===issued.token&&entry.count===1),name);
 }
});

test('password-only sessions are limited to MFA enrollment and logout until a verified factor rotates them',async()=>{
 const f=fixture(),issued=await f.service.issue({identity:f.identity,membership:f.memberships.get('a'),mfaVerifiedAt:null,recentAuthenticatedAt:new Date(start)});
 const identitySession=await f.service.authenticate(issued.token,{allowUnverifiedMfa:true});
 assert.equal(identitySession.mfaVerifiedAt,null);
 assert.equal(await f.service.authenticate(issued.token),null);
});

test('password-only HTTP sessions cannot read identity or tenant membership data',async t=>{
 const f=fixture(),issued=await f.service.issue({identity:f.identity,membership:f.memberships.get('a'),mfaVerifiedAt:null,recentAuthenticatedAt:new Date(start)}),app=express();app.use(express.json());
 installProductionAuthRoutes(app,{sessionService:f.service,identityService:{listActiveMemberships:async()=>{throw new Error('membership data must not be read');}},mfaService:{beginEnrollment:async()=>({secret:'synthetic'})},appOrigin:'https://app.wimblo.example'});app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`,headers={Cookie:`wimblo_session=${issued.token}`};
 for(const path of ['/api/auth/me','/api/auth/tenants'])assert.equal((await fetch(base+path,{headers})).status,401,path);
});
