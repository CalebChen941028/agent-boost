#!/usr/bin/env node
/**
 * Build and validation script for agent-boost.
 * Verifies that shared gate helpers and schema definitions are in sync.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("Checking agent-boost build and shared module consistency...");

// 1. Validate JSON schema
const schemaPath = path.join(rootDir, "shared", "models.schema.json");
const examplePath = path.join(rootDir, "models.example.json");

try {
  JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  JSON.parse(fs.readFileSync(examplePath, "utf8"));
  console.log("✔ JSON configurations valid.");
} catch (err) {
  console.error("✖ JSON validation failed:", err.message);
  process.exit(1);
}

// 2. Validate verify-gate pure functions
const dwfPath = path.join(rootDir, "adapters", "zcode", "boost.dwf.ts");
const dwfContent = fs.readFileSync(dwfPath, "utf8");

const requiredPureFunctions = [
  "formatFailureOutput",
  "computeFailureSignature",
];

for (const fn of requiredPureFunctions) {
  if (!dwfContent.includes(`function ${fn}`)) {
    console.error(`✖ Missing inlined helper "${fn}" in boost.dwf.ts`);
    process.exit(1);
  }
}

console.log("✔ boost.dwf.ts helper alignment verified.");
console.log("Build verification successful!");
