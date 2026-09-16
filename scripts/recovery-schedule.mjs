import {openOfflineRecoverySchedule} from '../server/offlineRecoverySchedule.js';
import {createBackupStorageFromEnv} from '../server/backupStorage.js';
import {createObjectStorageFromEnv} from '../server/objectStorage.js';
import {createDocumentRecoveryAdapter} from '../server/documentRecovery.js';
const help=`Private operator-invoked offline recovery schedule (no daemon)

  node scripts/recovery-schedule.mjs arm --journal ABS_PRIVATE_FILE --root ABS_PLATFORM_ROOT --legacy-db ABS_DB --archives ABS_PRIVATE_DIRECTORY --recovery-id UUID --cadence Daily|Weekly --first-run UTC_ISO_Z --require-off-host true|false --reason TEXT
  node scripts/recovery-schedule.mjs run --journal ABS_PRIVATE_FILE --offline-confirmed true [--configured-storage true]
  node scripts/recovery-schedule.mjs inspect --journal ABS_PRIVATE_FILE
  node scripts/recovery-schedule.mjs recover --journal ABS_PRIVATE_FILE --run-id UUID --version N --offline-confirmed true --runner-stopped-confirmed true --reason TEXT [--configured-storage true] [--object-key KEY --version-id VERSION]
  node scripts/recovery-schedule.mjs retire --journal ABS_PRIVATE_FILE --version N --reason TEXT

Stop ALL app processes/workers before EVERY run/recover invocation. Recover also
requires confirming the original schedule runner has stopped. A separate operator
scheduler must invoke 'run' at the adopted offline maintenance cadence; this CLI
does not stop applications, install cron, run a daemon, or prove actual adoption.
One Daily/Weekly UTC schedule per private mode0600 journal; immutable outcomes and
up to 5000 retained runs / 50000 outcomes, last 100 runs visible. Recovery is bounded
to 100 retained outcomes per occurrence; no history is purged. One overdue catch-up, never missed-cycle
backfill. An unresolved occurrence blocks all new runs until explicit recovery.
Archives are mode0600, never overwritten, authenticated by a NEW-root restore drill.
BACKUP_ENCRYPTION_KEY is environment-only; retain SAME MFA_ENCRYPTION_KEY separately.
The operator journal is separate and NOT included in the platform archive; retain
its private custody independently along with the archive/version references.
Without --configured-storage true NO provider factories/calls are enabled. With it,
existing environment-only document recovery/off-host storage adapters are enabled;
there are no credential arguments. A local directory is NEVER labeled off-host.
A Publishing-stage interruption requires an EXACT retained private object key/version
and verified readback; automatic republishing/new object creation is refused.
Preserve an unresolvable journal/archive for operator disposition rather than rearm.
No retention purge, disposal approval, adopted RPO/RTO, cloud durability or SLA claim.
Existing bundle limits: 128 MiB, 1000 tenants; actual buyer-scale recovery unaccepted.
`;
async function main(){const args=process.argv.slice(2);if(!args.length||args[0]==='--help'){console.log(help);return;}const[command,...rest]=args,sets={arm:['--journal','--root','--legacy-db','--archives','--recovery-id','--cadence','--first-run','--require-off-host','--reason'],run:['--journal','--offline-confirmed','--configured-storage'],inspect:['--journal'],recover:['--journal','--run-id','--version','--offline-confirmed','--runner-stopped-confirmed','--reason','--configured-storage','--object-key','--version-id'],retire:['--journal','--version','--reason']};if(!sets[command]||rest.length%2)throw Error();const p={};for(let i=0;i<rest.length;i+=2){if(!sets[command].includes(rest[i])||Object.hasOwn(p,rest[i])||!rest[i+1]||rest[i+1].startsWith('--'))throw Error();p[rest[i]]=rest[i+1];}const required=sets[command].filter(k=>!['--configured-storage','--object-key','--version-id'].includes(k));if(required.some(k=>!p[k])||Boolean(p['--object-key'])!==Boolean(p['--version-id']))throw Error();for(const k of ['--offline-confirmed','--runner-stopped-confirmed','--configured-storage','--require-off-host'])if(p[k]&&!['true','false'].includes(p[k]))throw Error();if(p['--configured-storage']&&p['--configured-storage']!=='true')throw Error();if(p['--configured-storage']&&!['run','recover'].includes(command))throw Error();let service;try{const configured=p['--configured-storage']==='true',objectStorage=configured?createObjectStorageFromEnv():null;service=await openOfflineRecoverySchedule({journalPath:p['--journal'],store:configured?createBackupStorageFromEnv():null,...(configured?{documentStorageForTenant:(tenantId,db)=>createDocumentRecoveryAdapter({db,tenantId,objectStorage})}:{})});let r;if(command==='arm')r=await service.arm({rootDir:p['--root'],legacyDbPath:p['--legacy-db'],archiveDir:p['--archives'],recoveryId:p['--recovery-id'],cadence:p['--cadence'],firstRunAt:p['--first-run'],requireOffHost:p['--require-off-host']==='true',reason:p['--reason']});else if(command==='run')r=await service.runDue({offlineConfirmed:p['--offline-confirmed']==='true',encryptionKey:process.env.BACKUP_ENCRYPTION_KEY});else if(command==='recover')r=await service.recover({runId:p['--run-id'],version:Number(p['--version']),offlineConfirmed:p['--offline-confirmed']==='true',runnerStoppedConfirmed:p['--runner-stopped-confirmed']==='true',reason:p['--reason'],encryptionKey:process.env.BACKUP_ENCRYPTION_KEY,...(p['--object-key']?{reference:{key:p['--object-key'],versionId:p['--version-id']}}:{})});else if(command==='retire')r=service.retire({version:Number(p['--version']),reason:p['--reason']});else r=service.inspect();console.log(JSON.stringify(r));}finally{service?.close();}}
main().catch(()=>{console.error('Offline scheduled recovery failed. Inspect its private journal, shutdown confirmations, identity, version, key and retained archive. No completion or cloud durability is claimed. Use --help.');process.exitCode=1;});
