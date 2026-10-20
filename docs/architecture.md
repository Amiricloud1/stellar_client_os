# Fundable Stellar Architecture Guide

This document provides a comprehensive technical guide to the Fundable Stellar platform architecture, spanning the web application, TypeScript SDK, off-chain backend services, and all 15 Soroban smart contracts.

---

## 1. High-Level System Architecture

```mermaid
graph TD
    User([User / Sponsor / Planter]) --> WebFrontend[Web Frontend - Next.js]
    WebFrontend <--> BackendAPI[API Routes / Backend Services]
    WebFrontend --> SDK[TypeScript SDK - @fundable/sdk]
    BackendAPI --> SDK
    BackendAPI --> Storage[(IPFS / Pinata)]
    SDK --> SorobanRPC[Soroban RPC Node]
    SorobanRPC --> StellarNetwork((Stellar Blockchain))
    StellarNetwork --> SorobanContracts{Soroban 15-Contract Layer}
    WebFrontend <--> ExternalRails[External Bridge & Offramp Rails]

    subgraph "Client Layer"
        User
        WebFrontend
    end

    subgraph "Application & Service Layer"
        BackendAPI
        SDK
        Storage
    end

    subgraph "Decentralized On-Chain Layer"
        SorobanRPC
        StellarNetwork
        SorobanContracts
    end

    subgraph "Settlement & Liquidity Rails"
        ExternalRails
    end
```

### Core Layers
1. **Frontend (`apps/web`):** Next.js 15 client providing responsive UI for campaign management, tree planting verification, donor tax certificates, and offramp bank transfers.
2. **TypeScript SDK (`packages/sdk`):** Type-safe library abstracting Soroban contract interaction, transaction assembly, simulation, deterministic contract ID prediction, and polling.
3. **Soroban Smart Contracts (`contracts/*`):** 15 Rust-based Soroban contracts enforcing escrow holds, payment streaming, dynamic pricing, badges, slashing, arbitration, timelocks, and upgrades.
4. **Off-Chain Services & Storage:** Next.js route handlers, background email/push notification workers, IPFS metadata anchoring, and webhook dispatchers.

---

## 2. Smart Contract Inventory (15 Contracts)

The on-chain layer is organized as a Cargo workspace with 15 contracts:

```mermaid
graph TD
    subgraph "Core Funding & Escrow"
        CF[campaign-funding]
        SC[sponsor-crowdfunding]
        SI[sponsor-insurance]
        CD[campaign-diversity]
        TDC[tax-deduction-certificate]
    end

    subgraph "Payments & Streaming"
        PS[payment-stream]
        DI[distributor]
        NS[nft-stream]
    end

    subgraph "Verification & Performance"
        PL[planter]
        CVA[campaign-verification-audit]
        VP[verifier-penalty]
        SB[soulbound-badge]
    end

    subgraph "Governance & Infrastructure"
        DA[dispute-arbiter]
        TL[timelock]
        UP[upgrade-proxy]
    end
```

### Detailed Contract Specifications

| # | Workspace Member | Package Name | WASM Artifact | Description & Responsibilities |
|---|------------------|--------------|---------------|--------------------------------|
| 1 | `payment-stream` | `payment-stream` | `payment_stream.wasm` | Manages continuous linear token streaming between senders and recipients with rate-based unlocking, pause, cancel, and protocol fee collection. |
| 2 | `distributor` | `distributor` | `distributor.wasm` | Executes one-to-many token distributions with support for equal shares or weighted percentage splits, with automated fee deduction. |
| 3 | `nft-stream` | `nft-stream` | `nft_stream.wasm` | Enables streaming non-fungible tokens released according to time schedules or verified campaign milestone completions. |
| 4 | `campaign-funding` | `campaign-funding` | `campaign_funding.wasm` | Orchestrates crowdfunding campaigns, milestone escrow holds, dynamic surge pricing algorithms, planter allocations, and verified fund releases. |
| 5 | `soulbound-badge` | `soulbound-badge` | `soulbound_badge.wasm` | Issues non-transferable, identity-bound credential badges recognizing verified tree planters, milestone achievements, and high-impact donors. |
| 6 | `verifier-penalty` | `stellar-client-os-verifier-penalty` | `stellar_client_os_verifier_penalty.wasm` | Manages collateral staking and slashing penalties for campaign verification oracles who breach audit SLAs or submit fraudulent verifications. |
| 7 | `planter` | `planter` | `planter.wasm` | Maintains registered planter performance records, assigned planting sites, work proofs, and reward distribution eligibility. |
| 8 | `campaign-verification-audit` | `campaign-verification-audit` | `campaign_verification_audit.wasm` | Append-only, tamper-proof on-chain log of all site verification records, photo hashes, and auditor attestations. |
| 9 | `dispute-arbiter` | `stellar-client-os-dispute-arbiter` | `stellar_client_os_dispute_arbiter.wasm` | Multi-party dispute resolution engine capable of freezing escrow releases and adjudicating campaign milestone disputes via arbiter voting. |
| 10 | `timelock` | `timelock` | `timelock.wasm` | Enforces mandatory time delays on sensitive protocol administrative actions, allowing audit and governance cancellation prior to execution. |
| 11 | `upgrade-proxy` | `upgrade-proxy` | `upgrade_proxy.wasm` | UUPS-compatible upgrade proxy enabling zero-downtime Soroban contract logic upgrades while maintaining persistent storage state. |
| 12 | `sponsor-crowdfunding` | `sponsor-crowdfunding` | `sponsor_crowdfunding.wasm` | Implements quadratic funding and corporate matching grant pools for civic and environmental reforestation projects. |
| 13 | `sponsor-insurance` | `sponsor-insurance` | `sponsor_insurance.wasm` | Tree-loss protection and mortality insurance pool safeguarding sponsors against climate and environmental risks within a 2-year window. |
| 14 | `campaign-diversity` | `campaign-diversity` | `campaign_diversity.wasm` | Calculates ecological biodiversity indices (Simpson / Shannon), tracks native species ratios, and adjusts campaign incentive multipliers. |
| 15 | `tax-deduction-certificate` | `tax-deduction-certificate` | `tax_deduction_certificate.wasm` | Issues verifiable non-profit tax exemption certificates for charitable campaign contributions tied directly to on-chain transaction hashes. |

---

## 3. API Boundaries

The architecture maintains strict boundaries across communication interfaces:

### 1. Web Frontend <-> Next.js Route Handlers
- **Protocol:** HTTP/1.1 and HTTP/2 JSON REST & GraphQL (`/api/*`).
- **Authentication:** Stellar wallet cryptographic signatures verified via `@creit.tech/stellar-wallets-kit` and freighter extensions; API rate limits enforced by Redis / in-memory sliding window counters.
- **Payload Validation:** Strict Zod schemas on all API inputs before service-layer execution.

### 2. Service Layer <-> Webhook Delivery Subsystem
- **Endpoints:** `/api/webhooks/subscriptions`, `/api/webhooks/trigger`.
- **Integrity:** Payloads signed with HMAC-SHA256 (`X-Webhook-Signature`).
- **Idempotency:** Stable event identities (`eventId`, `verificationId`, `txHash`) deduplicated per subscriber.
- **Resilience:** Automatic exponential backoff retries with dead-letter queue (DLQ) logging.

### 3. TypeScript SDK <-> Soroban RPC Node
- **Protocol:** JSON-RPC over HTTPS (`https://soroban-testnet.stellar.org` or local network).
- **Transaction Assembly:** Builds XDR envelopes, sets sequence numbers, and manages resource footprint simulation.
- **Fee Buffer:** Applies a 1.2x safety multiplier on simulated resource fees to prevent mempool rejection under surge conditions.
- **Polling:** Transaction status polled via `getTransaction` with configurable timeouts and backoff intervals.

---

## 4. Trust Boundaries & Security Model

```mermaid
flowchart TD
    subgraph "Trust Boundary 1: User Custody"
        UserKey["User Private Key (Never Leaves Wallet)"]
        UserSign["Local XDR Signing"]
    end

    subgraph "Trust Boundary 2: Web / API Layer"
        Sanitizer["Zod Input Sanitizer"]
        RateLimiter["Rate Limiting & Admin Guard"]
    end

    subgraph "Trust Boundary 3: On-Chain Soroban Engine"
        AuthVerification["require_auth() Checks"]
        EscrowHolds["Locked Escrow / State Machine"]
    end

    subgraph "Trust Boundary 4: External Rails"
        BridgeLock["Allbridge Lock / Mint"]
        ProviderOfframp["Fiat Bank Payout"]
    end

    UserKey --> UserSign
    UserSign --> Sanitizer
    Sanitizer --> RateLimiter
    RateLimiter --> AuthVerification
    AuthVerification --> EscrowHolds
    EscrowHolds -.-> BridgeLock
    BridgeLock --> ProviderOfframp
```

### Trust Boundary Principles
1. **Zero Private-Key Exposure:** The frontend and backend never handle or store user secret keys. All transaction authorization is performed client-side by wallet software.
2. **On-Chain Authorization (`require_auth`):** Every mutating contract method verifies that the caller address authenticated the invocation. Contracts reject spoofed transactions immediately at the Soroban host boundary.
3. **Escrow Isolation:** Sponsor funds are held in campaign-specific escrow accounts. Funds cannot be released to campaign creators until authorized verifiers approve milestone proof attestations.
4. **Oracle & Verifier Slashing:** Verifiers must post collateral in `verifier-penalty`. Malicious, delinquent, or fraudulent attestations result in slashed stake and dispute arbitration.
5. **Bridge & Offramp Settlement:** Cross-chain bridge quotes enforce strict TTL windows (30s rate preview, 10m order expiry). Webhooks from fiat settlement providers require signature validation and strict idempotency deduplication to prevent replay exploits.

---

## 5. Current System Data Flows

### Flow 1: Campaign Creation, Dynamic Pricing & Funding
```mermaid
sequenceDiagram
    autonumber
    actor Sponsor
    participant UI as Web Frontend
    participant API as Next.js API
    participant Contract as campaign-funding
    participant RPC as Soroban RPC

    Sponsor->>UI: Select campaign & amount
    UI->>API: Query dynamic pricing multiplier
    API->>Contract: get_dynamic_pricing_multiplier_bps(id)
    Contract-->>API: Multiplier (e.g. 15000 bps = 1.5x)
    API-->>UI: Live dynamic quote
    Sponsor->>UI: Confirm & Sign Contribution
    UI->>RPC: Submit signed contribution transaction
    RPC->>Contract: contribute(sponsor, id, amount)
    Contract->>Contract: Escrow funds held
    Contract-->>UI: Transaction confirmed (ContributionMadeEvent)
```

### Flow 2: Planting Verification, Audit Log & Escrow Release
```mermaid
sequenceDiagram
    autonumber
    actor Planter
    actor Verifier
    participant UI as Web Frontend
    participant AuditContract as campaign-verification-audit
    participant FundContract as campaign-funding
    participant Storage as IPFS / Pinata

    Planter->>UI: Upload tree planting evidence (EXIF, GPS, Photos)
    UI->>Storage: Store photo blobs & generate IPFS hash
    Planter->>AuditContract: record_audit_log(campaign_id, ipfs_hash)
    Verifier->>UI: Review submitted planting evidence on-site
    Verifier->>FundContract: approve_tree_verification(campaign_id, tree_count)
    FundContract->>FundContract: Transition Escrow status to Verified
    FundContract->>FundContract: release_escrow_to_creator(campaign_id)
    FundContract-->>UI: Funds released to creator account
```

### Flow 3: Bridge & Offramp Fiat Settlement
```mermaid
sequenceDiagram
    autonumber
    actor Creator
    participant UI as Web Frontend
    participant Svc as Settlement Service
    participant Bridge as Allbridge Rail
    participant Provider as Offramp Partner (Cashwyre)
    participant Bank as Beneficiary Bank

    Creator->>UI: Initiate USDC offramp to bank account
    UI->>Svc: Get quote & validate quote expiry (< 30s)
    Creator->>UI: Sign Stellar bridge deposit tx
    UI->>Bridge: Lock Stellar USDC
    Bridge->>Provider: Mint / Release EVM liquidity to provider
    Provider->>Bank: Dispatch local fiat (NGN/GHS/KES)
    Provider->>Svc: Webhook callback (completed)
    Svc->>Svc: Deduplicate callbackId & reconcile state
    Svc-->>UI: Offramp confirmed complete
```

---

## 6. Architecture Maintenance & CI Verification

To guarantee that this architecture guide never diverges from the evolving contract workspace:

1. **Workspace Sync Rule:** Any addition, rename, or removal of a member in `contracts/Cargo.toml` must be matched by a corresponding entry in Section 2 above.
2. **Automated Verification:** The project includes an automated test check in `apps/web/src/__tests__/architecture-docs.test.ts` that:
   - Reads `contracts/Cargo.toml` to extract all active contract members.
   - Asserts that every contract member is documented in `docs/architecture.md`.
   - Validates that artifact WASM names and trust boundary sections are present.
3. **Execution Command:**
   ```bash
   pnpm --filter @fundable/web test src/__tests__/architecture-docs.test.ts
   ```
   This command is run in CI to block pull requests with undocumented contracts.
