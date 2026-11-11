import {PERSISTENCE_CODES,persistenceFail} from '../persistence/contract.js';

export function installModuleRoutes(app,{moduleService,requireTenantSession,requireCsrf}){
 const admin=(req,res,next)=>req.productionSession?.membership?.role==='owner'||req.productionSession?.membership?.role==='admin'?next():next(persistenceFail(PERSISTENCE_CODES.ISOLATION,'Administrator capability authority is required.'));
 app.get('/api/modules',requireTenantSession,async(req,res)=>res.json({modules:await moduleService.list(req.productionSession.tenantId)}));
 for(const [path,method] of [['enable','enable'],['suspend','suspend'],['retire','beginRetirement'],['disable','disable']])app.post(`/api/modules/:code/${path}`,requireTenantSession,requireCsrf,admin,async(req,res)=>res.json({module:await moduleService[method]({tenantId:req.productionSession.tenantId,code:req.params.code,expectedVersion:req.body?.version,reason:req.body?.reason,dependencyReview:req.body?.dependencyReview,exportReview:req.body?.exportReview,actorIdentityId:req.productionSession.identityId})}));
 return moduleService;
}
