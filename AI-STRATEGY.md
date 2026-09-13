# Wimblo intelligence strategy

Status: bounded local implementation and future delivery plan, September 13, 2026. Intelligence now exposes deterministic saved-record priorities and policy-gated workflow help, constituent summaries and reviewed thank-you drafts through server/ai.js. An actual static-help request through the locally signed-in Ollama service using gpt-oss:120b-cloud returned HTTP 200 in 1,414ms. This proves connectivity, not factual accuracy: that output included unsupported workflow wording, which led to explicit approved control/workflow facts and regression guards against unsupported sending or Submit instructions; factual correctness still requires user review. Model assistance is synthetic-only; no real restricted data, autonomous writes, sending, receipt issuance, production AI deployment or subscription billing is claimed. Detailed current boundaries are in PLATFORM-AND-INTELLIGENCE-STATUS.md.

## Product direction

Intelligence should help users understand their work and choose their next action within existing screens. Wimblo owns business logic, permissions and authoritative financial calculations. Ollama supplies language-model inference behind a replaceable provider adapter. It is not a second authority or an automatic self-training system.

### Layer 1: application intelligence

Extend existing rules with explainable priorities: overdue pledges, outstanding acknowledgments, missing record fields, shift vacancies and impending deadlines. Calculate totals, dates and constraint checks in the application. Display the reason and linked evidence for each item. Preferences and explicit feedback may personalize ordering within the user's permission scope; they never alter facts or access rights.

### Layer 2: Ollama assistance

Retrieve only authorized, necessary data and approved help content. Provide this evidence to a selected Ollama model to summarize, explain or draft. Include source record links, filter/date scope and freshness; say when evidence is missing. Do not describe heuristic priority as a calibrated prediction.

### Layer 3: controlled action proposals

Later, let the assistant prepare a task or communication draft for preview. An authorized user confirms the exact proposed change. Execute through existing validated APIs with role checks, CSRF protection, version checks and audit attribution. Never execute model-generated SQL or arbitrary tools; never automatically post/void gifts, merge people, change account access, send messages or process payments.

## Capability placement and initial acceptance

| Screen | Assistance | Acceptance before release |
|---|---|---|
| Dashboard | Explain a metric/change; concise daily brief | All amounts computed by application; date/filter scope visible; sources linked; missing evidence acknowledged |
| Operations | Explainable next-action queue | Contact opt-outs respected; commitments distinct from receipts; known rules work without the model |
| Constituent detail | Relationship/history summary and meeting brief | Only permitted fields; no invented interactions, donation intent or sensitive profiling |
| Communications / Stewardship | Draft a thank-you from approved record facts | Preview/edit required; contact policy enforced; no send or tax-receipt implication |
| Reports | Natural-language questions mapped to approved reports/filters | Authorized report tools only; exact computed amounts; no arbitrary SQL; unsupported query explained |
| Import / identity review | Suggest CSV mappings and potential duplicates | Preview; normal validation; no inferred missing financial values or automatic merge |
| Contextual help | Explain a screen and next steps | Approved documentation; current route context; no claim unavailable capabilities exist |

## Deployment path

User browser → authenticated Wimblo API → permission-filtered retrieval and deterministic tools → AI policy/provider adapter → Ollama → validated response → contextual Wimblo panel.

Current backend is Express; the same boundary can be implemented in a future ASP.NET Core service. Neither migration nor a hosted AI service has been performed.

For a Cloud subscription, use Ollama's direct HTTPS API from the backend; keep OLLAMA_API_KEY server-side, never in VITE variables or frontend bundles. Model and endpoint selection are server-configured and allowlisted. Verify the account's available models and limits before benchmarking.

For private inference, use a dedicated secured Ollama host sized for the model. It must remain reachable independently of Zack's laptop and must not expose the unauthenticated local Ollama interface publicly. Local-only inference and Cloud inference have different data flows. Do not treat a Cloud model routed through a local Ollama client as local processing.

Ollama currently documents native structured outputs for local inference, but not Cloud. Independently validate all proposed tool arguments and responses; reject malformed or unauthorized proposals, bound retries and fall back to the ordinary interface. Tool support must be tested for the chosen model.

## Data and operational contract

Close existing school/program/field/read-scope gaps before enabling assistance on real restricted records. Filter before model submission and before output display; a browser-hidden record is not a permission boundary. Separate organization indexes, caches, saved conversations and retrieval scope. Treat imports, notes and retrieved documents as untrusted content, never assistant instructions.

Start with synthetic data. Before institutional Cloud use, verify approved processor terms, actual processing/logging/backups locations, applicable residency obligations, retention and subprocessors. Ollama's no-training policy does not independently establish customer approval or geographic compliance. Minimize/redact personal fields; omit credentials and unnecessary student/employee details. Store minimal execution metadata rather than raw private prompts in general logs. Permission changes must invalidate scoped context/caches. Document any saved AI conversation retention and deletion lifecycle.

Apply per-user limits, bounded input/output, cancellation, timeouts and cost controls. Record provider/model/prompt version, tool/action provenance and the confirming actor. Label generated text and estimates. Keep application workflows usable when AI is disabled, unavailable or rejects a response.

Feedback is explicit accept/edit/reject with optional reasons. Begin with controlled rule/preference tuning. Any future learned predictor needs enough appropriate historical data, offline evaluation and monitored release approval; no automatic model retraining or self-modifying business logic is promised.

## Delivery order

1. Define identity/permission scope and allowed evidence; build synthetic evaluation cases and the provider boundary.
2. Deliver contextual help, constituent summaries and editable acknowledgment drafts.
3. Deliver approved-report natural-language querying and explainable Operations priorities.
4. Add reviewed task/draft creation; consider prediction only after appropriate data and evidence exist.

Release evaluation covers factual/source accuracy, exact financial totals, unsupported questions, opt-outs, role/scope denial, injected document instructions, stale records, malformed proposals, provider outage, latency and spending limits. A successful chat response is not evidence of product readiness.

## Primary sources checked

- Ollama Cloud and direct authenticated API: https://docs.ollama.com/cloud
- Ollama tool calling: https://docs.ollama.com/capabilities/tool-calling
- Structured-output support and Cloud limitation: https://docs.ollama.com/capabilities/structured-outputs
- Privacy policy: https://ollama.com/privacy

