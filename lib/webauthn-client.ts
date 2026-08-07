/**
 * RP ID for passkey ceremonies — must match registration (WEBAUTHN_RP_ID / page host).
 */
export function getWebauthnRpIdForCeremony(): string {
  if (typeof window === "undefined") return "localhost";
  const env = process.env.NEXT_PUBLIC_WEBAUTHN_RP_ID?.trim();
  const host = window.location.hostname;
  if (!env || env === "localhost" || env === "127.0.0.1") {
    return host;
  }
  return env;
}

/**
 * Client-side WebAuthn availability checks (browser secure context).
 */

const INSECURE_CONTEXT_MESSAGE =
  "Passkeys need a secure browser context. Use https://localhost:3000 on this computer, or run `npm run dev:https` and open the HTTPS Network URL on other devices (not http://192.168.x.x). Plain HTTP on a LAN IP is blocked by the browser even though passkeys work on localhost.";

/**
 * Throws a clear error when WebAuthn APIs are unavailable (usually HTTP on a LAN IP).
 * @simplewebauthn/browser reports this as "WebAuthn is not supported in this browser".
 */
export function assertWebAuthnClientAvailable(): void {
  if (typeof window === "undefined") {
    throw new Error("WebAuthn is only available in the browser.");
  }

  if (!window.isSecureContext) {
    const host = window.location.hostname;
    const isLanIp =
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host);

    if (isLanIp && window.location.protocol === "http:") {
      throw new Error(INSECURE_CONTEXT_MESSAGE);
    }

    throw new Error(
      `${INSECURE_CONTEXT_MESSAGE} (current origin: ${window.location.origin})`
    );
  }

  if (typeof PublicKeyCredential !== "function") {
    throw new Error(
      "This browser does not expose WebAuthn (PublicKeyCredential). Try a recent Chrome, Safari, or Firefox."
    );
  }
}
