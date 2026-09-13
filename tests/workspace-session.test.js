import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWorkspaceSession} from '../src/workspaceSession.js';

test('helper authentication never requests or returns broad workspace data',async()=>{
 const calls=[],authentication={user:{id:'helper',role:'event-helper'},csrfToken:'synthetic'};
 const result=await loadWorkspaceSession(async path=>{calls.push(path);if(path==='/auth/me')return authentication;throw Error('Financial workspace must not be requested');});
 assert.deepEqual(calls,['/auth/me']);assert.deepEqual(result,{kind:'helper',authentication});assert.equal(Object.hasOwn(result,'workspace'),false);
});
test('enrollment-only and unsupported roles cannot fetch business records',async()=>{
 for(const [authentication,kind] of [[{user:{role:'admin'},mfaEnrollmentRequired:true},'enrollment'],[{user:{role:'unknown'}},null]]){
  const calls=[],api=async path=>{calls.push(path);return authentication;};
  if(kind)assert.equal((await loadWorkspaceSession(api)).kind,kind);else await assert.rejects(()=>loadWorkspaceSession(api),error=>error.status===403);
  assert.deepEqual(calls,['/auth/me']);
 }
});
test('ordinary roles retain authenticated full-workspace loading',async()=>{
 for(const role of ['admin','staff','viewer']){
  const calls=[],workspace={user:{role},data:{gifts:[]}},result=await loadWorkspaceSession(async path=>{calls.push(path);return path==='/auth/me'?{user:{role}}:workspace;});
  assert.deepEqual(calls,['/auth/me','/workspace']);assert.equal(result.workspace,workspace);assert.equal(result.kind,'workspace');
 }
});
