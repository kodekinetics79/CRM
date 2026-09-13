// Select the authorized workspace before requesting any business records.
export async function loadWorkspaceSession(api) {
 const authentication=await api('/auth/me');
 if(authentication.mfaEnrollmentRequired)return {kind:'enrollment',authentication};
 if(authentication.user?.role==='event-helper')return {kind:'helper',authentication};
 if(!['admin','staff','viewer'].includes(authentication.user?.role)){
  const error=new Error('This account has no supported workspace access.');error.status=403;throw error;
 }
 return {kind:'workspace',workspace:await api('/workspace')};
}
