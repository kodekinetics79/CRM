import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

export function installModuleRoutes(app,{moduleService,requireTenantSession,requireCsrf,requireRecentAuthentication}){
 if(typeof requireRecentAuthentication!=='function')throw new TypeError('Capability lifecycle routes require recent-authentication middleware.');
 const admin=(req,res,next)=>{try{return ['owner','admin'].includes(req.productionSession?.membership?.role)?next():persistenceFail(PERSISTENCE_CODES.ISOLATION,'Administrator capability authority is required.');}catch(error){next(error);}};
 app.get('/api/modules',requireTenantSession,async(req,res)=>res.json({modules:await moduleService.list(req.productionSession.tenantId)}));
 for(const [path,method] of [['enable','enable'],['suspend','suspend'],['retire','beginRetirement'],['disable','disable']])app.post(`/api/modules/:code/${path}`,requireTenantSession,requireCsrf,requireRecentAuthentication,admin,async(req,res)=>res.json({module:await moduleService[method]({tenantId:req.productionSession.tenantId,code:req.params.code,expectedVersion:req.body?.version,reason:req.body?.reason,dependencyReview:req.body?.dependencyReview,exportReview:req.body?.exportReview,actorIdentityId:req.productionSession.identityId})}));
 return moduleService;
}
