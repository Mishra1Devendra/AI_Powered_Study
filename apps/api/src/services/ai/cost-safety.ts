import { FREE_PROVIDERS, assertApprovedFreeModel, isFreeProviderId, type FreeProviderId } from "./free/catalog.js";
import { PolicyViolation, assertLocalModel, assertLocalOllamaUrl } from "./ollama-provider.js";

/**
 * ZERO-COST AI POLICY enforcement (see docs/AI_POLICY.md). Pure functions: assessing the
 * configuration never makes a network request and never uses any credential.
 */

export type CostResult = "SAFE" | "BLOCKED" | "NEEDS_APPROVAL";

export interface CostReport {
  provider: string;
  model: string;
  /** Where inference would run. */
  execution: "Local (this device)" | "None (canned demo replies)" | "Unknown / remote" | "Local first; free online services only if it is not running" | "Free online services first; local AI last";
  cloudRequest: boolean;
  paid: boolean;
  billingRequired: boolean;
  apiKeyRequired: boolean;
  potentialAutomaticBilling: boolean;
  estimatedCost: "INR 0 / USD 0" | "UNKNOWN";
  /** Names (never values) of paid-AI credentials found in the environment. They are NEVER used. */
  /** Names (never values) of keys for the APPROVED FREE services that are set (only used when AI_PROVIDER=free). */
  freeKeysPresent: string[];
  /** Approved free online services that are configured, in the order they would be tried (opaque to students). */
  freeServices: string[];
  paidKeysPresent: string[];
  /** Names of paid-AI endpoint variables found in the environment. They are NEVER used. */
  paidEndpointsPresent: string[];
  result: CostResult;
  reasons: string[];
}

/** Credential variables of paid/cloud AI vendors. Detected so they can be reported; never read for use. */
const PAID_KEY_NAME =
  /^(ANTHROPIC|OPENAI|AZURE_OPENAI|COHERE|MISTRAL|XAI|DEEPSEEK|PERPLEXITY|TOGETHER|REPLICATE)_(API_KEY|AUTH_TOKEN|KEY|TOKEN|ACCESS_KEY)$|^GOOGLE_(GENERATIVE_AI_)?API_KEY$|^AWS_BEARER_TOKEN_BEDROCK$/;
/** The keys of the three approved FREE services. They are read only by config/env.ts and only used when AI_PROVIDER=free. */
const FREE_KEY_NAME = /^(GROQ|GEMINI|OPENROUTER)_API_KEY$/;
const PAID_ENDPOINT_NAME =
  /^(ANTHROPIC|OPENAI|GEMINI|AZURE_OPENAI|COHERE|MISTRAL|GROQ|OPENROUTER|XAI|DEEPSEEK|PERPLEXITY|TOGETHER|REPLICATE)_(BASE_URL|ENDPOINT|API_BASE|HOST)$/;

const names = (source: NodeJS.ProcessEnv, re: RegExp) =>
  Object.keys(source)
    .filter((k) => re.test(k) && (source[k] ?? "").trim() !== "")
    .sort();

export function findPaidAiCredentials(source: NodeJS.ProcessEnv = process.env) {
  return { keys: names(source, PAID_KEY_NAME), endpoints: names(source, PAID_ENDPOINT_NAME), freeKeys: names(source, FREE_KEY_NAME) };
}

export interface CostInput {
  AI_PROVIDER: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_MODEL: string;
  FREE_AI_ORDER?: string | undefined;
  FREE_AI_LOCAL_POSITION?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  GROQ_MODEL?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
  GEMINI_MODEL?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  OPENROUTER_MODEL?: string | undefined;
}

export function assessAiCost(input: CostInput, source: NodeJS.ProcessEnv = process.env): CostReport {
  const found = findPaidAiCredentials(source);
  const base = {
    paidKeysPresent: found.keys,
    paidEndpointsPresent: found.endpoints,
    freeKeysPresent: input.AI_PROVIDER === "free" ? found.freeKeys : [],
    freeServices: [] as string[],
    reasons: [] as string[],
  };

  if (input.AI_PROVIDER === "mock") {
    return {
      ...base,
      provider: "Mock (demo)",
      model: "mock-demo",
      execution: "None (canned demo replies)",
      cloudRequest: false,
      paid: false,
      billingRequired: false,
      apiKeyRequired: false,
      potentialAutomaticBilling: false,
      estimatedCost: "INR 0 / USD 0",
      result: "SAFE",
    };
  }

  if (input.AI_PROVIDER === "ollama") {
    try {
      assertLocalOllamaUrl(input.OLLAMA_BASE_URL);
      assertLocalModel(input.OLLAMA_MODEL);
    } catch (err) {
      return {
        ...base,
        provider: "Ollama",
        model: input.OLLAMA_MODEL,
        execution: "Unknown / remote",
        cloudRequest: true,
        paid: false,
        billingRequired: false,
        apiKeyRequired: false,
        potentialAutomaticBilling: true,
        estimatedCost: "UNKNOWN",
        result: "BLOCKED",
        reasons: [err instanceof PolicyViolation ? err.message : "Ollama configuration could not be verified as local."],
      };
    }
    return {
      ...base,
      provider: "Ollama",
      model: input.OLLAMA_MODEL,
      execution: "Local (this device)",
      cloudRequest: false,
      paid: false,
      billingRequired: false,
      apiKeyRequired: false,
      potentialAutomaticBilling: false,
      estimatedCost: "INR 0 / USD 0",
      result: "SAFE",
    };
  }

  if (input.AI_PROVIDER === "free") {
    const reasons: string[] = [];
    try {
      assertLocalOllamaUrl(input.OLLAMA_BASE_URL);
      assertLocalModel(input.OLLAMA_MODEL);
    } catch (err) {
      reasons.push(err instanceof PolicyViolation ? err.message : "Ollama configuration could not be verified as local.");
    }
    const order = (input.FREE_AI_ORDER ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ids: string[] = order.length ? order : ["groq", "openrouter", "gemini"];
    const services: string[] = [];
    for (const id of ids) {
      if (!isFreeProviderId(id)) {
        reasons.push(`"${id.slice(0, 30)}" is not an approved free AI service (approved: ${Object.keys(FREE_PROVIDERS).join(", ")}).`);
        continue;
      }
      const fid: FreeProviderId = id;
      const key = fid === "groq" ? input.GROQ_API_KEY : fid === "gemini" ? input.GEMINI_API_KEY : input.OPENROUTER_API_KEY;
      if (!key) continue;
      const model = (fid === "groq" ? input.GROQ_MODEL : fid === "gemini" ? input.GEMINI_MODEL : input.OPENROUTER_MODEL) || FREE_PROVIDERS[fid].defaultModel;
      try {
        if (!model) throw new PolicyViolation("OPENROUTER_MODEL must be an explicit \":free\" model id.");
        services.push(`${fid} (${assertApprovedFreeModel(fid, model)})`);
      } catch (err) {
        reasons.push(err instanceof PolicyViolation ? err.message : `${fid} model could not be verified as free.`);
      }
    }
    const blocked = reasons.length > 0;
    return {
      ...base,
      freeServices: services,
      provider: "Free chain: local Ollama, then approved free online services",
      model: input.OLLAMA_MODEL,
      execution: services.length === 0 ? "Local (this device)" : input.FREE_AI_LOCAL_POSITION === "last" ? "Free online services first; local AI last" : "Local first; free online services only if it is not running",
      cloudRequest: services.length > 0,
      paid: false,
      billingRequired: false,
      apiKeyRequired: services.length > 0,
      potentialAutomaticBilling: false,
      estimatedCost: blocked ? "UNKNOWN" : "INR 0 / USD 0",
      result: blocked ? "BLOCKED" : "SAFE",
      reasons: blocked
        ? reasons
        : services.length > 0
          ? ["Free tiers only: every service is on the approved-free list, hosts are fixed, no paid fallback exists. A Gemini key must belong to a project WITHOUT billing (cannot be checked from here)."]
          : [],
    };
  }

  // Anything else is a provider this project has no approval for.
  return {
    ...base,
    provider: input.AI_PROVIDER,
    model: "n/a",
    execution: "Unknown / remote",
    cloudRequest: true,
    paid: true,
    billingRequired: true,
    apiKeyRequired: true,
    potentialAutomaticBilling: true,
    estimatedCost: "UNKNOWN",
    result: "NEEDS_APPROVAL",
    reasons: [`Provider "${input.AI_PROVIDER}" is not approved. Paid/cloud AI needs the owner's explicit written authorization.`],
  };
}

const yn = (b: boolean) => (b ? "Yes" : "No");

/** Human-readable report in the format required by the policy (sections 6, 9 and 12). */
export function formatCostReport(r: CostReport): string {
  const lines = [
    "AI Cost Safety Check",
    `  Provider:                     ${r.provider}`,
    `  Model:                        ${r.model}`,
    `  Execution:                    ${r.execution}`,
    `  Local or Cloud:               ${r.cloudRequest ? "Cloud" : "Local"}`,
    `  Cloud request:                ${yn(r.cloudRequest)}`,
    `  Paid or Free:                 ${r.paid ? "PAID / unverified" : "Free"}`,
    `  Billing account required:     ${yn(r.billingRequired)}`,
    `  API key required:             ${yn(r.apiKeyRequired)}`,
    `  Potential automatic billing:  ${yn(r.potentialAutomaticBilling)}`,
    `  Estimated AI API cost:        ${r.estimatedCost}`,
    `  Free online services:         ${r.freeServices.length ? r.freeServices.join(", ") : "none configured"}`,
    `  Free-service keys present:    ${r.freeKeysPresent.length ? `${r.freeKeysPresent.join(", ")} (names only; values never printed)` : "No"}`,
    `  Paid API key present:         ${r.paidKeysPresent.length ? `YES (${r.paidKeysPresent.join(", ")}) - ignored, never used` : "No"}`,
    `  Paid endpoint var present:    ${r.paidEndpointsPresent.length ? `YES (${r.paidEndpointsPresent.join(", ")}) - ignored, never used` : "No"}`,
    `  Result:                       ${r.result}`,
  ];
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  return lines.join("\n");
}
