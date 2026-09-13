// Offline operator adapter. It never issues a browser URL and only exports
// immutable references already present in this explicitly selected tenant DB.
export function createDocumentRecoveryAdapter({db,tenantId,objectStorage}={}){
 if(!objectStorage)return undefined;
 return {async exportStoredRevision(row){
  if(!row||row.tenant_id!==tenantId||row.provider!==objectStorage.scope.provider||row.bucket!==objectStorage.scope.bucket||row.namespace!==objectStorage.scope.namespace)throw Error('Recovery document tenant/provider does not match.');
  const current=db.prepare('SELECT * FROM document_revision_storage WHERE document_id=? AND revision=?').get(row.document_id,row.revision);
  if(!current||JSON.stringify(current)!==JSON.stringify(row))throw Error('Recovery immutable document reference does not match the selected workspace.');
  const bytes=await objectStorage.get({provider:row.provider,bucket:row.bucket,namespace:row.namespace,tenantId:row.tenant_id,documentId:row.document_id,revision:row.revision,key:row.object_key,version:row.object_version,sha256:row.sha256,size:row.size});
  const after=db.prepare('SELECT * FROM document_revision_storage WHERE document_id=? AND revision=?').get(row.document_id,row.revision);
  if(JSON.stringify(after)!==JSON.stringify(row))throw Error('Recovery document reference changed during readback.');
  return bytes;
 }};
}
