Products & Services

Latch is an end-to-end, open-source infrastructure stack that eliminates the two adoption blockers preventing C-address (Soroban Smart Account) usage today: the inability to fund a C-address without a G-address, and the absence of production-grade wallet tooling built around the OpenZeppelin Smart Account standard.

The stack is delivered as five decoupled, production-grade components — each a standalone ecosystem primitive, and together a complete onboarding and account management system for any wallet, dApp, or on-ramp that wants to support C-addresses.

1 - Smart Account Contract Suite:
The on-chain foundation. Three Soroban contracts implementing the full lifecycle of C-address creation, multi-curve authentication, and programmable authorization — built directly on OpenZeppelin's CustomAccountInterface SmartAccount standard.

Smart Account Contract

Implements OpenZeppelin's CustomAccountInterface, SmartAccount, and ExecutionEntryPoint traits. Uses Soroban's native __check_auth hook to enforce programmable, composable authorization organized around three concerns:

    What (Context Rules): permissions scoped to specific contracts, functions, or any context — with optional expiration by ledger sequence and configurable lifetime.

    Who (Signers): External signers backed by verifier contracts supporting any cryptographic curve — Ed25519, secp256k1, secp256r1/P-256 — plus Delegated signers for G-account and nested C-account composition.

    How (Policies): pluggable enforcement modules for spending limits, multisig thresholds, time restrictions, session-based access, and custom business logic.

All authorization logic is enforced on-chain. Trust boundaries are auditable and not dependent on any off-chain service.

Signature Verifier Suite

A family of stateless, immutable verifier contracts implementing OpenZeppelin's Verifier trait — deployed once, shared across all Smart Accounts:

    Ed25519 Verifier: supports Phantom, any standard Ed25519 hardware key, and any Ed25519-based ecosystem wallet signing authorization payloads directly.

    secp256k1 Verifier: supports MetaMask, Rabby, and any Ethereum-ecosystem wallet. Users sign with wallets they already have on other chains — no new account required.

    WebAuthn / Passkey Verifier: supports Face ID, Touch ID, Windows Hello, and hardware security keys via the secp256r1/P-256 curve. No seed phrase, no browser extension — just a biometric or device PIN authorizing a Stellar transaction.

Swapping the verifier is all it takes to add a new signing scheme. The Smart Account logic stays identical across all of them.

Factory Contract

Deterministically deploys and initializes Smart Accounts in a single call using Soroban's deployer_with_address. Key capabilities:

    get_c_address(user_pubkey, …) pre-computes the future C-address before deployment, enabling wallets, on-ramps, and escrow rails to fund the account before it exists.

    create_account(user_pubkey, verifier, …) deploys, initializes the Smart Account, and registers the user's chosen signer in one atomic operation.

    Lazy-deploys shared verifier contracts on first use, minimizing per-ecosystem deployment overhead.

    Outcome: one-call provisioning that turns C-address creation into a single, deterministic primitive — usable by on-ramps, CEX integrations, and wallet providers without any manual contract management.

2 - Latch Bridge (G -> C Forwarding Protocol):

A non-custodial, on-chain forwarding protocol that routes funds from G-addresses directly to C-addresses — making the G-address step transparent to end users.

How it works:

A proxy G-address is generated deterministically from the user's C-address. When funds arrive at that G-address — from a CEX withdrawal, fiat on-ramp, or existing Stellar wallet — a relay service detects the deposit and immediately forwards funds to the target C-address, funding the account for fees in the same operation.

The forwarding logic is verifiable on-chain. The relay is non-custodial — it routes but never holds funds. The user sees only a destination address and a funded account.

Supported funding paths:

    CEX withdrawal (any exchange supporting Stellar/XLM)

    Fiat on-ramp → G-address → C-address (compatible with existing on-ramp rails)

    Existing Stellar wallet (G-address holders migrating to Smart Accounts)

    Cross-chain bridge integrations for users arriving from other ecosystems

    Outcome: any existing funding rail becomes a C-address funding rail. The onboarding gap closes entirely — users who have never touched Stellar can land directly in a Smart Account.

3- Latch Wallet (Reference C-address Wallet):
A production-grade reference wallet implementation demonstrating the full Smart Account tooling stack — at parity with Freighter, built for C-addresses from the ground up.

Core capabilities:

    Account creation: create a Smart Account using a Passkey (Face ID / Touch ID), an ecosystem wallet (Phantom, MetaMask, Rabby), or a hardware key — zero seed phrase, zero G-address required from the user.

    Token support: full token balances, asset list, and portfolio view for the Smart Account — matching existing Stellar wallet feature parity.

    Transfer history: complete on-chain transaction history scoped to the C-address, including incoming and outgoing transfers across all asset types.

    Send and receive: token transfers authorized via the user's registered signer — Passkey biometric, external wallet signature, or multisig approval flow.

    Session key management: create, view, and revoke scoped session keys aligned with on-chain context rules — giving users visibility into what each dApp can do.

    Gas abstraction: fee sponsorship via Stellar fee bump transactions, so users never need to hold XLM to transact.

    G→C migration flow: guided onboarding for existing Stellar users migrating from a G-address to a Smart Account, with asset bridging built in.

Available on web and mobile (React Native).

    Outcome: proves end-to-end feasibility, provides a UX baseline for the ecosystem, and serves as the reference implementation against which all SDK integrations are tested.

4 - Latch Onboarding Kit:
A standard, open-source onboarding kit that any wallet provider or dApp can embed to add C-address support — without reimplementing the flow from scratch.

Pre-built UI components:

    Signer selection screen (Passkey / MetaMask / Phantom / hardware key)

    G→C migration flow with asset bridging step

    C-address creation confirmation with deterministic address preview

    Fee funding step with sponsorship or bridge fallback

    Session key creation and permission review UI

Transaction builders and helpers:

    Authorization payload construction for Smart Account operations

    Verifier-agnostic signing pipeline: build payload → route to any external signer → package response into correct Soroban auth entry format — abstracting the full two-phase simulation and auth construction flow from integrators.

    Context rule management: create, update, and remove authorization rules

    Policy configuration helpers for threshold, spending limit, and session policies

Bridge integration adapters:

    Drop-in connectors for existing Stellar bridge integrations

    CEX withdrawal flow with memo-based routing to the forwarding proxy

    On-ramp SDK hooks for fiat → C-address paths

Mobile SDK:

React Native compatible. All core flows — account creation, signing, session management, bridge funding — available on mobile without additional integration work.

    Outcome: turns Smart Account onboarding into a copy-paste primitive. A wallet that wants to support C-addresses drops in the SDK, wires up their signer, and ships — without auditing Soroban auth construction from scratch.

5 - Developer Tooling & Documentation:
The full test suite, reference scripts, and documentation required for the ecosystem to build on Latch confidently.

    Test suite: unit and integration tests for all three contracts, covering auth flows, verifier correctness, factory deployment, policy enforcement, and edge cases.

    Reference scripts: end-to-end flow scripts in TypeScript demonstrating every integration pattern — CEX funding, multi-signer setup, session key creation, policy configuration — executable against testnet.

    SDK documentation: full API reference, integration guides, and example implementations for web and mobile.

    Audit-ready contracts: contracts structured for external security audit, with documented trust assumptions, access control boundaries, and upgrade policies.

    Ecosystem integration examples: worked integrations showing how an existing Stellar wallet (Freighter-style) and a Soroban dApp each integrate the Latch stack.

Requested Budget

$120.0K
Traction Evidence

We built a working proof of concept demonstrating the core authorization primitive that Latch is built on. The Ed25519 verifier and a Smart Account are deployed on Stellar testnet, with a Next.js demo app showing a Phantom wallet authorizing a Stellar Smart Account transaction end-to-end — no Stellar wallet, no seed phrase, no XLM in the user's hands.

Concretely: the app connects Phantom, reads the user's 32-byte Ed25519 public key, constructs a Stellar authorization payload, passes it to Phantom for signing, packages the raw 64-byte signature into the correct Soroban Signer::External auth entry format, and submits. The on-chain Ed25519 verifier confirms the signature. The Smart Account authorizes the call. Fees are covered by a bundler via Stellar's fee bump mechanism. The full two-phase simulation flow (recording mode → enforcing mode) is implemented correctly — not a shortcut.

Deployed testnet contracts:

ContractAddressEd25519 VerifierCBNCF7QBTMIAEIZ3H6EN6JU5RDLBTFZZKGSWPAXW6PGPNY3HHIW5HKCHCounter (demo target)CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U

3000 Labs is a three-person technical team with consistent, demonstrated depth in the Stellar and Soroban ecosystem. Our track record reflects sustained, hands-on engagement with the ecosystem — not a team arriving fresh to chase a grant.

We have active open source contributions across multiple Stellar ecosystem projects through OnlyDust, GrantFox, and related programs — work that is publicly verifiable on-chain and on GitHub.

We have multiple hackathon wins building on Stellar, most notably at the UnitedEFi hackathon where we built an HTLC smart contract facilitating atomic swaps between an EVM chain and Stellar — a technically demanding cross-chain primitive that required deep understanding of both Soroban contract mechanics and EVM interoperability. Additional wins from the Building on Stellar hackathon track demonstrate consistent execution under competitive conditions.

Our prior Soroban contract work is the direct foundation for this submission. The Smart Account contract suite, verifier architecture, and signing pipeline in Latch are not theoretical — they are extensions of work we have already built, tested, and deployed to testnet.

We are building Latch because we ran into these onboarding problems ourselves. The G-to-C gap is real friction we have experienced directly while building on Stellar. That context informs the design of every component.
Tranche 1 (Deliverable Roadmap) - MVP

Deliverable 1: Smart Account Contract Suite — Feature Complete

Brief description:

    Ed25519, secp256k1, and WebAuthn/Passkey verifier contracts finalized, implementing OpenZeppelin's Verifier trait — deployed once, shared across accounts.

    Smart Account implements OZ CustomAccountInterface, SmartAccount, and ExecutionEntryPoint with full context rule support: scoped permissions, optional expiry, policy hooks.

    Factory contract with get_c_address (deterministic pre-computation) and create_account (atomic deploy + signer registration).

    Full unit and integration test suite covering auth flows, verifier correctness, factory deployment, policy enforcement, and edge cases.

Proof of completion: All contracts compile, pass the full test suite, and deploy to Stellar testnet. Test suite is publicly available in the open source repository. Verifier contracts are independently callable and verifiable on-chain.

Estimated completion: 4 weeks after approval

Budget: $12,000

Deliverable 2: Reference Wallet — Core Onboarding Flow

Brief description:

    Account creation via Passkey (WebAuthn browser API) and external ecosystem wallets (Phantom/Ed25519, MetaMask/secp256k1) — no seed phrase, no G-address required from the user.

    G→C onboarding flow: deterministic C-address preview, Bridge funding step, Smart Account deployment, signer registration — presented as a single guided flow.

    Bundler-sponsored fee abstraction via Stellar fee bump transactions.

    Basic send and receive for XLM and Stellar assets.

Proof of completion: User can arrive with no Stellar account, create a Smart Account using a Passkey or ecosystem wallet, fund it through the Bridge, and execute a token transfer on testnet — entirely without a G-address or XLM pre-balance.

Estimated completion: 7 weeks after approval

Budget: $20,000
Tranche 2 (Deliverable Roadmap) - Testnet

Deliverable 3: Latch Bridge — G→C Forwarding Protocol

Brief description:

    Non-custodial proxy G-address generated deterministically from the user's C-address.

    Relay service: monitors deposits, routes funds to the target C-address, funds XLM for fees in the same operation.

    Compatible with CEX withdrawals, fiat on-ramp rails, and existing Stellar wallet sends.

    Bridge contract with verifiable on-chain forwarding logic — relay is non-custodial.

Proof of completion: A CEX-style G-address withdrawal and a direct Stellar wallet send both route correctly to the target C-address on testnet. Relay service is publicly documented and open source.

Estimated completion: 11 weeks after approval Budget: $20,000

Deliverable 4: Wallet Feature Parity + Session Keys

Brief description:

    Full token balance display for all assets held by the C-address.

    Complete transfer history scoped to the Smart Account.

    Session key management UI: create, review, and revoke scoped signing permissions aligned with on-chain context rules — contract allowlists, spend limits, time windows.

    Policy configuration UI for threshold and spending limit policies.

    Mobile-responsive web wallet.

Proof of completion: Wallet displays token balances and history at parity with Freighter. Session key can be created with scope restrictions and used by a test dApp to execute a scoped transaction. UI reviewed against Freighter feature checklist.

Estimated completion: 14 weeks after approval Budget: $18,000

Deliverable 5: dApp Interaction Flow

Brief description:

    Stable wallet URL endpoint: dApps redirect users with a signing request, wallet signs via registered signer, redirects back with signed authorization entry.

    Transaction review UI with human-readable operation display before signing.

    Support for oversized payloads via Stellar Expert's refractor.space store-and-forward integration.

Proof of completion: A sample dApp sends an unsigned transaction to the wallet via both URL-embedded XDR and refractor.space. Wallet displays it for review, user signs with their registered signer, signed transaction executes on testnet, dApp receives the result.

Estimated completion: 16 weeks after approval

Budget: $14,000
Tranche 3 (Deliverable Roadmap) - Mainnet

Deliverable 6: Mainnet Deployment + Audit Fixes

Brief description:

    Deploy all contracts to Stellar mainnet.

    Address all critical and high findings from SCF-provided security audit.

    Publish final audit report alongside mainnet contract addresses.

Proof of completion: Contracts live on mainnet. Audit report published. All critical and high findings resolved and documented.

Estimated completion: June 14, 2026 Budget: $16,000

Deliverable 7: Onboarding SDK + Documentation

Brief description:

    Open-source TypeScript SDK (@latch/sdk) with pre-built components for G→C onboarding, Smart Account operations, verifier-agnostic signing pipeline, session key management, and Bridge integration.

    React Native compatible — all core flows available on mobile.

    Full developer documentation: SDK API reference, contract ABIs, integration guides, and architecture documentation.

Proof of completion: SDK published to npm. Documentation site live. SDK successfully used to add C-address onboarding to a test integration without any manual Soroban auth construction.

Estimated completion: June 19, 2026 Budget: $12,000

Deliverable 8: Example Integrations + Ecosystem Handoff

Brief description:

    At least two reference integrations: one showing an existing Stellar wallet adding C-address support via the SDK, one showing a Soroban dApp requesting Smart Account authorization.

    Ecosystem wallet outreach: documentation and direct support materials for wallet providers integrating the Onboarding Kit.

    All repositories finalized, licensed MIT, and handed off to the public.

Proof of completion: Two example integrations published and publicly runnable. Outreach documentation published. All repos open source and fully documented.

Estimated completion: June 19, 2026

Budget: $8,000
Team

Frankie — Lead Developer & Blockchain Architect Smart contract and cross-chain infrastructure developer with production systems across Stacks, Cronos, SKALE, Stellar, and EVM chains. Built HTLC atomic swaps, encrypted payment proxies, ZK verification toolkits, and Layer 2 payment channels. Experienced with MetaMask, Phantom, and Rabby wallet signing schemes. Leads Latch's Soroban contract development, relay service, and SDK architecture.

GitHub: https://github.com/frankiepower

X: x.com/frankyejezie

Kachi — Frontend & Blockchain Developer React/TypeScript and Solidity developer specializing in wallet interfaces and Web3 frontend systems. Built production dApp UIs with multi-wallet integration, token display rendering, transaction event parsing, and component library development. Leads Latch Wallet implementation, SDK UI components, onboarding flow, and cross-wallet sign-in frontend.

LinkedIn: https://www.linkedin.com/in/kachukwu-michael-esenwa

GitHub: https://github.com/kcmikee

Lexie — Designer & Project Manager Product designer and PM with experience delivering Web3 products from concept to launch. Skilled in user research, design systems, and developer documentation for blockchain tooling. Leads Latch's onboarding kit UX, wallet design, API documentation, developer guides, and ecosystem wallet coordination with Freighter and Lobstr.

Portfolio: https://www.linkedin.com/in/alexander-ejezie/

Tranche payments:
Approved
Initial Award Distribution

Once Projects pass necessary KYC/KYB checks, they receive 10% of their total requested budget.

mvp
Tranche #1

When teams have completed their first tranche of deliverables, they'll submit them for review. Once deliverable completion is confirmed, projects will then receive 20% of their total requested budget. 

Testnet
Tranche #2

Completed Tranche #2 deliverables unlock an additional 20% of the team's total budget. Eligible projects also get access to the audit bank at this time. 

Tranche #3 - Live on Mainnet

When a project is live on Stellar Mainnet (or equivalent), they receive the remaining 40% of their budget, as well as access to the Growth Hack program, professional user testing, Marketing Grants, and more. 