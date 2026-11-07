# Backend Agent Guidelines

The `@anima/backend` package is the web server for Ànima.

## Overview

- **Framework**: Built with [Elysia](https://elysiajs.com) using the Node.js adapter (`@elysiajs/node`).
- **Runtime**: Runs as a Node.js process (Node 22+).
- **Core responsibilities**:
  - LLM orchestration using Vercel's AI SDK.
  - Solid POD authentication and proxying.
  - Managing an internal Community Solid Server (CSS) instance when running in managed POD mode.
  - Statically serving the frontend when bundled (`SERVE_FRONTEND=true`).

## MCP servers

The backend can load Model Context Protocol servers at boot and expose every tool they publish to chat models. Loading is controlled by environment variables:

- `ANIMA_MCP_ENABLED=false` disables all MCP loading at boot. Truthy values are `true`, `1`, `yes`; falsey are `false`, `0`, `no`.
- `ANIMA_MCP_CONFIG=/path/to/mcp.json` loads server definitions from a JSON file. Without it, the backend uses the built-in `cairn mcp stdio` server.
- `ANIMA_MCP_SERVERS=cairn,other` loads only the named servers from the config. Unknown names are rejected during resolution; the backend logs a warning and continues without MCP.

MCP is disabled by default for `E2E=true`, `EVALS=true`, and `NODE_ENV=test`; set `ANIMA_MCP_ENABLED=true` to override. An explicit `enabled` value in a config file also overrides the test/E2E default.

See `mcp.example.json` for the stdio shape. HTTP servers use `{ "type": "http", "url": "...", "headers": {...} }`. Tool names are exposed unchanged unless two servers publish the same name; then both are prefixed with `<server>__`.

The full catalogue is exposed; there is no tool allowlist. MCP tools are available only in backend mode, not the SPA runtime. The instructions from each MCP server are appended to the chat system prompt.

At chat time the backend also injects a compact catalogue of Cairn skills (name, description, activation and exact URI) into the system prompt, refreshed at most every 5 minutes. Bodies are never injected; the model calls load_skill on demand. The catalogue is only fetched when list_skills is available, failures are logged and ignored, and a refresh retains Cairn's list_skills audit event.

If the Cairn daemon is not signed in, its tools return Cairn's `authentication_required` result until `cairn login` is run; the backend does not store or forward Solid credentials.

When the backend runs inside proot on Android, proot's `$HOME` is `/root` while Cairn's broker descriptor lives in the Termux home. Start the backend with `CAIRN_HOME=/data/data/com.termux/files/home/.cairn`, or set `env.CAIRN_HOME` on the `cairn` server in `mcp.json`. Without it, the server still lists its tools, but authenticated calls return `authentication_required`.

## Endpoints

### Always Available

- **OIDC & Client ID** (`src/routes/oidc/index.ts`):
  - `GET /clientid.jsonld` — Solid OIDC Client ID document.
  - `GET /oidc/redirect` — OIDC login callback.
  - `GET /oidc/logout` — OIDC post-logout callback.
- **API Auth** (`src/routes/api/auth.ts`):
  - `GET /api/auth/session` — Get current user session profile.
  - `POST /api/auth/login` — Log in with `{ oidcIssuer }` (external POD, returns a `redirectUrl`) or `{ email, password }` (managed POD only).
  - `POST /api/auth/signup` — Create a managed POD account (managed POD only).
  - `POST /api/auth/logout` — Terminate session.
  - `POST /api/auth/proxy` — Authenticated Solid fetch proxy.
- **AI Endpoints** (`src/routes/api/ai/index.ts`) _(requires active session)_:
  - `GET /api/ai/providers`, `POST /api/ai/providers`, `DELETE /api/ai/providers/:name` — Manage AI providers.
  - `GET /api/ai/models`, `POST /api/ai/models`, `DELETE /api/ai/models/:id` — Manage AI models.
  - `GET /api/ai/chats`, `POST /api/ai/chats/:url/messages` — List chats and stream chat messages.

### Managed POD (`MANAGED_POD=true`)

_Endpoints return `404` when managed POD is disabled._

- **Authorization of third-party apps** (`src/routes/api/pod/authorize.ts`):
  - CSS sends browsers straight to the frontend's `/authorize/` page. The request in progress is identified by CSS's interaction cookies, which the proxy scopes to `/api/pod/authorize`.
  - `GET /api/pod/authorize` — Get the pending authorization request (prompt, client, login status).
  - `POST /api/pod/authorize/login` — Log in to the POD using the current session.
  - `POST /api/pod/authorize/consent`, `POST /api/pod/authorize/cancel` — Grant or deny access.
  - All of them return the `location` the browser should go to next.
- **POD Proxy** (`src/routes/pod/index.ts`):
  - `GET /pod/` — Frontend's POD home page (the POD root is meant for browsers, not RDF clients). Page loads are served directly when `SERVE_FRONTEND=true` and redirected to the frontend dev server otherwise; other requests (e.g. apps fetching RDF) get `404`. Other methods return `405`, except `OPTIONS`.
  - `ALL /pod/.account/*` — Blocked with `403` (the account API is only used internally).
  - `/pod/.well-known/css/*`, `/pod/favicon.ico` — Blocked with `404` (CSS's own static files, unused since pages are served by the frontend).
  - `ALL /pod/*` — Proxies requests to the internal CSS instance, which listens on a private socket and uses `/pod/` as its base URL.
- **POD discovery** (`getOpenIdConfiguration` in `src/routes/pod/index.ts`):
  - `GET /.well-known/openid-configuration` — The POD's OIDC configuration, also served at the root because some apps look for it there.
- **CSS configs** (stored in `~/.anima`, or `~/.anima-dev` in development):
  - `css-storage.json` — Main config, including where each POD is stored (created on first start).
  - `css-interaction.json` — Sends authorization requests to the frontend's `/authorize/` page (rewritten on every start).

### E2E Testing (`E2E=true`)

_Route not mounted unless `E2E=true` is set._

- **E2E Reset** (`src/routes/e2e/index.ts`):
  - `POST /__e2e__/reset` — Resets sessions, restarts CSS, and resets AI models/providers.

### Static Frontend (`SERVE_FRONTEND=true`)

_Route not mounted unless `SERVE_FRONTEND=true` is set; registered after all API routes._

- **SPA Assets** (`src/routes/frontend/index.ts`):
  - `GET /*` — Serves static assets from `public/` or falls back to `index.html`.
