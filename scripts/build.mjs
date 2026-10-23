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

function isEscaped(str, idx) {
  let count = 0;
  for (let i = idx - 1; i >= 0 && str[i] === "\\"; i--) {
    count++;
  }
  return count % 2 === 1;
}

/**
 * Extracts a top-level `export function <name>(...) { ... }` block using a lexical
 * scanner that skips strings ('', "", ``), comments (//, /* *\/), and regex literals (//),
 * and normalizes parameter signatures (stripping TS types) and function bodies.
 */
function extractNormalizedFunction(source, fnName) {
  const startToken = `export function ${fnName}`;
  const startIdx = source.indexOf(startToken);
  if (startIdx === -1) {
    throw new Error(`Function "${fnName}" not found`);
  }

  // Find opening parenthesis of parameter list
  const openParenIdx = source.indexOf("(", startIdx + startToken.length);
  if (openParenIdx === -1) {
    throw new Error(`Parameter list start '(' not found for "${fnName}"`);
  }

  // Find closing parenthesis of parameter list skipping strings and comments
  let parenDepth = 0;
  let closeParenIdx = -1;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openParenIdx; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "/" && source[i - 1] === "*") inBlockComment = false;
      continue;
    }
    if (inString) {
      if (ch === inString && !isEscaped(source, i)) inString = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
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

  const rawParams = source.slice(openParenIdx + 1, closeParenIdx);

  // Normalize parameters: split by top-level comma, strip TS types and optional marks
  const splitParams = [];
  let curParam = "";
  let pDepth = 0;
  let bDepth = 0;
  let strMode = null;
  for (let i = 0; i < rawParams.length; i++) {
    const ch = rawParams[i];
    if (strMode) {
      if (ch === strMode && !isEscaped(rawParams, i)) strMode = null;
      curParam += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      strMode = ch;
      curParam += ch;
      continue;
    }
    if (ch === "(" || ch === "<") pDepth++;
    else if (ch === ")" || ch === ">") pDepth--;
    else if (ch === "{" || ch === "[") bDepth++;
    else if (ch === "}" || ch === "]") bDepth--;
    else if (ch === "," && pDepth === 0 && bDepth === 0) {
      if (curParam.trim()) splitParams.push(curParam.trim());
      curParam = "";
      continue;
    }
    curParam += ch;
  }
  if (curParam.trim()) {
    splitParams.push(curParam.trim());
  }

  const normalizedParams = splitParams
    .map((p) => {
      const eqIdx = p.indexOf("=");
      if (eqIdx !== -1) {
        const left = p.slice(0, eqIdx).trim();
        const right = p.slice(eqIdx + 1).trim();
        const cleanLeft = left.replace(/\?$/, "").replace(/:[\s\S]*$/, "").trim();
        return `${cleanLeft} = ${right}`;
      } else {
        return p.replace(/\?$/, "").replace(/:[\s\S]*$/, "").trim();
      }
    })
    .join(", ");

  // Find opening brace '{' of function body (skipping return type)
  let bodyStartIdx = -1;
  const afterParen = source.slice(closeParenIdx + 1).trimStart();
  const hasReturnType = afterParen.startsWith(":");

  if (!hasReturnType) {
    bodyStartIdx = source.indexOf("{", closeParenIdx + 1);
  } else {
    let colonIdx = source.indexOf(":", closeParenIdx + 1);
    let angleDepth = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let inType = false;
    let strMode = null;

    for (let i = colonIdx + 1; i < source.length; i++) {
      const ch = source[i];
      if (strMode) {
        if (ch === strMode && !isEscaped(source, i)) strMode = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        strMode = ch;
        continue;
      }
      if (!inType) {
        if (/\s/.test(ch)) continue;
        inType = true;
        if (ch === "{") {
          braceDepth = 1;
          continue;
        }
      }
      if (ch === "<") angleDepth++;
      else if (ch === ">") angleDepth--;
      else if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      else if (ch === "{") {
        if (angleDepth > 0 || parenDepth > 0 || braceDepth > 0) {
          braceDepth++;
        } else {
          bodyStartIdx = i;
          break;
        }
      } else if (ch === "}") {
        if (braceDepth > 0) braceDepth--;
      }
    }
  }

  if (bodyStartIdx === -1) {
    throw new Error(`Could not locate body start of "${fnName}"`);
  }

  // Find matching closing brace '}' using lexical scanner
  let braceDepth = 0;
  let bodyEndIdx = -1;
  inString = null;
  inLineComment = false;
  inBlockComment = false;
  let inRegex = false;
  let inCharClass = false;
  const templateStack = [];

  for (let i = bodyStartIdx; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "/" && source[i - 1] === "*") inBlockComment = false;
      continue;
    }
    if (inString === "'" || inString === '"') {
      if (ch === inString && !isEscaped(source, i)) inString = null;
      continue;
    }
    if (inString === "`") {
      if (ch === "`" && !isEscaped(source, i)) {
        inString = null;
        continue;
      }
      if (ch === "$" && next === "{" && !isEscaped(source, i)) {
        templateStack.push(braceDepth);
        inString = null;
        i++; // skip '$'
        braceDepth++; // for '{'
        continue;
      }
      continue;
    }
    if (inRegex) {
      if (inCharClass) {
        if (ch === "]" && !isEscaped(source, i)) inCharClass = false;
        continue;
      }
      if (ch === "[" && !isEscaped(source, i)) {
        inCharClass = true;
        continue;
      }
      if (ch === "/" && !isEscaped(source, i)) {
        inRegex = false;
        continue;
      }
      continue;
    }

    // Comment starts
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    // String starts
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }

    // Regex start
    if (ch === "/") {
      const preceding = source.slice(bodyStartIdx, i).trimEnd();
      const lastChar = preceding[preceding.length - 1];
      if (/[=(:,;!&|?{\[]/.test(lastChar) || /\breturn\b$/.test(preceding)) {
        inRegex = true;
        inCharClass = false;
        continue;
      }
    }

    if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      braceDepth--;
      if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        inString = "`";
        continue;
      }
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
  const normalizedBody = rawBody
    // Remove TypeScript variable and param type annotations
    .replace(/:\s*(?:string|number|boolean|any|FileConflict|FindingLike)(?:\[\])?/g, "")
    .replace(/new Map<[^>]+>\(\)/g, "new Map()")
    // Collapse whitespace for canonical structural comparison
    .replace(/\s+/g, " ")
    .trim();

  return {
    params: normalizedParams,
    body: normalizedBody,
  };
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
  let tsFn, jsFn, dwfFn;
  try {
    tsFn = extractNormalizedFunction(tsContent, fn);
    jsFn = extractNormalizedFunction(jsContent, fn);
    dwfFn = extractNormalizedFunction(dwfContent, fn);
  } catch (err) {
    console.error(`✖ Missing or malformed helper "${fn}": ${err.message}`);
    process.exit(1);
  }

  // 1. Parameter signature check
  if (tsFn.params !== dwfFn.params) {
    console.error(
      `✖ Parameter signature drift detected in "${fn}" between shared/verify-gate.ts and adapters/zcode/boost.dwf.ts!`,
    );
    console.error("  verify-gate.ts:", tsFn.params);
    console.error("  boost.dwf.ts:  ", dwfFn.params);
    process.exit(1);
  }

  if (tsFn.params !== jsFn.params) {
    console.error(
      `✖ Parameter signature drift detected in "${fn}" between shared/verify-gate.ts and shared/verify-gate.js!`,
    );
    console.error("  verify-gate.ts:", tsFn.params);
    console.error("  verify-gate.js:", jsFn.params);
    process.exit(1);
  }

  // 2. Body logic check
  if (tsFn.body !== dwfFn.body) {
    console.error(
      `✖ Logic drift detected in "${fn}" between shared/verify-gate.ts and adapters/zcode/boost.dwf.ts!`,
    );
    console.error("  verify-gate.ts:", tsFn.body);
    console.error("  boost.dwf.ts:  ", dwfFn.body);
    process.exit(1);
  }

  if (tsFn.body !== jsFn.body) {
    console.error(
      `✖ Logic drift detected in "${fn}" between shared/verify-gate.ts and shared/verify-gate.js!`,
    );
    console.error("  verify-gate.ts:", tsFn.body);
    console.error("  verify-gate.js:", jsFn.body);
    process.exit(1);
  }
}

console.log(
  `✔ All ${requiredPureFunctions.length} shared verify-gate functions are 100% parameter- and body-identical across TS, JS, and boost.dwf.ts.`,
);
console.log("Build verification successful!");
