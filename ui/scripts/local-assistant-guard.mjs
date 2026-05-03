#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultScanRoots = [join(uiRoot, "src"), join(uiRoot, "index.html")];
const allowedExtensions = new Set([".ts", ".tsx", ".css", ".html"]);

const lineChecks = [
  {
    name: "API-key/token UI or copy",
    patterns: [
      /\bapi[\s_-]*(?:key|token)\b/i,
      /\b(?:openai|anthropic|provider|llm|model)[\s_-]*(?:api[\s_-]*)?(?:key|token|secret|credential)s?\b/i,
      /\b(?:key|token|secret|credential)s?\s*(?:for|to)\s*(?:openai|anthropic|provider|llm|model)\b/i,
    ],
  },
  {
    name: "provider selection UI",
    patterns: [
      /\b(?:select|choose|switch|configure)\s+(?:an?\s+)?(?:ai\s+|llm\s+|model\s+)?provider\b/i,
      /\b(?:provider|model)\s+(?:dropdown|select|selector|picker|option)s?\b/i,
      /\b(?:ai|llm)\s+provider\b/i,
    ],
  },
  {
    name: "direct browser/network call path",
    patterns: [
      /\bfetch\s*\(/,
      /\baxios\s*\./,
      /\baxios\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bEventSource\s*\(/,
      /\bWebSocket\s*\(/,
    ],
  },
  {
    name: "external AI/provider endpoint",
    patterns: [
      /\bapi\.openai\.com\b/i,
      /\bapi\.anthropic\.com\b/i,
      /\bgenerativelanguage\.googleapis\.com\b/i,
      /\bapi\.mistral\.ai\b/i,
      /\bapi\.groq\.com\b/i,
      /\bopenrouter\.ai\b/i,
      /\bapi\.perplexity\.ai\b/i,
      /\bapi\.cohere\.ai\b/i,
      /\bapi\.together\.xyz\b/i,
      /\blocalhost:11434\b/i,
    ],
  },
  {
    name: "assistant overclaim wording",
    patterns: [
      /\bAI\s+Copilot\b/i,
      /\bAsk\s+AI\b/i,
      /\bLLM[-\s]+driven\s+testbench\s+generation\b/i,
      /\bprovider[-\s]+backed\s+assistant\b/i,
      /\bAPI[-\s]+key[-\s]+powered\s+assistant\b/i,
      /\bcloud[-\s]+assistant\b/i,
      /\bcloud\s+LLM\s+bridge\b/i,
      /\bcloud[-\s]+LLM\b/i,
      /\b(?:Claude|GPT)\s+directly\s+controls\s+pccx-lab\b/i,
      /\b(?:Claude|GPT)\s+controls\s+pccx-lab\b/i,
    ],
  },
  {
    name: "unsupported board/runtime claim",
    patterns: [
      /\bproduction[-\s]+ready\b/i,
      /\bmarketplace[-\s]+ready\b/i,
      /\bstable\s+plugin\s+(?:ABI|API)\b/i,
      /\bMCP\s+integration\s+complete\b/i,
      /\bMCP\s+runtime\s+complete\b/i,
      /\blauncher\s+integration\s+complete\b/i,
      /\blauncher\s+runtime\s+complete\b/i,
      /\bIDE\s+integration\s+complete\b/i,
      /\bIDE\s+runtime\s+complete\b/i,
      /\bruntime\s+integration\s+complete\b/i,
      /\bKV260\s+inference\s+works\b/i,
      /\b20\s+tok\/s\s+achieved\b/i,
      /\btiming\s+closed\b/i,
      /\btiming\s+closure\s+achieved\b/i,
      /\btiming[-\s]+closed\s+bitstream\b/i,
      /\brunning\s+the\s+pccx\s+v002\s+bitstream\b/i,
      /\bmeasurements\s+were\s+captured\s+on\b/i,
    ],
  },
];

const compactBans = [
  "apikey",
  "apitoken",
  "openaiapikey",
  "openaitoken",
  "anthropicapikey",
  "anthropictoken",
  "providerapikey",
  "providerkey",
  "providertoken",
  "aicopilot",
  "askai",
  "cloudassistant",
  "cloudllm",
  "cloudllmbridge",
  "providerbackedassistant",
  "apikeypoweredassistant",
  "productionready",
  "marketplaceready",
  "stablepluginabi",
  "stablepluginapi",
  "mcpintegrationcomplete",
  "mcpruntimecomplete",
  "launcherintegrationcomplete",
  "launcherruntimecomplete",
  "ideintegrationcomplete",
  "ideruntimecomplete",
  "runtimeintegrationcomplete",
  "kv260inferenceworks",
  "20toksachieved",
  "timingclosed",
  "timingclosureachieved",
];

function extensionOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

function collectFiles(path, out = []) {
  if (!existsSync(path)) return out;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (allowedExtensions.has(extensionOf(path))) out.push(path);
    return out;
  }

  const entries = readdirSync(path).sort();
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    collectFiles(join(path, entry), out);
  }
  return out;
}

function usage() {
  return [
    "Usage: node scripts/local-assistant-guard.mjs [--root <path>...]",
    "",
    "Without --root, scans the production UI source roots.",
    "With --root, scans only the supplied fixture or source path(s).",
  ].join("\n");
}

function parseScanRoots(argv) {
  const roots = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--root") {
      const root = argv[index + 1];
      if (!root) {
        throw new Error("Missing path after --root");
      }
      roots.push(resolve(root));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return roots.length > 0 ? roots : defaultScanRoots;
}

let scanRoots;
try {
  scanRoots = parseScanRoots(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(2);
}

const files = scanRoots.flatMap(root => collectFiles(root));
const failures = [];

for (const file of files) {
  const rel = relative(uiRoot, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  for (const { name, patterns } of lineChecks) {
    for (const pattern of patterns) {
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          failures.push(`${rel}:${index + 1}: ${name}: ${pattern}`);
        }
      });
    }
  }

  const compact = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const token of compactBans) {
    if (compact.includes(token)) {
      failures.push(`${rel}: compact guard matched forbidden token: ${token}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Local assistant static guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Local assistant static guard passed (${files.length} files scanned).`);
