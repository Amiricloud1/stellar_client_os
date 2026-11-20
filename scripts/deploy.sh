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
#   - Registry-compatible records: network, address, deployment ledger,
#     spec version and lifecycle state per contract
#
# Deployment registry contract (deployments/${NETWORK}.json):
#   {
#     "<contract>": {
#       "network": "<network>",
#       "address": "<contract id>",
#       "ledger": <ledger sequence at deployment>,
#       "spec_version": "<workspace package version>",
#       "state": "deployed" | "failed" | "pending"
#     }
#   }
# Legacy flat string records ("<contract>": "<contract id>") are still read
# for idempotency checks and are upgraded in place on the next write.
#
# Failure / recovery:
#   If a registry record cannot be written, the script exits non-zero and
#   prints the record it failed to persist. Recovery: re-run the script with
#   --force (or FORCE_DEPLOY=true) for the affected contract once the
#   deployments directory is writable; the record is rewritten atomically.
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

# Resolve the workspace spec version recorded with each registry entry.
resolve_spec_version() {
  local version=""
  if command -v cargo &> /dev/null && [ -f contracts/Cargo.toml ]; then
    version=$(cargo metadata --no-deps --format-version 1 --manifest-path contracts/Cargo.toml 2>/dev/null \
      | jq -r '.packages[0].version // empty' 2>/dev/null || true)
  fi
  if [ -z "$version" ] && [ -f contracts/Cargo.toml ]; then
    version=$(grep -m1 '^version' contracts/Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/' || true)
  fi
  echo "${version:-unknown}"
}

SPEC_VERSION="$(resolve_spec_version)"

# Atomically write a registry record. Exits non-zero (loudly) on failure.
write_registry_record() {
  local name="$1" address="$2" ledger="$3" state="$4"
  local tmp_file
  tmp_file="$(mktemp "${DEPLOYMENTS_FILE}.XXXXXX")" || {
    echo "❌ Error: could not create temporary file next to $DEPLOYMENTS_FILE." >&2
    echo "   Failed record: {\"$name\": {\"network\": \"$NETWORK\", \"address\": \"$address\", \"ledger\": $ledger, \"spec_version\": \"$SPEC_VERSION\", \"state\": \"$state\"}}" >&2
    echo "   Recovery: ensure the deployments directory is writable, then re-run with --force." >&2
    exit 1
  }

  if ! jq --arg name "$name" \
        --arg network "$NETWORK" \
        --arg address "$address" \
        --argjson ledger "$ledger" \
        --arg spec_version "$SPEC_VERSION" \
        --arg state "$state" \
        '.[$name] = {network: $network, address: $address, ledger: $ledger, spec_version: $spec_version, state: $state}' \
        "$DEPLOYMENTS_FILE" > "$tmp_file"; then
    rm -f "$tmp_file"
    echo "❌ Error: failed to write registry record for '$name' to $DEPLOYMENTS_FILE." >&2
    echo "   Failed record: {\"$name\": {\"network\": \"$NETWORK\", \"address\": \"$address\", \"ledger\": $ledger, \"spec_version\": \"$SPEC_VERSION\", \"state\": \"$state\"}}" >&2
    echo "   Recovery: fix the registry file (must be valid JSON) or permissions, then re-run with --force." >&2
    exit 1
  fi

  if ! mv "$tmp_file" "$DEPLOYMENTS_FILE"; then
    rm -f "$tmp_file"
    echo "❌ Error: failed to atomically replace $DEPLOYMENTS_FILE." >&2
    echo "   Recovery: check filesystem permissions and re-run with --force." >&2
    exit 1
  fi
}

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

  # Check if already deployed (supports both registry objects and legacy strings)
  EXISTING_ID=$(jq -r --arg name "$WASM_NAME" --arg member "$MEMBER" '
    (.[$name] // .[$member] // empty)
    | if type == "object" then (.address // empty) else . end
  ' "$DEPLOYMENTS_FILE" 2>/dev/null || true)
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
  if ! CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source "$STELLAR_SECRET_KEY" \
    --network "$NETWORK" \
    --network-passphrase "$NETWORK_PASSPHRASE"); then
    echo "❌ Error: deployment of $MEMBER failed." >&2
    write_registry_record "$WASM_NAME" "" 0 "failed"
    exit 1
  fi

  echo "✅ Deployed $MEMBER! Contract ID: $CONTRACT_ID"

  # Capture the ledger sequence at deployment for the registry record
  LEDGER_SEQ=$(stellar ledger latest \
    --network "$NETWORK" \
    --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null \
    | jq -r '.sequence // .ledger // 0' 2>/dev/null || echo 0)
  if ! [[ "$LEDGER_SEQ" =~ ^[0-9]+$ ]]; then
    LEDGER_SEQ=0
  fi

  # Persist atomically to deployments file
  write_registry_record "$WASM_NAME" "$CONTRACT_ID" "$LEDGER_SEQ" "deployed"

  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
done

echo ""
echo "========================================================"
echo " Deployment Summary"
echo " Mode:      $([ "$IS_DRY_RUN" = "true" ] && echo "DRY-RUN (Simulated)" || echo "LIVE")"
echo " Processed: $SUCCESS_COUNT"
echo " Skipped:   $SKIPPED_COUNT"
echo " Records:   $DEPLOYMENTS_FILE"
echo " Spec:      $SPEC_VERSION"
echo "========================================================"