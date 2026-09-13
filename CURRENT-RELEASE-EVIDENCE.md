# Wimblo 0.5.0 — verified local release

September 13, 2026. Kode Kinetics LLC. This is a local implementation and review checkpoint, not a production launch, awarded score or buyer acceptance.

## Requirements inventory

| Classification | Supplied baseline | Current reviewed source |
|---|---:|---:|
| Implemented locally | 25 | 46 |
| Partial | 39 | 24 |
| Missing | 17 | 11 |
| External evidence required | 3 | 3 |
| Total | 84 | 84 |

All 84 numbered criteria and their individual limits remain in [CURRENT-RFP-REQUIREMENTS-MATRIX.md](CURRENT-RFP-REQUIREMENTS-MATRIX.md). There are **38 entries still open**. Local status describes a basic tested workflow; it is not a complete real-data, policy, scale or operational acceptance. Mandatory provider qualifications and submission gates are additional to this scored inventory.

## Verified source and business journeys

The full mounted application passed **325 tests**, zero failures and skips, in **10.8 seconds**. A subsequent production build passed in **1.13 seconds**, including the new grant and tribute screens. Tests exercise actual authenticated API routes, permissions, optimistic source versions, transactions, exact cents, retained histories, restart, replay and failure paths. Separate focused runs overlap this count.

Browser checks used fictional local data:

| Journey | Observed result |
|---|---|
| Migration | Three mapped constituent/designation/gift CSVs previewed and committed; $123.45 gift reconciled exactly. Replaying created no duplicates. This was not NonProfitEasy conversion. |
| Fiscal reassignment | Authorized gift-year override and explicit reset were reflected in the appropriate report; original gift date stayed unchanged. |
| Identity | Household creation retained one fictional donor member. Merge safeguards are API-tested; blocked historical cases still need an accepted policy. |
| Reports | Saved custom definition ran against current data. A scheduled internal snapshot was produced automatically, retaining its execution time and source version. No email was sent. |
| Documents | Linked revisions retained file names, statuses and digests; prior content downloaded. Older private revisions remain hidden even if a later revision is public. |
| Fundraising and analytics | Major ask/activity, planned bequest and capped matching claim saved without becoming income. Retention/cohort and source drill-through showed the actual posted gift ledger. |
| Event operations | Table/seat, ticket, check-in, sponsorship benefits and auction bid/winner workflows retained history. Prices, promises and winning bids remained distinct from money received. |
| Correspondence | Selected gifts produced separate accurate letters; reviewed text finalized/exported as **Not sent**. |
| Receipt register | A clearly fictional organization profile prepared a fictional individual receipt. Physical print and hand-sign confirmations remained unchecked; no real receipt issuance or tax validity was established. |
| Tributes | Donor, honoree and recipient remained distinct. A memory notification was prepared, reviewed, finalized and exported as **Not sent**, without amount or soft-credit income disclosure. |
| Grant milestones | Owner/date recorded; completion was disabled without eligible evidence. A linked Final Report revision was reviewed and pinned to completion. Exact evidence downloaded. Reasoned reopening retained original completion, evidence, actor and source request/award values. No external submission occurred. |
| Connected work queue | Reopened QA milestone appeared with its recorded owner/date and opened the real controls. Completion removed that item while unrelated legacy grant dates remained. Rule-based intelligence follows the same exact grant/kind/due-date mapping; private histories cannot suppress public legacy review. |
| Responsive guidance | Grant workflow became readable work cards at 390 pixels, with grant/name first, due/owner next, status/history and actions below. Page scroll width remained 390 pixels. Ordinary viewport was restored. |

## Independent security findings repaired

The review reproduced each issue before changing its guard, then added actual API regression tests and independently rechecked the result:

- Deleting a merged survivor could strand its retained aliases. Both native and generic deletion now preserve referenced identity history.
- A pre-merge correspondence recipient could retain obsolete consent. Current identities and opt-out preferences are revalidated before review finalization.
- Mapped migration records could be deleted through the generic endpoint. Retained source maps now prevent destructive deletion, including encoded IDs.
- Encoded event IDs could bypass raw-path guards. Decoded route parameters and core mutation/deletion guards protect financial, admission and historical links.
- A private document revision became readable when a later revision was public. Every retained revision is now authorized individually; private content returns 404 without a successful-download audit.
- Revoked donor disclosure left historical tribute notifications readable to viewers. Current and saved disclosure/visibility are enforced; staff-authorized originals remain retained.
- Retained scheduled revision reports could preserve private metadata. Current results carry source provenance and a privacy marker; older unsafe snapshots and snapshots with newly private or missing sources are denied to nonadministrators.

These fixes establish the reviewed local controls, not a certification or proof that every possible threat has been eliminated.

## Subsequent multidisciplinary review checkpoint

A dedicated finance/controller review, independent nonprofit operations review and independent security/data/storage review are now complete; see [SME-REVIEW-AND-SIGNOFF.md](SME-REVIEW-AND-SIGNOFF.md). These are AI-assisted domain reviews, not outside licensed professional approval. They found open correction-history, receipt-benefit, cutoff and connected-workflow issues; the register and discipline reports retain their acceptance tests.

The new issued-receipt gift-void bypass was reproduced and repaired with explicit route operation and core mutation guards. The complete mounted application then passed **326/326 tests**, zero failures/skips, in **16.2 seconds**. This subsequent check includes the new regression. No frontend source changed in this repair; the previous production build remains the UI evidence. Both local servers were restarted with the repair.

Direct Ollama cloud authentication and an actual authenticated Wimblo workflow-help request returned HTTP 200 with generated review-required text. Only a static workflow question was sent, with zero donor source records. The key resides in an ignored owner-only local backend configuration, not the source or UI. This check establishes connectivity, not model accuracy or real-data approval. No cloud deployment or production tenant configuration occurred.

## What still closes the RFP

**Product capabilities:** public peer-to-peer and approved online/card/ACH/recurring payment flows; executing marketing/workflow delivery, optional SMS, Mailchimp synchronization/response tracking and offered Stripe compatibility; preferred SSO/connectors; helper/module access policy and remaining business-model depth. Provider sandboxes, credentials and buyer payment-account restrictions must be respected. A method label or draft is not payment or delivery.

**Buyer data and acceptance:** actual ten-year NonProfitEasy exports and contracts, source mappings/deltas, counts/amounts/files/consent reconciliation, buyer-scale users/designations, board outputs, receipt wording/physical operations and agreed blocked-merge cases. November 30 source-download cutoff remains material.

**Hosted operations and services:** durable approved-country storage, production encryption/key custody, tenant/platform recovery, automated backup/monitoring/incident process, adopted retention/exit/disposal, staffed implementation/training/support and accepted DPA/LearnPlatform/iBoss evidence. Current Render/Vercel/Neon availability does not prove these CRM operations. Next.js/.NET/PostgreSQL migration is not implemented.

**Qualification:** identify the qualifying software provider/product with the required three years and three accepted comparable references; supply the actual prescribed reseller letter if applicable. New Wimblo features cannot manufacture that history or waive the pass/fail gate.

## Intelligence and competitive positioning

Deterministic work priorities and recorded-data analytics operate without a model. Bounded Ollama assistance is optional, synthetic-only and subject to current user, tenant, consent, source-version and generation limits. Human review remains necessary; no model sends, collects, performs receipt confirmation or changes business records. Real-data model use needs an approved data/subprocessor policy.

Public procurement review did not expose named downloaders or confirmed bidders. Named product battlecards in [COMPETITIVE-INTELLIGENCE.md](COMPETITIVE-INTELLIGENCE.md) are market comparisons, not claims that those firms are bidding. Win through proven conversion, accurate operations, clear screen guidance, credible total cost and funded support; feature volume cannot guarantee an award.

## Source and handover

Package version and source health identify **0.5.0**. The local source commit and clean review-package checksum are recorded in the final handover note. The review package excludes environment files, local databases, keys and installed dependencies. No new cloud deployment is claimed. Follow README and RENDER-SETUP for actual commands and configuration names; credentials remain server-side.
