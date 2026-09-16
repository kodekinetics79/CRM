# Remaining external gates

September 15, 2026. Kode Kinetics LLC / Wimblo. Everything below is outside what source code, local tests or a local deployment can settle. Nothing here is claimed as done, in progress or agreed. This list is deliberately separate from the engineering evidence so that a reader cannot mistake implemented behaviour for an operated, approved or accepted one.

## 1. Mandatory qualification gates (pass/fail, before technical review)

| Gate | Source | Status |
|---|---|---|
| Three years delivering the **proposed product** to US school-district nonprofit arms | Part 2A, p12; Q&A60, Q&A64 | **Not satisfied.** Q&A60 is explicit that implementation personnel history is insufficient and that product/provider evidence is required. A newly built Wimblo cannot substitute general Kode Kinetics delivery history. Q&A64 confirms failure removes the bid before technical review. |
| Three comparable US district references (Utah preferred, JSD excluded) | Part 2A, p12; Q&A32, Q&A46 | **Not satisfied.** Q&A32 permits US higher-education references; Q&A46 permits any-size US districts where comparable ones are unavailable. Qualifying referees must still exist and agree. |
| Reseller / provider letter where the software provider cannot contract directly | Part 2F, p13; Q&A85 | **Not satisfied.** Applies only to a prime-plus-provider arrangement; a self-built product does not produce this letter. |
| Signed Attachment B boycott statement | Part 2D, p12 | Authorized signatory action. |
| Signed Attachment E Student Data Privacy Agreement, and LearnPlatform approval | Part 2E, p12; Q&A29/31 | Legal signature and district determination. Local privacy controls do not establish FERPA approval. |
| iBoss compatibility without degrading filtering | Part 2B, p12; Q&A25/26 | Requires a district-path test with iBoss enabled on district endpoints and network. |
| 100-page proposal limit with stated exclusions; exact tab/criterion order; no ZIP or embedded-file uploads | Part 2C, p12; Part 4 pp21-22, p29 | Submission packaging, not software. |
| US/Canada headquarters and personnel; all collected data stored in US or Canada | Addendum 2 §1(a)(iv); Q&A42/58 | Company fact plus a residency commitment covering database, logs, backups, telemetry and every subprocessor. **Conflict on record:** Q&A56 reports North America or Europe acceptable; the later Addendum 2 restricts to US/Canada. The later amendment is applied conservatively and the conflict needs official clarification. |
| Mandatory live virtual presentation, ~90 minutes, after technical qualification | Q&A16/28 | Scheduled event; no prerecorded substitute. |

## 2. Provider gates (no external account exists or was contacted)

- **Email and SMS delivery.** No ESP or SMS account, sending domain, SPF/DKIM/DMARC records, 10DLC or short-code registration, bounce/complaint feedback loop, or delivery evidence. Only a TEST_ONLY transport ships; production transports are refused. A recorded handoff is not delivery, an open, a click or a human reply.
- **Mailchimp bidirectional integration (Q&A53).** No authorized account, no contact write path, no live unsubscribe/bounce return at buyer volume. Current work is observation and a separate reviewed update slice against a mock provider.
- **Payments (A2.8, A3.1, A3.2, A6.8, A8.9).** No executed Stripe or other processor account, no sandbox run, no settlement, refund, dispute or payout. Q&A86 records that the buyer has no Stripe account and district policy prevents connecting its payment account to the CRM; manual entry and upload remain the mandated path.
- **Identity provider (A8.7).** The OIDC/OAuth2 boundary was validated against a locally generated key pair and a simulated issuer. No Google, Auth0 or Okta tenant, client registration, redirect allowlist or secret custody exists, and the boundary issues no workspace session.
- **Hosted model inference.** No hosted model is contacted. Remote egress requires a separately recorded authorization reference and is refused otherwise, independent of data mode and of who supplies the transport.

## 3. Buyer-data gates

- **C1 historical conversion and C2 current contacts.** Actual NonProfitEasy exports are supplied after award. Q&A86: source downloads and reports end November 30, 2026. All conversion evidence to date uses synthetic fixtures at the buyer's reported counts (6,515 constituents, 1,622 designations), not the buyer's records.
- **A8.1/A8.8 account structure.** The buyer's real designation list, location and function code assignments, and annual add/retire batch. **Open buyer question:** whether one designation must report under several accounts at once. The current model gives each designation exactly one account, which is what makes double posting structurally impossible; answering yes requires an explicit apportionment rule and reintroduces that risk.
- **A3.4 receipts.** Buyer-approved organization, tax, benefit and noncash wording, the calendar-year employee policy, and actual printing, signature and issuance operations.
- **B5 board pack.** Buyer-approved board output. Every drilldown named in Q&A6 is implemented and reconciled; approval is a separate act.
- **A8.2 uploads.** Buyer SchoolWindows/Successfund exports and the payroll Excel-to-CSV mapping.

## 4. Operational gates (implemented ≠ operated)

- Hosted operation of a durable database, with the deployment constraint discovered in this run: **the application must not connect as the database owner**, because row-level security is ineffective under a superuser connection.
- Key custody for the MFA encryption key, backup encryption key and object-storage key, held separately from archives and from each other.
- Off-host backup cadence, retention enforcement, geographic replication, and a timed buyer-scale restore drill.
- **Physical proof of data residency.** The software constrains what it accepts and records `placementProven: false` by design; no code can observe where a provider puts bytes.
- A monitored alert transport and paging rota. Alert hooks ship inert with no transport.
- Off-host, tamper-evident log and audit retention. Current telemetry is process-local and bounded.
- A performed incident tabletop with recorded elapsed times, a named incident commander, privacy owner and district contact roster.
- An adopted retention schedule with district-approved periods, reconciled with the executed DPA.
- Staffed support meeting Q&A57 (Monday–Friday 8am–5pm Mountain, non-critical response within 24 hours), funded training, and maintenance.
- Named project management, configuration, conversion, testing, go-live and training delivery (C3, C4).

## 5. Assurance gates

No SOC 2, ISO 27001, PCI AoC, FERPA determination or LearnPlatform approval is established by any local control, test or document in this repository. Q&A56 permits equivalent documented controls in place of SOC 2/ISO 27001 and does not require an independent penetration test, but equivalence must still be documented and accepted by the district.

## 6. What this run did **not** do

No production deployment was performed, no provider was contacted, no message was sent, no payment was charged, no real constituent data was used, and no credential was exposed. No criterion is marked accepted by the buyer, and `acceptedByBuyer` is `false` for all 84 criteria.
