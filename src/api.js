let csrfToken='';
export function setCsrf(value){csrfToken=value || '';}
export async function api(path,{method='GET',body}={}) {
 const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'X-CSRF-Token':csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const payload=await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
 if(!response.ok){const detail=payload.fields?.map(f=>`${f.path.join('.')}: ${f.message}`).join('; ');const error=new Error(detail || payload.error || 'This action could not be completed.');error.status=response.status;throw error;}
 if(payload.csrfToken)setCsrf(payload.csrfToken);
 return payload;
}
