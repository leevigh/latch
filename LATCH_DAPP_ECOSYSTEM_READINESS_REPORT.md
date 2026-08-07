# Latch dApp ecosystem readiness report

**Research date:** 21 July 2026  
**Purpose:** Define what Latch can do today and the technical, ecosystem, security, and partnership work required for Latch Wallet to appear in Stellar wallet selectors and work with third-party dApps such as Blend.

## Executive summary

Latch has already proved the hard account-abstraction primitive:

- a Latch C-address smart account can be controlled by a passkey or external signer;
- a dApp that deliberately integrates `window.latch` can connect to the extension;
- that dApp can provide an unsigned Soroban transaction XDR;
- Latch can prepare the C-account authorization, show it for approval, sign it, and either submit it or return an assembled signed transaction;
- Latch context rules can restrict which signer may call which contract.

Latch is **not yet a drop-in Stellar wallet for arbitrary existing dApps**. Today, a dApp must know Latch's custom provider and smart-account flow. Latch is not a built-in Stellar Wallets Kit module, and its current `window.latch` API does not implement the standard SEP-43 / Wallets Kit method shapes.

More importantly, discovery is only half of the problem. Most existing Stellar dApps assume the connected wallet returns a classic G-address that can:

1. be loaded as the transaction source account;
2. supply the transaction sequence number and fees; and
3. sign the transaction envelope.

Latch's user account is a C-address. A C-address cannot be a transaction source and cannot sign an envelope. It authorizes Soroban calls through signed authorization entries, while a separate G-address pays fees and signs the envelope. Therefore:

> Adding a Latch icon and adapter to a wallet kit would make Latch discoverable, but it would not by itself make every existing dApp compatible.

There are two possible compatibility targets:

1. **Native Latch smart-account support (recommended):** keep the C-address model and make dApps/standards smart-account-aware. This preserves Latch's passkeys, policies, context rules, and gas sponsorship.
2. **Legacy G-address compatibility mode (optional, separate product decision):** provide a conventional G-account and envelope signer so unchanged dApps treat Latch like Freighter. This gives wider immediate compatibility but changes Latch's account model and does not automatically exercise the Latch C-account.

The practical path is to first harden Latch's wallet interface and signing engine, create a Stellar Wallets Kit module, and run a coordinated Blend pilot that adds a C-account transaction path. In parallel, Latch should participate in the open SEP-43 contract-account discussion so the ecosystem has a standard way to return both a C-address and its fee-paying source account.

For discovery, Latch should pursue two complementary routes:

1. a native SEP-43-compatible Stellar Wallets Kit module for desktop/browser integration;
2. WalletConnect v2 plus an approved WalletGuide listing for mobile, QR, and generic WalletConnect selectors.

WalletConnect can improve visibility but does not remove the G-address versus C-address transaction mismatch.

## 1. First-principles model

There are four separate compatibility layers:

1. **Discovery:** can the dApp see Latch and show it in “Connect wallet”?
2. **Connection:** can the dApp request the active address and network with user consent?
3. **Signing:** can the dApp send the wallet the kind of XDR it builds, and receive the exact result it expects?
4. **Account semantics:** does the dApp understand whether the user is a G-account or a C-account, who pays fees, and what must authorize the contract call?

Passing layer 1 does not imply layers 2–4. A wallet can appear in a selector and still fail as soon as the dApp tries to build or sign a transaction.

### Classic Stellar wallet flow

```text
dApp gets G-address
  -> dApp loads that G-account and sequence
  -> dApp builds and simulates transaction
  -> wallet signs transaction envelope
  -> dApp submits signed envelope
```

### Latch C-account flow

```text
dApp gets user C-address plus a fee-paying G source
  -> dApp builds a Soroban call whose user arguments are the C-address
  -> transaction is simulated to produce C-account auth entries
  -> Latch signs the C-account auth entry
  -> fee-paying G-account signs the transaction envelope
  -> wallet, dApp, or bundler submits the completed transaction
```

The second flow is valid Stellar/Soroban, but many existing dApp frontends implement only the first.

## 2. What Latch can do today

The statements below are based on the code and documentation in this repository. The browser extension's full source is not present here; `extension-integration/` contains integration patches intended for the separate `latch-web-extension` repository. A release audit must verify that the production extension actually contains them.

### 2.1 Custom injected provider

The extension integration injects `window.latch` into pages at `document_start` and bridges page requests to the extension background process.

The current provider exposes:

- `isConnected()`;
- `getPublicKey()`;
- `getNetwork()`;
- `signTransaction(request)`;
- `openSignRequest(params)`.

The bridge injects on `<all_urls>`, and the extension-side flow is designed to require origin approval before exposing the active account or signing.

Relevant files:

- `extension-integration/contents/provider-bridge.ts`
- `extension-integration/scripts/inpage.ts`
- `extension-integration/BACKGROUND_AND_TYPES_PATCH.md`
- `types/window.latch.d.ts`
- `lib/sign-demo/latchWallet.ts`

### 2.2 External unsigned XDR intake

A purpose-built dApp can build an unsigned Soroban transaction and send it to Latch. Latch's `prepare-sign` flow:

- parses base64 transaction XDR;
- requires at least one Soroban invoke operation;
- verifies that the transaction requires the selected smart account;
- identifies a target contract;
- discovers the relevant context rule;
- simulates the transaction;
- extracts authorization entries;
- calculates the signing payload;
- produces review metadata, fee estimates, and warnings.

Relevant files:

- `app/api/transaction/prepare-sign/route.ts`
- `lib/transaction/prepareExternalSign.ts`
- `lib/transaction/validateExternalTx.ts`
- `EXTERNAL_SIGN_API.md`

### 2.3 Smart-account signing and submission

Latch supports passkey, Phantom/Ed25519, and delegated Freighter-oriented authorization paths. The submit routes can either:

- assemble and submit through Latch's bundler; or
- when `submit=false`, return a submit-ready `signedTxXdr` for the dApp to broadcast.

This proves that a “dApp proposes, wallet authorizes, dApp submits” integration is possible, provided the dApp follows Latch's C-account flow.

### 2.4 Context-rule setup

Latch smart accounts enforce on-chain context rules:

- a Default rule is created during deployment;
- a `CallContract(C...)` rule can authorize a signer for a particular target contract.

If a required rule is missing, Latch returns `NO_CONTEXT_RULE`. The client can build a one-time `add_context_rule` transaction, ask the user to approve it, submit it, and retry the original action.

This is a wallet/account permission step, not the initial dApp connection handshake.

Relevant files:

- `LATCH_BACKEND_ECOSYSTEM.md`
- `lib/context-rule-setup.ts`
- `app/api/smart-account/setup-context-rule/route.ts`

## 3. Current limitations

### 3.1 Latch is not discoverable through the main Stellar wallet kit

Stellar Wallets Kit only displays modules supplied by the dApp. Latch does not currently ship as a kit module, so dApps using the kit do not know that `window.latch` exists.

Blend currently initializes Stellar Wallets Kit with an explicit module list including xBull, Freighter, Lobstr, Albedo, Hana, Ledger, WalletConnect, and HOT Wallet. Latch is not in that list.

There is no universal Stellar injected-wallet discovery registry comparable to Ethereum's EIP-6963. SEP-43 standardizes wallet methods, not provider discovery or provider naming.

An alternative discovery path is WalletConnect. Blend already includes a generic WalletConnect module, and wallets approved in WalletConnect's WalletGuide may appear inside that flow without a Latch-specific Blend adapter. This is useful for early connection testing and mobile support, but it does not create a native “Latch” row in Blend's first-level wallet list and does not make Blend's current G-source transaction construction C-account-aware.

### 3.2 The provider is not SEP-43 compatible

SEP-43 v1.2.1 and the current Wallets Kit module interface expect methods shaped approximately as:

- `getAddress() -> { address }`;
- `signTransaction(xdr, { networkPassphrase, address }) -> { signedTxXdr, signerAddress }`;
- `signAuthEntry(authEntry, options)`;
- `signMessage(message, options)`;
- `getNetwork() -> { network, networkPassphrase }`;
- structured error codes for internal error, service error, invalid request, and user rejection.

Latch currently differs:

- `getPublicKey()` returns a string rather than `getAddress()` returning an object;
- `signTransaction()` takes a Latch-specific request object containing `network` and `accountToSign`;
- `getNetwork()` returns `"testnet"` or `"mainnet"` rather than the standard object and passphrase;
- `signAuthEntry()` and `signMessage()` are not exposed;
- response and error shapes are Latch-specific;
- account/network change events and `disconnect()` are not part of the declared provider.

An adapter can translate method names and shapes, but the deeper C-account behavior still needs to be defined.

### 3.3 C-addresses cannot use the normal G-address transaction path

Stellar's own signing guidance is explicit:

- C-accounts cannot be transaction sources;
- C-accounts cannot sign transaction envelopes;
- C-accounts must authorize through Soroban auth entries;
- a G-account must provide sequence, fees, envelope signature, and submission.

SEP-43 v1.2.1 still describes `getAddress()` as returning the G-address the wallet signs for. Contract-account support is under active discussion in `stellar/stellar-protocol#1928`, including a proposal for `getAddress()` to return a C-address plus an optional `sourceAccount`.

This is the largest ecosystem gap and should be treated as an upstream standards issue, not hidden inside a thin adapter.

### 3.4 Blend's current frontend assumes a G-account source

As of the research date, Blend's public frontend:

- obtains `walletAddress` from Wallets Kit;
- calls `stellarRpc.getAccount(walletAddress)`;
- uses that account in `new TransactionBuilder(...)`;
- calls `walletKit.signTransaction(...)`;
- submits the returned envelope directly to Soroban RPC.

That path cannot accept a C-address because RPC cannot load a C-address as the transaction source account.

Blend's **contracts** appear compatible with C-address users: the protocol functions use Soroban `Address`, and Blend's integration documentation describes the user as a “pubkey/contract address.” The incompatibility is primarily in wallet discovery and frontend transaction construction.

### 3.5 Latch's generic transaction preparation is not yet fully generic

The current external preparation path intentionally supports Soroban invoke transactions. It:

- rejects transactions without invoke-host-function operations;
- derives the target from the first invoke operation;
- expects authorization from one selected Latch smart account;
- depends on Latch's backend simulation, context-rule discovery, and bundler configuration.

Before claiming arbitrary dApp support, test and, where necessary, extend:

- multiple invoke operations and multiple target contracts;
- multiple auth entries and multiple authorizers;
- nested contract invocations;
- fee-bump envelopes;
- restoration transactions;
- transaction mutation after simulation;
- auth-entry expiry and resimulation;
- transactions already containing auth entries;
- classic operations mixed with Soroban operations;
- mainnet RPC and bundler behavior;
- every signer type and context-rule combination.

There are also immediate implementation blockers to resolve before compatibility testing:

- `lib/transaction/prepareExternalSign.ts` currently references `bundlerOnlyRule` in its return path without defining it in that function;
- `LATCH_BACKEND_ECOSYSTEM.md` records remaining Go backend parity work for arbitrary `CallContract` discovery and generic `setup-context-rule`;
- extension integration is represented here as patches, so the shipped extension and API types can drift unless they are tested together in CI.

### 3.6 Production extension readiness is not demonstrated in this repository

This repository contains web/API code and extension integration patches, but not enough of the extension to verify:

- store packaging and reproducible builds;
- Chrome/Firefox release status;
- complete permission storage and revocation;
- account/network change events;
- transaction decoding coverage;
- phishing protection;
- update signing and release controls;
- key/passkey recovery and backup behavior.

## 4. Target product contract

Latch should publish a stable, versioned wallet contract with two layers.

### Layer A: standards-facing provider

Implement a SEP-43-compatible interface, either directly on `window.latch` or through a small published adapter:

```ts
interface LatchSep43Provider {
  isAvailable(): Promise<boolean>
  getAddress(): Promise<{ address: string; sourceAccount?: string }>
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ signedTxXdr: string; signerAddress: string }>
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ signedAuthEntry: string; signerAddress: string }>
  signMessage(
    message: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ signedMessage: string; signerAddress: string }>
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>
  disconnect(): Promise<void>
  onChange?(callback: (event: unknown) => void): void
}
```

`sourceAccount` is shown as the likely smart-account direction discussed in SEP-43 issue #1928; it is not part of SEP-43 v1.2.1 today. Latch must version this extension and avoid presenting it as finalized SEP behavior.

### Layer B: Latch smart-account capabilities

Keep Latch-specific features in a namespaced capability surface instead of overloading standard methods:

- account kind and smart-account metadata;
- context-rule inspection and setup;
- fee sponsorship/bundler policy;
- signer type and policy information;
- richer transaction review;
- smart-account deployment/recovery;
- `prepareTransaction` if preparation cannot safely be internalized.

Example capability negotiation:

```ts
const capabilities = await window.latch.getCapabilities()
// {
//   accountType: "contract",
//   signTransaction: true,
//   signAuthEntry: true,
//   sponsoredSourceAccount: true,
//   contextRules: true
// }
```

The exact interface should be coordinated with SEP-43 maintainers before it becomes public API.

## 5. Required engineering work

### Workstream 0 — Decide the account compatibility promise

Document and approve one of these product positions:

**Position A — C-account native:** Latch connects a C-address. Unchanged G-only dApps are not supported until they add a smart-account path. This best matches Latch's purpose.

**Position B — dual mode:** Latch exposes both:

- a Latch C-account for smart-account-aware dApps; and
- an optional conventional G-account for legacy dApps.

Dual mode requires a real G-account signing design. A C-account cannot be made envelope-compatible by renaming it. If the extension generates a local Ed25519 G-account, define backup, recovery, migration, funding, and the relationship between G and C balances. Do not use a custodial backend signer merely to mimic compatibility.

The report recommends Position A first and Position B only if market testing shows that unchanged legacy dApp access is more important than a C-address-only experience.

### Workstream 1 — Build and test Provider v2

1. Add SEP-43-compatible methods and return shapes.
2. Accept full network passphrases, not only `testnet|mainnet` labels.
3. Validate that the supplied passphrase matches the active network before any signature.
4. Add `signAuthEntry`.
5. Define `signMessage` behavior. Until contract-account message signing is standardized, return a clear unsupported error rather than inventing an incompatible signature format.
6. Add stable structured errors, including a distinct user-rejection code.
7. Add account/network change events.
8. Add explicit `disconnect()` and per-origin permission revocation.
9. Publish TypeScript types and a provider version/capability field.
10. Preserve the existing API behind a compatibility layer during migration.

### Workstream 2 — Make signing self-contained from the dApp's perspective

The desired dApp contract is:

```text
unsigned/prepared XDR in
  -> user reviews and approves in Latch
  -> complete submit-ready signedTxXdr out
```

To reach it:

1. Move Latch-specific preparation behind the wallet adapter where possible.
2. Accept an unsigned or simulated Soroban transaction and identify all Latch C-account auth entries.
3. If the transaction lacks usable auth entries, simulate and assemble it deterministically.
4. Sign every auth entry owned by the selected Latch account.
5. preserve unrelated auth entries and decorated signatures;
6. obtain a fee-paying G source through a documented bundler contract;
7. return one complete envelope whose contents the dApp can submit without Latch-specific post-processing;
8. optionally support sign-and-submit, but keep sign-only as the interoperability baseline;
9. never silently change contract, function, arguments, network, or user-visible value after approval;
10. display the final simulated effects, fees, target contracts, token movements, and context-rule changes before signing.

Because auth entries are tied to network, nonce, invocation, and expiry, any material transaction change after authorization must trigger resimulation and a new approval.

### Workstream 3 — Generalize context-rule orchestration

1. Detect all target contracts involved in the authorization tree, not only the first top-level invoke.
2. Explain missing permission in wallet UI using the dApp origin and contract identity.
3. Build the setup transaction, show it separately, and require explicit user approval.
4. Submit setup, wait for finality, then rebuild/resimulate the original action.
5. Support multiple required rules without retry loops that can run indefinitely.
6. Add rule expiry, revoke, and “connected dApps / allowed contracts” management UI.
7. Maintain a verified contract metadata registry for human-readable review; never rely only on a dApp-provided name.
8. Treat a context rule as permission for an on-chain contract, not as permission for a website origin. Keep origin permissions and contract permissions separate.

### Workstream 4 — Create the Stellar Wallets Kit module

Implement a `LatchModule` conforming to the current `ModuleInterface`:

- `moduleType`;
- stable exported `LATCH_ID`;
- `productName`, `productUrl`, and hosted icon;
- `isAvailable()` resolving in under one second;
- `isPlatformWrapper()` where applicable, resolving within the kit's timeout;
- `getAddress()`;
- `signTransaction()`;
- `signAuthEntry()`;
- `signMessage()` with explicit unsupported behavior if necessary;
- `getNetwork()`;
- `onChange()`;
- `disconnect()`;
- optionally `signAndSubmitTransaction()`.

Deliver it in two stages:

1. publish and test the adapter from a Latch-controlled package/repository so dApps can opt in immediately;
2. open an upstream PR to `Creit-Tech/Stellar-Wallets-Kit` so the module can be distributed with the kit.

Being included upstream does not guarantee every dApp will show Latch. Some dApps use explicit module lists, as Blend currently does. Those dApps must upgrade the kit and add `LatchModule` to their selected modules.

Use the D'CENT module and its Wallets Kit PR (`#98`) as the nearest current browser-extension precedent: unique provider naming, SEP-43-compatible shapes, injection-race handling, tests, package exports, and registration without impersonating Freighter.

### Workstream 4A — Add WalletConnect and WalletGuide discovery

Implement wallet-side WalletConnect v2 support for:

- chains `stellar:pubnet` and `stellar:testnet`;
- `stellar_signXDR`;
- `stellar_signAndSubmitXDR`;
- `stellar_signAuthEntry`;
- `stellar_signMessage`;
- QR pairing, deep links, session restore, account/network updates, rejection, and disconnect.

Then:

1. create a WalletConnect Dashboard project for Latch Wallet;
2. submit Latch's branding, supported platforms/chains, deep links, and test instructions to WalletGuide;
3. allow for WalletGuide review and propagation time;
4. verify whether Blend's AppKit configuration displays the approved listing;
5. run the same C-address/source-account compatibility checks as the native module.

WalletConnect account identifiers commonly use values such as `stellar:pubnet:G...`. Before listing Latch's C-account mode, confirm and document the interoperable account identifier and source-account behavior with WalletConnect and Stellar Wallets Kit maintainers. Do not advertise a session that connects successfully but cannot satisfy the dApp's transaction path.

### Workstream 5 — Implement a Blend C-account pilot

Blend is a good pilot because its contracts accept Soroban `Address`, but its current frontend assumes the wallet address is also the G transaction source.

Proposed pilot changes:

1. Add `LatchModule` to Blend's explicit module list.
2. Detect `accountType: "contract"` or a C-address from the wallet.
3. Keep the connected C-address as `from`, `spender`, `to`, and position owner.
4. obtain a separate sponsored G source account for `TransactionBuilder`;
5. simulate the operation with the C-address authorization in recording mode;
6. pass the assembled XDR to Latch for auth-entry signing;
7. receive a completed signed envelope or use a clearly defined sign-and-submit result;
8. submit and poll using Blend's existing RPC path;
9. add context rules for the actual Blend pool/token/router contracts required by each action;
10. test supply, withdraw, borrow, repay, claim, backstop actions, restoration, rejection, expiry, and resimulation.

Do this against Blend testnet first. A successful test must prove that Blend positions and token balances belong to the Latch C-address, not to the bundler G-address.

### Workstream 6 — Production security and extension distribution

Before asking major dApps to support Latch:

1. commission an independent review of extension, provider bridge, backend bundler, and on-chain account contracts;
2. derive the requesting origin from the browser tab/content-script context rather than trusting an `origin` field supplied by page JavaScript;
3. bind every approval and response to tab, frame, origin, request ID, account, and network;
4. reject requests from non-top-level or unexpected frames unless explicitly supported;
5. provide per-origin connect permissions, per-request signing approval, disconnect, and revocation;
6. protect against concurrent request confusion and response interception;
7. use cryptographically random request IDs;
8. strictly parse XDR and cap payload size, operation count, simulation time, and response size;
9. verify callbacks against an approved HTTPS origin and prevent open redirects;
10. minimize extension permissions and document why `<all_urls>` is required;
11. publish reproducible builds, signed releases, a vulnerability disclosure process, and an incident response plan;
12. complete Chrome Web Store privacy disclosures, privacy policy, and Limited Use requirements;
13. prepare readable source, reproducible build instructions, and reviewer test credentials for Firefox AMO;
14. publish the extension in official stores so `productUrl` points to a trusted install location.

The origin-binding item is especially important in the current integration sketch: page messages include a caller-supplied `origin`, while the bridge forwards the payload. The production background handler must verify the real sender/tab URL and must not grant permissions based only on that string.

### Workstream 7 — SDK, documentation, and conformance suite

Publish:

- `@latch/wallet-provider` or equivalent SEP-43 adapter;
- `@latch/stellar-wallets-kit` module until upstream inclusion;
- a framework-neutral quickstart;
- React helpers only as an optional wrapper;
- a minimal dApp example with no Latch backend calls visible to the application;
- a C-account integration guide explaining source account versus authorizer;
- a context-rule setup/retry guide;
- a migration guide from Provider v1.

Create an automated conformance suite covering:

- provider detection under slow extension startup;
- connection approve/reject/revoke;
- account and network changes;
- malformed XDR and wrong-network rejection;
- transaction, auth-entry, and message methods;
- single and multiple auth entries;
- context-rule missing/setup/retry;
- user rejection at setup and action stages;
- `submit=false` and sign-and-submit;
- testnet and mainnet;
- Chrome and Firefox;
- extension restart and stale session recovery;
- malicious origin spoof attempts;
- unchanged transaction hash/content across the approval boundary.

## 6. Ecosystem and partnership plan

### 6.1 Stellar Wallets Kit maintainers

**Where:** `https://github.com/Creit-Tech/Stellar-Wallets-Kit`  
**Primary public route:** open a design issue, then a draft PR. The project's documentation explicitly instructs wallet developers to implement a module and open a PR. `@earrietadev` is the principal visible maintainer/contributor.

Ask for:

- agreement on how a C-address module should represent its separate source account;
- whether smart accounts need a dedicated `ModuleType` or capability field;
- expected behavior of `signTransaction` for a C-account;
- guidance on `signMessage`;
- review of the smallest possible `LatchModule`;
- inclusion in `defaultModules()` after security and conformance evidence exists.

There is already an open passkey smart-wallet module PR (`#94`) and related issues (`#93`, `#95`). Coordinate rather than creating an incompatible second convention.

### 6.2 SEP-43 and Stellar standards participants

**Where:** `https://github.com/stellar/stellar-protocol/issues/1928` and the Stellar Developer Discord (`https://discord.gg/stellardev`).

Ask for:

- a standardized account descriptor containing C-address and optional fee-paying source;
- explicit C-account semantics for `signTransaction`;
- capability negotiation for auth-entry signing, fee sponsorship, and account type;
- agreed behavior when a dApp supplies its own source account;
- standard contract-account message-signing behavior, or an explicit unsupported rule.

Latch should contribute tested implementation evidence, not only a proposed interface.

### 6.3 Blend Capital

**Where:**

- frontend: `https://github.com/blend-capital/blend-ui`;
- SDK: `https://github.com/blend-capital/blend-sdk-js`;
- docs: `https://docs.blend.capital`;
- community: `https://discord.com/invite/a6CDBQQcjW`.

Ask for:

- confirmation that every intended Blend action accepts a C-address user;
- a testnet smart-account feature flag;
- review of the source-account/authorizer split;
- addition of `LatchModule` to Blend's explicit wallet list;
- a joint test matrix before enabling mainnet.

Open the conversation with a working branch/demo and transaction links. “Latch is in Wallets Kit” is not sufficient evidence.

### 6.4 Stellar Development Foundation ecosystem teams

Use the Stellar Developer Discord and ecosystem channels to:

- validate the SEP-43 direction;
- identify other dApps willing to pilot C-account flows;
- request review of bundler and smart-account patterns;
- add Latch integration material to Stellar ecosystem resources after the API stabilizes.

### 6.5 WalletConnect / Reown

**Where:** WalletConnect Dashboard and `https://docs.walletconnect.network/walletguide/explorer-submission`.

Ask for:

- confirmation of C-address account identifiers in the Stellar namespace;
- review of Latch's four Stellar signing methods;
- WalletGuide listing review;
- deep-link and mobile session interoperability guidance.

Official guidance currently estimates approximately 7–10 business days for listing review and about 24 hours for propagation after approval; recheck these estimates before scheduling launch.

### 6.6 OpenZeppelin Stellar maintainers

Latch relies on OpenZeppelin smart-account context rules and signer/verifier patterns. Coordinate on:

- correct multi-contract context-rule matching;
- delegated signer behavior;
- auth-entry encoding and expiry;
- upgrades that may affect wallet compatibility.

## 7. Phased delivery plan

### Phase 0 — Architecture decision and threat model

Exit criteria:

- approved C-only versus dual-mode product position;
- documented address/source/signer model;
- provider and bundler threat model;
- no ambiguous claim that all existing dApps work unchanged.

### Phase 1 — Provider v2 and conformance harness

Exit criteria:

- SEP-43-compatible method shapes;
- stable errors and events;
- `signAuthEntry`;
- complete signed XDR returned for the supported C-account flow;
- origin-binding security fixed and tested;
- public test dApp passes on Chrome testnet.

### Phase 2 — Standalone Wallets Kit module

Exit criteria:

- Latch appears in a local Wallets Kit modal;
- connect, reject, network switch, sign, and disconnect pass;
- module can be installed by any dApp from a documented package;
- limitations for G-only dApps are displayed clearly.

In parallel, complete a WalletConnect prototype and submit the WalletGuide listing once the C-account session semantics are agreed.

### Phase 3 — Upstream standards and kit contribution

Exit criteria:

- design feedback recorded on SEP-43 issue #1928;
- upstream `LatchModule` PR opened;
- alignment with the existing smart-wallet module work;
- module reviewed with no private Latch-only assumptions.

### Phase 4 — Blend testnet pilot

Exit criteria:

- Latch appears in Blend's testnet wallet modal;
- Blend builds with separate C user and G source;
- supply, withdraw, borrow, and repay succeed;
- resulting positions belong to the C-address;
- missing-rule setup and retry works;
- Blend and Latch teams sign off on failure and security behavior.

### Phase 5 — Production readiness

Exit criteria:

- independent security review completed and findings addressed;
- official extension store listing;
- mainnet bundler capacity, abuse controls, monitoring, and incident response;
- mainnet canary with transaction/value limits;
- public integration SLA and support route.

### Phase 6 — Wider ecosystem rollout

Prioritize dApps that already use current Stellar Wallets Kit and Soroban `Address` arguments. For each dApp:

1. confirm whether its frontend assumes `getAccount(walletAddress)`;
2. add the C-account/source-account branch;
3. add Latch to its module list;
4. run its critical action test matrix;
5. publish a verified compatibility entry.

## 8. Definition of “ecosystem ready”

Latch should only claim broad Stellar dApp readiness when all of the following are true:

- the extension is publicly installable from trusted stores;
- Latch has a stable standards-facing provider and versioned types;
- Latch is available as a Wallets Kit module;
- a dApp can connect without calling Latch-specific APIs directly;
- an unsigned/simulated Soroban transaction can enter the wallet and a complete submit-ready envelope can come back;
- the wallet handles C-account auth and the fee-paying source without confusing the dApp or user;
- missing context rules are set up through an explicit, reviewable transaction;
- account/network changes, disconnect, rejection, expiry, and resimulation are reliable;
- security review and cross-browser conformance tests have passed;
- at least two independent third-party dApps, including one production-grade DeFi app such as Blend, have completed testnet integration;
- compatibility documentation distinguishes “listed,” “connects,” “signs,” and “fully supports C-account actions.”

## 9. Immediate next actions

1. Open an internal architecture decision record for C-only versus dual-mode compatibility.
2. Fix the undefined `bundlerOnlyRule` prepare-sign return path and complete the documented Go backend parity work.
3. Turn the current custom provider into a versioned SEP-43 adapter without removing Provider v1.
4. Fix real-origin derivation in the extension bridge/background boundary.
5. Add `signAuthEntry`, standard errors, events, and disconnect.
6. Make `signTransaction` return one complete submit-ready XDR for supported C-account transactions.
7. Build the standalone `LatchModule` and a Wallets Kit conformance demo.
8. Implement the four Stellar WalletConnect methods and prepare a WalletGuide submission.
9. Join SEP-43 issue #1928 with Latch's concrete C-address/source-account findings.
10. Coordinate with the maintainers of Wallets Kit PR #94 before choosing smart-account module semantics.
11. Open a Blend design issue with a working testnet branch that separates the C user from the G source.
12. Complete extension security review and official store distribution before mainnet partner rollout.

## 10. Sources

### Latch repository

- `README.md`
- `LATCH_BACKEND_ECOSYSTEM.md`
- `EXTERNAL_SIGN_API.md`
- `types/window.latch.d.ts`
- `extension-integration/README.md`
- `extension-integration/scripts/inpage.ts`
- `extension-integration/contents/provider-bridge.ts`
- `extension-integration/BACKGROUND_AND_TYPES_PATCH.md`
- `lib/transaction/prepareExternalSign.ts`
- `lib/transaction/validateExternalTx.ts`
- `app/api/transaction/prepare-sign/route.ts`
- `app/api/transaction/submit-webauthn/route.ts`

### External primary sources

- Stellar Wallets Kit, wallet module guide:  
  `https://stellarwalletskit.dev/wallets/create-wallet-module.html`
- Stellar Wallets Kit repository:  
  `https://github.com/Creit-Tech/Stellar-Wallets-Kit`
- Stellar Wallets Kit v2.5.0 release current on the research date:  
  `https://github.com/Creit-Tech/Stellar-Wallets-Kit/releases/tag/v2.5.0`
- D'CENT Wallets Kit module precedent:  
  `https://github.com/Creit-Tech/Stellar-Wallets-Kit/pull/98`
- SEP-43 v1.2.1, Standard Web Wallet API Interface (status: Draft):  
  `https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md`
- SEP-43 contract-account support discussion:  
  `https://github.com/stellar/stellar-protocol/issues/1928`
- Open Wallets Kit passkey smart-wallet module PR:  
  `https://github.com/Creit-Tech/Stellar-Wallets-Kit/pull/94`
- Stellar guide, Signing Soroban contract invocations:  
  `https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations`
- OpenZeppelin Stellar, Signers and Verifiers:  
  `https://docs.openzeppelin.com/stellar-contracts/accounts/signers-and-verifiers`
- Blend frontend wallet context:  
  `https://github.com/blend-capital/blend-ui/blob/main/src/contexts/wallet.tsx`
- Blend pool integration guide:  
  `https://docs.blend.capital/tech-docs/integrations/integrate-pool`
- Blend Discord link from official docs:  
  `https://discord.com/invite/a6CDBQQcjW`
- Stellar ecosystem resources and Developer Discord:  
  `https://github.com/stellar/ecosystem-resources`
- WalletConnect WalletGuide submission:  
  `https://docs.walletconnect.network/walletguide/explorer-submission`
- Chrome Web Store program policies:  
  `https://developer.chrome.com/docs/webstore/program-policies/policies`
- Mozilla add-on policies:  
  `https://extensionworkshop.com/documentation/publish/add-on-policies/`

## Research caveats

- SEP-43 is still marked Draft, and its C-account behavior is actively disputed. Recheck it before freezing Provider v2.
- Stellar Wallets Kit and Blend are actively developed. The module interface and Blend's explicit module list should be rechecked at implementation time.
- This report did not audit the complete `latch-web-extension` repository because it is not included here. Claims about the production extension must be verified against its actual release source and store artifact.
- Contract compatibility does not prove frontend compatibility. Every target dApp requires an end-to-end transaction test.
