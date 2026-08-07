# Latch test-ground (Next.js) — WebAuthn / passkey implementation guide

**Audience:** Engineers updating [`references/latch-test-ground`](references/latch-test-ground) API route handlers (Next.js + `@simplewebauthn/server`). Use this as the reference port alongside production Go.

**Companion docs:**

- Production Go guide: [`LATCH_GO_BACKEND_WEBAUTHN_PASSKEY_IMPLEMENTATION.md`](LATCH_GO_BACKEND_WEBAUTHN_PASSKEY_IMPLEMENTATION.md)
- Extension contract: [`LATCH_BACKEND_WEBAUTHN_PASSKEYS.md`](LATCH_BACKEND_WEBAUTHN_PASSKEYS.md)
- Shared RP / ceremony helpers: `lib/webauthn-server.ts`
- Multisig draft ceremonies: `lib/multisig-draft-webauthn.ts`

**Goal:** Same product outcomes as Go — distinct passkeys per enrollment (solo + multisig), honored display names, discoverable login — while keeping a single HTTP `sid` session per browser/client.

---

## Concepts (do not conflate)

| Concept | Meaning | Change needed? |
|--------|---------|----------------|
| **HTTP session (`sid`)** | `getOrCreateSession()` in `lib/session.ts` → backend `userId`. | **Keep.** One session may own many credentials. |
| **WebAuthn `user.id`** | Passed as `userID` into `generateRegistrationOptions`. Same value across creates → authenticator may **overwrite** prior passkeys. | **Unique per new passkey enrollment.** |
| **Credential ID** | Stored in Prisma `WebauthnCredential.credentialId`. | Keep; use for exclude / allow lists. |
| **RP ID** | `resolveWebauthnCeremonyContext` already maps `chromeExtensionId` → extension RP. | Keep. |
| **Multisig member `label`** | Draft member roster field. | Not a substitute for WebAuthn `userName` / display name. |

Do **not** create a new `sid` per Latch wallet or per multisig to “fix” GPM. Fix WebAuthn options instead.

---

## Current state vs gaps

### What already works better than Go

| Area | Behavior |
|------|----------|
| Personal register begin | Accepts `displayName`; sets `userName: body.displayName \|\| "local-user"`. |
| Multisig draft/join register begin | Passes `displayName` into `beginDraftWebauthnRegistration` → `userName: displayName \|\| "multisig-member"`. |
| Auth begin (personal) | If session has **no** creds, sets `allowCredentials` to `undefined` (field omitted) → discoverable login. Comment in route explains this. |

### What is still wrong / incomplete

1. **`userID: stableUserIdBytes(userId)`** uses the **session** `userId` on every registration (personal + multisig helpers). Same overwrite risk as Go.
2. **No `excludeCredentials`** in `generateRegistrationOptions` (personal or multisig).
3. **Fallback names** `"local-user"` / `"multisig-member"` are shared constants when `displayName` is missing — prefer a unique fallback.
4. **`userDisplayName`:** `@simplewebauthn/server` may derive display name from `userName`; set **`userDisplayName`** explicitly to the requested display name so options always carry both `user.name` and `user.displayName` matching the extension.
5. Multisig auth-begin routes should mirror personal: omit empty allowlists (audit `app/api/multisig/**/authenticate/begin`).

---

## Routes to update

### Personal

| Method | Path | File |
|--------|------|------|
| POST | `/api/webauthn/registration/begin` | `app/api/webauthn/registration/begin/route.ts` |
| POST | `/api/webauthn/authentication/begin` | `app/api/webauthn/authentication/begin/route.ts` (tighten / keep omit-empty) |

Finish routes stay verify + persist; only begin options (and optional challenge metadata) change.

### Multisig

| Method | Path | Implementation |
|--------|------|----------------|
| POST | `/api/multisig/drafts/[id]/webauthn/register/begin` | route → `beginDraftWebauthnRegistration` in `lib/multisig-draft-webauthn.ts` |
| POST | `/api/multisig/join/[token]/webauthn/register/begin` | same helper (or join-specific wrapper that calls it) |
| POST | `.../webauthn/authenticate/begin` (draft + join) | ensure empty allowlist omitted |

Centralize registration-option building so personal and multisig cannot drift.

---

## Required fixes

### Fix A — Honor `displayName` on every account / enroll path

**Body (already used):**

```json
{ "displayName": "Latch account 2 · Family multisig", "chromeExtensionId": "<optional>" }
```

**In `generateRegistrationOptions`:**

```ts
const label = (displayName?.trim() || `Latch passkey ${crypto.randomUUID().slice(0, 8)}`);

const options = await generateRegistrationOptions({
  rpID,
  rpName: "Latch",
  userID: /* see Fix B — not session user bytes */,
  userName: label,
  userDisplayName: label, // explicit: GPM + extension assert on displayName
  // ...
  excludeCredentials: /* Fix C */,
});
```

Apply in:

- `app/api/webauthn/registration/begin/route.ts`
- `lib/multisig-draft-webauthn.ts` → `beginDraftWebauthnRegistration`

Never hardcode `"Latch User"` or `"Multisig Signer"`. Prefer unique fallbacks over shared `"local-user"` / `"multisig-member"` when the client omits `displayName`.

### Fix B — Unique stable WebAuthn `user.id` per passkey enrollment

**Today (bug):**

```ts
userID: stableUserIdBytes(userId) // session userId — reused every create
```

**Target:**

1. On each registration begin, allocate `const webauthnUserHandle = crypto.randomUUID()` (or 16–32 random bytes).
2. Pass `userID: stableUserIdBytes(webauthnUserHandle)` (or raw `Uint8Array` of the new id — keep using `stableUserIdBytes` if the handle is a string UUID).
3. Store the handle on the challenge row (add column or encode in an existing metadata field) so finish can write it onto the credential if desired.
4. Persist credential with **session** `userId` as owner (unchanged Prisma `userId` FK). Session ownership ≠ WebAuthn handle.
5. New enroll (solo smart account or new multisig member passkey) → new handle. Reusing an existing passkey as a multisig member does not call register begin.

Optional Prisma:

```prisma
// WebauthnChallenge
webauthnUserHandle String? @map("webauthn_user_handle")

// WebauthnCredential
webauthnUserHandle String? @map("webauthn_user_handle")
```

**Anti-patterns:** session `userId` as WebAuthn `userID`; client-regenerated ids; one handle for “the whole multisig wallet.”

### Fix C — `excludeCredentials`

Before `generateRegistrationOptions`:

```ts
const existing = await prisma.webauthnCredential.findMany({
  where: { userId },
  select: { credentialId: true, transports: true },
});

excludeCredentials: existing.map((c) => ({
  id: c.credentialId,
  type: "public-key" as const,
  // omit transports or pass parsed list; do not force ["internal"] only
})),
```

Use in personal begin and `beginDraftWebauthnRegistration` (exclude session user’s known creds for additive enroll).

### Fix D — Authentication `allowCredentials`

**Personal** (`authentication/begin/route.ts`) already does the right thing when `creds.length === 0` → `undefined`. Keep that.

Audit multisig authenticate begin helpers: if they always pass `allowCredentials: []`, change to omit when empty.

When `creds.length > 0`, pass the full mapped list. Prefer omitting `transports` unless you know they are accurate; restrictive transports hide GPM-synced keys.

### Fix E — Shared builder (recommended)

Add something like `lib/webauthn-registration-options.ts`:

```ts
export async function buildRegistrationOptions(args: {
  request: Request;
  sessionUserId: string;
  displayName?: string;
  chromeExtensionId?: string;
  challengePurpose: string; // "registration" | draftRegisterPurpose(draftId) | ...
}): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; webauthnUserHandle: string }>
```

Personal and multisig begin routes only resolve authz (draft ownership / invite), then call this helper. Guarantees display name, unique `userID`, exclude list, and RP context stay aligned with Go.

---

## Suggested code touchpoints

| Concern | Location |
|---------|----------|
| Session cookie | `lib/session.ts` (no per-wallet session) |
| RP / extension id | `lib/webauthn-server.ts` (`resolveWebauthnCeremonyContext`, finish verification) |
| Personal register begin | `app/api/webauthn/registration/begin/route.ts` |
| Personal auth begin | `app/api/webauthn/authentication/begin/route.ts` |
| Multisig register options | `lib/multisig-draft-webauthn.ts` → `beginDraftWebauthnRegistration` |
| Multisig draft/join routes | `app/api/multisig/drafts/[id]/webauthn/register/begin/route.ts`, `app/api/multisig/join/[token]/webauthn/register/begin/route.ts` |
| Schema | `prisma/schema.prisma` (+ migration) if persisting `webauthnUserHandle` |

---

## Verification

1. Same session: create two personal passkeys → two GPM entries, distinct names, distinct WebAuthn `user.id` (inspect begin options).
2. Personal passkey, then multisig **new** enroll with `displayName` including context → personal key remains; new key shows requested label (not a constant).
3. Begin options: `user.displayName` === requested `displayName`; `user.name` distinguishable.
4. Second register begin includes first credential in `excludeCredentials`.
5. New session / zero known creds: auth begin **omits** `allowCredentials` → discoverable Latch passkeys can appear.
6. Extension against test-ground: no “ignored display name” warning; `chromeExtensionId` RP path still works.

**Out of scope:** Retroactive rename of passkeys already saved under old labels / old shared `user.id`.

---

## Parity with Go production

Implement the same four behavioral guarantees in both codebases:

1. Honor `displayName` → `user.name` + `user.displayName`
2. Unique stable WebAuthn `user.id` per enrollment
3. `excludeCredentials` on register begin
4. Auth: omit empty `allowCredentials`; never send a blocking `[]`

test-ground is already closer on (1) and (4); prioritize (2) and (3), then harden display-name + multisig auth parity so both backends behave identically for the extension.
