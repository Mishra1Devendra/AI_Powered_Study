import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { AiFeature, AiUsage, Role } from "@copilot/shared";
import type { AiCharge, AiQuota } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The AI charge made for this request, until it is given back. */
    aiCharge: AiCharge | null;
  }
  interface FastifyInstance {
    aiQuota: AiQuotaGuard;
  }
}

export interface AiQuotaGuard {
  /** A preHandler for a route that asks the AI for something: charges the feature's cost (no-op for administrators). Put it AFTER `authenticate`. */
  guard(feature: AiFeature): preHandlerAsyncHookHandler;
  /** Gives this request's charge back (the request ended up not using the AI, e.g. it returned an existing result). Safe to call twice. */
  refund(req: FastifyRequest): Promise<void>;
  usage(userId: string, role: Role | null): Promise<AiUsage>;
}

const NEVER_RESETS = new Date(Date.UTC(2100, 0, 1)).toISOString();

/**
 * Installs the daily AI allowance on the app: `app.aiQuota.guard("quiz")` on each AI route. Without a quota (tests that do not
 * inject one) every guard does nothing. A request that ends with an error status gives its charge back.
 */
export function installAiQuota(app: FastifyInstance, quota: AiQuota | undefined): void {
  app.decorateRequest("aiCharge", null);

  const refund = async (req: FastifyRequest) => {
    const charge = req.aiCharge;
    req.aiCharge = null;
    if (charge && quota) await quota.refund(charge);
  };

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    // Bad input, a conflict, a missing item: the AI was never asked, so the student does not pay for it.
    if (req.aiCharge && reply.statusCode >= 400) await refund(req);
  });

  const guard: AiQuotaGuard = {
    guard(feature) {
      return async (req) => {
        if (!quota || !req.user) return;
        req.aiCharge = await quota.charge(req.user.id, req.role, feature);
      };
    },
    refund,
    usage: async (userId, role) => (quota ? quota.usage(userId, role) : { unlimited: true, limit: null, used: 0, remaining: null, resetsAt: NEVER_RESETS }),
  };
  app.decorate("aiQuota", guard);
}
