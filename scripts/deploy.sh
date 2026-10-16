#!/usr/bin/env bash
set -e

#load contracts
CONTRACTS=(
  payment_stream
  distributor
)

# Load env vars
source .env

# ── Credential preflight (issue #108) ──
# Reject missing or mismatched credentials before touching the network so a
# testnet credential can never be used against mainnet (or vice versa).
validate_credentials() {
  local missing=0

  for var in NETWORK STELLAR_SECRET_KEY; do
    if [ -z "${!var}" ]; then
      echo "❌ Missing required credential: $var" >&2
      missing=1
    fi
  done

  case "${NETWORK:-}" in
    testnet) PASSPHRASE_VAR="TESTNET_NETWORK_PASSPHRASE" ;;
    mainnet) PASSPHRASE_VAR="MAINNET_NETWORK_PASSPHRASE" ;;
    *)
      echo "❌ NETWORK must be 'testnet' or 'mainnet' (got '${NETWORK:-}')" >&2
      missing=1
      PASSPHRASE_VAR=""
      ;;
  esac

  if [ -n "${PASSPHRASE_VAR:-}" ] && [ -z "${!PASSPHRASE_VAR:-}" ]; then
    echo "❌ Missing required credential: $PASSPHRASE_VAR" >&2
    missing=1
  fi

  # Network passphrase must match the expected value for the target network.
  case "${NETWORK:-}" in
    testnet) EXPECTED_PASSPHRASE="Test SDF Network ; September 2015" ;;
    mainnet) EXPECTED_PASSPHRASE="Public Global Stellar Network ; September 2015" ;;
    *) EXPECTED_PASSPHRASE="" ;;
  esac
  if [ -n "${EXPECTED_PASSPHRASE:-}" ] && [ "${!PASSPHRASE_VAR:-}" != "${EXPECTED_PASSPHRASE}" ]; then
    echo "❌ $PASSPHRASE_VAR does not match the ${NETWORK} network passphrase" >&2
    missing=1
  fi

  # Secret key format: Stellar secret keys start with 'S' and are 56 chars.
  if [ -n "${STELLAR_SECRET_KEY:-}" ]; then
    if [[ ! "${STELLAR_SECRET_KEY}" =~ ^S ]] || [ "${#STELLAR_SECRET_KEY}" -ne 56 ]; then
      echo "❌ STELLAR_SECRET_KEY must be a 56-character Stellar secret key starting with 'S'" >&2
      missing=1
    fi
  fi

  # Testnet/mainnet separation: the two networks must use distinct passphrases.
  if [ -n "${TESTNET_NETWORK_PASSPHRASE:-}" ] && [ -n "${MAINNET_NETWORK_PASSPHRASE:-}" ] \
     && [ "${TESTNET_NETWORK_PASSPHRASE}" = "${MAINNET_NETWORK_PASSPHRASE}" ]; then
    echo "❌ Testnet and mainnet passphrases must not match" >&2
    missing=1
  fi

  if [ "$missing" -ne 0 ]; then
    echo "❌ Aborting deployment due to missing or mismatched credentials" >&2
    exit 1
  fi
}

validate_credentials

DEPLOYMENTS_FILE="deployments/${NETWORK}.json"
case "${NETWORK}" in
  testnet) NETWORK_PARAPHRASE="${TESTNET_NETWORK_PASSPHRASE}" ;;
  mainnet) NETWORK_PARAPHRASE="${MAINNET_NETWORK_PASSPHRASE}" ;;
esac

echo "Deploying contract to $NETWORK..."

# Ensure deployments file exists
mkdir -p deployments
if [ ! -s "$DEPLOYMENTS_FILE" ]; then
  echo "{}" > "$DEPLOYMENTS_FILE"
fi

# Build contract
echo "🔧 Building contract..."
cd contracts
cargo build --release --target wasm32-unknown-unknown
cd ..

# Install Stellar CLI
cargo install --locked stellar-cli@25.0.0

# Deploy contract
for CONTRACT in "${CONTRACTS[@]}"; do
  WASM_PATH="contracts/target/wasm32-unknown-unknown/release/${CONTRACT}.wasm"

CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source "$STELLAR_SECRET_KEY" \
  --network "$NETWORK" \
  --network-passphrase "$NETWORK_PARAPHRASE")
  

echo "Deployed contract ID: $CONTRACT_ID"

# Get deployer address
DEPLOYER_ADDRESS=$(stellar keys address "$STELLAR_SECRET_KEY" 2>/dev/null || echo "unknown")

echo "Deployer address is: $DEPLOYER_ADDRESS"

# Save deployment address
jq --arg name "$CONTRACT" --arg id "$CONTRACT_ID" \
  '. + {($name): $id}' \
  "$DEPLOYMENTS_FILE" > tmp.json && mv tmp.json "$DEPLOYMENTS_FILE"

done

echo "Saved deployment to $DEPLOYMENTS_FILE"


# make the script executable using
# chmod +x scripts/deploy.sh