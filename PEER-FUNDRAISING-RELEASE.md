# Wimblo — peer fundraising and financial integrity

September 13, 2026. Kode Kinetics LLC. Verified local implementation; production deployment and buyer acceptance remain open.

The final frozen application passed **678/678 tests**, zero failures or skips, in **35.60 seconds**. The final production build passed in **1.26 seconds**; main bundle 493.72 kB. The preceding run passed 677 tests but browser testing then exposed a false source-change warning after successful saves. The UI was repaired, a meaningful regression added, and the final integrated run and built journey repeated. Passing tests alone did not establish readiness.

## Working user journey

Staff create a plan for an existing active Peer-to-peer campaign and known constituent, assign an active staff coordinator, set an exact goal and review visibility. A coordinator assignment records responsibility; it creates no new account permissions. A goal is not cash, income or an amount owed.

Choose an existing compatible one-time Posted Cash gift in the same campaign through today, inspect its actual donor and exact amount, explain the referral and confirm attribution. Attribution preserves the native donor, amount, allocations, soft credit and receipt. It does not create another financial gift, collect a payment, fulfill a pledge or classify an event exchange as charitable income.

Reasoned unlinking retains the original association and correction. The original gift remains Posted. A reasoned terminal retirement prevents new attribution while retaining original gifts and history; retirement does not automatically remove compatible historical cash. Private current or retained administrator-only history cannot become readable to ordinary staff or viewers through a later visibility revision.

## Integrity, access and recovery

Current account, tenant, session, role, MFA policy, CSRF and reviewed source versions are checked on writes and before commit. Native gift validation verifies exact cents, valid methods and allocations, current designations, and source compatibility. A transactional unique association prevents two writers assigning the same gift. Source/created-row/audit changes and deferred commit faults reject success atomically.

Protected original donors, fundraisers and recognition references survive unlinking. Native source deletion, incompatible edits and merges cannot strand that history. The native merge transaction checks peer history after the HTTP precheck and again before final commit; a valid late reference is independently tested. Unrelated compatible source revisions remain visible as changes to review without creating duplicate income. Voids cease contributing to progress; no refund is inferred.

Four curated administrator operational report sources distinguish goal, posted cash, actual donor, attribution and retained history. They omit raw private snapshots, email, bindings and proofs. Scheduled snapshots retain dated provenance; current account downgrade denies retained private output. Original native records and peer ledgers survive encrypted authenticated new-path recovery, with old sessions removed. These local protections do not establish institutional recovery operations or certification.

## Built browser proof

A fictional local active campaign and a $100.01 gift were saved using native forms. Actual donor Taylor Bennett, soft credit Morgan Arrival and fundraiser Casey Arrival remained distinct. On the corrected final build the uninterrupted journey was:

1. Reviewed Casey plan saved at v1: goal $200.00, received $0.00, zero contributing gifts; attribution controls usable.
2. Existing gift attributed at 19:17:29.858 UTC: plan v2, cash $100.01, one contributing gift, retained Linked action; unlink/retire controls usable.
3. Reasoned unlink at 19:17:47.077 UTC: plan v3, cash $0.00, zero contributing gifts, original association now Unlinked v2; both original and correction retained.
4. Reasoned retirement: plan Retired v4, two attribution actions and four retained plan revisions; new attribution/revision controls absent.
5. Open original gift: still native v1, Posted $100.01, Taylor donor, Morgan soft credit and exact original allocation. No new receipt, void, payment or external message occurred.

At 390 px the page client and scroll widths are both 390 px. The register prioritizes Plan/fundraiser, Status and Posted cash. Campaign/coordinator/goal remain in detail, while complex attribution history has a 320 px container scrolling its 580 px contents internally. Monetary cells are right-aligned and never wrap. Desktop viewport was restored. This is evidence for this journey, not all-page mobile acceptance.

Explicit workspace-source refresh is disabled while busy or holding unsaved inputs. Unknown write outcomes never trigger an automatic repeat. Fresh unchanged arrays preserve the next action; genuine native revision changes invalidate reviewed sources. Failed post-save refresh shows counts awaiting confirmation rather than inventing empty history.

## Scope still open

A2.6 is **Partial**. The RFP asks for a peer-to-peer narrative and presentation demonstration; public fundraiser/team pages, donor self-service, checkout and provider operations are broader product maturity targets, not falsely quoted buyer subclauses. Those capabilities, actual financial/provider acceptance, buyer workflow review and real data volume remain open.

Bounds: 100 active plans per workspace; 100 records per page; 1,000 retained attributions per plan; latest 100 attribution actions/revisions in the detail/report projection. Full native history remains retained, but these bounds are not accepted proof for 6,500 contacts or ten years of source history. Four new retained peer ledgers need adopted category-specific custody, legal holds, correction/exit/disposal and restored-backup anti-reappearance policy. No blanket retention period or certification is asserted for them.

Current inventory: **46 Local / 27 Partial / 8 Missing / 3 External evidence**, 84 criteria and 3,500 listed technical points; **zero buyer-accepted criteria**. Qualification and submission evidence remain additional gates. Render remains deferred; no production-main push or launch is included.
