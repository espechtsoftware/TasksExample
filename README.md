# MCP Server Example: GCP Bearer Auth + Long-Running Tasks + MCP Apps

A learning project demonstrating three things on one small MCP server:

1. **Bearer-token security using Google (GCP) identity** — the GCP analog of
   protecting an API with Microsoft Entra ID. Streamable HTTP transport only
   (no stdio), and **no API key or anonymous fallback**: every MCP request
   must carry a valid Google-issued OIDC ID token.
2. **Long-running tasks** — the MCP Tasks *call-now / fetch-later* pattern: a
   tool call returns a task handle immediately, the client polls for status,
   and fetches the result when the work finishes.
3. **MCP Apps** — an interactive HTML dashboard (progress bars for the running
   tasks) that compliant hosts render in a sandboxed iframe, talking back to
   the server through the host over the same JSON-RPC audit path as normal
   tool calls.

```
┌─────────────┐   Authorization: Bearer <Google ID token (JWT)>
│  MCP host    │ ─────────────────────────────────────────────────┐
│ (Claude, …)  │                                                  ▼
│              │                              ┌──────────────────────────────┐
│ ┌──────────┐ │   tools/call, tasks/get, …   │  Express                     │
│ │ sandboxed│ │ ◄──────────────────────────► │   ├─ auth middleware (jose)  │
│ │  iframe  │ │      Streamable HTTP         │   │    verify sig ⇐ Google   │
│ │dashboard │ │        POST /mcp             │   │    JWKS + iss + aud      │
│ └────▲─────┘ │                              │   ├─ McpServer (per request) │
│      │ JSON- │                              │   │    generate_report (task)│
│      │  RPC  │                              │   │    list_report_tasks     │
│      │ post- │                              │   │    report_dashboard (app)│
│      │Message│                              │   └─ shared: TaskStore,      │
└──────┴───────┘                              │        ReportRegistry        │
                                              └──────────────────────────────┘
```

## Part 1 — Bearer auth: Google as the identity provider

If you know how an API protected by **Microsoft Entra ID** works, the mapping
is one-to-one. The server is a pure *resource server*: it never talks to the
IdP interactively, it just fetches public signing keys and verifies JWTs
locally.

| Concept                        | Entra ID                                          | Google (this project)                          |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------- |
| Token issuer (`iss`)           | `https://login.microsoftonline.com/{tenant}/v2.0` | `https://accounts.google.com`                  |
| Signing keys (JWKS)            | tenant's `discovery/v2.0/keys`                    | `https://www.googleapis.com/oauth2/v3/certs`   |
| Audience (`aud`)               | Application (client) ID                           | `GOOGLE_AUDIENCE` env var                      |
| Tenant restriction             | tenant ID in issuer                               | `GOOGLE_ALLOWED_DOMAIN` (the `hd` claim)       |
| User/app assignment            | app roles, user assignment                        | `GOOGLE_ALLOWED_EMAILS` allowlist              |
| How a service gets a token     | client credentials flow                           | service-account identity tokens                |
| How a human gets a token       | auth code flow / `az account get-access-token`    | `gcloud auth print-identity-token`             |

The interesting code is [`src/auth/google.ts`](src/auth/google.ts):

- `createGoogleTokenVerifier` — one `jwtVerify` call (via [jose](https://github.com/panva/jose))
  checks the signature against Google's remote JWKS **and** the `iss`, `aud`,
  and `exp` claims. Optional `hd`-domain and email-allowlist checks layer on top.
- `createGoogleAuthMiddleware` — the Express gate in front of `/mcp`. Failures
  answer `401`/`403` with a `WWW-Authenticate` header pointing at the RFC 9728
  protected-resource metadata; successes attach the verified identity to
  `req.auth`, which the MCP SDK forwards to every tool handler as
  `extra.authInfo` (the report tool records *who* requested it this way).
- `protectedResourceMetadata` — the one intentionally public document
  (`/.well-known/oauth-protected-resource/mcp`). The MCP authorization spec
  uses it so clients that get a 401 can discover *which* IdP protects the
  resource. Note: Google doesn't support RFC 7591 dynamic client registration,
  so clients obtain tokens out-of-band — the same operational model as most
  Entra-protected APIs, where the app registration exists up front.

### Getting a real token

```bash
# As yourself (audience is fixed to gcloud's own client ID — set GOOGLE_AUDIENCE
# to 32555940559.apps.googleusercontent.com for quick local experiments):
gcloud auth print-identity-token

# As a service account, minted for YOUR audience (the production pattern —
# the analog of Entra's client-credentials flow):
gcloud auth print-identity-token \
  --impersonate-service-account=my-sa@my-project.iam.gserviceaccount.com \
  --audiences="https://mcp.example.com/mcp"
```

Then call the server:

```bash
TOKEN=$(gcloud auth print-identity-token ...)
curl -sS http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

No token → `401` with a `WWW-Authenticate` challenge. Wrong audience → `401`.
Right token, wrong account → `403`. There is no other door.

## Part 2 — Long-running tasks (MCP Tasks)

MCP tool calls are traditionally synchronous: the HTTP request stays open
until the tool finishes. That breaks down for work that takes minutes. The
**Tasks** pattern (experimental in the SDK today; being finalized as an
official extension in the 2026-07-28 spec) splits it up:

```
client                                server
  │ tools/call generate_report          │
  │ ────────────────────────────────►   │  creates task, kicks off worker
  │ ◄──────────────────────────────── ─ │  { task: { taskId, status:"working" } }
  │                                     │       (returns immediately!)
  │ tasks/get {taskId}      (poll)      │
  │ ────────────────────────────────►   │
  │ ◄──────────────────────────────── ─ │  { status:"working", statusMessage:"Step 2/5: Analyzing data" }
  │          … repeat …                 │
  │ ◄──────────────────────────────── ─ │  { status:"completed" }
  │ tasks/result {taskId}               │
  │ ────────────────────────────────►   │
  │ ◄──────────────────────────────── ─ │  the finished CallToolResult
```

Where to look:

- [`src/mcp/server.ts`](src/mcp/server.ts) — `server.experimental.tasks.registerToolTask('generate_report', …)`
  with `execution: { taskSupport: 'required' }`, plus the **`tasks` capability
  declaration** in the server options (clients only send task-augmented calls
  to servers that declare it — forget this and every call silently runs the
  old way; the smoke test caught exactly that during development).
- [`src/mcp/reports.ts`](src/mcp/reports.ts) — the worker. It runs *after* the
  originating HTTP request has already been answered, publishes progress via
  `updateTaskStatus(…, statusMessage)`, checks for cooperative cancellation
  (`tasks/cancel`) between steps, and persists the final `CallToolResult` with
  `storeTaskResult`.
- The **`TaskStore`** is the load-bearing abstraction: this example uses the
  SDK's `InMemoryTaskStore`, shared across requests. In production you'd
  implement the same interface over Redis/Firestore so *any* replica can
  answer a poll — which is the point of the spec's move to stateless servers.

## Part 3 — MCP Apps (interactive UI)

MCP Apps ([SEP-1865](https://github.com/modelcontextprotocol/ext-apps)) lets a
tool declare an HTML view the host renders in a sandboxed iframe:

- The `report_dashboard` tool carries `_meta: { ui: { resourceUri: "ui://report-dashboard/view.html" } }`.
- That `ui://` resource is registered with MIME type `text/html;profile=mcp-app`
  and must be **fully self-contained** — the sandbox CSP blocks external
  scripts, so the build ([`scripts/build-ui.mjs`](scripts/build-ui.mjs))
  bundles the view code *and* the `@modelcontextprotocol/ext-apps` runtime
  into a single HTML file with esbuild.
- Inside the iframe ([`src/ui/dashboard.ts`](src/ui/dashboard.ts)), the `App`
  class speaks JSON-RPC to the host over `postMessage`. The host seeds it with
  the tool's result (`ontoolresult`), then the view polls `list_report_tasks`
  every 2 s via `app.callServerTool(…)` and renders live progress bars.

The security story is the part worth internalizing: the iframe never talks to
your server directly. Every `callServerTool` goes **through the host**, which
applies the same consent/audit path — and the same bearer token — as a
model-initiated tool call.

Try it end-to-end in a compliant host (Claude, VS Code, the `basic-host`
example from the ext-apps repo, or MCP Inspector): ask for a report, then ask
for the dashboard while it runs.

## Running it

```bash
npm install

# Required: the audience your callers mint tokens for
export GOOGLE_AUDIENCE="https://mcp.example.com/mcp"
# Optional hardening:
export GOOGLE_ALLOWED_DOMAIN="example.com"          # Workspace hd claim
export GOOGLE_ALLOWED_EMAILS="me@example.com,sa@my-project.iam.gserviceaccount.com"
# Optional: public URL used in discovery metadata (default http://localhost:3000)
export MCP_PUBLIC_URL="http://localhost:3000"

npm run dev      # build the UI bundle + start with tsx
# or
npm run build && npm start
```

### Smoke test (no GCP account needed)

```bash
npm run smoke
```

Boots the real server and drives it with the real MCP SDK client over
Streamable HTTP. The only substitution: tokens are signed with an ephemeral
local key pair injected through a test-only seam (`createApp`'s
`authOverrides`) — the production entrypoint always pins Google's JWKS. It
verifies the 401/403 gate, RFC 9728 discovery, the full task lifecycle
(handle → working → completed → result), cross-request task visibility,
identity propagation into tool results, and the self-contained Apps HTML.

## Project layout

```
src/
├── index.ts           HTTP entrypoint: stateless Streamable HTTP, auth gate, discovery endpoint
├── config.ts          Env config, with the Entra ↔ Google concept mapping
├── auth/google.ts     Token verifier + Express middleware + RFC 9728 metadata
├── mcp/server.ts      McpServer factory: task tool, app tool + ui:// resource, list tool
├── mcp/reports.ts     The long-running worker + progress registry
└── ui/
    ├── dashboard.html View template (inline CSS, script placeholder)
    └── dashboard.ts   Iframe-side App code (postMessage JSON-RPC to the host)
scripts/
├── build-ui.mjs       esbuild → single self-contained dist/ui/dashboard.html
└── smoke.ts           End-to-end test with locally-signed Google-shaped tokens
```

## Design notes & production checklist

- **Stateless by construction.** A fresh `McpServer` + transport per POST, no
  `Mcp-Session-Id` (`sessionIdGenerator: undefined`), `GET/DELETE /mcp` → 405.
  This matches where the spec is heading (the 2026-07-28 revision removes
  protocol-level sessions entirely) and means the server works behind a plain
  load balancer.
- **Swap the in-memory stores** (`InMemoryTaskStore`, `ReportRegistry`) for
  Redis/Firestore implementations before running more than one replica —
  the `TaskStore` interface is designed for exactly that.
- **On Cloud Run** you can put [IAP or built-in IAM invoker checks](https://cloud.google.com/run/docs/authenticating/service-to-service)
  in front and keep this middleware as defense-in-depth; the token format is
  the same Google ID token either way.
- **Tasks are experimental** in SDK 1.29 (`server.experimental.tasks`); the
  API will shift as the Tasks extension is finalized. The lifecycle concepts
  (handle, poll, result, cancel, TTL) carry over.

## Further reading

- [MCP specification](https://modelcontextprotocol.io/specification) — Streamable HTTP transport & authorization sections
- [MCP Tasks (SEP-1686)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) — the experimental tasks spec this SDK implements
- [MCP Apps (ext-apps repo)](https://github.com/modelcontextprotocol/ext-apps) — spec, SDK, and example servers
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) — OAuth 2.0 Protected Resource Metadata
- [Google ID token validation](https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken)
