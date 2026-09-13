# Wimblo source conversion and cutover custody

September 13, 2026 · next core closure pass

The implemented normalized importer is one component of conversion, not a complete ten-year migration. This plan makes the remaining source work explicit without inventing source exports or claiming buyer acceptance. The reported November 30 source-download cutoff is the critical custody deadline; continued source access until March is not a download extension.

## Preserve originals before preparing conversion copies

Inventory each authorized source export, report and attachment collection. Record source system, export purpose/date/timezone, owner, native filename/format, row/entity scope, source-ID meaning, byte size and checksum, consent/history content, and the approved private custody location. Preserve original bytes. Mapping a prepared CSV copy must not overwrite or replace the native export.

Wimblo's current content fingerprint identifies the normalized request and mapping. It is not a checksum of the original provider export, a complete attachment inventory or proof of custody. Migration sourceFiles records supported collection, row count and mapping; it does not retain original export bytes. Storage location, retention/holds, access and all-copy US/Canada evidence require real approved operation.

## Classify source facts before importing

| Source facts | Current supported path | Separate conversion work needed |
|---|---|---|
| Constituent identity and supported category, parent, scalar contact fields, explicit preference | Normalized constituent rows with explicit source IDs, optional strict contact arrays and preserved explicit preference | Additional categories/overlap, household membership, aliases/duplicates, consent evidence and complete retained identity history |
| Designations/account codes and parent/location labels | Normalized designation rows | Accepted location/subaccount relationships and complete source hierarchy/mapping |
| Posted positive gifts and balanced exact-dollar allocations | Normalized gift rows, original calendar date, type/method and source references, optional explicit campaign links | Source void/refund/reversal/correction history; pledge, grant and commitment relationships; historical fiscal reassignment; receipt/acknowledgment/soft-credit details outside the current mapped fields |
| Campaign goals/dates/status | Normalized campaigns with explicit source IDs, original required dates and exact goals, including zero | Source actor/version history and campaign execution/attribution beyond supported fields |
| Grants, pledges and major/planned/matching commitments | Not converted by the current importer | Accepted record/version/association/activity mappings; commitment versus cash realization and exact once-only revenue linkage |
| Volunteers, shifts, reservations and dated/undated/corrected time | Not converted by the current importer | Historical source chronology, identity/capacity relationships and original-versus-corrected ledger |
| Events, registrations, seating, sponsor/auction commitments and payments | Not converted by the current importer | Original status/transitions/benefits/attribution and committed-versus-received reconciliation |
| Dated Logged interactions explicitly classified Workspace | Normalized source ID, constituent link, original calendar date, channel, subject/body/notes; shared with current workspace readers | Restricted/private source history, original actor/timestamps beyond the calendar date and source revisions |
| Communication/receipt/acknowledgment delivery history and provider events | Not converted by the current importer | Original delivery/fulfillment facts, consent/opt-outs and distinct historical actor/date; never replay a legacy fact as a newly confirmed current action |
| Documents/contracts/attachments and revisions | Not converted by the current importer | Private original bytes, checksums, source record/revision links, visibility, evidence dates and retention/hold policy |

Do not import a source void/refund/reversal as an ordinary posted positive gift. A recurring/planned/matching/pledge-fulfillment label does not rebuild its commitment or execution history. Explicit campaignSourceId links now convert. Pledge/grant commitment IDs remain unlinked by this importer. An unmapped contact preference defaults to Email; this is not evidence of marketing consent and must not discard actual opt-outs.

## Run governed batches

Keep the source-system name and source IDs stable. Use distinct stable batch keys for distinct prepared files. Within one batch the planner resolves supported dependencies; across batches create constituent/designation/campaign dependencies before their gifts. Do not split a parent/dependent set blindly. Maximum 500 total rows per batch, ten server files and the 2 MiB serialized request bound remain in force; the screen stages one file per supported type and limits each CSV to 500 KB/30 columns.

Preview is read-only. Review every suggested mapping, error and source conflict, plus counts and exact type/method/account allocation controls. All rows must validate before an atomic commit. Changed source IDs/values and changed mapped dependencies need governed reconciliation; a new batch key is not permission to overwrite history or silently merge identities.

After each commit inspect saved reconciliation and current lineage. A retry of the identical source/key/content returns the original result without duplicate revenue. If a response is uncertain, inspect history before retrying. A changed current record is not silently rewritten by replay; keep original committed facts distinct from current integrity. Staff constituent data must not create a login or infer Employee-only receipt eligibility.

## Acceptance before final cutover

1. Approve every source entity/history/file mapping and category/financial/consent policy with representative exports.
2. Reconcile source and destination counts, explicit IDs, exact amounts/classifications/allocations, parent/commitment/document links and bytes. Unknown facts remain unknown; do not invent awards, dates, fulfillment or consent.
3. Execute trial, governed delta and final rehearsals with approved freeze/export timing. Define cutoff ownership and how late source corrections are detected and resolved.
4. Validate operational reports, July–June fiscal overrides and original-date cutoffs with migrated examples; distinguish commitments, fees, noncash and posted receipts.
5. Rehearse complete recovery at representative volume with private objects and separately held keys. Verify retained history, permissions and disposed-data suppression.
6. Obtain named sign-off on reconciliation, exclusions/unresolved exceptions, service access and support. Tests and screens do not substitute for source custody or acceptance.

## Next engineering slices

Build source-specific mappings from actual approved exports before selecting bulk defaults. Campaign source links, strictly mapped contacts and explicitly shared dated Logged interactions now have bounded contracts. Next slices include grants/pledges/commitments and financial history, restricted/original-actor interaction history, volunteer time, event ledgers and private source-file/document custody. Each needs a dedicated historical-import contract rather than reuse of today's action endpoint. Preserve original actors/dates, version relationships, replay/source uniqueness and audit atomically. Financial voids/corrections, fulfillment and privacy disposition require especially explicit policy and source evidence.

The current pass shares declarative mapping fields/required fields/limits between the screen and server and indexes preview duplicate checks. It does not increase the 500-row bound, remove the whole-workspace dependency fingerprint, eliminate core write validation, convert unsupported histories or establish customer-volume performance. Those remain separately tracked work.

## Connected-history checkpoint

The latest bounded extension passes 504 tests and synthetic five-file browser commit/replay. See CONNECTED-HISTORY-CONVERSION.md for exact fields, exclusions and financial cutoff verification. This supersedes earlier review notes listing campaigns, contact arrays and all interactions as unsupported; those notes remain historical analysis. The complete ten-year conversion criterion remains partial.
