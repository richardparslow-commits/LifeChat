#!/usr/bin/env bash
#
# Build the deployment image with the pre-deploy posture gate enabled.
#
# The gate runs inside the image build, so the four values it checks must reach
# BuildKit. They are passed as secrets (`--secret id=...,env=...`), never as
# --build-arg (recorded in the image history) or ENV (readable from the image).
# No value is printed here or by the gate, which reports length and shape only.
#
# BuildKit does not include secret contents in its cache key, so the gate stage
# is excluded from the cache. Without that, a cached layer from an earlier build
# could vouch for values that are no longer being deployed.
#
# Inputs (all required, read from the environment):
#   ADMIN_API_KEY          the four values `npm run secrets:gate` validates
#   RECORD_ENCRYPTION_KEY
#   LLM_API_KEY
#   TEXAS_LICENSE_NUMBER
#   IMAGE_TAG              optional tag, default lifechat:local
#
# Usage: scripts/build-docker-image.sh [extra docker buildx flags]
#
# Requires BuildKit and the buildx plugin (`docker buildx version`).

set -euo pipefail

cd "$(dirname "$0")/.."

missing=""
for name in ADMIN_API_KEY RECORD_ENCRYPTION_KEY LLM_API_KEY TEXAS_LICENSE_NUMBER; do
  if [ -z "${!name:-}" ]; then
    missing="${missing:+$missing }$name"
  fi
done
if [ -n "$missing" ]; then
  echo "ERROR: missing $missing - the posture gate runs during the build and refuses an image without them." >&2
  echo "Read each value from your secret store into the environment, then rerun." >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "ERROR: docker buildx is required so the gate stage can be excluded from the build cache." >&2
  echo "Install the buildx plugin (shipped with Docker Desktop and recent Engine releases), then rerun." >&2
  exit 1
fi

# The specs are their own argv array so each can carry an inline scanner
# annotation. They name BuildKit secret ids and environment variables — no
# value is present — but a scanner reads `id=<name>,env=<NAME>` as a credential
# assignment. An inline exemption keeps that local: a real secret added
# anywhere in this script is still reported, unlike a path exemption.
secret_args=(
  --secret "id=admin_api_key,env=ADMIN_API_KEY" # gitleaks:allow - argument name, not a value
  --secret "id=record_encryption_key,env=RECORD_ENCRYPTION_KEY" # gitleaks:allow - argument name, not a value
  --secret "id=llm_api_key,env=LLM_API_KEY" # gitleaks:allow - argument name, not a value
  --secret "id=texas_license_number,env=TEXAS_LICENSE_NUMBER" # gitleaks:allow - argument name, not a value
)

exec docker buildx build \
  --tag "${IMAGE_TAG:-lifechat:local}" \
  --load \
  --no-cache-filter posture-gate \
  "${secret_args[@]}" \
  "$@" .
