import type { MasteryLevel } from "@copilot/shared";

/** Words for a subject's level (the same thresholds as the Progress page). The level is always written out, never colour alone. */
export const SCORE_LEVEL_LABEL_FOR_MASTERY: Record<MasteryLevel, string> = {
  strong: "Strong",
  needs_practice: "Needs practice",
  weak: "Weak",
  insufficient: "Not enough data yet",
};
