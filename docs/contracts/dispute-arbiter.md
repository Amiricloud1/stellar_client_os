# Dispute Arbiter Evidence and Resolution Rules

This document specifies the consensus model, evidence handling, deadlines, tie/timeout behavior, and terminal finality rules for the `dispute-arbiter` smart contract.

---

## 1. Consensus Model & Quorum

- **Arbiters Pool**: Exactly 5 independent arbiters are assigned per dispute upon creation (`REQUIRED_ARBITERS = 5`).
- **Consensus Threshold**: A majority threshold of 3 votes (`CONSENSUS_THRESHOLD = 3`) is required to achieve consensus.
- **Vote Choices**:
  - `Approve`: Approve milestone release to the freelancer.
  - `Reject`: Reject milestone release, returning funds to client.
  - `RequestEvidence`: Request clarifying evidence before making a final determination.

---

## 2. Evidence Submission & Authority

When arbiters request evidence or during an active voting window:
- **Eligible Submitters**: Strictly restricted to the disputed milestone's `client` and `freelancer`. Submissions from unrelated addresses are rejected with `ArbiterError::InvalidSubmitter`.
- **Submission Deadline**: Submissions must occur before `dispute.voting_deadline`. Late submissions are rejected with `ArbiterError::EvidenceDeadlineExpired`.
- **Duplicate Evidence Prevention**:
  - Each evidence item is identified by its cryptographic SHA-256 hash (`BytesN<32>`).
  - Attempting to submit an identical evidence hash for the same dispute is rejected with `ArbiterError::DuplicateEvidence`.
- **State Transition**: When evidence is submitted while a dispute is in `EvidenceRequested` state, the dispute state automatically transitions back to `Voting` so arbiters can review the submission.

---

## 3. Timeout, Ties & Finality

- **Voting Deadline**: Defaults to 7 days (`DEFAULT_VOTING_PERIOD_SECS = 604,800`).
- **Timeout Resolution**: If consensus is not reached before `voting_deadline`, `force_resolve_timeout` marks the dispute as `TimedOut`.
- **Terminal Finality**:
  - The states `Approved`, `Rejected`, and `TimedOut` are **terminal**.
  - Once a dispute reaches any terminal state, no further votes, evidence submissions, or timeout resolutions are permitted (`ArbiterError::AlreadyResolved`).
  - Terminal disputes cannot be resolved or transitioned twice under any condition.
