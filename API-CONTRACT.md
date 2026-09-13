# Wimblo 0.5.0 evaluator pilot API contract

This is a local evaluator pilot with synthetic data, not an assertion of production certification. Node 24, Express 5, node:sqlite. Server binds 127.0.0.1 port 4311 by default; APP_HOST/PORT configurable. In production serve dist. Use app export createApp({dbPath, seed=true}) for tests; index.js starts server. Current module routes below share the authenticated workspace and atomic audit boundary.

## Endpoints
- POST /api/auth/login {email,password} -> {user,csrfToken} for an unenrolled account, or {mfaRequired:true,challengeToken,expiresAt} without an authenticated session for an enrolled account; HttpOnly session cookie, SameSite Strict. Demo admin alex@foundation.example / FoundationDemo!2026; staff staff@foundation.example, viewer board@foundation.example same password. Local test-only credentials; production always refuses demo seeding and demo/evaluator/acceptance flags; ALLOW_DEMO cannot override this guard.
- GET /api/auth/me -> {user,csrfToken}; 401 anonymous. POST /api/auth/logout.
- GET /api/workspace -> {user,csrfToken, data:{constituents:[],gifts:[],campaigns:[],grants:[],volunteers:[],events:[],tasks:[],communications:[],designations:[]}, audit:[], settings:{organizationName,fiscalStartMonth}}. Only administrator/staff/viewer can access this broad workspace; event-helper receives 403. Nonsecret organizationName/fiscalStartMonth settings are readable by every authenticated role for consistent reporting. Audit, user management, settings edits and backup are admin only. Viewer business records are readonly; staff ordinary CRUD. Acceptance-mode viewers may submit observations through the narrowly scoped feedback POST exception; they cannot edit/delete observations or business records. Mutations require X-CSRF-Token matching session.
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

## Restricted event-helper access

Account creation/update supports `event-helper` as a distinct login role. The role has no full-workspace read or ordinary CRUD/report/export/AI permission. Its exact check-in router precedes a default-deny guard before all business modules; HEAD and other non-GET/POST check-in methods are denied. Own authentication/logout/MFA endpoints remain available under existing policy.

- GET `/api/event-checkin/events` -> `{events:[{id,name,date,location,version}],scope}`; no query fields. Helpers see active assignments only.
- GET `/api/event-checkin/events/:eventId?limit=1..100&after=UUID` -> `{event,tickets:[{id,attendeeName,version,checkedIn,checkedInAt}],nextCursor}`. Issued tickets only; no constituent ID, contact/profile/financial data or actor details.
- POST `/api/event-checkin/events/:eventId/tickets/:ticketId/checkin` requires CSRF and strict `{version,eventVersion}` -> `{event:{id,version},ticket}` with the same minimal ticket projection. Assignment/current account/tenant/session and record revisions are rechecked atomically with native attendance and immutable transitions/audit. Unassigned/wrong-event/missing records uniformly return 404; conflicts use a generic helper-safe 409.
- Administrator GET `/api/users/:id/event-access` -> `{userId,version,eventIds}` for an active helper; other roles/inactive accounts conflict.
- Administrator PATCH same endpoint requires CSRF and strict `{version,eventIds:uniqueUUIDs(max100),reason:nonblank(max500)}`. Returns updated access plus `sessionsRevoked`. Every replacement increments account version, revokes sessions/pending MFA challenges and retains reasoned before/after immutable history. Role/active changes retire grants. New helpers have no assignments; historical grants never silently reactivate. Retained assignment history blocks destructive event deletion.

Native recovery includes helper assignment/access-history tables and clears restored sessions/challenges. Reporting-catalog coverage and adopted institutional retention/exit policy for this new history remain separate gaps. Helper MFA is optional under configured key policy; it is not SSO or a claim about buyer-required board duties/licensing. See EVENT-HELPER-ACCESS-RELEASE.md for evidence and limits.

## Saved audiences

Administrator/staff write and administrator/staff/viewer read/preview; helpers are denied before all business modules. Current tenant/account/session/binding/MFA authority is rechecked in native audience mutations and audience-backed correspondence prepare/finalize transactions.

- POST `/api/audiences` strict `{name,filters:{segmentTokens:unique trimmed comma-free tokens(max25),segmentMatch:'Any'|'All',types:nativeUniqueEnums,preferences:nativeUniqueEnums}}` -> `{audience}`. Empty arrays impose no criterion. Definitions start Active revision1; max200 active.
- GET `/api/audiences` -> `{audiences,limit:200}`; active-first bounded list. GET `/:id` -> `{audience,revisions,revisionCount,revisionLimit:100}`.
- PATCH `/:id` strict `{version,name,filters,status:'Active'|'Retired',reason?}`. Retirement requires nonblank reason≤500; Retired is terminal. Revisions/history retained and immutable.
- GET `/:id/preview?version=N&channel=Print|Email%20draft&limit=1..100&after=UUID` -> `{audience:{id,version,name,definitionDigest},channel,sourceDigest,totalCount,matchedCount,eligibleCount,excludedCount,reasonCounts,recipients:[{id,name,version,preference}],nextCursor,limit}`. Exact case-sensitive comma-token matching; exclusion counts are global with one primary reason. Print excludes Do not contact; Email draft additionally needs Email preference and valid primary email.
- Messaging correspondence preparation optionally accepts `audience:{id,version,sourceDigest}` with existing explicit `constituentIds`≤100. Current digest of the entire constituent corpus, audience and channel must match; selected IDs must still be eligible. Snapshot retains audience name/revision/digests/channel and selected IDs. Finalization rebuilds under current authority and validates all source/template/wording references; stale reviews fail, never auto-expand. Existing non-audience request/snapshot shapes remain unchanged. Nothing is sent.

Reports curate savedAudiences/audienceRevisions criteria (`segmentLabels` is an explicit safe report alias for native segmentTokens), and correspondence audienceId/name/revision/selectedCount; raw corpus/digests/email/selected IDs omitted. Event helper assignment/access-history sources are administrator-only and remain invisible to staff/viewer catalogs. Native recovery includes new tables; adopted retention/exit and field/volume acceptance remain open.

## Private task reminders

All private endpoints require current active administrator/staff access; helper router denies access and viewers are denied. Each reminder belongs to its task-owner account; administrators cannot inspect or create another owner's inbox. Authority, account binding, ownership and task revisions are rechecked in native mutations.

- POST `/api/tasks/:id/reminders`: strict `{taskVersion,ownerVersion,remindAt:canonicalUTC}` -> `{reminder,delivery:'Internal only',timezone:'UTC'}`. Noncompleted current owned task only, one active per task, workspace max100 active; time accepts minus60-second minute tolerance through366 days.
- GET `/api/task-reminders`: `{reminders,limit:100,delivery,timezone}`; own retained bounded history, current title only while source bindings remain valid, latest outcome and versions.
- GET `/api/task-reminders/:id`: own only `{reminder,outcomes,outcomeCount,outcomeLimit:100}`; latest dated outcomes, uniform404 for another owner's/missing ID.
- POST `/api/task-reminders/:id/cancel`: CSRF, strict `{version,reason:nonblank(max500)}`; active/current source only, terminal Cancelled with retained outcome. No edit/delete route.
- GET `/api/reminder-inbox`: `{items:[{id,reminderId,taskId,taskVersion,taskTitle,deliveredAt}],limit:100,delivery:'Internal only'}`. Own Delivered/current-source items only, not every historical delivery.

Native `task_reminders`, immutable `task_reminder_outcomes` and unique immutable `task_reminder_inbox` are included in full encrypted recovery. Installer options `reminderClock`/`reminderWorker` support deterministic verification; ordinary runtime polls every30 seconds, reconciles all active sources and attempts at most50 due per cycle. Failed persistence rolls back delivery, stores capped60-second retry evidence where persistence works, and terminally suppresses after five persisted attempts. No automatic UI POST replay. Task history blocks source deletion.

Platform suspension commits registry state before workspace effects. Effects failure returns503 while access stays Suspended; repeat suspension retries effects. Resume requires existing workspace storage and successful suppression/revocation before registry activation. No distributed transaction guarantee. Administrative report sources `taskReminderSchedules`, `taskReminderOutcomes`, `taskReminderInbox` omit bindings/title/body and are unavailable in staff/viewer catalogs/direct queries. Adopted retention/exit and hosted recovery remain open. See TASK-REMINDERS-RELEASE.md.

## Original contract revision conversion

Administrator-only `/api/document-migration` prefix rechecks current tenant/account/session/binding/MFA authority. POST `/preview` requires strict `{source:{namespace,documentId,revisionId,visibility,originalDate:day|null},document:{title,category:'Agreement',status,visibility,evidenceDate:day|null,filename,contentBase64,collection,recordId,recordVersion,targetDocumentId?:UUID,targetVersion?:int},sha256:lowercase64hex,size:1..1048576}`. Target pair is required together for append. Existing supported format/native metadata validators apply;2MiB request max. Private original/native chains cannot become Workspace through conversion.

Preview returns `{valid,operation:Create|Append|Replay,proof,contentHash,dependencyHash,reconciliation:{sourceRevisions:1,sourceBytes:size,nativeRevisions:0|1,nativeBytes:0|size},target,file,source,metadata,scope}`. Native counts/bytes mean NEW expected values: Replay0/0; Create/Append1/size. POST `/commit` repeats payload plus proof, returns201 `{replayed:false,document,reconciliation}` or200 replay true. Signs are process-local; restarted/stale reviews need a new preview. No automatic client POST replay.

Successful reconciliation DTO `{id,tenantId,source,documentId,revision,collection,recordId,recordVersion,requestedDocumentVersion,sourceHash,nativeHash,file:{filename,mime,sha256,size},metadata,actor,at,reconciliation:{sourceRevisions:1,sourceBytes:size,nativeRevisions:1,nativeBytes:size}}` describes the original committed row, even on replay. GET `/history?limit=1..100&after=UUID` returns `{reconciliations,nextCursor,limit,scope}` with strict valid workspace cursor. Source maps and successful rows are immutable. Exact source/custody/dependency mismatch fails409 before signing/committing. Source chronology is optional explicit calendar date only; importing actor/time remains actual.

Native writer callbacks share validated staging/readback/final transaction/audit; failures roll back native revisions/source lineage and retain truthful Failed/Orphaned upload attempts. Full encrypted recovery retains original custody, lineage and verified offline bytes. Administrator-only `documentMigrationMappings`/`documentMigrationReconciliations` reports validate the same explicit workspace identity, curate dates/IDs/counts and omit filenames/title/contents/raw hashes/proofs/provider references/bindings. Dedicated legacy SQLite uses its registered legacy identity; real tenants/object storage require authoritative explicit IDs. Complete source inventory/custody/bulk/format/scale acceptance remains open. See CONTRACT-REVISION-CONVERSION.md.

## Prospective Communications draft workflows

Current ordinary admin/staff/viewer roles can GET `/api/communication-workflows` (latest100, active first) and `/:id` (rule + latest100 outcomes + exact outcomeCount); helpers are denied. Staff/admin can POST create with strict `{name,audienceId,audienceVersion,sourceDigest,templateId,templateVersion,channel:'Print'|'Email draft',confirmed:true}` after current baseline/wording review.201 returns `{workflow,delivery:'Not sent',historicalBackfill:false,limits}`. POST `/:id/retire` requires owner or administrator, `{version,reason}`, current authority and Active revision. No edit, resume or silent rearm endpoint.

Rule DTO: id/name/version/status/ownerId/audienceId/audienceVersion/templateId/templateVersion/channel/baselineCount/sourceCurrent/createdAt/updatedAt/lastOutcome. Safe outcomes carry IDs/revisions/status/reason/at/retryAt; only a Drafted outcome backed by its immutable execution and current existing native source can include communicationId and original communicationVersion. No message body/email/security binding is returned.

Workspace native Communications and authorized report projections add optional trusted workflowOrigin `{workflowId,workflowName,episode,producedAt,sourceCurrent,delivery:'Not sent',reviewRequired:true}`. Ordinary historical body authorization is preserved; current=false means review required, not delivery/disposal. UI refreshes current business records before Open draft.

Activation baselines existing eligible profiles; observed future entry creates one native Messaging Draft transactionally. Current owner account/MFA enrollment policy authorizes the worker independently of browser cookie expiry. Current source/consent/tenant/rule protections recheck before complete native-record commit. Durable membership/entry/execution/outcome ledgers, 5-attempt60s retry cap, 20-active/1000-watermark/1000-episode/40-cycle bounds and terminal definition/security/lifecycle/recovery suppression apply. Backup recovery appends a deliberate immutable marker while preserving exact old business/audit rows; restored activations close rather than resume. No provider messages or financial actions. Five curated operational report sources are administrator-only. See COMMUNICATION-WORKFLOWS-RELEASE.md for proof, limits and open acceptance.

## Internal peer fundraiser ownership and gift attribution

Authenticated administrator/staff can write; administrator/staff/viewer can read permitted workspace efforts. Helpers are denied. Each mutation rechecks current tenant/account/session/binding/MFA authority within the native transaction and requires CSRF. Administrators alone create/manage Administrators visibility; any current or retained private revision hides the entire effort and association history from staff/viewer. No relaxation of retained private history.

- POST `/api/peer-fundraisers`: strict `{campaignId,campaignVersion,constituentId,constituentVersion,coordinatorId,coordinatorVersion,title,goalCents,visibility:'Workspace'|'Administrators'}` ->201 `{fundraiser,limits,scope}`. Existing Active Peer-to-peer campaign, unmerged constituent and active administrator/staff coordinator with matching current versions; title1..250, integer goalCents0..1000000000000. One active effort per campaign/constituent; max100 active workspace efforts. Goal is an aspiration, not received income.
- PATCH `/api/peer-fundraisers/:id`: strict `{version,title,goalCents,visibility,coordinatorId,coordinatorVersion,reason}` -> `{fundraiser,scope}`. All fields required; reason trimmed1..2000. Active only; fixed campaign/fundraiser identity, reasoned coordinator/goal/title changes and privacy tightening.
- POST `/:id/retire`: strict `{version,reason}` -> `{fundraiser,scope}`. Terminal retirement preserves existing actual progress and all history; no edit/resume/delete route.
- POST `/:id/attributions`: strict `{version,giftId,giftVersion,campaignVersion,coordinatorVersion,reason}` ->201 `{fundraiser,attribution,scope}`. Existing positive Posted One-time Cash gift with exact same campaign, valid nonfuture date/method/reconciled native allocations and no pledge/grant/event-payment linkage. A gift has at most one active peer attribution across efforts; max1000 retained attributions per effort. Actual donor need not equal fundraiser, and no self-donation restriction is inferred.
- POST `/:id/attributions/:attributionId/unlink`: strict `{version,attributionVersion,giftVersion,reason}` -> `{fundraiser,attribution,scope}`. Terminal reasoned unlink retains original association/snapshot; governance unlink can proceed on a retired effort or unavailable coordinator. Subsequent native financial correction requires ordinary authority and guards; a newly eligible gift needs a fresh explicit attribution.
- GET `/api/peer-fundraisers?limit=1..100&after=UUID&campaignId=ID&status=Active|Retired`: optional filters, default limit100 -> `{fundraisers,nextCursor,limit,limits,scope}`. Current permitted filtered cursor required.
- GET `/:id?limit=1..100&after=UUID`: default limit100 -> `{fundraiser,attributions,nextCursor,limit,attributionCount,revisions,revisionCount,history,historyCount,historyLimit:100,scope,limits}`. Attribution paging plus latest100 ownership revisions and latest100 history rows with exact counts; uniform404 for inaccessible private IDs.

Fundraiser DTO includes current campaign/identity/coordinator names/versions/availability and `progress:{postedCashCents,attributedGiftCount,unlinkedCount,voidedGiftCount,sourceChangedCount,asOf}`. Compatible active existing Posted gifts count once; retired effort retains actual progress. A protected native void yields zero received progress and retained void evidence, without a provider refund. Source-current facts distinguish unchanged retained originals from later native source revisions; harmless notes/equivalent allocation-order changes do not erase compatible progress. Active attribution blocks financial corrections until reasoned unlink. Retained actual-donor/soft-credit/ownership references protect deletion, type changes and identity merging at native transaction boundaries.

Attribution does not change the native donor, soft credit, receipt, acknowledgment, campaign goal, gift amount or income. Complete native saved-row/source/audit verification and SQLite uniqueness enforce atomic failure/concurrent once-only association. Four retained peer ledgers are included in encrypted native recovery; sessions are cleared on restore. Administrator-only report sources `peerFundraisers`, `peerFundraiserVersions`, `peerGiftAttributions`, `peerGiftAttributionHistory` curate permitted lineage/progress without raw source JSON/digests or security bindings. Public pages/team checkout, provider sending/refunds, adopted ledger retention/hold/disposal/exit and buyer acceptance remain outside this slice. A2.6 remains Partial.
