#!/usr/bin/env node
/**
 * Build and Single-Source-of-Truth (SSOT) validation script for agent-boost.
 * Verifies:
 * 1. JSON schema & models.example.json validity and semantic compliance.
 * 2. Exact body parity of pure functions across shared/verify-gate.ts,
 *    shared/verify-gate.js, and adapters/zcode/boost.dwf.ts.
 * 3. Role prompt and adapter completeness.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("Checking agent-boost build and Single-Source-of-Truth consistency...");

// 1. Validate JSON schema and models.example.json
const schemaPath = path.join(rootDir, "shared", "models.schema.json");
const examplePath = path.join(rootDir, "models.example.json");
const opencodePath = path.join(rootDir, "adapters", "opencode", "agents.json");

try {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const opencode = JSON.parse(fs.readFileSync(opencodePath, "utf8"));

  if (typeof example.default_light_model !== "string" || !example.models) {
    throw new Error("models.example.json does not satisfy required fields in models.schema.json");
  }
  const allowedTiers = schema.properties.models.additionalProperties.properties.tier.enum;
  for (const [key, val] of Object.entries(example.models)) {
    if (!val.id || (val.tier && !allowedTiers.includes(val.tier))) {
      throw new Error(`Invalid model entry "${key}" in models.example.json`);
    }
  }
  for (const [role, cfg] of Object.entries(opencode.roles || {})) {
    const promptPath = path.join(rootDir, cfg.prompt);
    const zhPromptPath = path.join(rootDir, cfg.prompt.replace(/\.en\.md$/, ".zh.md"));
    if (!fs.existsSync(promptPath) || !fs.existsSync(zhPromptPath)) {
      throw new Error(`Missing bilingual role prompt files for OpenCode role "${role}"`);
    }
  }
  console.log("✔ JSON configurations and bilingual role files validated.");
} catch (err) {
  console.error("✖ Configuration validation failed:", err.message);
  process.exit(1);
}

/**
 * Extracts a top-level `export function <name>(...) { ... }` block and strips TypeScript
 * type annotations so TS and JS implementations can be compared for exact logic parity.
 */
function extractNormalizedFunction(source, fnName) {
  const startToken = `export function ${fnName}`;
  const startIdx = source.indexOf(startToken);
  if (startIdx === -1) {
    throw new Error(`Function "${fnName}" not found`);
  }

  // Find closing parenthesis of parameter list
  let parenDepth = 0;
  let closeParenIdx = -1;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        closeParenIdx = i;
        break;
      }
    }
  }
  if (closeParenIdx === -1) {
    throw new Error(`Could not locate parameter list end of "${fnName}"`);
  }

  // Find opening brace of function body (skipping optional return type annotation like `: string` or `: { a: string; b: boolean }`)
  let typeBraceDepth = 0;
  let bodyStartIdx = -1;
  const afterParen = source.slice(closeParenIdx + 1).trimStart();
  const hasReturnType = afterParen.startsWith(":");

  if (!hasReturnType) {
    bodyStartIdx = source.indexOf("{", closeParenIdx + 1);
  } else {
    let seenFirstTypeToken = false;
    let inObjectType = false;
    for (let i = closeParenIdx + 1; i < source.length; i++) {
      const ch = source[i];
      if (!seenFirstTypeToken) {
        if (ch === ":" || /\s/.test(ch)) continue;
        seenFirstTypeToken = true;
        if (ch === "{") {
          inObjectType = true;
          typeBraceDepth = 1;
          continue;
        }
      }
      if (inObjectType) {
        if (ch === "{") typeBraceDepth++;
        else if (ch === "}") {
          typeBraceDepth--;
          if (typeBraceDepth === 0) {
            inObjectType = false;
          }
        }
      } else if (ch === "{") {
        bodyStartIdx = i;
        break;
      }
    }
  }
  if (bodyStartIdx === -1) {
    throw new Error(`Could not locate body of "${fnName}"`);
  }

  let braceDepth = 0;
  let bodyEndIdx = -1;
  for (let i = bodyStartIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        bodyEndIdx = i;
        break;
      }
    }
  }
  if (bodyEndIdx === -1) {
    throw new Error(`Unbalanced braces in "${fnName}"`);
  }

  const rawBody = source.slice(bodyStartIdx, bodyEndIdx + 1);
  return rawBody
    // Remove TypeScript variable type annotations like `: string[]`, `: Map<string, string[]>`, `: FileConflict[]`
    .replace(/:\s*(?:string|number|boolean|any|FileConflict|FindingLike)(?:\[\])?/g, "")
    .replace(/new Map<[^>]+>\(\)/g, "new Map()")
    // Collapse whitespace for canonical structural comparison
    .replace(/\s+/g, " ")
    .trim();
}

// 2. Validate exact AST/structural body parity across shared/verify-gate.ts, shared/verify-gate.js, and boost.dwf.ts
const tsPath = path.join(rootDir, "shared", "verify-gate.ts");
const jsPath = path.join(rootDir, "shared", "verify-gate.js");
const dwfPath = path.join(rootDir, "adapters", "zcode", "boost.dwf.ts");

const tsContent = fs.readFileSync(tsPath, "utf8");
const jsContent = fs.readFileSync(jsPath, "utf8");
const dwfContent = fs.readFileSync(dwfPath, "utf8");

const requiredPureFunctions = [
  "formatFailureOutput",
  "computeFailureSignature",
  "detectTargetFileConflicts",
  "formatConclusion",
  "validateTeamProfile",
  "resolveModelConfiguration",
  "formatExperienceEntry",
];

for (const fn of requiredPureFunctions) {
  let tsBody, jsBody, dwfBody;
  try {
    tsBody = extractNormalizedFunction(tsContent, fn);
    jsBody = extractNormalizedFunction(jsContent, fn);
    dwfBody = extractNormalizedFunction(dwfContent, fn);
  } catch (err) {
    console.error(`✖ Missing or malformed helper "${fn}": ${err.message}`);
    process.exit(1);
  }

  if (tsBody !== dwfBody) {
    console.error(
      `✖ Logic drift detected in "${fn}" between shared/verify-gate.ts and adapters/zcode/boost.dwf.ts!`,
    );
    console.error("  verify-gate.ts:", tsBody);
    console.error("  boost.dwf.ts:  ", dwfBody);
    process.exit(1);
  }

  if (tsBody !== jsBody) {
    console.error(
      `✖ Logic drift detected in "${fn}" between shared/verify-gate.ts and shared/verify-gate.js!`,
    );
    console.error("  verify-gate.ts:", tsBody);
    console.error("  verify-gate.js:", jsBody);
    process.exit(1);
  }
}

console.log(
  `✔ All ${requiredPureFunctions.length} shared verify-gate functions are 100% body-identical across TS, JS, and boost.dwf.ts.`,
);
console.log("Build verification successful!");
