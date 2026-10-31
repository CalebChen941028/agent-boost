#!/usr/bin/env node

/**
 * agent-boost — Unified CLI interface
 *
 * Provides a direct command-line entrypoint for agent-boost:
 *   npx agent-boost install --target zcode --lang auto
 *   npx agent-boost selftest
 *   npx agent-boost benchmark --tasks LIVE-EXPRESS-RACE
 *   npx agent-boost report
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

function readPackageJson() {
  try {
    const pkgPath = path.join(ROOT_DIR, "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return { version: "0.6.2" };
  }
}

const pkg = readPackageJson();
const VERSION = pkg.version || "0.6.2";

function printHelp() {
  console.log(`
agent-boost v${VERSION} — Multi-Agent Deep Reasoning Workflow Engine

Usage:
  agent-boost <command> [options]
  boost <command> [options]

Commands:
  install       Install agent-boost into target AI coding agents
                Options:
                  --target <name>  all | zcode | claude | codex | antigravity | agents |
                                   deepseek | opencode | workbuddy | cursor | windsurf |
                                   cline | aider | generic
                  --lang <opt>     auto | zh | en (default: auto)
                  --dest <path>    Custom destination directory
                  --dry-run        Simulate installation without writing files

  uninstall     Uninstall agent-boost from target AI coding agents
                Options:
                  --target <name>  Target platform adapter to remove
                  --dest <path>    Custom destination directory

  selftest      Run offline harness machinery self-test (60/60 checks, $0 API spend)

  benchmark     Run live dual-track benchmark duels
                Options:
                  --model <name>   Model name (e.g. deepseek-v4.1-flash, mimo-v2.6-flash)
                  --tasks <ids>    Comma-separated task list (e.g. LIVE-EXPRESS-RACE)
                  --json <path>    Structured JSON audit ledger destination
                  --html <path>    Interactive visual report output destination

  report        Generate visual HTML / Markdown reports from benchmark ledgers
                Options:
                  --in <path>      Input JSON run file (default: live-results/live-run-final.json)
                  --out <path>     Output report destination (.html or .md)
                  --compare <f1> <f2> [out]  Generate cross-model comparison dashboard

  version, -v   Print version (${VERSION})
  help, -h      Show this help message

Documentation & Repository:
  https://github.com/CalebChen941028/agent-boost
`);
}

function runShellScript(scriptName, args) {
  const scriptPath = path.join(ROOT_DIR, scriptName);
  const result = spawnSync("bash", [scriptPath, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, AGENT_BOOST_ROOT: ROOT_DIR }
  });
  process.exit(result.status ?? 0);
}

function runNodeScript(scriptRelativePath, args) {
  const scriptPath = path.join(ROOT_DIR, scriptRelativePath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, AGENT_BOOST_ROOT: ROOT_DIR }
  });
  process.exit(result.status ?? 0);
}

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

if (!command || command === "-h" || command === "--help" || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "-v" || command === "--version" || command === "version") {
  console.log(`agent-boost v${VERSION}`);
  process.exit(0);
}

switch (command) {
  case "install":
    runShellScript("install.sh", subArgs);
    break;

  case "uninstall":
    runShellScript("uninstall.sh", subArgs);
    break;

  case "selftest":
    runNodeScript("scripts/run-live-benchmarks.mjs", ["--offline-selftest", ...subArgs]);
    break;

  case "benchmark":
  case "live":
    runNodeScript("scripts/run-live-benchmarks.mjs", subArgs);
    break;

  case "report":
    runNodeScript("scripts/generate-benchmark-report.mjs", subArgs);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
