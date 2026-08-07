/**
 * Client helpers for multisig draft / join WebAuthn ceremonies.
 * Extension: pass chromeExtensionId in every body (rpId = extension id).
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";
import { assertWebAuthnClientAvailable } from "@/lib/webauthn-client";

export type PasskeyMaterial = { credentialId: string; keyDataHex: string };

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  }
  return data as T;
}

export async function multisigDraftRegisterPasskey(args: {
  draftId: string;
  displayName?: string;
  chromeExtensionId?: string;
}): Promise<PasskeyMaterial> {
  const begin = await postJson<{ options: unknown }>(
    `/api/multisig/drafts/${args.draftId}/webauthn/register/begin`,
    {
      displayName: args.displayName,
      chromeExtensionId: args.chromeExtensionId,
    }
  );
  assertWebAuthnClientAvailable();
  const regResponse = await startRegistration({
    optionsJSON: begin.options as Parameters<typeof startRegistration>[0]["optionsJSON"],
  });
  return postJson<PasskeyMaterial>(
    `/api/multisig/drafts/${args.draftId}/webauthn/register/finish`,
    {
      response: regResponse as RegistrationResponseJSON,
      chromeExtensionId: args.chromeExtensionId,
    }
  );
}

export async function multisigDraftAuthenticatePasskey(args: {
  draftId: string;
  chromeExtensionId?: string;
}): Promise<PasskeyMaterial> {
  const begin = await postJson<{ options: unknown }>(
    `/api/multisig/drafts/${args.draftId}/webauthn/authenticate/begin`,
    { chromeExtensionId: args.chromeExtensionId }
  );
  assertWebAuthnClientAvailable();
  const authResponse = await startAuthentication({
    optionsJSON: begin.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
  });
  return postJson<PasskeyMaterial>(
    `/api/multisig/drafts/${args.draftId}/webauthn/authenticate/finish`,
    {
      response: authResponse as AuthenticationResponseJSON,
      chromeExtensionId: args.chromeExtensionId,
    }
  );
}

export async function multisigJoinRegisterPasskey(args: {
  inviteToken: string;
  displayName?: string;
  chromeExtensionId?: string;
}): Promise<PasskeyMaterial> {
  const begin = await postJson<{ options: unknown }>(
    `/api/multisig/join/${args.inviteToken}/webauthn/register/begin`,
    {
      displayName: args.displayName,
      chromeExtensionId: args.chromeExtensionId,
    }
  );
  assertWebAuthnClientAvailable();
  const regResponse = await startRegistration({
    optionsJSON: begin.options as Parameters<typeof startRegistration>[0]["optionsJSON"],
  });
  return postJson<PasskeyMaterial>(
    `/api/multisig/join/${args.inviteToken}/webauthn/register/finish`,
    {
      response: regResponse as RegistrationResponseJSON,
      chromeExtensionId: args.chromeExtensionId,
    }
  );
}

export async function multisigJoinAuthenticatePasskey(args: {
  inviteToken: string;
  chromeExtensionId?: string;
}): Promise<PasskeyMaterial> {
  const begin = await postJson<{ options: unknown }>(
    `/api/multisig/join/${args.inviteToken}/webauthn/authenticate/begin`,
    { chromeExtensionId: args.chromeExtensionId }
  );
  assertWebAuthnClientAvailable();
  const authResponse = await startAuthentication({
    optionsJSON: begin.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
  });
  return postJson<PasskeyMaterial>(
    `/api/multisig/join/${args.inviteToken}/webauthn/authenticate/finish`,
    {
      response: authResponse as AuthenticationResponseJSON,
      chromeExtensionId: args.chromeExtensionId,
    }
  );
}
