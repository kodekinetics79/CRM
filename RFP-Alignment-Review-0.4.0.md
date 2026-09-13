# RFP alignment re-review — Jordan Everbright release 0.4.0

Reviewed September 13, 2026 for Kode Kinetics LLC. This is a fresh full-document and current-source alignment review, not a submitted technical proposal, buyer acceptance, independent SME certification or a predicted score.

## Conclusion

The product is a useful locally testable synthetic CRM POC with connected financial, donor, grant, volunteer, event and operational workflows. It is **not yet a complete implementation of this RFP**. Visual depth and additional capabilities do not substitute for the missing required workflows, delivery services and mandatory procurement evidence. The 87 passing tests establish the behaviors tested in the local pilot, not all 84 scored criteria or production readiness.

## Source and review scope

Reopened the exact supplied 31-page PDF, extracted every page afresh and read all parts. Visually inspected the mandatory, scope and scored/evaluation pages 12–20 and 22–31. Base PDF SHA256: `dd8bfd9f8e265b997f4f9c392151fb09a98596ef41ef1672155987eeba889930`.

Reviewed current application fields, server schemas/routes, report calculations, Settings, gift importer, release acceptance/verification and chief architecture/coverage/expansion documents. This pass is a source/requirements comparison; it did not repeat unchanged browser or automated tests. Their dated release0.4.0 results remain in VERIFICATION.md.

The RFP expressly makes official Q&A/addenda controlling (p.5). Existing RFP-COVERAGE.md retains earlier official-Q&A interpretation; the supplied September 10 Addendum 2 was re-read for US/Canada headquarters/data storage and the Canadian exception. This review does **not** assert that the saved addenda/Q&A are the portal's latest notices. Verify the final official set before any proposal commitment. Base-document requirements below must be read with those amendments.

## Buyer-specific behavior that must remain central

- Cloud-based delivery replacing NonProfitEasy, with licenses, implementation, configuration, conversion, training, documentation, support, maintenance and updates (p.14). A loopback launcher is an independent local evaluation mechanism, not approved cloud hosting.
- Foundation programs, school/classroom designations, organizational contacts/subsidiaries and donor-board giving history (p.14). Preserve hierarchy and traceability; test donor-board and subsidiary rollups against buyer-approved cases.
- Cash, in-kind, grants, payroll contributions and fees must remain distinguishable. JEF cannot link its bank directly; manual entry/upload must remain a first-class path even when approved processor services are added (p.14).
- Mailchimp monthly newsletter: about 6,500 contacts and 10 years of history (p.14). A draft editor or generic CSV does not demonstrate Mailchimp conversion/synchronization.
- Time-specific volunteer capacity is explicit. Staff-managed booking now works; public signup/login/self-cancellation and email reminders do not (A5.5/A5.6). Reservations remain separate from attendance and hours.
- Fiscal school-year reporting, not calendar-year-only totals (B9). July is still an evaluator assumption until confirmed.
- Minimum 4–6 users and buyer-scale operation require explicit acceptance. Demo account count, constituent categories and staff login accounts must not be confused.

## Matrix interpretation

**Local**: a source-supported local workflow covers the named core behavior; not district acceptance or proof at institutional scale. **Partial**: working subset or classification exists, with the gap stated. **Missing**: the requested workflow is not implemented; a label/preview is not equivalent. **Evidence**: delivery/operational commitments need named ownership and verifiable evidence rather than app screens.

The 84 top-level scored criteria comprise 66 functional, 10 reporting and 8 delivery/security/support criteria, worth 2,670/510/320 points respectively (3,500 total). Subparts within criteria are explicitly addressed in the gap column. No status is an awarded-point estimate. The 2,625-point technical threshold (p.30) cannot be inferred from the number of implemented modules or test passes.

| Criterion | Requested capability | Current status | Working coverage and specific gap | Scope / scoring pages |
|---|---|---|---|---|
| A1.1 | Single constituent record | Partial | Stable record IDs and connected histories; duplicate detection/controlled merge and identity rules incomplete. | 15 / 22 |
| A1.2 | All constituent categories | Partial | Individual/business/foundation/alumni/employee/community partner types, donor links and volunteer records; overlapping donor/volunteer/staff roles need explicit coverage. | 15 / 22 |
| A1.3 | Householding | Partial | Household text and per-group recognition; no managed household entity, membership/address workflow or merge. | 15 / 22 |
| A1.4 | Constituent relationships/subsidiaries | Local | Parent organization links and descendant rollup; broader relationship types remain expansion. | 15 / 23 |
| A1.5 | Interaction history | Local | Dated Logged communications and linked completed acknowledgment history. | 15 / 23 |
| A1.6 | Notes and attachments | Partial | Notes work; no attachment upload/storage/permissions or migrated files. | 15 / 23 |
| A1.7 | Communication preferences | Local | Email/phone/post/do-not-contact preference and acknowledgment/follow-up safeguards; provider consent sync remains absent. | 15 / 23 |
| A1.8 | Segmentation | Local | Saved comma-separated segments and constituent search/filtering; advanced dynamic segments not claimed. | 15 / 23 |
| A2.1 | Annual campaigns | Local | Annual campaign goal/date/status with linked recorded gifts. | 15 / 23 |
| A2.2 | Capital campaigns | Partial | Capital type, goal/date/status and gift links; specialized campaign planning/pipelines not delivered. | 15 / 23 |
| A2.3 | Major gifts | Partial | Major gifts campaign classification and donor/task history; portfolio/prospect qualification workflow absent. | 15 / 23 |
| A2.4 | Planned giving | Partial | Planned gift/category and campaign labels; no instrument, valuation, estate or realization workflow. | 15 / 23 |
| A2.5 | Matching gifts | Partial | Matching gift/category and campaign labels; no matching obligation/claim/provider reconciliation. | 15 / 23 |
| A2.6 | Peer-to-peer fundraising | Missing | A campaign label is not a public fundraiser page, participant ownership or attribution workflow. | 15 / 23 |
| A2.7 | Recurring gifts | Partial | Recorded Recurring category; no subscription schedule, collection, pause/retry or provider events. Pledge schedules are separate. | 15 / 23 |
| A2.8 | Online donations/credit cards | Missing | Recording a Credit card method does not collect a payment; hosted giving/processor flow absent. | 16 / 23 |
| A2.9 | Pledges | Local | Exact-cent installments, qualifying linked receipts, overdue/balance and void reversal; no collection. | 16 / 23 |
| A2.10 | Gift acknowledgments | Partial | Selective local preview and manually completed linked interaction; no provider-confirmed delivery. | 16 / 23 |
| A2.11 | Tribute/memorial gifts | Partial | Tribute/memorial text on gifts; honoree/notification contact and acknowledgment workflow incomplete. | 16 / 23 |
| A3.1 | Online donations | Missing | No public donation checkout or verified processor ingestion. | 16 / 23 |
| A3.2 | Credit cards/ACH | Missing | Method labels/manual imports only; no processor-backed acceptance/settlement. | 16 / 23 |
| A3.3 | Pledge tracking | Local | Shared pledge/receipt reconciliation and history, as distinct from payment settlement. | 16 / 24 |
| A3.4 | Tax receipts | Missing | Acknowledgment preview is not an approved tax receipt/numbering/issuance/reissue workflow. | 16 / 24 |
| A3.5 | Acknowledgment letters | Partial | Local letter/merge preview and manual completion; approved templates/issued documents and delivery incomplete. | 16 / 24 |
| A3.6 | Soft credits | Local | Explicit recipient and recognition reports; group deduplication prevents double counting within each group. | 16 / 24 |
| A3.7 | In-kind donations | Local | Noncash type/method consistency, value and allocations; reports separate monetary/noncash values. | 16 / 24 |
| A4.1 | Grant prospects | Local | Funder links and Prospect/Preparing/Submitted stages with request amounts. | 16 / 24 |
| A4.2 | Grant calendar | Partial | Deadline lists, filters and Operations source links; no calendar service, recurring milestones or reminder delivery. | 16 / 24 |
| A4.3 | Proposal management | Partial | Stage/date/notes; no proposal document/version/submission-evidence workflow. | 16 / 24 |
| A4.4 | Awards | Local | Recorded award/date distinct from request; funder-linked receipts and award balance; unknown legacy awards explicit. | 16 / 24 |
| A4.5 | Reporting deadlines | Partial | Recorded report due dates and review work items; no completed report evidence or automated reminders. | 16 / 24 |
| A4.6 | Detailed grant history | Partial | Saved grant, linked gifts and audit activity; no agreement/document or milestone/version history repository. | 16 / 24 |
| A5.1 | Volunteer records | Local | Constituent-linked volunteer skills, event references, time ledger and booking history. | 16 / 24 |
| A5.2 | Volunteer hours | Local | Staff clock intervals, separate undated historical hours and reasoned audited corrections. | 16 / 24 |
| A5.3 | Volunteer skills | Partial | Free-text skills recorded; no controlled taxonomy, proficiency or skill-based assignment. | 16 / 24 |
| A5.4 | Volunteer scheduling | Local | Staff same-day venue/time/capacity shifts; explicit roster and overlap protection, one shared local timezone. | 16 / 24 |
| A5.5 | Reports/signup/login/clocks | Partial | Hours/dated ledger reports and staff clock actions; no verified volunteer login or independent self-service signup. | 16–17 / 24 |
| A5.6 | Timed capacity/reminders/cancellation | Partial | Capacity at selected intervals, staff waitlist/cancel/promotion and retained history; no public cancellation or automatic email reminders. | 17 / 25 |
| A6.1 | Event registration | Local | Staff constituent registration/cancellation with event capacity enforcement. | 17 / 25 |
| A6.2 | Ticketing | Partial | Event ticket price field; no ticket inventory/issuance/checkout/refund workflow. | 17 / 25 |
| A6.3 | Sponsorship tracking | Partial | Sponsorship gift type and event sponsor goal; no sponsor agreement/benefit/fulfillment or full event attribution. | 17 / 25 |
| A6.4 | Seating | Partial | Registrant seating label; no seating-plan editor or unique seat inventory. | 17 / 25 |
| A6.5 | Attendance | Local | Registered attendance/check-in state; does not infer volunteer time. | 17 / 25 |
| A6.6 | Auctions | Missing | No item/bid/winner/checkout or settlement workflow. | 17 / 25 |
| A6.7 | Check-in | Local | Staff admission/check-in requires valid event registration. | 17 / 25 |
| A6.8 | Event payments | Missing | Prices and recorded gifts are not event payment collection/refund/settlement. | 17 / 25 |
| A6.9 | Planning/checklists/assignments | Partial | Event-linked owned tasks and completion; dependency checklists and coordinated event workflow absent. | 17 / 25 |
| A7.1 | Email marketing | Missing | Draft/logged interactions are not a marketing send service. | 17 / 25 |
| A7.2 | Communication segmentation | Partial | Constituent tags/preferences; no provider audience selection/synchronization and consent-tested campaign sends. | 17 / 25 |
| A7.3 | Automated workflows | Missing | Derived work queues exist; no configurable triggers/actions or provider execution. | 17 / 25 |
| A7.4 | Optional SMS | Missing | No SMS provider, opt-in or delivery workflow. | 17 / 25 |
| A7.5 | Mail merge | Partial | Local acknowledgment/merge preview; no complete multi-recipient document/email merge workflow. | 17 / 25 |
| A7.6 | Communication campaign tracking | Partial | Fundraising campaign-to-gift links; no marketing campaign send/engagement/attribution model. | 17 / 26 |
| A7.7 | Selective acknowledgment email | Partial | Eligible gifts selectively previewed/manually completed; email delivery absent. | 17 / 26 |
| A7.8 | Mailchimp | Missing | No authorized two-way contact/segment/consent sync; 6,500-contact/10-year buyer history unconverted. | 17 / 26 |
| A7.9 | Response tracking | Missing | No provider-derived bounce/unsubscribe/delete/delivery statistics. | 17 / 26 |
| A8.1 | Many school/department child designations | Partial | Validated hierarchy and account codes work; representative district-wide volume/import and scale acceptance not established. | 18 / 26 |
| A8.2 | Card/payroll uploads | Partial | Strict gift CSV template supports recorded card/payroll methods, references and atomic validation; actual payroll/processor mappings and split source conversion absent. | 18 / 26 |
| A8.3 | Minimum 4–6 users | Partial | Admin user creation and three roles work; only three accounts seeded and 4–6-user/concurrent lifecycle acceptance outstanding. | 18 / 26 |
| A8.4 | Dashboard/trends | Local | Database-derived metrics and giving trends with supporting-record drill-through; no predictive claims. | 18 / 26 |
| A8.5 | Reminders/to-do lists | Partial | Owned dated tasks, upcoming work and Operations queues; no delivered notifications/recurrence/escalation. | 18 / 26 |
| A8.6 | Multiple profile contacts | Local | Multiple named/email/role contacts within the constituent profile, up to 50 per schema. | 18 / 26 |
| A8.7 | Workspace/Office/processors/giving/SSO/APIs | Partial | Authenticated internal API and documented module contracts; no Google/Microsoft/payment/giving/SSO connectors or managed external API scopes. | 18 / 26 |
| A8.8 | Subaccounts/multiple locations | Partial | Designation school/location text and account code; no authoritative multi-location subaccount/accounting model. | 18 / 26 |
| A8.9 | Stripe compatibility | Missing | No Stripe checkout/webhook/settlement integration or verified compatibility evidence. | 18 / 26 |
| A8.10 | Sponsorship versus donation | Partial | Separate Sponsorship/Cash revenue types and filters; agreements, event attribution, benefits and buyer-approved accounting treatment incomplete. | 18 / 26 |
| B1 | Standard reports | Local | 13 predefined report choices covering donor, designation, ledger, follow-up, grants, pledges, recognition and volunteer time. | 18 / 27 |
| B2 | Custom report builder | Missing | Saved filters are not arbitrary field/group/calculation/layout construction. | 18 / 27 |
| B3 | Reporting dashboards | Local | Shared database-derived dashboard, monetary/noncash separation and supporting records. | 18 / 27 |
| B4 | Fundraising analytics | Partial | Campaign goals, recorded giving trends and donor/recognition summaries; advanced retention/cohort/forecast analytics absent. | 18 / 27 |
| B5 | Board reports | Partial | Board read-only access and shared reports; approved institutional board pack/templates not validated. | 18 / 27 |
| B6 | Excel/PDF export | Partial | CSV opens in Excel; browser print/save PDF exists; no native XLSX, dedicated report PDF or completed-download verification. | 18 / 27 |
| B7 | Scheduled reporting | Missing | No schedule, authorized recipient delivery, retry or delivery evidence. | 18 / 27 |
| B8 | Revenue-type reporting | Local | Cash/in-kind/grant/fee/employee/sponsorship type filters and separate noncash; fees can be excluded. | 18 / 27 |
| B9 | Fiscal school-year assignment/filter | Local | Configurable fiscal start, derived transaction school year and filters; July default remains unconfirmed buyer policy. | 18 / 27 |
| B10 | Six specified operational reports | Local | Donor/date totals, designation/date totals, fee exclusion, first-time donors, inactivity/contact report and first/last gift dates exist; verify exact buyer results on migrated sample. | 18–19 / 27 |
| C1 | NonProfitEasy historical conversion | Missing | Generic gift import is not discovery/mapping/trial reconciliation of actual historical donor/transaction/interaction data. | 19 / 28 |
| C2 | Historical/current contracts conversion | Missing | No contract/attachment repository or actual contract export conversion. | 19 / 28 |
| C3 | Implementation services | Partial | Source launcher, guides, tests and CTO plan exist; actual PM/configuration/conversion/go-live and role training plan need named delivery ownership and acceptance. | 19 / 28 |
| C4 | Professional development/timeline | Evidence | No agreed initial/ongoing training service, dated implementation schedule or staffing commitment. Supplied RFP desires November 1, 2026 start. | 19 / 28 |
| C5 | Support/updates/human vs AI | Evidence | Local instructions only; name help desk/CSM, hours, SLA, knowledge base, maintenance/security update process and human/AI escalation boundaries. | 19 / 28 |
| C6 | Data protection/DPA/FERPA | Partial | Pilot auth/roles/preferences/validation exist; no signed DPA, approved data handling/retention or institutional privacy acceptance. | 19 / 28 |
| C7 | Security/assurance/recovery | Partial | Role checks, protected sessions, append-only app audit and stale writes; no MFA/SSO, at-rest/key evidence, restore test, supported assurance/PCI/Utah compliance evidence. | 19–20 / 29 |
| C8 | Cybersecurity/breach response | Evidence | Application protections do not establish monitored incident operations, notification process, named responders or tested breach-response program. | 20 / 29 |

## Mandatory gates and submission alignment

Part 2 pp.12–13 requires evidence of relevant product/service history and three qualifying references, iBoss compatibility, page-limit compliance, signed boycott statement, DPA/Learn Platform requirements and the direct-provider/reseller arrangement. Company name/website and a new POC do not establish those gates. Earlier official Q&A qualifications must be applied with evidence; Addendum2's geography requirements are additional. Participation remains conditional until Kode Kinetics' applicable bidder/provider/reference/location documentation is verified.

The supplied base RFP lists September 18, 2026 noon MDT as due (p.1); confirm against final portal notices. Technical submission must use the eight prescribed tabs and repeat each full criterion in exact order with a detailed narrative (pp.21–22). Keep pricing in separate prescribed cost forms; observe the 100-page limit and specified exclusions. This condensed matrix is a review aid, not that final narrative response.

**Packaging distinction:** p.10 prohibits ZIP/embedded-file submissions and requires separate readable uploaded files. Jordan-Everbright-Client-Testing.zip is a source/runtime handover for local testing, not an acceptable proposal upload. Any evaluation demo offered externally also needs an accessible supported hosting/testing arrangement; a localhost URL is not reachable by the buyer on their own machine without installing/running the package.

Presentations are optional, invited after mandatory and technical thresholds; statements made there become proposal representations (pp.6,30–31). Do not demonstrate labels as operational services or promise unsupported production/security status. Extra capabilities are encouraged (p.4), but all required narratives and working-vs-future distinctions remain necessary. Awarded services require signed contract and purchase order (p.31); local authorized POC development is not district work authorization.

## Required-first delivery decisions

| Priority | Work package / criteria | Acceptance gate |
|---|---|---|
| 0 | Bidder/provider eligibility and complete narrative/evidence; Part 2, pp.21–22 | Verify references/product history, provider role/letters where applicable, geography, iBoss and privacy/approval path; answer every criterion truthfully. No eligibility assertion from the demo. |
| 1 | Conversion and document foundations; A1.6, A4.3/A4.6, C1/C2 | Inventory approved source exports/contracts; implement protected attachments and contract records, migration mapping/preview, trial conversion and monetary/count/document reconciliation with rollback. |
| 1 | Buyer operational completeness; A1.2/A1.3, A6.3/A6.9, A8.1–3/A8.8/A8.10, B2/B5/B6/B10 | Define overlapping constituent roles, controlled household/relationship rules, sponsorship/event links and location/subaccounts; deliver flexible reports/native exports; verify 4–6 users and representative district data. |
| 2 | Approved communications and public volunteering; A5.5/A5.6, A7.1–9 | Verified participant identity/permissions; capacity/self-cancel recovery; Mailchimp consent/history mapping, provider-confirmed selective sends/reminders and failure/unsubscribe statistics. |
| 2 | Approved payments/fundraising; A2.4–8, A3.1/A3.2/A3.4, A6.2/A6.6/A6.8, A8.9 | Hosted provider sandbox and signed idempotent events; distinguish attempts, settlements, fees/refunds and recorded gifts; preserve manual upload/no direct bank link; approve receipt wording/treatment. |
| 2 | Productivity and reporting automation; A7.3, A8.5/A8.7, B7 | Scoped Google/Microsoft/external API services; explicit schedules/recipients; retry/disconnect/failure cases and audit; no inactive connect controls. |
| Production gate | C3–C8 and approved cloud service | Named staffed implementation/training/support and human escalation; MFA/identity/lifecycle, approved geography/encryption, tested recovery, security/privacy/incident evidence and buyer-scale acceptance. |
| After core acceptance | Predictive suggestions, deeper graphics and expansion options | Supporting source records, permission/consent safeguards, accessible solid data surfaces and reduced-motion/transparency; never displace mandatory workflows. |

These priorities refine the existing CTO phases rather than claim they are completed. Independent client testing should verify first-glance comprehension on actual buyer tasks; developer checks alone cannot establish that. Future deliverables must link each changed workflow to this criterion matrix, a recovery/permission case, persisted result and buyer acceptance gate.

Evidence references: RFP-COVERAGE.md, CTO-PROJECT-PLAN.md, PHASE-FOUR-ACCEPTANCE.md, API-CONTRACT.md and VERIFICATION.md alongside this review. No runtime behavior or evaluation records were modified during this review.
