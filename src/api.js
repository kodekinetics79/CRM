let csrfToken='';
const MUTATING=new Set(['POST','PUT','PATCH','DELETE']);
// A form holds one Idempotency-Key per instance and publishes it here only for the synchronous start of its save,
// so the first mutating request that save issues carries it without every caller threading it through.
export const PENDING_IDEMPOTENCY_KEY=Symbol.for('wimblo.pendingIdempotencyKey');
export function setCsrf(value){csrfToken=value || '';}
export function newIdempotencyKey(){const c=globalThis.crypto;if(typeof c?.randomUUID==='function')return c.randomUUID();const b=c.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export function withIdempotencyKey(key,fn){const previous=globalThis[PENDING_IDEMPOTENCY_KEY];globalThis[PENDING_IDEMPOTENCY_KEY]=key;try{return fn();}finally{globalThis[PENDING_IDEMPOTENCY_KEY]=previous;}}
// Server refusals that prove this attempt changed nothing, so a form may start a fresh key for the next attempt.
// Idempotency refusals (409 in progress/completed, 422 key reused) and uncertain failures keep the key.
export function rejectedWithoutEffect(error){return [400,403,404,422].includes(error?.status)&&!String(error?.code||'').startsWith('IDEMPOTENCY_');}
export async function api(path,{method='GET',body,idempotencyKey}={}) {
 let key=null;if(MUTATING.has(String(method).toUpperCase())){const pending=globalThis[PENDING_IDEMPOTENCY_KEY];key=idempotencyKey||pending||newIdempotencyKey();if(!idempotencyKey&&pending)globalThis[PENDING_IDEMPOTENCY_KEY]=undefined;}
 const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'X-CSRF-Token':csrfToken}:{}),...(key?{'Idempotency-Key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const payload=await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
 if(!response.ok){const detail=payload.fields?.map(f=>`${f.path.join('.')}: ${f.message}`).join('; ');const error=new Error(detail || payload.error || 'This action could not be completed.');error.status=response.status;if(payload.code)error.code=payload.code;throw error;}
 if(payload.csrfToken)setCsrf(payload.csrfToken);
 return payload;
}
