import React from 'react';
import {ArrowRight,ExternalLink,ClipboardCheck,BookOpen} from 'lucide-react';
import {RELEASE} from '../evaluationScenarios';

export default function About({onNavigate,acceptanceEnabled=false,demoAccess=false}) {
  return <article className="about-page">
    <div className="page-header"><div><h1>About Wimblo</h1><p>The people, work, and insight behind your workspace.</p></div><span className="release-label">{demoAccess?'Evaluator':'Release'} {RELEASE}</span></div>
    <section className="about-introduction" aria-labelledby="about-purpose">
      <div><h2 id="about-purpose">Bring the whole picture together.</h2><p>Relationships are more useful when their context comes with them. Wimblo connects people, giving, programs, and everyday work so your team can see what happened—and choose what comes next.</p><button className="btn btn-primary" onClick={()=>onNavigate('operations')}>Open your work queue<ArrowRight size={16}/></button></div>
      <figure><img src="/brand/wimblo-gather.png" width="260" height="260" alt="Wimblo’s Gather symbol: three joined pieces around one clear opening"/><figcaption>Separate pieces. One clear picture.</figcaption></figure>
    </section>
    <section className="about-connections" aria-labelledby="about-work"><h2 id="about-work">A workspace that keeps the context.</h2><dl>
      <div><dt>People & relationships</dt><dd>Open a constituent to find connected gifts, commitments, activity, volunteering, and event history.</dd></div>
      <div><dt>Giving & programs</dt><dd>Connect received gifts to funds, campaigns, pledges, and recorded grant awards. Keep plans distinct from actual receipts.</dd></div>
      <div><dt>Work & insight</dt><dd>Move from a work queue to its supporting record. Inspect saved activity, choose report filters, and export your findings.</dd></div>
    </dl></section>
    <div className="about-details">
      <section aria-labelledby="about-provider"><h2 id="about-provider">Made by Kode Kinetics.</h2><p>Wimblo is an application by <strong>Kode Kinetics LLC</strong>. The workspace connects foundation relationships, giving and programs.</p><a className="about-provider-link" href="https://www.kodekinetics.com" target="_blank" rel="noopener noreferrer">Visit Kode Kinetics<ExternalLink size={15}/><span className="sr-only"> (opens in a new tab)</span></a><p className="table-note">Connected work. Clear next steps.</p></section>
      <section aria-labelledby="about-evaluator"><h2 id="about-evaluator">Explore with confidence.</h2><p>{demoAccess?'This pilot uses synthetic data and saves changes locally.':'This release stores records through its application API.'} It records workflows; it does not send messages or process payments. Live integrations, migration, hosting, and institutional acceptance remain separate steps.</p>{acceptanceEnabled&&<div className="about-actions"><button className="btn btn-secondary" onClick={()=>onNavigate('testing')}><ClipboardCheck size={16}/>Start client testing</button><button className="text-btn" onClick={()=>onNavigate('guide')}><BookOpen size={16}/>Read the evaluator guide<ArrowRight size={15}/></button></div>}</section>
    </div>
    <footer className="about-footer"><span>Wimblo · {RELEASE}</span><span>Connected work. Clear next steps.</span></footer>
  </article>;
}
