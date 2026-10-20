#!/usr/bin/env bash
#
# Push the validated deployment secrets into the Vercel project's production
# environment.
#
# The deploy workflow validates the GitHub copy of ADMIN_API_KEY and
# RECORD_ENCRYPTION_KEY before it builds, and the deployed function must run
# with exactly those values. Vercel's environment is a separate, write-only
# store that nothing can read back, so the checked copy is written here rather
# than left for an operator to keep two stores in step by hand.
#
# The values are never passed as arguments — argv is visible in a process
# listing — and never printed. Only the name and length of each value reaches
# the log, which is enough to show the sync ran without copying a secret into
# CI output.
#
# Inputs (all required):
#   VERCEL_TOKEN          a Vercel token scoped to the project
#   VERCEL_ORG_ID         the team that owns the project
#   VERCEL_PROJECT_ID     the project the deploy will publish to
#   ADMIN_API_KEY         validated by the pre-deploy gate
#   RECORD_ENCRYPTION_KEY validated by the pre-deploy gate
#
# The project is required explicitly, not inferred. `vercel deploy` can link
# itself to a project from the repository, but writing secrets to a guessed
# project would be worse than refusing: the value would not reach the function
# that is about to be deployed. An unlinked, unpinned checkout therefore fails
# here instead of deploying with secrets that were never checked.
#
# Requires the pinned Vercel CLI installed locally (the workflow runs
# `npm install --no-save vercel@64.7.0` first): `--no-install` keeps the step
# from fetching an unpinned release at deploy time.

set -euo pipefail

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "::error::VERCEL_TOKEN is not set; refusing to sync deployment secrets." >&2
  exit 1
fi

if [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ]; then
  echo "::error::VERCEL_ORG_ID and VERCEL_PROJECT_ID must both be set so the sync writes to the project this deploy will publish to." >&2
  exit 1
fi

for name in ADMIN_API_KEY RECORD_ENCRYPTION_KEY; do
  value="${!name:-}"
  if [ -z "$value" ]; then
    echo "::error::$name is empty; the pre-deploy gate should have stopped this run." >&2
    exit 1
  fi
  # --sensitive stores the value as a Vercel Secret: never readable in the
  # dashboard and unavailable to `vercel env pull`. --force overwrites a stale
  # value in the same environment, which is what makes the sync idempotent.
  printf '%s' "$value" | npx --no-install vercel env add "$name" \
    --environment production \
    --sensitive \
    --force \
    --yes \
    --scope "$VERCEL_ORG_ID" \
    --project "$VERCEL_PROJECT_ID" \
    --token "$VERCEL_TOKEN"
  echo "Synced $name to Vercel production (${#value} chars)."
done
