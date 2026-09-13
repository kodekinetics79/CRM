import test from 'node:test';
import assert from 'node:assert/strict';
import {grantDeadlineState,unresolvedGrantDeadlines} from '../src/grantDeadlines.js';
const grant={id:'grant-a',stage:'Closed',reportDue:'2026-09-01',deadline:'2026-01-01'};
const milestone={grantId:'grant-a',kind:'Report',dueDate:'2026-09-01',status:'Completed'};
test('grant completion clears only an authorized exact grant, kind and date obligation',()=>{
 assert.equal(unresolvedGrantDeadlines(grant,[milestone]).length,0);
 for(const change of [{grantId:'grant-b'},{kind:'Agreement'},{dueDate:'2026-09-02'}])assert.equal(unresolvedGrantDeadlines(grant,[{...milestone,...change}]).length,1);
 assert.equal(unresolvedGrantDeadlines(grant,[]).length,1); // Hidden completion is not proof for this user.
 assert.equal(grantDeadlineState(grant,'Report',grant.reportDue,[milestone]).status,'Completed');
});
test('reopened or conflicting open milestones remain unresolved even for a Closed grant',()=>{
 assert.equal(unresolvedGrantDeadlines(grant,[{...milestone,status:'Open'}])[0].status,'Open');
 assert.equal(unresolvedGrantDeadlines(grant,[milestone,{...milestone,status:'Open'}])[0].status,'Open');
 const submitted={...grant,stage:'Submitted'};
 assert.deepEqual(unresolvedGrantDeadlines(submitted,[]).map(d=>d.kind),['Application']);
});
