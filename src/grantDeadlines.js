// Consume only the authorized milestone projection supplied by the workspace API.
export function grantDeadlineState(grant,kind,dueDate,milestones=[]) {
 const matches=milestones.filter(m=>m.grantId===grant.id&&m.kind===kind&&m.dueDate===dueDate&&['Open','Completed'].includes(m.status));
 return {status:matches.some(m=>m.status==='Open')?'Open':matches.length?'Completed':'Legacy date',matched:matches.length>0};
}
export function unresolvedGrantDeadlines(grant,milestones=[]) {
 const candidates=[...(['Prospect','Preparing','Submitted'].includes(grant.stage)&&grant.deadline?[{grant,date:grant.deadline,kind:'Application'}]:[]),...(['Awarded','Closed'].includes(grant.stage)&&grant.reportDue?[{grant,date:grant.reportDue,kind:'Report'}]:[])];
 return candidates.map(d=>({...d,...grantDeadlineState(grant,d.kind,d.date,milestones)})).filter(d=>d.status!=='Completed');
}
