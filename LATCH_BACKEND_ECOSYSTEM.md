# Latch backend ecosystem guide

Directions for the Go/backend team (`latch-backend` / [Swagger](https://latch-backend.onrender.com/swagger/index.html)) so Latch works for **first-party product flows** and **any Stellar dapp** that connects via `window.latch`.

This document is the source of truth for **what to keep, fix, and add**. The Next.js app in this repo remains a reference client (`/dev/sign-demo`, SendCard, etc.).

---

## 1. How Latch auth works (short)

Latch smart accounts authorize actions with **on-chain context rules**:

| Rule type | Meaning |
|-----------|---------|
| **Default** | Catch-all rule created at deploy |
| **CallContract(C…)** | Allows invoking a specific Soroban contract (SAC, dapp, router, …) |

**Setup is one-time and user-signed.** Endpoints like `setup-send-rules` / `setup-context-rule` only **build** an `add_context_rule` transaction. The client must:

1. Call the setup endpoint  
2. Have the user **sign and submit** that tx (**via the Latch extension** for extension-issued passkeys — never page-hostname WebAuthn against an extension rpId)  
3. **Retry** the original build / prepare  

`prepare-sign` accepts those setup txs as **smart-account self-invokes** (Default rule). SAC transfers still require a matched `CallContract` rule.

The API **must not** silently add rules without a signature. Clients branch on:

| HTTP | `code` | Typical `suggestedAction` |
|------|--------|---------------------------|
| 409 | `NO_CONTEXT_RULE` | `setup_transfer_rule` |
| 409 | `SIGNER_MISMATCH` | `setup_swap_rule` / `reconfigure_swap_rule` |

Legacy alias (avoid): `context_rule_missing` (400). Prefer `NO_CONTEXT_RULE` (409).

---

## 2. Dapp happy path (ecosystem)

```text
connect window.latch
  → ensure CallContract(target)  [setup-context-rule or setup-send-rules]
  → dapp builds unsignedTxXdr (its own contract ops)
  → POST /api/transaction/prepare-sign
  → sign via window.latch.signTransaction | openSignRequest (+ optional sign-payload)
  → POST /api/transaction/submit-*
```

**Latch-owned builders** (`build-send`, `build-swap`, counter `build`) are product conveniences. Arbitrary dapps should build their own XDR and use **prepare-sign**.

Runnable reference: `/dev/sign-demo` in this repo.

---

## 3. Existing endpoints (keep)

| Method | Path | Role |
|--------|------|------|
| POST | `/api/transaction/build-send` | Catalog SAC transfer (auth-ready) |
| POST | `/api/transaction/build-swap` | Aquarius swap |
| POST | `/api/transaction/build` | Demo counter increment |
| POST | `/api/transaction/build-delegated` | Counter for delegated G |
| POST | `/api/transaction/prepare-sign` | Auth-wrap **client-built** unsigned XDR |
| POST | `/api/smart-account/setup-send-rules` | `CallContract(SAC)` for catalog assets |
| POST | `/api/smart-account/setup-swap-rules` | Signer on Default for swaps |
| GET | `/api/smart-account/context-rules` | List rules for UX |
| POST / GET | `/api/sign-payload`, `/api/sign-payload/{ref}` | Out-of-band sign payload |
| POST | `/api/transaction/submit-webauthn` | Passkey submit |
| POST | `/api/transaction/submit-delegated` | Freighter / delegated submit |
| POST | `/api/transaction/submit` | Phantom / Ed25519 submit |

Live catalog: [latch-backend Swagger](https://latch-backend.onrender.com/swagger/index.html).

---

## 4. Must fix in Go (`latch-backend`)

Parity gaps vs this Next.js app (also noted in `reference/latch-api-master/docs/webapp-port.md`):

### 4.1 `POST /api/transaction/build-send`

- Enforce **matched** `CallContract(asset SAC)` (same as Next `requireMatchedContextRule: true`).
- On miss → **`409`** + `code: "NO_CONTEXT_RULE"` + `suggestedAction: "setup_transfer_rule"`.
- Route through the shared auth-build core so **Freighter** gets `smartAccountAuthEntryXdr`, `gAddressPreimageXdr`, `gAddressEntryTemplateXdr`.

Without `NO_CONTEXT_RULE`, web clients cannot auto-run setup then retry (Section B2 in sign-demo).

### 4.2 `POST /api/transaction/prepare-sign`

Align with Next [`lib/transaction/prepareExternalSign.ts`](lib/transaction/prepareExternalSign.ts):

- Extract **target contract** from ops; discover **`CallContract(target)`** (not Default-only).
- Swap routers → Default rule path + signer checks (`SIGNER_MISMATCH` / setup_swap_rule).
- Return review fields: fees, `operations`, `warnings`, Freighter template XDRs.
- Missing rule → **`409 NO_CONTEXT_RULE`**.

This is the **primary arbitrary-dapp** endpoint. Default-only discovery breaks third-party contracts that use dedicated CallContract rules.

---

## 5. Must add in Go

### 5.1 `POST /api/smart-account/setup-context-rule` (required for ecosystem)

Create `CallContract(targetContractId)` for **any** Soroban C-address (not only the SAC catalog).

**Request (mirror Next):**

```json
{
  "smartAccountAddress": "C...",
  "signerType": "passkey|phantom|freighter",
  "targetContractId": "C...",
  "name": "optional-max-20-chars",
  "publicKeyHex": "...",
  "keyDataHex": "...",
  "gAddress": "G..."
}
```

**Response:** same shape as `setup-send-rules` — either `{ "alreadyConfigured": true }` or auth-build fields (`txXdr`, `authEntryXdr`, digests, Freighter fields, …).

Reference implementation in this repo: [`app/api/smart-account/setup-context-rule/route.ts`](app/api/smart-account/setup-context-rule/route.ts).

### 5.2 Optional: `POST /api/transaction/build-sign-demo`

Dev-only unsigned SAC noop/transfer for sign-demo parity. **Not required** if clients keep using Next for demos and Go `build-send` for production sends. Explicitly deferred in `webapp-port.md` today.

---

## 6. Client contracts (do not break)

When emitting errors, preserve:

```json
{
  "error": "human message",
  "code": "NO_CONTEXT_RULE",
  "message": "human message",
  "suggestedAction": "setup_transfer_rule"
}
```

Send / sign-demo clients already:

1. Detect `NO_CONTEXT_RULE` / legacy `context_rule_missing`
2. Call `setup-send-rules` or `setup-context-rule`
3. Sign + submit setup
4. Retry build / prepare (max ~5)

Shared helper in this repo: [`lib/context-rule-setup.ts`](lib/context-rule-setup.ts).

---

## 7. Wallet provider surface (extension)

Stable `window.latch` (see `types/window.latch.d.ts`, extension provider):

- `isConnected` / `getPublicKey` / `getNetwork`
- `signTransaction({ xdr, network, accountToSign, submit? })` — prefer `submit: false` for dApp-submit interoperability
- `openSignRequest` (inline XDR or `payloadRef` + callback)
- `on('accountChanged' | 'networkChanged', handler)` / `off(...)` — payload `{ publicKey, network }`

Dapps should not need Latch-owned `build-send` to integrate — only connect, ensure rules, prepare-sign, sign, submit.

---

## 8. Out of scope / later

- Published `@latch/core` / `@latch/react` (see [`docs/PRD_MOBILE_SDK.md`](docs/PRD_MOBILE_SDK.md))
- Multisig playground auto-setup of send rules (needs member signing path; UI now fails clearly with `requireMatchedContextRule: true`)

---

## 9. Verification checklist (backend)

- [ ] `build-send` without send rule → 409 `NO_CONTEXT_RULE` + `setup_transfer_rule`
- [ ] After client setup-send-rules + submit → `build-send` succeeds with Freighter fields when `signerType=freighter`
- [ ] `prepare-sign` with XDR targeting a non-Default CallContract → discovers matched rule or 409
- [ ] `prepare-sign` with smart-account self-invoke (`add_context_rule` setup tx) → succeeds under Default
- [ ] `setup-context-rule` for arbitrary C-address → alreadyConfigured or buildable setup tx
- [ ] Swagger docs updated for new/changed fields and error codes

---

## 10. Local Next reference (this repo)

| Item | Location |
|------|----------|
| Shared ensure+retry | `lib/context-rule-setup.ts` |
| Sign demo + Section B2 (Go build-send) | `app/dev/sign-demo/page.tsx` |
| Local build-sign-demo | `app/api/transaction/build-sign-demo/route.ts` |
| Generic setup | `app/api/smart-account/setup-context-rule/route.ts` |
| Product send auto-setup | `components/SendCard.tsx` |

Default Go base for Section B2: `https://latch-backend.onrender.com` (override with `NEXT_PUBLIC_LATCH_API_URL`).
