# Wimblo restricted event-helper release

September 13, 2026. This replaces the proposed helper scope with a tested local implementation. It does not claim buyer acceptance or production deployment.

## Implemented

An optional `event-helper` account opens a dedicated Wimblo check-in workspace. It starts with zero assigned events. Administrators explicitly replace assignments with a current account version and a reason; every replacement increments that version, retains immutable before/after history, and revokes the target's sessions and pending MFA challenges. Role changes and suspension retire assignments; later reactivation does not silently restore them. Retained assignment history prevents destructive event deletion.

Helpers see only assigned event name/date/location and issued-ticket attendee name, ticket reference, current revision and attendance time. They can check in those tickets. They cannot browse constituent profiles, contact details, financial records, exports, reports, intelligence, registrations, seating, cancellation, payment or reversal functions. A guard before business modules denies other helper routes, including implicit HEAD requests. Current tenant/account/session and assignment authorization are checked again in the mutation transaction.

Check-in shares native ticket/registration/event attendance, versions, transition history and audit. Stale rosters fail conservatively. The interface refreshes attendance after an interrupted response and requires review; it never automatically repeats the mutation or displays optimistic success. Page-scoped search is clearly labeled and rosters paginate in groups of at most 100.

Own-account authenticator access follows existing server key policy. Helpers have optional MFA, not inferred mandatory MFA or SSO. The browser fixture intentionally had no MFA encryption key and correctly showed setup unavailable. Production administrator enrollment policy remains separate.

Pending full-workspace responses cannot repopulate authenticated state after sign-out, session expiry or account-security reauthentication: session generations fence both initial loading and editor refresh.

## Verification

The final integrated suite passed **531/531 tests**, zero failures/cancellations/skips, in **26.62 seconds**. The production bundle built in **2.07 seconds**; main bundle 489.72 kB. Focused backend tests include route denial, poisoned-field disclosure, assignment lifecycle, stale writes, CSRF, tenant isolation, immutable history and full native recovery of the new tables. Frontend tests cover helper-only loading, enrollment restrictions, zero assignments, pending-action locks and interrupted-response refresh without replay.

An isolated synthetic browser fixture passed: one assigned event and two issued tickets; Casey Arrival check-in saved and survived roster refresh; Morgan's unchecked ticket remained actionable. An ordinary gifts deep link returned to the restricted helper landing page. A second unassigned helper saw zero events and an explanatory guide. Own-security status loaded without business data. A 390×844 phone viewport showed readable, wrapped ticket references and controls; the override was reset. No captured browser warnings/errors. No real contact, money, provider delivery or production account was used.

## Remaining scope

A8.3 remains **Partial**. Assigned-ticket check-in is one optional helper duty; it does not implement unrestricted board entry or establish the offered no-extra-cost terms, six-user buyer acceptance or their chosen permissions. Staff/viewer business reads remain broad. New retained helper-access history also needs approved retention/exit treatment and complete business-field reporting coverage. No school restriction is inferred from the RFP.

The complete inventory remains **46 local basic / 24 partial / 11 missing / 3 external evidence = 84**, with no criterion marked accepted by the buyer. Hosted deployment, operating recovery/key custody, external integrations, approved institutional policy and qualification evidence remain separate work. Render deployment remains deferred by the owner.
