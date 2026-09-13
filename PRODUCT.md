# Wimblo

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Delegated by Zack: React + Vite frontend, Node 24 Express server, SQLite local evaluator database. Browser workspace and synthetic test data first; external hosting later.

## Users
Foundation staff managing constituent records, gifts, campaigns, grants, events, and volunteers. RFP evaluators must be able to test the application directly. Administrator, staff, and read-only board evaluator accounts.

## Product Purpose
The intended deliverable is a fully functional, hosted and supported Wimblo CRM product with optional customer branding, aligned with RFP 27TH05P5. The current implementation supports real local evaluation workflows and remains incomplete for institutional production. Users should complete real saved workflows rather than inspect static mockups. The pilot must not be described as production-certified or as satisfying bidder experience requirements.

## Operating Context
Nonprofit fundraising and relationship management. The supplied Jordan Education Foundation RFP is a requirements source, not the application identity. Donation designations include schools, classrooms, programs, and foundation funds. Manual donation recording/import accommodates the district's stated bank-linking restriction. Record types and workflow requirements derive from the supplied RFP; actual live third-party integration credentials and migration exports are not provided.

## Capabilities and Constraints
Saved records, role access, searchable tables, split gift allocation, fiscal-year reports, CSV import/export, grants, volunteer time, event registration/check-in, tasks, communication drafts/logs, audit history. Persistent local backend. Synthetic data only. Actual fiscal-year start month is unverified and configurable. No external mail sending, payment processing, SSO, certifications, or buyer authorization is implied.

## Brand Commitments
Kode Kinetics LLC, www.kodekinetics.com. User explicitly requests Impeccable and standard UI/UX conventions; build directly in code and review finished screens. Wimblo is the sole product brand selected by Zack. Do not use Jordan Foundation, JEF or a district name in the product identity, shell, login, page headings or metadata. Requirements documentation may identify the source RFP without implying affiliation. Do not fabricate official logos, customers, references, or compliance certifications.

## Evidence on Hand
RFP and attachments under Downloads/27TH05P5 - pub - RFP- Nonprofit CRM Software for Jordan Educ. Extracted working text at ../../work/rfp-review. Generated dashboard concept in design/dashboard-concept.png is inspiration only, not an approved image specification: user chose code-first.

## Product Principles
- Prove capability through working saved workflows.
- Use familiar navigation and explicit actions.
- Protect financial integrity and preserve an audit trail.
- Separate actual capabilities from future integrations and approvals.
- Keep sample data recognizable and editable.

## Accessibility & Inclusion
Keyboard-operable navigation and forms, visible focus, text contrast, explicit labels/errors, responsive tables and mobile navigation. WCAG 2.2 AA is a design target, not a claimed audit certificate.

## Phase Two
User authorized deeper POC capabilities and UI/UX refinement. Scope: pledges and reconciliation, recognition/relationship rollups, dated volunteer time with historical separation, manual acknowledgment queue and shared saved report views. Preserve incumbent School fund ledger identity. Product name and default workspace identity: Wimblo. Customer branding is optional and requires explicit configuration. Code-first, local synthetic preview remains confirmed.

## Security and compliance contract

Current controls include account suspension/role changes with immediate session revocation, final-administrator protection, version/CSRF checks and production acceptance-tool isolation. Read scope, MFA/SSO, durable hosted database/recovery and privacy lifecycle remain production gates. RFP-SECURITY-COMPLIANCE.md is the source requirement/evidence register; security_best_practices_report.md ranks gaps; SECURITY-OPERATIONS.md is a draft for staffed adoption and district approval. No certificate, signed DPA, approved residency or operational SLA is implied.
