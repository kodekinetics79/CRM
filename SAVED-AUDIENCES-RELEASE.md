# Wimblo saved audiences and correspondence

September 13, 2026. This is verified local product behavior, not buyer acceptance or a hosted deployment.

## Implemented

Staff and administrators can save versioned audiences using exact, case-sensitive, comma-separated segment tokens, Any/All segment matching, native constituent types and recorded contact preferences. Empty filter arrays impose no restriction. Creating a group never grants contact consent. Definitions retain immutable revisions; retirement requires a reason, is terminal and releases active-definition capacity. Maximum 200 active groups; the list shows 200 active-first definitions and detail shows the latest 100 revisions with the total revision count. Universal retired-history discovery is not claimed.

Current eligibility is calculated by the server. Merged identities and nonmatching profiles are excluded. Print follows existing do-not-contact exclusion; Email draft additionally requires Email preference and a valid primary email. Secondary contacts and profile tags never establish permission. Counts cover all current workspace profiles: matching means nonmerged criteria matches before format exclusions; excluded means total profiles minus eligible. Each excluded profile has one primary reason. Eligible pages contain at most 100 names, identifiers, preferences and source revisions.

The Letters & statements Messaging flow accepts only explicitly selected eligible recipients, at most 100. Its review pins audience revision, channel and a conservative digest of every current constituent record. Preparation and finalization revalidate the digest, current preferences, source records, template, organization wording and current actor/tenant/session authority inside the native transaction. Changing any corpus record invalidates an older audience review, including an unselected profile. Fresh review never automatically expands explicit selections. Other correspondence kinds and existing manual selections retain their previous contracts.

The interface keeps eligibility review and preparation separate, explains exclusions and page scope, resets selection on changed criteria/channel/page/template revision, and locks embedded controls during preparation. Inline keep/discard decisions protect unsaved criteria and clear dirty state after discard. Finalized wording and audience provenance remain retained; no messages are sent or gift acknowledgments completed automatically.

Curated reports expose saved definitions/revisions using the safe field alias `segmentLabels`, plus historical audience name/revision and selected-recipient count on correspondence preparations. They omit source corpus, digests, recipient email and selected IDs. Administrator-only curated helper assignment/access history is also available; ordinary staff/viewers cannot discover or run those sources. Existing credential filtering is unchanged.

## Verification

Final integrated suite: **554/554 passing**, zero failures/cancellations/skips, **20.79 seconds**. Build: **1.22 seconds**, main bundle **490.28 kB**. Independent tests found and verified a fix for suspended tenants preparing through the alternate correspondence route, and an in-transaction changed actor binding. Other coverage includes exact tokens, disjoint exclusion counts, Print/Email differences, strict roles/CSRF/tenant boundaries, stale definition/channel/corpus/consent, no automatic expansion, immutable retirement/history, rollback/restart and safe role-aware reporting. UI checks verify counts, digest-bound selection, page reset, pending-control locks and inline discard choices.

Synthetic browser: saved Annual donor review QA v1 from exact Annual donor tokens. **22 total / 16 matching / 15 eligible / 7 globally excluded**: six outside criteria, one matching do-not-contact profile. Explicitly selected Avery Collins and Quinn Anderson; exactly two Messaging documents prepared and finalized with their saved audience provenance and Not sent status. Saving template v2 reset the parent and child selection. Inline Keep editing preserved unsaved criteria; Discard returned to Manual with controls enabled. The 390×844 mobile eligible table and its container were both 320 pixels wide, without horizontal overflow; viewport reset. No actual contact delivery, money or external account was used.

## Remaining requirements

A7.2 remains Partial: saved local construction is implemented, but buyer-approved audience cases and authoritative provider audience/consent synchronization require separate evidence if connected marketing is offered. Sending, delivery/response tracking, workflow execution and provider integrations are not implied. B2 still requires accepted field coverage, scale and outputs. New retained audience/helper history requires approved institutional retention/exit policy.

Inventory remains **46 local basic / 24 partial / 11 missing / 3 external evidence = 84**; none accepted by the buyer. Qualification evidence, institutional conversion/custody, hosted operations and deferred Render deployment remain separate.
