import { assertApprovedFreeModel } from "./free/catalog.js";
import { PolicyViolation } from "./errors.js";

export type CostResult = "SAFE" | "BLOCKED" | "NEEDS_APPROVAL";

export interface CostReport {
  provider: string;
  model: string;
  execution: "Online (Google Gemini API)" | "Unknown / remote";
  cloudRequest: boolean;
  paid: boolean;
  billingRequired: boolean;
  apiKeyRequired: boolean;
  potentialAutomaticBilling: boolean;
  estimatedCost: "UNKNOWN";
  freeKeysPresent: string[];
  freeServices: string[];
  paidKeysPresent: string[];
  paidEndpointsPresent: string[];
  billingDisabledAttested: boolean;
  result: CostResult;
  reasons: string[];
}

const PAID_KEY_NAME =
  /^(ANTHROPIC|OPENAI|AZURE_OPENAI|COHERE|MISTRAL|XAI|DEEPSEEK|PERPLEXITY|TOGETHER|REPLICATE)_(API_KEY|AUTH_TOKEN|KEY|TOKEN|ACCESS_KEY)$|^GOOGLE_(GENERATIVE_AI_)?API_KEY$|^AWS_BEARER_TOKEN_BEDROCK$/;
const FREE_KEY_NAME = /^GEMINI_API_KEY$/;
const PAID_ENDPOINT_NAME =
  /^(ANTHROPIC|OPENAI|GEMINI|AZURE_OPENAI|COHERE|MISTRAL|GROQ|OPENROUTER|XAI|DEEPSEEK|PERPLEXITY|TOGETHER|REPLICATE)_(BASE_URL|ENDPOINT|API_BASE|HOST)$/;

const names = (source: NodeJS.ProcessEnv, re: RegExp) =>
  Object.keys(source)
    .filter((key) => re.test(key) && (source[key] ?? "").trim() !== "")
    .sort();

export function findPaidAiCredentials(source: NodeJS.ProcessEnv = process.env) {
  return {
    keys: names(source, PAID_KEY_NAME),
    endpoints: names(source, PAID_ENDPOINT_NAME),
    freeKeys: names(source, FREE_KEY_NAME),
  };
}

export interface CostInput {
  AI_PROVIDER: string;
  GEMINI_API_KEY?: string | undefined;
  GEMINI_MODEL?: string | undefined;
  GEMINI_BILLING_DISABLED?: boolean | undefined;
}

export function assessAiCost(input: CostInput, source: NodeJS.ProcessEnv = process.env): CostReport {
  const found = findPaidAiCredentials(source);
  const model = input.GEMINI_MODEL?.trim() || "(not configured)";
  const reasons: string[] = [];
  let approvedModel: string | null = null;

  if (input.AI_PROVIDER !== "gemini") reasons.push("Only the Google Gemini provider is allowed.");
  if (!input.GEMINI_API_KEY?.trim()) reasons.push("GEMINI_API_KEY is not configured.");
  if (!input.GEMINI_MODEL?.trim()) {
    reasons.push("GEMINI_MODEL is not configured; free-tier eligibility remains unverified.");
  } else {
    try {
      approvedModel = assertApprovedFreeModel("gemini", model);
    } catch (error) {
      reasons.push(error instanceof PolicyViolation ? "The configured Gemini model's current free-tier eligibility is unverified; AI startup is disabled." : "The Gemini model could not be verified.");
    }
  }
  if (!input.GEMINI_BILLING_DISABLED) {
    reasons.push("Confirm in Google Cloud that billing is disabled for the Gemini project, then set GEMINI_BILLING_DISABLED=true.");
  }

  const billingDisabledAttested = input.GEMINI_BILLING_DISABLED === true;
  if (billingDisabledAttested) {
    reasons.push("Billing-disabled status is operator-attested only; the application cannot inspect the Google project.");
  }

  const safe = reasons.length === 1 && billingDisabledAttested && Boolean(approvedModel) && Boolean(input.GEMINI_API_KEY?.trim());
  if (safe) reasons.length = 0;
  return {
    provider: "Google Gemini API (model eligibility unverified; disabled)",
    model: approvedModel ?? model,
    execution: "Online (Google Gemini API)",
    cloudRequest: true,
    paid: false,
    billingRequired: false,
    apiKeyRequired: true,
    potentialAutomaticBilling: !billingDisabledAttested,
    estimatedCost: "UNKNOWN",
    freeKeysPresent: found.freeKeys,
    freeServices: approvedModel ? [`Google Gemini (${approvedModel})`] : [],
    paidKeysPresent: found.keys,
    paidEndpointsPresent: found.endpoints,
    billingDisabledAttested,
    result: safe ? "SAFE" : "BLOCKED",
    reasons: safe
      ? ["No provider fallback is enabled. Billing status remains an operator attestation, not an API-verified fact."]
      : reasons,
  };
}

const yn = (value: boolean) => (value ? "Yes" : "No");

export function formatCostReport(report: CostReport): string {
  const lines = [
    "AI Cost Safety Check",
    `  Provider:                     ${report.provider}`,
    `  Model:                        ${report.model}`,
    `  Execution:                    ${report.execution}`,
    `  Cloud request:                ${yn(report.cloudRequest)}`,
    `  Paid provider configured:     ${yn(report.paid)}`,
    `  Billing disabled attested:    ${yn(report.billingDisabledAttested)} (not independently verified)`,
    `  Potential automatic billing:  ${yn(report.potentialAutomaticBilling)}`,
    `  Estimated AI API cost:        ${report.estimatedCost}`,
    `  Free model configured:        ${report.freeServices.length ? report.freeServices.join(", ") : "none"}`,
    `  Gemini key present:           ${report.freeKeysPresent.length ? "Yes (name only; value never printed)" : "No"}`,
    `  Other AI key names present:   ${report.paidKeysPresent.length ? report.paidKeysPresent.join(", ") : "No"}`,
    `  Other AI endpoint names:      ${report.paidEndpointsPresent.length ? report.paidEndpointsPresent.join(", ") : "No"}`,
    `  Result:                       ${report.result}`,
  ];
  for (const reason of report.reasons) lines.push(`  - ${reason}`);
  return lines.join("\n");
}
