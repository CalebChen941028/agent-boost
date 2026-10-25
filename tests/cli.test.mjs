import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(ROOT_DIR, "bin", "agent-boost.mjs");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));

test("CLI: --version outputs package version", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, new RegExp(`agent-boost v${PKG.version}`));
});

test("CLI: --help prints command reference", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /agent-boost <command>/);
  assert.match(res.stdout, /install/);
  assert.match(res.stdout, /uninstall/);
  assert.match(res.stdout, /selftest/);
  assert.match(res.stdout, /benchmark/);
  assert.match(res.stdout, /report/);
});

test("CLI: install --dry-run succeeds for zcode target", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "install", "--target", "zcode", "--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /\[Dry-Run\] Target: zcode/);
});

test("CLI: install --dry-run succeeds for claude target", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "install", "--target", "claude", "--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /\[Dry-Run\] Target: claude/);
});

test("CLI: install --dry-run succeeds for antigravity and agents targets", () => {
  const resA = spawnSync(process.execPath, [CLI_PATH, "install", "--target", "antigravity", "--dry-run"], { encoding: "utf8" });
  assert.equal(resA.status, 0);
  assert.match(resA.stdout, /\[Dry-Run\] Target: antigravity/);

  const resB = spawnSync(process.execPath, [CLI_PATH, "install", "--target", "agents", "--dry-run"], { encoding: "utf8" });
  assert.equal(resB.status, 0);
  assert.match(resB.stdout, /\[Dry-Run\] Target: agents/);
});

test("CLI: install --dry-run succeeds for batch all target", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "install", "--target", "all", "--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Multi-Agent Batch Installation/);
});

test("CLI: rejects unknown command with exit 1", () => {
  const res = spawnSync(process.execPath, [CLI_PATH, "invalid-cmd"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown command: invalid-cmd/);
});
