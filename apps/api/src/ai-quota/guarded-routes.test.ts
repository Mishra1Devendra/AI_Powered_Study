import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every route that asks the AI for something must be behind the daily AI allowance (administrators are exempt inside the guard).
 * If this fails, an AI route was added or lost its guard: add `app.aiQuota.guard("<feature>")` after `authenticate`, then list it here.
 * (policy.guard.test.ts separately limits which files may call the AI at all.)
 */
const routesDir = join(import.meta.dirname, "..", "routes");
const EXPECTED: Record<string, string[]> = {
  "tutor.ts": ["tutor", "tutor"], // send a message, regenerate
  "notes.ts": ["notes", "notes"], // ask the assistant, regenerate
  "quiz.ts": ["quiz", "quiz"], // generate, regenerate
  "planner.ts": ["planner", "planner", "check"], // generate, regenerate, start a study check
  "viva.ts": ["viva", "viva", "viva"], // start (first question), answer (evaluation), next question
  "recommendations.ts": ["recommendations"], // explain my priorities
  "study-tools.ts": ["flashcards", "mindmap", "mindmap"], // write a deck, draw a map, draw again
};

describe("daily AI allowance covers every AI route", () => {
  for (const [file, features] of Object.entries(EXPECTED)) {
    it(`${file} guards ${features.length} AI route${features.length === 1 ? "" : "s"}: ${features.join(", ")}`, () => {
      const src = readFileSync(join(routesDir, file), "utf8");
      const found = [...src.matchAll(/aiQuota\.guard\("([a-z]+)"\)/g)].map((m) => m[1]!);
      // study-tools builds its guard through one helper, called once per AI route
      const viaHelper = [...src.matchAll(/\.\.\.aiGuard\("([a-z]+)"\)/g)].map((m) => m[1]!);
      const actual = file === "study-tools.ts" ? viaHelper : found;
      expect(actual.sort()).toEqual([...features].sort());
    });
  }

  it("no other route file uses the allowance without being listed (so this list stays the truth)", () => {
    const users = readdirSync(routesDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /aiQuota|aiGuard/.test(readFileSync(join(routesDir, f), "utf8")))
      .sort();
    expect(users).toEqual([...Object.keys(EXPECTED), "me.ts"].sort());
  });
});
