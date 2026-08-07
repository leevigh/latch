/**
 * Client-orchestrated context-rule ensure + retry.
 * Setup txs require a user signature — APIs only emit NO_CONTEXT_RULE.
 */

export const CONTEXT_RULE_SETUP_MAX_ATTEMPTS = 5;

export function isMissingContextRuleError(
  status: number,
  code?: string | null,
  suggestedAction?: string | null
): boolean {
  if (
    suggestedAction === "setup_transfer_rule" ||
    suggestedAction === "setup_swap_rule"
  ) {
    return status === 409 || status === 400;
  }
  if (code !== "NO_CONTEXT_RULE" && code !== "context_rule_missing") {
    return false;
  }
  return status === 409 || status === 400;
}

export type AttemptResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      code?: string;
      message?: string;
      suggestedAction?: string;
    };

export type EnsureContextRuleOptions = {
  maxAttempts?: number;
  /** Invoked before each setup (UI status / signing state). */
  onNeedsSetup?: () => void;
  /** Build + sign + submit a setup rule tx (or no-op if alreadyConfigured). */
  runSetup: () => Promise<void>;
};

/**
 * Retry `attempt` after running `runSetup` whenever the failure is a missing
 * CallContract context rule.
 */
export async function ensureContextRuleThen<T>(
  attempt: () => Promise<AttemptResult<T>>,
  opts: EnsureContextRuleOptions
): Promise<T> {
  const max = opts.maxAttempts ?? CONTEXT_RULE_SETUP_MAX_ATTEMPTS;

  for (let i = 0; i < max; i++) {
    const result = await attempt();
    if (result.ok) return result.value;

    if (
      isMissingContextRuleError(
        result.status,
        result.code,
        result.suggestedAction
      )
    ) {
      opts.onNeedsSetup?.();
      await opts.runSetup();
      continue;
    }

    throw new Error(result.message ?? "Request failed");
  }

  throw new Error("Context rule setup did not complete. Try again.");
}

export type SetupSendRulesBody = {
  smartAccountAddress: string;
  signerType: "passkey" | "phantom" | "freighter";
  assetId?: string;
  assetIds?: string[];
  publicKeyHex?: string;
  keyDataHex?: string;
  gAddress?: string;
};

export async function postSetupSendRules(
  body: SetupSendRulesBody
): Promise<Record<string, unknown> & { alreadyConfigured?: boolean }> {
  const setupRes = await fetch("/api/smart-account/setup-send-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const setup = (await setupRes.json()) as Record<string, unknown> & {
    alreadyConfigured?: boolean;
    error?: string;
    message?: string;
  };
  if (!setupRes.ok) {
    throw new Error(
      (typeof setup.error === "string" && setup.error) ||
        (typeof setup.message === "string" && setup.message) ||
        "Setup build failed"
    );
  }
  return setup;
}

export type SetupContextRuleBody = {
  smartAccountAddress: string;
  signerType: "passkey" | "phantom" | "freighter";
  targetContractId: string;
  name?: string;
  publicKeyHex?: string;
  keyDataHex?: string;
  gAddress?: string;
};

export async function postSetupContextRule(
  body: SetupContextRuleBody
): Promise<Record<string, unknown> & { alreadyConfigured?: boolean }> {
  const setupRes = await fetch("/api/smart-account/setup-context-rule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const setup = (await setupRes.json()) as Record<string, unknown> & {
    alreadyConfigured?: boolean;
    error?: string;
    message?: string;
  };
  if (!setupRes.ok) {
    throw new Error(
      (typeof setup.error === "string" && setup.error) ||
        (typeof setup.message === "string" && setup.message) ||
        "Setup context rule failed"
    );
  }
  return setup;
}
