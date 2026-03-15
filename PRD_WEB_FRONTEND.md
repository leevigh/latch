# PRD — Web Frontend Developer
### Latch | Web Wallet + Landing Page + dApp Signing UI

---

## Overview

You are building the web-facing layer of Latch — everything a user sees and interacts with in a browser. This includes the marketing landing page, the full web wallet application, and the dApp transaction signing page.

You work from:
- **Figma designs** provided by the design team (Lexie)
- **@latch/core SDK** provided by the SDK developer (Kachi)
- **API routes** already scaffolded in Next.js (existing codebase)
- **Technical spec** from Frankie for wallet integration and signing flows

Stack: **Next.js 15, React 19, TypeScript**. The repo is already set up — you'll be building into it.

---

## 1. Landing Page

### Goal
Convert visitors into wallet users or SDK integrators. Two audiences: end users who want a Smart Account wallet, and developers who want to integrate C-address support.

### What you build
- Static or server-rendered landing page at `latch.so` (or similar)
- Sections: Hero, Problem, Solution, How it Works, For Developers (SDK snippet), Ecosystem logos, Footer
- Two CTAs: "Launch Wallet" → wallet app, "Read the Docs" → GitBook
- Mobile responsive, dark mode

### Input
- Figma file from design team
- No dynamic data — this is a static marketing page

### Deliverable
- Deployed and live (Vercel)
- Passes Lighthouse performance > 90

---

## 2. Latch Web Wallet

### Goal
A fully functional, production-grade web wallet for Stellar Smart Accounts (C-addresses). Feature parity with Freighter for standard wallet operations, plus Smart Account-specific features.

### Tech notes
- Uses `@latch/core` for all Stellar interactions (do not call Stellar SDK directly — go through the SDK)
- Wallet adapters: Phantom (window.phantom), MetaMask (window.ethereum), WebAuthn (navigator.credentials)
- All signing happens client-side — no private keys sent to server
- Server-side API routes (already in repo) handle tx build, simulate, and submit

### Screens and features

**Onboarding (new user, no Smart Account yet)**

| Screen | What it does |
|---|---|
| Welcome | Intro copy, "Create Account" button |
| Choose signer | Select: Passkey / Phantom / MetaMask / Hardware key |
| Creating account | Deploy Smart Account (calls API), show deterministic C-address immediately |
| Fund account | Show proxy G-address + memo, "I've sent funds" button |
| Waiting for deposit | Poll bridge status, show received amount, progress indicator |
| Ready | Account active, enter wallet |

**Dashboard**
- Total portfolio value in USD
- Asset list: icon, token name, balance, USD value
- Quick actions: Send, Receive
- Recent transactions (last 5, link to full history)

**Send**
- Recipient input (C-address or G-address)
- Asset dropdown (list all held tokens)
- Amount input with USD conversion
- Review screen: recipient, asset, amount, estimated fee
- Sign screen: triggers wallet adapter (Passkey biometric / Phantom popup / MetaMask popup)
- Success / error states

**Receive**
- Your C-address (QR code + copy button)
- Bridge section: proxy G-address + memo for CEX deposits (copy each separately)
- "How to deposit from a CEX" expandable guide

**Transaction History**
- Chronological list
- Each item: type (sent/received/contract call), asset, amount, counterparty address (truncated + copy), date, status badge
- Filter by: all / sent / received / contract calls
- Pagination or infinite scroll

**Asset Detail**
- Token name, balance, USD value
- Send button
- Transaction history filtered to this asset

**Session Keys & Permissions**
- List of active session keys: name, scoped contract(s), spend limit, expiry, Revoke button
- "Add session key" flow: name, contract allowlist, spend limit (optional), time window (optional), confirm + sign
- Connected dApps view (what each dApp is allowed to do)

**Settings**
- Account: C-address (copy + QR), registered signers list
- Add signer: add Passkey / MetaMask / Phantom to existing account
- Network: testnet / mainnet toggle
- Danger zone: export address

### States to handle for every component
- Loading skeleton
- Empty state (no assets, no history, no session keys)
- Error state (RPC down, tx failed, wallet rejected)
- Success confirmation

### Requirements
- TypeScript strict mode
- No raw Stellar SDK calls — everything through @latch/core
- All wallet connections use the adapter pattern (easy to add new wallets)
- Responsive: works on desktop (1280px+) and mobile browser (375px+)
- Dark mode primary

---

## 3. dApp Signing Page

### Goal
When a dApp wants a user to authorize a Stellar Smart Account transaction, it redirects the user to Latch with a signing request. The user reviews the transaction and approves or rejects. Latch returns the signed auth entry to the dApp.

### How it works
1. dApp encodes the unsigned XDR into the URL or uploads to refractor.space and passes a reference
2. User lands on `latch.so/sign?xdr=...` or `latch.so/sign?ref=...`
3. Latch decodes the XDR, displays it in human-readable form
4. User reviews: what dApp, what contract, what function, what args, what fee
5. User authenticates (Passkey / Phantom / MetaMask)
6. Latch signs and returns the signed auth entry back to the dApp (via redirect URL or postMessage)

### Screens

**Transaction Review**
- dApp name + domain (from URL params)
- What this transaction does (human-readable — parse the contract function name + args)
- Contract address being called (truncated + link to Stellar Expert)
- Function name
- Arguments (display as key: value, not raw XDR)
- Estimated fee (in XLM + USD)
- Two buttons: Approve / Reject

**Signing**
- Triggers appropriate wallet adapter
- Loading state while signing

**Result**
- Success: "Transaction signed — returning to [dApp name]" + auto-redirect
- Rejection: "Transaction rejected" + return button
- Error: clear error message (expired tx, wrong network, not authorized)

### Requirements
- Must handle both URL-embedded XDR and refractor.space store-and-forward
- Payload size limit: handle XDR up to 64KB inline, beyond that require refractor.space
- Must display content even before user is connected (show the tx details, prompt to connect if not already)
- Security: validate the XDR, never expose raw hex to user

---

## What you receive before starting

From design team:
- Figma file with all screens above, all states, component library

From SDK dev (Kachi):
- `@latch/core` npm package with: address derivation, bridge funding instructions, auth payload helpers, verifier ABIs
- `@latch/react` hooks: useSmartAccount, useBridge, useTransaction, useWalletAdapter

From Frankie:
- API route specs (build tx, simulate, submit — already scaffolded in repo)
- Contract ABIs for Smart Account, verifiers, bridge

---

## Deliverables

| # | Deliverable | Done when |
|---|---|---|
| 1 | Landing page live on Vercel | Deployed, Lighthouse > 90 |
| 2 | Onboarding flow | User can create a Smart Account with Passkey + Phantom on testnet |
| 3 | Dashboard + send/receive | User can view balances and send XLM on testnet |
| 4 | Transaction history | Full history displayed correctly |
| 5 | Session key management | User can create, view, revoke session keys |
| 6 | dApp signing page | Sample dApp can complete a full signing round-trip |
| 7 | Mobile responsive | All screens work at 375px |

---

## Timeline

| Week | Work |
|---|---|
| 1 | Setup, landing page, onboarding flow shell |
| 2–3 | Dashboard, send, receive, history |
| 4 | Session keys, settings, all empty/error states |
| 5 | dApp signing page |
| 6 | Mobile polish, QA, testnet end-to-end testing |
