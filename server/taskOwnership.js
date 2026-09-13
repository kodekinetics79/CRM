import {randomUUID} from 'node:crypto';

// Assignment is a responsibility record, not a notification or delivery service.
export function installTaskOwnership(app,{db,get,audit,fail}) {
 db.exec(`CREATE TABLE IF NOT EXISTS task_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,from_version INTEGER,to_version INTEGER NOT NULL,before_owner TEXT NOT NULL,after_owner TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS task_assignments_no_update BEFORE UPDATE ON task_assignments BEGIN SELECT RAISE(ABORT,'Assignment history is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS task_assignments_no_delete BEFORE DELETE ON task_assignments BEGIN SELECT RAISE(ABORT,'Assignment history is immutable'); END;`);
 const users=()=>db.prepare("SELECT id,name,role,active,version FROM users WHERE active=1 AND role IN ('admin','staff') ORDER BY name,id").all().map(u=>({id:u.id,name:u.name,role:u.role,version:u.version}));
 const owner=task=>{if(!task.ownerId)return {id:null,name:task.owner||'',status:task.owner?'Legacy label — choose staff':'Unassigned'};const u=db.prepare('SELECT id,name,role,active,version FROM users WHERE id=?').get(task.ownerId);return {id:task.ownerId,name:u?.name||task.owner,status:u?.active&&['admin','staff'].includes(u.role)?'Assigned':'Needs reassignment',role:u?.role||null,version:u?.version||null};};
 app.get('/api/tasks/:id/assignments',(req,res)=>{get('tasks',req.params.id);res.json({assignments:db.prepare('SELECT * FROM task_assignments WHERE task_id=? ORDER BY to_version,id').all(req.params.id).map(r=>({id:r.id,taskId:r.task_id,fromVersion:r.from_version,toVersion:r.to_version,before:JSON.parse(r.before_owner),after:JSON.parse(r.after_owner),reason:r.reason,actor:JSON.parse(r.actor),at:r.at}))});});
 function retain(before,after,actor,reason){
  if(before&&(before.ownerId??null)===(after.ownerId??null))return;
  if(!before&&!after.ownerId)return;
  if(before&&(typeof reason!=='string'||!reason.trim()||reason.trim().length>2000))fail(400,'Changing task responsibility requires assignmentReason (1–2000 characters).');
  const original=before?owner(before):{id:null,name:'',status:'Unassigned'},replacement=owner(after),id=randomUUID(),why=before?reason.trim():'Initial staff assignment';
  db.prepare('INSERT INTO task_assignments VALUES(?,?,?,?,?,?,?,?,?)').run(id,after.id,before?.version??null,after.version,JSON.stringify(original),JSON.stringify(replacement),why,JSON.stringify({id:actor?.id||'system',name:actor?.name||'System',role:actor?.role||null}),after.updatedAt);
  audit(actor,'assign_task','tasks',after.id,{assignmentId:id,fromVersion:before?.version??null,toVersion:after.version,before:original,after:replacement,reason:why});
 }
 return {users,owner,retain,validateDeletion:task=>{if(db.prepare('SELECT 1 FROM task_assignments WHERE task_id=?').get(task.id))fail(409,'Task assignment history must be retained; mark the task completed instead.');}};
}
