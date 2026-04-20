/**
 * WebAuthn client library for Latch smart account integration.
 *
 * Handles passkey registration, signing, and all encoding needed to
 * produce a valid AuthPayload for the on-chain WebAuthn verifier.
 *
 * On-chain verifier expects WebAuthnSigData { authenticator_data, client_data, signature }
 * XDR-encoded as a sorted symbol-keyed map, then wrapped in AuthPayload.
 */

import {
  startRegistration,
  startAuthentication,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { hash, xdr, Address } from "@stellar/stellar-sdk";
import { hashSorobanAuthPayload } from "@/lib/soroban-auth-payload";

// ─── base64url helpers (no external package) ──────────────────────────────────

function b64uEncode(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64uDecode(str: string): Buffer {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PUBKEY_SIZE = 65; // 0x04 prefix + 32-byte X + 32-byte Y

// ─── Registration ─────────────────────────────────────────────────────────────

export interface PasskeyRegistration {
  /** 65-byte uncompressed P-256 public key */
  publicKey: Uint8Array;
  /** base64url credential ID assigned by the authenticator */
  credentialId: string;
  /** keyData = publicKey (65 bytes) || credentialId bytes — what the factory receives */
  keyData: Buffer;
}

/**
 * Register a new passkey and return the key material needed for factory deployment.
 *
 * The factory's WebAuthn verifier expects keyData = 65-byte pubkey || credentialId.
 * Total must be > 65 bytes and first byte must be 0x04.
 */
export async function registerPasskey(
  rpId: string,
  rpName: string,
  userName: string
): Promise<PasskeyRegistration> {
  const challenge = generateChallenge();

  const response = await startRegistration({
    optionsJSON: {
      challenge,
      rp: { id: rpId, name: rpName },
      user: {
        id: b64uEncode(Buffer.from(`${userName}:${Date.now()}:${Math.random()}`)),
        name: userName,
        displayName: userName,
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }], // ES256 = P-256
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      timeout: 60000,
    },
  });

  const publicKey = await extractPublicKey(response.response);
  const credentialId = response.id;
  const keyData = buildKeyData(publicKey, credentialId);

  return { publicKey, credentialId, keyData };
}

// ─── Signing ─────────────────────────────────────────────────────────────────

export interface PasskeySignature {
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
  /** 64-byte compact P-256 signature (r || s, low-S normalised) */
  signature: Buffer;
}

/**
 * Sign an auth digest with an existing passkey.
 *
 * The OZ WebAuthn verifier validates that:
 *   - clientDataJSON.type === "webauthn.get"
 *   - clientDataJSON.challenge === base64url(authDigest[0..32])
 *   - authenticatorData UP + UV flags are set
 *   - secp256r1_verify(pubKey, SHA256(authData || SHA256(clientData)), signature)
 *
 * @simplewebauthn handles all of this automatically by passing authDigest
 * as the challenge — the browser base64url-encodes it into clientDataJSON.
 */
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
      timeout: 60000,
    },
  });

  const authenticatorData = b64uDecode(response.response.authenticatorData);
  const clientDataJSON = b64uDecode(response.response.clientDataJSON);
  const derSignature = b64uDecode(response.response.signature);
  const signature = Buffer.from(derToCompact(derSignature));

  return { authenticatorData, clientDataJSON, signature };
}

// ─── Auth digest ──────────────────────────────────────────────────────────────

/**
 * Compute the auth digest the passkey must sign.
 *
 * auth_digest = SHA256(signaturePayload || contextRuleIds.toXDR())
 *
 * This matches the OZ smart account's do_check_auth which calls:
 *   auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
 * before forwarding to the verifier.
 */
export function computeAuthDigest(
  authEntry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
  contextRuleIds: number[]
): Buffer {
  const signaturePayload = hashSorobanAuthPayload(authEntry, networkPassphrase);
  const ruleIdsXdr = xdr.ScVal.scvVec(
    contextRuleIds.map((id) => xdr.ScVal.scvU32(id))
  ).toXDR();
  return hash(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)]));
}

// ─── XDR encoding ────────────────────────────────────────────────────────────

/**
 * Encode PasskeySignature as the XDR bytes the on-chain verifier expects.
 *
 * The verifier does: WebAuthnSigData::from_xdr(e, &sig_data)
 * WebAuthnSigData { authenticator_data: Bytes, client_data: Bytes, signature: BytesN<64> }
 * encodes as a sorted symbol-keyed ScMap.
 */
export function encodeWebAuthnSigData(sig: PasskeySignature): Buffer {
  return Buffer.from(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("authenticator_data"),
        val: xdr.ScVal.scvBytes(sig.authenticatorData),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("client_data"),
        val: xdr.ScVal.scvBytes(sig.clientDataJSON),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(sig.signature),
      }),
    ]).toXDR()
  );
}

/**
 * Build the full AuthPayload ScVal to set on the auth entry's credentials.
 *
 * AuthPayload { context_rule_ids: Vec<u32>, signers: Map<Signer, Bytes> }
 * Signer::External(verifier_address, key_data)
 */
export function buildWebAuthnAuthPayload(
  verifierAddress: string,
  keyData: Buffer,
  sigDataXdr: Buffer,
  contextRuleIds: number[]
): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifierAddress).toScAddress()),
    xdr.ScVal.scvBytes(keyData),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerKey,
          val: xdr.ScVal.scvBytes(sigDataXdr),
        }),
      ]),
    }),
  ]);
}

// ─── Key data helpers ─────────────────────────────────────────────────────────

/**
 * Build keyData for the factory: 65-byte pubkey || credentialId bytes.
 * Factory validation: len > 65, first byte == 0x04.
 */
export function buildKeyData(publicKey: Uint8Array, credentialId: string): Buffer {
  return Buffer.concat([Buffer.from(publicKey), b64uDecode(credentialId)]);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function generateChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64uEncode(Buffer.from(bytes));
}

/**
 * Extract 65-byte uncompressed P-256 public key from a WebAuthn registration response.
 */
async function extractPublicKey(
  response: RegistrationResponseJSON["response"]
): Promise<Uint8Array> {
  // Path 1: response.publicKey (SPKI-encoded, available in most modern browsers)
  if (response.publicKey) {
    const spki = b64uDecode(response.publicKey);
    if (spki.length === PUBKEY_SIZE && spki[0] === 0x04) {
      return new Uint8Array(spki);
    }
    try {
      const imported = await crypto.subtle.importKey(
        "spki",
        new Uint8Array(spki),
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        []
      );
      const raw = await crypto.subtle.exportKey("raw", imported);
      const rawBuf = Buffer.from(new Uint8Array(raw));
      if (rawBuf.length === PUBKEY_SIZE && rawBuf[0] === 0x04) {
        return new Uint8Array(rawBuf);
      }
    } catch {
      // fall through to authenticatorData path
    }
  }

  // Path 2: authenticatorData (works on Safari/mobile where publicKey may be absent)
  if (response.authenticatorData) {
    const authData = b64uDecode(response.authenticatorData);
    // authenticatorData layout: rpIdHash(32) + flags(1) + signCount(4) + attestedCredData...
    // attestedCredData: aaguid(16) + credIdLen(2) + credId(credIdLen) + COSE pubkey
    const credIdLen = (authData[53] << 8) | authData[54];
    const cosePubKey = authData.slice(55 + credIdLen);

    // COSE ES256 key: map with x at offset 10 (after fixed header) and y 37 bytes later
    if (cosePubKey.length >= 77) {
      const x = cosePubKey.slice(10, 42);
      const y = cosePubKey.slice(45, 77);
      return new Uint8Array(Buffer.concat([Buffer.from([0x04]), x, y]));
    }
  }

  // Path 3: attestationObject CBOR — scan for COSE ES256 key prefix
  if (response.attestationObject) {
    const attObj = b64uDecode(response.attestationObject);
    const prefix = Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
    const idx = attObj.indexOf(prefix);
    if (idx !== -1) {
      const start = idx + prefix.length;
      const x = attObj.slice(start, start + 32);
      const y = attObj.slice(start + 35, start + 67);
      return new Uint8Array(Buffer.concat([Buffer.from([0x04]), x, y]));
    }
  }

  throw new Error("Could not extract P-256 public key from WebAuthn registration response");
}

/**
 * Convert DER-encoded ECDSA signature to 64-byte compact (r || s) with low-S normalisation.
 *
 * DER format: 0x30 [len] 0x02 [rLen] [r] 0x02 [sLen] [s]
 * Stellar's secp256r1_verify requires low-S: S <= n/2
 */
function derToCompact(der: Buffer): Uint8Array {
  let offset = 2; // skip 0x30 + total length

  const rLen = der[offset + 1];
  const r = der.slice(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  const sLen = der[offset + 1];
  const s = der.slice(offset + 2, offset + 2 + sLen);

  const rBig = BigInt("0x" + r.toString("hex"));
  let sBig = BigInt("0x" + s.toString("hex"));

  // secp256r1 curve order n
  const n = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  if (sBig > n / 2n) {
    sBig = n - sBig;
  }

  const rPadded = Buffer.from(rBig.toString(16).padStart(64, "0"), "hex");
  const sPadded = Buffer.from(sBig.toString(16).padStart(64, "0"), "hex");

  return new Uint8Array(Buffer.concat([rPadded, sPadded]));
}
