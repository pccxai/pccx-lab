#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const guardScript = join(scriptDir, "local-assistant-guard.mjs");
const fixtureRoot = join(scriptDir, "fixtures", "local-assistant-guard");

const cases = [
  {
    name: "safe local-only wording",
    path: join(fixtureRoot, "safe-local.fixture.ts"),
    expectPass: true,
    snippets: ["Local assistant static guard passed"],
  },
  {
    name: "API-key/token UI regression",
    path: join(fixtureRoot, "api-key-ui.fixture.ts"),
    expectPass: false,
    snippets: ["api-key-ui.fixture.ts", "API-key/token UI or copy"],
  },
  {
    name: "provider fetch regression",
    path: join(fixtureRoot, "provider-fetch.fixture.ts"),
    expectPass: false,
    snippets: [
      "provider-fetch.fixture.ts",
      "direct browser/network call path",
      "external AI/provider endpoint",
    ],
  },
  {
    name: "assistant wording regression",
    path: join(fixtureRoot, "assistant-wording.fixture.ts"),
    expectPass: false,
    snippets: ["assistant-wording.fixture.ts", "assistant overclaim wording"],
  },
  {
    name: "unsupported board/runtime claim regression",
    path: join(fixtureRoot, "runtime-claims.fixture.ts"),
    expectPass: false,
    snippets: [
      "runtime-claims.fixture.ts",
      "unsupported board/runtime claim",
    ],
  },
];

const failures = [];

for (const testCase of cases) {
  const result = spawnSync(process.execPath, [guardScript, "--root", testCase.path], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const passed = result.status === 0;

  if (testCase.expectPass && !passed) {
    failures.push(`${testCase.name}: expected pass, got exit ${result.status}\n${output}`);
    continue;
  }

  if (!testCase.expectPass && passed) {
    failures.push(`${testCase.name}: expected failure, got pass\n${output}`);
    continue;
  }

  for (const snippet of testCase.snippets) {
    if (!output.includes(snippet)) {
      failures.push(`${testCase.name}: missing output snippet ${JSON.stringify(snippet)}\n${output}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Local assistant guard fixture tests failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Local assistant guard fixture tests passed (${cases.length} cases).`);
