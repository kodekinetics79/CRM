# Wimblo: reliability depth and competitive readiness

September 13, 2026. This is an engineering evidence register, not a vendor parity, certification, bidder list, or buyer acceptance claim. The specialist agents applied financial, migration and solution-architecture review perspectives. No agent's employment at or delivery experience with a competitor is asserted.

## What changed in this pass

| Customer problem | Working change | Verification |
| --- | --- | --- |
| A gift can have the right total and wrong revenue classification or destination | Import plans group exact cents by revenue type, payment method, designation source ID and account code. Commit independently compares saved new-record groups/counts and rolls back discrepancies. New, reused and all validated groups are distinct. | Adversarial unchanged-grand-total misposting tests; rollback includes records, mappings, batches and audit. |
| A changed fiscal policy can silently invalidate an import review | Preview fingerprints all twelve monthly fiscal boundaries, including an empty workspace's first import. | February-to-March change rejects the old preview without writes; a fresh review imports the correct year. |
| Staff cannot easily locate one bad row | Fifty-row validation pages, errors-only filter, downloadable identifier/problem checklist, mapped first-row samples and a pre-upload combined row limit. | Stateful event tests and browser invalid-to-corrected CSV journey. The checklist is not a replacement import file. |
| Retried imports can look like new revenue | Explicit all-validated versus new-gift labels, scoped new/reused controls, existing exact replay protection and saved expected/actual reconciliation. | Replay/control tests and UI event tests. Reused values do not add revenue again. |
| Staff cannot trace a converted source record after later edits | Administrator batch detail separates saved reconciliation from current Unchanged/Changed/Missing lineage; exposes source ID to Wimblo ID and original batch; downloads lineage and shows file mappings. Existing records open through ordinary workspace navigation. | Mounted history/replay/historical coverage tests and browser saved-source inspection. Older batches disclose incomplete lineage coverage. |
| Import history grows too large or older batches disappear from view | Compact bounded batch summaries with validated cursor pagination; full mapping/row detail loads only when requested. Load older batches appends pages. | Server pagination and UI event tests. This is bounded history access, not buyer-scale migration proof. |
| A save succeeds but its follow-up refresh fails | The screen preserves saved reconciliation and explicitly says the batch saved while workspace refresh failed. | Stateful success-plus-refresh-failure regression. No suggestion to blindly recommit an uncertain operation. |
| Deleting an old donor or fund breaks financial provenance | Generic deletion transaction protects before/after source records retained by financial corrections, preserving current permissions/version checks. | Reproduced historical designation and former soft-credit identity deletion before repair; unrelated unused records remain removable. |
| Deleting a donor breaks a prepared correspondence snapshot | Prepared and finalized Messaging recipient references prevent constituent deletion; preference changes remain supported. | Reproduced deletion before repair; mounted role/version/CSRF/restart/opt-out tests. No claim of live email delivery. |
| Errors or audit failure leave inconsistent finances | Existing correction/whole-void flows now have additional fault injection and retry assertions. | Failed history/audit insert rolls back exact splits and money; successful retry records once; repeat void returns conflict. A void is not a payment refund. |

## Established-platform practices reviewed

These are documented examples of mature workflow expectations, not verified participants in this procurement. Findings below are our engineering interpretation of primary sources reviewed September 13, 2026.

- [HubSpot import error review](https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors) documents error details, imported/new/updated summaries, and downloadable error information. Wimblo now makes identifiers/problems and new-versus-reused counts easier to review. It does not implement HubSpot's in-tool bulk value replacement or breadth of activity imports.
- [Salesforce NPSP data preparation](https://trailhead.salesforce.com/content/learn/projects/import-your-data-using-npsp-data-importer/prepare-your-data-for-import) emphasizes preparing data and using applicable import templates. Wimblo retains explicit source identity mapping and review-before-commit. It does not provide NPSP's complete import/update object coverage or established ecosystem.
- [Bloomerang CRM import workflow](https://help.bloomerang.com/en/articles/12632760-imports-import-data-into-bloomerang-crm) documents mapping previews, predicted new/updated records, small-file trials and skipped-record recovery. Wimblo's present financial conversion deliberately requires the whole reviewed batch to validate rather than silently skipping bad monetary rows. Saved reusable mapping templates and interactions/notes conversion remain unfinished.
- [Raiser's Edge NXT gift flow](https://webfiles-sc1.blackbaud.com/files/support/helpfiles/rex/content/donfm-renxt-giftflow.html) documents transaction review, grouping by source/date/payment method and approval before gift records are created. Wimblo's grouping and reconciliation deepen manual-import review; they do not supply Blackbaud's online transaction processing or matching pipeline.

## Requirements first: closing order

The RFP and its addenda remain the acceptance source. Feature quantity cannot replace software-provider experience/references or buyer confidence. Current 84-criterion disposition remains 46 Local, 24 Partial, 11 Missing and 3 External; this pass strengthens evidence within existing partial items and does not declare new criteria complete.

| Priority | Remaining requirement/product work | Done when |
| --- | --- | --- |
| Core conversion | Obtain approved real exports; finish source-specific field contracts, interactions/history/files and delta/correction policy; batch/restore capacity beyond present limits | Source counts and classified totals reconcile to exports, every accepted relationship resolves, no dropped history, repeat/delta rehearsals and buyer sign-off |
| Staff comfort and reporting | Exercise donor lookup → gift allocation → receipt → correspondence → July–June/custom report journeys with buyer-like data and helpers | Staff finish without coaching; report drill-through/export agree; permissions and failure recovery hold |
| Delivery and connectors | Select authorized email/SMS/identity and hosted giving providers; implement delivery state, suppression, retries and provider reconciliation | Sandbox then authorized live evidence; ambiguous callbacks never become duplicate business writes; real delivery verified |
| Identity/duty policy | Approve ordinary module/export permissions and two optional helper duties; preferred SSO and account-recovery operating procedure | Approved role matrix enforced server-side, tested across record/document/report/export routes and operator recovery drills |
| Durable service | Render changes deferred by Zack; operate private storage, backups, restore drills, monitoring/alerts and tested frontend API routing | Real persistent restart, exact private provider versions, off-host scheduled backup/readback, complete new-root recovery and alert evidence |
| Capacity | Current conversion 500 rows across up to ten server files; UI one file per each of three supported types. Current archive 128 MiB and individual document 1 MiB | Accepted buyer volumes/ten-year retention, recovery budget and measured representative workloads; do not merely raise limits |
| Additional competitive capability | Extend deterministic next actions, explainable segmentation and approved reviewed AI after core closure | Traceable source-backed suggestions, ordinary permission/consent rules, explicit human approval and authorized real-data processor/residency policy |
| Contract/support evidence | Qualifying product/provider references, signed privacy/residency terms and staffed support/training/renewal commitments | Independent commercial/operational evidence; code cannot manufacture it |

No live deployment, provider payment, external communication, paid infrastructure change, or buyer migration was performed in this pass. Render remains deferred. The product remains React/Vite + Express/SQLite; attached Neon credentials are not a completed PostgreSQL business-data migration.

## Final verification

- Full combined suite: **468/468 pass**, zero failures/skips; **20.222376583 seconds**. This supersedes the earlier 462-test intermediate run for these source changes.
- Frontend build passes in **1.34 seconds**; main bundle **482.16 kB** before gzip. No hosted performance benchmark is implied.
- Independent solution-architecture review reproduced the fiscal-preview defect; after repair, final source review reported no additional verified blocker in this pass's scope.
- Actual browser journey against the restarted isolated built application at `127.0.0.1:4341`: stage 60 constituents, one fund and 60 gifts; reject one three-decimal amount; errors-only review isolates data row 60; upload corrected source; classify 60 Cash/Check gifts allocating **$740.40** to `DEPTH-100`; commit 121 records; reopen saved batch showing 121 unchanged source records; paginate lineage; open source gift 38 into its ordinary saved **$12.34** record.
- Mobile at 390 × 844: source lineage restructures as stacked records; desktop lineage table hidden; document width equals viewport (390); source navigation and pagination work. Desktop operating layout inspected; browser captured no warning/error logs for the tested isolated tab. Temporary viewport override reset.
- UI event tests additionally cover error-checklist spreadsheet formula escaping, new/reused control scopes, older batch coverage, saved-versus-refresh-failure feedback and appending/refreshing older history pages.
- Test data are synthetic. No actual buyer conversion, provider delivery/payment, public API capacity, live hosting durability or full competitive parity was validated.
