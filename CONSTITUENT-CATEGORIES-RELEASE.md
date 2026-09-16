# Wimblo — overlapping constituent categories

September 13, 2026. **982/982 tests pass**, zero failures/skips (73.688456s). Final build passes (1.24s). Local working source, not a hosted production release.

One person can now be an Individual, Alumni, Employee and Staff member while retaining one constituent ID, one gift history and linked volunteer activity. Organizations can carry compatible Business/Foundation/Community partner categories. A primary category stays explicit; additional categories are canonical and cannot mix a person with an organization.

## Completed and verified

- Native create/edit, save/reopen, directory search/filter and CSV preserve primary and additional categories. The editor retains incompatible existing choices visibly and requires deliberate removal before a primary-category change can save.
- Normalized migration accepts an optional JSON additionalTypes cell, rejects duplicate/unknown/incompatible categories atomically, preserves omitted legacy source fingerprints and supports committed replay/restart. An explicit new mapping cannot silently rewrite an existing source mapping.
- Annual employee receipts and statements recognize Employee membership beyond the primary category. Only actual posted payroll Employee giving enters the annual amount. Removing Employee blocks a pending stale issue/finalization; issued originals and financial records remain unchanged.
- Audiences match any category once, retain contact preferences and opt-outs, and invalidate stale reviewed membership. Categories grant neither account permissions nor marketing consent. Existing workflow/source digests pin changes without sending.
- Compatible identity merges keep the target primary, combine categories canonically, retain original source aliases and conserve exact cents. All 49 primary-category pair previews test physical-family boundaries; acknowledged/protected financial history remains guarded. Household and volunteer eligibility stays person-only.
- Custom reports expose all categories and numeric Employee/Staff/Alumni membership indicators (1=yes, 0=no) without multiplying identity or financial rows. Corrupt saved membership fails closed.

## Evidence and limits

Two independent specialists checked backend business/financial safeguards and identity behavior; root connected migration, reports and UI. The final full suite includes eight new backend cases, five identity cases, ten migration cases, six reporting cases and seven UI cases; focused regression runs overlap that suite and are not additive.

Built Chromium journeys passed at 1440×1000 and 390×844 using bundled Playwright because the browser plugin was absent: create/select all three additional categories, save, reopen one profile, single-identity report, and mobile additional-category directory filter. No page exceptions or mobile horizontal overflow. The current 4346 preview was restarted with its retained synthetic database and verified to show the new controls.

Source manifest: `80948d48f59f8b365e1b632446b0730b96dcec813ed7f35bc294dee4b76df915`. See CONSTITUENT-CATEGORIES-VERIFICATION.json; 946/918/896/835 evidence files remain historical checkpoints and were not overwritten. Browser evidence is in the sibling Wimblo-constituent-category-evidence directory.

A1.2 is **Local** after its fictional staff/employee donor-plus-volunteer scenario passes; **0 buyer accepted**. Current inventory: **47 Local / 32 Partial / 2 Missing / 3 Evidence required**, 84 total. This is neither a percentage of product completion nor a predicted RFP score.

Still open: A1.1 universal protected-history resolution; live email/bulk lifecycle/SMS; public payment/recurrence/self-service operations; actual buyer migration/acceptance; durable hosting and approved country custody/off-host recovery/monitoring; institutional training/support/incident commitments and commercial/eligibility evidence. Local tests do not certify production or superiority over established platforms. Render and eligibility discussion remain deferred.
