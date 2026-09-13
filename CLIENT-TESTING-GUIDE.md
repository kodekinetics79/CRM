# Jordan Everbright — client testing guide

Use this local evaluator to review nonprofit fundraising workflows and record your observations. Jordan Everbright is Kode Kinetics' synthetic application tailored to Jordan Education Foundation; it is not an official district product or endorsement.

Use fictional names, example-domain emails and sample amounts. Recording a gift does not move money, and recording a communication does not send a message. Work at your own pace; the application suggests about 50 minutes for the eleven scenarios, but that is a planning estimate.

## Start the shared evaluator

Your computer needs **Node.js 24 or newer** and npm. If these are unfamiliar, ask your IT contact to help with this initial setup. No database service or separate development browser/server is required.

1. Extract the shared application archive to a folder on your computer.
2. Open a terminal in that extracted application folder. To check the prerequisite, run `node --version`; it must begin with `v24` or a higher major version.
3. Run these two commands, waiting for the first to finish:

```sh
npm ci
npm run evaluate
```

4. Leave that terminal open and visit [the local evaluator](http://127.0.0.1:4321) in your browser. The same running process serves the application and its data service. It is available only on this computer.
5. When finished, press **Control+C** in the terminal. Your changes and saved test results remain available the next time you run `npm run evaluate` from the same folder.

The shared archive includes the built application. If the launcher says the built app is missing, run `npm run build`, then `npm run evaluate`. If port 4321 is already in use, stop the other evaluator terminal or ask your IT contact to select another local port; do not change the host to expose the demo to a network. The launcher deliberately rejects production mode and nonlocal hosting/origins.

## Sign in

All three local demo accounts use **`FoundationDemo!2026`**:

| Account | Email | Review purpose |
|---|---|---|
| Administrator | `alex@foundation.example` | Full review, user/preferences administration and snapshot export |
| Foundation staff | `staff@foundation.example` | Everyday record entry and operational workflows |
| Board viewer | `board@foundation.example` | Read-only business records/reports; may submit test feedback |

Start with the administrator or staff account. Use the board account for scenario 9. These shared passwords are for synthetic local evaluation only.

## Use Client testing

Choose **Client testing** in the application navigation. Select a scenario and read its steps and Expected outcome. Choose **Open workspace** to perform the task, then return to Client testing to record what happened.

Use your name in Tester. Select Test result and Finding severity, enter an Observed outcome, and add Reproduction steps / record reference plus Additional test notes as useful. A finding or blocked test requires reproduction information. Choose **Save test result**, then **Review recorded results** to inspect saved observations.

- **Passed:** the expected behavior occurred, including correct rejection of a deliberately invalid operation. An expected validation error is a pass for that guard.
- **Needs attention:** the workflow ran but differed from the expected result. State the difference and how to reproduce it.
- **Blocked:** you could not complete the test. Record the blocker and what you attempted; a blocked test is not a pass.

Results are manually entered observations, not automated certification. Saved observations are shared inside this local workspace. Separate client installations do not automatically synchronize results.

## Nine self-guided situations

### 1. Trace a gift to its funds

Create or select a fictional donor and record a $100 Cash gift. Split $60 to STEM and $40 to arts using existing designations. First try allocations totaling $90, then restore the complete $100 and save. Use a unique fictional external reference.

**Expected:** the incomplete allocation cannot save; the complete gift and allocations each total $100. Open the donor's history, reload, and compare the Gift ledger CSV. No funds are collected.

### 2. Reconcile a pledge commitment

Create a $1,200 monthly pledge with twelve installments for a fictional donor. Record a $100 monetary gift for that same donor and select Linked pledge. Inspect the schedule and try a receipt greater than the remaining commitment.

**Expected:** twelve $100 installments total $1,200; the linked receipt fulfills $100 and leaves $1,100 outstanding. An excessive receipt is rejected. The commitment never becomes received contributions merely because it exists.

### 3. Recognize supporters without double counting

Assign fictional constituents to a household or parent organization, then record a gift with a different soft-credit constituent. Compare Soft-credit recognition, Household rollup and Organization rollup using the same date filters.

**Expected:** direct/soft attribution and monetary/noncash value stay distinct. Each gift counts once within a group. Parent/subsidiary and other recognition groups may overlap; do not add every report row together as income.

### 4. Separate request, award and receipts

Create a $25,000 request with a named synthetic funder. Record a $15,000 award, award date and Awarded stage. Create a $5,000 Grant revenue gift from that funder and select Linked grant award. Inspect reconciliation and linked history, then try a wrong-funder or over-award receipt.

**Expected:** requested $25,000, recorded award $15,000, recorded receipts $5,000 and unreceived award $10,000 remain separate. Invalid linked receipts save nothing. Older awards without verified amounts remain explicitly unknown rather than being inferred from request values.

### 5. Review dated volunteer time

Open a volunteer, clock in, then clock out. Compare the completed interval with separately labeled undated historical hours. Correct interval hours with a reason and reload.

**Expected:** the dated interval and historical totals remain distinct. The correction retains original hours/dates and reason, and the total reconciles. A short test shift may round to 0.00 hours on screen; check the recorded interval before reporting a defect. A person cannot clock into two volunteer records simultaneously. Date filters use the recorded start date in UTC, not invented dates for history.

### 6. Register and admit a guest

Open a synthetic event, register a constituent with a table/seat label, and check that guest in. Reload. Confirm already registered guests are omitted from the picker and registration is disabled when capacity is full; cancel a registration to reopen a slot if needed.

**Expected:** registration, seating label and check-in persist. Duplicate registrations/capacity overflow are prevented. Recording a ticket price does not collect payment.

### 7. Record a completed thank-you

In Stewardship, select an eligible unacknowledged gift and record a fictional completed Phone action with notes. Review Completed stewardship and the linked interaction. Confirm do-not-contact recipients are excluded and the same gift cannot be acknowledged again.

**Expected:** the saved action leaves Pending, appears in Completed and links to a Logged interaction. No message is sent and no approved tax receipt is issued. Record an action only as a fictional completed evaluator action.

### 8. Reuse a team report view

Choose a report and applicable date/year filters, then save a named workspace view. Change reports, reapply the view and reload. Export the selected report and compare its rows/totals.

**Expected:** saved filters survive reload and are readable by the board role. CSV reflects the selected report. Saved views do not schedule deliveries; historical volunteer totals and non-date-filtered reports have explicitly different scopes.

### 9. Verify board access and keyboard use

Sign out and use the board account. Browse records/reports; confirm business creation/editing and Settings are unavailable. Open Client testing and save a result. Use **Command+K** on Mac or **Control+K** elsewhere to focus search, then Tab through controls. Return to staff/admin and try **C** outside a text input on a page that supports creation.

**Expected:** board access is read-only for business records, with permission to submit feedback. Board users cannot edit/delete feedback. Search and creation shortcuts respect access/page context, and keyboard focus is visible. Note any difficult keyboard or narrow-screen interaction as a finding.

## Share findings and triage them

In Client testing, choose **Results CSV** for a spreadsheet-friendly report or **Results JSON** for the complete recorded feedback package. Both export all observations in this local workspace. Keep the exported files and share them through your team's agreed review channel. No file is automatically sent by the application.

Use a synthetic record reference or unique external reference in reproduction steps. If attaching a screenshot through your review channel, keep it limited to fictional data. Suggested severity:

| Severity | When to use it |
|---|---|
| High | Incorrect financial totals, unauthorized data/write access, loss of saved records, or a core workflow that cannot proceed |
| Medium | A workflow is disrupted but has a usable workaround, confusing validation, or an export/filter mismatch |
| Low | Layout, wording, keyboard convenience or another presentation issue that does not change records/totals/access |

Include what you expected, what actually happened, the account/role used, steps, record reference, browser, and whether the issue repeats after reload. After a fix, save a new observation for the same scenario to record the retest; preserve earlier findings.

## Optional fresh evaluation without deleting work

The default evaluator uses `server/data/evaluator.sqlite`; the original development pilot uses `server/data/foundation.sqlite`. Keep these separate files to preserve their records and feedback. To start another clean round, stop the evaluator and ask your IT contact to launch it with `DB_PATH` pointing to a **new, unused** SQLite file. Do not delete the original database or guess which files to remove.

For example, from the application folder on macOS/Linux:

```sh
DB_PATH=./server/data/evaluation-round-2.sqlite npm run evaluate
```

In Windows PowerShell:

```powershell
$env:DB_PATH = './server/data/evaluation-round-2.sqlite'
npm run evaluate
```

Use another unused filename for subsequent fresh rounds. Stop that session before returning to the default; in PowerShell remove the override with `Remove-Item Env:DB_PATH`, then run `npm run evaluate`. Previously recorded observations stay in their original workspace and do not appear in the new round unless separately exported for review.

## Scope limits

This evaluator is not production-ready or a complete RFP response. It does not establish required experience/references, provider/reseller authorization, institutional approval, iBoss verification, Learn Platform approval or a signed district DPA. Actual NonProfitEasy mapping/migration, live Mailchimp/Google/Microsoft/Stripe and other external connections, online payment settlement, recurring collection, email/SMS delivery, SSO/MFA, approved hosting/encryption, managed backup/recovery and operational security/support assurance remain separate work. No FERPA, PCI, SOC 2 or ISO certification claim is made.

## Additional journeys in release0.4.0

Open Operations → Volunteer shifts. Plan a one-place synthetic shift and reserve one person. Try another reservation to see the full-capacity message, then choose Waitlisted. Cancel the first place, observe preserved Cancelled history and available capacity, and explicitly reserve the waiting person's place. Reload, reopen the shift and verify the roster. Same-day times use the foundation's shared local scheduling timezone; no hours or messages are created.

In Operations → Work queue, filter/find a task and open its supporting record. Complete a fictional task and confirm it leaves the queue. Review grant reporting dates without assuming completion is tracked. In Data quality, review shared-email suggestions without automatically merging people.

As Administrator, open Settings → Workspace checks → Run workspace checks. Review the actual local-check time, record count and issues. Passed means the recorded constraints checked successfully, not that providers or institutional approval were verified. Board viewers can inspect operations and shifts but cannot reserve/edit or open administration.
