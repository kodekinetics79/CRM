> Subsequent local reliability-depth pass: import grouped controls, fiscal preview invalidation, bounded batch history/lineage and retained financial/correspondence source guards are implemented; **468 tests pass**. See COMPETITIVE-READINESS-DEPTH.md. Zack deferred Render setup to later; the live production gates below remain open.

# Wimblo production handover — current engineering checkpoint

September 13, 2026. Kode Kinetics LLC. This register supersedes earlier statements about optional administrator MFA or missing platform recovery. It does not replace the RFP requirements inventory or buyer acceptance. **Do not admit real buyer data yet.**

## Verified account configuration

| Service | Actual inspection | Consequence |
|---|---|---|
| Render | Wimblo_CRM, `srv-daj8htnqj5pc73cl051g`, Oregon, one instance, free, no persistent disk; repository kodekinetics79/CRM, main; backend URL `https://crm-xenz.onrender.com` | Current SQLite backend cannot safely run on this ephemeral service. Startup now requires an explicitly confirmed durable mount. Latest inspected deployment dep-daj8htvqj5pc73cl05qg failed its build against old source e0199a1c5c1cc5188559808611e1ca32a44b1218. No production upgrade or rollout of this checkpoint is claimed. |
| Vercel | Wimblo project linked to CRM/main; Vite frontend, Node 24.x; Neon environment variable names present | Environment attachment does not integrate the business API. Existing vercel.json has no backend rewrite. Actual /api/health returned HTTP 404. |
| Neon | Project ancient-brook-87383598, main br-odd-fire-ava8ausd, AWS US East 1; read-only public table inventory returned zero CRM tables | Business records still use SQLite. DATABASE_URL is not consumed by that business persistence layer. No PostgreSQL migration is claimed. |
| Neon object storage | Actual branch storage inspection returned “branchable-storage is not available in this region” | Do not assume this attached project can host documents. A separately approved compatible private storage provider is necessary if external storage is enabled. |

## Runtime profile prepared for the existing backend

Build `npm ci && npm run build`; start `npm start`; Node 24.x; listener `0.0.0.0`, Render-supplied PORT. Serve frontend and API together on the backend origin for the first validated rollout. Set APP_ORIGIN to that exact HTTPS origin and TRUST_PROXY=true only behind the controlled HTTPS proxy. Existing API HTTPS/Origin/CSRF enforcement remains active.

For the current SQLite architecture, use **one instance with a persistent disk mounted at /var/data**. Set PERSISTENT_DATA_DIR=/var/data, PERSISTENT_STORAGE_CONFIRMED=true after checking the actual mount, DB_PATH=/var/data/wimblo.sqlite, PLATFORM_DATA_DIR=/var/data/wimblo-platform. Both business database and platform registry must be inside the mount. Symbolic-link escapes, missing mounts, duplicate backup/MFA keys, evaluator/demo/acceptance startup are rejected before initialization. Graceful shutdown stops new connections and has a bounded 25-second deadline.

This is a single-instance deployment with maintenance during changes. It is not high availability, horizontal scaling or the requested possible PostgreSQL/.NET transition. A genuine PostgreSQL migration requires converting the synchronous SQLite data access and testing transaction/privacy/history equivalence; attaching a URL is insufficient.

Render's current pricing lists Starter compute at $7/month and persistent storage at $0.25/GB/month. A 1 GB disk would start around $7.25/month before bandwidth, external storage and monitoring. Paid resource creation requires owner approval. [Pricing](https://render.com/pricing), [persistent disk constraints](https://render.com/docs/disks).

For Vercel after the backend is safely operational, use a same-origin external `/api/:path*` rewrite to the verified backend. Set the backend's single APP_ORIGIN to the chosen Vercel public origin. Test Secure/HttpOnly/SameSite cookies, CSRF, wrong-Origin denial, tenant selection and fresh MFA sign-in through that exact proxy. Do not add cross-origin browser secrets or loosen credentials to make the proxy work. [External rewrites](https://vercel.com/docs/routing/rewrites).

## Control scope

| Control | Implemented engineering behavior | Required operational proof |
|---|---|---|
| Administrator access | Workspace and platform administrators require MFA. Password-only initial sessions have enrollment-only access; enrollment revokes old sessions; factor sign-in binds current account access; required MFA cannot be disabled. Recovery codes are single-use. | Retain the MFA key separately, complete real administrator enrollment, adopt verified identity-recovery procedure. Staff MFA is optional; SSO remains separate. |
| Bootstrap | Fresh production workspace/platform require separately configured actual administrator accounts and strong passwords. Existing accounts remain after removing bootstrap credentials. Synthetic registries/accounts are rejected. MFA-authenticated platform operators can create additional administrators and reasonedly suspend/restore them with version checks, retained audit and last-active protection; access changes revoke sessions/challenges. | Owner-supplied admin identities; privately remove bootstrap password variables after setup; no demonstration credentials. |
| Documents | SQLite inline storage remains explicitly supported; private external storage uses immutable tenant-bound references, exact version/checksum reads and authorized server downloads. Grant evidence must verify content before committing completion and recheck current pins. | Compatible approved-country provider, private/versioned/encrypted bucket verification, least-privilege server credentials, real upload/download/restore probe. Configuration alone is not proof. |
| Recovery | Encrypted workspace backups verify installed tables, native history and document contents. Full-platform tooling additionally covers registry, tenant map, privileged accounts/MFA/audit and all tenant archives; restores publish a new root and clear sessions/challenges. | Actual scheduled off-host copies, exact readback, timed restore/restart drill, platform/tenant reconciliation and retained separate encryption keys. |
| Readiness | `node scripts/production-check.mjs --help` exposes a private operator check. It reads the workspace without modification and outputs safe checks, not credentials. Missing durability, readback, restore, monitoring or retention evidence blocks readiness. Uncommitted/Orphaned uploads also block admission until verified reconciliation, even when completed-document archives pass. | Actual operator-controlled evidence; runtime checks do not certify compliance, residency, provider SLA or buyer acceptance. |
| Business security | Existing server-side role controls and implemented module-specific privacy, current-source permissions, versioned writes, CSRF, account/tenant suspension and retained native history remain required. MFA does not expand permissions. | Buyer-approved responsibility/helper/export matrix, negative-access tests on real roles and accepted segregation of financial duties. |

Keys are server-only. MFA_ENCRYPTION_KEY and BACKUP_ENCRYPTION_KEY must be valid **distinct** 32-byte values, separately retained outside archives. Do not publish environment files, databases, recovery archives, private evidence or credentials in the repository/review ZIP/frontend. Provider keys and signing/identity recovery custody are not restored from a business archive. [Private storage setup](PRIVATE-STORAGE-SETUP.md) lists actual configuration, restricted permissions and current file/recovery limits.

## Acceptance sequence and exact dependencies

1. Owner approves durable hosting and selects private off-host document/recovery storage plus monitoring. No compatible object-store credentials were available in the inspected Vercel environment metadata.
2. Configure fresh private durable roots and actual workspace/platform administrators. Complete enrollment and fresh MFA login; remove bootstrap passwords. Keep AI restricted to its existing synthetic-only policy until approved real-data processing terms exist.
3. Deploy the tested source, verify restart preserves records and tenant controls, exercise rejected wrong-origin/CSRF/out-of-scope requests, then validate any Vercel proxy.
4. Operate scheduled encrypted off-host backups; test exact ciphertext readback, full new-root restore, authentication reset and business/file-history reconciliation. Exercise monitoring and alert escalation with owner-authorized recipients; approve retention and exit procedure.
5. Obtain actual ten-year source exports/mappings/deltas, confirm totals/files/consent, agree receipt/payment restrictions and four full-user/two optional helper journeys. External email/SMS/payment/SSO/connectors require selected providers and credentials; drafts/method labels are not provider execution.
6. Complete signed DPA/subprocessor/residency/security assurance, staffed support/training and qualifying provider/reference evidence. These cannot be generated by application code or marked passed on the buyer's behalf.

The 84-entry requirements inventory is separate: its last reviewed status remains **46 local / 24 partial / 11 missing / 3 external** until criterion-specific evidence is reassessed. Production hardening does not turn all 84 criteria into completed capabilities.

## Final local verification

Integrated frozen source: **446/446 tests passed**, zero failures/skips, 19.3839 seconds. Build passed in **1.14 seconds**; main bundle 482.15 kB. Focused MFA/succession/component 104/104, private document/grant/storage 44/44, initial recovery/readiness 26/26 and retrieval 7/7 runs overlap that integrated suite and are not additive totals.

The actual production entrypoint was started twice against an isolated explicitly confirmed temporary fixture mount, with HTTPS-proxy policy exercised through controlled forwarded TLS headers: administrator enrollment-only denial, factor enrollment/fresh recovery-code sign-in, authorised synthetic record save, wrong-origin denial, graceful restart with bootstrap passwords removed, preserved record/MFA and reused-code denial. This tests application behaviour; a temporary fixture directory is not proof of a provider persistent disk.

Real browser reload of the rebuilt local evaluator Dashboard succeeded with no observed console warning/error. A separate HTTPS production-browser fixture could not open because its local certificate was untrusted; no certificate warning was bypassed, no browser enrollment journey or live TLS deployment is claimed. Required enrollment screens have isolated component-state tests. Complete browser MFA/cookie/proxy journeys after a valid hosted rollout; the owner performs actual factor setup and retains recovery codes.

Independent read-only architecture review found and reproduced a post-upload orphan-provenance defect; it is fixed with exact-version cleanup or retained Orphaned status, and no usable document/evidence commit. Final scoped re-review found no new confirmed defect in that repair, bucket residency guards, off-host retrieval or administrator succession. This is engineering review, not licensed financial signoff, external certification or an accepted security assessment.

A **nonactivated** deploy/vercel-proxy.template.json contains the exact backend rewrite to review after the backend is operational. The active vercel.json remains unchanged to avoid routing the public application to a known unready backend. Private storage setup lists actual permissions/configuration and bounded recovery limits.
