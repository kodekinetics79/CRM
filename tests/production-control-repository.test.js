import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createControlRepository} from '../server/production/controlRepository.js';
import {PersistenceError,PERSISTENCE_CODES} from '../server/persistence/index.js';

const now='2026-11-11T15:00:00.000Z';
const clock=()=>new Date(now);
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');

function scriptedPool(responder){
  const calls=[];
  const session={async query(text,values=[]){
    const sql=String(text).trim();
    calls.push({sql,values});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[],rowCount:0};
    return responder(sql,values,calls);
  }};
  return {calls,async withAdminSession(fn){return fn(session);}};
}

const auditRow={audit_id:'1',tenant_id:null,identity_id:null,actor_identity_id:null,action:'test',target_type:'identity',target_id:'target',details:{},at:now};
const auditResponse=sql=>sql.includes('INSERT INTO wimblo_platform.control_audit')?{rows:[auditRow],rowCount:1}:null;

test('identity email is normalized once and a case-insensitive duplicate remains a conflict',async()=>{
  const identityId=randomUUID();
  const pool=scriptedPool((sql,values)=>{
    if(auditResponse(sql))return auditResponse(sql);
    if(sql.includes('INSERT INTO wimblo_platform.global_identities'))return {rows:[{
      identity_id:identityId,normalized_email:values[1],display_name:'Ada Lovelace',password_hash:'hash',status:'active',security_version:1,created_at:now,updated_at:now
    }],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const repository=createControlRepository({pool,clock});
  const created=await repository.createIdentity({identityId,email:'  ADA@Example.COM ',displayName:'Ada Lovelace',passwordHash:'hash'});
  assert.equal(created.normalizedEmail,'ada@example.com');
  const insert=pool.calls.find(call=>call.sql.includes('INSERT INTO wimblo_platform.global_identities'));
  assert.equal(insert.values[1],'ada@example.com');

  const duplicatePool=scriptedPool(sql=>{
    if(sql.includes('INSERT INTO wimblo_platform.global_identities'))throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'duplicate normalized email');
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(()=>createControlRepository({pool:duplicatePool,clock}).createIdentity({identityId:randomUUID(),email:'ada@example.com',displayName:'Other Ada',passwordHash:'other'}),error=>error.code===PERSISTENCE_CODES.CONFLICT);
});

test('identity and membership UUIDs are caller-independent immutable values returned exactly',async()=>{
  const identityId=randomUUID(),membershipId=randomUUID(),tenantId=randomUUID();
  const pool=scriptedPool((sql,values)=>{
    if(auditResponse(sql))return auditResponse(sql);
    if(sql.includes('INSERT INTO wimblo_platform.memberships'))return {rows:[{
      membership_id:membershipId,tenant_id:tenantId,identity_id:identityId,role:'staff',status:'active',version:1,created_at:now,updated_at:now
    }],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const membership=await createControlRepository({pool,clock}).createMembership({membershipId,tenantId,identityId,role:'staff'});
  assert.equal(membership.membershipId,membershipId);
  assert.equal(membership.identityId,identityId);
  assert.equal(pool.calls.find(call=>call.sql.includes('INSERT INTO wimblo_platform.memberships')).values[0],membershipId);
});

test('one identity can hold separate membership records in two tenants',async()=>{
  const identityId=randomUUID(),tenantA=randomUUID(),tenantB=randomUUID();
  const rows=[
    {membership_id:randomUUID(),tenant_id:tenantA,identity_id:identityId,role:'owner',status:'active',version:1,created_at:now,updated_at:now},
    {membership_id:randomUUID(),tenant_id:tenantB,identity_id:identityId,role:'viewer',status:'active',version:1,created_at:now,updated_at:now}
  ];
  let index=0;
  const pool=scriptedPool(sql=>{
    if(auditResponse(sql))return auditResponse(sql);
    if(sql.includes('INSERT INTO wimblo_platform.memberships'))return {rows:[rows[index++]],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const repository=createControlRepository({pool,clock});
  const first=await repository.createMembership({membershipId:rows[0].membership_id,tenantId:tenantA,identityId,role:'owner'});
  const second=await repository.createMembership({membershipId:rows[1].membership_id,tenantId:tenantB,identityId,role:'viewer'});
  assert.notEqual(first.membershipId,second.membershipId);
  assert.deepEqual([first.tenantId,second.tenantId],[tenantA,tenantB]);
});

test('membership mutation refuses a stale expected version instead of overwriting',async()=>{
  const pool=scriptedPool(sql=>{
    if(sql.includes('UPDATE wimblo_platform.memberships'))return {rows:[],rowCount:0};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const repository=createControlRepository({pool,clock});
  await assert.rejects(()=>repository.changeMembership({membershipId:randomUUID(),role:'admin',status:'active',expectedVersion:3}),error=>{
    assert.equal(error.code,PERSISTENCE_CODES.CONFLICT);
    assert.match(error.message,/version conflict/i);
    return true;
  });
  assert.ok(pool.calls.some(call=>call.sql==='ROLLBACK'));
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});

test('invitation persistence receives only a SHA-256 token hash and returns no token material',async()=>{
  const invitationId=randomUUID(),tenantId=randomUUID(),createdBy=randomUUID();
  const token='single-use-invitation-token';
  const pool=scriptedPool((sql,values)=>{
    if(auditResponse(sql))return auditResponse(sql);
    if(sql.includes('INSERT INTO wimblo_platform.invitations'))return {rows:[{
      invitation_id:invitationId,tenant_id:tenantId,normalized_email:'person@example.com',role:'staff',status:'pending',created_by:createdBy,consumed_by:null,expires_at:'2026-11-12T15:00:00.000Z',consumed_at:null,revoked_at:null,version:1,created_at:now
    }],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const invitation=await createControlRepository({pool,clock}).createInvitation({invitationId,tenantId,token,email:'Person@Example.com',role:'staff',createdBy,expiresAt:'2026-11-12T15:00:00.000Z'});
  const call=pool.calls.find(entry=>entry.sql.includes('INSERT INTO wimblo_platform.invitations'));
  assert.ok(call.values.includes(hash(token)));
  assert.equal(call.values.includes(token),false);
  assert.equal(JSON.stringify(invitation).includes(token),false);
  assert.equal(Object.hasOwn(invitation,'tokenHash'),false);
});

test('control audit is append-only at the repository surface',async()=>{
  const pool=scriptedPool(sql=>{
    if(auditResponse(sql))return {rows:[{...auditRow,audit_id:'42'}],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  });
  const repository=createControlRepository({pool,clock});
  const audit=await repository.appendAudit({action:'identity.reviewed',targetType:'identity',targetId:randomUUID(),details:{source:'test'}});
  assert.equal(audit.auditId,42);
  assert.equal(typeof repository.updateAudit,'undefined');
  assert.equal(typeof repository.deleteAudit,'undefined');
  assert.equal(pool.calls.some(call=>/UPDATE|DELETE/.test(call.sql)&&call.sql.includes('control_audit')),false);
});

test('session lookup hashes the opaque token and never queries or returns its plaintext',async()=>{
  const token='opaque-browser-session-token',identityId=randomUUID(),tenantId=randomUUID();
  const pool=scriptedPool((sql,values)=>{
    if(sql.includes('FROM wimblo_platform.opaque_sessions')){
      assert.equal(values[0],hash(token));
      assert.equal(sql.includes(token),false);
      return {rows:[{token_hash:values[0],tenant_id:tenantId,identity_id:identityId,membership_version:2,security_version:4,mfa_verified_at:now,created_at:now,expires_at:'2026-11-12T15:00:00.000Z',revoked_at:null}],rowCount:1};
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const session=await createControlRepository({pool,clock}).getSession(token);
  assert.equal(session.identityId,identityId);
  assert.equal(Object.hasOwn(session,'tokenHash'),false);
  assert.equal(JSON.stringify(session).includes(token),false);
});

test('membership creation rolls back both membership and audit when the transaction fails',async()=>{
  const pool=scriptedPool(sql=>{
    if(sql.includes('INSERT INTO wimblo_platform.memberships'))throw new PersistenceError(PERSISTENCE_CODES.CONFLICT,'synthetic membership failure');
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(()=>createControlRepository({pool,clock}).createMembership({membershipId:randomUUID(),tenantId:randomUUID(),identityId:randomUUID(),role:'staff'}),error=>error.code===PERSISTENCE_CODES.CONFLICT);
  assert.deepEqual(pool.calls.map(call=>call.sql),[
    'BEGIN',
    pool.calls[1].sql,
    'ROLLBACK'
  ]);
  assert.equal(pool.calls.some(call=>call.sql.includes('control_audit')),false);
});
