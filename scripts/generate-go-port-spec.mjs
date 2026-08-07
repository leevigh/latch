#!/usr/bin/env node
/**
 * Generates LATCH_GO_PORT_API_SPEC.json from structured endpoint definitions.
 * Run: node scripts/generate-go-port-spec.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const S = (name) => ({ $ref: `#/components/schemas/${name}` });

const schemas = {
  ApiErrorBody: {
    type: "object",
    required: ["error", "code", "message"],
    properties: {
      error: { type: "string" },
      code: { type: "string" },
      message: { type: "string" },
    },
  },
  LegacyErrorBody: {
    type: "object",
    required: ["error"],
    properties: { error: { type: "string" } },
  },
  SignerType: { type: "string", enum: ["passkey", "phantom", "freighter"] },
  Network: { type: "string", enum: ["testnet", "mainnet"] },
  ContextRuleDiscovery: { type: "string", enum: ["matched", "default", "fallback"] },
  SubmitMethod: { type: "string", enum: ["bundler-delegated", "delegated", "webauthn"] },
  BuildAuthTransactionResult: {
    type: "object",
    required: [
      "txXdr", "authEntryXdr", "authEntriesXdr", "smartAccountAuthEntryIndex",
      "delegatedNativeAuthEntryIndices", "delegatedNativeSignBlobPayloadsBase64",
      "delegatedGAuthEntrySynthesized", "contextRuleId", "contextRuleIds",
      "contextRuleDiscovery", "authDigestHex", "signaturePayloadHex",
      "validUntilLedger", "simulationResultXdr",
    ],
    properties: {
      txXdr: { type: "string" },
      authEntryXdr: { type: "string" },
      authEntriesXdr: { type: "array", items: { type: "string" } },
      smartAccountAuthEntryIndex: { type: "integer" },
      delegatedNativeAuthEntryIndices: { type: "array", items: { type: "integer" } },
      delegatedNativeSignBlobPayloadsBase64: { type: "array", items: { type: "string" } },
      delegatedGAuthEntrySynthesized: { type: "boolean" },
      contextRuleId: { type: "integer" },
      contextRuleIds: { type: "array", items: { type: "integer" } },
      contextRuleDiscovery: S("ContextRuleDiscovery"),
      authDigestHex: { type: "string" },
      signaturePayloadHex: { type: "string" },
      validUntilLedger: { type: "integer" },
      simulationResultXdr: { type: "string" },
      smartAccountAuthEntryXdr: { type: "string" },
      gAddressPreimageXdr: { type: "string" },
      gAddressEntryTemplateXdr: { type: "string" },
      submitMethod: S("SubmitMethod"),
      delegatedAuthG: { type: "string" },
    },
  },
  SubmitResult: {
    type: "object",
    required: ["hash", "status"],
    properties: { hash: { type: "string" }, status: { type: "string" } },
  },
  SignPayloadBody: {
    type: "object",
    required: ["network", "smartAccountAddress", "unsignedTxXdr", "callback"],
    properties: {
      network: S("Network"),
      smartAccountAddress: { type: "string" },
      unsignedTxXdr: { type: "string" },
      callback: { type: "string", format: "uri" },
      requestId: { type: "string" },
      origin: { type: "string" },
      submit: { type: "boolean", default: true },
    },
  },
  OnRampIntentResponse: {
    type: "object",
    properties: {
      id: { type: "string" },
      memoId: { type: "string" },
      destinationCAddress: { type: "string" },
      status: { type: "string", enum: ["created", "pending", "completed", "failed"] },
      moonpayTransactionId: { type: ["string", "null"] },
      fiatAmount: { type: "string" },
      fiatCode: { type: "string" },
      moonpayTransactionStatus: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  SerializedDraft: {
    type: "object",
    properties: {
      id: { type: "string" },
      threshold: { type: "integer" },
      accountSaltHex: { type: "string" },
      inviteToken: { type: "string" },
      status: { type: "string", enum: ["collecting", "deployed"] },
      predictedAddress: { type: ["string", "null"] },
      smartAccountAddress: { type: ["string", "null"] },
      createdAt: { type: "integer" },
      expiresAt: { type: ["integer", "null"] },
      validMemberCount: { type: "integer" },
      canDeploy: { type: "boolean" },
      members: { type: "array", items: { type: "object" } },
    },
  },
  PrepareSignResponse: {
    allOf: [
      S("BuildAuthTransactionResult"),
      {
        type: "object",
        properties: {
          network: S("Network"),
          smartAccountAddress: { type: "string" },
          estimatedFeeXlm: { type: "string" },
          estimatedFeeUsd: { type: "string" },
          feeLabel: { type: "string" },
          operations: { type: "array", items: { type: "object" } },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
    ],
  },
};

const ENV = {
  database: ["DATABASE_URL", "DIRECT_URL"],
  sorobanTestnet: ["NEXT_PUBLIC_RPC_URL", "NEXT_PUBLIC_NETWORK_PASSPHRASE"],
  sorobanMainnet: ["MAINNET_RPC_URL", "MAINNET_NETWORK_PASSPHRASE"],
  contracts: [
    "NEXT_PUBLIC_FACTORY_ADDRESS",
    "NEXT_PUBLIC_VERIFIER_ADDRESS",
    "NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS",
    "NEXT_PUBLIC_COUNTER_ADDRESS",
  ],
  bundler: ["BUNDLER_SECRET"],
  assets: ["NEXT_PUBLIC_NATIVE_SAC_ADDRESS", "NEXT_PUBLIC_USDC_SAC_ADDRESS"],
  webauthn: ["WEBAUTHN_RP_ID", "WEBAUTHN_ORIGIN"],
  cors: ["API_CORS_ALLOWED_ORIGINS", "WEBAUTHN_EXTENSION_IDS"],
  moonpay: [
    "MOONPAY_SECRET_KEY",
    "MOONPAY_POOL_G_ADDRESS",
    "MOONPAY_PUBLISHABLE_KEY",
    "MOONPAY_INTEGRATION_MODE",
  ],
};

const e = (
  method,
  apiPath,
  tag,
  sourceFile,
  opts = {}
) => ({
  method,
  path: apiPath,
  tag,
  sourceFile,
  auth: opts.auth || "none",
  env: opts.env || [],
  dbModels: opts.db || [],
  libImports: opts.lib || [],
  legacyError: opts.legacyError !== false,
  summary: opts.summary || `${method} ${apiPath}`,
  requestBody: opts.body || null,
  queryParams: opts.query || [],
  pathParams: opts.pathParams || [],
  responseSchema: opts.response || { type: "object" },
});

const endpoints = [
  e("GET", "/api/accounts", "accounts", "app/api/accounts/route.ts", {
    auth: "session",
    db: ["SmartAccount"],
    legacyError: true,
    response: {
      type: "object",
      properties: {
        accounts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              smartAccountAddress: { type: "string" },
              credentialId: { type: "string" },
              deployed: { type: "boolean" },
              createdAt: { type: "integer" },
            },
          },
        },
      },
    },
    env: ENV.database,
  }),
  e("POST", "/api/accounts/set-active", "accounts", "app/api/accounts/set-active/route.ts", {
    body: {
      type: "object",
      required: ["smartAccountAddress"],
      properties: { smartAccountAddress: { type: "string" } },
    },
    response: { type: "object", properties: { ok: { type: "boolean", const: true } } },
  }),
  e("GET", "/api/counter", "counter", "app/api/counter/route.ts", {
    env: ENV.sorobanTestnet,
    response: { type: "object", properties: { value: { type: "integer" } } },
  }),
  e("POST", "/api/recovery/backup-passkey", "recovery", "app/api/recovery/backup-passkey/route.ts", {
    auth: "session+ownership",
    db: ["SmartAccount", "AccountSigner"],
    env: ENV.database,
    body: {
      type: "object",
      required: ["smartAccountAddress"],
      properties: {
        smartAccountAddress: { type: "string" },
        label: { type: "string" },
      },
    },
    response: {
      type: "object",
      properties: { ok: { type: "boolean" }, next: { type: "string" } },
    },
  }),
  e("POST", "/api/sign-payload", "sign-payload", "app/api/sign-payload/route.ts", {
    legacyError: false,
    db: ["SignPayload"],
    env: ENV.database,
    body: {
      type: "object",
      required: ["network", "smartAccountAddress", "unsignedTxXdr", "callback"],
      properties: {
        network: S("Network"),
        smartAccountAddress: { type: "string" },
        unsignedTxXdr: { type: "string" },
        callback: { type: "string" },
        requestId: { type: "string" },
        origin: { type: "string" },
        submit: { type: "boolean" },
        ttlSeconds: { type: "integer", minimum: 60, maximum: 3600 },
      },
    },
    response: {
      type: "object",
      properties: {
        payloadRef: { type: "string", pattern: "^sp_" },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
  }),
  e("GET", "/api/sign-payload/{payloadRef}", "sign-payload", "app/api/sign-payload/[payloadRef]/route.ts", {
    legacyError: false,
    pathParams: ["payloadRef"],
    db: ["SignPayload"],
    env: ENV.database,
    response: S("SignPayloadBody"),
  }),
  e("GET", "/api/webauthn/credentials", "webauthn", "app/api/webauthn/credentials/route.ts", {
    auth: "session",
    db: ["WebauthnCredential"],
    env: [...ENV.database, ...ENV.webauthn],
    response: {
      type: "object",
      properties: {
        credentials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              credentialId: { type: "string" },
              createdAt: { type: "integer" },
            },
          },
        },
      },
    },
  }),
  e("POST", "/api/webauthn/registration/begin", "webauthn", "app/api/webauthn/registration/begin/route.ts", {
    auth: "session",
    db: ["WebauthnChallenge"],
    env: [...ENV.database, ...ENV.webauthn, ...ENV.cors],
    body: {
      type: "object",
      properties: {
        displayName: { type: "string" },
        chromeExtensionId: { type: "string" },
      },
    },
    response: { type: "object", properties: { options: { type: "object" } } },
  }),
  e("POST", "/api/webauthn/registration/finish", "webauthn", "app/api/webauthn/registration/finish/route.ts", {
    auth: "session",
    db: ["WebauthnChallenge", "WebauthnCredential", "SmartAccount"],
    env: [...ENV.database, ...ENV.webauthn, ...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["response"],
      properties: {
        response: { type: "object" },
        chromeExtensionId: { type: "string" },
      },
    },
    response: {
      type: "object",
      properties: {
        credentialId: { type: "string" },
        keyDataHex: { type: "string" },
        saltHex: { type: "string" },
        smartAccountAddress: { type: "string" },
        deployed: { type: "boolean" },
        alreadyDeployed: { type: "boolean" },
        determinismCheck: { type: "object", properties: { keyDataHash: { type: "string" } } },
      },
    },
  }),
  e("POST", "/api/webauthn/authentication/begin", "webauthn", "app/api/webauthn/authentication/begin/route.ts", {
    auth: "session",
    db: ["WebauthnChallenge", "WebauthnCredential"],
    env: [...ENV.database, ...ENV.webauthn, ...ENV.cors],
    body: { type: "object", properties: { chromeExtensionId: { type: "string" } } },
    response: { type: "object", properties: { options: { type: "object" } } },
  }),
  e("POST", "/api/webauthn/authentication/finish", "webauthn", "app/api/webauthn/authentication/finish/route.ts", {
    auth: "session",
    db: ["WebauthnChallenge", "WebauthnCredential", "SmartAccount"],
    env: [...ENV.database, ...ENV.webauthn],
    body: {
      type: "object",
      required: ["response"],
      properties: {
        response: { type: "object" },
        chromeExtensionId: { type: "string" },
      },
    },
    response: {
      type: "object",
      properties: {
        smartAccountAddress: { type: "string" },
        keyDataHex: { type: "string" },
        deployed: { type: "boolean" },
        activeCredentialId: { type: "string" },
        accounts: { type: "array", items: { type: "object" } },
      },
    },
  }),
  e("GET", "/api/smart-account", "smart-account", "app/api/smart-account/route.ts", {
    env: [...ENV.contracts, ...ENV.sorobanTestnet],
    response: {
      type: "object",
      properties: {
        verifierAddress: { type: "string" },
        counterAddress: { type: "string" },
        network: { type: "string", const: "testnet" },
      },
    },
  }),
  e("POST", "/api/smart-account", "smart-account", "app/api/smart-account/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["publicKeyHex"],
      properties: { publicKeyHex: { type: "string", pattern: "^[0-9a-fA-F]{64}$" } },
    },
    response: {
      type: "object",
      properties: {
        smartAccountAddress: { type: "string" },
        gAddress: { type: "string" },
        verifierAddress: { type: "string" },
        counterAddress: { type: "string" },
        alreadyDeployed: { type: "boolean" },
      },
    },
  }),
  e("GET", "/api/smart-account/balances", "smart-account", "app/api/smart-account/balances/route.ts", {
    query: [
      { name: "smartAccountAddress", required: true },
      { name: "all", required: false, description: "Set to 1 to include zero balances" },
    ],
    env: [...ENV.sorobanTestnet, ...ENV.assets],
    response: {
      type: "object",
      properties: {
        smartAccountAddress: { type: "string" },
        balances: { type: "array", items: { type: "object" } },
      },
    },
  }),
  e("GET", "/api/smart-account/context-rules", "smart-account", "app/api/smart-account/context-rules/route.ts", {
    query: [
      { name: "address", required: true },
      { name: "network", required: false, description: "testnet|mainnet, default testnet" },
    ],
    env: [...ENV.sorobanTestnet, ...ENV.sorobanMainnet],
    response: {
      type: "object",
      properties: {
        smartAccountAddress: { type: "string" },
        network: { type: "string" },
        ruleCount: { type: "integer" },
        rules: { type: "array", items: { type: "object" } },
      },
    },
  }),
  e("GET", "/api/smart-account/factory", "smart-account", "app/api/smart-account/factory/route.ts", {
    query: [{ name: "pubkey", required: true, description: "64-char hex Ed25519 public key" }],
    env: [...ENV.contracts, ...ENV.sorobanTestnet],
    response: {
      type: "object",
      properties: {
        deployed: { type: "boolean" },
        smartAccountAddress: { type: "string" },
      },
    },
  }),
  e("POST", "/api/smart-account/factory", "smart-account", "app/api/smart-account/factory/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["publicKeyHex"],
      properties: { publicKeyHex: { type: "string", pattern: "^[0-9a-fA-F]{64}$" } },
    },
    response: {
      type: "object",
      properties: {
        smartAccountAddress: { type: "string" },
        gAddress: { type: "string" },
        factoryAddress: { type: "string" },
        alreadyDeployed: { type: "boolean" },
      },
    },
  }),
  e("GET", "/api/smart-account/freighter", "smart-account", "app/api/smart-account/freighter/route.ts", {
    query: [{ name: "gAddress", required: true }],
    env: [...ENV.contracts, ...ENV.sorobanTestnet],
    response: {
      type: "object",
      properties: { deployed: { type: "boolean" }, smartAccountAddress: { type: "string" } },
    },
  }),
  e("POST", "/api/smart-account/freighter", "smart-account", "app/api/smart-account/freighter/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["gAddress"],
      properties: { gAddress: { type: "string" } },
    },
    response: {
      type: "object",
      properties: { smartAccountAddress: { type: "string" }, alreadyDeployed: { type: "boolean" } },
    },
  }),
  e("GET", "/api/smart-account/webauthn", "smart-account", "app/api/smart-account/webauthn/route.ts", {
    query: [
      { name: "credentialId", required: true },
      { name: "keyDataHex", required: true },
    ],
    env: [...ENV.contracts, ...ENV.sorobanTestnet],
    response: {
      type: "object",
      properties: { deployed: { type: "boolean" }, smartAccountAddress: { type: "string" } },
    },
  }),
  e("POST", "/api/smart-account/webauthn", "smart-account", "app/api/smart-account/webauthn/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["keyDataHex", "credentialId"],
      properties: { keyDataHex: { type: "string" }, credentialId: { type: "string" } },
    },
    response: {
      type: "object",
      properties: { smartAccountAddress: { type: "string" }, alreadyDeployed: { type: "boolean" } },
    },
  }),
  e("POST", "/api/smart-account/setup-send-rules", "smart-account", "app/api/smart-account/setup-send-rules/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet, ...ENV.assets],
    body: {
      type: "object",
      required: ["smartAccountAddress", "signerType"],
      properties: {
        smartAccountAddress: { type: "string" },
        signerType: S("SignerType"),
        assetId: { type: "string" },
        assetIds: { type: "array", items: { type: "string" } },
        publicKeyHex: { type: "string" },
        keyDataHex: { type: "string" },
        gAddress: { type: "string" },
      },
    },
    response: {
      allOf: [
        S("BuildAuthTransactionResult"),
        {
          type: "object",
          properties: {
            alreadyConfigured: { type: "boolean" },
            configuredAsset: { type: "object" },
            remainingSetupCount: { type: "integer" },
            instructions: { type: "string" },
          },
        },
      ],
    },
  }),
  e("POST", "/api/smart-account/setup-swap-rules", "smart-account", "app/api/smart-account/setup-swap-rules/route.ts", {
    legacyError: false,
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet, ...ENV.sorobanMainnet],
    body: {
      type: "object",
      required: ["network", "smartAccountAddress"],
      properties: {
        network: S("Network"),
        smartAccountAddress: { type: "string" },
        signerType: S("SignerType"),
        providerId: { type: "string" },
        routerContractId: { type: "string" },
        publicKeyHex: { type: "string" },
        gAddress: { type: "string" },
        keyDataHex: { type: "string" },
        credentialId: { type: "string" },
        credential_id: { type: "string", description: "alias for credentialId" },
      },
    },
    response: {
      allOf: [
        S("BuildAuthTransactionResult"),
        {
          type: "object",
          properties: {
            routerContractId: { type: "string" },
            providerId: { type: "string" },
            contextRuleId: { type: "integer" },
            remainingSetupCount: { type: "integer" },
            instructions: { type: "string" },
          },
        },
      ],
    },
  }),
  e("POST", "/api/transaction/build", "transaction", "app/api/transaction/build/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["smartAccountAddress"],
      properties: {
        smartAccountAddress: { type: "string" },
        signerG: { type: "string" },
      },
    },
    response: S("BuildAuthTransactionResult"),
  }),
  e("POST", "/api/transaction/build-send", "transaction", "app/api/transaction/build-send/route.ts", {
    env: [...ENV.bundler, ...ENV.sorobanTestnet, ...ENV.assets],
    body: {
      type: "object",
      required: ["smartAccountAddress", "signerType", "recipient", "amount"],
      properties: {
        smartAccountAddress: { type: "string" },
        signerType: S("SignerType"),
        assetId: { type: "string" },
        contractId: { type: "string" },
        recipient: { type: "string" },
        amount: { type: "string" },
        signerG: { type: "string" },
      },
    },
    response: {
      allOf: [
        S("BuildAuthTransactionResult"),
        {
          type: "object",
          properties: {
            asset: { type: "object" },
            recipient: { type: "string" },
            amount: { type: "string" },
            amountRaw: { type: "string" },
          },
        },
      ],
    },
  }),
  e("POST", "/api/transaction/build-swap", "transaction", "app/api/transaction/build-swap/route.ts", {
    legacyError: false,
    env: [...ENV.bundler, ...ENV.sorobanTestnet, ...ENV.sorobanMainnet],
    body: {
      type: "object",
      required: [
        "network", "smartAccountAddress", "signerType", "swapChainXdr",
        "tokenInContractId", "amountInRaw", "amountOutMinRaw",
      ],
      properties: {
        network: S("Network"),
        smartAccountAddress: { type: "string" },
        signerType: S("SignerType"),
        signerG: { type: "string" },
        routerContractId: { type: "string" },
        swapChainXdr: { type: "string" },
        tokenInContractId: { type: "string" },
        amountInRaw: { type: "string" },
        amountOutMinRaw: { type: "string" },
        providerId: { type: "string" },
      },
    },
    response: {
      allOf: [
        S("BuildAuthTransactionResult"),
        {
          type: "object",
          properties: {
            routerContractId: { type: "string" },
            tokenInContractId: { type: "string" },
            amountInRaw: { type: "string" },
            amountOutMinRaw: { type: "string" },
            providerId: { type: "string" },
            submitMethod: S("SubmitMethod"),
            delegatedAuthG: { type: "string" },
          },
        },
      ],
    },
  }),
  e("POST", "/api/transaction/build-delegated", "transaction", "app/api/transaction/build-delegated/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["smartAccountAddress", "gAddress"],
      properties: {
        smartAccountAddress: { type: "string" },
        gAddress: { type: "string" },
      },
    },
    response: {
      type: "object",
      properties: {
        txXdr: { type: "string" },
        smartAccountAuthEntryXdr: { type: "string" },
        gAddressPreimageXdr: { type: "string" },
        gAddressEntryTemplateXdr: { type: "string" },
        authDigestHex: { type: "string" },
        validUntilLedger: { type: "integer" },
        contextRuleId: { type: "integer" },
      },
    },
  }),
  e("POST", "/api/transaction/build-sign-demo", "transaction", "app/api/transaction/build-sign-demo/route.ts", {
    auth: "dev_only",
    legacyError: false,
    env: [...ENV.bundler, ...ENV.sorobanTestnet, ...ENV.sorobanMainnet, ...ENV.assets],
    body: {
      type: "object",
      required: ["network", "smartAccountAddress", "demoAction"],
      properties: {
        network: S("Network"),
        smartAccountAddress: { type: "string" },
        demoAction: { type: "string", enum: ["noop", "transfer"] },
        recipient: { type: "string" },
        amount: { type: "string" },
        assetId: { type: "string" },
        contractId: { type: "string" },
      },
    },
    response: {
      type: "object",
      properties: {
        unsignedTxXdr: { type: "string" },
        description: { type: "string" },
        network: { type: "string" },
        smartAccountAddress: { type: "string" },
      },
    },
  }),
  e("POST", "/api/transaction/prepare-sign", "transaction", "app/api/transaction/prepare-sign/route.ts", {
    legacyError: false,
    env: [...ENV.bundler, ...ENV.sorobanTestnet, ...ENV.sorobanMainnet],
    body: {
      type: "object",
      required: ["network", "smartAccountAddress", "unsignedTxXdr"],
      properties: {
        network: S("Network"),
        smartAccountAddress: { type: "string" },
        unsignedTxXdr: { type: "string" },
        signerType: S("SignerType"),
        signerG: { type: "string" },
        feePayerG: { type: "string" },
        contextRuleId: { type: "integer" },
        contextRuleDiscovery: S("ContextRuleDiscovery"),
      },
    },
    response: S("PrepareSignResponse"),
  }),
  e("POST", "/api/transaction/submit", "transaction", "app/api/transaction/submit/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["txXdr", "authEntryXdr", "authSignatureHex", "prefixedMessage", "publicKeyHex", "contextRuleId"],
      properties: {
        txXdr: { type: "string" },
        authEntryXdr: { type: "string" },
        authSignatureHex: { type: "string" },
        prefixedMessage: { type: "string" },
        publicKeyHex: { type: "string" },
        contextRuleId: { type: "integer" },
      },
    },
    response: S("SubmitResult"),
  }),
  e("POST", "/api/transaction/submit-webauthn", "transaction", "app/api/transaction/submit-webauthn/route.ts", {
    env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["txXdr", "authEntryXdr", "sigDataXdr", "keyDataHex", "contextRuleId"],
      properties: {
        txXdr: { type: "string" },
        authEntryXdr: { type: "string" },
        sigDataXdr: { type: "string" },
        keyDataHex: { type: "string" },
        contextRuleId: { type: "integer" },
        authEntriesXdr: { type: "array", items: { type: "string" } },
        smartAccountAuthEntryIndex: { type: "integer" },
        delegatedGAuthEntrySynthesized: { type: "boolean" },
      },
    },
    response: S("SubmitResult"),
  }),
  e("POST", "/api/transaction/submit-delegated", "transaction", "app/api/transaction/submit-delegated/route.ts", {
    legacyError: false,
    env: [...ENV.bundler, ...ENV.sorobanTestnet],
    body: {
      type: "object",
      required: ["txXdr", "smartAccountAuthEntryXdr"],
      properties: {
        txXdr: { type: "string" },
        smartAccountAuthEntryXdr: { type: "string" },
        gAddressEntryTemplateXdr: { type: "string" },
        signedAuthEntryBase64: { type: "string" },
        signerAddress: { type: "string" },
        authEntriesXdr: { type: "array", items: { type: "string" } },
        smartAccountAuthEntryIndex: { type: "integer" },
        delegatedGAuthEntrySynthesized: { type: "boolean" },
        contextRuleId: { type: "integer" },
      },
    },
    response: S("SubmitResult"),
  }),
  e("POST", "/api/on-ramp/session", "on-ramp", "app/api/on-ramp/session/route.ts", {
    auth: "dev_only+session",
    legacyError: false,
    db: ["OnRampIntent"],
    env: [...ENV.database, ...ENV.moonpay],
    body: {
      type: "object",
      required: ["destinationCAddress"],
      properties: {
        destinationCAddress: { type: "string" },
        fiatAmount: { type: "string" },
        fiatCode: { type: "string" },
      },
    },
    response: { type: "object" },
  }),
  e("GET", "/api/on-ramp/pool", "on-ramp", "app/api/on-ramp/pool/route.ts", {
    auth: "dev_only",
    legacyError: false,
    env: [...ENV.moonpay, ...ENV.sorobanTestnet],
    query: [{ name: "memo", required: false }],
    response: { type: "object" },
  }),
  e("GET", "/api/on-ramp/intent/{id}", "on-ramp", "app/api/on-ramp/intent/[id]/route.ts", {
    auth: "dev_only",
    legacyError: false,
    pathParams: ["id"],
    db: ["OnRampIntent"],
    env: [...ENV.database, ...ENV.moonpay],
    response: S("OnRampIntentResponse"),
  }),
  e("PATCH", "/api/on-ramp/intent/{id}", "on-ramp", "app/api/on-ramp/intent/[id]/route.ts", {
    auth: "dev_only",
    legacyError: false,
    pathParams: ["id"],
    db: ["OnRampIntent"],
    env: [...ENV.database, ...ENV.moonpay],
    body: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["created", "pending", "completed", "failed"] },
        moonpayTransactionId: { type: "string" },
      },
    },
    response: S("OnRampIntentResponse"),
  }),
];

// Multisig endpoints (condensed batch)
const multisigRoutes = [
  ["GET", "/api/multisig/accounts", "app/api/multisig/accounts/route.ts", { auth: "session", db: ["MultisigAccount", "MultisigMember"] }],
  ["POST", "/api/multisig/accounts/register", "app/api/multisig/accounts/register/route.ts", { auth: "session", db: ["MultisigAccount", "MultisigMember"] }],
  ["POST", "/api/multisig/accounts/draft", "app/api/multisig/accounts/draft/route.ts", { env: ENV.sorobanTestnet }],
  ["POST", "/api/multisig/accounts/deploy", "app/api/multisig/accounts/deploy/route.ts", { env: [...ENV.bundler, ...ENV.contracts, ...ENV.sorobanTestnet] }],
  ["POST", "/api/multisig/drafts", "app/api/multisig/drafts/route.ts", { auth: "session", db: ["MultisigDraft"] }],
  ["GET", "/api/multisig/drafts", "app/api/multisig/drafts/route.ts", { auth: "session", query: [{ name: "active", required: true }], db: ["MultisigDraft"] }],
  ["GET", "/api/multisig/drafts/{id}", "app/api/multisig/drafts/[id]/route.ts", { auth: "session+creator", pathParams: ["id"], db: ["MultisigDraft"] }],
  ["PATCH", "/api/multisig/drafts/{id}", "app/api/multisig/drafts/[id]/route.ts", { auth: "session+creator", pathParams: ["id"], db: ["MultisigDraft"] }],
  ["POST", "/api/multisig/drafts/{id}/members", "app/api/multisig/drafts/[id]/members/route.ts", { auth: "session+creator", pathParams: ["id"], db: ["MultisigDraftMember"] }],
  ["DELETE", "/api/multisig/drafts/{id}/members/{memberId}", "app/api/multisig/drafts/[id]/members/[memberId]/route.ts", { auth: "session+creator", pathParams: ["id", "memberId"], db: ["MultisigDraftMember"] }],
  ["POST", "/api/multisig/drafts/{id}/predict", "app/api/multisig/drafts/[id]/predict/route.ts", { auth: "session+creator", pathParams: ["id"], db: ["MultisigDraft"] }],
  ["POST", "/api/multisig/drafts/{id}/deploy", "app/api/multisig/drafts/[id]/deploy/route.ts", { auth: "session+creator", pathParams: ["id"], env: [...ENV.bundler, ...ENV.contracts], db: ["MultisigAccount", "MultisigMember", "MultisigDraft"] }],
  ["POST", "/api/multisig/drafts/{id}/webauthn/register/begin", "app/api/multisig/drafts/[id]/webauthn/register/begin/route.ts", { auth: "session+creator", pathParams: ["id"], env: ENV.webauthn }],
  ["POST", "/api/multisig/drafts/{id}/webauthn/register/finish", "app/api/multisig/drafts/[id]/webauthn/register/finish/route.ts", { auth: "session+creator", pathParams: ["id"], env: ENV.webauthn }],
  ["POST", "/api/multisig/drafts/{id}/webauthn/authenticate/begin", "app/api/multisig/drafts/[id]/webauthn/authenticate/begin/route.ts", { auth: "session+creator", pathParams: ["id"], env: ENV.webauthn }],
  ["POST", "/api/multisig/drafts/{id}/webauthn/authenticate/finish", "app/api/multisig/drafts/[id]/webauthn/authenticate/finish/route.ts", { auth: "session+creator", pathParams: ["id"], env: ENV.webauthn }],
  ["GET", "/api/multisig/join/{token}", "app/api/multisig/join/[token]/route.ts", { auth: "invite_token", pathParams: ["token"], db: ["MultisigDraft"] }],
  ["POST", "/api/multisig/join/{token}/members", "app/api/multisig/join/[token]/members/route.ts", { auth: "invite_token", pathParams: ["token"], db: ["MultisigDraftMember"] }],
  ["POST", "/api/multisig/join/{token}/webauthn/register/begin", "app/api/multisig/join/[token]/webauthn/register/begin/route.ts", { auth: "invite_token", pathParams: ["token"], env: ENV.webauthn }],
  ["POST", "/api/multisig/join/{token}/webauthn/register/finish", "app/api/multisig/join/[token]/webauthn/register/finish/route.ts", { auth: "invite_token", pathParams: ["token"], env: ENV.webauthn }],
  ["POST", "/api/multisig/join/{token}/webauthn/authenticate/begin", "app/api/multisig/join/[token]/webauthn/authenticate/begin/route.ts", { auth: "invite_token", pathParams: ["token"], env: ENV.webauthn }],
  ["POST", "/api/multisig/join/{token}/webauthn/authenticate/finish", "app/api/multisig/join/[token]/webauthn/authenticate/finish/route.ts", { auth: "invite_token", pathParams: ["token"], env: ENV.webauthn }],
  ["GET", "/api/multisig/proposals", "app/api/multisig/proposals/route.ts", { auth: "session+ownership", query: [{ name: "account", required: true }], db: ["MultisigAccount", "MultisigProposal"] }],
  ["POST", "/api/multisig/proposals", "app/api/multisig/proposals/route.ts", { auth: "session+ownership", env: [...ENV.bundler, ...ENV.sorobanTestnet, ...ENV.assets], db: ["MultisigAccount", "MultisigProposal"] }],
  ["GET", "/api/multisig/proposals/{id}", "app/api/multisig/proposals/[id]/route.ts", { auth: "session+ownership", pathParams: ["id"], db: ["MultisigProposal", "MultisigApproval", "MultisigMember"] }],
  ["POST", "/api/multisig/proposals/{id}/refresh", "app/api/multisig/proposals/[id]/refresh/route.ts", { auth: "session+ownership", pathParams: ["id"], env: ENV.bundler, db: ["MultisigProposal", "MultisigApproval"] }],
  ["POST", "/api/multisig/proposals/{id}/execute", "app/api/multisig/proposals/[id]/execute/route.ts", { auth: "session+ownership", pathParams: ["id"], env: [...ENV.bundler, ...ENV.contracts], db: ["MultisigProposal", "MultisigApproval"] }],
  ["POST", "/api/multisig/proposals/{id}/approve/webauthn", "app/api/multisig/proposals/[id]/approve/webauthn/route.ts", { auth: "session+ownership", pathParams: ["id"], db: ["MultisigApproval"] }],
  ["POST", "/api/multisig/proposals/{id}/approve/delegated/begin", "app/api/multisig/proposals/[id]/approve/delegated/begin/route.ts", { auth: "session+ownership", pathParams: ["id"], env: ENV.bundler, db: ["MultisigApproval"] }],
  ["POST", "/api/multisig/proposals/{id}/approve/delegated/finish", "app/api/multisig/proposals/[id]/approve/delegated/finish/route.ts", { auth: "session+ownership", pathParams: ["id"], db: ["MultisigApproval"] }],
];

for (const [method, apiPath, sourceFile, opts] of multisigRoutes) {
  endpoints.push(
    e(method, apiPath, "multisig", sourceFile, {
      auth: opts.auth || "none",
      env: [...ENV.database, ...(opts.env || [])],
      db: opts.db || [],
      pathParams: opts.pathParams || [],
      query: opts.query || [],
      response: opts.pathParams?.includes("id") && method === "GET" && apiPath.includes("proposals")
        ? { type: "object" }
        : opts.pathParams?.includes("id") && apiPath.includes("drafts") && method === "GET"
          ? { type: "object", properties: { draft: S("SerializedDraft"), inviteUrl: { type: "string" } } }
          : { type: "object" },
    })
  );
}

const paths = {};
for (const ep of endpoints) {
  if (!paths[ep.path]) paths[ep.path] = {};
  const method = ep.method.toLowerCase();
  const op = {
    summary: ep.summary,
    operationId: ep.path.replace(/[{}]/g, "").replace(/\//g, "_").replace(/^api_/, "") + "_" + method,
    tags: [ep.tag],
    "x-latch-source-file": ep.sourceFile,
    "x-latch-auth": ep.auth,
    "x-latch-env-required": [...new Set(ep.env)],
    "x-latch-db-models": ep.dbModels,
    "x-latch-legacy-error": ep.legacyError,
    responses: {
      "200": { description: "Success", content: { "application/json": { schema: ep.responseSchema } } },
      "201": { description: "Created", content: { "application/json": { schema: ep.responseSchema } } },
      "400": {
        description: "Bad request",
        content: {
          "application/json": {
            schema: ep.legacyError ? S("LegacyErrorBody") : S("ApiErrorBody"),
          },
        },
      },
      "403": {
        description: "Forbidden",
        content: {
          "application/json": {
            schema: ep.legacyError ? S("LegacyErrorBody") : S("ApiErrorBody"),
          },
        },
      },
      "404": {
        description: "Not found",
        content: {
          "application/json": {
            schema: ep.legacyError ? S("LegacyErrorBody") : S("ApiErrorBody"),
          },
        },
      },
      "409": {
        description: "Conflict",
        content: {
          "application/json": {
            schema: ep.legacyError ? S("LegacyErrorBody") : S("ApiErrorBody"),
          },
        },
      },
      "500": {
        description: "Server error",
        content: {
          "application/json": {
            schema: ep.legacyError ? S("LegacyErrorBody") : S("ApiErrorBody"),
          },
        },
      },
    },
  };
  if (typeof ep.auth === "string" && ep.auth.includes("session")) {
    op.security = [{ sessionCookie: [] }];
  }
  if (ep.requestBody) {
    op.requestBody = { required: true, content: { "application/json": { schema: ep.requestBody } } };
  }
  if (ep.queryParams?.length) {
    op.parameters = ep.queryParams.map((q) => ({
      name: q.name,
      in: "query",
      required: q.required || false,
      schema: { type: "string" },
      description: q.description || "",
    }));
  }
  if (ep.pathParams?.length) {
    op.parameters = (op.parameters || []).concat(
      ep.pathParams.map((p) => ({
        name: p,
        in: "path",
        required: true,
        schema: { type: "string" },
      }))
    );
  }
  paths[ep.path][method] = op;
}

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Latch API",
    version: "1.0.0",
    description:
      "Machine-readable spec for porting Latch Next.js /api/* routes to Go. Extension-verified. See LATCH_GO_PORT_GUIDE.md.",
  },
  servers: [
    { url: "http://localhost:8080", description: "Go dev server" },
    { url: "http://localhost:3000", description: "Next.js reference server" },
  ],
  tags: [
    { name: "accounts", description: "User smart account listing" },
    { name: "counter", description: "Demo counter contract" },
    { name: "recovery", description: "Passkey recovery hooks" },
    { name: "sign-payload", description: "External sign callback refs" },
    { name: "webauthn", description: "Passkey ceremony" },
    { name: "smart-account", description: "Deploy, balances, context rules" },
    { name: "transaction", description: "Build, prepare, submit pipeline" },
    { name: "on-ramp", description: "MoonPay dev on-ramp" },
    { name: "multisig", description: "Shared wallet drafts and proposals" },
  ],
  paths,
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "sid",
        description: "30-day sliding session. Auto-created on first request.",
      },
    },
    schemas,
  },
  "x-latch-route-count": {
    files: 58,
    handlers: endpoints.length,
    note: "8 route files export GET+POST (smart-account, factory, freighter, webauthn, multisig/drafts, multisig/drafts/[id], multisig/proposals, on-ramp/intent/[id])",
  },
  "x-latch-env": {
    required: [
      "DATABASE_URL",
      "DIRECT_URL",
      "BUNDLER_SECRET",
      "NEXT_PUBLIC_RPC_URL",
      "NEXT_PUBLIC_NETWORK_PASSPHRASE",
      "NEXT_PUBLIC_FACTORY_ADDRESS",
      "NEXT_PUBLIC_VERIFIER_ADDRESS",
      "NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS",
      "WEBAUTHN_RP_ID",
      "WEBAUTHN_ORIGIN",
    ],
    optional: [
      "MAINNET_RPC_URL",
      "MAINNET_NETWORK_PASSPHRASE",
      "NEXT_PUBLIC_COUNTER_ADDRESS",
      "NEXT_PUBLIC_NATIVE_SAC_ADDRESS",
      "NEXT_PUBLIC_USDC_SAC_ADDRESS",
      "NEXT_PUBLIC_ASSET_ALLOWLIST_JSON",
      "NEXT_PUBLIC_SMART_ACCOUNT_WASM_HASH",
      "LEGACY_DELEGATED_SIGNER_SECRET",
      "API_CORS_ALLOWED_ORIGINS",
      "WEBAUTHN_EXTENSION_IDS",
      "ALLOWED_DEV_ORIGINS",
      "WEBAUTHN_DEV_TRUST_REQUEST_HOST",
      "DEBUG_SOROBAN_AUTH",
      "NODE_ENV",
    ],
    devOnly: [
      "MOONPAY_SECRET_KEY",
      "MOONPAY_PUBLISHABLE_KEY",
      "MOONPAY_INTEGRATION_MODE",
      "MOONPAY_API_BASE",
      "MOONPAY_POOL_G_ADDRESS",
      "MOONPAY_DEFAULT_FIAT_AMOUNT",
      "MOONPAY_DEFAULT_FIAT_CODE",
    ],
    categories: ENV,
    startupValidation: {
      failFastInProduction: true,
      validateBundlerPublicKeyMatchesExtension: true,
      databaseUrlMustIncludePgbouncer: true,
      directUrlMustNotIncludePgbouncer: true,
    },
  },
  "x-latch-lib-mapping": {
    "lib/soroban-transaction-build.ts": "internal/soroban/build",
    "lib/soroban-transaction-submit.ts": "internal/soroban/submit",
    "lib/soroban-context-rules.ts": "internal/soroban/contextrules",
    "lib/soroban-setup-signers.ts": "internal/soroban/setupsigners",
    "lib/bundler-config.ts": "internal/bundler/config",
    "lib/bundler-delegated-auth.ts": "internal/bundler/delegatedauth",
    "lib/webauthn-server.ts": "internal/webauthn/server",
    "lib/session.ts": "internal/session",
    "lib/multisig-draft.ts": "internal/multisig/draft",
    "lib/on-ramp/config.ts": "internal/onramp/config",
    "lib/sign-payload/store.ts": "internal/signpayload/store",
    "lib/transaction/prepareExternalSign.ts": "internal/transaction/preparesign",
    "lib/swap-routers.ts": "internal/swap/routers",
  },
  "x-latch-database": {
    provider: "postgresql",
    host: "Neon",
    migrations: [
      "prisma/migrations/20260428100157_init_neon/migration.sql",
      "prisma/migrations/20260602101834_multisig_service/migration.sql",
      "prisma/migrations/20260603120000_multisig_draft/migration.sql",
      "prisma/migrations/20260618120000_sign_payloads/migration.sql",
      "prisma/migrations/20260625120000_on_ramp_intents/migration.sql",
    ],
    models: [
      "User", "Session", "WebauthnCredential", "SmartAccount", "WebauthnChallenge",
      "AccountSigner", "MultisigDraft", "MultisigDraftMember", "MultisigAccount",
      "MultisigMember", "MultisigProposal", "MultisigApproval", "SignPayload", "OnRampIntent",
    ],
    conventions: {
      bigintMs: "users, sessions, credentials, smart_accounts, challenges, account_signers, all multisig tables",
      timestamp: "sign_payloads, on_ramp_intents",
      booleanAsInt: ["deployed", "backed_up"],
      idGeneration: {
        uuid: ["User", "Session", "OnRampIntent", "MultisigDraft.id (app-generated)"],
        cuid: ["AccountSigner", "MultisigAccount", "MultisigMember", "MultisigProposal", "MultisigApproval", "MultisigDraftMember"],
        signPayload: "sp_ + 32 hex chars",
      },
    },
  },
  "x-latch-legacy-error-routes": [
    "Most /api/smart-account/*, /api/transaction/build*, /api/transaction/submit*",
    "Most /api/webauthn/*, /api/multisig/*",
    "Go should standardize on ApiErrorBody { error, code, message } everywhere",
  ],
  "x-latch-testing": {
    layers: ["contract", "domain-unit", "db-integration"],
    mandatoryCases: [
      "passkey send build-send + submit-webauthn multi auth entry",
      "passkey swap build-swap + submit-webauthn",
      "freighter submit-delegated",
      "webauthn registration + authentication round-trip",
      "multisig draft deploy proposal approve execute",
      "startup validation without BUNDLER_SECRET",
      "on-ramp 403 in production",
    ],
  },
};

const outPath = path.join(root, "LATCH_GO_PORT_API_SPEC.json");
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`Paths: ${Object.keys(paths).length}, Handlers: ${endpoints.length}`);
