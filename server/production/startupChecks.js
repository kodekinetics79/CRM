import {SCHEMA_VERSION,assertControlPlaneRole,assertRowLevelSecurityEffective,assertSecurityDefinerOwnersBypassRls,readSchemaVersion} from '../persistence/index.js';

const inspect=async(pool,roleCheck,label)=>pool.withAdminSession(async session=>{
 const role=await roleCheck(session),schemaVersion=await readSchemaVersion(session);
 if(schemaVersion!==SCHEMA_VERSION)throw new Error(`${label} database schema is not current.`);
 return {role:role.role,schemaVersion};
});

export async function certifyProductionPools({tenantPool,controlPool}={}){
 if(!tenantPool||typeof tenantPool.withAdminSession!=='function'||!controlPool||typeof controlPool.withAdminSession!=='function')throw new TypeError('Production startup certification requires tenant and control pools.');
 const [tenant,control]=await Promise.all([inspect(tenantPool,assertRowLevelSecurityEffective,'Tenant'),inspect(controlPool,async session=>{const role=await assertControlPlaneRole(session);await assertSecurityDefinerOwnersBypassRls(session);return role;},'Control')]);
 if(tenant.role===control.role)throw new Error('Production startup requires distinct tenant and control database roles.');
 return {schemaVersion:SCHEMA_VERSION,tenantRoleVerified:true,controlRoleVerified:true};
}
