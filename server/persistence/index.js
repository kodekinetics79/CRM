// Wimblo persistence boundary — public surface.
//
// Phase 4 status, stated plainly: this is production-persistence READINESS.
// Nothing here is installed into server/app.js. The application still runs on
// the embedded SQLite store exactly as before. What this package provides is an
// explicit boundary, a second implementation on PostgreSQL, explicit forward
// migrations, defined failure behaviour, a verified restore path, a private
// object-storage abstraction, and a proven copy path from a SQLite workspace.
//
// Verified locally against a real PostgreSQL server and a real S3-compatible
// object store by `npm run verify:postgres`. Hosted operation, key custody,
// backup cadence and physical residency evidence remain deployment items and
// are not claimed here.

export {
 PERSISTENCE_CODES,PersistenceError,persistenceFail,
 REPOSITORY_CONTRACT,REPOSITORY_METHODS,assertRepositoryContract,
 runRepositoryConformance,CONFORMANCE_CHECKS,
 canonicalJson,sha256,recordChecksum,digestOf,assertIntegerCents,assertTenantId,
 searchText,normalizedSearchText,normalizeSearchTerm,matchesSearch,validateFinancialBatch,
 FINANCIAL_COLLECTION,GIFT_STATUSES
} from './contract.js';

export {MIGRATIONS,SCHEMA_VERSION,MIGRATION_LEDGER_TABLE,validateMigrations,planMigrations,applyMigrations,readSchemaVersion} from './migrations.js';
export {createPostgresPool,poolFromEnv,classifyError} from './pool.js';
export {applicationRoleGrants,assertRowLevelSecurityEffective,TENANT_TABLES} from './roles.js';
export {createSqliteRepository,WORKSPACE_TABLES} from './sqliteRepository.js';
export {createPostgresRepository} from './postgresRepository.js';
export {
 createPrivateObjectStore,createMemoryObjectBackend,createS3ObjectBackend,
 createMemoryObjectCatalog,createPostgresObjectCatalog,parseObjectKey,
 OBJECT_CONTENT_TYPES,OBJECT_MAX_BYTES,OBJECT_STATES,ENCRYPTION_ALGORITHM
} from './objectStore.js';
export {createTenantBackup,readBackupManifest,restoreTenantBackup,verifyRestore,MAX_ARCHIVE_BYTES} from './backupRestore.js';
export {migrateSqliteWorkspaceToPostgres,inspectSqliteWorkspace} from './legacySqliteMigration.js';
export {
 resolveResidency,residencyFromEnv,RESIDENCY_PROFILES,RESIDENCY_AUTHORITY,
 DEFAULT_RESIDENCY_PROFILE,CUSTODY_MODES
} from './residency.js';
