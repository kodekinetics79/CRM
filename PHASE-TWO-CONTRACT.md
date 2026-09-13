# Phase two implementation contract

Product name: **Jordan Everbright**. Tailored workspace subtitle: **Jordan Education Foundation**. This is Kode Kinetics' synthetic evaluator application, not an official district product or endorsement. Preserve the existing School fund ledger visual world and code-first preference.

## Release scope

Add real pledge schedules and received-gift reconciliation, recognition reports, dated volunteer time entries, a manual stewardship queue, saved report views, and an improved responsive working interface. No live payments/email or production certification implied. Preserve all phase-one data and controls.

## Backend ownership and endpoints

Backend agent owns server/*.js only. All new collections included in /api/workspace data. Same authentication/CSRF/roles/version/audit controls. Collections:
- pledges: name,constituentId,amount integer cents>0,startDate YYYY-MM-DD,installments integer1..120,frequency Monthly|Quarterly|Annual,designationId nullable,campaignId nullable,status Active|Paused|Cancelled,notes. Generic create/PATCH/version/delete when unreferenced. Gift optional pledgeId nullable added; pledge reference text retained for legacy. Linked gifts must match donor, be monetary contributions (not fees/in-kind), and total posted linked receipts cannot exceed commitment. Editing pledge amount/donor must preserve valid receipts. Voids release fulfillment. No future commitments enter received dashboards.
- volunteerTime: generated dated ledger entries only: volunteerId,constituentId,eventId,startAt,endAt,hours,source Clock|Historical,notes, usual id/version/metadata. Generic create/PATCH/delete blocked. Clock-out appends interval atomically with hours update. Preserve existing hours as one Historical entry with start/end null, never claim a date. Prevent simultaneous clocks for same constituent across volunteer records. /api/volunteer-time/:id/correct POST {version,hours,reason} staff/admin, retains originalHours and correction reason in record/audit; no date invention.
- reportViews: shared workspace saved views name,filters object {report,start,end,type,schoolYear,excludeFees,inactiveDays}. Generic CRUD; strict allowable report names including new below. No scheduled delivery.
- POST /api/gifts/:id/acknowledge {version,date,channel Email|Phone|Meeting|Post,notes}: record manual completed action and create linked Logged communication atomically; acknowledgment {date,channel,notes,communicationId,at} server-controlled. Cannot act on voided/fee gifts; do-not-contact blocked. This does not send messages or issue receipts. Prevent duplicate acknowledgment.

Backend changes default organizationName Jordan Education Foundation and migrates old default 'Foundation CRM · Evaluator pilot' only, preserves custom settings. Add deterministic upgrade seed pledge for existing/fresh synthetic DB only if missing, no duplicate seed. Servername references Jordan Everbright. No edits to frontend/test/docs by backend agent.

## Frontend feature-agent ownership

Own src/features/Pledges.jsx, src/features/Reports.jsx, src/features/VolunteerLedger.jsx, src/phaseTwo.js only. Pledges props {data,onCreate,onOpen,canWrite}; list/open ordinary generic detail supported root. phaseTwo exports pledgeSchedule(pledge,gifts,asOf YYYY-MM-DD), recognitionReport(data,config), volunteerTimeReport(data,config). pledgeSchedule returns {received,balance,overdue,rows:[{date,amount,received,balance,status}]} integer-cent monthly clamped dates; distribute remainder to earliest installments. Receipt amounts applied chronologically to oldest installments; active commitment only overdue through asOf; never forecast as received. Recognition reports 'Soft-credit recognition','Organization rollup','Household rollup', distinguish direct/soft monetary and noncash, never doublecount pergroup, full descendant traversal cyclesafe. Shared report filters apply. Volunteer time report dated-only date/year filters, historical totals separately shown, correction values reconcile.
Reports props add onSaveView(view),onDeleteView(view),canWrite; savedviews UI applies filters, handlesvalidation; includes 'Pledge balances','Volunteer time ledger' new report names. Root adds schemafields/giftpledge picker and detail schedule/time section. VolunteerLedger props {volunteer,data,onCorrect,canWrite,notify} dated/historytable + inline correction reason/hours, no mutation of existing dates.

## Root ownership

Own App/schema/lib integration (no changes to phaseTwo.js), brand/shell/dashboard/Records/RecordDetail/GiftForm/Stewardship/CSS. Stewardship props data/onOpen/onAction/canWrite/notify, queue eligible posted gifts without acknowledgment, opt-out exclusion, exact manual completion action. Add pledges/stewardship nav, grouped navigation remains findable. URL routes/back behavior, keyboard/focus and responsive improvements. Update PRODUCT.md and docs when feature state verified.

## QA ownership

Test/consultant agent owns tests/phase-two.test.js, tests/phase-two-lib.test.js and PHASE-TWO-ACCEPTANCE.md only. Read contract and wait for files to land. Test real create/version/roles, pledge overfulfillment and edits, void reversals, schedule monthends/remainder, recognition dedup, history/dated time/corrections, optout/ackduplicates, savedviews, persistence upgrade. Reuse existing test style. No source edits. Root browser verifies meaningful happy/failure paths desktop/mobile; fresh finishreview afterward.
