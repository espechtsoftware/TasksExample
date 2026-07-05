# Model Training as a Product — an MCP Server Example

A learning project: a **paid model-training service** exposed as an MCP
server. Customers buy a training plan, upload a dataset, and a background
worker picks and fits the best scikit-learn / XGBoost model for their data —
delivered as a downloadable, deploy-ready artifact.

It demonstrates, on one small codebase:

1. **Bearer-token security using Google (GCP) identity** — the GCP analog of
   protecting an API with Microsoft Entra ID. Streamable HTTP transport only
   (no stdio), and **no API key or anonymous fallback**.
2. **Commerce on top of MCP** — purchasable tiers, entitlements, quotas, and
   every transaction logged to **Postgres**.
3. **Long-running tasks** — training runs as an MCP Task (*call-now /
   fetch-later*): the tool answers with a task handle, clients poll progress,
   and fetch the outcome when the Python worker finishes.
4. **MCP Apps** — a live dashboard (progress bars, CV leaderboards) rendered
   by the host in a sandboxed iframe.

## The customer journey

```
list_products ──► purchase_training_plan ──► upload_dataset ──► train_model ──► model://{jobId}
   (tiers)          (mock payment,             (CSV, size         (async MCP       (download the
                     entitlement in            capped by           Task: sklearn    fitted joblib
                     Postgres)                 your tier)          + XGBoost CV)    pipeline)
                                                     │                  │
                                                     ▼                  ▼
                                               transactions &    training_dashboard
                                               audit_events         (MCP App UI)
                                               in Postgres
```

Everything is keyed to the verified identity in the caller's Google bearer
token (`sub`/`email` claims): your purchases, your datasets, your jobs, your
models. Another authenticated account sees none of it.

### Tiers

| Tier     | Price | Trainings          | Max dataset | Valid |
| -------- | ----- | ------------------ | ----------- | ----- |
| basic    | $29   | 1, ever            | 1 MB        | 7 d   |
| standard | $99   | 2 per day          | 5 MB        | 30 d  |
| pro      | $249  | 10 per day         | 25 MB       | 30 d  |

Defined in [`src/products.ts`](src/products.ts); quota enforcement reads live
counts from Postgres in [`src/mcp/server.ts`](src/mcp/server.ts)
(`pickEntitlement`).

### Payments (and their limits in MCP today)

MCP has no payment primitive yet, so real deployments take payment
out-of-band (Stripe Checkout, in-host purchases) and record an **entitlement**
keyed to the caller's identity — the part this example implements for real.
[`src/payments.ts`](src/payments.ts) isolates the provider behind a
`PaymentProvider` interface; the bundled `MockPaymentProvider` auto-approves
so the flow is runnable end-to-end. Swap in a Stripe implementation there
without touching anything else.

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

The interesting code is [`src/auth/google.ts`](src/auth/google.ts): one
`jwtVerify` (via [jose](https://github.com/panva/jose)) checks the signature
against Google's JWKS **and** `iss`/`aud`/`exp`; failures answer 401/403 with
a `WWW-Authenticate` header pointing at the RFC 9728 protected-resource
metadata (`/.well-known/oauth-protected-resource/mcp` — the one intentionally
public URL); successes attach the identity to `req.auth`, which the MCP SDK
hands to every tool as `extra.authInfo`.

Getting a real token:

```bash
# As yourself (for local experiments):
gcloud auth print-identity-token

# As a service account, minted for YOUR audience (the client-credentials analog):
gcloud auth print-identity-token \
  --impersonate-service-account=my-sa@my-project.iam.gserviceaccount.com \
  --audiences="https://mcp.example.com/mcp"
```

## Part 2 — Commerce records in Postgres

[`src/db.ts`](src/db.ts) holds the schema and typed queries. Tables map to
the business flow: `customers`, `transactions` (every purchase with its
receipt), `entitlements` (what a purchase unlocks, with expiry), `datasets`,
`training_jobs` (status marches `received → analyzing → training →
completed/failed/cancelled`), and an append-only `audit_events` log
(purchase, dataset_received, training_started/completed, model_downloaded).

Two interchangeable backends behind one seam:

- **No `DATABASE_URL`** → [PGlite](https://pglite.dev/), a real Postgres
  engine embedded in-process (file-backed under `var/db`). Zero setup.
- **`DATABASE_URL` set** → the standard `pg` pool against a real server
  (Cloud SQL, RDS, docker). Same SQL, same code.

## Part 3 — Training as a long-running MCP Task

`train_model` is registered with `execution: { taskSupport: 'required' }`:
the call returns a **task handle** immediately and the client polls:

```
client                                   server
  │ tools/call train_model                 │
  │ ─────────────────────────────────►     │  quota check → job row → spawn Python
  │ ◄───────────────────────────────── ─   │  { task: { taskId, status:"working" } }
  │ tasks/get {taskId}          (poll)     │
  │ ◄───────────────────────────────── ─   │  statusMessage: "Cross-validating candidate 3/3: xgboost…"
  │          … repeat …                    │
  │ ◄───────────────────────────────── ─   │  { status:"completed" }
  │ tasks/result {taskId}                  │
  │ ◄───────────────────────────────── ─   │  best model + CV leaderboard + model:// URI
```

[`src/mcp/training.ts`](src/mcp/training.ts) bridges the Python child process
to the task lifecycle: JSON-lines on stdout become task `statusMessage`
updates *and* durable `training_jobs` progress; cancellation is cooperative
(`tasks/cancel` kills the child on the next tick). Two gotchas this project
hit that are worth knowing:

- Servers must **declare the `tasks` capability** at initialization or
  clients silently fall back to synchronous calls.
- With the experimental SDK, refusals inside `createTask` (no plan, quota
  spent) travel best as an **instantly-failed task** with the reason in
  `statusMessage` — thrown errors get mangled into unparseable results.

### The AutoML worker (`python/train.py`)

Where scikit-learn and XGBoost live. Given a CSV and target column:

1. **Outcome type** — the `problem_type` tool parameter is
   `classification` | `regression` | `auto`. With `auto`, the analyzer
   decides: non-numeric/boolean targets → classification; low-cardinality
   integers → classification; other numerics → regression.
2. **Preprocessing** — a `ColumnTransformer`: median-impute + scale numerics,
   mode-impute + one-hot categoricals; label-encode classification targets.
3. **Model selection** — k-fold cross-validation over a candidate zoo:
   a linear baseline (LogisticRegression / Ridge), RandomForest, and XGBoost.
   Best primary metric (f1-weighted / R²) wins. The linear baseline keeps the
   ensembles honest — on linear data Ridge beats XGBoost, and the customer
   gets the simpler model.
4. **Deliverable** — the winner is refit on all data and saved with `joblib`:
   `{pipeline, label_encoder, feature_columns, target_column, problem_type,
   best_model, cv_metrics}`.

Deploying a downloaded model is three lines:

```python
import joblib, pandas as pd
bundle = joblib.load("model.joblib")
pred = bundle["pipeline"].predict(df[bundle["feature_columns"]])
if bundle["label_encoder"] is not None:          # classification
    pred = bundle["label_encoder"].inverse_transform(pred)
```

### Dataset upload

`upload_dataset` takes the raw CSV as a tool argument — that's how host apps
deliver data: attach a file to the conversation (ChatGPT, Claude, …) and the
model passes its content into the tool. Limits are enforced server-side:
the per-tier byte cap before anything touches disk (plus a 30 MB transport
ceiling on the JSON body), then row/column sanity checks in the trainer.
The response echoes the detected columns so picking `target_column` is easy.

## Part 4 — MCP Apps dashboard

`training_dashboard` declares a `ui://` HTML resource
([`src/ui/`](src/ui/)) that hosts render in a sandboxed iframe: status per
job, progress bar, CV leaderboard of every candidate, and the `model://` URI
once complete. The iframe polls `list_training_jobs` **through the host**
(`app.callServerTool`) every 2 s — same consent/audit path and same bearer
identity as a model-initiated call. The build
([`scripts/build-ui.mjs`](scripts/build-ui.mjs)) inlines all JS with esbuild
because the sandbox CSP forbids external scripts.

## Running it

```bash
npm install

# Most systems (Debian/Ubuntu, etc.) block system-wide pip installs (PEP 668).
# Use a virtual environment instead:
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt   # scikit-learn, xgboost, pandas, joblib

export GOOGLE_AUDIENCE="https://mcp.example.com/mcp"   # required
# Optional:
export GOOGLE_ALLOWED_DOMAIN="example.com"
export GOOGLE_ALLOWED_EMAILS="me@example.com"
export DATABASE_URL="postgres://…"       # default: embedded PGlite under var/db
export DATA_DIR="var"                    # datasets, models, job configs
export PYTHON_BIN=".venv/bin/python"     # point at the venv's interpreter

npm run dev        # or: npm run build && npm start
```

### Smoke test (no GCP account, no Postgres server needed)

```bash
npm run smoke
```

Boots the real server (in-memory PGlite, mock payments) and drives the whole
journey with the real MCP SDK client: auth gate (401/403), purchase → refusal
before purchase, tier size limit, classification training via task polling,
quota exhaustion on the basic tier, upgrade + regression with `auto`
detection, model download (pickle header verified), and tenant isolation
between two identities. Tokens are signed with an ephemeral local key
injected through a test-only seam — production always pins Google's JWKS.

## Project layout

```
src/
├── index.ts           HTTP entrypoint: stateless Streamable HTTP, auth gate, discovery endpoint
├── config.ts          Env config, with the Entra ↔ Google concept mapping
├── auth/google.ts     Token verifier + Express middleware + RFC 9728 metadata
├── products.ts        The purchasable tiers
├── payments.ts        PaymentProvider seam + auto-approving mock
├── db.ts              Postgres schema & queries (PGlite embedded / pg pool)
├── mcp/server.ts      Tools: catalog, purchase, upload, train (task), jobs, dashboard, model download
├── mcp/training.ts    Async worker: Python child process ⇄ task lifecycle ⇄ job records
└── ui/                Dashboard MCP App (iframe-side code + template)
python/
├── train.py           AutoML: infer outcome type, CV model zoo, fit best, joblib dump
└── requirements.txt
scripts/
├── build-ui.mjs       esbuild → single self-contained dist/ui/dashboard.html
└── smoke.ts           End-to-end journey test with locally-signed Google-shaped tokens
```

## Design notes & production checklist

- **Stateless by construction.** A fresh `McpServer` + transport per POST, no
  `Mcp-Session-Id`; `GET/DELETE /mcp` → 405. Durable state lives in Postgres
  and on disk, which is why a task started on one request is pollable from
  another connection — or another replica.
- **Before scaling out**: swap `InMemoryTaskStore` for a Redis/Postgres
  `TaskStore` implementation, and move artifacts from local disk to GCS/S3.
- **Real training loads** belong in a job runner (Cloud Run jobs, Batch,
  Celery/RQ) rather than a child process of the API server; the
  `runTrainingJob` seam is where that swap happens.
- **Tasks are experimental** in SDK 1.29 (`server.experimental.tasks`); the
  API will shift as the MCP Tasks extension is finalized, but the lifecycle
  concepts (handle, poll, statusMessage, result, cancel, TTL) carry over.

## Further reading

- [MCP specification](https://modelcontextprotocol.io/specification) — Streamable HTTP transport & authorization sections
- [MCP Tasks (SEP-1686)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) — the experimental tasks spec this SDK implements
- [MCP Apps (ext-apps repo)](https://github.com/modelcontextprotocol/ext-apps) — spec, SDK, and example servers
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) — OAuth 2.0 Protected Resource Metadata
- [Google ID token validation](https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken)
- [PGlite](https://pglite.dev/) — embedded Postgres
