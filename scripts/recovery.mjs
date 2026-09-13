import {backupPlatform,restorePlatform,publishOffHostPlatformBackup,retrieveOffHostPlatformBackup} from '../server/platformRecovery.js';

import {createObjectStorageFromEnv} from '../server/objectStorage.js';
import {createDocumentRecoveryAdapter} from '../server/documentRecovery.js';

import {createBackupStorageFromEnv} from '../server/backupStorage.js';

const help=`Offline encrypted complete-platform recovery
  node scripts/recovery.mjs backup --root PATH --legacy-db PATH --out NEW_ARCHIVE --recovery-id UUID --offline-confirmed true
  node scripts/recovery.mjs restore --archive PATH --dest NEW_CONTAINER --recovery-id UUID
  node scripts/recovery.mjs publish --archive PATH --recovery-id UUID
  node scripts/recovery.mjs retrieve --recovery-id UUID --object-key KEY --version-id VERSION --sha256 EXPECTED_SHA256 --out NEW_ARCHIVE
Retrieve uses private exact-version reads, expected ciphertext SHA256 and a new-root
verification drill; no public or presigned URL is issued. Credentials remain environment-only.
Stop every application/worker before backup or restore. A backup locks the registry
and all tenant workspaces. Restore creates NEW_CONTAINER/restored, never overwrites
live data, verifies tenant inventory/checksums and clears all sessions and pending MFA.
BACKUP_ENCRYPTION_KEY is environment-only; retain the SAME MFA_ENCRYPTION_KEY separately.
External document revisions use configured private storage with exact version reads.
Missing configuration or corrupt versions fail safely; inline recovery needs no provider.
Restore returns PLATFORM_DATA_DIR and DB_PATH; review/configure them before activation.
The bounded bundle is limited to 128 MiB and 1,000 tenants. No cloud SLA is implied.`;
async function main(){const args=process.argv.slice(2);if(!args.length||args[0]==='--help'){console.log(help);return;}const [command,...rest]=args,allowed=command==='backup'?['--root','--legacy-db','--out','--recovery-id','--offline-confirmed']:command==='restore'?['--archive','--dest','--recovery-id']:command==='publish'?['--archive','--recovery-id']:command==='retrieve'?['--recovery-id','--object-key','--version-id','--sha256','--out']:[];if(!allowed.length||rest.length%2)throw Error('Invalid arguments. Use --help.');const options={};for(let i=0;i<rest.length;i+=2){if(!allowed.includes(rest[i])||options[rest[i]]||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Invalid arguments. Use --help.');options[rest[i]]=rest[i+1];}if(allowed.some(k=>!options[k]))throw Error('Missing required arguments. Use --help.');const encryptionKey=process.env.BACKUP_ENCRYPTION_KEY;if(command==='backup'){const objectStorage=createObjectStorageFromEnv();const result=await backupPlatform({documentStorageForTenant:(tenantId,db)=>createDocumentRecoveryAdapter({db,tenantId,objectStorage}),rootDir:options['--root'],legacyDbPath:options['--legacy-db'],outputPath:options['--out'],recoveryId:options['--recovery-id'],encryptionKey,offlineConfirmed:options['--offline-confirmed']==='true'});console.log(JSON.stringify({encrypted:true,tenantCount:result.tenantCount,archiveSha256:result.archiveSha256}));}else if(command==='publish'){const result=await publishOffHostPlatformBackup({archivePath:options['--archive'],recoveryId:options['--recovery-id'],encryptionKey,store:createBackupStorageFromEnv()});console.log(JSON.stringify(result));}else if(command==='retrieve'){const result=await retrieveOffHostPlatformBackup({recoveryId:options['--recovery-id'],key:options['--object-key'],versionId:options['--version-id'],expectedSha256:options['--sha256'],outputPath:options['--out'],encryptionKey,store:createBackupStorageFromEnv()});console.log(JSON.stringify(result));}else{const result=await restorePlatform({archivePath:options['--archive'],destinationRoot:options['--dest'],expectedRecoveryId:options['--recovery-id'],encryptionKey});console.log(JSON.stringify({verified:true,tenantCount:result.tenantCount,PLATFORM_DATA_DIR:result.rootDir,DB_PATH:result.legacyDbPath,notice:result.notice}));}}
main().catch(()=>{console.error('Recovery failed. Verify shutdown, key, identity, source availability and new destination. No live database was overwritten. Use --help.');process.exitCode=1;});
