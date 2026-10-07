import { AI_COST, AI_FEATURE_LABEL, AI_LIMIT_CODE, type AiFeature, type AiUsage, type Role } from "@copilot/shared";
import { AppError } from "../errors.js";
import type { AiUsageRepository } from "./repository.js";

/** A charge that was made for one request, so it can be given back. */
export interface AiCharge {
  userId: string;
  day: string;
  units: number;
  feature: AiFeature;
}

export interface AiQuotaDeps {
  repo: AiUsageRepository;
  /** The daily allowance of a student. */
  dailyUnits: number;
  now?: () => Date;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const nextMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

/** "about 3 hours" / "about 40 minutes", for the message a student reads. */
function untilReset(now: Date): string {
  const minutes = Math.max(1, Math.ceil((nextMidnight(now).getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * The daily AI allowance. Administrators are never limited (and never counted); everyone else has `dailyUnits` per UTC day.
 * Each AI action charges its cost BEFORE the AI is asked, atomically, and the charge is given back if the request then fails
 * (bad input, a conflict) so a student only pays for work that actually started.
 */
export function createAiQuota(deps: AiQuotaDeps) {
  const now = deps.now ?? (() => new Date());
  const unlimited = (role: Role | null) => role === "admin";

  return {
    dailyUnits: deps.dailyUnits,

    /** Charges one action. Returns the charge (to refund later), or null when the account is unlimited. Throws 429 when the day's allowance is spent. */
    async charge(userId: string, role: Role | null, feature: AiFeature): Promise<AiCharge | null> {
      if (unlimited(role)) return null;
      const t = now();
      const day = utcDay(t);
      const units = AI_COST[feature];
      const total = await deps.repo.tryCharge(userId, day, units, deps.dailyUnits);
      if (total === null) {
        const used = await deps.repo.used(userId, day);
        const left = Math.max(0, deps.dailyUnits - used);
        throw new AppError(
          429,
          AI_LIMIT_CODE,
          `You've reached today's AI limit (${AI_FEATURE_LABEL[feature]} needs ${units} ${units === 1 ? "use" : "uses"}, you have ${left} left of ${deps.dailyUnits}). It starts again in ${untilReset(t)}. Everything that doesn't use AI still works.`,
          { limit: deps.dailyUnits, used, remaining: left, resetsAt: nextMidnight(t).toISOString() },
        );
      }
      return { userId, day, units, feature };
    },

    async refund(charge: AiCharge | null): Promise<void> {
      if (charge) await deps.repo.refund(charge.userId, charge.day, charge.units);
    },

    async usage(userId: string, role: Role | null): Promise<AiUsage> {
      const t = now();
      const resetsAt = nextMidnight(t).toISOString();
      if (unlimited(role)) return { unlimited: true, limit: null, used: 0, remaining: null, resetsAt };
      const used = await deps.repo.used(userId, utcDay(t));
      return { unlimited: false, limit: deps.dailyUnits, used, remaining: Math.max(0, deps.dailyUnits - used), resetsAt };
    },
  };
}

export type AiQuota = ReturnType<typeof createAiQuota>;
