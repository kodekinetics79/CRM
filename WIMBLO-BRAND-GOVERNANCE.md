# Wimblo brand governance and copy review

September 13, 2026 · Marketing Director SME review · application source read-only.

**Wimblo is the sole product and default workspace identity.** The user's latest instruction removes Jordan Education Foundation/customer branding from the running product. That instruction supersedes earlier statements that retained the customer as a branded workspace. RFP requirements, original document titles and dated acceptance evidence remain attributable to their actual sources; they do not become Wimblo customer claims.

## Identity rules

- Use **Wimblo** in page titles, product prose, About, current guides, exports and release/package labels. The approved wordmark may use lowercase **wimblo** as a visual treatment. Do not introduce Wimblo/Jordan, Jordan Wimblo, JEF, Everbright or Kinflect as current product identities.
- Use the approved Gather symbol and indigo/apricot palette. The shared `Brand.jsx` composition owns the mark and wordmark; avoid competing logo compositions or customer subtitles. The inspected shipping `public/brand/wimblo-gather.png` contains only the sculpture, with no customer/legacy text.
- Default workspace settings should identify **Wimblo**. A known inherited customer-branded evaluator default must not reappear in Settings, report captions, printouts or snapshots. Migrate only explicit obsolete defaults; preserve actual custom settings and business records.
- Keep nonprofit terms such as constituent, gift, pledge, grant, fund and volunteer when they describe workflows. Generic “foundation” is a domain noun, but “workspace,” “team” or “nonprofit” provides clearer portable copy where no foundation-specific behavior exists.
- Kode Kinetics LLC is factual provider attribution, not a second product brand. Keep provider/legal attribution separate from the Wimblo wordmark; About is the appropriate place for expanded provider information.
- Do not claim registered trademark status, domain ownership, trademark clearance, district endorsement, institutional approval, approved customer relationships or compliance certification. Logo generation does not establish uniqueness or legal clearance.

## Actionable copy inventory

The following residuals were present at initial review and reported to the implementation owner. A subsequent source reinspection found the listed current copy/default/governance corrections implemented. The table retains the initial findings and recommended direction as review provenance; this reviewer changed no application source.

| Surface / source | Residual or contradiction | Recommended disposition |
|---|---|---|
| `src/components/Brand.jsx` | Wordmark subtitle “Jordan Education Foundation” appears in navigation and login | Remove subtitle or use “Connected nonprofit work.” Wimblo remains the only identity |
| `src/App.jsx` login | “Programs that move Jordan’s classrooms forward” | “Connect people, giving and programs in one workspace.” |
| `src/features/Dashboard.jsx` | “Jordan’s generosity, connected to opportunity” | “A clear view of people, giving and programs.” |
| `src/features/Stewardship.jsx` | “Stronger connection with Jordan’s community” | “Keep every gift connected to the people behind it.” |
| `src/features/Guide.jsx` | Current introduction calls Wimblo tailored to Jordan Education Foundation | “Wimblo is a functional nonprofit workspace for reviewing connected workflows.” Retain the synthetic/local scope statement where evaluator mode applies |
| `index.html` title and description | Browser title and metadata identify Jordan Education Foundation | Title “Wimblo”; description “Wimblo connects people, giving, programs and everyday work.” Add evaluator qualification where applicable |
| `server/app.js` fresh settings | `organizationName` defaults to Jordan Education Foundation | Default to Wimblo so Settings, captions and exports use the selected identity |
| `server/app.js` old-default upgrade | “Foundation CRM · Evaluator pilot” upgrades into Jordan Education Foundation | Upgrade known obsolete defaults into Wimblo, with existing audited settings migration; include prior customer-branded default in exact-match handling |
| `README.md` current introduction/release paragraph | Claims tailored customer workspace and explicitly says customer identity remains | Replace current product statements with Wimblo-only identity and compatible local evaluator scope |
| `README.md` launch wording | “Jordan-Wimblo directory” | Use the actual delivered directory name or “the Wimblo application directory.” Do not invent a package path |
| `CLIENT-TESTING-GUIDE.md` current introduction | Describes a customer-tailored branded application | Describe Wimblo nonprofit evaluation; preserve fictional-data, manual-results and actual scope limits |
| `BRAND.md` current policy | Declares “Client workspace: Jordan Education Foundation” | Replace with “Product and default workspace identity: Wimblo.” Dated name-change provenance may remain |
| `PRODUCT.md` current identity instructions | Earlier phase notes still prescribe buyer-branded workspace | Add an explicit latest Wimblo-only rule and contextualize superseded phase notes; keep named RFP source/requirements attribution |

Optional consistency improvements: “Search your workspace…” and accessible “Search all workspace records”; role label “Staff”; preview heading “Gift acknowledgment preview”; signature “Your team.” These improve portability without changing the gift, role or acknowledgment contract. Preview wording must continue to say it is not an issued tax receipt.

## Concise reusable product wording

| Placement | Recommended copy |
|---|---|
| Product descriptor | Wimblo · Connected nonprofit work |
| Login headline | Good work starts with connection. |
| Login support | Connect people, giving and programs in one workspace. |
| About introduction | Wimblo connects people, giving, programs and everyday work so your team can see what happened and choose what comes next. |
| Dashboard support | A clear view of people, giving and programs. |
| Stewardship support | Keep every gift connected to the people behind it. |
| Evaluator qualification | Synthetic records. Saved workflows. No live payments or message delivery. |
| Provider attribution | An application by Kode Kinetics LLC. |

These statements describe implemented local connections. Avoid “complete platform,” “production ready,” “compliant CRM,” “trusted by Jordan,” “district approved,” “bank reconciled,” “automated giving,” “messages delivered” or claims of hosted/support capability unless the corresponding evidence exists.

## What to retain without turning it into branding

Original RFP/customer names belong in source/evidence citations, procurement requirement mappings and accurately dated historical reviews. Historical Everbright/Kinflect names can remain in dated review provenance with a current explanatory note; they should not be presented as the running product identity. Source documents must not be rewritten to imply the customer owns, endorses or approved Wimblo.

Internal `jordan_everbright_evaluator_session`, `everbright-density`, legacy database names and temporary test prefixes are compatibility identifiers rather than visible branding. Do not blindly rename them and invalidate sessions/preferences. If renaming is later desired, use an explicit compatible migration and verify it independently. Synthetic person **Jordan Lee** is a person's name, not Jordan Foundation branding; changing it is unnecessary. Actual user-entered constituent/organization names are business data and should not be globally replaced.

## Brand release gate

At initial inspection, the Wimblo name, shipping Gather mark, About heading, route page titles, testing export product/name, snapshot filename and evaluator startup label already used Wimblo. **Subsequent source reinspection passes the current-copy gate:** the customer subtitle is removed; login, Dashboard, Stewardship and Guide use neutral Wimblo copy; metadata uses Wimblo; fresh workspace defaults use Wimblo; exact old generic/Jordan Foundation/Jordan Education Foundation defaults migrate to Wimblo with audited previous/new values; current README, client guide, BRAND and PRODUCT instructions now prescribe Wimblo-only identity. A targeted scan of src, server, index and public found only compatibility keys, explicit migration match strings and a synthetic person name. None is a rendered customer brand. Full built-browser/package and migration test execution remain separate verification gates; test source now includes legacy default migration/restart cases, but this review does not claim their execution.

The implementation owner should verify login, navigation, Dashboard, Stewardship, About, Guide, Settings, report/print captions and exported artifacts against both a fresh evaluator database and an existing customer-default database. Build and reopen the actual delivered application so stale bundled text does not survive. Browser/manual results should state the observed surface and database state; source inspection alone is not a completed UI pass.

This review preserves RFP evidence and makes no institutional approval or certification claim. It changes no application source, permissions, financial semantics, migration records or live external systems.
