# Sandbox / staging deployment runbook

What this document is: the deployment-specific work that does **not** live in this
repository, written as steps. Everything the app itself needs to boot in a
sandbox is already in the code (see "What the app now does for you"), and the
items below are environment, platform, or counsel decisions.

Scope note: this is a pilot deployment runbook for a staging/sandbox environment
and a first production pilot. It is not a capacity plan — the process is a single
Node worker with in-memory sessions and JSONL record logs, described honestly
under "Known limitations".

---

## What the app now does for you

| Concern                  | Behaviour in the codebase                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port binding             | `LIFECHAT_PORT` wins, else `PORT` (platform-injected), else 3000. `PORT=0` → OS-assigned free port.                                                                  |
| No LLM credentials       | Boots and answers from the static safe fallback (`state: standby`); `/health` reports `llm.configured: false`.                                                       |
| Shutdown                 | `SIGTERM`/`SIGINT` close the listener gracefully (in-flight requests finish, 5s cap).                                                                                |
| Health check             | `GET /health` → status, uptime, kill switch, LLM configured/model/endpoint, `dataPathsWritable`, record-encryption / admin-key / license posture, compliance matrix. |
| Startup preflight        | Boot log lists each resolved record path (flagged if unwritable), whether `public/` was found, the LLM endpoint, and the cross-origin allowlist.                     |
| Unknown route / bad JSON | JSON `404` and JSON `400` (no HTML error page, no stack trace, no `x-powered-by`).                                                                                   |
| Static assets            | `/demo.html`, `/widget.js` served from `public/` next to `dist/`.                                                                                                    |
| Cross-origin embed       | Deny-by-default; `ALLOWED_ORIGINS` lists the blog origin; preflight is answered without route logic.                                                                 |
| Write-endpoint abuse     | `/api/consent` and `/api/dsr` are bounded to 60 requests/minute per client IP.                                                                                       |
| Runtime stop             | `POST/DELETE /api/admin/kill-switch` (admin key), no redeploy needed.                                                                                                |
| Record storage           | `data/*.jsonl`, created on demand, AES-256-GCM when `RECORD_ENCRYPTION_KEY` is set.                                                                                  |

---

## 1. Prerequisites

1. Node.js 22 or 24 (`engines.node >= 22`; CI runs both).
2. A writable directory for record logs (a mounted volume in a container).
3. If the sandbox has no outbound network, expect fallback answers — that is a
   valid demo posture; add `LLM_API_KEY` (+ `LLM_API_BASE_URL`) when you want
   real model responses.

## 2. Build and boot

```bash
npm ci                 # lockfile install
npm run build          # tsc → dist/
PILOT_MODE=true node dist/index.js
```

In a container, run `node dist/index.js` as PID 1 with the platform's port in
`PORT`. Do not run `ts-node` in a supervisor (documented in `.freebuff/run.md`:
shebang/PATH issues under launchd; the same class of problem appears under
systemd and some container entrypoints). Compile, then run plain `node`.

## 3. Healthcheck and smoke test

```bash
curl -fsS localhost:${PORT}/health            # 200 + readiness facts
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:${PORT}/demo.html
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:${PORT}/widget.js
curl -fsS -X POST localhost:${PORT}/api/chat -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","currentState":"education","message":"What is term life insurance?"}'
```

Wire `/health` as the platform liveness **and** readiness probe. A useful
readiness rule: `status === "ok" && dataPathsWritable === true`. Do not fail
readiness on `llm.configured === false` if you intend to demo the fallback path.

## 4. Persistence (do not skip)

1. Create a volume/directory and mount it, then point the app at it:

   ```bash
   LEAD_LOG_PATH=/var/lib/lifechat/lead-records.jsonl
   DSR_LOG_PATH=/var/lib/lifechat/dsr-records.jsonl
   ABSTENTION_LOG_PATH=/var/lib/lifechat/abstention-log.jsonl
   ```

2. Confirm the boot log shows each path with **no** `(DIRECTORY NOT WRITABLE)`
   marker. Lead and DSR writes are fail-closed: an unwritable path refuses the
   request (500/503) rather than silently acknowledging it — a test asserts this.
3. Generate the at-rest encryption key **before** writing any records:

   ```bash
   openssl rand -hex 32
   ```

   Store it in the platform's secret manager, put it in `RECORD_ENCRYPTION_KEY`,
   and never rotate it silently: existing encrypted lines become unreadable if
   the key changes (the loader warns and skips rather than losing them quietly).

4. Back up `lead-records.jsonl` / `dsr-records.jsonl` on the retention schedule
   counsel approves. They are legal artifacts (consent proof, TDPSA obligations).

## 5. Secrets

1. `ADMIN_API_KEY`, `RECORD_ENCRYPTION_KEY`, `LLM_API_KEY`, `TEXAS_LICENSE_NUMBER`
   belong in the platform's secret store — not in an image, not in a committed
   file. `.env` is gitignored and must never be shipped in an image:
   add `.env` to `.dockerignore`.
2. Production (`PILOT_MODE=false`) **refuses to start** without
   `TEXAS_LICENSE_NUMBER`, `ADMIN_API_KEY`, and `RECORD_ENCRYPTION_KEY`. Treat a
   failed boot as the checklist telling you what is missing, not as an outage.
3. Rotate `ADMIN_API_KEY` on staff change; it gates the system prompt, session
   history, DSR status, and the kill switch.

## 6. TLS and reverse proxy (required before any public URL)

The app speaks plain HTTP and does not terminate TLS. Terminate it in front:

```
# nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;
  ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;
  client_max_body_size 1m;              # request bodies are small JSON
  location / {
    proxy_pass         http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;   # so per-IP limits key correctly
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
  }
}
```

Two details that matter here:

- **`X-Real-IP` / `X-Forwarded-For`:** the write-endpoint limiter keys on
  `req.ip`. Behind a proxy without those headers every client looks like the
  proxy, so one abuser exhausts the shared budget. If you set
  `app.set('trust proxy', ...)`, do it deliberately and only for a proxy you
  control.
- **CORS:** the API's allowlist is the only browser gate. Keep
  `ALLOWED_ORIGINS` to the exact blog origin; do not use `*` — several endpoints
  carry consent artifacts.

Caddy equivalent: `chat.example.com { reverse_proxy 127.0.0.1:3001 }` (TLS is
automatic, and it forwards `X-Forwarded-For` by default).

## 7. Process supervision

Container: set restart policy `unless-stopped`, run `node dist/index.js`, let
`SIGTERM` stop it (the graceful handler is already in place).

systemd:

```ini
[Service]
WorkingDirectory=/srv/lifechat
EnvironmentFile=/etc/lifechat/lifechat.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10
User=lifechat
```

## 8. Observability

1. Capture stdout/stderr: the app logs the startup preflight, a warning when a
   response exceeds the P95 latency target, the kill-switch audit lines, and
   server-side error stacks. It logs no PII and no record contents by design.
2. Poll `/health` (uptime, kill switch, readiness) from your monitor.
3. Watch the `data/` directory size and rotate/archive on the retention schedule;
   JSONL append is O(1) but unbounded.
4. There is **no metrics endpoint** (`/metrics`) and no structured log format —
   if you need Prometheus or JSON logs, that is an enhancement, not a config
   flip.

## 9. Security and compliance checklist before exposure

- [ ] `PILOT_MODE=false` only after counsel signs the classification matrix
      (`docs/compliance-classification-matrix.md`); until then leave it `true`
      and treat the URL as a demo.
- [ ] `HEALTH_DATA_COLLECTION_DISABLED=true` stays true until Texas counsel
      approves the Phase 2 flow (`docs/medical-lead-capture-phase2.md` §7). Live
      medical capture is a counsel decision, not a deployment one.
- [ ] `ADMIN_API_KEY` set and stored as a secret.
- [ ] `RECORD_ENCRYPTION_KEY` set before the first record is written.
- [ ] `TEXAS_LICENSE_NUMBER` is the verified number (until set, `/api/disclosure`
      returns `null` and the disclosure omits the license line).
- [ ] `ALLOWED_ORIGINS` is exactly the embed origin(s).
- [ ] `FREE_OFFER_MARKETING_APPROVED=false` until marketing review clears the
      "free quote"/"no-obligation" phrasing.
- [ ] Kill-switch drill performed: activate, confirm `/api/chat` returns the
      static fallback and `/api/availability` reports `staffed:false`, then clear.
- [ ] Retention/backup schedule for `lead-records.jsonl` and `dsr-records.jsonl`
      agreed with counsel.

## 10. Known limitations (be explicit with stakeholders)

1. **Sessions are in-memory.** Restarting the process drops conversation history
   (30-minute TTL). Fine for a pilot; requires a shared store (Redis) for
   multi-instance or zero-downtime deploys.
2. **Rate limits are per process.** Two replicas mean two budgets.
3. **Record logs are append-only files, not a database.** No query API, no
   transactional writes, no multi-writer safety. One process should own them.
4. **No log rotation, metrics, or tracing** — see §8.
5. **Single worker, no clustering.** Scale vertically or add a store first.
6. **No consumer-facing auth on `/api/chat`, `/api/consent`, `/api/dsr`** by
   design (public education site); abuse control is the per-IP limiter plus the
   kill switch.
7. **The `data/` directory is gitignored.** A fresh clone has no records; the
   discovery of "where did the leads go" is almost always a container without the
   volume mounted.

## 11. Vercel (serverless) — the `VERCEL_KEY` pipeline

The repository also ships a serverless path for Vercel, driven by the
`Deploy (Vercel)` workflow. It is additive to everything above: the container
path (§2–§9) remains the way to run the app where a long-lived process, a
mounted volume, or a private network is required.

**How the deploy works.** After CI succeeds on `main` (a push, not a PR run),
`.github/workflows/deploy.yml` checks out the exact commit CI validated, runs
lint + typecheck + build again, deploys with the Vercel CLI
(`vercel deploy --prebuilt --prod`), then smoke-checks the result: `/health`
must answer 200 and `/widget.js` must serve. A failed probe fails the deploy
job visibly instead of shipping a broken URL.

**Required repository secret.** `VERCEL_KEY` — a Vercel token scoped to the
project (Account Settings → Tokens, or per-project under Project Settings →
Git Integration). Optional secrets: `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`
pin the deploy to one project; without them the token's default scope decides.
If `VERCEL_KEY` is unset the deploy job skips itself with an explanatory
message, so forks and pre-secret states stay green.

**How the app adapts.** `vercel.json` runs `npm run build` (tsc) and bundles
`dist/` and `public/` into the function (`includeFiles`); `/api/*` rewrites to
the function built from `api/index.ts`, which exports the Express app.
Vercel's runtime always sets `VERCEL=1`, and `src/config/app-config.ts`
treats it (or an explicit `SERVERLESS=true`) as _do not listen_: the app is
constructed but never binds a port, and the session/rate-limit cleanup
intervals are not scheduled — the platform owns the socket and the
invocation. `tests/serverless-mode.test.ts` pins this contract: no port is
bound under either flag, the router still serves every route with the same
gates (admin auth, chat envelope), and the default path still listens.

**Platform settings to mirror locally.** Set in the Vercel project
environment what `.env` carries elsewhere — at minimum `PILOT_MODE=true`
(sandbox) and `ALLOWED_ORIGINS` for the blog origin; the production gates
(§5.2) apply unchanged. The platform serves `public/` statically, so the
widget ships from the CDN rather than `express.static`.

**Serverless caveats (read before relying on it).**

1. **Records do not survive instance recycling.** The lead/DSR/abstention
   JSONL logs are append-only files (§4) on an ephemeral filesystem; on
   Vercel they live and die with the warm instance. The fail-closed write
   guarantee still holds — an unsaved record is a 500/503, never a false
   success — but for anything beyond a sandbox demo, wire the record store to
   durable storage first, or keep consent capture on the container path.
2. **Sessions and rate limits are per warm instance.** The §10.1/§10.2
   limitations are sharper here: two warm instances are two independent
   session stores and two rate budgets, and a cold start empties both.
3. **The smoke check cannot see records.** It proves serving works; it does
   not prove persistence. Verify record handling in an environment with the
   volume or store mounted (§4).
