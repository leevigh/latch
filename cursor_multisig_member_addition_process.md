# Multisig member addition process
_Exported on 04/06/2026 at 11:09:28 GMT+1 from Cursor (3.5.38)_

---

**User**

Currently, on the multisig flow for adding members, the passkey flow has two buttons to select from: "Use existing key" and "Create new key". I believe this is assuming all of this is done on the same client. However, my question now is: how would it be if there is a different user somewhere else that we need to add to the multisig with their passkey? How would that work? How would we share it to them to get their key data from a remote location and add them as members to the multisig?
Explain the key ideas briefly to me.

---

**Cursor**

Exploring the multisig member-add flow and passkey handling to explain how remote signers would work.


You're right: the current UI is built for **same-browser, same-device** collection. The two passkey buttons in `CollectSignersStep` both run WebAuthn on **whoever is sitting at that machine**:

- **Use existing passkey** — authenticates against credentials already registered with Latch on this browser
- **Create passkey** — registers a new passkey in this browser's authenticator (Face ID, Touch ID, etc.)

The draft is also stored in **localStorage** on that machine only — there's no invite/share flow implemented yet.

---

## What a remote passkey member actually contributes

For multisig creation, you don't need their wallet address or private key. You need **public signer material**:

For passkey users, that's **`keyDataHex`**:

```
65-byte P-256 public key (starts with 0x04) || credential ID bytes
```

That's what gets registered on-chain as `External(WebAuthn, key_data)`. The private key never leaves their device.

Your codebase documents this clearly in `lib/multisig-signers.ts` and the private guide (sections 9 and Part 1–2).

---

## How remote collection would work (conceptually)

The intended model is a **two-phase, off-chain coordination** flow:

```mermaid
Creator                         Remote invitee (Bob)
   │                                │
   ├─ Create draft (2-of-3)         │
   ├─ Add self (passkey)             │
   ├─ Send invite link ────────────►│
   │                                ├─ Opens link on THEIR device
   │                                ├─ "Create passkey" or "Use existing"
   │                                ├─ WebAuthn runs locally (Face ID etc.)
   │                                ├─ App extracts keyDataHex (public only)
   │                                └─ Submits to shared draft
   ├─ Sees Bob's fingerprint in member list
   ├─ get_account_address → everyone confirms same C-address
   └─ create_account (once)
```

**Key ideas:**

1. **Invite link, not key export** — Bob opens a Latch URL (e.g. `/multisig/join/{draftId}`). On his phone/laptop, he runs the same passkey ceremony. The app sends only `keyDataHex` back to the draft.

2. **No Stellar signature at creation** — Factory deploy only needs public keys. Bob doesn't co-sign a chain transaction to *join*; he just registers his public credential.

3. **Same RP ID / origin matters** — Passkeys are bound to the relying party (`WEBAUTHN_RP_ID`, e.g. your deployed domain). Bob must complete the ceremony **on your Latch site**, not paste hex from somewhere else. "Use existing passkey" only works if he already registered that passkey with Latch on that domain.

4. **Create vs use existing (remote)** — Same meaning, different person:
   - **Create passkey** — Bob has never used Latch; he registers a fresh passkey during the invite
   - **Use existing passkey** — Bob already has a Latch passkey on that domain; he authenticates and the server returns his stored `keyDataHex`

5. **Creation ≠ spending** — Adding Bob to the draft only registers his public key. Later, when the team spends, Bob must **actually sign** proposals on his device (your delegated approval routes handle that separately).

6. **Verification UX** — Show a fingerprint like `passkey · 04abc1…f3` so the creator can confirm the right person joined (optional challenge-sign for stronger proof).

---

## What's missing today vs what's designed

| Today | Intended for remote |
|-------|---------------------|
| Draft in localStorage | Shared draft on server (draft API exists at `/api/multisig/accounts/draft`) |
| Creator collects all keys locally | Invite link per member |
| Same two buttons, same browser | Same buttons, **invitee's** browser |

The **on-chain model already supports remote passkey members** — you just need the product layer: shared draft storage, invite URLs, and a join page that runs the passkey flow and POSTs `keyDataHex` into the draft.

---

## Brief mental model

- **Multisig wallet** = new C-address whose signers are **public keys**, not personal wallet addresses  
- **Remote passkey user** = runs WebAuthn on their device → gives you `keyDataHex` → you add them to the draft  
- **Never collect** private keys, seeds, or their personal C-address  
- **Share a link**, not key material — they produce the public data themselves

If you want to go deeper next, the two most useful angles are: (1) what the invitee page/API contract would look like, or (2) how passkey signing works later when Bob approves a proposal from afar.

---

**User**

This is a great explanation. Would this work seamlessly in our extension? When we build here, we have to think about the extension that we are building for Latch, and this needs to work seamlessly in our extension to implement the multisig flow. Now the question I would like answered is: would this work properly in our extension, and how would it work?

---

**Cursor**

Exploring how the Latch extension handles WebAuthn and multisig to assess whether the remote passkey flow fits.


**Short answer:** Yes — multisig with remote passkey members fits the extension model well, and much of the backend is already built for it. The on-chain side only needs public `keyDataHex`; where the ceremony runs (web vs extension) does not matter at creation. What you still need is the invite/join product layer and extension UI wired to the same APIs, with one important rule: **sign later with the same passkey context you used when joining**.

---

## Why the extension is a good fit

The extension is a natural home for multisig because:

1. **Passkeys never leave the device** — registration and signing stay in the extension popup or a dedicated extension page.
2. **Remote invitees are just “another device”** — Bob runs WebAuthn on his machine; the creator only receives `keyDataHex`.
3. **Later approvals happen in the wallet** — the extension already matches the “stable wallet URL / signing request” pattern from your roadmap.

Your private guide’s invite model (link → passkey on invitee’s device → submit public material → deploy) maps cleanly onto extension UX.

---

## What the backend already supports

The web app is not extension-blind. There is explicit extension WebAuthn plumbing:

- `resolveWebauthnCeremonyContext()` — when `chromeExtensionId` is sent, RP ID becomes the **32-char extension id**, origin becomes `chrome-extension://<id>`
- Registration/auth **begin/finish** routes accept `chromeExtensionId` in the body
- Verification handles extension RP ID hashing quirks (`chromeExtensionRpIdCandidates`)
- Session cookies use `SameSite=None` when `WEBAUTHN_EXTENSION_IDS` / `API_CORS_ALLOWED_ORIGINS` include the extension
- CORS middleware allows credentialed `fetch` from `chrome-extension://…`

`lib/multisig-signers.ts` even notes that `credentialId` is stored in the draft **for re-signing in the extension** — that’s intentional.

So: **multisig member collection + later WebAuthn approval can work from the extension**, as long as the extension calls the same APIs with the right parameters.

---

## How it would work in practice

### Phase 1 — Creator starts draft (web or extension)

Alice creates a 2-of-3 draft, adds herself, generates an invite link. Draft lives on the **server** (not localStorage — that’s a current web-only gap).

### Phase 2 — Remote Bob joins via extension

```
Alice (any client)                    Bob (Latch extension)
      │                                      │
      ├─ invite link ───────────────────────►│
      │   latch.app/multisig/join/{token}    │
      │                                      ├─ Opens extension (or “Open in Latch”)
      │                                      ├─ “Create passkey” or “Use existing”
      │                                      ├─ WebAuthn in extension context
      │                                      │   rpId = chrome.runtime.id
      │                                      ├─ Extract keyDataHex (+ credentialId)
      │                                      ├─ POST to draft API
      │                                      └─ Store locally in chrome.storage:
      │                                          { credentialId, keyDataHex, draftId }
      ◄──────────────────────────────────────┘
Alice sees Bob’s fingerprint in member list
```

**Create passkey (extension):**

```ts
// Conceptually — same lib/webauthn.ts, different rpId
await registerPasskey(chrome.runtime.id, "Latch", "Bob");
// → keyDataHex = 65-byte P-256 pubkey || credentialId bytes
// POST to /api/multisig/draft/{id}/members with { keyDataHex, label: "Bob" }
// Save credentialId in extension storage for later signing
```

**Use existing passkey (extension):** read a passkey already stored in the extension (`credentialId` + `keyDataHex`), not necessarily the website login flow.

### Phase 3 — Deploy

Creator calls `get_account_address` → everyone confirms C-address → `create_account` once. Bob’s `keyDataHex` is already in the signer list; he did not need to co-sign deploy.

### Phase 4 — Bob approves a proposal later

When the team spends, Bob gets a notification or signing link in the extension:

1. Fetch proposal + `authDigestHex`
2. `signWithPasskey(credentialId, authDigest, chrome.runtime.id)` — **extension RP ID, not website hostname**
3. POST to `/api/multisig/proposals/{id}/approve/webauthn` with `sigDataXdrHex`

That matches your existing approval API; the extension is the signing surface.

---

## The one critical constraint: web passkeys ≠ extension passkeys

Passkeys are bound to **RP ID**:

| Context | RP ID | Origin |
|--------|--------|--------|
| Website | `latch.app` (WEBAUTHN_RP_ID) | `https://latch.app` |
| Extension | `abcdefghijklmnop…` (32-char id) | `chrome-extension://…` |

Same person, two different passkeys → two different `keyDataHex` values.

**Implications:**

- **Creation:** Fine to mix — Alice joins on web, Bob on extension. On-chain only sees public keys.
- **“Use existing passkey”:** Only finds credentials for the **same RP ID**. A passkey created on the website won’t show up in the extension flow and vice versa.
- **Signing:** Bob must approve from the **extension** if he joined with an extension passkey. Using the website with `window.location.hostname` as `rpId` will fail.

**Product rule:** Pick a primary surface per user — **extension-first for multisig** is reasonable: invite opens extension, create/use passkey there, approve there later.

---

## What does *not* work seamlessly yet (gaps to design for)

| Gap | Why it matters |
|-----|----------------|
| **No invite/join flow** | Draft is localStorage on web; extension needs server-backed draft + token |
| **Web UI uses `window.location.hostname`** | Extension must use `chrome.runtime.id` for all WebAuthn calls |
| **“Use existing passkey” via auth/finish** | That path expects a **personal** smart account in DB. Multisig-only members who only join a team wallet should use **extension local storage** or a lighter “list my credentials” path |
| **Extension source not in repo** | Backend is ready; extension UI/workflow still to build |
| **Env config** | Need `WEBAUTHN_EXTENSION_IDS` + `API_CORS_ALLOWED_ORIGINS` including `chrome-extension://<id>` |

---

## Recommended extension-first multisig design

1. **Invite link** → universal URL that opens the extension (installed) or prompts install, then passes `draftToken`.
2. **Join page in extension** — same two buttons as web, but always with `chromeExtensionId`.
3. **Local credential vault** — store `{ credentialId, keyDataHex, multisigAccounts[] }` in `chrome.storage`; don’t rely on website session for multisig-only users.
4. **Shared `@latch/webauthn` (or shared package)** — reuse `registerPasskey`, `signWithPasskey`, `encodeWebAuthnSigData`; only `rpId` differs (`chrome.runtime.id` vs hostname).
5. **Approval inbox** — pending proposals → sign → POST approve API → notify when threshold reached.

---

## Bottom line

**Yes, it can work properly in the extension** — arguably better than pure web for remote passkey members, because the extension is the persistent wallet that holds credentials and signs.

The contracts and APIs already assume “public `keyDataHex` at creation, biometric sign at spend.” What you need to build is:

- Server-backed invite/join (not same-browser localStorage)
- Extension UI that passes `chromeExtensionId` everywhere
- Local storage of `credentialId` for members who may not have a personal Latch account
- Consistent “extension passkey for multisig” UX so users don’t mix web and extension credentials

If you want to go deeper next, the most useful follow-ups are: (1) invite URL + API contract between web creator and extension invitee, or (2) how extension storage should map to multisig proposal approval.

