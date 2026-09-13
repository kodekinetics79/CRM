# Wimblo private document and recovery storage

Use an owner-approved native AWS S3 bucket in a permitted US/Canada region for the current production profile. Enable all S3 Block Public Access settings, a nonpublic ACL/policy, server-side encryption and bucket versioning. The application independently probes provider configuration and a small private exact-version upload/readback; declaration variables do not bypass verification. The attached Neon US East 1 project explicitly returned storage-region unavailable.

## Server-only configuration

| Variable | Purpose |
|---|---|
| DOCUMENT_STORAGE_PROVIDER | `sqlite` preserves inline local/durable-SQLite storage; `s3` enables verified private external document revisions |
| DOCUMENT_STORAGE_BUCKET | Approved private document bucket name |
| DOCUMENT_STORAGE_NAMESPACE | Stable deployment namespace; never reuse another installation's namespace |
| DOCUMENT_STORAGE_PRIVATE_CONFIRMED | `true` after actual owner configuration review; provider probes still required |
| AWS_REGION | Approved bucket region |
| AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN | Least-privilege server credentials; temporary session token only when used |
| BACKUP_STORAGE_BUCKET | Separate approved private recovery bucket; native versioned S3 required |
| BACKUP_STORAGE_NAMESPACE | Stable recovery deployment namespace; defaults to DOCUMENT_STORAGE_NAMESPACE |
| BACKUP_STORAGE_PRIVATE_CONFIRMED | Owner confirmation; actual encryption/privacy/version probes remain required |
| BACKUP_AWS_REGION | Recovery region override; otherwise AWS_REGION |
| BACKUP_AWS_ACCESS_KEY_ID, BACKUP_AWS_SECRET_ACCESS_KEY, BACKUP_AWS_SESSION_TOKEN | Optional separate least-privilege recovery principal; defaults to normal AWS credentials |
| MFA_ENCRYPTION_KEY | Separately retained 32-byte MFA key for restoring enabled factors |
| BACKUP_ENCRYPTION_KEY | Distinct 32-byte key for authenticated encrypted archives; retained outside the bucket and archive |

Never prefix private keys with VITE_ or expose them in the frontend. Native production AWS endpoints are required; arbitrary compatible endpoints and unproved Neon production storage are not accepted by the current profile.

## Required permission scope

Restrict the principal to the selected bucket and deployment namespace, not all buckets. Bucket-level inspection requires GetBucketAcl, GetBucketPolicyStatus, GetBucketPublicAccessBlock, GetEncryptionConfiguration, GetBucketVersioning and GetBucketLocation. Object-level upload/readback/failed-staging/probe cleanup requires PutObject, GetObject, GetObjectVersion and DeleteObjectVersion under only the selected namespace. Allow KMS encrypt/decrypt/data-key use only on the selected KMS key if SSE-KMS is used. These are policy action names, not permission to create public access or delete committed history.

Document keys are tenant/document/revision scoped. Recovery objects use separate tenant-backup and platform-backup paths. Exact provider version, source checksum and tenant identity are verified. Uncommitted uploads/probes may be cleaned; committed business history has independent retention guards. Adopt archive/version retention, legal holds, explicit tenant exit and authorised disposal separately; do not attach an arbitrary lifecycle expiry to retained business evidence.

## Validation and recovery

1. Check the actual bucket region, public-access settings, encryption/versioning and private credential permissions. Use only synthetic files until all provider/data approvals are complete.
2. Upload a supported synthetic document, download the exact revision and compare its checksum; test private historical revision denial and tenant separation. Complete and reopen a synthetic grant obligation against verified evidence.
3. Use `node scripts/backup.mjs --help` for workspace archives and `node scripts/recovery.mjs --help` for complete-platform backup, new-root restore, off-host publication and exact-version retrieval. Stop all application/workers before a full-platform snapshot. Backup CLI exports configured external document bytes with source/provider pins.
4. Preserve off-host archive identity, exact version and SHA-256 in private operator evidence. Exercise actual download and full new-root restore; configure both returned PLATFORM_DATA_DIR and DB_PATH, then restart and reconcile accounts, financial/history/file records.
5. Use `node scripts/production-check.mjs --help` with the explicit original tenant UUID and private real operational evidence. Approve retention and separately exercise external monitoring/alert escalation.

Document limits remain **1 MiB**, PDF/PNG/JPEG/UTF-8 TXT/CSV. Executables/HTML/archives/Office files are unsupported. Without a configured malware scanner the interface accurately says **Format validation only**; file signatures are not malware scanning. Recovery bundles remain bounded at **128 MiB / 1,000 tenants**, with workspace/table/row limits in CLI help. Test actual buyer volume and fund the required capacity or streaming/chunked recovery design before historical migration; passing small fixtures does not accept these limits for ten years of buyer records.

No live bucket, scheduled off-host operation, retention enforcement, approved geographic copies or hosted recovery SLA is established by this setup document.
