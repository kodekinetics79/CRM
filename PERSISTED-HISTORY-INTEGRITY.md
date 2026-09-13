# Wimblo persisted history integrity

September 13, 2026 · follow-on checkpoint after 997fa4a

Migration now compares saved business fields and resolved relationships against native-normalized validated values after every new record has been created. This catches changed contacts, campaign goals, conversation text or gift links that counts and financial grouping alone cannot detect. Contact and allocation order remains significant. New gift status/fiscal year and creation metadata are checked; unexpected lifecycle/provider fields reject. Reused records and retained source dependencies must still match their original hashes. Source mappings are derived from verified reloaded records.

Every check remains inside the existing transaction. A mismatch rejects the entire batch and rolls back records, source mappings, batch results and audit. Existing source fingerprints, legacy replay results, three-key count shapes, normalization and limits remain unchanged. This is a local persistence invariant, not a complete source-file custody or production assurance claim.

The final combined suite passed **508/508**, zero failures, cancellations or skips, in **18.81 seconds**. Build passed in **2.67 seconds**; main bundle 484.08 kB. Focused migration checks passed **45/45**. Four new tests exercise twelve post-save corruptions, later writes altering earlier records and reused/external mapped identities; rejected cases restore complete pre-import record/mapping/batch/audit snapshots. These are correctness tests, not customer-volume benchmarks.

Browser verification reused the previously imported synthetic constituent, designation and campaign, adding only one original-date **$10.01** gift and one historical Logged interaction. Reconciliation showed zero new records for the three reused types, exactly one new gift and interaction, and exact **$10.01** new allocation/value. The source classification and contact opt-out remained intact.

The report builder now explains that unfiltered gift values include future dates, fees and noncash, while scheduled date filters remain fixed. The result scope carries the same warning for API/report consumers. Browser source review retained all three campaign gift dates and values. A saved version-one report filtered by campaign, Cash type and date at most September 13, 2026 returned **$133.46**, with two matching source records and one grouped result; the future **$50.00** remained a recorded source value outside that cutoff. The native date control was verified through its keyboard segments; automated bulk filling did not commit its controlled value, so that attempt was not counted as passed. No captured browser warnings/errors occurred.

Migration error guidance now instructs the operator to correct the prepared conversion copy while preserving the original export. Source-row control totals explicitly distinguish future recorded gift value from currently raised money.

The 84-entry register remains **46 local basic / 24 partial / 11 missing / 3 external evidence required**, totaling 3,500 technical points. None is marked buyer-accepted. Full historical/entity/file conversion, approved optional helper duties/access, actual delivery/integrations, hosted recovery/key/retention operations, staffed services and qualification evidence remain open. Render remains deferred.

Architecture review specifies a separate default-deny assigned-event check-in helper workspace. It is proposed product scope, not an inferred requirement for school-level restrictions or evidence of no-extra-cost licensing. The existing Staff role is too broad for that duty; Viewer cannot enter attendance. See Wimblo-event-helper-access-plan.md for the next implementation contract and verification boundaries.
