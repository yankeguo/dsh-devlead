#!/usr/bin/env bash
# Configure npm trusted publishing (keyless OIDC) for every package in this
# workspace.
#
# Run this once per package after the package's FIRST publish (npm requires the
# package to exist before a trusted publisher can be attached). Afterward the
# GitHub Actions workflow publishes with no NPM_TOKEN secret at all.
#
# Prerequisites:
#   - npm >= 11.15.0 (npm trust was added there; `npm install -g npm@latest`)
#   - 2FA enabled on the npm account
#   - npm login as an account with write access to the @yankeguo packages
#     (npm trust does not accept bypass-2FA granular tokens)
#
# Usage:
#   scripts/trusted-publishers.sh                     # configure all packages
#   scripts/trusted-publishers.sh --dry-run           # show what it would do
#   scripts/trusted-publishers.sh --list              # list current config
#   scripts/trusted-publishers.sh --env npm-publish   # bind a GitHub environment
#   scripts/trusted-publishers.sh --repo owner/repo --file publish.yml
#
# The workflow filename must match .github/workflows/<file> exactly; the
# optional GitHub environment must also be set on the workflow job for the
# claims to match.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="yankeguo/dsh-devlead"
WORKFLOW_FILE="publish.yml"
ENVIRONMENT=""
MODE="configure"

# Print this script's header comment block as --help output.
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --list) MODE="list"; shift ;;
    --repo) REPO="${2:?--repo needs owner/repo}"; shift 2 ;;
    --file) WORKFLOW_FILE="${2:?--file needs a filename}"; shift 2 ;;
    --env|--environment) ENVIRONMENT="${2:?--env needs a name}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Reject values the registry would only reject after a round trip. npm requires
# the bare workflow filename (no directory) and an owner/repository pair.
if [[ ! "${WORKFLOW_FILE}" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]]; then
  echo "--file must be a bare workflow filename ending in .yml/.yaml (got ${WORKFLOW_FILE})" >&2
  exit 2
fi
if [[ ! "${REPO}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "--repo must be owner/repository (got ${REPO})" >&2
  exit 2
fi

# ---- prerequisites ---------------------------------------------------------
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 2; }
if ! command -v node >/dev/null 2>&1; then
  echo "node is required"
  exit 2
fi

npm_version="$(npm --version)"
node_version="$(node --version)"
echo "npm ${npm_version} / node ${node_version}"
# Capability check instead of parsing versions: `npm trust` is the feature we
# actually need, and old npm versions print an unknown-command error.
if ! npm trust --help >/dev/null 2>&1; then
  echo "npm >= 11.15.0 is required for 'npm trust' (found ${npm_version}); run: npm install -g npm@latest" >&2
  exit 2
fi

# Collect publishable package names from the workspace manifests.
# (while-read keeps this portable to bash 3.2, the default /bin/bash on macOS.)
PACKAGES=()
while IFS= read -r package_name; do
  [[ -n "${package_name}" ]] && PACKAGES+=("${package_name}")
done < <(
  node - "${REPO_ROOT}/packages" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
for (const dir of fs.readdirSync(root).sort()) {
  const manifestPath = path.join(root, dir, 'package.json')
  if (!fs.existsSync(manifestPath)) continue
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@')) continue
  if (manifest.private === true) continue
  process.stdout.write(manifest.name + '\n')
}
NODE
)

if [[ "${#PACKAGES[@]}" -eq 0 ]]; then
  echo "no publishable packages found under ${REPO_ROOT}/packages" >&2
  exit 1
fi

echo "repository: ${REPO}"
echo "workflow:   ${WORKFLOW_FILE}"
[[ -n "${ENVIRONMENT}" ]] && echo "environment: ${ENVIRONMENT}"
echo "packages:   ${#PACKAGES[@]}"
printf '  - %s\n' "${PACKAGES[@]}"

# npm trust only needs the registry and the per-user config; running it from a
# neutral directory keeps the repository's pnpm-only .npmrc out of npm's config
# warnings.
npm_trust() {
  ( cd / && npm trust "$@" )
}

# ---- list mode -------------------------------------------------------------
if [[ "${MODE}" == "list" ]]; then
  failed=()
  for name in "${PACKAGES[@]}"; do
    echo ""
    echo "== ${name} =="
    if ! npm_trust list "${name}"; then
      echo "   FAILED to list ${name} (not logged in?)" >&2
      failed+=("${name}")
    fi
  done
  if [[ "${#failed[@]}" -gt 0 ]]; then
    echo "" >&2
    echo "FAILED: ${failed[*]}" >&2
    exit 1
  fi
  exit 0
fi

# ---- configure -------------------------------------------------------------
TRUST_ARGS=(--file "${WORKFLOW_FILE}" --repo "${REPO}" --allow-publish --yes)
[[ -n "${ENVIRONMENT}" ]] && TRUST_ARGS+=(--env "${ENVIRONMENT}")
[[ "${MODE}" == "dry-run" ]] && TRUST_ARGS+=(--dry-run)

failed=()
for index in "${!PACKAGES[@]}"; do
  name="${PACKAGES[$index]}"
  echo ""
  echo "== configuring ${name} =="
  if npm_trust github "${name}" "${TRUST_ARGS[@]}"; then
    echo "   OK ${name}"
  else
    echo "   FAILED ${name}" >&2
    failed+=("${name}")
  fi
  # npm recommends spacing bulk trust calls to avoid rate limiting. A dry run
  # makes no calls, so it needs no delay.
  if [[ "${MODE}" != "dry-run" && "${index}" -lt "$(( ${#PACKAGES[@]} - 1 ))" ]]; then
    sleep 2
  fi
done

echo ""
if [[ "${#failed[@]}" -gt 0 ]]; then
  echo "FAILED: ${failed[*]}" >&2
  echo "If a package reports an existing configuration, run:" >&2
  echo "  npm trust list <package>          # find the id" >&2
  echo "  npm trust revoke <package> --id=<id>" >&2
  echo "Then rerun this script." >&2
  exit 1
fi

echo "All ${#PACKAGES[@]} packages configured for trusted publishing."
echo "Next: push a v* tag; .github/workflows/${WORKFLOW_FILE} publishes with OIDC."
