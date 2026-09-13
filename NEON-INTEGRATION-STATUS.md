# Wimblo Neon access and integration status

September 13, 2026. Read-only owner inspection; no schema, records, credentials, identity settings or deployment were changed.

## Verified access

- Vercel account/team access succeeds. Project `wimblo` is configured with the Vite framework.
- Vercel production/preview variable metadata includes `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, PostgreSQL host/user/password variables, `NEON_PROJECT_ID`, `NEON_AUTH_BASE_URL` and `VITE_NEON_AUTH_URL`.
- Variable values were not printed, copied into source or written to an environment file. Metadata does not establish that the running application consumes these values.
- Neon account access succeeds. Project `wimblo` (`ancient-brook-87383598`) is in `aws-us-east-1`, with default branch `main` (`br-odd-fire-ava8ausd`). No secret connection string was requested.
- A read-only SQL query succeeds against `neondb`, reporting PostgreSQL `18.6 (2078fcb)`.
- Table inventory contains nine `neon_auth` tables and no CRM business tables. Existing Neon Auth tables were preserved without querying personal user/session data.
- The Vercel environment metadata was inspected without decrypting/validating connection-string values. Exact variable-to-branch mapping still needs a server-side connection check when wiring the application.

## Current application gap

The application's Express API uses `node:sqlite` and does not read `DATABASE_URL`. Its users/sessions are application-owned SQLite records, not Neon Auth accounts. React calls same-origin `/api` routes. Database attachment and environment-variable availability do not implement those routes, create CRM schema or translate the application to Postgres.

## Delivery approach

Use the existing Neon project as the candidate PostgreSQL destination for the proposed ASP.NET Core backend. Develop schema/conversion on an isolated Neon branch and verify existing business contracts before applying a reviewed migration. Preserve Neon Auth data; make an explicit choice between integrating its verified identity flow and the proposed ASP.NET Core Identity/institutional SSO flow. An authentication service is not the CRM's business API or its school/program authorization policy.

Configure the backend's database connection privately, verify the precise database/branch, implement and test schema/persistence and scoped API reads/mutations, then connect Vercel's `/api` routes to the hosted backend and verify login, permissions, save/reload and recovery. A .NET/PostgreSQL service needs its own deployment configuration; RENDER-SETUP.md currently describes Node/SQLite.

No additional database provisioning is necessary merely to inspect the available Wimblo database. No working CRM/Postgres integration, authenticated hosted journey or production acceptance is claimed yet.
