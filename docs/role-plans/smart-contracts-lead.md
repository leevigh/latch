# Smart Contracts Lead (You)
Timeline: Mon Mar 16, 2026 – Mon May 4, 2026

## Week 1 (Mar 16–Mar 22)
- Mon: Confirm contract scope and interfaces; list modules and their inputs/outputs.
- Tue: Set up verifier contract scaffolds; outline test plan for each verifier.
- Wed: Implement Ed25519 verifier core logic; add minimal unit tests.
- Thu: Implement secp256k1 verifier core logic; add minimal unit tests.
- Fri: Document verifier assumptions and external dependencies.
- Sat: Implement WebAuthn/P-256 verifier core logic; add minimal unit tests.
- Sun: Review tests, refactor for consistency, finalize week summary.

## Week 2 (Mar 23–Mar 29)
- Mon: Implement Smart Account base (CustomAccountInterface, SmartAccount, ExecutionEntryPoint).
- Tue: Add __check_auth pipeline and signer dispatch wiring.
- Wed: Implement context rules (scope + optional expiry).
- Thu: Implement policy hooks (spend limits, thresholds placeholders).
- Fri: Add auth flow unit tests for Smart Account core.
- Sat: Clean up error handling + invariants; update docs.
- Sun: Verify test suite green; prep for factory work.

## Week 3 (Mar 30–Apr 5)
- Mon: Implement factory contract skeleton and init flow.
- Tue: Add get_c_address deterministic derivation + tests.
- Wed: Add create_account atomic deploy + signer registration.
- Thu: Implement verifier lazy-deploy flow + tests.
- Fri: Integration tests for end-to-end account creation.
- Sat: Deploy to testnet staging; validate addresses.
- Sun: Fix any testnet issues; finalize integration tests.

## Week 4 (Apr 6–Apr 12)
- Mon: Expand integration tests for auth flows across verifiers.
- Tue: Add edge cases: expiry, invalid signer, policy rejection.
- Wed: Audit test coverage; fill gaps.
- Thu: Final testnet deployment + address verification.
- Fri: Prepare Deliverable 1 proof bundle (tests, addresses, notes).
- Sat: Internal walkthrough; document any caveats.
- Sun: Buffer day for fixes.

## Week 5 (Apr 13–Apr 19)
- Mon: Support wallet team integration (auth payload format checks).
- Tue: Fix signer auth edge cases found by wallet integration.
- Wed: Provide examples for auth payload construction.
- Thu: Debug any fee-bump interactions with auth.
- Fri: Verify end-to-end wallet + smart account flow.
- Sat: Update docs/notes as requested by PM.
- Sun: Buffer day.

## Week 6 (Apr 20–Apr 26)
- Mon: Triage integration bugs from wallet testing.
- Tue: Patch contracts if required; add regression tests.
- Wed: Confirm final testnet deployment consistency.
- Thu: Validate transaction history + auth entry serialization.
- Fri: Provide final technical notes for Deliverable 2 proof.
- Sat: Buffer day.
- Sun: Buffer day.

## Week 7 (Apr 27–May 3)
- Mon: Support final demo stability fixes.
- Tue: Review demo flow; confirm no contract regressions.
- Wed: Final documentation notes for Deliverable 2.
- Thu: Standby for last-minute fixes.
- Fri: Standby.
- Sat: Standby.
- Sun: Standby.
