import {DatabaseSync} from 'node:sqlite';
import {backupWorkspace,restoreWorkspace,BACKUP_LIMITS} from '../server/backup.js';

const help=`Offline encrypted full-workspace backup and NEW-destination restore

Usage:
  node scripts/backup.mjs backup --db server/data/workspace.sqlite --out server/data/workspace.wbackup --tenant UUID
  node scripts/backup.mjs restore --archive server/data/workspace.wbackup --dest server/data/NEW-workspace.sqlite --tenant UUID

Set BACKUP_ENCRYPTION_KEY in the environment: exactly 32 bytes encoded as 64 hex
characters or padded base64. No default key; keys are never accepted as arguments
or printed. Keep this key separately from the archive. --tenant is required and
must be the original workspace UUID; restore enforces the expected tenant.

Outputs are atomic, mode 0600 and never overwrite an existing destination.
Use a private nonpublic ignored server/data directory. Restore is offline only:
it creates a NEW database, never overwrites a running/live workspace, verifies
SQLite integrity/schema/counts/digests, and clears sessions, MFA challenges and
pending MFA enrollments. Password hashes, enabled MFA encrypted secrets, recovery
history, audit, documents and all installed workspace tables remain encrypted in
the archive. Retain the SAME MFA_ENCRYPTION_KEY separately to use restored MFA;
neither it nor environment/provider keys or the platform registry is archived.

Limits: ${BACKUP_LIMITS.maxArchiveBytes/1024/1024} MiB archive including metadata,
${BACKUP_LIMITS.maxTables} tables, ${BACKUP_LIMITS.maxRows.toLocaleString('en-US')} rows.
This verifies local recovery only; no automatic backup schedule, cloud durability
or availability/recovery SLA is provided. Full ten-year source conversion and
client retention/disposal approval remain separate acceptance work.
`;

async function main(){
 const args=process.argv.slice(2);if(!args.length||args[0]==='--help'||args[0]==='help'){console.log(help);return;}
 const [command,...rest]=args;if(!['backup','restore'].includes(command)||rest.length%2)throw Error('Invalid arguments. Use --help.');const allowed=command==='backup'?['--db','--out','--tenant']:['--archive','--dest','--tenant'];const options={};for(let i=0;i<rest.length;i+=2){const key=rest[i];if(!allowed.includes(key)||options[key]!==undefined||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Invalid arguments. Use --help.');options[key]=rest[i+1];}if(allowed.some(k=>!options[k]))throw Error('Required paths and tenant UUID are missing. Use --help.');
 let db;try{if(command==='backup'){db=new DatabaseSync(options['--db'],{readOnly:true});const r=await backupWorkspace({db,outputPath:options['--out'],tenantId:options['--tenant'],encryptionKey:process.env.BACKUP_ENCRYPTION_KEY});console.log(`Encrypted workspace backup created (${r.archiveBytes} bytes; ${r.tableCount} tables; ${r.totalRows} rows).`);}else{const r=await restoreWorkspace({archivePath:options['--archive'],destinationPath:options['--dest'],expectedTenantId:options['--tenant'],encryptionKey:process.env.BACKUP_ENCRYPTION_KEY});console.log(`New workspace restored and verified (${r.restoredInventory.tableCount} tables). Sessions and pending MFA challenges/enrollments cleared. Retain the same separately managed MFA_ENCRYPTION_KEY.`);}}finally{db?.close();}
}
main().catch(error=>{const known=/^(?:BACKUP_|An explicit tenant|Destination already|Backup |Encrypted |Restored |Receipt |Workspace |Source is not|Platform registry|Required paths|Invalid arguments|Archive limit|Explicit archive|A live SQLite|SQLite integrity)/.test(error.message);console.error(known?error.message:'Backup operation failed. Check the supplied paths, key, tenant and workspace availability; no destination was overwritten.');process.exitCode=1;});
