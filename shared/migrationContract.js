// One normalized conversion contract for the mapping screen and server planner.
// This is not a parser for an arbitrary provider export.
export const MIGRATION_COLLECTIONS = Object.freeze(['constituents', 'designations', 'gifts']);
export const MIGRATION_FIELDS = Object.freeze({
 constituents:Object.freeze(['sourceId','name','type','email','phone','household','parentSourceId','segments','preference','notes']),
 designations:Object.freeze(['sourceId','name','accountCode','school','parentSourceId','description']),
 gifts:Object.freeze(['sourceId','donorSourceId','amount','type','method','date','designationSourceId','allocations','externalRef','notes','tribute','softCreditSourceId','giftKind']),
});
export const MIGRATION_REQUIRED = Object.freeze({
 constituents:Object.freeze(['sourceId','name','type']),
 designations:Object.freeze(['sourceId','name','accountCode']),
 gifts:Object.freeze(['sourceId','donorSourceId','amount','type','method','date']),
});
export const MIGRATION_LIMITS = Object.freeze({rowsPerBatch:500,filesPerBatch:10,csvBytes:500000,columnsPerRow:30,sourceName:80,fileKey:160,requestBytes:2097152});
