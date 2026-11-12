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

The production worker registers `crm.task_reminder` as a real durable handler. A due reminder creates one in-product task timeline event whose event identity is the durable job ID, then clears the task schedule in the same tenant transaction. The handler suppresses stale versions, rescheduled reminders, completed or cancelled tasks, missing subjects, and inactive owners. A retry after commit recognizes the existing event and succeeds without duplication. This release does not send reminder email, SMS, push, or provider notifications.

If polling fails while handlers are active, the worker drains those handlers before pool shutdown. If shutdown wins after a job was claimed but before its handler began, the lease is released without consuming an attempt or dead-lettering the unstarted job.

## Deployment topology required

Operate three logical components:

1. Production frontend bundle from `npm run build`, served by the SaaS web process on the exact `APP_ORIGIN`.
2. SaaS web/API process using `npm run start:saas:web`.
3. SaaS worker process using `npm run start:saas:worker`.

The SaaS web composition serves the built `dist` bundle and API from one exact origin. The checked-in `render.yaml` stages the existing paid `Wimblo_CRM` web service plus a separate worker, keeps service auto-deploy disabled, and validates through the Render CLI. The synthetic evaluator is isolated on the free `Wimblo_CRM_Evaluator` service; `vercel.json` routes only evaluator API traffic to that service. Keep Blueprint Auto Sync disabled in Render as well as service auto-deploy.

## Provider and cost checkpoint

Inspection and controlled provisioning on 2026-11-12 established these boundaries:

- the existing Render `Wimblo_CRM` web service uses the `0.5c-512mb` plan and can be repurposed without adding another paid web service;
- the synthetic evaluator clone `Wimblo_CRM_Evaluator` uses Render's free web plan. It is intentionally ephemeral and may cold-start; its exact evaluator commit and direct login must pass before changing the Vercel rewrite;
- Render does not offer a free background-worker plan; the staged `0.5c-512mb` worker adds the provider's current $7/month compute charge;
- Free Render Postgres expires after 30 days and has no backups, so it is not a production option; paid Render Postgres currently starts at $6/month;
- the existing Neon Launch project `wimblo` is in `aws-us-east-1`; main is migrated through schema version 18 and has separate migration, tenant-runtime, and control-runtime roles;
- Neon main has private `wimblo-production-documents` and `wimblo-production-backups` buckets. Live synthetic write/read/delete plus anonymous-read denial must pass before each promotion;
- Render terminates TLS, redirects HTTP, keeps the application port off the public internet, and documents the first forwarded address as the real client. `TRUSTED_PROXY_PROVIDER=render` is accepted only when Render's injected hostname exactly matches `APP_ORIGIN`; do not generalize this profile or add wildcard CIDRs.

The owner approved the described production completion plan, including the `0.5c-512mb` worker charge. Do not add another paid service, enable autoscaling, or accept an unreviewed provider upgrade.

## Required private configuration

Follow `server/production/runtimeConfig.js` as the authoritative validator. Keep database URLs, MFA/session keys, object-storage credentials, evidence bindings, and backup keys in provider secret storage. Never paste them into tickets, logs, Git, screenshots, or certification output. Use distinct TLS database URLs for tenant and control roles.

On Render, set `TRUSTED_PROXY_PROVIDER=render`; Render supplies `RENDER=true` and `RENDER_EXTERNAL_HOSTNAME`. Startup rejects the profile unless the injected hostname exactly matches the hostname in `APP_ORIGIN`. The profile uses Render's documented first-address forwarding contract so appended client spoof entries cannot rotate authentication rate limits. Never set wildcard CIDRs or reuse this provider profile elsewhere. The non-HTTP worker does not use ingress trust.

Provision a third, non-runtime migration owner. It may be `NOSUPERUSER`, but it must hold `BYPASSRLS`; `applyMigrations` refuses before forced-RLS DDL, global backfills, or definer-function creation when the effective migration owner has neither `SUPERUSER` nor `BYPASSRLS`. This credential owns the schema and reviewed definer functions, runs only the explicit migration job, and must never be supplied to the web or worker process. Tenant and control runtime roles remain `NOSUPERUSER NOBYPASSRLS`. After every migration, rerun the tenant/control grants because new runtime functions are not granted through `PUBLIC`.

## Health and readiness

- `/health` is process liveness and deliberately works on Render's internal HTTP health probe without forwarded TLS headers.
- `/ready` remains behind HTTPS/origin enforcement and proves pool connectivity only after startup certification has proved schema, role controls, private document storage, and private backup storage. The web does not listen at all if startup certification fails.
- Worker evidence must show polling through the control-only runnable-tenant function and tenant-scoped job claims.
- Exact deployed commit SHA, process type, restart persistence, migration state, and bundle provenance must be recorded independently.

## Backup and recovery

Local certification runs the encrypted logical backup contract: create backup, authenticate/read the archive, restore to a fresh target, and reconcile schema, row counts, per-table digests for every production CRM table, audits, users, and integer-cent totals. Restore control-plane identities and tenant memberships first. For any archive containing referenced identity or membership IDs, `restoreTenantBackup` requires `validateControlPlanePrerequisites` to confirm the exact target identities and tenant memberships before it creates a target repository or imports any tenant row. Missing validation or incomplete confirmation refuses the restore without a partial tenant copy. This proves local code behavior, not provider backup scheduling or durability.

The production readiness RPO is 24 hours. The evidence timestamp may be at most 86,400 seconds old; exactly 86,400 seconds passes and 86,401 seconds blocks promotion. Before production acceptance, record private provider evidence for backup creation, immutable readback, fresh-environment restore, every CRM table's reconciliation, measured RTO, key custody, and retention. If `pg_dump` or provider snapshots are used, restore into a disposable target and compare tenant counts and CRM table checksums before declaring the drill successful.

## Attachment policy

An attachment link is an active same-tenant metadata reference. It never grants byte access. Responses explicitly carry `accessPolicy.scope = tenant-metadata-reference` and `grantsByteAccess = false`; they expose no object key, bucket, credentials, or download URL. No SaaS byte upload/download route is enabled in this release. If a future preview/download feature introduces object ownership or ACLs, authorize the object independently before linking and again before serving bytes.

## Incident actions

- Session/logout anomaly: keep the browser in the explicit “Sign-out not confirmed” state, retry termination, revoke identity sessions through the operated control path, and preserve redacted audit evidence.
- Tenant isolation or role assertion failure: stop web/worker startup; do not bypass the check.
- Migration mismatch: run the explicit reviewed migration job with the dedicated `BYPASSRLS` owner role; runtime roles never migrate on connect. If the owner preflight fails, correct role provisioning rather than setting a tenant scope or bypassing the check.
- Queue backlog/dead letters: suspend the affected handler if necessary, preserve tenant scope, inspect the control-only aggregate, and replay only with an idempotency proof.
- Missing task reminder: inspect the durable job, task version/status/reminder time, active owner membership, and the deterministic `reminder_due` timeline event. A completed suppressed job is expected for stale, rescheduled, terminal, unscheduled, or inactive-owner work; do not claim an external notification was sent.
- Restore mismatch: quarantine the restored target and backup artifact; never promote a partially reconciled restore.

## Evidence boundaries

Keep these states separate: implemented, locally verified, CI/PR, merged, deployed, production observed, customer UAT, and customer accepted. A green local run is evidence only for the first two states.
