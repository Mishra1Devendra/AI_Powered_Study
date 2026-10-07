// Guards the production bundle. Run after `npm run build`: node scripts/verify-prod-bundle.mjs
// Fails if the bundle was built in development mode, contains dev-only preview/sample data,
// or contains anything that looks like a server secret.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|css|html|map)$/.test(name)) yield p;
  }
}

const forbidden = [
  // Warning text that only React's development build contains (library code may mention jsxDEV).
  ["development React build", /Each child in a list should have a unique/],
  ["dev-only preview routes", /\/dev\/(dashboard|tutor|notes|quiz|study-plan|progress|viva|recommendations)/],
  ["fake tutor backend", /Fake in-memory tutor/],
  ["fake notes backend", /Fake in-memory notes/],
  ["fake quiz backend", /Fake in-memory quizzes/],
  ["fake planner backend", /Fake in-memory study plans/],
  ["fake progress backend", /Fake in-memory progress/],
  ["fake viva backend", /Fake in-memory vivas/],
  ["fake recommendations backend", /Fake in-memory recommendations/],
  ["sample fixture data", /SAMPLE DATA|Sample Student/],
  ["service-role key reference", /service_role/],
  ["database URL", /postgres(ql)?:\/\//],
  ["Anthropic key", /sk-ant-/],
];

const problems = [];
let count = 0;
for (const file of files(dist)) {
  count++;
  const text = readFileSync(file, "utf8");
  for (const [label, re] of forbidden) if (re.test(text)) problems.push(`${label} found in ${file}`);
}

if (count === 0) problems.push("dist/ is empty - run the build first");
if (problems.length) {
  console.error("FAIL production bundle check:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(`OK    production bundle clean (${count} files checked)`);
