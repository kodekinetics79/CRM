# Wimblo CRM Operations Runbook

## Scope and cost boundary

This runbook covers the industry-neutral PostgreSQL SaaS web and worker runtimes. It does not certify the legacy SQLite `npm start` runtime, the synthetic evaluator, a provider deployment, billing, customer UAT, or customer acceptance. Local certification performs no Git push, pull request, merge, deployment, hosting upgrade, paid check, or billable provider activation.

## Release gates

Run from a clean reviewed commit:

```sh
npm run certify:crm:local
```

The command runs focused CRM security/capacity/recovery tests, the disposable two-tenant PostgreSQL foundation verifier, the existing encrypted backup/readback/fresh-target restore verifier, the full regression suite, production and synthetic builds, the high-severity dependency audit, and the focused/skipped-test discipline gate. It stops at the first failure and never converts local evidence into provider claims.

Local infrastructure is an explicit prerequisite: use a dedicated disposable loopback PostgreSQL 17 database on `127.0.0.1:57733` and a dedicated S3-compatible MinIO container on `127.0.0.1:57734`. Never point these destructive verifiers at a shared, remote, staging, or production database. Start the containers with the documented local-only credentials in the verifier headers, confirm their loopback port bindings, and stop and remove each verification container after evidence is captured. This local setup never proves provider readiness or provider recovery.

The bounded capacity gate runs 40 real `crm.listParties` repository operations against the disposable PostgreSQL database. It records errors, elapsed time, configured pool maximum, observed operation/query concurrency, actual queries, and queries per operation; invented counters are not accepted as capacity evidence.

Verifier and composed-certifier diagnostics redact configured URLs, database names, user names, passwords, access keys, tokens, and endpoints while retaining safe error categories such as connection refusal, schema mismatch, and failed invariant names. Treat any unredacted infrastructure output as a failed release gate.

Web and worker startup also fail before listening or polling unless both database connections prove:

- current checksum-protected schema version;
- a non-superuser, non-`BYPASSRLS` tenant role with forced RLS on every tenant table;
- a distinct least-privilege control-plane role with no tenant-business-table privileges;
- control-role access to the audit sequence and `tenant_state`, `runnable_tenant_ids`, and `dead_letter_count` functions required at runtime.
- every required `SECURITY DEFINER` function is owned by a superuser or `BYPASSRLS` migration owner, so forced-RLS global lifecycle and readiness reads cannot silently disappear.

Any verification, listener, or worker-loop failure must close every initialized database pool exactly once before the process exits. Repeated shutdown signals must remain idempotent.

## Deployment topology required

Operate three separate components:

1. Production frontend bundle from `npm run build`, served on the exact `APP_ORIGIN`.
2. SaaS web process using `npm run start:saas:web`.
3. SaaS worker process using `npm run start:saas:worker`.

The checked-in `render.yaml` currently starts the legacy SQLite application through `npm start`. It must not be treated as the SaaS deployment manifest. No checked-in topology currently serves the production `dist` bundle or provisions the SaaS web/worker pair. Promotion remains blocked until a reviewed no-new-cost topology replaces that mismatch.

## Required private configuration

Follow `server/production/runtimeConfig.js` as the authoritative validator. Keep database URLs, MFA/session keys, object-storage credentials, evidence bindings, and backup keys in provider secret storage. Never paste them into tickets, logs, Git, screenshots, or certification output. Use distinct TLS database URLs for tenant and control roles.

The SaaS web runtime also requires `TRUSTED_PROXY_CIDRS`, a comma-separated allowlist containing only the exact IP addresses or CIDR ranges of the managed HTTPS ingress that connects directly to the web process. Record provider evidence for those ranges and that the ingress overwrites client-supplied forwarding headers before promotion; never use `0.0.0.0/0`, `::/0`, a hop count, or an end-user/client range. Requests from any other peer cannot use `X-Forwarded-Proto` to satisfy HTTPS enforcement or `X-Forwarded-For` to select an authentication rate-limit bucket. A deployment that previously set only `TRUST_PROXY_HOPS` must replace it with the verified allowlist before the SaaS web process can start. The non-HTTP worker does not require this ingress setting.

Provision a third, non-runtime migration owner. It may be `NOSUPERUSER`, but it must hold `BYPASSRLS`; `applyMigrations` refuses before forced-RLS DDL, global backfills, or definer-function creation when the effective migration owner has neither `SUPERUSER` nor `BYPASSRLS`. This credential owns the schema and reviewed definer functions, runs only the explicit migration job, and must never be supplied to the web or worker process. Tenant and control runtime roles remain `NOSUPERUSER NOBYPASSRLS`. After every migration, rerun the tenant/control grants because new runtime functions are not granted through `PUBLIC`.

## Health and readiness

- `/health` is process liveness only.
- `/ready` proves pool connectivity only after startup certification has proved schema and role controls.
- Worker evidence must show polling through the control-only runnable-tenant function and tenant-scoped job claims.
- Exact deployed commit SHA, process type, restart persistence, migration state, and bundle provenance must be recorded independently.

## Backup and recovery

Local certification runs the existing encrypted logical backup contract: create backup, authenticate/read the archive, restore to a fresh target, and reconcile schema, row counts, per-collection digests, audits, users, and integer-cent totals. This proves local code behavior, not provider backup scheduling or durability.

Before production acceptance, record private provider evidence for backup creation, immutable readback, fresh-environment restore, CRM record reconciliation, RPO, RTO, key custody, and retention. If `pg_dump` or provider snapshots are used, restore into a disposable target and compare tenant counts and representative CRM checksums before declaring the drill successful.

## Attachment policy

An attachment link is an active same-tenant metadata reference. It never grants byte access. Responses explicitly carry `accessPolicy.scope = tenant-metadata-reference` and `grantsByteAccess = false`; they expose no object key, bucket, credentials, or download URL. No SaaS byte upload/download route is enabled in this release. If a future preview/download feature introduces object ownership or ACLs, authorize the object independently before linking and again before serving bytes.

## Incident actions

- Session/logout anomaly: keep the browser in the explicit “Sign-out not confirmed” state, retry termination, revoke identity sessions through the operated control path, and preserve redacted audit evidence.
- Tenant isolation or role assertion failure: stop web/worker startup; do not bypass the check.
- Migration mismatch: run the explicit reviewed migration job with the dedicated `BYPASSRLS` owner role; runtime roles never migrate on connect. If the owner preflight fails, correct role provisioning rather than setting a tenant scope or bypassing the check.
- Queue backlog/dead letters: suspend the affected handler if necessary, preserve tenant scope, inspect the control-only aggregate, and replay only with an idempotency proof.
- Restore mismatch: quarantine the restored target and backup artifact; never promote a partially reconciled restore.

## Evidence boundaries

Keep these states separate: implemented, locally verified, CI/PR, merged, deployed, production observed, customer UAT, and customer accepted. A green local run is evidence only for the first two states.
