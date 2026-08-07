# WebAuthn passkey account recovery
_Exported on 04/06/2026 at 11:09:48 GMT+1 from Cursor (3.5.38)_

---

**User**

I need to understand a few things. I think I have a gap in my understanding of webauthn passkey account recovery. I need to fully understand it. Currently, when we create an account using passkeys, it gets stored somewhere in the browser, probably on your Google email that you select from the pop-up natively on the browser or Apple's keychain or whatever.
1. First of all, is there a way to select a particular passkey that you've saved in your browser to get a particular account consistently every time?
2. Secondly, is there a way to list out related passkeys that have been saved? For example, when you create a passkey account on Latch, for example, and you create a second one, you would want to be able to get those particular passkeys without the other passkeys you've saved to your browser from other applications. How would you get this?
And this also relates to our multisig in the sense that the passkey, assuming you created a new one for the multisig, would be saved. When you need to sign a transaction for the multisig, you need to be able to get that particular passkey for the multisig that you created easily on the user's end and sign.

Lastly, I believe in the case when you change your device or you need to open a latch wallet on a different device where you haven't saved your passkey and you want to have that passkey account on a new device. How would you go about this? I think we have those accounts saved in a backend that could be recovered, but how would we efficiently go about getting a particular user's account from their passkey onto a new device consistently every time?

---

**Cursor**

Exploring how Latch implements WebAuthn/passkeys and multisig so we can answer your questions in context.


This is a great set of questions — they sit at the intersection of **WebAuthn platform behavior** (what browsers/OSes allow) and **Latch’s app model** (how you map passkeys to smart accounts). Here is a full picture.

---

## Mental model: what lives where

When you create a passkey on Latch, three separate things get created:

| Layer | What's stored | Who holds it |
|-------|---------------|--------------|
| **Authenticator** (browser/OS) | Private key + credential ID | iCloud Keychain, Google Password Manager, Windows Hello, YubiKey, etc. |
| **Latch backend** | Public key, credential ID, smart account address, session user | Postgres (`WebauthnCredential`, `SmartAccount`) |
| **On-chain** | `key_data` = 65-byte P-256 pubkey \|\| credential ID bytes | Smart account contract |

The **private key never leaves the authenticator**. Your backend can tell you *which accounts exist* and *which public key/credential ID belongs to which C-address*, but it **cannot sign on the user’s behalf**. Recovery always means: get the user in front of a device that can use that passkey (or a backup).

---

## 1. Can you select a particular passkey to get the same account every time?

**Yes — that is exactly what `credentialId` + `allowCredentials` are for.**

WebAuthn lets the server say: “only accept authentication from *this* credential.” The browser then prompts for that specific passkey (Face ID, Touch ID, etc.) instead of showing a free-form picker.

Latch already does this in two places:

**Signing transactions** — pinned to one credential:

```104:116:lib/webauthn.ts
export async function signWithPasskey(
  credentialId: string,
  authDigest: Buffer,
  rpId?: string
): Promise<PasskeySignature> {
  const response = await startAuthentication({
    optionsJSON: {
      challenge: b64uEncode(authDigest),
      rpId,
      userVerification: "preferred",
      allowCredentials: [{ id: credentialId, type: "public-key" }],
```

**Login when the session already knows your credentials** — server sends all known credential IDs for that session user:

```30:57:app/api/webauthn/authentication/begin/route.ts
    const creds = await prisma.webauthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });

    const allowCredentials =
      creds.length > 0
        ? creds.map((c) => ({
            id: c.credentialId,
            type: "public-key" as const,
            ...
          }))
        : undefined;
```

**How consistency works in practice:**

- Each Latch account = one passkey = one unique `credentialId` → one C-address.
- If you pass the right `credentialId` in `allowCredentials`, you always get the same smart account (assuming that passkey still exists on the device).
- If you omit `allowCredentials` (fresh session, no known creds), the browser shows a **discoverable** passkey picker filtered to **Latch’s domain only** (`rpId` = e.g. `latch.example.com`). The user picks one; the server looks up `credentialId` in the DB and returns the matching account.

**What you cannot fully control:** the OS/browser UI. On some platforms, if `allowCredentials` lists multiple IDs, the user may still see a chooser. Pinning to a single ID (as `signWithPasskey` does) is the most reliable way to force “this exact passkey.”

---

## 2. Can you list “Latch passkeys” vs passkeys from other apps?

**Split answer: server yes, browser no.**

### What WebAuthn does *not* allow (by design)

Websites **cannot** call an API like “list all passkeys in my Google account.” That would be a privacy/security hole — every site could enumerate your vault.

The browser only exposes passkeys **during an active ceremony** (registration or authentication), and even then only credentials relevant to the current **Relying Party ID** (`rpId` = your domain).

So when Latch triggers `navigator.credentials.get()`:
- The picker shows passkeys registered for **Latch’s domain only**, not GitHub, Google, etc.
- You never see a global inventory from JavaScript.

### What Latch *can* do (and already does)

**Server-side list** — credentials your app registered:

```11:28:app/api/accounts/route.ts
    const accounts = await prisma.smartAccount.findMany({
      where: { userId },
      ...
      select: {
        smartAccountAddress: true,
        credentialId: true,
        ...
      },
    });
```

Each row is effectively “one Latch passkey account”: C-address + `credentialId`.

**UX pattern for multiple Latch accounts:**

1. Show the user their Latch accounts from the backend (labels, addresses, created dates).
2. When they pick one, start auth with `allowCredentials: [{ id: thatAccount.credentialId }]`.
3. Browser prompts for that specific passkey → consistent account every time.

**Registration uses `residentKey: "preferred"`**, which encourages discoverable (syncable) passkeys so usernameless login works on new devices — but listing is still server-driven, not vault-driven.

---

## 3. Multisig: getting the *right* passkey to sign

This is where app design matters beyond raw WebAuthn.

### On-chain vs off-chain

For multisig, what goes on-chain is `keyDataHex` (pubkey + credential ID bytes). The **MultisigMember** table stores `keyDataHex` but **not** `credentialId` separately — only the draft flow keeps `credentialId` in localStorage:

```15:18:lib/multisig-signers.ts
  /** WebAuthn: hex of 65-byte P-256 pubkey || credentialId bytes (External WebAuthn key_data). */
  keyDataHex?: string;
  /** WebAuthn: base64url credential id (for re-signing in the extension; optional in draft). */
  credentialId?: string;
```

To sign a multisig proposal, the client must call something like `signWithPasskey(credentialId, authDigest)`. That means you need the **credential ID**, not just `keyDataHex`.

**Good news:** `keyDataHex` embeds the credential ID (bytes after the first 65). You can derive `credentialId` from `keyDataHex` without storing it separately — but the app must do that consistently and persist it server-side for proposal approval flows.

### Two multisig passkey scenarios

| Scenario | What happens | How to sign later |
|----------|--------------|-------------------|
| **“Use existing passkey”** (login flow in `CollectSignersStep`) | User picks an existing Latch passkey; you capture `keyDataHex` + `credentialId` | Same passkey on same/synced device; pin with `allowCredentials: [{ id: credentialId }]` |
| **“Create passkey”** (new registration for multisig) | New passkey in the authenticator, new `keyDataHex` | User must use **that** passkey when approving — not their personal wallet passkey |

This is important: **a multisig member passkey is not the same as their personal Latch smart account passkey** unless they explicitly choose “use existing passkey.” If they create a dedicated passkey for the team wallet, signing a proposal requires that dedicated passkey.

### Recommended UX for multisig signing

1. **Label members clearly** in the UI (“Alice — Team Treasury passkey”).
2. When a proposal needs their signature, show **which member slot** they’re signing as (match `keyDataHex` / derived `credentialId` to `MultisigMember`).
3. Call `signWithPasskey(memberCredentialId, authDigest)` with a **single** entry in `allowCredentials`.
4. Optionally store `credentialId` on `MultisigMember` at registration time so approval UI doesn’t depend on localStorage or parsing hex.

The approve API already accepts the signature blob; the client-side gap is reliably resolving credential ID → passkey prompt:

```56:68:app/api/multisig/proposals/[id]/approve/webauthn/route.ts
    const approval = await prisma.multisigApproval.upsert({
      ...
        webauthnSigDataXdrHex: body.sigDataXdrHex.toLowerCase(),
```

---

## 4. New device / cross-device recovery

This is the biggest conceptual gap for many people: **the backend does not “hold” the passkey and cannot restore signing ability by itself.**

### What the backend *can* do

- Remember that credential `abc123` maps to C-address `C…`
- Verify a signature when the user proves they still have the passkey
- List accounts tied to a session after successful WebAuthn auth
- Re-attach credentials to a new session on discoverable login (see `authentication/finish` merging `userId`)

### What the backend *cannot* do

- Export or recreate the private key
- Sign transactions without the user completing WebAuthn on a device that has (or can reach) that passkey

### How users actually get their account on a new device

**Path A — Synced passkeys (most common today)**  
If the passkey was created as a **synced** passkey (Apple iCloud Keychain, Google Password Manager, etc.), the same passkey appears on other devices logged into that Apple/Google account. Latch stores `backedUp` on registration for this.

Flow on new device:
1. Open Latch → “Login with passkey”
2. Auth begin omits `allowCredentials` (fresh session) → discoverable login
3. Browser shows Latch passkeys from synced vault
4. User picks one → server finds `credentialId` in DB → returns smart account

**Path B — Cross-device QR / phone (hybrid / caBLE)**  
Some platforms let a laptop show a QR code; you scan with your phone’s passkey. Still the same credential, different transport — not something Latch implements explicitly; the browser/OS handles it if supported.

**Path C — Backup / second signer (what recovery endpoints are scaffolding for)**  
Your `/api/recovery/backup-passkey` route is a stub: record intent to add a **second** passkey or guardian on-chain. Real recovery means:

- Register a **backup passkey** on another device and add it as an additional signer (on-chain change), or
- Use a **delegated G-address** signer (Phantom/Freighter) as fallback, or
- Social/guardian recovery (not built yet)

```8:12:app/api/recovery/backup-passkey/route.ts
 * Recovery hook (DB + UX integration point):
 * - Today: this endpoint just records intent/metadata for adding a backup passkey.
 * - Future: wire this to an on-chain method that adds a second signer/guardian.
```

**Path D — Device-bound passkey with no backup**  
If someone created a passkey that **never synced** (some security keys, some “this device only” choices), a new laptop **cannot** use it. The C-address and funds still exist on-chain, but only that physical device can sign. Recovery requires pre-planned backup signers — there is no magic server-side unlock.

### “Efficiently get a particular account on a new device every time”

The reliable pattern:

```
┌─────────────────────────────────────────────────────────────┐
│  Latch DB: accounts[] with { address, credentialId, label } │
└───────────────────────────┬─────────────────────────────────┘
                            │
         User picks account OR uses discoverable login
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  WebAuthn auth with allowCredentials: [chosenCredentialId] │
│  (or discoverable + server lookup by returned credentialId)  │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Session gets smartAccountAddress + keyDataHex               │
│  User can sign — IF passkey exists on this device/sync       │
└─────────────────────────────────────────────────────────────┘
```

**Identity linking gap in Latch today:** sessions are cookie-based (`getOrCreateSession()`), and discoverable login can re-attach a credential to the current session user. There is no separate “Latch user account” (email/OAuth) tying multiple devices to one person unless they use the same synced passkey or you add explicit account linking. For production recovery, you typically want:

- Encourage **synced** passkeys at registration (`residentKey: "required"`, educate users)
- **Account picker** backed by server list + pinned `allowCredentials`
- **Backup passkey** flow (second credential, optionally on-chain)
- Optional **delegated signer** for multisig members who might lose a device

---

## Summary table

| Question | Short answer |
|----------|--------------|
| Select a specific passkey every time? | Yes — pass `credentialId` in `allowCredentials` (Latch does this for signing). |
| List Latch passkeys vs other apps? | Not from the browser vault; yes from Latch DB per session user; browser picker is already scoped to your `rpId`. |
| Multisig: use the right passkey? | Pin `credentialId` when signing; store/derive it from `keyDataHex`; distinguish “new multisig passkey” vs “reuse personal passkey”. |
| New device recovery? | Backend maps accounts but cannot restore keys; user needs synced passkey, backup passkey, or another signer. Recovery API is not fully wired yet. |

---

## Practical gaps in the current Latch codebase (worth knowing)

1. **Multisig members** persist `keyDataHex` but not `credentialId` server-side — approval UX will need derivation or an schema addition.
2. **Recovery** is metadata-only (`backup_passkey_intent`); no on-chain second signer yet.
3. **Session model** is browser-session-centric, not a durable cross-device user identity — fine for demo, limiting for “same person, many devices” without synced passkeys.
4. **Account switcher** exists for personal accounts (`/api/accounts`, `handleSwitchAccount`) but switching passkey accounts still requires re-auth with the right credential unless you keep multiple credential IDs in session state.

If you want to go deeper next, we can walk through a concrete “user creates 2 Latch accounts + 1 multisig passkey → signs proposal on phone vs laptop” flow step-by-step against your actual API routes. I'm in Ask mode so I can only explain and guide — switch to Agent mode if you want implementation changes (e.g. storing `credentialId` on `MultisigMember`, account picker UX).

