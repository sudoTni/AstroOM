#!/usr/bin/env bash
# AstroOM launcher (Linux / macOS / WSL).
#
# Applies the tuned policy argv and execs the astroom binary. Any arguments
# you pass are appended *last* so they override the defaults, which is what the
# binary's `args_override_self` expects.
#
# The launcher does NOT change directory. Path resolution belongs to the
# executable, which locates its own resources relative to itself; changing the
# working directory here would mask that and break any relative path you pass.
set -euo pipefail

# Bash 3.2 (macOS) lacks BASH_SOURCE[0] safety nets and `readarray`.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

die() {
  printf 'astro_launcher: %s\n' "$*" >&2
  exit 1
}

# --- locate the binary ------------------------------------------------------
# Order matters: an explicit override, then a co-located install (the
# distribution layout), then a staged build under ./bin, then the in-tree
# cargo build output, then PATH. ./bin/astroom is checked before target/ so a
# deliberately staged release build is not shadowed by a stale target/ binary.
find_binary() {
  local candidate
  if [[ -n "${ASTROOM_BIN:-}" ]]; then
    if [[ -x "${ASTROOM_BIN}" ]]; then
      printf '%s\n' "${ASTROOM_BIN}"
      return 0
    fi
    die "ASTROOM_BIN is set to '${ASTROOM_BIN}', which is not an executable file."
  fi
  for candidate in \
    "${SCRIPT_DIR}/astroom" \
    "${SCRIPT_DIR}/../bin/astroom" \
    "${SCRIPT_DIR}/bin/astroom"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  # When both release and debug in-tree targets exist, pick the newer one so
  # debug iterations aren't masked by an older release build.
  if [[ -x "${SCRIPT_DIR}/target/release/astroom" && -x "${SCRIPT_DIR}/target/debug/astroom" ]]; then
    if [[ "${SCRIPT_DIR}/target/debug/astroom" -nt "${SCRIPT_DIR}/target/release/astroom" ]]; then
      printf '%s\n' "${SCRIPT_DIR}/target/debug/astroom"
      return 0
    else
      printf '%s\n' "${SCRIPT_DIR}/target/release/astroom"
      return 0
    fi
  elif [[ -x "${SCRIPT_DIR}/target/release/astroom" ]]; then
    printf '%s\n' "${SCRIPT_DIR}/target/release/astroom"
    return 0
  elif [[ -x "${SCRIPT_DIR}/target/debug/astroom" ]]; then
    printf '%s\n' "${SCRIPT_DIR}/target/debug/astroom"
    return 0
  fi
  if command -v astroom >/dev/null 2>&1; then
    command -v astroom
    return 0
  fi
  cat >&2 <<EOF
astro_launcher: could not find the astroom binary.

Searched, in order:
  \$ASTROOM_BIN
  ${SCRIPT_DIR}/astroom
  ${SCRIPT_DIR}/../bin/astroom
  ${SCRIPT_DIR}/bin/astroom
  ${SCRIPT_DIR}/target/release/astroom
  ${SCRIPT_DIR}/target/debug/astroom
  astroom on PATH

Build one with:  cargo build --release
or set \$ASTROOM_BIN to its full path.
EOF
  return 1
}

# --- configuration ----------------------------------------------------------
load_env_file() {
  local env_file="${SCRIPT_DIR}/.env"
  [[ -f "${env_file}" ]] || return 0
  printf ':: sourcing %s\n' "${env_file}"
  # shellcheck disable=SC1090
  source "${env_file}"
  printf ':: ...sourced %s\n' "${env_file}"
}

# Resolved before anything destructive happens, so a missing binary never costs
# you the previous run's logs.
ASTROOM="$(find_binary)" || exit 1

load_env_file

: "${AOM_OR_API_KEY:?Set AOM_OR_API_KEY in ${SCRIPT_DIR}/.env before running LLM stages.}"

if [[ "${AOM_CLEAN_LOGS:-1}" == "1" ]]; then
  printf ':: cleaning %s/logs/\n' "${SCRIPT_DIR}"
  mkdir -p "${SCRIPT_DIR}/logs"
  rm -rf "${SCRIPT_DIR}"/logs/*
  printf ':: ...cleaned %s/logs/\n' "${SCRIPT_DIR}"
fi

# --- policy argv ------------------------------------------------------------
# Mirrors the tuned defaults; every one of these is overridable by a trailing
# caller argument.
PROFILE_DIR="${AOM_PROFILE_DIR:-${SCRIPT_DIR}/candidate_data}"

ARGS=(
  run-pipeline
  --job-provider indeed,linkedin
  --search-terms-file "${PROFILE_DIR}/search_terms.txt"
  --api-key "$AOM_OR_API_KEY"
  --jobcloth-preset "jc_glm-5.3-flash"
  --remoteeval-preset "re_glm-5.3-flash"
  --jobjudge-preset "jep_glm-5.3-flash"
  --makematerials-preset "rop_glm-5.3-flash"
  --batch 10 --sleep 2 --results-wanted 200 --hours-old 24
  --jc-provider astro_auto_provider --jc-provider-quant fp8 --jc-reasoning-effort low
  --re-provider astro_auto_provider --re-provider-quant fp8 --re-reasoning-level high
  --jj-provider astro_auto_provider --j-provider-quant fp8 --jj-reasoning-effort high
  --mm-provider astro_auto_provider --mm-provider-quant fp8 --mm-reasoning-effort high
  --astro_auto_provider-top 3
  --provider-ignore baseten/fp8
  --remote-only true --track-or-costs --internet-watchdog --log-cool-offs
)

# Optional explicit directory redirection. Passed as absolute paths so they are
# unambiguous regardless of the caller's working directory.
[[ -n "${AOM_DATA_DIR:-}" ]] && ARGS+=(--data-dir "$AOM_DATA_DIR")
[[ -n "${AOM_LOG_DIR:-}" ]] && ARGS+=(--log-dir "$AOM_LOG_DIR")
[[ -n "${AOM_MATERIALS_DIR:-}" ]] && ARGS+=(--materials-dir "$AOM_MATERIALS_DIR")
if [[ -n "${AOM_PROFILE_DIR:-}" ]]; then
  ARGS+=(--profile-dir "$AOM_PROFILE_DIR")
  # Replaces the default entry appended above rather than duplicating it.
  for i in "${!ARGS[@]}"; do
    if [[ "${ARGS[$i]}" == "--search-terms-file" ]]; then
      ARGS[$((i + 1))]="${AOM_PROFILE_DIR}/search_terms.txt"
      break
    fi
  done
fi

[[ "${AOM_CLEAN:-0}" == "1" ]] && ARGS+=(--clean)
if [[ "${AOM_DEPLOY:-0}" == "1" ]]; then
  : "${AOM_DEPLOY_DESTINATION:?Set AOM_DEPLOY_DESTINATION, e.g. GoogleDrive:/autoJobGen-src}"
  ARGS+=(--deploy --deploy-destination "$AOM_DEPLOY_DESTINATION")
fi

printf ':: exec %s %s ...\n' "${ASTROOM}" "${ARGS[0]}" >&2
exec "${ASTROOM}" "${ARGS[@]}" "$@"
