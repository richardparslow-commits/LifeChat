# Data-lifecycle runbook: verification, erasure, and retention

This is the operator procedure for TDPSA deletion requests and for the retention
schedule. It matches what the software actually does; if the two ever disagree,
the software is authoritative and this document must be corrected.

Implementation: [src/privacy/erasure.ts](../src/privacy/erasure.ts) (rewrites and
receipts), [src/privacy/dsr.ts](../src/privacy/dsr.ts) (request lifecycle),
[src/privacy/lifecycle-cli.ts](../src/privacy/lifecycle-cli.ts) (operator CLI),
[src/app.ts](../src/app.ts) (admin routes). Tests:
[tests/data-lifecycle.test.ts](../tests/data-lifecycle.test.ts).

## 1. What the system now does

| Step         | Trigger                                          | Effect                                                                                                                                                      |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake       | `POST /api/dsr` (public)                         | Record created with status `received`, `verified: false`. **No authority yet.**                                                                             |
| Verification | `POST /api/dsr/:id/verify` (admin)               | Records that a human confirmed the requester controls the address. Status becomes `verifying`, `verified: true`. This is what grants suppression authority. |
| Fulfilment   | `POST /api/dsr/:id/erase` (admin) or CLI         | Rewrites the logs: removes the subject's leads, replaces their DSR records with PII-free tombstones, marks the authorizing request `fulfilled`.             |
| Retention    | `POST /api/admin/retention/sweep` (admin) or CLI | Removes leads older than `DATA_RETENTION_DAYS` and fulfilled DSR tombstones older than the same cutoff. Open requests and undated records are kept.         |

The **verification route records a decision; it does not make one.** Someone must
actually confirm identity through an independent channel (reply from the address
on file, a call-back to the number on file, or another counsel-approved method)
before calling it. Calling `/verify` on an unconfirmed request turns an attacker's
claim into suppression authority over a real lead.

Erasure authority is taken from the DSR, never from the request body: the
address is read from the stored request, and only a `deletion` request that is
`verified` can authorise it.

## 2. Verify a request

```bash
# Inspect first: status, type and whether it is already verified.
curl -s "$BASE/api/dsr/$REQUEST_ID" -H "x-admin-key: $ADMIN_API_KEY" | jq

# Only after confirming identity out of band:
curl -s -X POST "$BASE/api/dsr/$REQUEST_ID/verify" \
  -H "x-admin-key: $ADMIN_API_KEY" | jq
```

Expected: `{ "verified": true, "status": "verifying", ... }`. A `404` means the
id is wrong; a `503` means the verification could not be written durably — retry,
do not treat it as recorded.

## 3. Fulfil a deletion

```bash
curl -s -X POST "$BASE/api/dsr/$REQUEST_ID/erase" \
  -H "x-admin-key: $ADMIN_API_KEY" | jq
```

Or, from a shell with the same environment as the app:

```bash
npm run data:lifecycle -- erase --request-id "$REQUEST_ID"
```

Expected receipt:

```json
{
  "status": "fulfilled",
  "requestId": "…",
  "erasedAt": "2026-10-21T18:04:00.000Z",
  "leadRecordsErased": 1,
  "dsrRecordsRedacted": 1,
  "auditRecorded": true
}
```

`dsrRecordsRedacted` counts distinct requests, not log lines (verification
appends a second line for the same request).

### What is removed, and what is kept

- **Removed:** every lead/consent record whose `email` matches the request's
  address, including `first_name`, `phone`, `medical_profile`, consent hashes,
  and the note fields on that record.
- **Kept as a tombstone:** each DSR for that address, with `contact_email`
  replaced by `erased`, `detail` cleared to `null`, and its id, type, timestamps
  and status preserved. The authorizing request becomes `fulfilled`; other
  requests keep their status so an open access/correction request is not
  silently closed.
- **Never touched:** records for other addresses, and the PII-free audit line.
- **Not covered:** provider-side logs, email inboxes, CRM exports, and **backups
  or disk snapshots**. Erasure rewrites the live JSONL objects only. The
  retention policy for Archil snapshots/backups must be set separately, and a
  deleted record can persist there until that snapshot expires.

## 4. Failure handling

| Response                  | Meaning                                                                                                 | Action                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `409 not_verified`        | The request has not been confirmed.                                                                     | Complete §2 first.                                                                                       |
| `400 not_a_deletion`      | The request is access/correction/portability.                                                           | Use the appropriate process; erasure is only for deletion.                                               |
| `409 already_fulfilled`   | The request was already fulfilled.                                                                      | No action. The tombstone is the record.                                                                  |
| `404 request_not_found`   | Wrong id.                                                                                               | Check the id from the intake response.                                                                   |
| `503 storage_unavailable` | Serverless runtime without durable storage.                                                             | Run against the deployment with the durable volume/Archil disk.                                          |
| `500 undecodable_record`  | A line cannot be decoded (wrong or missing `RECORD_ENCRYPTION_KEY`). **Nothing was changed.**           | Restore the correct key and retry. Do not delete the log to "fix" it.                                    |
| `500 malformed_record`    | A line is not valid JSON. **Nothing was changed.**                                                      | Investigate the line with the key available; fix or quarantine it under counsel's direction, then retry. |
| `500 write_failed`        | The rewrite could not be written; the original is still in place (local writes are temp-file + rename). | Check disk space/permissions, then retry. The operation is safe to repeat.                               |

A successful erasure also reloads both in-memory caches. If the process is
running on more than one instance, other instances keep serving erased records
until they restart — erasure is currently a single-instance operation.

The rewrite is not a transaction against concurrent writers. Run erasure during
low traffic: a consent that is appended after the rewrite is a _new_ record and
will not be removed by that erasure (re-check the address and re-run if the
requester has not re-consented). Retention has the same property.

## 5. Retention

Configure the period with `DATA_RETENTION_DAYS` (default `2555`, seven years)
and the audit path with `ERASURE_LOG_PATH` (default `data/erasure-log.jsonl`).
Counsel owns the number; the code only enforces it.

```bash
# Report what would be removed; changes nothing and writes no audit line.
npm run data:lifecycle -- retention --dry-run

# Apply the configured period.
npm run data:lifecycle -- retention

# One-off period (e.g. after a schedule change).
npm run data:lifecycle -- retention --days 1825
```

The admin route accepts the same options:

```bash
curl -s -X POST "$BASE/api/admin/retention/sweep" \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"dryRun": true}' | jq
```

Semantics:

- Leads expire by `created_at`.
- A DSR expires only when its status is `fulfilled` **and** it is older than the
  cutoff. An open request is evidence of an outstanding legal obligation.
- A record with no parseable timestamp is kept; the sweep never guesses.
- `dryRun: true` computes counts without writing, auditing or reloading.
- The sweep is operator-triggered. This repository ships no scheduler; run it
  from cron/CI or a platform scheduled job, e.g. monthly, and keep the receipt.

## 6. Evidence

- **Receipt:** the JSON from §3 (request id, timestamp, counts) is the
  fulfilment artifact. Attach it to the DSR's file/ticket.
- **Audit log:** `ERASURE_LOG_PATH` is append-only and contains
  `subject_erasure` and `retention_sweep` entries with counts, cutoff and request
  id — never an address or free-text detail.
- **Access log:** `ADMIN_ACCESS_LOG_PATH` (default
  `data/admin-access-log.jsonl`) records one `admin_read` entry per operator read
  — route, hashed key id, opaque record id or `unrecognized`, timestamp, status —
  and nothing that was read. A read that cannot be recorded is refused with 503,
  so a gap here means the read did not happen. It holds no encrypted content, so
  key rotation leaves it alone; keep it with the other audit logs.
- **DSR tombstone:** `GET /api/dsr/:id` shows `status: "fulfilled"` and
  `fulfilledAt`. The address is gone from the record.

Keep the receipt and audit log for the period counsel specifies. They contain no
PII, so they can outlive the erased records.

## 7. Record-encryption key rotation

Every encrypted record line carries a key id (`kid`) derived from the secret
itself, so a key needs no separate identifier. New lines use
`RECORD_ENCRYPTION_KEY`; decryption also accepts the previous secrets listed in
`RECORD_ENCRYPTION_KEYS`. Rotating without the old key in the ring makes older
records unreadable — and erasure cannot complete without them.

1. Generate the new secret: `openssl rand -base64 48`.
2. Set it as `RECORD_ENCRYPTION_KEY`; put the current secret in
   `RECORD_ENCRYPTION_KEYS` (comma-separated if already rotating).
3. Deploy. The app still starts if the ring is correct; test one record load
   (a DSR lookup or lead export) before continuing.
4. `npm run records:rekey -- --dry-run`, review the per-log counts and the
   `currentKeyId`.
5. `npm run records:rekey`. Each log is rewritten atomically and durably (temp
   file fsynced, renamed, directory fsynced). If any line cannot be decoded the
   command exits 1 and that file is left untouched — do **not** remove the old
   secret; fix the key ring first.
6. Confirm a second run reports `unchanged` equal to `total` for every log,
   then remove the old secret from `RECORD_ENCRYPTION_KEYS` and redeploy.

The rekey receipt prints counts and the key id only — never a secret. Keep it
with the other lifecycle evidence.

### Rotating `ABSTENTION_LOG_KEY`

The abstention feed hashes the normalized question with HMAC-SHA-256 keyed by
`ABSTENTION_LOG_KEY` (M-08); the key encrypts nothing, so no record becomes
unreadable when it changes. Each entry carries `hash_key_id` (a prefix of the
key's digest, never the key), so entries either side of a rotation are
distinguishable. Rotate it like any other secret (`openssl rand -hex 32`) and
delete the old value — it cannot decrypt anything. Recurrence counting starts a
new window after a rotation, so a question repeated across the boundary shows as
two: that is the reset, not data loss. With no key configured nothing is written
and the boot log warns.

The session → lead index (`LEAD_SESSION_INDEX_PATH`) holds only `session_id`,
`lead_id` and `created_at`, so a rekey leaves it valid; it is not re-encrypted.
A rewrite does make the lead log newer than the index, which the next process
notices and repairs. Run `npm run records:index-sessions` if you want the
repaired file on disk before the restart.

## 8. Durability and RPO

Every acknowledged record write is flushed before the caller is answered:

- **Append** — open the log, write the line, `fsync` the descriptor, close, and
  `fsync` the parent directory when the append created the file (a new name is a
  directory change; flushing the file alone can leave content that nothing
  points at).
- **Rewrite** — erasure, retention, key rotation and the session index write a
  temp file, `fsync` it, rename it over the log, then `fsync` the directory, so
  a crash cannot leave an empty log where an erased one was or bring the
  previous version back.
- **Failure** — a write that cannot be flushed is reported as a failure
  (`500`/`503`) instead of being acknowledged, and erasure answers
  `write_failed` rather than claiming nothing changed. A host that cannot sync a
  directory at all (Windows, some filesystems) is tolerated: there is no
  stronger primitive to ask for.

Cost: about 5 ms per record append on a local APFS volume (0.08 ms without the
flush), paid on consent, DSR, booking and abstention writes — not on chat turns,
which append nothing.

What that buys:

| Failure                                           | Data loss                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process crash, kill, or redeploy                  | None. Every acknowledged line was flushed before the response.                                                                                                                      |
| Power loss on a device that honours the flush     | At most the write in flight; nothing that was acknowledged.                                                                                                                         |
| Power loss on a device that drops its write cache | The last writes since the last real barrier — possibly acknowledged ones. `fsync` does not request `F_FULLFSYNC` on macOS, and some virtualised disks discard their cache on reset. |
| Losing the volume                                 | Everything not in a backup. `fsync` is not replication.                                                                                                                             |

The RPO is **zero for process failures**, **the in-flight write for a power cut
on a conforming device**, and **unbounded-but-small on a device that ignores the
flush** — no application code can bound that last case. If consent evidence has
to survive the third row, keep the volume on storage whose vendor documents
honouring flushes, and keep the backups counsel requires.

## 9. Scheduled checks

- [ ] Daily: any `received` request older than 40 days? Verify and fulfil before
      the 45-day TDPSA deadline.
- [ ] Monthly: run `retention --dry-run`, review counts, then apply. The
      operator process rebuilds the session index after the rewrite, so the
      file no longer names an erased session. A server that was already running
      keeps its in-memory copy until it restarts, but a lookup for a deleted
      record still fails closed because the record itself is gone — restart it
      at the end of the run for a clean index.
- [ ] Quarterly: confirm the audit log is being written and backed up, and that
      `RECORD_ENCRYPTION_KEY` is available to the operator on call (without it,
      erasure fails closed and the SLA cannot be met).
- [ ] Annually, or on suspected exposure: rotate the record key with the §7
      procedure, and keep the rekey receipt.
