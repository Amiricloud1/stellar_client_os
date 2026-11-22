# Git Workflow for Four Security Objectives

This document outlines the git workflow for implementing and reviewing the four security objectives. Follow this process to ensure clean commit history, proper code review, and seamless integration.

---

## Branch Strategy

Use feature branches for each objective, following this naming convention:

```
feat/objective-1-asset-validation
feat/objective-2-notice-periods
feat/objective-3-approval-governance
feat/objective-4-dispute-blocking
```

These branches will be merged **sequentially** after code review and testing.

---

## Phase 1: Objective 1 — Asset Validation

### 1. Create Feature Branch

```bash
cd /workspaces/stellar_client_os
git checkout -b feat/objective-1-asset-validation
```

### 2. Make Changes

Edit the following files:
- `contracts/campaign-funding/src/lib.rs` — Add validation logic
- `contracts/campaign-funding/src/test_token_validation.rs` — New file with tests

### 3. Test Locally

```bash
cd contracts/campaign-funding
cargo test test_token_validation --lib
cargo test --lib  # Verify no regressions
```

### 4. Commit

```bash
# Stage files
git add contracts/campaign-funding/src/lib.rs
git add contracts/campaign-funding/src/test_token_validation.rs

# Commit with conventional message
git commit -m "feat: Objective 1 - Asset validation before escrow acceptance

- Add token metadata validation (decimals 6 or 18 only)
- Implement transfer capability checks
- Add token whitelist mechanism with admin control
- Lock campaign to single token after first deposit
- Cache validation results for 90 days

Testing:
- 8 new test cases for token validation
- Verified no regressions in existing tests

Fixes: Campaigns accepting tokens without safety validation"
```

### 5. Build & Verify

```bash
# Build wasm artifact
cargo build --target wasm32-unknown-unknown --release

# Verify artifact
ls -lh target/wasm32-unknown-unknown/release/campaign_funding.wasm

# Run full test suite one more time
cargo test --lib
```

### 6. Push to Remote

```bash
git push -u origin feat/objective-1-asset-validation
```

### 7. Create Pull Request

On GitHub, create a PR with this template:

```markdown
## Summary
Implement Objective 1: Asset validation before escrow acceptance.

Validates token metadata (decimals, transfer restrictions) before accepting
campaign donations. Prevents acceptance of tokens with unsafe behaviors.

## Changes
- Campaign contract: Token validation + whitelist
- New: `ValidatedTokenMetadata` struct
- New: `validate_token_for_escrow()` function
- New: `whitelist_token()` admin function
- Modified: `deposit_to_campaign()` adds validation + lock
- Modified: `create_campaign()` checks token validity

## Testing
- 8 new test cases covering happy path, edge cases, and error conditions
- All existing tests pass (no regressions)
- Verified token validation caching (90-day TTL)
- Verified token lock after first deposit

## Backward Compatibility
✅ Backward compatible. New validation is gated by token whitelist.
Existing deployments continue to work; operators can whitelist tokens
as needed.

## Deployment
- Testnet: Ready
- Mainnet: After security audit approval

## Checklist
- [ ] Code review passed (2+ reviewers)
- [ ] All tests pass
- [ ] No regressions
- [ ] Wasm builds deterministically
- [ ] Documentation updated
```

### 8. Code Review

Wait for 2+ approvals. Address review feedback by:

```bash
# Make changes based on feedback
git add <changed-files>
git commit -m "fix: Address code review feedback

- Fix: Remove unnecessary clone in token validation
- Docs: Clarify whitelist initialization
- Tests: Add edge case for boundary decimals"

# Push updated commits
git push
```

### 9. Merge to Main

Once approved:

```bash
# Update main
git checkout main
git pull origin main

# Merge feature branch
git merge feat/objective-1-asset-validation

# Push merged main
git push origin main

# Clean up feature branch
git push origin --delete feat/objective-1-asset-validation
git branch -d feat/objective-1-asset-validation
```

---

## Phase 2: Objective 2 — Notice & Claim Periods

### 1. Create Feature Branch (Rebase on Main)

```bash
git checkout main
git pull origin main
git checkout -b feat/objective-2-notice-periods
```

### 2-9. Repeat Process (same as Objective 1)

After Objective 1 is merged, repeat the 9-step workflow for Objective 2.

**Key differences:**
- Branch name: `feat/objective-2-notice-periods`
- Files modified: `contracts/campaign-funding/src/lib.rs` (additional changes)
- New test file: `test_notice_periods.rs`
- Commit message: "feat: Objective 2 - Notice and claim periods..."

---

## Phases 3 & 4: Repeat for Objectives 3 & 4

Follow the same 9-step process, sequentially:

### Objective 3: Approval Governance
- Branch: `feat/objective-3-approval-governance`
- Contract: `contracts/dispute-arbiter/src/lib.rs`
- Depends on: Objectives 1-2 merged

### Objective 4: Dispute Blocking
- Branch: `feat/objective-4-dispute-blocking`
- Contract: `contracts/payment-stream/src/lib.rs`
- Depends on: Objectives 1-3 merged

---

## Commit Message Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer]
```

### Examples

**Feature:**
```
feat(campaign-funding): add token validation for escrow safety

- Validate decimals (6 or 18 only)
- Check transfer capability
- Whitelist mechanism

Fixes: #123
```

**Bug fix:**
```
fix(dispute-arbiter): prevent threshold change during active votes

ActiveDisputeCount was not decremented on dispute resolution,
allowing governance changes mid-voting.

Fixes: #456
```

**Documentation:**
```
docs(payment-stream): clarify dispute blocking behavior

Added examples of blocked operations during disputes.
```

---

## Code Review Checklist

When reviewing PRs, verify:

### Functionality
- [ ] Feature works as described
- [ ] Tests pass locally
- [ ] No regressions in existing tests
- [ ] Edge cases handled

### Code Quality
- [ ] Follows project style guide
- [ ] Functions documented (doc comments)
- [ ] Error handling complete
- [ ] No unnecessary complexity

### Security
- [ ] Auth checks on sensitive functions
- [ ] No overflow/underflow vulnerabilities
- [ ] No reentrancy issues
- [ ] Storage keys don't collide
- [ ] No hardcoded secrets

### Testing
- [ ] Happy path covered
- [ ] Error paths tested
- [ ] Boundary conditions tested
- [ ] Integration tests included

### Documentation
- [ ] README updated
- [ ] Inline comments clear
- [ ] No obvious typos

---

## Common Git Workflows

### Sync Feature Branch with Updated Main

```bash
git fetch origin
git rebase origin/main
```

### Squash Commits Before Merge

If you have multiple commits and want to squash:

```bash
# Interactive rebase last 3 commits
git rebase -i HEAD~3

# Mark commits as "squash" (or "s")
# Save and merge the commit messages

git push --force-with-lease origin feat/objective-1-asset-validation
```

### View All Commits on Feature Branch

```bash
git log --oneline main..feat/objective-1-asset-validation
```

### Create Backup Before Major Rebase

```bash
git branch backup/feat/objective-1-asset-validation
```

### Revert Committed Changes

```bash
# Revert a single commit (safe; creates new commit)
git revert <commit-hash>

# Undo local unpushed commits (destructive)
git reset --hard <commit-hash>
```

---

## CI/CD Integration

The repository uses GitHub Actions. Every commit triggers:

1. **Lint checks**: `cargo clippy`
2. **Build**: `cargo build --release`
3. **Tests**: `cargo test --lib`
4. **Security scan**: Secret scanning, dependency audit
5. **Artifact reproducibility**: Verify wasm builds deterministically

All checks must pass before merging to main.

### Monitor CI Status

```bash
# View CI runs
gh run list --repo Amiricloud1/stellar_client_os

# View details of failed run
gh run view <run-id>

# Re-run failed checks
gh run rerun <run-id>
```

---

## Release Process

After all four objectives are merged:

### 1. Create Release Branch

```bash
git checkout main
git pull origin main
git checkout -b release/security-objectives-v1.0.0
```

### 2. Update Version

Update `package.json` and `Cargo.toml`:

```json
{
  "version": "1.0.0",
  "description": "Security objectives: asset validation, notice periods, governance, dispute blocking"
}
```

### 3. Generate Changelog

```bash
git log --oneline v0.9.0..release/security-objectives-v1.0.0 > CHANGELOG_new.md
# Manually organize and review
```

### 4. Commit Version Bump

```bash
git add package.json Cargo.toml CHANGELOG.md
git commit -m "chore: release v1.0.0 - security objectives

Four security objectives implemented:
1. Asset validation before escrow acceptance
2. Notice and claim periods for fund recovery
3. Immutable governance snapshots for disputes
4. Timelock and dispute blocking for payouts"
```

### 5. Create Release PR

```bash
git push -u origin release/security-objectives-v1.0.0
# Create PR on GitHub
```

### 6. Merge Release PR

After final approval:

```bash
git checkout main
git pull origin main
git merge release/security-objectives-v1.0.0
git tag -a v1.0.0 -m "Security objectives: asset validation, notice periods, governance, dispute blocking"
git push origin main --tags
```

### 7. Create GitHub Release

On GitHub, create a release linked to tag `v1.0.0` with:
- Release notes (from CHANGELOG)
- Artifacts (wasm files)
- Security audit summary

---

## Troubleshooting

### Merge Conflict

```bash
# During rebase
git status  # See conflicted files
# Edit files to resolve conflicts
git add <resolved-files>
git rebase --continue
```

### Force Push Needed (Only on Feature Branches!)

```bash
git push --force-with-lease origin feat/objective-1-asset-validation
```

⚠️ Never force-push to `main` or `develop`.

### Accidentally Committed to Main

```bash
# On main, undo last commit (keep changes)
git reset --soft HEAD~1

# Create feature branch with those changes
git checkout -b feat/objective-1-asset-validation
git commit -m "..."
git push -u origin feat/objective-1-asset-validation

# Reset main to origin
git checkout main
git reset --hard origin/main
```

### Lost Commits

```bash
# View reflog to find lost commits
git reflog

# Restore branch to a previous state
git reset --hard <commit-from-reflog>
```

---

## Git Configuration Tips

### Set Default Branch Protections

```bash
# Require PR reviews before merge
gh repo edit --add-topic security-objectives

# View branch rules
gh api repos/Amiricloud1/stellar_client_os/branches/main/protection
```

### Useful Aliases

Add to `~/.gitconfig`:

```ini
[alias]
  co = checkout
  br = branch
  ci = commit
  st = status
  unstage = reset HEAD --
  last = log -1 HEAD
  visual = log --graph --oneline --all
```

Then use:
```bash
git co feat/objective-1-asset-validation
git ci -m "message"
git visual
```

---

## Sign-Off

Before merging each phase, verify:

**Implementer**: ✅ All tests pass locally; code meets style guide

**Code Reviewer 1**: ✅ Code review passed; no blockers

**Code Reviewer 2**: ✅ Code review passed; no blockers

**Tech Lead**: ✅ Approved for merge to main

---

## Questions?

Refer to:
- Git docs: `git help <command>`
- GitHub CLI: `gh help`
- Conventional Commits: https://www.conventionalcommits.org/
- Project CONTRIBUTING.md: `/CONTRIBUTING.md`

