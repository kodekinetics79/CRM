# Wimblo 0.5.0 evaluator pilot API contract

This is a local evaluator pilot with synthetic data, not an assertion of production certification. Node 24, Express 5, node:sqlite. Server binds 127.0.0.1 port 4311 by default; APP_HOST/PORT configurable. In production serve dist. Use app export createApp({dbPath, seed=true}) for tests; index.js starts server. Current module routes below share the authenticated workspace and atomic audit boundary.

## Endpoints
- POST /api/auth/login {email,password} -> {user,csrfToken} for an unenrolled account, or {mfaRequired:true,challengeToken,expiresAt} without an authenticated session for an enrolled account; HttpOnly session cookie, SameSite Strict. Demo admin alex@foundation.example / FoundationDemo!2026; staff staff@foundation.example, viewer board@foundation.example same password. Local test-only credentials; production always refuses demo seeding and demo/evaluator/acceptance flags; ALLOW_DEMO cannot override this guard.
- GET /api/auth/me -> {user,csrfToken}; 401 anonymous. POST /api/auth/logout.
- GET /api/workspace -> {user,csrfToken, data:{constituents:[],gifts:[],campaigns:[],grants:[],volunteers:[],events:[],tasks:[],communications:[],designations:[]}, audit:[], settings:{organizationName,fiscalStartMonth}}. All auth required. Nonsecret organizationName/fiscalStartMonth settings are readable by every authenticated role for consistent reporting. Audit, user management, settings edits and backup are admin only. Viewer business records are readonly; staff ordinary CRUD. Acceptance-mode viewers may submit observations through the narrowly scoped feedback POST exception; they cannot edit/delete observations or business records. Mutations require X-CSRF-Token matching session.
- POST /api/records/:collection body record -> {record}; PATCH /api/records/:collection/:id body including version -> {record}; DELETE /api/records/:collection/:id body {version} -> {ok:true}. IDs generated, integer optimistic version prevents stale writes with 409. All records include id,version,createdAt,updatedAt. Audit transaction together with mutation.
- POST /api/gifts/import {rows:[gift record...]} -> {imported}; atomic validation, duplicate externalRef rejected 409 (if nonempty); max 500 rows. Gifts use same record endpoint for single creation. DELETE a gift only through POST /api/gifts/:id/void {version,reason} -> {record}; do not physically delete financial records; status Posted/Voided. Voided excluded from totals.
- POST /api/volunteers/:id/clock {action:'in'|'out',version} -> {record}; persisted clockIn, hours updated on out; invalid repeated operations rejected. Changing clockIn/hours via generic update disallowed.
- POST /api/events/:id/register {constituentId,seating} -> {record}; respects capacity, no duplicate. POST /api/events/:id/checkin {constituentId} -> {record}; must registered. DELETE /api/events/:id/register/:constituentId cancel persisted registration.
- GET /api/users admin -> {users} no passwords/hash. POST /api/users {name,email,password,role} -> {user}. PATCH /api/settings {organizationName,fiscalStartMonth} -> {settings}. GET /api/backup admin -> JSON authenticated review snapshot WITHOUT sessions, user password hashes, or credentials. It omits newer noncollection tables and is not a full recovery backup; use the offline encrypted CLI described below.
- Error JSON {error,message?}; zod issue fields optional {fields}; reject invalid input with 400/409/403, no stack traces to client.

## Record fields (camelCase, exact names)
constituents: name,email,phone,type (Individual, Business, Foundation, Alumni, Employee, Staff, Community partner), household, parentId nullable FK to constituent, contacts array [{name,email,role}], segments string, preference (Email,Phone,Post,Do not contact), notes.
designations: name,school,parentId nullable FK designation,accountCode,description. No hierarchy cycles; referenced records cannot delete.
campaigns: name,type (Annual,Capital,Major gifts,Planned giving,Matching gifts,Peer-to-peer),goal integer cents,startDate,endDate,status (Active,Planned,Completed),description.
gifts: constituentId FK,amount integer cents >0,type (Cash,In-kind,Grant,Fee payment,Employee giving,Sponsorship),method (Check,Cash,Credit card,ACH,Payroll,In-kind),date YYYY-MM-DD,campaignId nullable FK,allocations [{designationId FK,amount positive cents}] must sum amount,externalRef optional unique,notes,tribute,softCreditId nullable FK,pledge optional legacy string,pledgeId/grantId nullable linked commitments,giftKind (One-time,Recurring,Pledge fulfillment,Matching gift,Planned gift),status Posted/Voided server-controlled. In-kind valued separately by UI; don't claim cash inflow. schoolYear uses the configured fiscal start (default July, matching Q&A54 July1–June30), with an explicit versioned/reasoned schoolYearOverride available through POST /api/gifts/:id/school-year. Reports honor the effective assigned year while preserving the actual transaction date.
grants: name,funderId nullable FK constituent,amount requested cents,awardedAmount recorded cents,awardDate YYYY-MM-DD nullable,stage (Prospect,Preparing,Submitted,Awarded,Declined,Closed),deadline YYYY-MM-DD,reportDue YYYY-MM-DD nullable,notes.
volunteers: constituentId FK,skills,shift,eventId nullable FK,hours numeric >=0,capacity optional number,notes; clockIn server-controlled. Seed hours allowed.
events: name,date YYYY-MM-DD,location,capacity integer >0,ticketPrice cents,sponsorGoal cents,notes, registrations server-controlled [{constituentId,seating,checkedIn,registeredAt}]. Initial registrations [] on create.
tasks: title,dueDate YYYY-MM-DD,owner,status (Open,In progress,Completed),priority (Normal,High),constituentId optional FK,notes.
communications: constituentId nullable FK,subject,channel (Email,Phone,Meeting,Post),status (Draft,Logged),date YYYY-MM-DD,body,notes. Drafts/logs only; no live send or claimed delivery. Block new marketing drafts for Do not contact preference. UI preview mail merge using selected contact.

Seed enough realistic synthetic records across July-Sep 2026 and previous year, campaigns, school/classroom designations, forthcoming grants/tasks. Email addresses all example.test/example.com/example domains. No real student data. Dashboard computes values from actual DB, never hardcoded claims.

## Security and integrity
Validate/strip or reject protected metadata keys; money always cents, actual calendar dates checked, FK validation in same transactions; cross-request no async writes inside sync sqlite transaction. Scrypt hashes, timing safe compare; random opaque session token hashed database-side, expire 8h and idle timeout 30min, basic login rate limiting and bounded request size; origin allowlist localhost:5174/4311 and production APP_ORIGIN; no wildcard CORS; Helmet security headers, query parameters binding, production HTTPS secure cookies, trusted proxy explicit only. Input lengths bounded. Limit JSON body 2MB. Protect last admin; don't expose business data anonymous. Backup only admin. Append-only audit database trigger as useful. MFA secrets and offline backup archives now have implemented encryption; this does not establish encryption of the live business database/disk, SOC2/SSO, email/payment integration or hosted assurance.

## Release0.4.0 scheduling and local integrity contracts

`/api/records/volunteerShifts` uses the authenticated/versioned/audited collection contract with `name`, calendar `date`, 24-hour `startTime`/`endTime`, `location`, positive integer `capacity`, optional `eventId`, `status` Open/Closed and `notes`. Same-day start precedes end; one shared foundation scheduling timezone is assumed. Existing reservation history locks date/times/event. Capacity cannot drop below Reserved places.

`/api/records/shiftReservations` stores `shiftId`, eligible individual/alumni/employee `constituentId`, `status` Reserved/Waitlisted/Cancelled and `notes`. POST/PATCH are staff/admin-only with CSRF/origin protection. Capacity, active duplicates and same-person overlapping Reserved intervals are checked inside the mutation transaction. Waitlist promotion is explicit. Identity remains fixed; DELETE returns403—cancel to retain history. Shift/constituent references remain protected even for Cancelled history.

`GET /api/readiness` is administrator-only and read-only. It returns `checkedAt`, `recordCount`, a clearly local `scope` and named `checks` with Passed/Needs review and concrete record issues. Current checks cover schema-backed fields/references/constraints, volunteer dated/historical time references and aggregate reconciliation, and simultaneous clocks. Voided receipt history is excluded from live commitment ceiling checks but linked references are still verified. It does not fetch external endpoints, test provider credentials or assert institutional approval.

These scheduling workflows address RFP A5.4 and the specific-time capacity portion of A5.6; public self-service identity, cancellation and email reminders remain separate scope. New client evaluation scenario IDs `shifts` and `operations` are accepted under the same board feedback exception.

## 0.4.2 security additions

- GET /api/config is unauthenticated but subject to production HTTPS/origin guards; returns only `{demoAccess,acceptanceEnabled}`. No secrets or personal data. GET /api/workspace includes matching capabilities.
- GET /api/users remains admin-only; each user now includes Boolean active and integer version, without credential hashes. POST creates active version-1 accounts.
- PATCH /api/users/:id requires administrator, CSRF and strict `{version,role,active}`. Missing account 404; stale version or attempted removal of final active administrator 409; invalid fields/role 400; staff/viewer 403. Actual changes atomically increment version, revoke all target sessions and audit before/after access; unchanged values are a no-op. Returns `{user,sessionsRevoked}`. Suspended/unknown-role accounts cannot login or access authenticated endpoints; reactivation requires fresh login.
- Standard production defaults acceptance off. `/api/records/evaluations` and descendants return 404 outside acceptance, including authenticated requests. Workspace returns empty evaluations; historical administrator snapshots may include retained observations. ENABLE_ACCEPTANCE, ALLOW_DEMO and EVALUATOR_MODE remain prohibited in production; use a separate nonproduction synthetic deployment.
- Current staff/viewer business reads remain broad; these access-lifecycle additions do not create school/program/field scopes. Own-account MFA is described below.

## Local platform/intelligence additions

See PLATFORM-AND-INTELLIGENCE-STATUS.md for current endpoints, separate tenant/platform authority, synthetic-only model policy and explicit reviewed-draft saving. Wrapped config adds tenant name/slug and platformAvailable; standalone core config retains its original flags. No billing/send/provider-approval claim.


## Workspace-account MFA

Current server/mfa.js and createApp routes use an explicitly configured server-only `MFA_ENCRYPTION_KEY` (32-byte hex or padded base64). No generated/default production master key exists. This protects enabled/pending authenticator secrets with AES-256-GCM; it does not encrypt the live SQLite business database. Workspace and separate platform administrators must enroll and complete fresh factor sign-in in production. Staff/viewer enrollment remains per-account and optional. Platform MFA has its own account/session controls; institutional SSO remains absent.

| Endpoint | Request / response | Boundary |
|---|---|---|
| GET /api/auth/mfa/status | `{available,enabled,recoveryCodesRemaining}` | Authenticated own account; no secret |
| POST /api/auth/mfa/enroll | `{password}` → `{secret,otpauthUrl,expiresAt}` | Own authenticated account + CSRF + current password; sensitive enrollment output for that user only |
| POST /api/auth/mfa/confirm | `{code}` → `{enabled,recoveryCodes,sessionsRevoked,reauthenticationRequired}` | Own account + CSRF; six-digit TOTP, eight one-use recovery codes shown on confirmation; all prior sessions revoked |
| POST /api/auth/mfa/verify | `{challengeToken,code}` → `{user,csrfToken}` and session cookie | Password-valid challenge required; TOTP or unused recovery code; no session before success |
| POST /api/auth/mfa/disable | `{password,code}` → `{enabled,sessionsRevoked,reauthenticationRequired}` | Own authenticated account + CSRF + current password + unused factor; revokes old sessions |

TOTP uses thirty-second steps with replay protection; challenges/pending enrollment expire after five minutes, with persisted account failure limits. Verification rechecks active role/account version. Missing/wrong master key fails enrolled login/verification closed with503, not a password-only bypass. In platform mode login accepts the existing `tenantSlug` selector and tenant-selector cookie routes the MFA challenge to its owning workspace; tenant suspension blocks pending verification. This selector is not an authenticated business session.

## Reviewed correspondence (preparation only)

All reads require a workspace account; viewer reads, staff/admin writes, CSRF on writes. Templates/preparations/finalizations are tenant-local database records. This module does not send email, record delivery, issue numbered receipts or mark existing gift acknowledgments completed.

| Endpoint | Contract |
|---|---|
| GET /api/correspondence/templates | `{templates,mergeFields,format:'Plain text',delivery:'Not sent'}` |
| POST /api/correspondence/templates | `{name,kind,subject,body}` →201 `{template}`; kind Acknowledgment / Annual employee / Messaging |
| GET /api/correspondence/templates/:id | `{template,revisions}`; original definitions retained |
| PATCH /api/correspondence/templates/:id | Full template fields + current `version` → `{template}`; stale409; kind cannot change |
| POST /api/correspondence/prepare | `{templateId,templateVersion,channel:'Print'|'Email draft',giftIds}` for acknowledgment; use explicit `constituentIds` for Messaging / Annual employee, plus calendar `year` for Annual employee →201 `{correspondence,delivery:'Not sent'}` |
| GET /api/correspondence | Optional `q,constituentId,giftId,status` (Prepared / Finalized) → `{correspondence,delivery,limit:100}` |
| GET /api/correspondence/:id | `{correspondence,delivery:'Not sent'}` |
| POST /api/correspondence/:id/finalize | `{version:1,preparationDigest,confirmed:true}` → `{correspondence,delivery:'Not sent'}`; repeated finalization409 |

A snapshot exposes id/status/version/preparationDigest, template id/name/kind/version, channel, items, created/finalized attribution, and the explicit unchanged-acknowledgment-ledger statement. Each item has `{recipient:{id,name,email,preference},subject,body,semantics,references:[{collection,id,version,recordDigest}]}`. Finalization rechecks current template, organization wording, referenced records/preferences and annual gift membership; stale409 or current consent denial requires new preparation/review. Stored text and original provenance remain immutable after later record/template edits.

Common merge fields: `recipientName,recipientEmail,organizationName`. Acknowledgment additionally permits `giftDate,giftType,giftReference,monetaryAmount,noncashValue`; Annual employee permits `calendarYear,annualEmployeeAmount,giftCount`. Unknown/object-path/executable placeholders fail; substituted values are not recursively interpreted. Render as plain text/escaped React content, never innerHTML. Only explicitly selected records are included, max100, no duplicates. Do not contact and merged identities block preparation/finalization; Email draft requires Email preference and the primary email. Secondary contacts/soft-credit people are never silently added. Fees/voids/future-dated gifts are excluded; noncash is described as recorded support, not deductible value. Annual employee totals use only the actual calendar year's posted Payroll Employee giving through today for selected Employee constituents. Limits:200 templates,1,000,000-byte prepared snapshot,100 history results. Tax/client wording approval and all provider delivery remain pending.

## Numbered receipt register (staff-confirmed hand-signed Print)

Viewer reads; staff/admin prepare/issue/void/reissue with CSRF; **only administrator** configures/approves the receipt profile. No default tax identifier or assumed legal certification exists. This is separate from correspondence review and does not mutate the existing completed acknowledgment ledger.

| Endpoint | Contract |
|---|---|
| GET /api/receipt-profile | `{profile,configured,notice}`; administrators also receive profile revisions |
| PUT /api/receipt-profile | `{version:0}` first / current version edit plus `organizationName,address,taxIdentifier,signatureLabel,customFooter,approved:true` → `{profile,notice}`; stale409 |
| POST /api/receipts/prepare | Individual `{kind:'Individual',giftId,profileVersion,noncashDescription?,benefitsDescription?,benefitValueCents?}` or annual `{kind:'Annual employee',constituentId,year,profileVersion}` →201 `{receipt}` |
| GET /api/receipts | Optional `q,giftId,constituentId,status` (Prepared / Issued / Voided) → `{receipts,limit:100,notice}` |
| GET /api/receipts/:id | `{receipt}` with retained source/profile snapshot and issue/void/replacement history |
| POST /api/receipts/:id/issue | `{version:1,preparationDigest,channel:'Print',printed:true,handSigned:true,issueDate:'YYYY-MM-DD'}` → `{receipt}`; actual nonfuture date on/after source transactions |
| POST /api/receipts/:id/void | `{version,reason}` → `{receipt}`; only current active Issued receipt |
| POST /api/receipts/:id/reissue | Original must be Voided; `{profileVersion,reason,giftId?,noncashDescription?,benefitsDescription?,benefitValueCents?}` →201 new Prepared `{receipt}` linked prior original; annual keeps original employee/year |

Receipt status/version: Prepared/1 (no number), Issued/2, Voided/3. Unique tenant-local `R-00000001` numbers are allocated atomically only on issue. Response includes monetaryCents, recipient, calendarYear, giftCount, gift facts, approved profile, references/digests, number, issue/void, priorReceiptId/reissueReason and replacements. Issue rechecks source/profile/current recipient/annual membership; stale or repeated issue409 without consuming a number. Overlapping active issued receipts for the same gift are blocked. Original snapshots and all issue/void events are retained; reissue supplies current descriptions/benefits again and only one replacement can be issued for a given original.

Fees/voids and soft-credit recognition cannot become receipts. Individual noncash requires a description and displays **no assigned tax value**, with zero monetaryCents. Sponsorship requires benefits description and separately disclosed benefitValueCents (explicit zero allowed), with no deductible amount calculation. Annual employee uses actual-calendar-year posted Payroll Employee giving, not assigned fiscal year. Do not contact/merged identities fail preparation. Limits:1,000,000-byte prepared receipt,10,000 annual source gifts,100 searched results.

Active issued receipt history blocks actual financial gift changes/voids; void the receipt before correction and prepare/review a replacement. Nonfinancial notes remain editable. Receipt-owned guards also block identity-merge preview/commit touching either issued recipient or issued-source direct/soft-credit identity. Prepared-only merge may proceed but invalidates stale issuance. Staff `printed`/`handSigned` confirmations are a log of claimed actual human actions, not independent delivery proof. Workflow/model assistance may explain the register and its controls but cannot physically print, sign, issue or confirm those staff actions; client tax/wording approval and email/provider transmission remain pending.

## Offline encrypted full-workspace recovery

The backup module is **not an HTTP endpoint**. `scripts/backup.mjs --help` documents manual offline operation. `backupWorkspace({db,outputPath,tenantId,encryptionKey,maxBytes?})` snapshots a live SQLite connection through VACUUM INTO a private temporary file. `restoreWorkspace({archivePath,destinationPath,expectedTenantId,encryptionKey,maxBytes?})` decrypts/verifies into a new absent destination only; existing files/symlinks/live databases are never overwritten.

`BACKUP_ENCRYPTION_KEY` is a distinct server/operator-only 32-byte hex/padded-base64 key, retained separately from `MFA_ENCRYPTION_KEY`; no key value belongs in API payloads, source, client bundles or archive headers. AES-256-GCM authenticates format/version/explicit tenant UUID; all SQLite bytes, source SHA-256, schema fingerprint, table counts and row digests are inside the encrypted envelope. Full installed workspace tables include document bytes/revisions, receipt/correspondence/fundraising/event/grant/tribute histories, password hashes and encrypted MFA state. No environment/provider master keys or platform registry are read into this workspace archive.

Restore verifies SQLite integrity/schema/counts/digests, preserves business/audit/immutable histories, clears sessions/MFA challenges/pending enrollments, and retains enabled MFA/recovery history. The same separately managed MFA master key is required for restored enabled accounts. Limits: 128 MiB archive including metadata, 200 tables, 500,000 total rows, 1 MiB manifest. Atomic 0600 output, bounded reads, no overwrite. This proves manual local recovery; no operated automated backup schedule, remote/cloud durability, funded response team or RPO/RTO SLA is implied. Separate full-platform recovery tools include the registry and tenant databases/files; this workspace archive alone does not.


## 0.5.0 grant operations: retained milestone evidence

`/api/grant-operations` is workspace-authenticated. Staff/admin writes require CSRF; viewer reads are limited by documentary evidence privacy. A milestone records Application / Report / Agreement, an active staff/admin owner, a grant source snapshot and Open / Completed status. Completion is a human-confirmed documentary record; it does not submit an application/report, send reminders, create an award or alter grant/gift money.

| Endpoint | Contract |
|---|---|
| GET /api/grant-operations | Optional `grantId,status,kind,from,to` → `{milestones,documents,grants,owners,scope}`; document/revision candidates are privacy-filtered |
| POST /api/grant-operations | `{grantId,name,kind,dueDate,ownerId,ownerVersion,grantVersion}` →201 `{milestone}` |
| GET /api/grant-operations/:id | `{milestone}` including immutable history; unavailable/private404 |
| PATCH /api/grant-operations/:id | Current `version` plus `name,kind,dueDate,ownerId,ownerVersion,grantVersion` → `{milestone}`; only Open milestones |
| POST /api/grant-operations/:id/complete | `{version,grantVersion,ownerVersion,documentId,documentVersion,revision,completedDate,reference,confirmed:true}` → `{milestone}` |
| POST /api/grant-operations/:id/reopen | `{version,reason}` → new Open `{milestone}`; original completion remains in history |
| DELETE /api/grant-operations/:id | Administrator-only;403 retained history |

Completion requires a current, unarchived document attached to that same grant, an existing immutable revision with Final / Submitted status, and the matching Proposal / Report / Agreement category. Its bytes must match stored SHA-256. Completion date is nonfuture and cannot precede a supplied evidence date. Current milestone/grant/active-owner/document versions are checked atomically; stale409, invalid400, corrupted evidence503. The retained proof includes source grant requested/awarded values, owner/version, document/version/revision/category/status/visibility/filename/hash/size, completion date/reference, staff confirmation and audit attribution. It is evidence of the saved staff statement and selected file, not independent verification of external submission or approval.

Document API lists/detail/revision/archival responses filter each saved revision by its own metadata visibility as well as current document visibility. A private original revision remains unavailable to staff/viewers after a Workspace latest revision is added; its metadata is omitted and `/api/documents/:id/revisions/:revision/content` returns404 without returning bytes or recording a successful download. Administrators retain original metadata/content.

Historical grant/owner/document references cannot be deleted through supported routes. Revising or archiving a document does not rewrite an earlier completion. Saved administrator-only evidence remains restricted after reopen or a later public revision; a document subsequently made private also restricts its retained milestone history. Inaccessible milestones are omitted from lists and return404 individually. Curated grant metadata reporting follows saved and current evidence privacy; raw file contents/source snapshots are not report exports.

## 0.5.0 honor and memorial tributes: reviewed notification drafts

Tributes are separate gift-linked records. They do not change the gift donor, soft credit, allocations, amount or received-income ledger. Staff/admin writes require CSRF; viewer reads honor both current and retained privacy. Supported fields are `giftId,type:'Honor'|'Memory',honoreeName,honoreeId:null|id,notificationRecipientId:null|id,message,notes,visibility:'Team'|'Staff only',donorDisclosureApproved:boolean`. Provide an entered honoree name or linked existing honoree; notification recipient is explicitly selected, never inferred. `donorDisclosureApproved` defaults false and records staff review, not independently verified donor consent.

| Endpoint | Contract |
|---|---|
| GET /api/tributes | Optional `q,giftId` → `{tributes,notice}`; up to100 visible records |
| POST /api/tributes | Tribute fields →201 `{tribute}`; up to10,000 tribute records |
| GET /api/tributes/:id | `{tribute,revisions}`; retained definitions and original gift/donor/honoree/recipient source snapshots, privacy-filtered |
| PATCH /api/tributes/:id | Partial supported fields plus current `version` → `{tribute}`; original giftId cannot change; stale409 |
| DELETE /api/tributes/:id |403; definitions and source/notification history retained |
| POST /api/tributes/:id/notifications/prepare | `{version,channel:'Print'|'Email draft'}` →201 `{notification}` |
| GET /api/tribute-notifications | Optional `tributeId` → `{notifications,delivery:'Not sent'}`; up to100 visible snapshots |
| GET /api/tribute-notifications/:id | `{notification}`; inaccessible/private404 |
| POST /api/tribute-notifications/:id/finalize | `{version:1,preparationDigest,confirmed:true}` → `{notification}`; repeated review409 |

A notification has id/version1, Draft / Finalized status, subject/body, explicitly selected recipient, source donor/gift date, gift/tribute/constituent versions and record digests, preparation/final-review attribution and **Not sent** delivery. Plain text includes the approved donor and honoree names but omits gift value, secondary contacts and soft-credit recipients. It is not a donation receipt. Sources must be posted non-fee, nonvoid gifts with current/historical dates; merged donors/honorees/recipients are rejected. Preparation requires donor-disclosure approval and no Do not contact preference for donor or recipient; Print requires recipient Post preference, Email draft requires Email preference and primary email. Finalization rechecks current source/tribute versions, organization wording, recipient/channel preferences and donor approval. Invalid preferences/consent or stale records require fresh preparation/review; originals remain immutable.

Staff-only current tribute records are hidden from viewers; private retained revisions/notifications stay hidden even if a later tribute version becomes Team. Making a current tribute private also hides its formerly public notifications. Viewer notification lists/detail additionally require current donorDisclosureApproved and approval in the saved tribute version; revoking approval hides both Draft and Finalized donor-containing snapshots. Viewer tribute revisions require current and saved approval, so a Team current record may remain visible with no source history while approval is revoked. Reapproval exposes only previously approved visible versions; staff/admin retain all originals. Curated tribute metadata report sources are administrator-only and exclude notification bodies/emails/raw source snapshots; this is not complete all-stored-field reporting.

Source guards retain original donor/soft-credit identities and reject deletion, constituent reclassification or unsupported history-rewriting merges across saved source references. Finalized notification financial facts are protected against subsequent gift edits; ordinary nonfinancial gift notes and fiscal assignment can still change. Source gift void remains available under other applicable receipt/core guards. **There is no finalized-notification withdrawal or financial-correction release endpoint yet**; revising tribute wording does not release that guard or change the original notification. Assistance may explain the workflow but cannot send, print, sign, issue or establish delivery.

## Retained report-schedule lifecycle

`PATCH /api/report-schedules/:id` accepts versioned Active/Paused transitions or `{version,status:'Retired',reason}` with a nonblank reason. Retirement is terminal and atomically audited; only the owner or administrator with current report access may change it. Retired schedules never execute, do not consume the 100 active/paused slots, and retain immutable deliveries under current report/source privacy guards. To schedule again, create a new schedule. GET retains schedule history under its existing bounded listing; no deletion or external email delivery is provided.

Staff is a constituent category, not an account role or inferred Employee membership. Household and staff-operated volunteer reservations recognize Staff as a person. Annual employee receipts retain their explicit Employee-only policy; category overlap still needs buyer agreement.

## Connected normalized historical conversion

The shared mapping contract declares five supported collections. Campaigns require sourceId/name/type/goal/startDate/endDate/status; exact decimal-dollar goals include zero and never create revenue. Optional gift campaignSourceId resolves staged or retained same-source campaigns, without name inference. Optional constituent contacts is an explicit JSON array of at most50 strict name/email/role objects (8000-character cell;[] for empty). Accepted strings/order remain exact; surrounding contact name spaces reject. Business contact roles do not grant access or consent. Unmapped new optional fields are omitted from normalized fingerprints to preserve legacy reuse/replay.

Historical communications require sourceId/constituentSourceId/subject/channel/status/date/accessScope. Only Logged, valid nonfuture original dates and explicit accessScope=Workspace are accepted. Classification is fingerprinted but omitted from native payload; ordinary workspace readers can read the history. Restricted sources need a separate private path. No sending, consent/account changes, provider delivery, gift acknowledgment or original actor/timestamps beyond these fields is implied.

Original three-key count/replay shapes remain unchanged without extension files. Campaign/communication counts appear only when that file is present. Signing covers all five collections, source maps and fiscal policy. Persistence/reconciliation/maps/audits are transactional; supported counts/financial totals are not full source custody or historical acceptance. Campaign progress uses lifetime posted monetary contributions through the displayed date, excluding future/fee/noncash/void/unposted rows; future posted monetary source rows are shown separately. Plan dates, source transaction dates and fiscal overrides remain distinct.

Post-persistence migration checks compare every supported native-normalized business field, ordered array and resolved link after all creates, verify new creation metadata/Posted gift fiscal fields, and recheck retained source dependency hashes before saving new maps. Mismatches fail409 and roll back all changes. Original replay returns retain their prior immutable result shape. Report result scope explicitly includes future recorded values and fixed scheduled date-cutoff semantics; filters, not the unfiltered amount column, define currently raised money.
