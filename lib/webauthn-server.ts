import * as crypto from "crypto";
import { decode as cborDecode } from "cbor-x";

/** Chrome packed extension IDs are 32 chars from [a-p] (base-16 alphabet). */
const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Some Chromium builds hash `chrome-extension://<id>` in authData even when options.rp.id is the
 * bare 32-char id. Verification must accept SHA-256 of either form.
 */
export function chromeExtensionRpIdCandidates(ext: string): string[] {
  const e = ext.trim().toLowerCase();
  if (!CHROME_EXTENSION_ID_RE.test(e)) return [e];
  return [e, `chrome-extension://${e}`];
}

export class WebauthnCeremonyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebauthnCeremonyConfigError";
  }
}

function stripSurroundingQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

function parseCommaSeparatedEnv(name: string): string[] {
  const raw = stripSurroundingQuotes(process.env[name]?.trim() ?? "");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => stripSurroundingQuotes(s.trim()))
    .filter(Boolean);
}

/** Allowed Chrome extension IDs for extension-scoped WebAuthn (`WEBAUTHN_EXTENSION_IDS`). */
export function getAllowedWebauthnExtensionIds(): string[] {
  return parseCommaSeparatedEnv("WEBAUTHN_EXTENSION_IDS");
}

/**
 * Extracts the 32-char extension id from `Origin`, `Referer`, or any `chrome-extension://…` URL.
 */
export function parseChromeExtensionRpIdFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("chrome-extension://")) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "chrome-extension:") return null;
    const id = (u.hostname || "").toLowerCase();
    return CHROME_EXTENSION_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Optional on extension → API `fetch`: some proxies omit `Origin`; the extension can send this.
 */
export function parseChromeExtensionIdFromHeaders(req: Request): string | null {
  const raw =
    req.headers.get("x-latch-chrome-extension-id") ?? req.headers.get("x-chrome-extension-id");
  if (!raw?.trim()) return null;
  const id = raw.trim().toLowerCase();
  return CHROME_EXTENSION_ID_RE.test(id) ? id : null;
}

/**
 * Extension `fetch` usually sends `Origin: chrome-extension://<id>`. Some stacks omit `Origin` but
 * send `Referer: chrome-extension://<id>/popup.html`, or `X-Latch-Chrome-Extension-Id`.
 */
export function getChromeExtensionIdFromRequest(req: Request): string | null {
  const fromHeader = parseChromeExtensionIdFromHeaders(req);
  if (fromHeader) return fromHeader;
  const fromOrigin = parseChromeExtensionRpIdFromUrl(req.headers.get("origin"));
  if (fromOrigin) return fromOrigin;
  return parseChromeExtensionRpIdFromUrl(req.headers.get("referer"));
}

function normalizeChromeExtensionOriginUrl(s: string): string {
  return s.trim().toLowerCase().replace(/\/+$/, "");
}

/** @deprecated Use {@link getChromeExtensionIdFromRequest} */
export function getChromeExtensionIdFromRequestOrigin(req: Request): string | null {
  return getChromeExtensionIdFromRequest(req);
}

/**
 * RP ID candidates for @simplewebauthn verify* (handles stale `rp_id` vs `origin` rows and
 * extension id casing). Authenticator rpIdHash must match one of these.
 */
export function getExpectedRpidsForVerification(input: {
  challengeOrigin: string;
  challengeRpId: string;
  clientDataOrigin: string | null;
  finishChromeExtensionId?: string | null;
}): string[] {
  const { challengeOrigin, challengeRpId, clientDataOrigin, finishChromeExtensionId } = input;
  const ids = new Set<string>();
  const push = (s: string | null | undefined) => {
    const t = (s ?? "").trim();
    if (!t) return;
    ids.add(t);
    const ext =
      parseChromeExtensionRpIdFromUrl(t) ??
      (CHROME_EXTENSION_ID_RE.test(t.toLowerCase()) ? t.toLowerCase() : null);
    if (ext) for (const c of chromeExtensionRpIdCandidates(ext)) ids.add(c);
  };
  push(challengeRpId);
  push(parseChromeExtensionRpIdFromUrl(challengeOrigin));
  push(parseChromeExtensionRpIdFromUrl(clientDataOrigin));
  push(finishChromeExtensionId ?? undefined);
  return ids.size ? [...ids] : [challengeRpId.trim() || "localhost"];
}

/**
 * Build `expectedOrigin` / `expectedRPID` for @simplewebauthn verify* on finish.
 *
 * For chrome-extension assertions: verify with `chrome-extension://<id>` as expectedOrigin and
 * expectedRPID including both the bare extension id and `chrome-extension://<id>` (Chromium may
 * hash the latter in authData). Sources: JSON `chromeExtensionId`, extension headers, clientData
 * origin — so a wrong `rp_id` row from begin cannot cause "Unexpected RP ID hash".
 */
export function resolveWebauthnFinishVerification(input: {
  challengeOrigin: string;
  challengeRpId: string;
  clientDataOrigin: string | null;
  chromeExtensionId?: unknown;
  request?: Request;
}): { expectedOrigin: string; expectedRPID: string | string[] } {
  const { challengeOrigin, challengeRpId, clientDataOrigin, chromeExtensionId, request } = input;
  if (!clientDataOrigin?.trim()) {
    throw new WebauthnCeremonyConfigError("Missing clientData origin");
  }

  const extFromClient = parseChromeExtensionRpIdFromUrl(clientDataOrigin);
  const extFromHeader = request ? parseChromeExtensionIdFromHeaders(request) : null;

  let extFromBody: string | null = null;
  if (chromeExtensionId !== undefined && chromeExtensionId !== null) {
    if (typeof chromeExtensionId !== "string") {
      throw new WebauthnCeremonyConfigError("chromeExtensionId must be a string");
    }
    const t = chromeExtensionId.trim().toLowerCase();
    if (t) {
      if (!CHROME_EXTENSION_ID_RE.test(t)) {
        throw new WebauthnCeremonyConfigError("Invalid chromeExtensionId format");
      }
      extFromBody = t;
    }
  }

  const parts = [extFromBody, extFromHeader, extFromClient].filter((x): x is string => Boolean(x));
  const uniq = [...new Set(parts)];
  if (uniq.length > 1) {
    throw new WebauthnCeremonyConfigError(
      "Conflicting extension ids (chromeExtensionId JSON, X-Latch-Chrome-Extension-Id header, clientData origin)"
    );
  }
  const ext = uniq[0] ?? null;

  const allowed = getAllowedWebauthnExtensionIds().map((x) => x.trim().toLowerCase()).filter(Boolean);

  if (ext) {
    if (!allowed.length || !allowed.includes(ext)) {
      throw new WebauthnCeremonyConfigError(
        "Extension id is not in WEBAUTHN_EXTENSION_IDS allowlist"
      );
    }
    const expectedOrigin = `chrome-extension://${ext}`;
    if (normalizeChromeExtensionOriginUrl(clientDataOrigin) !== normalizeChromeExtensionOriginUrl(expectedOrigin)) {
      throw new WebauthnCeremonyConfigError(
        "clientData origin does not match chrome-extension ceremony (expected chrome-extension://<id>)"
      );
    }
    return {
      expectedOrigin,
      expectedRPID: chromeExtensionRpIdCandidates(ext),
    };
  }

  if (clientDataOrigin !== challengeOrigin) {
    throw new WebauthnCeremonyConfigError("WebAuthn response origin does not match issued challenge");
  }
  return {
    expectedOrigin: challengeOrigin,
    expectedRPID: getExpectedRpidsForVerification({
      challengeOrigin,
      challengeRpId,
      clientDataOrigin,
      finishChromeExtensionId: null,
    }),
  };
}

/**
 * When `chromeExtensionId` is set, returns rpId + origin for ceremonies in an extension page.
 * Requires `WEBAUTHN_EXTENSION_IDS` to include that id (comma-separated env).
 * Otherwise falls back to hostname / request-derived origins for same-site web flows.
 */
export function resolveWebauthnCeremonyContext(
  req: Request,
  chromeExtensionId?: string | null
): { rpId: string; origin: string } {
  const fromBody = typeof chromeExtensionId === "string" ? chromeExtensionId.trim().toLowerCase() : "";
  const fromHeader = parseChromeExtensionIdFromHeaders(req);
  const fromOriginRef =
    parseChromeExtensionRpIdFromUrl(req.headers.get("origin")) ??
    parseChromeExtensionRpIdFromUrl(req.headers.get("referer"));
  const parts = [fromBody, fromHeader, fromOriginRef].filter((x): x is string => Boolean(x));
  const uniq = [...new Set(parts)];
  if (uniq.length > 1) {
    throw new WebauthnCeremonyConfigError(
      "Conflicting extension ids (chromeExtensionId JSON, X-Latch-Chrome-Extension-Id header, Origin/Referer)"
    );
  }
  const extRaw = uniq[0] || "";
  if (!extRaw) {
    return {
      rpId: getRpIdFromRequest(req),
      origin: getExpectedOriginFromRequest(req),
    };
  }

  const ext = extRaw.toLowerCase();
  if (!CHROME_EXTENSION_ID_RE.test(ext)) {
    throw new WebauthnCeremonyConfigError("Invalid chromeExtensionId format");
  }

  const allowed = getAllowedWebauthnExtensionIds().map((id) => id.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) {
    throw new WebauthnCeremonyConfigError(
      "Extension WebAuthn requires WEBAUTHN_EXTENSION_IDS to list allowed extension ids"
    );
  }
  if (!allowed.includes(ext)) {
    throw new WebauthnCeremonyConfigError(
      "Extension id (from Origin or chromeExtensionId) is not in WEBAUTHN_EXTENSION_IDS allowlist"
    );
  }

  return {
    rpId: ext,
    origin: `chrome-extension://${ext}`,
  };
}

function requestOriginFromHeaders(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    const proto = req.headers.get("x-forwarded-proto") || "http";
    const host = req.headers.get("host") || "localhost";
    return `${proto}://${host}`;
  }
}

function requestRpIdFromHeaders(req: Request): string {
  try {
    return new URL(req.url).hostname;
  } catch {
    const host = req.headers.get("host") || "localhost";
    return host.split(":")[0];
  }
}

/**
 * In dev, use the request Host when env is pinned to localhost but the user opened a LAN / HTTPS URL.
 */
function useRequestCeremonyHostInDev(req: Request): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (process.env.WEBAUTHN_DEV_TRUST_REQUEST_HOST === "1") return true;

  const derivedHost = requestRpIdFromHeaders(req);
  const envOrigin = process.env.WEBAUTHN_ORIGIN?.trim();
  if (!envOrigin) return true;

  try {
    const envHost = new URL(envOrigin).hostname;
    return (
      (envHost === "localhost" || envHost === "127.0.0.1") &&
      derivedHost !== "localhost" &&
      derivedHost !== "127.0.0.1"
    );
  } catch {
    return false;
  }
}

export function getRpIdFromRequest(req: Request): string {
  if (useRequestCeremonyHostInDev(req)) {
    return requestRpIdFromHeaders(req);
  }

  const env = process.env.WEBAUTHN_RP_ID;
  if (env?.trim()) return env.trim();

  return requestRpIdFromHeaders(req);
}

export function getExpectedOriginFromRequest(req: Request): string {
  if (useRequestCeremonyHostInDev(req)) {
    return requestOriginFromHeaders(req);
  }

  const env = process.env.WEBAUTHN_ORIGIN;
  if (env?.trim()) return env.trim();

  return requestOriginFromHeaders(req);
}

export function sha256Hex(str: string) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

export function stableUserIdBytes(userId: string): Uint8Array {
  // @simplewebauthn/server no longer accepts string userID.
  // Using UTF-8 bytes keeps a stable mapping while still allowing us to store userId as TEXT in SQLite.
  return new TextEncoder().encode(userId);
}

export function toBase64Url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function fromBase64Url(str: string) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Decode clientDataJSON (base64url) and return the `origin` field, or null if invalid. */
export function getOriginFromClientDataJSON(clientDataJSON: string): string | null {
  try {
    const json = JSON.parse(fromBase64Url(clientDataJSON).toString("utf8")) as { origin?: unknown };
    return typeof json.origin === "string" ? json.origin : null;
  } catch {
    return null;
  }
}

/**
 * Convert a COSE_Key (EC2 P-256) buffer to raw uncompressed 65-byte pubkey (0x04||x||y).
 * @simplewebauthn/server gives `credentialPublicKey` as COSE bytes.
 */
export function coseEc2ToRawP256Uncompressed(cosePublicKey: Buffer): Buffer {
  const decoded = cborDecode(new Uint8Array(cosePublicKey)) as Map<number, unknown> | Record<string, unknown>;

  const get = (k: number): unknown => {
    if (decoded instanceof Map) return decoded.get(k);
    // cbor-x may decode to plain object with string keys
    return (decoded as any)[String(k)];
  };

  const x = get(-2);
  const y = get(-3);

  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("Unsupported COSE key format: missing -2/-3 coordinates");
  }
  if (x.byteLength !== 32 || y.byteLength !== 32) {
    throw new Error("Unsupported COSE key format: expected 32-byte x/y");
  }
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]);
}

