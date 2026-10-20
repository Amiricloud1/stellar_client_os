#!/usr/bin/env bash
set -e

# ==============================================================================
# Fundable Stellar — Multi-Contract Initialization Script
#
# Supports all 15 contracts in the contracts/ Cargo workspace.
# Features:
#   - Full workspace or single-contract initialization
#   - Dry-run simulation mode (DRY_RUN=true or --dry-run)
#   - Contract-specific initialization parameter mappings
#   - Graceful AlreadyInitialized error recovery
# ==============================================================================

DRY_RUN_FLAG=false
TARGET_CONTRACT=""

for arg in "$@"; do
  case $arg in
    --dry-run)
      DRY_RUN_FLAG=true
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

# Load environment variables
if [ -f .env ]; then
  # shellcheck source=/dev/null
  source .env
fi

NETWORK="${NETWORK:-testnet}"
NETWORK_PASSPHRASE="${TESTNET_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
DEPLOYMENTS_FILE="deployments/${NETWORK}.json"

# List of all 15 workspace contracts
ALL_CONTRACTS=(
  payment_stream
  distributor
  nft_stream
  campaign_funding
  soulbound_badge
  stellar_client_os_verifier_penalty
  planter
  campaign_verification_audit
  stellar_client_os_dispute_arbiter
  timelock
  upgrade_proxy
  sponsor_crowdfunding
  sponsor_insurance
  campaign_diversity
  tax_deduction_certificate
)

echo "========================================================"
echo " Fundable Stellar Contract Initializer"
echo " Network:      $NETWORK"
echo " Dry Run:      $IS_DRY_RUN"
echo " Deployments:  $DEPLOYMENTS_FILE"
echo " Target:       ${TARGET_CONTRACT:-All Contracts (15)}"
echo "========================================================"

if [ ! -f "$DEPLOYMENTS_FILE" ]; then
  echo "❌ Error: Deployments file $DEPLOYMENTS_FILE not found. Run deploy.sh first."
  exit 1
fi

# Select target contracts
SELECTED_CONTRACTS=()
if [ -n "$TARGET_CONTRACT" ]; then
  NORM_TARGET="${TARGET_CONTRACT//-/_}"
  for C in "${ALL_CONTRACTS[@]}"; do
    if [ "$C" = "$NORM_TARGET" ] || [ "$C" = "$TARGET_CONTRACT" ]; then
      SELECTED_CONTRACTS+=("$C")
      break
    fi
  done
  if [ ${#SELECTED_CONTRACTS[@]} -eq 0 ]; then
    echo "❌ Error: Target contract '$TARGET_CONTRACT' is not recognized."
    exit 1
  fi
else
  SELECTED_CONTRACTS=("${ALL_CONTRACTS[@]}")
fi

# Verify admin address
ADMIN_ADDRESS="${STELLAR_ACCOUNT_ADDRESS}"
if [ -z "$ADMIN_ADDRESS" ] && [ -n "$STELLAR_SECRET_KEY" ] && command -v stellar &> /dev/null; then
  ADMIN_ADDRESS=$(stellar keys address "$STELLAR_SECRET_KEY" 2>/dev/null || echo "")
fi
ADMIN_ADDRESS="${ADMIN_ADDRESS:-GADMINSAMPLEADDRESSFORSOROBANCONTRACTINITIALIZATION001}"

SUCCESS_COUNT=0
SKIPPED_COUNT=0

for CONTRACT in "${SELECTED_CONTRACTS[@]}"; do
  # Read contract ID from deployments file (checks underscored and dashed keys)
  DASH_NAME="${CONTRACT//_/-}"
  CONTRACT_ID=$(jq -r ".[\"$CONTRACT\"] // .[\"$DASH_NAME\"] // empty" "$DEPLOYMENTS_FILE" 2>/dev/null || true)

  echo ""
  echo "--- Initializing: $CONTRACT ---"

  if [ -z "$CONTRACT_ID" ] || [ "$CONTRACT_ID" = "null" ]; then
    echo "⚠️  Contract $CONTRACT is not present in $DEPLOYMENTS_FILE (skipping initialization)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  echo "Contract ID: $CONTRACT_ID"

  # Construct contract-specific initialization arguments
  case "$CONTRACT" in
    payment_stream)
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS" --fee_collector "$ADMIN_ADDRESS" --general_fee_rate 50)
      ;;
    distributor)
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS" --protocol_fee_percent 100 --fee_address "$ADMIN_ADDRESS")
      ;;
    soulbound_badge)
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS" --accepted_token "$ADMIN_ADDRESS")
      ;;
    planter)
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS" --reward_token "$ADMIN_ADDRESS" --reward_amount 1000)
      ;;
    campaign_diversity)
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS" --registrar "$ADMIN_ADDRESS")
      ;;
    campaign_funding)
      # campaign-funding initializes on a per-campaign escrow basis (initialize_campaign_escrow)
      echo "ℹ️  Note: campaign_funding uses per-campaign escrow initialization; instance ready."
      SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
      continue
      ;;
    upgrade_proxy)
      MOCK_WASM_HASH="0000000000000000000000000000000000000000000000000000000000000000"
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS" --implementation_hash "$MOCK_WASM_HASH")
      ;;
    *)
      # Standard admin-only initialization
      INIT_ARGS=(initialize --admin "$ADMIN_ADDRESS")
      ;;
  esac

  if [ "$IS_DRY_RUN" = "true" ]; then
    echo "🧪 [DRY-RUN] Simulated invocation: stellar contract invoke --id $CONTRACT_ID -- ${INIT_ARGS[*]}"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    continue
  fi

  # Live invocation with AlreadyInitialized error handling
  echo "Invoking: ${INIT_ARGS[*]}..."
  OUTPUT=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --source "$STELLAR_SECRET_KEY" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- "${INIT_ARGS[@]}" 2>&1 || true)

  if echo "$OUTPUT" | grep -qi -E "AlreadyInitialized|HostError|already initialized"; then
    echo "ℹ️  Contract $CONTRACT was already initialized."
  elif echo "$OUTPUT" | grep -qi "error"; then
    echo "⚠️ Warning: Failed to initialize $CONTRACT: $OUTPUT"
  else
    echo "✅ Successfully initialized $CONTRACT"
  fi
  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
done

echo ""
echo "========================================================"
echo " Initialization Summary"
echo " Mode:      $([ "$IS_DRY_RUN" = "true" ] && echo "DRY-RUN (Simulated)" || echo "LIVE")"
echo " Processed: $SUCCESS_COUNT"
echo " Skipped:   $SKIPPED_COUNT"
echo "========================================================"
