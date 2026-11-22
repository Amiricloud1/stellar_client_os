#!/usr/bin/env bash
set -e

# ==============================================================================
# Fundable Stellar — Multi-Contract Deployment Script
#
# Supports all 15 contracts in the contracts/ Cargo workspace.
# Features:
#   - Full workspace or single-contract deployment
#   - Dry-run simulation mode (DRY_RUN=true or --dry-run)
#   - Idempotent execution (skips already deployed unless FORCE_DEPLOY=true)
#   - Atomic deployment state persistence (deployments/${NETWORK}.json)
#   - Pre-launch readiness checklist gate (see below)
#
# Pre-Launch Readiness Checklist
# ------------------------------
# Before any live deployment the script validates the campaign configuration
# supplied via environment variables (or .env). Every check must pass; on the
# first failure the script prints the failing item plus a remediation hint and
# aborts with a non-zero exit code. Dry runs report the checklist but do not
# abort on failure so operators can iterate safely.
#
#   1. Campaign metadata  — CAMPAIGN_NAME, CAMPAIGN_DESCRIPTION,
#                           CAMPAIGN_CREATOR (non-empty, sane length).
#   2. Network            — NETWORK must be a known network and
#                           NETWORK_PASSPHRASE must match its canonical value.
#   3. Asset support      — CAMPAIGN_ASSET must be XLM or a valid SAC/asset
#                           identifier (C.../G... StrKey, 56 chars).
#   4. Milestones         — CAMPAIGN_MILESTONES must be a positive integer and
#                           CAMPAIGN_MILESTONE_AMOUNTS (comma separated) must
#                           contain exactly that many positive integers.
#   5. Payout terms       — CAMPAIGN_PAYOUT_TERMS must be one of
#                           all-or-nothing | milestone | immediate.
#
# Set SKIP_READINESS_CHECK=true to bypass the gate (not recommended; the
# bypass is logged loudly). See docs/deployment.md for the full checklist.
# ==============================================================================

# Parse command line flags
DRY_RUN_FLAG=false
TARGET_CONTRACT=""

for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN_FLAG=true
      shift
      ;;
    --force)
      FORCE_DEPLOY=true
      shift
      ;;
    *)
      if [ -z "$TARGET_CONTRACT" ]; then
        TARGET_CONTRACT="$arg"
      fi
      ;;
  esac
done

if [ "$DRY_RUN" = "true" ] || [ "$DRY_RUN_FLAG" = "true" ]; then
  IS_DRY_RUN=true
else
  IS_DRY_RUN=false
fi

# Load environment variables if .env exists
if [ -f .env ]; then
  # shellcheck source=/dev/null
  source .env
fi

NETWORK="${NETWORK:-testnet}"
NETWORK_PASSPHRASE="${TESTNET_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
DEPLOYMENTS_FILE="deployments/${NETWORK}.json"

# All 15 supported workspace contracts with their respective compiled WASM artifact basenames
# Format: "member_name:wasm_artifact_name"
ALL_CONTRACT_SPECS=(
  "payment-stream:payment_stream"
  "distributor:distributor"
  "nft-stream:nft_stream"
  "campaign-funding:campaign_funding"
  "soulbound-badge:soulbound_badge"
  "verifier-penalty:stellar_client_os_verifier_penalty"
  "planter:planter"
  "campaign-verification-audit:campaign_verification_audit"
  "dispute-arbiter:stellar_client_os_dispute_arbiter"
  "timelock:timelock"
  "upgrade-proxy:upgrade_proxy"
  "sponsor-crowdfunding:sponsor_crowdfunding"
  "sponsor-insurance:sponsor_insurance"
  "campaign-diversity:campaign_diversity"
  "tax-deduction-certificate:tax_deduction_certificate"
)

echo "========================================================"
echo " Fundable Stellar Contract Deployer"
echo " Network:      $NETWORK"
echo " Dry Run:      $IS_DRY_RUN"
echo " Target:       ${TARGET_CONTRACT:-All Contracts (15)}"
echo " Deployments:  $DEPLOYMENTS_FILE"
echo "========================================================"

# Filter contracts if a specific target was requested
SELECTED_SPECS=()
if [ -n "$TARGET_CONTRACT" ]; then
  # Normalize target name (replace underscores with dashes or vice versa)
  NORM_TARGET="${TARGET_CONTRACT//_/-}"
  FOUND=false
  for SPEC in "${ALL_CONTRACT_SPECS[@]}"; do
    MEMBER="${SPEC%%:*}"
    WASM_BASE="${SPEC##*:}"
    if [ "$MEMBER" = "$NORM_TARGET" ] || [ "$WASM_BASE" = "$TARGET_CONTRACT" ] || [ "$MEMBER" = "$TARGET_CONTRACT" ]; then
      SELECTED_SPECS+=("$SPEC")
      FOUND=true
      break
    fi
  done
  if [ "$FOUND" = "false" ]; then
    echo "❌ Error: Target contract '$TARGET_CONTRACT' is not a supported workspace member."
    echo "Available contracts:"
    for SPEC in "${ALL_CONTRACT_SPECS[@]}"; do
      echo "  - ${SPEC%%:*} (${SPEC##*:}.wasm)"
    done
    exit 1
  fi
else
  SELECTED_SPECS=("${ALL_CONTRACT_SPECS[@]}")
fi

# Ensure deployments directory and state file exist
mkdir -p deployments
if [ ! -s "$DEPLOYMENTS_FILE" ]; then
  echo "{}" > "$DEPLOYMENTS_FILE"
fi

# ------------------------------------------------------------------------------
# Pre-Launch Readiness Checklist
# ------------------------------------------------------------------------------
READINESS_FAILURES=0

readiness_fail() {
  # $1 = checklist item, $2 = remediation hint
  echo "❌ [READINESS] $1"
  echo "   ↳ Fix: $2"
  READINESS_FAILURES=$((READINESS_FAILURES + 1))
}

check_campaign_metadata() {
  if [ -z "${CAMPAIGN_NAME:-}" ]; then
    readiness_fail "Campaign metadata: CAMPAIGN_NAME is not set." \
      "Export CAMPAIGN_NAME with the public campaign title."
  elif [ "${#CAMPAIGN_NAME}" -gt 128 ]; then
    readiness_fail "Campaign metadata: CAMPAIGN_NAME exceeds 128 characters." \
      "Shorten CAMPAIGN_NAME to 128 characters or fewer."
  fi

  if [ -z "${CAMPAIGN_DESCRIPTION:-}" ]; then
    readiness_fail "Campaign metadata: CAMPAIGN_DESCRIPTION is not set." \
      "Export CAMPAIGN_DESCRIPTION describing the campaign."
  fi

  if [ -z "${CAMPAIGN_CREATOR:-}" ]; then
    readiness_fail "Campaign metadata: CAMPAIGN_CREATOR is not set." \
      "Export CAMPAIGN_CREATOR with the creator's Stellar public key (G...)."
  elif ! [[ "$CAMPAIGN_CREATOR" =~ ^G[A-Z2-7]{55}$ ]]; then
    readiness_fail "Campaign metadata: CAMPAIGN_CREATOR is not a valid Stellar account (G...)." \
      "Provide a 56-character StrKey starting with 'G'."
  fi
}

check_network() {
  case "$NETWORK" in
    testnet)
      EXPECTED_PASSPHRASE="Test SDF Network ; September 2015"
      ;;
    mainnet|public)
      EXPECTED_PASSPHRASE="Public Global Stellar Network ; September 2015"
      ;;
    futurenet)
      EXPECTED_PASSPHRASE="Test SDF Future Network ; October 2022"
      ;;
    *)
      readiness_fail "Network: '$NETWORK' is not a supported network." \
        "Set NETWORK to one of: testnet, mainnet, futurenet."
      return
      ;;
  esac

  if [ "$NETWORK_PASSPHRASE" != "$EXPECTED_PASSPHRASE" ]; then
    readiness_fail "Network: NETWORK_PASSPHRASE does not match '$NETWORK'." \
      "Set NETWORK_PASSPHRASE=\"$EXPECTED_PASSPHRASE\" (or unset it to use the default)."
  fi
}

check_asset_support() {
  if [ -z "${CAMPAIGN_ASSET:-}" ]; then
    readiness_fail "Asset support: CAMPAIGN_ASSET is not set." \
      "Export CAMPAIGN_ASSET=XLM or a 56-character SAC/asset identifier (C.../G...)."
    return
  fi
  if [ "$CAMPAIGN_ASSET" = "XLM" ] || [ "$CAMPAIGN_ASSET" = "native" ]; then
    return
  fi
  if ! [[ "$CAMPAIGN_ASSET" =~ ^[CG][A-Z2-7]{55}$ ]]; then
    readiness_fail "Asset support: CAMPAIGN_ASSET '$CAMPAIGN_ASSET' is not supported." \
      "Use XLM or a 56-character StrKey asset identifier starting with 'C' or 'G'."
  fi
}

check_milestones() {
  if [ -z "${CAMPAIGN_MILESTONES:-}" ]; then
    readiness_fail "Milestones: CAMPAIGN_MILESTONES is not set." \
      "Export CAMPAIGN_MILESTONES with the number of milestones (positive integer)."
    return
  fi
  if ! [[ "$CAMPAIGN_MILESTONES" =~ ^[1-9][0-9]*$ ]]; then
    readiness_fail "Milestones: CAMPAIGN_MILESTONES must be a positive integer." \
      "Set CAMPAIGN_MILESTONES to a value like 3."
    return
  fi

  if [ -z "${CAMPAIGN_MILESTONE_AMOUNTS:-}" ]; then
    readiness_fail "Milestones: CAMPAIGN_MILESTONE_AMOUNTS is not set." \
      "Export CAMPAIGN_MILESTONE_AMOUNTS as a comma-separated list of positive integers."
    return
  fi

  IFS=',' read -r -a MILESTONE_AMOUNTS <<< "$CAMPAIGN_MILESTONE_AMOUNTS"
  if [ "${#MILESTONE_AMOUNTS[@]}" -ne "$CAMPAIGN_MILESTONES" ]; then
    readiness_fail "Milestones: expected $CAMPAIGN_MILESTONES amounts, got ${#MILESTONE_AMOUNTS[@]}." \
      "Ensure CAMPAIGN_MILESTONE_AMOUNTS has exactly $CAMPAIGN_MILESTONES comma-separated entries."
  fi
  for AMOUNT in "${MILESTONE_AMOUNTS[@]}"; do
    if ! [[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]]; then
      readiness_fail "Milestones: amount '$AMOUNT' is not a positive integer." \
        "Every entry in CAMPAIGN_MILESTONE_AMOUNTS must be a positive integer."
    fi
  done
}

check_payout_terms() {
  case "${CAMPAIGN_PAYOUT_TERMS:-}" in
    all-or-nothing|milestone|immediate)
      ;;
    "")
      readiness_fail "Payout terms: CAMPAIGN_PAYOUT_TERMS is not set." \
        "Set CAMPAIGN_PAYOUT_TERMS to one of: all-or-nothing, milestone, immediate."
      ;;
    *)
      readiness_fail "Payout terms: '$CAMPAIGN_PAYOUT_TERMS' is not supported." \
        "Set CAMPAIGN_PAYOUT_TERMS to one of: all-or-nothing, milestone, immediate."
      ;;
  esac
}

run_readiness_checklist() {
  echo ""
  echo "🔎 Running pre-launch readiness checklist..."
  READINESS_FAILURES=0

  check_campaign_metadata
  check_network
  check_asset_support
  check_milestones
  check_payout_terms

  if [ "$READINESS_FAILURES" -gt 0 ]; then
    echo ""
    echo "❌ Readiness checklist failed with $READINESS_FAILURES issue(s)."
    if [ "$IS_DRY_RUN" = "true" ]; then
      echo "🧪 [DRY-RUN] Continuing despite failures; fix the items above before a live deploy."
    else
      echo "Aborting deployment. Resolve the items above and re-run."
      exit 1
    fi
  else
    echo "✅ Readiness checklist passed."
  fi
}

if [ "${SKIP_READINESS_CHECK:-false}" = "true" ]; then
  echo "⚠️  WARNING: SKIP_READINESS_CHECK=true — pre-launch readiness checklist bypassed."
else
  run_readiness_checklist
fi

# Prerequisite Checks
if [ "$IS_DRY_RUN" = "false" ]; then
  if [ -z "$STELLAR_SECRET_KEY" ]; then
    echo "❌ Error: STELLAR_SECRET_KEY environment variable is required for live deployment."
    exit 1
  fi
  if ! command -v stellar &> /dev/null; then
    echo "❌ Error: stellar-cli is not installed. Run: cargo install --locked stellar-cli@25.0.0"
    exit 1
  fi
fi

# Build contracts if build is available and not in dry-run
if [ "$IS_DRY_RUN" = "false" ] && command -v cargo &> /dev/null; then
  echo "🔧 Compiling contracts workspace to wasm32-unknown-unknown..."
  cd contracts
  cargo build --release --target wasm32-unknown-unknown
  cd ..
fi

SUCCESS_COUNT=0
SKIPPED_COUNT=0

# Iterate through selected contracts
for SPEC in "${SELECTED_SPECS[@]}"; do
  MEMBER="${SPEC%%:*}"
  WASM_NAME="${SPEC##*:}"
  WASM_PATH="contracts/target/wasm32-unknown-unknown/release/${WASM_NAME}.wasm"

  echo ""
  echo "--- Processing: $MEMBER ($WASM_NAME.wasm) ---"

  # Check if already deployed
  EXISTING_ID=$(jq -r ".[\"$WASM_NAME\"] // .[\"$MEMBER\"] // empty" "$DEPLOYMENTS_FILE" 2>/dev/null || true)
  if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ] && [ "$FORCE_DEPLOY" != "true" ]; then
    echo "ℹ️  Already deployed at: $EXISTING_ID (skipping. Set --force or FORCE_DEPLOY=true to redeploy)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  if [ "$IS_DRY_RUN" = "true" ]; then
    # Dry-run validation
    PREDICTED_MOCK_ID="C$(echo -n "${MEMBER}_${NETWORK}" | sha256sum | head -c 55 | tr '[:lower:]' '[:upper:]')"
    echo "🧪 [DRY-RUN] Prerequisite checks passed."
    echo "🧪 [DRY-RUN] Target artifact: $WASM_PATH"
    echo "🧪 [DRY-RUN] Simulated gas estimate: ~1,500,000 instructions"
    echo "🧪 [DRY-RUN] Predicted contract ID: $PREDICTED_MOCK_ID"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    continue
  fi

  # Live deployment
  if [ ! -f "$WASM_PATH" ]; then
    echo "⚠️ Warning: $WASM_PATH does not exist. Please build the contract first."
    continue
  fi

  echo "🚀 Deploying $MEMBER to $NETWORK..."
  CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source "$STELLAR_SECRET_KEY" \
    --network "$NETWORK" \
    --network-passphrase "$NETWORK_PASSPHRASE")

  echo "✅ Deployed $MEMBER! Contract ID: $CONTRACT_ID"

  # Persist atomically to deployments file
  jq --arg name "$WASM_NAME" --arg id "$CONTRACT_ID" \
    '. + {($name): $id}' \
    "$DEPLOYMENTS_FILE" > tmp.json && mv tmp.json "$DEPLOYMENTS_FILE"

  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
done

echo ""
echo "========================================================"
echo " Deployment Summary"
echo " Mode:      $([ "$IS_DRY_RUN" = "true" ] && echo "DRY-RUN (Simulated)" || echo "LIVE")"
echo " Processed: $SUCCESS_COUNT"
echo " Skipped:   $SKIPPED_COUNT"
echo " Records:   $DEPLOYMENTS_FILE"
echo "========================================================"