// One normalized conversion contract for the mapping screen and server planner.
// This is not a parser for an arbitrary provider export.
export const MIGRATION_COLLECTIONS = Object.freeze(['constituents', 'designations', 'campaigns', 'gifts', 'communications']);
export const MIGRATION_FIELDS = Object.freeze({
 constituents:Object.freeze(['sourceId','name','type','email','phone','household','parentSourceId','segments','preference','notes','contacts']),
 designations:Object.freeze(['sourceId','name','accountCode','school','parentSourceId','description']),
 campaigns:Object.freeze(['sourceId','name','type','goal','startDate','endDate','status','description']),
 gifts:Object.freeze(['sourceId','donorSourceId','amount','type','method','date','designationSourceId','allocations','externalRef','notes','tribute','softCreditSourceId','giftKind','campaignSourceId']),
 communications:Object.freeze(['sourceId','constituentSourceId','subject','channel','status','date','accessScope','body','notes']),
});
export const MIGRATION_REQUIRED = Object.freeze({
 constituents:Object.freeze(['sourceId','name','type']),
 designations:Object.freeze(['sourceId','name','accountCode']),
 campaigns:Object.freeze(['sourceId','name','type','goal','startDate','endDate','status']),
 gifts:Object.freeze(['sourceId','donorSourceId','amount','type','method','date']),
 communications:Object.freeze(['sourceId','constituentSourceId','subject','channel','status','date','accessScope']),
});
export const MIGRATION_LIMITS = Object.freeze({rowsPerBatch:500,filesPerBatch:10,csvBytes:500000,columnsPerRow:30,sourceName:80,fileKey:160,requestBytes:2097152});
