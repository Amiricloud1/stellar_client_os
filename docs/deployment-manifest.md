# Deployment Manifest Schema

The deployment manifest (`deployments/manifest.json`) is the **authoritative record** of every contract deployment to a Stellar network. It is validated automatically on every CI run and must be kept up to date after each deploy.

---

## Purpose

The manifest provides:

- A **human- and machine-readable** record of what was deployed, to which network, from which source.
- A ground truth for **address validation**: the SDK, scripts, and tests all derive contract addresses from this file.
- A **chain identity anchor**: the `wasmHash` and `ledger` fields tie the running contract to a specific on-chain state.
- An **audit trail** for the mainnet deployment approval checklist (`docs/mainnet-deployment-checklist.md`).

---

## Schema Reference

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DeploymentManifest",
  "description": "Authoritative record of a Soroban contract deployment on a Stellar network.",
  "type": "object",
  "required": ["network", "networkPassphrase", "contracts", "deployedAt"],
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "network": {
      "type": "string",
      "enum": ["testnet", "mainnet", "custom"],
      "description": "Target Stellar network identifier."
    },
    "networkPassphrase": {
      "type": "string",
      "minLength": 10,
      "description": "Full network passphrase used to sign transactions (e.g. 'Public Global Stellar Network ; September 2015')."
    },
    "rpcUrl": {
      "type": "string",
      "format": "uri",
      "description": "Soroban RPC endpoint used for this deployment."
    },
    "deployedAt": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 UTC timestamp of when the deployment was completed."
    },
    "deployer": {
      "type": "string",
      "pattern": "^G[A-Z2-7]{55}$",
      "description": "Stellar public address (G…) of the deploying account."
    },
    "contracts": {
      "type": "object",
      "description": "Map of contract names to their deployment metadata.",
      "minProperties": 1,
      "additionalProperties": {
        "$ref": "#/$defs/ContractEntry"
      }
    }
  },
  "$defs": {
    "ContractEntry": {
      "type": "object",
      "required": ["contractId", "wasmHash", "version", "ledger", "txHash"],
      "additionalProperties": false,
      "properties": {
        "contractId": {
          "type": "string",
          "pattern": "^C[A-Z2-7]{55}$",
          "description": "On-chain Soroban contract address (C…, base-32 encoded)."
        },
        "wasmHash": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$",
          "description": "SHA-256 hex hash of the installed WASM binary (64 lowercase hex chars)."
        },
        "version": {
          "type": "string",
          "description": "Semantic version of the contract, matching the Cargo.toml version field."
        },
        "ledger": {
          "type": "integer",
          "minimum": 1,
          "description": "Stellar ledger sequence number at which the deployment was confirmed."
        },
        "txHash": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$",
          "description": "Transaction hash of the deploy operation (64 lowercase hex chars)."
        },
        "initTxHash": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$",
          "description": "Transaction hash of the initialization call, if applicable."
        },
        "sourceCommit": {
          "type": "string",
          "pattern": "^[0-9a-f]{40}$",
          "description": "Full git commit SHA of the source code used to build this WASM."
        }
      }
    }
  }
}
```

---

## Field Reference

### Top-Level Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `network` | ✅ | `"testnet" \| "mainnet" \| "custom"` | Target Stellar network |
| `networkPassphrase` | ✅ | `string` | Full passphrase used when signing deployment transactions |
| `rpcUrl` | — | `string (URI)` | Soroban RPC endpoint used |
| `deployedAt` | ✅ | `string (date-time)` | UTC ISO 8601 timestamp of completion |
| `deployer` | — | `string (G…)` | Public address of the deploying Stellar account |
| `contracts` | ✅ | `object` | Map of contract name → `ContractEntry` |

### ContractEntry Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `contractId` | ✅ | `string (C…)` | On-chain Soroban contract address |
| `wasmHash` | ✅ | `string (64 hex)` | SHA-256 of the WASM binary installed on-chain |
| `version` | ✅ | `string` | SemVer version from `Cargo.toml` |
| `ledger` | ✅ | `integer ≥ 1` | Ledger sequence at deployment confirmation |
| `txHash` | ✅ | `string (64 hex)` | Transaction hash of the deploy operation |
| `initTxHash` | — | `string (64 hex)` | Transaction hash of the `initialize` call |
| `sourceCommit` | — | `string (40 hex)` | Git commit SHA of the source used to build the WASM |

---

## Address Validation Rules

The CI workflow (`docs-validate.yml`) enforces the following:

1. Every `contractId` must match the regex `^C[A-Z2-7]{55}$` (valid Stellar Soroban contract address).
2. Every `deployer` must match the regex `^G[A-Z2-7]{55}$` (valid Stellar account address).
3. Every `wasmHash` must be 64 lowercase hex characters.
4. Every `txHash` must be 64 lowercase hex characters.
5. `network` must be one of: `testnet`, `mainnet`, `custom`.
6. The `networkPassphrase` must not be empty.
7. For `mainnet` manifests, `deployer` must be explicitly set.

These rules are checked by `scripts/validate-manifest.ts` (run as part of CI).

---

## Canonical Examples

### `deployments/testnet.json` (current)

```json
{
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "deployedAt": "2026-01-01T00:00:00Z",
  "deployer": "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  "contracts": {
    "payment_stream": {
      "contractId": "CA3DIUFFHMAWENXSH2NBI7OVOQ7MU6LZMKHRV5ABWGIT24IUG3QKGIJX",
      "wasmHash": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "version": "0.1.0",
      "ledger": 1234567,
      "txHash": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
    },
    "distributor": {
      "contractId": "CBX5CH2GDKOXXCHTR6OSPYM3HZX3PP2GJI7FYGGHREA232D2F7WV75IH",
      "wasmHash": "b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5f6a7b2c3d4e5f6a7b2c3",
      "version": "0.1.0",
      "ledger": 1234568,
      "txHash": "bbccddeeff00112233445566778899aabbccddeeff00112233445566778899aa"
    }
  }
}
```

### `deployments/mainnet.json` (template — fill in after deployment)

```json
{
  "network": "mainnet",
  "networkPassphrase": "Public Global Stellar Network ; September 2015",
  "rpcUrl": "https://mainnet.sorobanrpc.com",
  "deployedAt": "YYYY-MM-DDTHH:MM:SSZ",
  "deployer": "G...",
  "contracts": {
    "payment_stream": {
      "contractId": "C...",
      "wasmHash": "<64-char lowercase hex>",
      "version": "0.1.0",
      "ledger": 0,
      "txHash": "<64-char lowercase hex>",
      "sourceCommit": "<40-char git sha>"
    }
  }
}
```

---

## Keeping the Manifest Up to Date

### After a testnet or mainnet deploy

`scripts/deploy.sh` automatically updates the deployment record when a contract is deployed. Run it via:

```bash
NETWORK=testnet ./scripts/deploy.sh
```

The script writes the returned `contractId` into `deployments/${NETWORK}.json` using `jq`. After the deploy, update `deployments/manifest.json` manually (or via a helper) with the full metadata (`wasmHash`, `version`, `ledger`, `txHash`, `sourceCommit`).

### After a contract upgrade

Re-run the deploy step for the upgraded contract and update `wasmHash`, `version`, `ledger`, `txHash`, and `sourceCommit` in the manifest.

---

## Compatibility and Migration Notes

- **v0.1.0 → v0.2.0+**: If the `contractId` changes (new deployment, not an upgrade), update the manifest and re-run `pnpm --filter @fundable/sdk generate:mainnet` to regenerate bindings from the live contract.
- The legacy flat `deployments/testnet.json` format (`{ "payment_stream": "C…", … }`) is still accepted by `initialize.sh` for backward compatibility. New deployments should use the full manifest format.
- Adding new contract entries to `contracts` does not break existing consumers; fields are additive.

---

## CI Integration

The workflow `docs-validate.yml` runs `scripts/validate-manifest.ts --check` on every push and pull request that touches `deployments/`. See [`Automated coverage`](./mainnet-deployment-checklist.md) for details.
