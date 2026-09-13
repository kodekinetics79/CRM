import React from 'react';
import { BookOpen, CheckCircle2, ShieldCheck, Map } from 'lucide-react';

const workflows = [
  ['Constituents and stewardship', 'Create people and organizations, household labels, parent relationships, additional contacts, segments and preferences. Open a constituent to review its recorded gifts and interactions.'],
  ['Gifts and designations', 'Record a gift, split its value across school or classroom funds, link a campaign, and track tribute or soft-credit information. Void a gift with a reason while preserving its record. Monetary and in-kind value are distinguished.'],
  ['Pledge schedules and fulfillment', 'Create monthly, quarterly or annual installments. Link actual monetary gifts to the pledge and review received, balance and overdue amounts. Receipts apply to the oldest installments; voids release fulfillment. Commitments never become received income.'],
  ['CSV imports and reports', 'Download the gift sample, match existing donor emails and designation codes, validate and preview, then confirm the batch. Review donor, designation, ledger, first-time donor, follow-up and pledge-balance reports. Save shared filter views, export CSV or open the print/PDF dialog.'],
  ['Recognition and rollups', 'Compare direct and soft monetary recognition with noncash value. Organization rollups include descendants; households use shared labels. Each gift counts once per group with direct precedence, but different groups may recognize the same gift. Do not add overlapping recognition as received income.'],
  ['Grants and volunteer time', 'Separate grant requests, recorded awards and linked matching-funder receipts. Inspect award balances and retain unknown legacy awards without inventing a commitment. Link volunteers to constituents/events and clock completed intervals into a dated ledger. Historical hours remain undated and separate. Correct hours with a reason while preserving original hours, dates and an audit trail.'],
  ['Manual completed acknowledgments', 'Use Stewardship to review eligible unacknowledged gifts and record an action already completed by staff. The gift links to a Logged donor interaction. Opt-out, voided gifts, fees and duplicate acknowledgments are blocked. This sends no message and issues no tax receipt.'],
  ['Events and tasks', 'Manage capacity, register constituents, record seating labels, check guests in and cancel registrations. Assign follow-up tasks, link them to constituents or events, and mark work completed.'],
  ['Drafts and access', 'Save unsent communication drafts or logged conversations, with local name/email/date previews. Administrators manage users, preferences, audit history and review snapshots; staff edit ordinary records and viewers review them.'],
];

const reviewSteps = [
  'Create a fictional constituent and an additional contact. Save, reload, and verify the record persists.',
  'Record a $100 gift split $60/$40 across two designations. Confirm that an allocation total of $90 cannot be saved.',
  'Import a sample gift using a unique external reference. Preview it before saving, then verify a repeated reference is rejected.',
  'Create a $1,200 pledge with twelve monthly installments. Link a $100 monetary gift, verify the balance is $1,100, then void the gift and verify the balance returns to $1,200.',
  'Use an eligible posted gift in Stewardship to record a fictional completed acknowledgment. Reload and verify its Completed entry and linked Logged donor interaction. No message is sent.',
  'Create a grant request, record an award amount/date, link a Grant receipt, and inspect the reconciled award balance; clock a volunteer in and out, register/check in an event guest, and complete an event-linked task.',
  'Correct a volunteer ledger entry with a reason. Verify original hours and timestamps remain visible, and dated/historical totals reconcile separately in Reports.',
  'Compare monetary/noncash and direct/soft-credit recognition, organization descendants and households. Save a shared report view, reload and apply it; sign in as the board viewer to confirm applying works while editing is unavailable.',
];

const roadmap = [
  {
    stage: 'Core nonprofit operations',
    capabilities: 'Provider-backed recurring collection, controlled constituent merges, volunteer shift reservations, approved real acknowledgment delivery/receipts, and arbitrary custom or scheduled reports beyond shared saved filters.',
    evidence: 'Failed charges do not become gifts. Merges preserve history. Grant values stay distinct. External delivery uses authorized providers and consent, while approved receipt policy remains separate from manual activity records.',
  },
  {
    stage: 'Verified migration and integrations',
    capabilities: 'Actual NonProfitEasy mapping and conversion, document/contract migration, source-specific payroll imports, Mailchimp synchronization, agreed Google/Microsoft workflows, and controlled integration APIs.',
    evidence: 'Approved mapping and trial migration reconcile counts and values. Duplicate runs are safe. Live connections have authorized accounts, scoped permissions, consent handling, and visible provider errors.',
  },
  {
    stage: 'Public participation and fundraising',
    capabilities: 'Donor and volunteer self-service, shift capacity and waitlists, online card/ACH giving, recurring collection, event ticketing, seating plans, auctions, peer-to-peer campaigns, and matching-gift workflows.',
    evidence: 'Capacity is enforced across simultaneous signups. Failed charges do not become gifts. Payment events are processed once, refunds reconcile, and fees, purchases, sponsorships and donations remain distinguishable.',
  },
  {
    stage: 'Production and institutional acceptance',
    capabilities: 'SSO/MFA, approved hosting and encryption, managed backups and recovery, security assessment, district privacy review, support ownership, training, accessibility and performance acceptance.',
    evidence: 'Test identity and permission boundaries, restore and reconcile a backup, verify hosting geography, obtain required institutional approvals, resolve security findings, and rehearse support and incident response.',
  },
];

export default function Guide() {
  return <div className="guide-page">
    <div className="page-header">
      <div><h1>Jordan Everbright evaluator guide</h1><p className="subtle">Review working foundation workflows and the evidence needed before real use.</p></div>
      <a className="btn btn-secondary" href="#guide-review"><BookOpen size={16} aria-hidden="true" /> Start the review</a>
    </div>

    <section className="panel" aria-labelledby="guide-scope">
      <h2 className="section-title" id="guide-scope"><CheckCircle2 size={18} aria-hidden="true" /> Working local workflows</h2>
      <p>Jordan Everbright is Kode Kinetics’ functional synthetic evaluator pilot tailored to Jordan Education Foundation. It is not an official district product or endorsement. Use fictional donors and amounts while reviewing; local changes persist.</p>
      <dl>{workflows.map(([title, detail]) => <div key={title}>
        <dt><strong>{title}</strong></dt><dd className="subtle">{detail}</dd>
      </div>)}</dl>
      <p className="subtle">Pledge schedules and linked receipt reconciliation are working records, not payment instructions. Recurring gift categories still do not trigger collection. Recognition overlap does not create income. Dated volunteer intervals are separated from historical hours with unknown dates.</p>
    </section>

    <section className="panel" aria-labelledby="guide-review">
      <h2 className="section-title" id="guide-review"><BookOpen size={18} aria-hidden="true" /> A practical review</h2>
      <ol>{reviewSteps.map(step => <li key={step}>{step}</li>)}</ol>
      <p className="subtle">Reports use the workspace fiscal start month; July is a demonstration default that must be confirmed. Donor follow-up considers either stale giving or stale logged contact and excludes “Do not contact.” Grant pipeline and Volunteer hours include all current records. Volunteer time ledger filters completed intervals by clock-in date/year and shows undated history separately. Pledge balances uses pledge start-date filters and an as-of date.</p>
      <p className="subtle">Communication previews remain unsent. A manually completed acknowledgment records staff activity with a linked Logged interaction; it is not provider-confirmed delivery or an issued tax receipt. A recorded payment method does not authorize, settle or reconcile a bank/processor transaction.</p>
    </section>

    <section className="panel" aria-labelledby="guide-readiness">
      <h2 className="section-title" id="guide-readiness"><ShieldCheck size={18} aria-hidden="true" /> Before operational use</h2>
      <p>Production readiness requires a separately reviewed implementation and acceptance plan.</p>
      <ul>
        <li>Approve hosting geography, HTTPS, encryption, access management, SSO/MFA requirements, backup protection and tested disaster recovery.</li>
        <li>Complete the district's Learn Platform review, signed data privacy agreement, iBoss compatibility checks and required security/privacy assessment.</li>
        <li>Map actual NonProfitEasy records, reconcile a trial migration, validate historical documents/contracts and rehearse cutover.</li>
        <li>Configure and test authorized Mailchimp, Google, Microsoft, Stripe and other agreed connections. No live external connection is configured in this pilot.</li>
        <li>Agree support ownership, service levels, training, maintenance and incident-response procedures.</li>
      </ul>
      <p className="subtle">The administrator snapshot is a review export, not a managed recovery backup. This pilot makes no FERPA, PCI, SOC 2, ISO 27001 or institutional-approval claim. It also does not replace the RFP's required relevant experience, three qualifying references or provider/reseller authorization.</p>
    </section>

    <section className="panel" aria-labelledby="guide-roadmap">
      <h2 className="section-title" id="guide-roadmap"><Map size={18} aria-hidden="true" /> Proposed extra and future capabilities</h2>
      <p className="subtle">These stages describe an implementation order, without release dates or delivery commitments. The capabilities below are future work beyond today's demonstrated workflows.</p>
      {roadmap.map((item, index) => <div key={item.stage}>
        <h3>{index + 1}. {item.stage}</h3>
        <p>{item.capabilities}</p>
        <p className="subtle"><strong>Acceptance evidence:</strong> {item.evidence}</p>
      </div>)}
      <h3>Later options</h3>
      <p className="subtle">Consider duplicate suggestions, donor-lapse scoring, trend exploration and staff-assistance tools after reliable data and permissions are established. Suggestions should show supporting records and require an authorized staff decision; predictions must remain distinct from recorded facts.</p>
    </section>
  </div>;
}
