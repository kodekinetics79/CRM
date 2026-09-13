// Shared allowlisted report projection and execution. Never evaluates client code or SQL.
export const REPORT_LIMITS={columns:20,filters:12,groups:3,aggregates:8,sourceRows:10000,resultRows:250,previewRows:20,cellCharacters:8000,outputBytes:1000000};
const BASE={
 eventCommitmentTransitions:'eventId ownerType ownerId action fromRevision toRevision eventRevision reason actorId actorName at beforeStatus afterStatus beforeName afterName beforeCommitmentAmountCents afterCommitmentAmountCents beforeActiveCommitmentAmountCents afterActiveCommitmentAmountCents beforeWinningBidId afterWinningBidId winningBidId winningBidAmountCents highestBidId highestBidAmountCents receiptLinkCount referencedReceiptAmountCents sourceReferences',
 correspondenceFulfillments:'preparationId giftId sourceGiftRevision acknowledgmentGiftRevision communicationId date channel actorId reason at templateId templateRevision recipientId finalizedBy finalizedAt manualConfirmation applicationSent',
 tributeNotificationWithdrawals:'notificationId tributeId revision reason actorId at confirmedNotSent delivery',
 eventTicketTransitions:'ticketId eventId action fromRevision toRevision eventRevision reason actorId actorName at beforeStatus afterStatus beforeCheckedIn afterCheckedIn beforeCheckedInAt afterCheckedInAt',
 taskAssignmentHistory:'taskId fromRevision toRevision beforeOwnerId beforeOwnerName afterOwnerId afterOwnerName reason actorId actorName at',
 giftFinancialCorrections:'giftId fromRevision toRevision changedFields reason actorId actorName actorRole at beforeAmountCents afterAmountCents beforeDate afterDate beforeConstituentId afterConstituentId beforeType afterType beforeMethod afterMethod beforeCampaignId afterCampaignId beforePledgeId afterPledgeId beforeGrantId afterGrantId beforeSoftCreditId afterSoftCreditId beforeExternalRef afterExternalRef beforeGiftKind afterGiftKind beforePledge afterPledge beforeAllocations afterAllocations sourceVersions',
 constituents:'name email phone type household parentId contacts segments preference notes',
 gifts:'constituentId amount type method date campaignId allocations externalRef notes tribute softCreditId pledge pledgeId grantId giftKind status schoolYear acknowledgment',
 campaigns:'name type goal startDate endDate status description',
 grants:'name funderId amount awardedAmount awardDate stage deadline reportDue notes',
 volunteers:'constituentId skills shift eventId hours capacity notes clockIn',
 events:'name date location capacity ticketPrice sponsorGoal notes registrations',
 tasks:'title dueDate owner ownerId status priority constituentId eventId notes',
 communications:'constituentId subject channel status date body notes giftId',
 designations:'name school parentId accountCode description',
 pledges:'name constituentId amount startDate installments frequency designationId campaignId status notes',
 volunteerTime:'volunteerId constituentId eventId startAt endAt hours source notes originalHours correctionReason correctedAt',
 reportViews:'name filters',evaluations:'scenarioId tester result severity actual reproduction notes',
 volunteerShifts:'name date startTime endTime location capacity eventId status notes',
 shiftReservations:'shiftId constituentId status notes',
 documents:'collection recordId title category visibility status evidenceDate archived createdAt updatedAt retentionUntil revisionCount latestFilename latestMime latestSize',
 documentRevisions:'documentId collection recordId title visibility revision filename mime size sha256 actor at metadata',
 households:'name address memberIds memberCount createdAt updatedAt',
 householdMemberships:'householdId householdName constituentId constituentName',
 identityAliases:'sourceId targetId sourceName targetName reason actor at',
 migrationBatches:'source fileKey committedAt actor valid totalRows createCount mappedCount errorRows giftCount allocationCount newGiftTotalCents allocationTotalCents monetaryContributionCents noncashValueCents feePaymentCents actualNewGiftCents',
 migrationMappings:'source collection externalId recordId batchId',
 customReportDefinitions:'name entity columns filters groupBy aggregates includeVoided columnCount filterCount groupCount calculationCount createdAt updatedAt',
 reportSchedules:'reportId name ownerId cadence nextRun status createdAt updatedAt',
 reportDeliveries:'scheduleId reportId name scheduledAt executedAt status reportVersion error resultSummary',
 correspondenceTemplates:'name kind subject body createdAt updatedAt',
 correspondenceTemplateRevisions:'templateId revision name kind subject body actor at',
 correspondencePreparations:'templateId templateName templateKind templateRevision channel organizationName recipientCount giftCount monetaryCents noncashCents delivery status actor at',
 correspondenceFinalizations:'preparationId actor at humanReviewed delivery',
 fundraisingRecords:'kind name donorId donorName ownerId stage expectedAmount nextActionDate nextActionStatus latestFollowup instrument commitmentAmount status campaignId campaignName originalGiftId originalGiftRevision originalGiftAmountCents matchingOrganizationId matchingOrganizationName ratioNumerator ratioDenominator capAmount notes revision createdAt updatedAt',
 fundraisingVersions:'recordId revision kind name donorId donorName ownerId stage expectedAmount nextActionDate nextActionStatus latestFollowup instrument commitmentAmount status campaignId campaignName originalGiftId originalGiftRevision originalGiftAmountCents matchingOrganizationId ratioNumerator ratioDenominator capAmount notes actor at',
 fundraisingAssociations:'recordId giftId revision status giftRevision associatedDonorId associatedAmountCents associatedType associatedGiftKind associatedCampaignId associatedDate currentGiftAmountCents currentGiftStatus receivedAmountCents asOf createdAt unlinkedAt unlinkReason',
 fundraisingActivity:'recordId actor date note action at',
 receiptProfiles:'organizationName address taxIdentifier signatureLabel customFooter approved revision actor at',
 receiptProfileRevisions:'organizationName address taxIdentifier signatureLabel customFooter approved revision actor at',
 receiptHistory:'kind recipientId recipientName calendarYear monetaryCents benefitValueCents benefitDescription noncashDescription giftCount profileRevision organizationName taxDeductibility semantics status number issueDate staffConfirmedPrint staffConfirmedHandSign createdAt actor priorReceiptId reissueReason voidReason voidedAt',
 receiptGiftReferences:'receiptId giftId date type monetaryCents reference receiptStatus',
 eventTables:'eventId eventName name seats revision createdAt updatedAt',
 eventSeatAssignments:'eventId eventName tableId constituentId constituentName seatNumber status revision assignedAt cancelledAt cancelReason',
 eventTickets:'eventId eventName constituentId constituentName priceCents status revision issuedAt checkedInAt cancelledAt cancelReason',
 eventSponsors:'eventId eventName sponsorId sponsorName name status everFulfilled commitmentAmountCents activeCommitmentAmountCents benefits revision createdAt updatedAt',
 eventAuctionItems:'eventId eventName name startingBidCents minIncrementCents description status winningBidId revision createdAt updatedAt',
 eventAuctionBids:'itemId bidderId bidderName amountCents actor at',
 eventPayments:'ownerType ownerId eventId eventName giftId revenueCase constituentId constituentName amountCents date type status receivedAmountCents asOf actor at',
 workspaceUsers:'name email role active revision',
 workspaceSettings:'organizationName fiscalStartMonth',
 auditHistory:'actor actorName action collection recordId at detailCount',
 grantMilestones:'grantId grantName grantRevision funderId requestedAmountCents awardedAmountCents awardDate sourceStage ownerId ownerName ownerRole ownerRevision name kind dueDate status revision requiredRole createdAt updatedAt',
 grantMilestoneVersions:'milestoneId grantId grantName grantRevision funderId requestedAmountCents awardedAmountCents awardDate sourceStage ownerId ownerName ownerRole ownerRevision name kind dueDate status revision requiredRole action reason actor at',
 grantMilestoneEvidence:'milestoneId milestoneRevision grantId grantName documentId documentVersion documentRevision documentTitle documentCategory documentStatus documentEvidenceDate documentVisibility revisionVisibility documentFilename documentSize documentArchived completedDate completionReference staffConfirmed actor at',
 tributes:'giftId type honoreeName honoreeId notificationRecipientId notificationRecipientName visibility donorDisclosureApproved messagePresent notes revision sourceGiftAmountCents sourceGiftType sourceGiftStatus sourceGiftDate createdAt updatedAt',
 tributeVersions:'tributeId giftId type honoreeName honoreeId notificationRecipientId notificationRecipientName visibility donorDisclosureApproved messagePresent notes revision sourceGiftAmountCents sourceGiftType sourceGiftStatus sourceGiftDate actor at',
 tributeNotifications:'tributeId tributeRevision type honoreeName honoreeId visibility channel subject recipientId recipientName giftId giftDate status delivery actor createdAt finalizedBy finalizedAt',
 tributeNotificationFinalizations:'notificationId tributeId actor at humanReviewed delivery'
};
const TITLES={constituents:'Constituents',gifts:'Gifts',giftAllocations:'Gift allocations',campaigns:'Campaigns',grants:'Grants',volunteers:'Volunteers',events:'Events',tasks:'Tasks',communications:'Communications',designations:'Designations',pledges:'Pledges',volunteerTime:'Volunteer time ledger',reportViews:'Saved report views',evaluations:'Evaluation observations',volunteerShifts:'Volunteer shifts',shiftReservations:'Shift reservations'};
const MONEY=new Set(['activeCommitmentAmountCents','beforeCommitmentAmountCents','afterCommitmentAmountCents','beforeActiveCommitmentAmountCents','afterActiveCommitmentAmountCents','winningBidAmountCents','highestBidAmountCents','referencedReceiptAmountCents','beforeAmountCents','afterAmountCents','amount','goal','awardedAmount','ticketPrice','sponsorGoal','allocationAmount','newGiftTotalCents','allocationTotalCents','monetaryContributionCents','noncashValueCents','feePaymentCents','actualNewGiftCents','monetaryCents','noncashCents','expectedAmount','commitmentAmount','capAmount','originalGiftAmountCents','associatedAmountCents','currentGiftAmountCents','receivedAmountCents','benefitValueCents','priceCents','commitmentAmountCents','startingBidCents','minIncrementCents','amountCents','requestedAmountCents','awardedAmountCents','sourceGiftAmountCents']);
const NUMBERS=new Set(['receiptLinkCount','sourceGiftRevision','acknowledgmentGiftRevision','eventRevision','fromRevision','toRevision','hours','originalHours','capacity','installments','allocationCount','revision','revisionCount','memberCount','size','latestSize','totalRows','createCount','mappedCount','errorRows','giftCount','columnCount','filterCount','groupCount','calculationCount','recipientCount','templateRevision','reportVersion','ratioNumerator','ratioDenominator','calendarYear','profileRevision','giftRevision','originalGiftRevision','seats','seatNumber','detailCount','fiscalStartMonth','grantRevision','ownerRevision','milestoneRevision','documentVersion','documentRevision','documentSize','tributeRevision']);
const DATES=new Set(['beforeCheckedInAt','afterCheckedInAt','beforeDate','afterDate','date','startDate','endDate','awardDate','deadline','reportDue','dueDate','startAt','endAt','clockIn','correctedAt','createdAt','updatedAt','voidedAt','evidenceDate','retentionUntil','at','committedAt','nextRun','scheduledAt','executedAt','nextActionDate','assignedAt','cancelledAt','issuedAt','checkedInAt','unlinkedAt','associatedDate','issueDate','asOf','documentEvidenceDate','completedDate','sourceGiftDate','giftDate','finalizedAt']);
const INTERNAL=new Set(['version','tenantId','tenant_id','createdBy','updatedBy','__proto__','prototype','constructor']);
const protectedKey=k=>k.startsWith('_')||INTERNAL.has(k)||/(password|credential|secret|token|session|csrf|cookie|apiKey|privateKey|mfa|otp|salt|hash)/i.test(k);
const title=key=>key.replaceAll('.', ' · ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
export class ReportError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const fail=(message,status)=>{throw new ReportError(message,status);};
const own=(obj,key)=>obj!=null&&Object.prototype.hasOwnProperty.call(obj,key);
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!protectedKey(key)).map(([key,v])=>[key,clean(v)])):value;
const scalar=value=>Array.isArray(value)||value&&typeof value==='object'?JSON.stringify(clean(value)):value;
function read(obj,path){const walk=(v,keys)=>{if(!keys.length)return scalar(v);if(Array.isArray(v))return v.map(x=>walk(x,keys)).filter(x=>x!=null).map(scalar).join('; ');if(!own(v,keys[0]))return null;return walk(v[keys[0]],keys.slice(1));};return walk(obj,path.split('.'));}
const monetary=value=>{if(value==null||value==='')return null;if(!Number.isSafeInteger(value))fail('A monetary source value is not safe integer cents. Review the source record.');return value;};
function field(key,value,structured=false){const leaf=key.split('.').at(-1);const type=structured?'text':MONEY.has(leaf)?'money':NUMBERS.has(leaf)||typeof value==='number'?'number':DATES.has(leaf)||typeof value==='string'&&/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)?'date':'text';return {key,label:title(key),type,...(type==='money'?{unit:'cents',currency:'USD'}:['size','latestSize','documentSize'].includes(leaf)?{unit:'bytes'}:{}),groupable:!structured,aggregateable:!structured&&['money','number'].includes(type)};}
const METADATA=new Set(['eventCommitmentTransitions','correspondenceFulfillments','tributeNotificationWithdrawals','eventTicketTransitions','taskAssignmentHistory','giftFinancialCorrections','documents','documentRevisions','households','householdMemberships','identityAliases','migrationBatches','migrationMappings','customReportDefinitions','reportSchedules','reportDeliveries','correspondenceTemplates','correspondenceTemplateRevisions','correspondencePreparations','correspondenceFinalizations','fundraisingRecords','fundraisingVersions','fundraisingAssociations','fundraisingActivity','receiptProfiles','receiptProfileRevisions','receiptHistory','receiptGiftReferences','eventTables','eventSeatAssignments','eventTickets','eventSponsors','eventAuctionItems','eventAuctionBids','eventPayments','workspaceUsers','workspaceSettings','auditHistory','grantMilestones','grantMilestoneVersions','grantMilestoneEvidence','tributes','tributeVersions','tributeNotifications','tributeNotificationFinalizations']);
const STRUCTURED=new Set(['sourceReferences','latestFollowup','changedFields','beforeAllocations','afterAllocations','sourceVersions','contacts','allocations','registrations','acknowledgment','filters','metadata','memberIds','columns','groupBy','aggregates','resultSummary','benefits']);
const ADMIN_METADATA=new Set(['tributeNotificationWithdrawals','identityAliases','migrationBatches','migrationMappings','receiptProfiles','receiptProfileRevisions','workspaceUsers','workspaceSettings','auditHistory','tributes','tributeVersions','tributeNotifications','tributeNotificationFinalizations']);
const joinedFields={donorName:'Donor name',designationNames:'Designation names',accountCodes:'Account codes',campaignName:'Campaign name',grantName:'Grant name',pledgeName:'Pledge name',allocationCount:'Allocation count'};

export function buildReportCatalog(data,collections=Object.keys(BASE)){
 const entities=[];
 for(const entity of collections){
  if(!own(BASE,entity))continue;const found=new Map();
  for(const key of ['id',...BASE[entity].split(' ')])found.set(key,field(key,null,STRUCTURED.has(key)));
  const discover=(obj,prefix='',depth=0,throughArray=false)=>{
   if(!obj||typeof obj!=='object'||depth>4)return;
   if(Array.isArray(obj)){for(const item of obj.slice(0,100))discover(item,prefix,depth, true);return;}
   for(const [key,value]of Object.entries(obj)){
    if(protectedKey(key))continue;const path=prefix?prefix+'.'+key:key;
    const structured=throughArray||Array.isArray(value)||value!==null&&typeof value==='object';
    if(!found.has(path)||value!=null)found.set(path,field(path,value,structured));
    if(value&&typeof value==='object')discover(value,path,depth+1,throughArray);
   }
  };
  for(const row of data[entity]||[])discover(row);
  if(entity==='gifts')for(const [key,label]of Object.entries(joinedFields))found.set(key,{...field(key,key==='allocationCount'?0:''),label});
  if(['volunteers','volunteerTime','tasks','communications','pledges','shiftReservations'].includes(entity))found.set('constituentName',{...field('constituentName',''),label:'Constituent name'});
  if(entity==='grants')found.set('funderName',{...field('funderName',''),label:'Funder name'});
  if(['volunteers','volunteerTime','tasks','volunteerShifts'].includes(entity))found.set('eventName',{...field('eventName',''),label:'Event name'});
  entities.push({id:entity,label:TITLES[entity]||title(entity),requiredRole:ADMIN_METADATA.has(entity)?'admin':'authenticated',description:METADATA.has(entity)?(entity==='eventSponsors'?'Original sponsorship commitment amounts remain recorded after cancellation, while active commitment is zero for cancelled promises. Ever fulfilled preserves prior recorded benefit completion even when the current checklist is unchecked. These values are not income or bank settlement.':entity==='eventCommitmentTransitions'?'Retained promise and award transitions with exact source references. Historical amounts and referenced receipts are not new income; cancelled sponsor promises and reopened awards have no active commitment.':entity==='correspondenceFulfillments'?'Staff-confirmed manual fulfillment linked to exact reviewed correspondence. Recording completion does not send, print, sign or issue a receipt.':entity==='tributeNotificationWithdrawals'?'Retained unsent notification withdrawals. Original review and wording remain historical; withdrawal is not delivery or a financial void.':entity==='eventTicketTransitions'?'Retained ticket and attendance corrections. Historical transitions are not additional admissions, collected payments or refunds.':entity==='taskAssignmentHistory'?'Retained responsibility transfers. Historical assignments are not additional tasks or delivered notifications.':entity==='giftFinancialCorrections'?'Retained financial corrections and source references. Before/after amounts are historical facts, not additional income, deductible amounts or bank settlement.':entity==='correspondencePreparations'?'Retained preparation metadata. Recorded values are correspondence coverage, not new income or confirmed delivery.':['fundraisingRecords','fundraisingVersions','eventTickets','eventSponsors','eventAuctionItems','eventAuctionBids'].includes(entity)?'Recorded asks, commitments, prices and bids are not received income. Revisions are historical rows, not additional commitments.':entity==='receiptHistory'||entity==='receiptGiftReferences'?'Retained receipt coverage metadata. Reissued and voided receipt history may repeat the same gift; these values are not new income or deductible amounts.':entity==='fundraisingAssociations'||entity==='eventPayments'?'Existing gift associations. Received amount is zero for unlinked, voided or future receipts as of today; gift values are source references, not additional income.':['grantMilestones','grantMilestoneVersions','grantMilestoneEvidence'].includes(entity)?'Staff-recorded grant milestone/source/evidence metadata. Historical versions are not additional awards, completed actions or received income; private current or historical evidence hides the whole milestone from nonadministrators.':['tributes','tributeVersions','tributeNotifications','tributeNotificationFinalizations'].includes(entity)?'Administrator-only curated honor/memorial history. Source values are recognition references, not additional income. Notification bodies, raw donor snapshots and recipient email are excluded; delivery is always Not sent.':entity==='reportDeliveries'?'Internal delivery metadata and safe result counts only. Stored report cells are not exposed.':'Allowlisted current workspace metadata; file content, raw snapshots and authentication data are excluded.'):entity==='gifts'?'One row per gift. Joined fund labels do not multiply the gift value.':entity==='volunteerTime'?'Historical and dated time remain distinguishable through Source and dates.':'One row per saved record.',fields:[...found.values()].filter(f=>!f.key.split('.').some(protectedKey))});
 }
 if(collections.includes('gifts'))entities.push({id:'giftAllocations',label:TITLES.giftAllocations,description:'One row per gift allocation. Allocation amount is the split value; the full gift amount is not repeated.',fields:['giftId','constituentId','donorName','date','type','method','status','schoolYear','designationId','designationName','accountCode','school','allocationAmount','campaignName','grantName','pledgeName'].map(k=>({...field(k,k==='allocationAmount'?0:''),...(k==='allocationAmount'?{label:'Allocation value'}:{})}))});
 return {entities,limits:REPORT_LIMITS};
}

const strict=(value,keys,name)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('Unsupported '+name+' fields.');};
const unique=a=>new Set(a).size===a.length;
export function validateReportDefinition(input,catalog){
 strict(input,['name','entity','columns','filters','groupBy','aggregates','includeVoided'],'report definition');
 if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120)fail('Give the report a name of 1–120 characters.');
 const entity=catalog.entities.find(e=>e.id===input.entity);if(!entity)fail('Choose an available report entity.');
 const fields=new Map(entity.fields.map(f=>[f.key,f]));
 const columns=input.columns;if(!Array.isArray(columns)||!columns.length||columns.length>REPORT_LIMITS.columns||!unique(columns)||columns.some(k=>typeof k!=='string'||!fields.has(k)))fail('Choose 1–20 distinct fields from the selected entity.');
 const filters=input.filters??[],groupBy=input.groupBy??[],aggregates=input.aggregates??[];
 if(!Array.isArray(filters)||filters.length>REPORT_LIMITS.filters)fail('Use at most 12 filters.');
 const checkValue=(f,value)=>{
  if(f.type==='money'){if(!Number.isSafeInteger(value))fail('Money filters require safe integer USD cents.');}
  else if(f.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)fail('Number filters require a bounded finite number.');}
  else{if(typeof value!=='string'||value.length>1000)fail('Text/date filter values must be bounded text.');if(f.type==='date'&&(!/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10)))fail('Use a valid calendar date or ISO timestamp.');}
 };
 for(const filter of filters){strict(filter,['field','op','value'],'filter');const f=fields.get(filter.field);if(!f)fail('A filter field is not available in this entity.');const ops=['eq','ne','empty','notEmpty','in',...(f.type==='text'?['contains','startsWith']:['gt','gte','lt','lte'])];if(!ops.includes(filter.op))fail('That filter operator is not valid for its field type.');if(['empty','notEmpty'].includes(filter.op)){if(filter.value!==undefined)fail('Empty filters do not accept a value.');}else if(filter.op==='in'){if(!Array.isArray(filter.value)||!filter.value.length||filter.value.length>20)fail('Choose 1–20 values for an in filter.');for(const value of filter.value)checkValue(f,value);}else checkValue(f,filter.value);}
 if(!Array.isArray(groupBy)||groupBy.length>REPORT_LIMITS.groups||!unique(groupBy)||groupBy.some(k=>!fields.get(k)?.groupable))fail('Choose at most three distinct scalar group fields.');
 if(!Array.isArray(aggregates)||aggregates.length>REPORT_LIMITS.aggregates)fail('Use at most eight calculations.');
 const aggregateKeys=[];
 for(const aggregate of aggregates){strict(aggregate,['op','field','label'],'calculation');if(!['count','sum','min','max','avg'].includes(aggregate.op))fail('Choose count, sum, minimum, maximum or average.');if(aggregate.op==='count'){if(aggregate.field!==undefined)fail('Count counts source rows and does not take a field.');}else{const f=fields.get(aggregate.field);if(!f?.aggregateable)fail('Calculations require an available scalar numeric field.');if(aggregate.op==='avg'&&f.type==='money')fail('Money averages can create fractional cents. Use sum, minimum or maximum.');}if(aggregate.label!==undefined&&(typeof aggregate.label!=='string'||!aggregate.label.trim()||aggregate.label.length>80))fail('Calculation labels must be 1–80 characters.');aggregateKeys.push(aggregate.op+':'+(aggregate.field||''));}
 if(!unique(aggregateKeys))fail('Do not repeat the same calculation.');
 if(groupBy.length&&!aggregates.length)fail('Add a calculation when grouping, such as a row count.');
 if(input.includeVoided!==undefined&&typeof input.includeVoided!=='boolean')fail('Include voided must be true or false.');
 if(input.includeVoided&& !['gifts','giftAllocations'].includes(entity.id))fail('Include voided applies only to gifts and gift allocations.');
 return {name:input.name.trim(),entity:entity.id,columns:[...columns],filters:filters.map(f=>({...f})),groupBy:[...groupBy],aggregates:aggregates.map(a=>({...a})),includeVoided:input.includeVoided??false};
}

function project(data,entity,includeVoided){
 const index=(collection)=>new Map((data[collection]||[]).map(r=>[r.id,r]));
 const people=index('constituents'),funds=index('designations'),campaigns=index('campaigns'),grants=index('grants'),pledges=index('pledges'),events=index('events');
 const name=(map,id)=>map.get(id)?.name??null;
 if(['gifts','giftAllocations'].includes(entity)){
  const result=[];
  for(const gift of data.gifts||[]){
   if(!includeVoided&&gift.status==='Voided')continue;
   const join={donorName:name(people,gift.constituentId),campaignName:name(campaigns,gift.campaignId),grantName:name(grants,gift.grantId),pledgeName:name(pledges,gift.pledgeId)};
   if(entity==='gifts')result.push({record:{...gift,...join,designationNames:(gift.allocations||[]).map(a=>name(funds,a.designationId)||'Unknown designation').join('; '),accountCodes:(gift.allocations||[]).map(a=>funds.get(a.designationId)?.accountCode||'').join('; '),allocationCount:gift.allocations?.length||0},reference:{collection:'gifts',id:gift.id}});
   else{
    if(!Array.isArray(gift.allocations))fail('A gift has no allocation ledger. Review the source gift.');
    let sum=0n;for(const a of gift.allocations){const cents=monetary(a.amount);if(cents===null||cents<1)fail('Allocation values must be positive integer cents.');sum+=BigInt(cents);}
    if(sum!==BigInt(monetary(gift.amount)??0))fail('Gift allocations do not reconcile to their saved gift value.');
    for(const a of gift.allocations){const fund=funds.get(a.designationId);result.push({record:{giftId:gift.id,constituentId:gift.constituentId,date:gift.date,type:gift.type,method:gift.method,status:gift.status,schoolYear:gift.schoolYear,designationId:a.designationId,designationName:fund?.name??null,accountCode:fund?.accountCode??null,school:fund?.school??null,allocationAmount:a.amount,...join},reference:{collection:'gifts',id:gift.id}});}
   }
  }
  return result;
 }
 return (data[entity]||[]).map(r=>({record:{...r,...(r.constituentId?{constituentName:name(people,r.constituentId)}:{}),...(r.funderId?{funderName:name(people,r.funderId)}:{}),...(r.eventId?{eventName:name(events,r.eventId)}:{})},reference:METADATA.has(entity)?(['giftFinancialCorrections','correspondenceFulfillments'].includes(entity)?{collection:'gifts',id:r.giftId}:entity==='taskAssignmentHistory'?{collection:'tasks',id:r.taskId}:['eventTicketTransitions','eventCommitmentTransitions'].includes(entity)?{collection:'events',id:r.eventId}:['documents','documentRevisions','migrationMappings'].includes(entity)&&data[r.collection]?.some(x=>x.id===r.recordId)?{collection:r.collection,id:r.recordId}:entity==='householdMemberships'?{collection:'constituents',id:r.constituentId}:entity==='identityAliases'?{collection:'constituents',id:r.targetId}:null):{collection:entity,id:r.id}}));
}
function matches(row,filter){const value=read(row,filter.field),empty=value==null||value==='';if(filter.op==='empty')return empty;if(filter.op==='notEmpty')return !empty;if(filter.op==='eq')return value===filter.value;if(filter.op==='ne')return value!==filter.value;if(filter.op==='in')return filter.value.includes(value);if(empty)return false;if(filter.op==='contains')return String(value).toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());if(filter.op==='startsWith')return String(value).toLocaleLowerCase().startsWith(filter.value.toLocaleLowerCase());if(filter.op==='gt')return value>filter.value;if(filter.op==='gte')return value>=filter.value;if(filter.op==='lt')return value<filter.value;if(filter.op==='lte')return value<=filter.value;return false;}
function calculate(rows,aggregate,fields){
 if(aggregate.op==='count')return rows.length;
 const f=fields.get(aggregate.field),values=rows.map(r=>read(r.record,aggregate.field)).filter(v=>v!=null&&v!=='');
 if(f.type==='money'){
  for(const v of values)monetary(v);
  if(aggregate.op==='sum'){let n=0n;for(const value of values)n+=BigInt(value);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))fail('The monetary total exceeds safe integer cents. Narrow the report filters.');return Number(n);}
 }else if(values.some(v=>typeof v!=='number'||!Number.isFinite(v)))fail('A numeric source field contains a nonnumeric value. Review its source.');
 if(!values.length)return aggregate.op==='sum'?0:null;
 if(aggregate.op==='min')return values.reduce((a,b)=>a<b?a:b);if(aggregate.op==='max')return values.reduce((a,b)=>a>b?a:b);
 const sum=values.reduce((a,b)=>a+b,0);if(!Number.isFinite(sum)||Math.abs(sum)>Number.MAX_SAFE_INTEGER)fail('The numeric total exceeds the safe report range. Narrow its filters.');return Number((aggregate.op==='avg'?sum/values.length:sum).toPrecision(15));
}

export function runCustomReport(data,input,catalog=buildReportCatalog(data)){
 const definition=validateReportDefinition(input,catalog),entity=catalog.entities.find(e=>e.id===definition.entity),fields=new Map(entity.fields.map(f=>[f.key,f]));
 const source=project(data,definition.entity,definition.includeVoided);if(source.length>REPORT_LIMITS.sourceRows)fail('This report exceeds 10,000 source rows. Use a smaller source dataset or a dedicated reporting service.',413);
 const matched=source.filter(r=>definition.filters.every(f=>matches(r.record,f)));
 const cell=(r,key)=>{const f=fields.get(key),value=read(r,key);return f.type==='money'?monetary(value):value??null;};
 let columns,rows,recordReferences;
 if(definition.aggregates.length){
  columns=[...definition.groupBy.map(k=>fields.get(k)),...definition.aggregates.map(a=>({key:a.op+':'+(a.field||''),label:a.label?.trim()||`${title(a.op)}${a.field?' · '+fields.get(a.field).label:' rows'}`,type:a.op==='count'?'number':fields.get(a.field).type,...(a.op!=='count'&&fields.get(a.field).type==='money'?{unit:'cents',currency:'USD'}:{})}))];
  const grouped=new Map();if(!definition.groupBy.length)grouped.set('all',{values:[],rows:matched});
  else for(const r of matched){const values=definition.groupBy.map(k=>cell(r.record,k)),key=JSON.stringify(values);if(!grouped.has(key))grouped.set(key,{values,rows:[]});grouped.get(key).rows.push(r);}
  rows=[...grouped.values()].map(g=>[...g.values,...definition.aggregates.map(a=>calculate(g.rows,a,fields))]);recordReferences=rows.map(()=>null);
 }else{columns=definition.columns.map(k=>fields.get(k));rows=matched.map(r=>definition.columns.map(k=>cell(r.record,k)));recordReferences=matched.map(r=>r.reference);}
 let textTruncated=false;const boundedCell=value=>{if(typeof value==='string'&&value.length>REPORT_LIMITS.cellCharacters){textTruncated=true;return value.slice(0,REPORT_LIMITS.cellCharacters)+'…';}return value;};
 const boundedRows=[],references=[];let bytes=0;const encode=new TextEncoder();
 for(let i=0;i<rows.length&&i<REPORT_LIMITS.resultRows;i++){const row=rows[i].map(boundedCell),size=encode.encode(JSON.stringify(row)).length;if(bytes+size>REPORT_LIMITS.outputBytes/2)break;bytes+=size;boundedRows.push(row);references.push(recordReferences[i]);}
 const previewRows=[],previewReferences=[];
 for(const r of matched.slice(0,REPORT_LIMITS.previewRows)){const row=definition.columns.map(k=>boundedCell(cell(r.record,k))),size=encode.encode(JSON.stringify(row)).length;if(bytes+size>REPORT_LIMITS.outputBytes)break;bytes+=size;previewRows.push(row);previewReferences.push(r.reference);}
 return {definition,columns,rows:boundedRows,recordReferences:references,...(definition.entity==='eventCommitmentTransitions'?{eventCommitmentSources:matched.map(r=>({transitionId:r.record.id,eventId:r.record.eventId,ownerType:r.record.ownerType,ownerId:r.record.ownerId,bidIds:r.record.sourceReferences.bids.map(b=>b.id),receiptLinks:r.record.sourceReferences.receiptLinks.map(link=>({id:link.id,giftId:link.giftId}))}))}:{}),...(definition.entity==='correspondenceFulfillments'?{correspondenceFulfillmentSources:[...new Map(matched.map(r=>[r.record.id,{fulfillmentId:r.record.id,giftId:r.record.giftId,communicationId:r.record.communicationId,preparationId:r.record.preparationId}])).values()]}:{}),...(definition.entity==='eventTicketTransitions'?{eventTicketTransitionSources:[...new Map(matched.map(r=>[r.record.id,{transitionId:r.record.id,ticketId:r.record.ticketId,eventId:r.record.eventId}])).values()]}:{}),...(definition.entity==='taskAssignmentHistory'?{taskAssignmentSources:[...new Map(matched.map(r=>[r.record.id,{assignmentId:r.record.id,taskId:r.record.taskId}])).values()]}:{}),...(definition.entity==='giftFinancialCorrections'?{giftCorrectionSources:[...new Map(matched.map(r=>[r.record.id,{correctionId:r.record.id,giftId:r.record.giftId}])).values()]}:{}),...(definition.entity==='documentRevisions'?{documentRevisionSources:[...new Map(matched.map(r=>[r.record.documentId+':'+r.record.revision,{documentId:r.record.documentId,revision:r.record.revision}])).values()]}:{}),matchedRows:matched.length,totalResultRows:rows.length,truncated:boundedRows.length<rows.length,textTruncated,sourcePreview:{columns:definition.columns.map(k=>fields.get(k)),rows:previewRows,recordReferences:previewReferences},scope:METADATA.has(definition.entity)?entity.description:['gifts','giftAllocations'].includes(definition.entity)?'Saved gift value includes fees and in-kind support unless filtered. Voided gifts are excluded by default. Allocation rows carry only their split value. Commitments are not received income.':'Current saved workspace records. A report definition is not a snapshot, scheduled delivery or arbitrary SQL query.'};
}
