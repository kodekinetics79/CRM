// Authentication may issue an enrollment-only session; business access is separate.
export function workspaceMfaRequired(production){return production===true;}
export function workspaceMfaSessionAllowed(production,factor,session){
 if(!factor||!session)return false;
 if(factor.enabled===true)return factor.available===true&&session.mfa_verified===1;
 return factor.enabled===false&&session.mfa_verified!==1&&!workspaceMfaRequired(production);
}
// Durable, explicitly armed work is account-authorized, independent of logout.
export function workspaceMfaOwnerAllowed(production,factor){
 if(!factor)return false;
 return factor.enabled===true?factor.available===true:factor.enabled===false&&!workspaceMfaRequired(production);
}
