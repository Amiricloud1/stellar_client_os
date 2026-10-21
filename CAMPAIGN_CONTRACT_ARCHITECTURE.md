# Campaign Contract Architecture

This document describes how the campaign contracts are organized in the Cargo
workspace, how their wasm artifacts are built, and how the deployment tooling
derives the set of deployable contracts.

## Workspace layout

All campaign contracts live in a single Cargo workspace. Each deployable
contract is a workspace member with its own `Cargo.toml` and a `cdylib` crate
type so it can be compiled to wasm.

```
contracts/
  Cargo.toml            # [workspace] members = [...]
  campaign/             # deployable contract
  campaign-registry/    # deployable contract
  ...                   # additional deployable members
```

The workspace `members` list is the single source of truth for which contracts
exist. Do not maintain a separate hand-written list of contracts in the build or
deploy tooling.

## Building wasm artifacts

The build step compiles every deployable workspace member to wasm and writes the
resulting artifacts to a predictable output directory (for example
`target/wasm32-unknown-unknown/release/<crate>.wasm`).

### Deriving the deployable set

The build/deploy tooling derives the deployable contract set from the Cargo
workspace metadata rather than from a hardcoded list:

1. Read the workspace members (e.g. via `cargo metadata`).
2. Select the members that are deployable contracts (crates that produce a wasm
   artifact).
3. Build each selected member for the `wasm32-unknown-unknown` target.
4. Collect the resulting `<crate>.wasm` artifacts into the artifact set used by
   deployment.

This means adding a new deployable contract to the workspace automatically
includes it in the build and deployment artifact set — no tooling change is
required.

### Failure conditions

The build MUST fail (non-zero exit) when either of the following holds:

- **Omitted deployable member:** a deployable workspace member is not present in
the artifact set. This catches tooling that silently drops a contract.
- **Missing wasm artifact:** a deployable member's expected wasm artifact does
  not exist in the output directory after the build. This catches build failures
  or misconfigured crate types that would otherwise deploy stale or missing
  code.

Both checks are validated in CI so that a workspace change cannot land with an
incomplete artifact set.

## Testing

Automated coverage for the build tooling is deterministic and does not depend on
live funds or a running network. Tests cover:

- **Success:** every deployable workspace member is discovered and its wasm
  artifact is present in the artifact set.
- **Failure — omitted member:** a deployable member missing from the artifact
  set causes the build to fail.
- **Failure — missing artifact:** a deployable member whose wasm file is absent
  causes the build to fail.
- **Boundary cases:** an empty deployable set and a workspace with a single
  deployable member are handled correctly.

## CI

CI runs the wasm build for all deployable workspace members and executes the
build-tooling tests above. A green CI run therefore guarantees that the artifact
set matches the workspace and that every deployable contract's wasm was built.

## Migration / compatibility notes

- The previous two-contract hardcoded build list is replaced by the
  workspace-derived set. Any contract that was previously built only because it
  appeared in the hardcoded list must be a workspace member to keep being built.
- New deployable contracts must be added as workspace members with a `cdylib`
  crate type; they are then picked up automatically.
- Non-deployable workspace members (libraries, test helpers) are excluded from
  the artifact set by the deployable-member selection rule.
