# Sandbox / staging deployment runbook

What this document is: the deployment-specific work that does **not** live in this
repository, written as steps. Everything the app itself needs to boot in a
sandbox is already in the code (see "What the app now does for you"), and the
items below are environment, platform, or counsel decisions.

Scope note: this is a pilot deployment runbook for a staging/sandbox environment
and a first production pilot. It is not a capacity plan — the process is a single
Node worker with in-memory sessions and JSONL record logs, described honestly
under "Known limitations".

**This one long-running Node process with a persistent volume is the only
supported production topology.** One replica, one writer. §11's Vercel path is a
sandbox demo, not an alternative production target, and §12's Archil Sandbox is
the same Node process with its root filesystem made durable.

---

## What the app now does for you

| Concern                  | Behaviour in the codebase                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Port binding             | `LIFECHAT_PORT` wins, else `PORT` (platform-injected), else 3000. `PORT=0` → OS-assigned free port.                                                                                                                                  |
| No LLM credentials       | Boots and answers from the static safe fallback (`state: standby`); admin health reports `llm.configured: false`.                                                                                                                    |
| Shutdown                 | `SIGTERM`/`SIGINT` close the listener gracefully (in-flight requests finish, 5s cap).                                                                                                                                                |
| Health check             | `GET /health` → liveness only: status, uptime, kill switch. Readiness (LLM configured/model/endpoint, `dataPathsWritable`, record storage, proxy, key/license posture, compliance matrix) is on admin-gated `GET /api/admin/health`. |
| Startup preflight        | Boot log lists each resolved record path (flagged if unwritable), whether `public/` was found, the LLM endpoint, and the cross-origin allowlist.                                                                                     |
| Unknown route / bad JSON | JSON `404` and JSON `400` (no HTML error page, no stack trace, no `x-powered-by`).                                                                                                                                                   |
| Static assets            | `/demo.html`, `/widget.js` served from `public/` next to `dist/`.                                                                                                                                                                    |
| Cross-origin embed       | Deny-by-default; `ALLOWED_ORIGINS` lists the blog origin; preflight is answered without route logic.                                                                                                                                 |
| Write-endpoint abuse     | `/api/consent` and `/api/dsr` are bounded to 60 requests/minute per client IP.                                                                                                                                                       |
| Runtime stop             | `POST/DELETE /api/admin/kill-switch` (admin key), no redeploy needed.                                                                                                                                                                |
| Record storage           | `data/*.jsonl`, created on demand, AES-256-GCM when `RECORD_ENCRYPTION_KEY` is set.                                                                                                                                                  |

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
# Admin routes fail closed without this key, in pilot mode too.
export ADMIN_API_KEY="$(openssl rand -base64 48)"
PILOT_MODE=true node dist/index.js
```

In a container, run `node dist/index.js` as PID 1 with the platform's port in
`PORT`. Do not run `ts-node` in a supervisor (documented in `.freebuff/run.md`:
shebang/PATH issues under launchd; the same class of problem appears under
systemd and some container entrypoints). Compile, then run plain `node`.

For the container image, build through `scripts/build-docker-image.sh` rather
than a bare `docker build`: the image build runs the pre-deploy posture gate
(§5) and the wrapper is what supplies its values and keeps that gate stage
uncached. A build without all four values fails in the gate stage.

## 3. Healthcheck and smoke test

```bash
curl -fsS localhost:${PORT}/health            # 200 + liveness (status, uptime, kill switch)
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:${PORT}/demo.html
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:${PORT}/widget.js
curl -fsS -X POST localhost:${PORT}/api/chat -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","currentState":"education","message":"What is term life insurance?"}'
```

Wire `/health` as the platform **liveness** probe: it answers `status`,
`uptimeSeconds` and `killSwitch`, and nothing about the deployment's posture
(M-02). Readiness lives on `GET /api/admin/health` behind `x-admin-key`: record
paths writable, LLM configured, the storage verdict, proxy derivation and the
compliance matrix. A useful readiness rule there is
`status === "ok" && dataPathsWritable === true`; do not fail readiness on
`llm.configured === false` if you intend to demo the fallback path. A monitor
that cannot hold the admin key can still alert on liveness, the kill switch,
and a failed `/api/chat` smoke.

## 4. Persistence (do not skip)

1. Create a volume/directory and mount it, then point the app at it:

   ```bash
   LEAD_LOG_PATH=/var/lib/lifechat/lead-records.jsonl
   DSR_LOG_PATH=/var/lib/lifechat/dsr-records.jsonl
   ABSTENTION_LOG_PATH=/var/lib/lifechat/abstention-log.jsonl
   ABSTENTION_LOG_KEY=$(openssl rand -hex 32)   # keys the abstention hash; unset = no abstentions recorded
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

1. `ADMIN_API_KEY`, `RECORD_ENCRYPTION_KEY` and `LLM_API_KEY` belong in the
   platform's secret store — not in an image, not in a committed file.
   `TEXAS_LICENSE_NUMBER` is a public identifier, so a repository variable is
   enough, but it belongs in configuration rather than in source. `.env` is
   gitignored and excluded by `.dockerignore`, so it must never be shipped in an
   image.
2. Production (`PILOT_MODE=false`) **refuses to start** without
   `TEXAS_LICENSE_NUMBER`, `ADMIN_API_KEY`, and `RECORD_ENCRYPTION_KEY`. Treat a
   failed boot as the checklist telling you what is missing, not as an outage.
3. The admin and record-encryption keys have a **32-character minimum**,
   enforced at boot in every mode (pilot included). A shorter value is refused
   rather than accepted as a weak setting — constant-time comparison cannot
   protect a guessable secret. Generate them with `openssl rand -base64 48`.
   The pre-deploy gate adds a **20-character floor** for `LLM_API_KEY`, below
   the length of any managed provider's real key.
4. Rotate `ADMIN_API_KEY` on staff change; it gates the system prompt, session
   history, DSR status, and the kill switch.
5. Before shipping, run `npm run secrets:gate` (the Vercel deploy workflow runs
   it automatically). For the secrets it rejects a missing key, one below the
   length floor, a placeholder (including model-provider templates such as
   `your-api-key-here`), a repeated or sequential value, a low-entropy value,
   the same value used under two names, and accidental surrounding whitespace.
   The license number is checked as an identifier rather than a secret: the
   pending sentinel, templates, letters, a number shorter than five digits,
   repeated digits (`0000000`) and straight runs (`1234567`) are all refused.
   It reports only length and measured shape — never the values — so its output
   is safe in CI.
6. **Container images run the same gate during the build.** The `Dockerfile`
   has a `posture-gate` stage that runs `npm run secrets:gate` before TypeScript
   is compiled, so an image cannot be produced from a missing, weak, placeholder
   or duplicated value — a container deployment cannot skip the check that the
   Vercel workflow runs as a step. The values are handed to BuildKit as secrets
   (`--secret id=…,env=…`), never as build args or `ENV`: a build arg is
   recorded in the image history and an `ENV` is readable from the image, so
   either would publish the secrets the gate is checking.

   ```bash
   # The same values the container will receive at run time, read from the
   # secret store — never from a file in the build context.
   export ADMIN_API_KEY="<32+ character random key>"
   export RECORD_ENCRYPTION_KEY="<different 32+ character random key>"
   export LLM_API_KEY="<provider key>"
   export TEXAS_LICENSE_NUMBER="<verified TDI number>"
   IMAGE_TAG=lifechat:pilot scripts/build-docker-image.sh
   ```

   The wrapper also passes `--no-cache-filter posture-gate`. BuildKit does not
   include secret contents in its cache key, so without that a cached layer from
   an earlier build could vouch for values that are no longer being deployed.
   The image still needs the same values at run time (the app validates them at
   boot); the build-time gate is simply the earlier, stricter check.

7. On the Vercel path, the deploy workflow then **writes the validated
   `ADMIN_API_KEY` and `RECORD_ENCRYPTION_KEY` into the project's production
   environment** (`scripts/sync-vercel-secrets.sh`) before deploying, from the
   same repository secrets the gate checked. Vercel values are write-only, so
   pushing the checked copy is the only way to guarantee the deployed value is
   the checked value; rotating either key in GitHub and merging is enough to
   update both copies. The sync addresses the project explicitly
   (`--scope`/`--project`), which is why the two project IDs above are
   mandatory: a secret written to the wrong project would leave the function
   being deployed on a stale value. Other deployment paths (container, manual)
   must supply those values from their own secret store — this sync is
   Vercel-specific.

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
  proxy, so one abuser exhausts the shared budget. Proxy trust is off unless
  `TRUST_PROXY` is set; enable it only for a proxy you control, as a hop count
  (`TRUST_PROXY=1`), a keyword (`TRUST_PROXY=loopback`), or an explicit subnet
  list. An unparseable value is ignored with a warning, so the process degrades
  to trusting nothing rather than trusting everything.
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
2. Poll `/health` (uptime, kill switch) from your monitor; poll
   `/api/admin/health` with `x-admin-key` where the monitor can hold one, for
   the readiness facts.
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
      medical capture is a counsel decision, not a deployment one. If the flow
      is ever enabled, `RECORD_ENCRYPTION_KEY` becomes mandatory in that
      environment: `/api/consent` refuses a medical profile with `503` without
      it rather than writing health data in clear, pilot mode included.
- [ ] `ADMIN_API_KEY` set (32+ characters), stored as a secret, and accepted by
      `npm run secrets:gate`.
- [ ] `TRUST_PROXY` set to the actual proxy hop count/keyword, or left unset.
- [ ] `RECORD_ENCRYPTION_KEY` set before the first record is written, different
      from `ADMIN_API_KEY`, and accepted by `npm run secrets:gate`.
- [ ] `TEXAS_LICENSE_NUMBER` is the verified number (until set, `/api/disclosure`
      returns `null` and the disclosure omits the license line).
- [ ] `ALLOWED_ORIGINS` is exactly the embed origin(s).
- [ ] The published rights channel is live: `npm run rights:channel` exits `0`
      for the production `DSR_CONTACT_EMAIL`. Exit `1` = the domain cannot
      receive mail; exit `2` = no answer (resolver failure, or no MX record and
      only an A/AAAA host that may not accept SMTP). Then send one test message
      from an outside account — DNS proves a route, not a mailbox.
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

## 11. Vercel (serverless) — sandbox demo only, not a supported topology

The repository still ships a serverless path for Vercel, driven by the
`Deploy (Vercel)` workflow. It exists for demos and for proving the no-listen
contract in `tests/serverless-mode.test.ts`; it is **not** a production
topology. The supported path is the container in §2–§9: a long-lived process
with a mounted volume, which is what durable records, coherent sessions and the
booking ledger require. `/api/consent` and `/api/dsr` answer 503 on Vercel by
design, so a deployed demo can chat but cannot capture a lead or a rights
request.

**How the deploy works.** After CI succeeds on `main` (a push, not a PR run),
`.github/workflows/deploy.yml` checks out the exact commit CI validated, runs
lint + typecheck + build again, deploys with the Vercel CLI
(`vercel deploy --prod`), then smoke-checks the result: `/health` must answer
200 and `/widget.js` must serve. The build itself runs on Vercel, driven by
`vercel.json` (`npm ci`, `npm run build`, `includeFiles`), so the job uploads
source rather than build output; its local build is a parity gate that runs the
same command. `--prebuilt` is deliberately not used — it uploads only the
`.vercel/output` directory produced by `vercel build`, which this job never
runs, and the CLI would reject the deploy for having nothing to upload. A
failed probe fails the deploy job visibly instead of shipping a broken URL.

**Required repository secrets.** `VERCEL_KEY` — a Vercel token scoped to the
project (Account Settings → Tokens, or per-project under Project Settings →
Git Integration) — plus `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, which identify
the team and the project. Both IDs are required whenever `VERCEL_KEY` is set:
the secret sync writes the validated keys to that exact project and the deploy
targets the same one, so a missing pair fails the job with a clear message
instead of writing to whatever project the CLI guessed from the checkout.
`VERCEL_PROJECT_ID` is the `prj_…` id and `VERCEL_ORG_ID` the `team_…` id (both
printed by `vercel link`). If `VERCEL_KEY` is unset the deploy job skips itself
with an explanatory message, so forks and pre-secret states stay green.

**Configuration preflight.** The first step is both the enable switch and a
completeness check. With `VERCEL_KEY` present, it requires `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID`, `ADMIN_API_KEY`, `RECORD_ENCRYPTION_KEY`, `LLM_API_KEY`
and `TEXAS_LICENSE_NUMBER` (a repository variable is accepted for the license),
and if any are absent it fails **before** `npm ci` and the build, listing every
missing name in one `::error::` so they can be fixed in a single pass. Without
that step a gap would surface later as a skipped sync, a partial gate report,
or a function that cannot start — all of which look like a partial success
rather than a configuration error.

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
(sandbox), `ADMIN_API_KEY` (admin routes answer 503 without it, in pilot too)
and `ALLOWED_ORIGINS` for the blog origin; the production gates (§5.2) apply
unchanged. The platform serves `public/` statically, so the
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

## 12. Archil Sandbox — a durable, publicly reachable pilot instance

An Archil Sandbox boots a container whose **root filesystem is itself an Archil
disk** (`/dev/mapper/archil-root`). That makes it the shortest path to a running
pilot with durable record logs: no volume to mount, no platform to configure,
and `stop`/`start` keeps `/app/data` intact.

```bash
npm run deploy:archil-sandbox                # build, deploy, restart, verify
npm run deploy:archil-sandbox -- --skip-build
```

`scripts/run-on-archil-sandbox.mjs` is the executable runbook. It builds with
`tsc` (never `ts-node` — see §2), packs `dist/` + `public/` + the package files,
uploads them with the sandbox files API, runs `npm ci --omit=dev` in the guest,
starts `node dist/index.js` as a detached process, exposes port 3000, and polls
`/health` before printing the URL. It is idempotent: the sandbox is reused by
name, and a redeploy stops then starts it so no leftover process can hold the
port.

**What it configures.** The guest env is `.env` with the record paths rewritten
to `/app/data/*.jsonl`; `LIFECHAT_PORT` is set to `3000`. The file is uploaded
at mode `0600` to `/root/lifechat.env` and read with `--env-file`, so secrets
stay out of the sandbox's env metadata (which the console shows).

**Verifying persistence.** Write a record through the public URL, stop the
sandbox, start it, and count the lines before restarting the app:

```bash
CONSENT='I agree to be contacted about my life-insurance inquiry. Consent is not a condition of purchase.'
curl -fsS -X POST "https://<sandbox-host>/api/consent" -H 'Content-Type: application/json' \
  -d "{\"contactConsentAffirmed\":true,\"contactChannel\":\"email\",\"email\":\"you@example.com\",
       \"sessionId\":\"lpp_persistcheck1\",\"consentText\":\"$CONSENT\"}"
# then, in the guest: wc -l /app/data/lead-records.jsonl
```

**Two things this path deliberately does not do.**

1. **It does not mount `ARCHIL_DISK_ID` into the sandbox.** Mounting that disk
   failed at boot (both an exclusive read-write mount and a conditional mount),
   so the sandbox writes to its own durable root disk. The S3 deployment —
   `ARCHIL_API_KEY` + `ARCHIL_DISK_ID`, which the local server uses — writes
   `lifechat/data/*.jsonl` to the shared disk instead. Both survive restarts;
   they are separate stores, so a lead captured on one is not visible on the
   other.
2. **It does not prove the model path.** `/api/admin/health` reports
   `llm.configured` from the presence of `LLM_API_KEY`, not from a successful
   call. A rejected or expired key still answers `/health` 200 and `/api/chat` with the static
   fallback, so check `/api/chat` for a real answer before demoing it —
   `npm run llm:probe` does exactly that (one minimal completion, exit 1 on a
   rejected key, and it never prints the key). The deploy script runs the same
   probe inside the guest and prints `Model probe: OK` or `FAILED`.

**Model egress is allowlisted.** A sandbox's outbound HTTPS goes through a
managed allowlist. `registry.npmjs.org`, `api.openai.com`, `api.anthropic.com`,
`openrouter.ai`, `api.groq.com` and `generativelanguage.googleapis.com` answer;
`ai-gateway.vercel.sh` (and `github.com`) are reset during the TLS handshake,
and an unlisted host surfaces in the app as `LLM call failed: fetch failed`.
A custom policy — `sandbox.updateNetwork({ egress: … })` — requires a paid Archil
plan. So a Vercel AI Gateway key cannot serve a model from inside a sandbox on
this plan: use a provider on the allowlist, or run the model path on the
container/Vercel deployment and keep the sandbox for storage.
