# Wimblo live deployment review

September 13, 2026. Target: https://wimblo.vercel.app/. Read-only owner inspection; no cloud configuration changed.

## Observed result

- Browser renders `Workspace unavailable` and `The server returned an unreadable response.`
- Browser title is `Dashboard · Kinflect`; the public deployment does not display the current local Wimblo identity.
- `GET /api/health`, `GET /api/auth/me` and `GET /api/workspace` each return HTTP 404 with `text/plain` responses, not the application's JSON API.
- An authenticated saved-data journey could not begin. No login, mutation, persistence or hosted permission success is claimed.

The frontend is reachable. There is no functioning application API at the frontend's expected `/api` paths. This does not establish whether a backend exists at another hostname.

## Resolution for the current implementation

Publish the reviewed local Wimblo changes to the deployed Git branch. Establish the Node/Express service with its persistent database using RENDER-SETUP.md and verify its health/TLS/proxy configuration. If retaining Vercel for the interface, route `/api` to that service through an external rewrite and configure the backend's APP_ORIGIN to the exact Vercel browser origin. Preserve the same-origin browser cookie/CSRF flow and verify actual login, denied roles, save/reload and restart persistence. Broad credentialed cross-origin access is not a substitute for this design.

The actual backend service URL is needed before producing a correct concrete rewrite. A separate domain is not guessed. Alternatively, the current Express application can host its compiled interface and API together on Render, as documented. ASP.NET Core/PostgreSQL remains a proposed migration, not an existing backend to connect.

## Subsequent backend configuration correction

September 13, 2026: Render backend candidate identified as Wimblo_CRM at https://crm-xenz.onrender.com. Its previous Ruby/bundle install runtime/build and placeholder origin were corrected to Node/npm build, npm start, /api/health and https://wimblo.vercel.app. No new deployment launched; free/no-disk SQLite durability remains unresolved. Current source Vercel config prepares security headers only; same-origin API rewrite and durable backend integration remain pending. Previous public 404/unavailable observations remain scoped to their inspection time, not a fresh post-deployment result.
