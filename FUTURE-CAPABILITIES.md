# Future capabilities and acceptance roadmap

This is the remaining product roadmap beyond Jordan Everbright's current local synthetic evaluator pilot. The tailored Jordan Education Foundation workspace is not an official district product or endorsement. Stages describe a useful implementation order, not delivery dates, commitments or certification claims. Future capabilities should enter the interface only when they work; the pilot should not display inactive buttons implying these services exist.

## Delivered in the local pilot

Phase two now includes real monthly/quarterly/annual pledge schedules and recorded-gift fulfillment/balances/overdue amounts; direct/soft-credit, organization-descendant and household recognition reports; dated volunteer clock intervals with separate undated historical hours and audited corrections; shared saved report filters; and a manual Pending/Completed acknowledgment queue with linked logged donor activities. These are working synthetic workflows, not future-only items. Commitments do not inflate received income, recognition groups can overlap without creating income, and manually logged acknowledgments do not send messages or issue tax receipts. See [RFP-COVERAGE.md](./RFP-COVERAGE.md) and [PHASE-TWO-ACCEPTANCE.md](./PHASE-TWO-ACCEPTANCE.md).

Prioritize the roadmap after reviewing the evaluator workflows, the buyer's actual exports, platform/partner arrangements, deployment requirements, and acceptance criteria. A production commitment needs a separately agreed scope, staffing, budget, and release plan.

Phase three also delivers distinct requested funding, verified-recorded awards and matching-funder linked grant receipts, including void reversals and explicit unknown legacy awards; the self-guided Client testing workspace; and a one-process independent local handover launcher. See [PHASE-THREE-ACCEPTANCE.md](./PHASE-THREE-ACCEPTANCE.md). These are recorded synthetic operations, not external settlement or formal institutional approval.

## Stage 1 — Complete core nonprofit operations

| Capability | Intended benefit | Acceptance checks before release |
|---|---|---|
| Recurring giving administration | Manage schedules and subscription status alongside donor history | Paused/canceled schedules cannot generate future collection attempts; payment-provider events are idempotent; failed charges do not become posted gifts; projections are labeled separately from received funds |
| Deduplication and controlled merges | Maintain one constituent record without losing history | Preview likely duplicates; require a selected surviving record; preserve gifts, soft credits, communications, registrations, and audit history; never silently merge different people sharing an email/household |
| Volunteer shift reservations and self-service | Extend delivered staff-managed shift reservations and the time ledger into verified public participation | Staff capacity/waitlist/cancellation and reserved-time conflict checks are now delivered. Verify public volunteer identity and self-service permissions; preserve dated ledger and historical totals; never invent dates for legacy hours |
| Advanced event responsibility and sponsorship workflows | Extend today's event-linked tasks into coordinated checklists, sponsors, and event readiness | Define checklist dependencies and event-specific task views; commitments and fulfillment have distinct statuses; registrant counts respect capacity; sponsorship, fee payments, and donations remain separately reportable |
| Provider-backed acknowledgment delivery and approved receipts | Extend the delivered manual activity queue into verified external delivery | Authorize the provider and buyer-approved wording; enforce consent; use provider-derived send/failure status; prevent duplicate delivery; approve real tax-receipt treatment separately from manual completed records |
| Arbitrary custom and scheduled reporting | Extend shared saved filters with approved layouts and authorized delivery | Build buyer-approved fields/templates; preserve cash/noncash/fees/sponsorships and overlap caveats; schedule only to authorized recipients; validate provider delivery and export scope. Current saved views store filters and do not schedule anything |

## Stage 2 — Verified migration and connected systems

| Capability | Intended benefit | Acceptance checks before release |
|---|---|---|
| Actual NonProfitEasy conversion | Preserve donor, designation, transaction, interaction, and contract history | Inventory real exports and fields; approve mapping; trial-convert a representative sample; reconcile record counts and monetary totals by period/type/designation; review duplicates/errors; validate attachments/contracts; rehearse rollback and final cutover |
| Payroll and financial-system imports | Reduce manual re-entry while respecting district financial policy | Approve source-specific mapping and identifiers; preview errors; prevent duplicate runs; preserve batch/source lineage; reconcile payroll totals and designation splits; do not require a direct bank connection contrary to buyer policy |
| Mailchimp integration | Keep marketing segments and consent aligned | Obtain scoped authorization; test exact contact mapping; honor unsubscribe/do-not-contact changes both ways; handle retries without duplicates; show real sync/send errors and provider-derived statistics |
| Google Workspace and Microsoft integration | Support agreed calendar, document, or productivity workflows | Define the precise service and permission scope; test connect/disconnect and token expiry; limit access to authorized users; never label a generic export as a live integration |
| External APIs and integration administration | Permit controlled future integrations | Document versioned endpoints/scopes; establish least-privilege credentials; audit access; support rate limits/idempotency/retries; verify disconnection and credential rotation; monitor failures without exposing secrets |
| Attachments and institutional documents | Preserve grant agreements, interaction evidence, and historical contracts | Use approved storage; limit type/size; scan uploads; restrict download permissions; retain linkage/provenance; test deletion/retention rules and include documents in migration/recovery planning |

Live integration acceptance depends on authorized provider accounts, buyer-approved configuration, sandbox tests, and reconciliation. Import/export utilities alone do not satisfy live connection requirements.

## Stage 3 — Public giving, participation, and advanced fundraising

| Capability | Intended benefit | Acceptance checks before release |
|---|---|---|
| Stripe / card / ACH payments | Accept gifts and event fees through an approved processor | Use an approved hosted payment flow; avoid storing card data; verify signed provider events; handle retries/refunds/disputes without duplicate gifts; reconcile settlement and fees; disclose payment status accurately |
| Donor and volunteer self-service | Allow controlled signup, cancellation, preference updates, and giving history | Verify account access to the correct person; enforce capacity atomically; prevent exposure of other donors/student data; provide cancellation/waitlist behavior; test accessibility and all reminder failures |
| Peer-to-peer and matching-gift workflows | Track supporter campaigns and matching opportunities | Public campaign totals reconcile to posted gifts; permissions protect campaign ownership; matches remain potential until received/confirmed; attribution and direct/soft credits do not double-count income |
| Event ticketing and seating | Connect registration, admission, payment, and seating | Paid/free/reserved states are distinct; check-in requires a valid registration; cancellations/refunds release seats correctly; seat assignments remain unique; ticket income is not automatically labeled a donation |
| Auction operations | Support item, bid, winner, checkout, and settlement records | Enforce bid timing/rules; preserve bidder/item history; reconcile winner payments; separate purchase value from charitable treatment under buyer-approved policy; recover from interrupted checkout |
| Planned-giving and major-gift portfolio | Track complex commitments and relationship plans | Separate estimates/intent from received gifts; define stages and confidentiality permissions; preserve tasks/contact history; validate buyer-approved reports without presenting projections as available funds |

## Stage 4 — Production and institutional acceptance

| Capability | Intended benefit | Acceptance checks before real data/public deployment |
|---|---|---|
| SSO and MFA | Fit district identity and stronger access requirements | Agree provider/protocol; test login/logout and MFA; map roles securely; revoke departed users; retain an approved recovery path; test session expiry and permission boundaries |
| Approved production hosting and encryption | Protect real institutional records in the required geography | Document actual application/database/object-storage regions and subcontractors; verify US/Canada requirements; configure HTTPS and at-rest encryption/key handling; test access restrictions and environment separation |
| Managed backups and disaster recovery | Restore usable records after loss or outage | Define approved recovery objectives; encrypt scheduled backups; include database/documents/configuration securely; test restoration and reconciliation; record evidence; verify retention, deletion, and recovery ownership |
| District privacy and security acceptance | Meet buyer requirements with evidence | Complete Learn Platform review, signed DPA, iBoss compatibility checks, approved retention/deletion rules, and independent security testing as applicable; remediate findings; do not claim approval before it is obtained |
| Security assurance and incident operations | Sustain security, updates, and response | Define service ownership and update process; implement monitoring/alerting; rehearse incident response and required notifications; commission applicable assurance work; only claim SOC 2/ISO/PCI status supported by current evidence |
| Operational support and training | Support administrators and end users after go-live | Agree support contacts/hours/SLA; test escalation; produce role-specific guides; rehearse onboarding and go-live support; define release/change communications and maintenance responsibilities |
| Performance and accessibility acceptance | Handle the buyer's actual record volume and users | Test representative migrated data and concurrent users; measure agreed performance; verify keyboard/screen-reader workflows; resolve material failures; document supported browsers and acceptance results |

## Additional options after reliable core delivery

Consider duplicate suggestions, donor-lapse scoring, designation trend exploration, configurable workflow rules, and staff-assistance tools only after data quality, permissions, and source traceability are established. Any suggested action should show its supporting records and require an authorized staff decision; inferred predictions must be visibly distinguished from recorded facts. Do not add unsupported donor-data enrichment, automatic messages, or automatic financial actions to the pilot.

The roadmap does not satisfy procurement eligibility: the required relevant experience, three references, provider/reseller letters, personnel location, and other mandatory bid conditions require independent evidence. Building future functionality cannot retroactively create qualifying institutional history.

## Current expansion delivery

Release0.4.0 delivers Operations source-record work queues, staff-managed volunteer shift reservations/capacity/waitlists/cancellation/conflict checks, exact shared-email identity review and administrator-run read-only local workspace checks. These are working local capabilities, not external connectivity. CTO-PROJECT-PLAN.md defines subsequent migration, provider, public participation and institutional production gates.
