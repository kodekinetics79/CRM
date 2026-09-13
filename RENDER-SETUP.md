# Wimblo: exact Render settings for the current code

September 13, 2026. These settings prepare a hosted installation of the current React/Express/SQLite application. They do not close the product gaps in PRODUCT-CLOSURE-REPORT.md. No Render deployment was performed. Latest Wimblo source is not yet committed/pushed to the Git branch.

## Service settings

| Render field | Value |
|---|---|
| Service type | Web Service |
| Runtime | Node |
| Repository | https://github.com/kodekinetics79/CRM |
| Branch | main, after the reviewed Wimblo release is committed/pushed |
| Root Directory | Leave blank: package.json is at this repository's root |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Region | US region, initially Oregon; verify all other stored copies/subprocessors against the buyer's geography rules |
| Instance count | One for the current SQLite/disk architecture |
| Persistent disk | Paid disk-capable service; mount `/var/data`, initially 1 GB, increase based on measured use |

The Express server serves both the built frontend and API. Do not configure this as a Static Site or run Vite dev/preview. Render requires the public listener on `0.0.0.0` and supplies `PORT`. A disk preserves writes only below its mount path; the default filesystem is ephemeral. Disk-backed services cannot scale to multiple instances and lose zero-downtime deploys. [Web service docs](https://render.com/docs/web-services), [disk docs](https://render.com/docs/disks).

## Environment variables: clean database installation

Replace the origin/admin placeholders in Render's Environment page. No passwords belong in Git or in the report.

| Key | Value | Meaning |
|---|---|---|
| `NODE_VERSION` | `24.15.0` | Pin the version used by the fresh local tests; verify Render installs it in build logs |
| `NODE_ENV` | `production` | Built assets, HTTPS and production bootstrap guards |
| `APP_HOST` | `0.0.0.0` | Public listener behind Render's proxy |
| `APP_ORIGIN` | `https://YOUR-ACTUAL-SERVICE.onrender.com` | Exact browser origin: no trailing slash, path, query or fragment; change to the exact custom HTTPS domain if used |
| `TRUST_PROXY` | `true` | Existing code trusts one proxy hop so forwarded TLS is recognized |
| `DB_PATH` | `/var/data/wimblo.sqlite` | SQLite database on the attached persistent disk |
| `ENABLE_ACCEPTANCE` | `false` | Blocks client-testing API/UI in standard production |
| `ALLOW_DEMO` | `false` | No synthetic seeding/demo accounts in the clean installation |
| `EVALUATOR_MODE` | `false` | The existing evaluator launcher is loopback-only and explicitly rejects production |
| `ADMIN_NAME` | Your initial administrator's full name | Required when the production database has no users |
| `ADMIN_EMAIL` | Your initial administrator's real email | Required at initial bootstrap; email is normalized to lowercase |
| `ADMIN_PASSWORD` | Unique private password, at least 16 characters with upper/lowercase, number and symbol | Set as a secret only in Render; required at initial bootstrap |
| `MFA_ENCRYPTION_KEY` | Independently generated server-only 32-byte key, encoded as hex or padded base64; configure as a private secret | Enables workspace-account authenticator enrollment/verification; preserve the same key for enrolled accounts/restores. No default and no platform-master MFA. |
| `BACKUP_ENCRYPTION_KEY` | A distinct independently generated server/operator-only 32-byte hex/padded-base64 key | Required only for the manual backup/restore CLI operator process; no normal-startup default or automatic backup worker. Keep separately from archives and the MFA key. |
| `PORT` | Leave Render's supplied value; default `10000` | Application reads Render's port; setting `10000` explicitly is optional |

[Render Node version configuration](https://render.com/docs/node-version) supports pinning via `NODE_VERSION`. A successful host build and runtime test is still required; local version testing is not proof of a live Render deployment.

After successful initial bootstrap, remove the three `ADMIN_*` variables from the service environment. Existing users remain on the persistent database. These variables do not reset an existing administrator password. A new empty database will need bootstrap values again.

The current code uses SQLite and database-backed opaque sessions, not an implemented `DATABASE_URL` or `JWT_SECRET` integration. There is no implemented Stripe/Mailchimp/SMTP sending credential configuration; adding variables does not create those integrations. Local platform settings are described below and do not imply automated subscription billing. `VITE_*` values are frontend-public and must not contain secrets.

`ALLOW_DEMO=false` and `EVALUATOR_MODE=false` prevent backend demo seeding/local evaluator mode. ENABLE_ACCEPTANCE=false now blocks test API/UI in production. Demo access is server-configured and standard login fields are blank; some foundation-specific branding/copy remains hardcoded. Use a separate acceptance deployment with synthetic data, never convert the shared demo database into the customer database.

## Hosted acceptance checks before use

Verify a successful Node/build install and live service; health returns 200; correct HTTPS origin login/CSRF cookie flow works; an administrator can save/reload a record; data survives service restart/redeploy; denied staff/viewer requests stay denied. Independently verify user scopes before institutional data is admitted. No hosted checks have yet been run here.

SQLite WAL files must stay with the database directory. The manual encrypted SQLite-aware workspace backup/restore CLI now exists and has scoped local recovery evidence; establish an adopted off-host copy/retention/cadence and perform a hosted restore drill. The JSON review snapshot omits newer tables and is not a recovery backup. Render disk snapshots alone are not this application's accepted recovery program. Managed PostgreSQL is a future scaling migration and currently needs code/schema changes.

For this code, a persistent disk is necessary for durable SQLite records. Free service without a disk is unsuitable for a durable client installation. Region selection alone does not certify compliance for all stored copies, logs, backups or providers.

## Existing service: verified configuration correction

September 13, 2026: Wimblo_CRM at https://crm-xenz.onrender.com was incorrectly Ruby/bundle install with a placeholder APP_ORIGIN and a failed build. API updates/readback verified Node runtime, build `npm ci && npm run build`, start `npm start`, health `/api/health` and APP_ORIGIN `https://wimblo.vercel.app`. Other variables/secrets were preserved; no credential was copied into this repository.

The free plan still has **no disk**, and its `/var/data/wimblo.sqlite` remains an unsuitable durability configuration. No new deployment or paid resource was created. No live authenticated journey or PostgreSQL integration is claimed. The configured origin anticipates a same-origin Vercel API route; that route is not yet connected to a working durable backend. Avoid direct Render-origin login unless the approved browser-origin configuration is changed accordingly. Source `vercel.json` currently configures security headers only, not an API rewrite.

## New local platform/AI configuration

See PLATFORM-AND-INTELLIGENCE-STATUS.md. PLATFORM_DATA_DIR must reside on durable protected storage alongside business databases; provisioning cannot run safely on free ephemeral storage. Initial platform credentials are separate server-only secrets and have no demo default. OLLAMA_MODEL is required for generation; direct cloud needs server-only OLLAMA_API_KEY and HTTPS endpoint. Local laptop loopback is not reachable from Render. No hosted AI, tenant recovery or automated subscription billing has been verified.


## Workspace MFA, receipts and correspondence acceptance

Both encryption keys are server/operator secrets: use independent values, never `VITE_*`, source, client bundles, shell arguments, logs or public files. No key values are supplied by this guide. `MFA_ENCRYPTION_KEY` protects individual account authenticator secrets; it does not encrypt the live business database/disk. Preserve the original key with independent restricted custody; replacing it without a reviewed re-encryption/re-enrollment plan can lock out enrolled users. Backup encryption uses its separately retained key; enabled restored accounts also need the original MFA key. No automatic key rotation exists.

Workspace administrators/staff/viewers may enroll their own authenticator and obtain one-use recovery codes. Enrolled login first returns a password-valid challenge, then authenticates only after valid MFA. Confirm/disable revoke old sessions. Hosted acceptance must verify own-account/CSRF controls, failed/replayed factors, recovery, correct tenant challenge routing and fail-closed behavior when the key is unavailable. This does **not** implement MFA for the separate platform master administrator, SSO or forced organization-wide enrollment; privileged-platform access policy remains an operational gate.

Configure the receipt organization/address/tax identifier/signature/footer through administrator-approved receipt-profile records, not invented environment defaults. Receipt issue requires staff confirmations of actual Print and hand-signing with date; unique numbered originals, voids and replacements remain retained. Active issued receipts protect financial edits/voids and identity merges. Noncash shows a description without assigned tax value; sponsorship benefits are disclosed without calculating deductibility. Tax/client wording approval remains required. Neither receipt issuance nor correspondence finalization independently verifies delivery, sends email or completes the existing gift acknowledgment ledger.

Correspondence permits saved versioned plain-text templates, explicitly selected eligible recipients, immutable preparation, human-reviewed finalization and searched history. It remains **Not sent**, including the Email draft preparation format. No provider credentials or outbound mail are configured by these modules. Verify primary-email/opt-out gates, recipient isolation, stale references/annual membership and safe text rendering in the hosted browser before admitting institutional data.

## Manual encrypted recovery CLI

Use `node scripts/backup.mjs --help` for the exact contract. Replace path/tenant placeholders with the operator-verified workspace mapping; the platform registry exposes workspace IDs, and its legacy Wimblo workspace ID is defined in server/platform.js. An archive's authenticated tenant label must match the expected restored workspace; the operator must select the correct source database. The workspace archive does not include platform registry/administrator/session data or external environment/provider keys.

```sh
node scripts/backup.mjs backup --db /var/data/wimblo.sqlite --out /var/data/private-backups/workspace.wbackup --tenant TENANT_UUID
node scripts/backup.mjs restore --archive /var/data/private-backups/workspace.wbackup --dest /var/data/NEW-workspace.sqlite --tenant TENANT_UUID
```

Supply `BACKUP_ENCRYPTION_KEY` privately through the operator process environment. The destination parent directory must already exist and be private/nonpublic. Prefer protected ignored server/data storage for local drills; never include databases, keys or archives in the distributable evaluator ZIP or static site. Outputs are atomic 0600 and refuse existing files/symlinks. Restore is offline to a **new absent path**, not a live HTTP/API restore, replacement of the running DB_PATH or automatic platform-registry repointing. Stop/isolate and reconcile the hosted deployment through an approved recovery procedure before an operator changes any live mapping.

Full installed SQLite tables/BLOBs are encrypted with AES-256-GCM; source SHA-256/schema/record counts/row digests are checked. Restore clears old sessions/MFA challenges/pending enrollment while preserving business/audit/immutable histories and enabled MFA/recovery state. Limits: 128 MiB encrypted archive including metadata, 200 tables, 500,000 rows, 1 MiB manifest. Independent local fixtures and offline CLI round trips passed; this is not a performed Render drill, remote/cloud copy durability, automatic schedule/alerting or an RPO/RTO SLA. Render's corrected free service still lacks a durable disk; local backup code does not remedy that service configuration.
