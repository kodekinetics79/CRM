# Wimblo — Ollama backend configuration

## Direct cloud settings

Configure these secrets/settings on the backend service, not the Vercel browser bundle:

```
OLLAMA_BASE_URL=https://ollama.com
OLLAMA_MODEL=gpt-oss:120b
OLLAMA_API_KEY=<private Ollama API key>
```

Use Render's secret environment fields for the key. Never prefix it with VITE_ or NEXT_PUBLIC_. The existing start command remains `npm start`; these settings do not replace the required application origin, durable storage and production administrator configuration in RENDER-SETUP.md.

Ollama's direct API uses HTTPS bearer authentication; its direct model name differs from the local cloud-proxy example. [Official authentication documentation](https://docs.ollama.com/api/authentication), [official cloud documentation](https://docs.ollama.com/cloud).

## Local configuration and verification

The owner-provided key is saved only in ignored `.env.ollama.local`, mode 0600. Load it explicitly; the normal launcher does not automatically read environment files:

```
node --env-file=.env.ollama.local server/index.js
node --env-file=.env.ollama.local scripts/evaluate.mjs
```

September 13, 2026: direct provider authentication returned HTTP 200 and a complete text response. An actual logged-in Wimblo workflow-help request returned HTTP 200, generated text and reviewRequired=true, with zero donor source records. Both local servers report configured cloud processing. No secret value is included in this document, release archive, API status or browser response. Render/Vercel hosted configuration was not changed.

Tenant policy still controls enablement. Only synthetic-mode workspaces are eligible for bounded model assistance; restricted-mode workspaces remain denied even with a valid key. A synthetic policy label does not itself classify uploaded content. Model output cannot execute business actions, issue receipts, send messages or collect payments. Real customer information needs separately accepted data/subprocessor/residency policy before provider use.
