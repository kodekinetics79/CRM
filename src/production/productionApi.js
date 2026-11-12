let csrfToken='';

export class ProductionApiError extends Error{
 constructor(message,{status=0,code='REQUEST_FAILED'}={}){super(message);this.name='ProductionApiError';this.status=status;this.code=code;}
}

export const setProductionCsrf=value=>{csrfToken=typeof value==='string'?value:'';};
export const clearProductionSession=()=>{csrfToken='';};
export const hasProductionCsrf=()=>Boolean(csrfToken);

const mutation=method=>!['GET','HEAD','OPTIONS'].includes(method);

export async function productionRequest(path,{method='GET',body,headers={},signal,response='json'}={}){
 const verb=String(method).toUpperCase(),requestHeaders={...headers};
 let payload=body;
 if(body!==undefined&&typeof body!=='string'&&!(typeof FormData!=='undefined'&&body instanceof FormData)){
  requestHeaders['Content-Type']='application/json';payload=JSON.stringify(body);
 }
 if(mutation(verb)&&csrfToken)requestHeaders['X-CSRF-Token']=csrfToken;
 let result;
 try{result=await fetch(`/api${path}`,{method:verb,credentials:'same-origin',headers:requestHeaders,body:payload,signal});}
 catch(error){if(error?.name==='AbortError')throw error;throw new ProductionApiError('The workspace could not be reached.',{code:'NETWORK_ERROR'});}
 const type=result.headers.get('content-type')||'';
 let data=null;
 try{data=response==='text'||type.includes('text/csv')?await result.text():result.status===204?null:await result.json();}
 catch{throw new ProductionApiError('The server returned an unreadable response.',{status:result.status,code:'UNREADABLE_RESPONSE'});}
 if(!result.ok){if(result.status===401)clearProductionSession();throw new ProductionApiError(data?.error||'Request was refused.',{status:result.status,code:data?.code||'REQUEST_REFUSED'});}
 if(data?.csrfToken)setProductionCsrf(data.csrfToken);
 return data;
}

export async function restoreProductionSession({signal}={}){
 const session=await productionRequest('/auth/me',{signal});
 if(!session?.csrfToken)throw new ProductionApiError('The session could not restore write protection.',{status:500,code:'CSRF_UNAVAILABLE'});
 setProductionCsrf(session.csrfToken);return session;
}

export const productionApi=Object.freeze({request:productionRequest,restore:restoreProductionSession,setCsrf:setProductionCsrf,clear:clearProductionSession,synthetic:false});
