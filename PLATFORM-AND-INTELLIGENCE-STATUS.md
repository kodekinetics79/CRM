# Wimblo platform and intelligence: current implementation

September 13, 2026 · Wimblo **0.5.0** local working source, not a published production release. Current RFP inventory: **46 Local / 24 Partial / 11 Missing / 3 Evidence required**. See [current 84-criterion matrix](CURRENT-RFP-REQUIREMENTS-MATRIX.md) and [closure progress](REQUIREMENTS-CLOSURE-PROGRESS.md).

## Real capabilities implemented

The separate `/platform` console manages organization accounts. `server/platform.js` persists a platform registry, platform administrator and audit stream, plus isolated business databases for provisioned tenants. New tenants have a unique provided administrator, empty business data and UUID-specific session cookies; the legacy Wimblo workspace retains its existing database/settings/accounts. The selected-workspace cookie routes requests but grants no authority. Unknown selectors do not fall back; platform sessions grant no business-record access or impersonation. Suspension revokes tenant sessions and blocks access without deleting business history. Versioned changes control active/suspended status, trial/subscription/dedicated labels and AI availability. Data environment is immutable after creation. Plan labels do not collect payment, renew subscriptions or implement contractual entitlements.

There is no default platform administrator. Configure `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_NAME` and `PLATFORM_ADMIN_PASSWORD` server-side. The bootstrap password requires 16+ characters, uppercase, lowercase, number and symbol. Bootstrap only creates the initial account on an empty registry; changing environment values does not rotate an existing password. Platform identity still lacks MFA/SSO, password recovery and multiple-operator lifecycle controls; production admission remains open.

`PLATFORM_DATA_DIR` locates the registry and provisioned business databases. By default the server places it beside DB_PATH in a folder named after that database, keeping evaluator and ordinary local registries separate. All these files need protected durable storage and consistent recovery. The new manual encrypted full-workspace backup/offline NEW-path restore does not include the platform registry or environment/provider keys, and no scheduled/cloud platform recovery is verified. SQLite remains the actual implementation; Neon/PostgreSQL business migration has not happened. Free Render ephemeral storage does not meet this requirement.

The Intelligence screen has saved-record priorities independent of any model. Bounded Ollama assistance offers workflow help, selected constituent summaries and selected gift thank-you drafts. Admin/staff only, CSRF-protected generation, server-selected endpoint/model, synthetic-only workspace policy, minimal record facts, private-note/contact/history omission, contact opt-out and authoritative app-computed financial facts. Responses execute no tools or writes. A staff member may explicitly edit and save a reviewed communication draft through the existing validated business API; no message is sent or receipt issued.

Model responses are withheld after access/session, policy, opt-out or relevant source-record changes. Requests are bounded by input/output limits, timeout and one concurrent generation plus six provider calls per minute per user. Deterministic priority reads do not consume this model quota. These in-memory limits are single-process protection, not distributed billing budgets. Audits record task/status metadata, not prompts or generated text. Restricted workspaces remain blocked pending approved data scope/provider/privacy controls.

## Configuration

| Server variable | Purpose |
|---|---|
| PLATFORM_DATA_DIR | Protected durable directory containing registry and tenant databases |
| PLATFORM_ADMIN_NAME / EMAIL / PASSWORD | Initial separate platform administrator, server secrets/configuration only |
| OLLAMA_BASE_URL | Server provider endpoint; defaults to local loopback11434, remote endpoint must use HTTPS |
| OLLAMA_MODEL | Required server model name; local verification used gpt-oss:120b-cloud |
| OLLAMA_API_KEY | Server-only credential for direct Ollama Cloud; never a frontend/VITE variable |
| DB_PATH | Legacy Wimblo workspace business database |
| MFA_ENCRYPTION_KEY | Optional protected 32-byte tenant/workspace MFA key, hex or canonical padded base64; no platform-master MFA |
| BACKUP_ENCRYPTION_KEY | Separate operator key for encrypted full-workspace backup/offline new-path restore; no automatic scheduling |

Existing production origin/TLS/trusted-proxy/demo safeguards still apply. A cloud model routed through local Ollama is cloud processing. A laptop endpoint is not a dependable hosted inference service.

## Verification and practical limits

Current mounted 0.5.0 passed **325/325 tests**, zero failures/skips, in 10.8 seconds and a production build in 1.13 seconds after independent privacy repairs. Earlier checkpoints are historical; focused suites overlap. Coverage includes tenant/session/reference isolation, platform authorization/lifecycle/CSRF/lost storage, AI policy/opt-out/source races and limits, and reporting/events/fundraising/grants/tributes/receipts/recovery. AI guidance is grounded in actual workflows; it cannot send, collect, physically print/sign, issue receipts or confirm staff actions. See [CURRENT-RELEASE-EVIDENCE.md](CURRENT-RELEASE-EVIDENCE.md). This is local evidence, not institutional or cloud acceptance.

A real static workflow-help request returned HTTP200 in1,414ms through the existing signed-in local Ollama service. No private CRM data was used. This proves provider connectivity only: the model output initially included unsupported wording about buttons and sending, requiring additional grounding. It is not a correctness benchmark or production acceptance.

Browser verification covered the guided Intelligence screen and an isolated synthetic platform fixture: separate login, creating an empty restricted workspace, saved subscription label/suspension, changed account counts and audit history. The UI states clearly that billing is not connected. Production cloud, institutional data, buyer migrations, hosted tenant recovery, provider latency/reliability and independent acceptance remain unverified. The requirements-first wave independently added local custom reporting/internal schedules, documents/migration/households, analytics, fundraising/events, correspondence/receipt history, optional tenant-account MFA and manual encrypted operator recovery. Each retains its stated buyer/configuration/history/scale limits. The addons do not close absent live communications/payment/productivity integrations, platform-master MFA, hosted operations or qualifying provider references. The report catalog exposes curated business fields/metadata, not arbitrary secret/binary/raw-SQL access.

## API additions

`/api/platform/config` returns configuration status only. Separate `/api/platform/auth/login|me|logout` sessions protect `/api/platform/tenants` GET/POST, `/api/platform/tenants/:id` PATCH and `/api/platform/audit` GET. Provisioning needs name, slug, plan/dataMode and strong initial admin; PATCH requires version plus status/plan/aiEnabled. Platform errors are denied without business fallback.

Workspace login optionally takes `tenantSlug`; no public organization directory is exposed. Workspace config/data include tenant name/slug when wrapped by the platform. `/api/intelligence` reads priorities/provider-policy metadata; `/api/intelligence/assist` accepts only help(question), constituent-summary(recordId), thank-you-draft(recordId). Reviewed saving is a separate ordinary communication POST.


## Release boundary

The platform console remains an optional local commercial control plane with labels rather than billing, renewal or contractual entitlement execution. The proposed product license is one year plus up to four annual renewals, four full users plus two optional no-added-cost nonadministrator helpers; no approved price/SLA, signed terms, award or IP buyout exists. Q&A54's JEF-personnel scope does not mandate school-level reporting restrictions; helper/module/field/export policy remains an agreed access decision.

Tenant/workspace own-account TOTP enrollment/challenge/recovery now works only with a valid protected server encryption key; production custody/adopted enrollment/recovery and the separate platform master's MFA remain open. Offline AES-256-GCM full-workspace restore is verified into a new path, not a cloud/scheduled recovery service. No deployed 0.5.0 release, Neon/PostgreSQL business migration, ASP.NET/.NET or Next.js migration, live email/payment processing or qualifying references are claimed.
