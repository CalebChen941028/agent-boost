#!/usr/bin/env node
/**
 * LIVE API End-to-End Benchmark Runner for agent-boost (v0.4.1)
 * Comparison frame: Solo model (single model, no tools)
 *                 vs model + agent-boost v0.4.1 (model + five-phase toolchain)
 *
 * Harness nature: 100% live evaluation. Every code artifact in this report is
 * produced by real HTTP calls to the OpenCode Zen gateway
 * (https://opencode.ai/zen/go/v1/chat/completions, model mimo-v2.6-flash).
 * Token counts are the gateway's own `usage` accounting (prompt_tokens /
 * completion_tokens), latencies are measured network round-trips, and exit
 * codes come from real `node --test` processes in isolated temp workspaces.
 *
 * Usage:
 *   node scripts/run-live-benchmarks.mjs                     # full live run
 *   node scripts/run-live-benchmarks.mjs --json out.json     # also dump results JSON
 *   node scripts/run-live-benchmarks.mjs --offline-selftest  # harness machinery check, NO API calls
 *   npm run benchmark:live
 *
 * Authentication (never logged, never committed):
 *   OPENCODE_API_KEY or ZEN_API_KEY from the environment, then `<repo>/.env`,
 *   then `~/.env`; if still absent and stdin is a TTY, a hidden prompt asks
 *   for it once and it is NOT persisted by this script.
 *
 * ---------------------------------------------------------------------------
 * Fairness protocol (identical brain, identical task text):
 *   - Same model, same endpoint, temperature 0.2 for every generation call.
 *   - Track A (Solo): the bare task brief (plus on-disk file contents) goes
 *     straight to the model. Code is written, tests run. On failure the solo
 *     agent may retry up to SOLO_MAX_ATTEMPTS with the raw failing test
 *     output as feedback. No conflict gate, no git checkpoint, no rollback,
 *     no test synthesis, no memory.
 *   - Track B (Boost): the same model drives the five-phase state machine —
 *     Phase 1 evaluateTaskComplexity + matchExperienceCues + planner with
 *     detectTargetFileConflicts gating; Phase 2 per-workstream execution on
 *     disjoint file ownership; Phase 3 real git checkpoint, real
 *     `node --test`, computeFailureSignature regression detection, real
 *     `git reset --hard` rollback on baseline regression, verify_synth.sh
 *     test synthesis when verifyCommand is null; Phase 4 agent-as-a-judge
 *     findings fed to calculateYardstickScore; Phase 5 formatExperienceEntry
 *     memory persisted across tasks within the run.
 *   - Repair budgets: solo attempts <= SOLO_MAX_ATTEMPTS (3); boost rounds
 *     come from evaluateTaskComplexity (simple 2 / standard 3 / hard 5) —
 *     the compute-tier allocation itself is part of the treatment.
 *   - Both arms are scored by the SAME judge prompt (independent review of
 *     the final git diff + test outcome) and the same ground-truth test run.
 * ---------------------------------------------------------------------------
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  detectTargetFileConflicts,
  computeFailureSignature,
  calculateYardstickScore,
  matchExperienceCues,
  evaluateTaskComplexity,
  formatExperienceEntry,
} from "../shared/verify-gate.js";
import { generateHtmlReport } from "./generate-benchmark-report.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  endpoint:
    process.env.OPENCODE_API_BASE || process.env.ZEN_API_BASE ||
    "https://opencode.ai/zen/go/v1/chat/completions",
  model: process.env.LIVE_MODEL || "mimo-v2.6-flash",
  temperature: 0.2,
  maxTokens: 6144, // default ceiling; adaptive budget scales with task complexity
  plannerMaxTokens: 2048,
  judgeMaxTokens: 2048,
  requestTimeoutMs: 180_000,
  httpRetries: 3, // network error / 429 / 5xx
  retryBackoffMs: [3000, 9000],
  sessionId: `agent-boost-live-${crypto.randomUUID().slice(0, 8)}`,
  userAgent: "agent-boost-live-benchmark/0.4.1",
  soloMaxAttempts: 3,
};

// Adaptive Test-Time Compute Allocation budgets (Option B)
const TIER_TOKEN_BUDGETS = {
  simple: 2048,
  standard: 4096,
  hard: 6144,
};

// ---------------------------------------------------------------------------
// API key resolution (credential-safe: the value never reaches stdout/logs)
// ---------------------------------------------------------------------------

function parseDotenv(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const out = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function promptForKeyInteractive() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      "OPENCODE_API_KEY not found in env, ./.env or ~/.env.\n" +
      "Enter it now (typing hidden, not stored anywhere): ",
    );
    const stdin = process.stdin;
    const onData = (ch) => {
      // mask characters except newline/ctrl
      const s = String(ch);
      if (s === "\r" || s === "\n" || s === "\u0004") return;
      const len = rl.line.length;
      readline.moveCursor(process.stdout, -len, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write("*".repeat(len));
    };
    stdin.on("data", onData);
    rl.question("", (answer) => {
      stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim() || null);
    });
  });
}

async function resolveApiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (process.env.ZEN_API_KEY) return process.env.ZEN_API_KEY;
  const repoEnv = parseDotenv(path.join(REPO_ROOT, ".env"));
  if (repoEnv.OPENCODE_API_KEY) return repoEnv.OPENCODE_API_KEY;
  if (repoEnv.ZEN_API_KEY) return repoEnv.ZEN_API_KEY;
  const homeEnv = parseDotenv(path.join(os.homedir(), ".env"));
  if (homeEnv.OPENCODE_API_KEY) return homeEnv.OPENCODE_API_KEY;
  if (homeEnv.ZEN_API_KEY) return homeEnv.ZEN_API_KEY;
  return promptForKeyInteractive();
}

// ---------------------------------------------------------------------------
// Live model client (native fetch, zero dependencies)
// ---------------------------------------------------------------------------

let API_KEY = null;
const callLedger = []; // every real HTTP call made during the run

function sanitizeChildEnv() {
  const env = { ...process.env };
  delete env.OPENCODE_API_KEY;
  delete env.ZEN_API_KEY;
  for (const k of Object.keys(env)) {
    if (k.startsWith("NODE_TEST_")) {
      delete env[k];
    }
  }
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAI-compatible call wrapper against the live gateway.
 * Returns a fully metered call record; never throws for HTTP/API-level
 * failures (ok:false + error), only aborts hard on missing credentials.
 */
async function callMimoModel(messages, temperature = CONFIG.temperature, systemPrompt = null, opts = {}) {
  if (!API_KEY) {
    throw new Error("API key unavailable — cannot place live call");
  }
  const maxTokens = opts.maxTokens || CONFIG.maxTokens;
  const tag = opts.tag || "call";
  const payloadMessages = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;

  let attempt = 0;
  let lastError = null;
  while (attempt <= CONFIG.httpRetries) {
    attempt += 1;
    const controller = new AbortController();
    // Deadline covers headers AND body read — a trickling response body must
    // not hang the run (AbortController alone only guards until headers).
    const deadline = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(CONFIG.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "x-opencode-session": CONFIG.sessionId,
          "User-Agent": CONFIG.userAgent,
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: payloadMessages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
      const rawText = await Promise.race([
        res.text(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("BodyReadTimeoutError: response body read exceeded deadline")), CONFIG.requestTimeoutMs),
        ),
      ]);
      const latencyMs = Math.round(performance.now() - t0);
      clearTimeout(deadline);

      let body = null;
      try {
        body = JSON.parse(rawText);
      } catch {
        body = null;
      }

      if (!res.ok) {
        const apiMsg = body && body.error ? body.error.message : rawText.slice(0, 200);
        lastError = `HTTP ${res.status}: ${apiMsg}`;
        const record = {
          tag, attempt, httpStatus: res.status, latencyMs,
          usage: null, ok: false, error: lastError,
          content: null, reasoningContent: null, finishReason: null,
        };
        callLedger.push(record);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt <= CONFIG.httpRetries) {
          await sleep(CONFIG.retryBackoffMs[Math.min(attempt - 1, CONFIG.retryBackoffMs.length - 1)]);
          continue;
        }
        return record;
      }

      const choice = (body.choices || [])[0] || {};
      const message = choice.message || {};
      const usage = body.usage || {};
      const record = {
        tag,
        attempt,
        httpStatus: res.status,
        latencyMs,
        ok: true,
        error: null,
        content: message.content ?? null,
        reasoningContent: message.reasoning_content ?? null,
        finishReason: choice.finish_reason ?? null,
        model: body.model || CONFIG.model,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        },
      };
      callLedger.push(record);

      // Reasoning models can exhaust max_tokens before emitting content; give
      // the same request one enlarged-budget rebroadcast before giving up.
      if ((!record.content || record.content.trim() === "") && record.finishReason === "length" && !opts.enlarged) {
        return callMimoModel(messages, temperature, systemPrompt, {
          ...opts,
          maxTokens: Math.min(maxTokens * 2, 16384),
          enlarged: true,
          tag: `${tag}(enlarged)`,
        });
      }
      return record;
    } catch (err) {
      clearTimeout(deadline);
      const latencyMs = Math.round(performance.now() - t0);
      lastError = err.name === "AbortError" ? `timeout after ${CONFIG.requestTimeoutMs}ms` : String(err.message || err);
      const record = {
        tag, attempt, httpStatus: 0, latencyMs,
        usage: null, ok: false, error: lastError,
        content: null, reasoningContent: null, finishReason: null,
      };
      callLedger.push(record);
      if (attempt <= CONFIG.httpRetries) {
        await sleep(CONFIG.retryBackoffMs[Math.min(attempt - 1, CONFIG.retryBackoffMs.length - 1)]);
        continue;
      }
      return record;
    }
  }
  return {
    tag: opts.tag || "call", attempt, httpStatus: 0, latencyMs: 0,
    usage: null, ok: false, error: lastError,
    content: null, reasoningContent: null, finishReason: null,
  };
}

function sumUsage(records) {
  return records.reduce(
    (acc, r) => {
      if (r && r.usage) {
        acc.prompt += r.usage.promptTokens;
        acc.completion += r.usage.completionTokens;
        acc.reasoning += r.usage.reasoningTokens;
        acc.calls += 1;
      }
      return acc;
    },
    { prompt: 0, completion: 0, reasoning: 0, calls: 0 },
  );
}

function meanLatencyMs(records) {
  const ok = records.filter((r) => r && r.usage);
  if (ok.length === 0) return 0;
  return Math.round(ok.reduce((a, r) => a + r.latencyMs, 0) / ok.length);
}

// ---------------------------------------------------------------------------
// Response parsing (robust fenced-block / JSON extraction)
// ---------------------------------------------------------------------------

function extractFileMap(text) {
  const files = new Map();
  const re = /###\s*FILE:\s*([^\s`*]+)[^\n]*\n```[a-zA-Z0-9]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    files.set(m[1].trim(), m[2].replace(/\n$/, ""));
  }
  if (files.size > 0) return { files, single: null };
  const fence = text.match(/```[a-zA-Z0-9]*\n([\s\S]*?)```/);
  if (fence) return { files: null, single: fence[1].replace(/\n$/, "") };
  return { files: null, single: text.trim() };
}

function extractJson(text) {
  if (!text) return null;
  const direct = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidates = [];
  if (direct) candidates.push(direct[1]);
  candidates.push(text);
  for (const cand of candidates) {
    try {
      return JSON.parse(cand.trim());
    } catch {
      /* fall through to balanced scan */
    }
  }
  // Balanced scan for the first [...] or {...} block, string-aware.
  for (const open of ["[", "{"]) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth += 1;
      const close = open === "[" ? "]" : "}";
      if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workspace isolation + real process execution
// ---------------------------------------------------------------------------

const CHILD_ENV = sanitizeChildEnv();

function mkDir(ws, rel) {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

function writeWorkspaceFiles(ws, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(mkDir(ws, rel), content, "utf8");
  }
}

// The fixture test suite is an immutable specification for BOTH arms: neither
// track may modify it (the boost arm's synthesized test lands in a NEW file,
// test/synth.test.mjs). Captured right after fixture() and restored before
// every test run so ground truth can never drift via model writes.
function captureFixtureTests(ws, task) {
  const map = new Map();
  for (const rel of task.testFiles) {
    const abs = path.join(ws, rel);
    if (fs.existsSync(abs)) map.set(rel, fs.readFileSync(abs, "utf8"));
  }
  return map;
}

function restoreFixtureTests(ws, fixtureTests) {
  let restored = 0;
  for (const [rel, content] of fixtureTests) {
    const abs = path.join(ws, rel);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== content) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      restored += 1;
    }
  }
  return restored;
}

function runNodeTest(ws, testDir = null) {
  const t0 = performance.now();
  // Bare `node --test` auto-discovers *.test.mjs under the workspace cwd.
  // (On Node 22, `node --test <dir>` treats the dir as a literal module path.)
  const res = spawnSync(process.execPath, ["--test"], {
    cwd: ws,
    encoding: "utf8",
    env: CHILD_ENV,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  const durationMs = Math.round(performance.now() - t0);
  return {
    exitCode: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    durationMs,
  };
}

function parseTestOutcome(run) {
  const text = `${run.stdout}\n${run.stderr}`;
  let passCount = null;
  let failCount = null;
  const specPass = text.match(/ℹ pass\s+(\d+)/);
  const specFail = text.match(/ℹ fail\s+(\d+)/);
  if (specPass) passCount = parseInt(specPass[1], 10);
  if (specFail) failCount = parseInt(specFail[1], 10);
  if (passCount === null || failCount === null) {
    // TAP fallback: ok / not ok lines
    const oks = (text.match(/^ok \d+/gm) || []).length;
    const notOks = (text.match(/^not ok \d+/gm) || []).length;
    if (passCount === null) passCount = oks;
    if (failCount === null) failCount = notOks;
  }
  const failingNames = [];
  const passingNames = [];
  const specFailName = /^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/gm;
  let m;
  while ((m = specFailName.exec(text)) !== null) {
    const name = m[1].trim();
    if (name && !failingNames.includes(name)) failingNames.push(name);
  }
  const specPassName = /^✔\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/gm;
  while ((m = specPassName.exec(text)) !== null) {
    const name = m[1].trim();
    if (name && !name.startsWith("▶") && !passingNames.includes(name)) passingNames.push(name);
  }
  if (failingNames.length === 0) {
    const tapFail = /^not ok \d+ - (.+)$/gm;
    while ((m = tapFail.exec(text)) !== null) {
      const name = m[1].trim();
      if (name && !failingNames.includes(name)) failingNames.push(name);
    }
  }
  if (passingNames.length === 0) {
    const tapPass = /^ok \d+ - (.+)$/gm;
    while ((m = tapPass.exec(text)) !== null) {
      const name = m[1].trim();
      if (name && !passingNames.includes(name)) passingNames.push(name);
    }
  }
  const tail = text.trim().split("\n").slice(-25).join("\n");
  return { passCount, failCount, failingNames, passingNames, tail, raw: text };
}

function gitExec(ws, args) {
  const res = spawnSync("git", args, {
    cwd: ws,
    encoding: "utf8",
    env: CHILD_ENV,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { code: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

function gitInitFixture(ws) {
  gitExec(ws, ["init", "-q", "-b", "main"]);
  gitExec(ws, ["config", "user.email", "bench@agent-boost.local"]);
  gitExec(ws, ["config", "user.name", "agent-boost-live-bench"]);
  gitExec(ws, ["add", "-A"]);
  gitExec(ws, ["commit", "-q", "-m", "fixture checkpoint"]);
  const sha = gitExec(ws, ["rev-parse", "HEAD"]).out.trim();
  return sha;
}

function gitCommitAll(ws, message) {
  gitExec(ws, ["add", "-A"]);
  gitExec(ws, ["commit", "-q", "-m", message]);
  return gitExec(ws, ["rev-parse", "HEAD"]).out.trim();
}

function gitResetHard(ws, sha) {
  return gitExec(ws, ["reset", "--hard", sha]);
}

function gitReflog(ws) {
  return gitExec(ws, ["reflog"]).out.trim().split("\n").filter(Boolean);
}

function gitDiffSince(ws, fixtureSha) {
  gitExec(ws, ["add", "-A"]); // include untracked files in the diff
  const stat = gitExec(ws, ["diff", "--cached", "--stat", fixtureSha]).out.trim();
  const full = gitExec(ws, ["diff", "--cached", fixtureSha]).out;
  return { stat, full: full.length > 6000 ? `${full.slice(0, 6000)}\n… (truncated)` : full };
}

// ---------------------------------------------------------------------------
// Prompt contracts shared by both arms
// ---------------------------------------------------------------------------

const ENGINEER_SYSTEM =
  "You are a senior software engineer. Follow the user's output-format contract exactly. " +
  "Never add commentary outside the requested format.";

const FILE_FORMAT_CONTRACT =
  "Output format contract — for every file you create or modify output exactly:\n" +
  "### FILE: <repository-relative-path>\n" +
  "```javascript\n<complete final file content>\n```\n" +
  "Rules: emit full file contents (never diffs), keep every file's header comment, " +
  "and output nothing outside ### FILE blocks.";

function fileContext(ws, relFiles) {
  return relFiles
    .map((rel) => {
      const abs = path.join(ws, rel);
      const content = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "(file does not exist yet)";
      return `--- ${rel} ---\n${content}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Judge (agent-as-a-judge) — identical prompt for both arms
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM =
  "You are an independent code reviewer. Judge only what the evidence shows. " +
  "Respond with a JSON array and nothing else.";

function buildJudgeMessages(task, diff, testOutcome) {
  const findingsInstruction =
    "Score the change against six criteria and report defects as findings. " +
    'Each finding: {"what": string, "evidence": string (file:line or test name), ' +
    '"severity": "low"|"medium"|"high", "status": "verified", ' +
    '"criterion": one of "delivery"|"conformance"|"fidelity"|"internal_consistency"|"operational_fitness"|"finish"}.\n' +
    "delivery = requested behavior missing; conformance = contract/schema drift; fidelity = unverified or false claims; " +
    "internal_consistency = broken imports/types; operational_fitness = crashes/test failures; finish = stubs/TODOs.\n" +
    "Report ONLY real defects visible in the diff or test output. If the change is clean, return [].\n" +
    "Output ONE ```json block containing the array.";
  const testSummary =
    `Final test run exit code: ${testOutcome.exitCode}\n` +
    `Parsed: pass=${testOutcome.parsed.passCount} fail=${testOutcome.parsed.failCount}\n` +
    (testOutcome.parsed.failingNames.length > 0
      ? `Failing tests: ${testOutcome.parsed.failingNames.join("; ")}\n`
      : "") +
    `Output tail:\n${testOutcome.parsed.tail}`;
  return [
    {
      role: "user",
      content:
        `Task brief:\n${task.brief}\n\n` +
        `Diff of the delivered change (vs. the original fixture commit):\n${diff.full || "(no changes)"}\n\n` +
        `${testSummary}\n\n${findingsInstruction}`,
    },
  ];
}

function normalizeFinding(f) {
  if (!f || typeof f !== "object") return null;
  const what = typeof f.what === "string" && f.what.trim() ? f.what.trim() : null;
  if (!what) return null;
  const sev = String(f.severity || "medium").toLowerCase();
  const severity = ["low", "medium", "high"].includes(sev) ? sev : "medium";
  const crit = String(f.criterion || "").toLowerCase();
  const criterion = [
    "delivery", "conformance", "fidelity",
    "internal_consistency", "operational_fitness", "finish",
  ].find((c) => crit.includes(c)) || "operational_fitness";
  return {
    what,
    evidence: String(f.evidence || "diff").slice(0, 200),
    severity,
    status: "verified",
    criterion,
  };
}

async function judgeArm(task, ws, fixtureSha, testRun, tag) {
  const diff = gitDiffSince(ws, fixtureSha);
  const parsed = parseTestOutcome(testRun);
  const call = await callMimoModel(
    buildJudgeMessages(task, diff, { exitCode: testRun.exitCode, parsed }),
    CONFIG.temperature,
    JUDGE_SYSTEM,
    { maxTokens: CONFIG.judgeMaxTokens, tag: `${tag}:judge` },
  );
  let findings = null;
  let source = "model";
  if (call.ok && call.content) {
    const parsedJson = extractJson(call.content);
    if (Array.isArray(parsedJson)) {
      findings = parsedJson.map(normalizeFinding).filter(Boolean);
    }
  }
  if (findings === null) {
    // Deterministic fallback so scoring never depends on JSON formatting luck.
    source = "fallback";
    findings =
      parsed.failCount > 0
        ? [
            { what: `Final test run fails ${parsed.failCount} test(s): ${parsed.failingNames.join("; ")}`, evidence: "node --test", severity: "high", status: "verified", criterion: "operational_fitness" },
          ]
        : [];
  }
  const yardstick = calculateYardstickScore(findings);
  return { yardstick, findings, judgeCall: call, judgeSource: source, diff };
}

// ---------------------------------------------------------------------------
// Track A — Solo (bare model, no toolchain)
// ---------------------------------------------------------------------------

async function runSoloArm(task, ws, log, fixtureTests) {
  const records = [];
  const t0 = performance.now();
  const fixtureSha = gitInitFixture(ws);
  let attempts = 0;
  let lastRun = null;

  if (task.scenario === "parallel-race") {
    // Uncoordinated parallel subagents, mirroring a bare multi-agent harness:
    // two live calls in flight, shared entrypoint file, last write wins.
    for (let round = 1; round <= CONFIG.soloMaxAttempts; round++) {
      attempts = round;
      const feedback =
        lastRun && lastRun.parsed.failCount > 0
          ? `\nPrevious integration attempt failed ${lastRun.parsed.failCount} test(s): ` +
            `${lastRun.parsed.failingNames.join("; ")}\nTest output tail:\n${lastRun.parsed.tail}\n`
          : "";
      const subagentPrompts = task.soloSubagents.map((sub) =>
        callMimoModel(
          [
            {
              role: "user",
              content:
                `${task.brief}\n${feedback}` +
                `\nYou are subagent "${sub.name}" of an uncoordinated parallel team. ` +
                `Implement ONLY your subtask:\n${sub.scope}\n` +
                `Another subagent works on the other subtask in parallel and you cannot see its output.\n\n` +
                `Current shared file:\n${fileContext(ws, sub.sharedFiles)}\n\n` +
                `${FILE_FORMAT_CONTRACT}`,
            },
          ],
          CONFIG.temperature,
          ENGINEER_SYSTEM,
          { tag: `solo:${task.id}:sub-${sub.name}:r${round}` },
        ),
      );
      const settled = await Promise.all(subagentPrompts);
      records.push(...settled);
      // Apply writes in completion order: whichever call settles last wins the
      // shared file — the literal last-write-wins race.
      for (const call of settled) {
        if (!call.ok || !call.content) continue;
        const { files, single } = extractFileMap(call.content);
        const sub = task.soloSubagents.find((s) => call.tag.includes(`sub-${s.name}`)) || task.soloSubagents[0];
        if (files && files.size > 0) {
          for (const [rel, content] of files) {
            if (sub.allowedFiles.includes(rel)) writeWorkspaceFiles(ws, { [rel]: content });
          }
        } else if (single && sub.allowedFiles.length === 1) {
          writeWorkspaceFiles(ws, { [sub.allowedFiles[0]]: single });
        }
      }
      const nRestored = restoreFixtureTests(ws, fixtureTests);
      if (nRestored > 0) log(`    [harness] immutable test suite restored (${nRestored} file(s) rewritten to fixture spec)`);
      lastRun = runNodeTest(ws);
      lastRun.parsed = parseTestOutcome(lastRun);
      log(
        `    [solo race r${round}] exit=${lastRun.exitCode} pass=${lastRun.parsed.passCount} fail=${lastRun.parsed.failCount}`,
      );
      if (lastRun.exitCode === 0) break;
    }
  } else {
    const editable = task.sourceFiles;
    for (let round = 1; round <= CONFIG.soloMaxAttempts; round++) {
      attempts = round;
      const feedback =
        lastRun && lastRun.exitCode !== 0
          ? `\nThe test suite failed (exit ${lastRun.exitCode}). Failing tests: ` +
            `${lastRun.parsed.failingNames.join("; ")}\nTest output tail:\n${lastRun.parsed.tail}\n` +
            `Rewrite the file(s) so ALL tests pass.\n`
          : "";
      const call = await callMimoModel(
        [
          {
            role: "user",
            content:
              `${task.brief}\n\nCurrent repository files you may edit:\n${fileContext(ws, editable)}\n` +
              `${task.soloSeesTests ? `Test files (already on disk, do not modify them):\n${fileContext(ws, task.testFiles)}\n` : ""}` +
              `${feedback}${FILE_FORMAT_CONTRACT}`,
          },
        ],
        CONFIG.temperature,
        ENGINEER_SYSTEM,
        { tag: `solo:${task.id}:impl:r${round}` },
      );
      records.push(call);
      if (!call.ok || !call.content) break;
      const { files, single } = extractFileMap(call.content);
      if (files && files.size > 0) {
        for (const [rel, content] of files) {
          if (editable.includes(rel)) writeWorkspaceFiles(ws, { [rel]: content });
        }
      } else if (single && editable.length === 1) {
        writeWorkspaceFiles(ws, { [editable[0]]: single });
      }
      const nRestored = restoreFixtureTests(ws, fixtureTests);
      if (nRestored > 0) log(`    [harness] immutable test suite restored (${nRestored} file(s) rewritten to fixture spec)`);
      lastRun = runNodeTest(ws);
      lastRun.parsed = parseTestOutcome(lastRun);
      log(
        `    [solo r${round}] exit=${lastRun.exitCode} pass=${lastRun.parsed.passCount} fail=${lastRun.parsed.failCount}`,
      );
      if (lastRun.exitCode === 0) break;
      if (!task.fixtureHasTests) break; // no verify command: solo has nothing to run
    }
    if (!task.fixtureHasTests) {
      // verifyCommand: null — the solo agent declares completion with no
      // executable check; lastRun stays null until ground truth is appended.
      lastRun = null;
    }
  }

  const wallMs = Math.round(performance.now() - t0);
  return {
    arm: "solo",
    fixtureSha,
    records,
    attempts,
    finalRun: lastRun,
    wallMs,
    usage: sumUsage(records),
    meanLatencyMs: meanLatencyMs(records),
  };
}

// ---------------------------------------------------------------------------
// Track B — Boost (same model driving the five-phase toolchain)
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM =
  "You are the planning phase of an engineering workflow. Output only the requested JSON.";

async function boostPhase1Plan(task, ws, records, log) {
  const complexity = evaluateTaskComplexity(task.brief, task.plannerContext || "", task.sourceFiles.length);
  const planCall = await callMimoModel(
    [
      {
        role: "user",
        content:
          `Decompose this task into parallel code workstreams. Each workstream declares the exact ` +
          `files it will create or modify (targetFiles, repository-relative).\n\n` +
          `Task:\n${task.brief}\n\nRepository files:\n${task.sourceFiles.join("\n")}\n\n` +
          "Output ONE ```json block containing exactly: " +
          `[{"title": "...", "targetFiles": ["..."]}]`,
      },
    ],
    CONFIG.temperature,
    PLANNER_SYSTEM,
    { maxTokens: CONFIG.plannerMaxTokens, tag: `boost:${task.id}:plan` },
  );
  records.push(planCall);
  // Normalization applied to EVERY plan source (initial plan and replan
  // candidates alike): strip test files (the suite is an immutable
  // specification), restrict ownership to fixture-known code paths, and fall
  // back to the task's source files. Prevents workstreams from owning or
  // creating stray test files that would pollute ground-truth discovery.
  const known = new Set([...task.sourceFiles, ...(task.assemblyFiles || [])]);
  const planCounters = { strippedTestPaths: 0 };
  const normalizePlan = (list) => {
    for (const w of list) {
      w.targetFiles = w.targetFiles
        .map((f) => String(f).replace(/^\.?\//, "").trim())
        .filter((f) => {
          if (task.testFiles.includes(f) || f.startsWith("test/")) {
            planCounters.strippedTestPaths += 1;
            return false;
          }
          return true;
        })
        .filter((f) => known.has(f) || task.sourceFiles.some((s) => f.endsWith(path.basename(s))));
      if (w.targetFiles.length === 0) w.targetFiles = [...task.sourceFiles];
    }
    return list;
  };
  const parsePlanList = (text) => {
    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) return null;
    const list = parsed
      .filter((w) => w && typeof w.title === "string" && Array.isArray(w.targetFiles))
      .map((w) => ({ title: w.title, kind: "code", targetFiles: w.targetFiles.map(String) }));
    return list.length > 0 ? list : null;
  };

  let workstreams = planCall.ok && planCall.content ? parsePlanList(planCall.content) : null;
  if (!workstreams) {
    // Deterministic fallback plan: one workstream per source file group.
    workstreams = [{ title: `Implement ${task.id}`, kind: "code", targetFiles: [...task.sourceFiles] }];
  }
  normalizePlan(workstreams);
  if (planCounters.strippedTestPaths > 0) {
    log(`    [boost P1] ownership gate: stripped ${planCounters.strippedTestPaths} test-file declaration(s) (suite is immutable)`);
  }

  let conflicts = detectTargetFileConflicts(workstreams);
  let conflictsIntercepted = 0;
  let replanned = false;
  if (conflicts.length > 0) {
    conflictsIntercepted = conflicts.length;
    const replanCall = await callMimoModel(
      [
        {
          role: "user",
          content:
            `Your workstream plan has overlapping targetFiles — parallel writes to the same file ` +
            `clobber each other:\n${JSON.stringify(conflicts, null, 2)}\n\n` +
            `Re-partition into DISJOINT workstreams with single file ownership; move shared ` +
            `entrypoint wiring into its own assembly workstream.\n\n` +
            "Output ONE ```json block: " +
            `[{"title": "...", "targetFiles": ["..."]}]`,
        },
      ],
      CONFIG.temperature,
      PLANNER_SYSTEM,
      { maxTokens: CONFIG.plannerMaxTokens, tag: `boost:${task.id}:replan` },
    );
    records.push(replanCall);
    if (replanCall.ok && replanCall.content) {
      const candidate = parsePlanList(replanCall.content);
      if (candidate && detectTargetFileConflicts(normalizePlan(candidate)).length === 0) {
        workstreams = candidate;
        replanned = true;
      }
    }
    if (!replanned) {
      // Deterministic decoupling: one workstream per file (single ownership).
      const byFile = new Map();
      for (const w of workstreams) for (const f of w.targetFiles) byFile.set(f, w.title);
      workstreams = [...byFile.entries()].map(([f, title]) => ({
        title: `${title} (${f})`,
        kind: "code",
        targetFiles: [f],
      }));
      replanned = true;
    }
    const resolved = detectTargetFileConflicts(workstreams);
    log(
      `    [boost P1] conflict gate: intercepted ${conflictsIntercepted} overlap(s), ` +
        `decoupled into ${workstreams.length} disjoint workstream(s) (residual conflicts: ${resolved.length})`,
    );
  } else {
    log(`    [boost P1] conflict gate: 0 overlaps across ${workstreams.length} workstream(s)`);
  }
  return { workstreams, complexity, conflictsIntercepted };
}

async function boostPhase2Execute(task, ws, workstreams, records, maxTokens = CONFIG.maxTokens) {
  const ownership = new Map();
  for (const w of workstreams) for (const f of w.targetFiles) ownership.set(f, w.title);
  const interfaceContracts = (task.contracts || [])
    .map((c) => `${c.module}: ${c.api}`)
    .join("\n");
  for (const w of workstreams) {
    const call = await callMimoModel(
      [
        {
          role: "user",
          content:
            `Workstream "${w.title}" — you own ONLY these files: ${w.targetFiles.join(", ")}.\n` +
            `Other workstreams own every other file; do not modify anything outside your ownership.\n\n` +
            `KEEP_BASE discipline: if a file you own already exists and satisfies its interface ` +
            `contract, output it UNCHANGED. The repository is dependency-free — do not import ` +
            `any npm package.\n\n` +
            `Task:\n${task.brief}\n\n` +
            (interfaceContracts ? `Interface contracts of modules owned by other workstreams:\n${interfaceContracts}\n\n` : "") +
            `Current content of files you own:\n${fileContext(ws, w.targetFiles)}\n\n` +
            `${FILE_FORMAT_CONTRACT}`,
        },
      ],
      CONFIG.temperature,
      ENGINEER_SYSTEM,
      { tag: `boost:${task.id}:exec:${w.title}`, maxTokens },
    );
    records.push(call);
    if (!call.ok || !call.content) continue;
    const { files, single } = extractFileMap(call.content);
    if (files && files.size > 0) {
      for (const [rel, content] of files) {
        if (w.targetFiles.includes(rel)) writeWorkspaceFiles(ws, { [rel]: content });
      }
    } else if (single && w.targetFiles.length === 1) {
      writeWorkspaceFiles(ws, { [w.targetFiles[0]]: single });
    }
  }
}

async function boostPhase3VerifyAndRepair(task, ws, complexity, records, log, fixtureTests, fixtureSha, baselinePassingNames, mutableFiles, maxTokens = CONFIG.maxTokens) {
  const events = { rollbacks: 0, rollbackEvidence: [], synthUsed: false, repairRounds: 0, signatureShifts: 0 };
  const maxRounds = Math.max(1, complexity.maxRepairRounds);
  // LATS checkpoint semantics: the pristine fixture is the last known-good
  // state; checkpointSha advances only through states that did NOT regress a
  // baseline-passing test. A regressing candidate is discarded via a real
  // `git reset --hard` back to the last accepted checkpoint.
  let checkpointSha = fixtureSha;
  const isBaselineRegression = (parsed) =>
    (parsed.failingNames || []).some((n) => baselinePassingNames.includes(n));
  const restoreSuite = () => {
    const restored = restoreFixtureTests(ws, fixtureTests);
    let purged = 0;
    const testDir = path.join(ws, "test");
    if (fs.existsSync(testDir)) {
      for (const name of fs.readdirSync(testDir)) {
        const rel = `test/${name}`;
        if (
          /\.(test|spec)\.(js|mjs|cjs)$/.test(name) &&
          !fixtureTests.has(rel) &&
          rel !== "test/synth.test.mjs"
        ) {
          fs.rmSync(path.join(testDir, name), { force: true });
          purged += 1;
        }
      }
    }
    if (restored > 0 || purged > 0) {
      log(`    [harness] immutable test suite enforced: ${restored} file(s) restored, ${purged} stray test file(s) removed`);
    }
  };
  const advanceCheckpoint = (parsed) => {
    if (!isBaselineRegression(parsed)) {
      checkpointSha = gitCommitAll(ws, "boost: state accepted (no baseline regression)");
    }
  };

  // verifyCommand: null -> verify_synth.sh reproduction-test synthesis.
  // The synthesized file is syntax-validated (`node --check`); a truncated
  // generation gets ONE re-synthesis at doubled budget. A still-invalid file
  // is discarded (never shipped broken) and the arm proceeds unverified.
  if (!task.fixtureHasTests) {
    const synthAbs = path.join(ws, "test", "synth.test.mjs");
    for (let synthAttempt = 1; synthAttempt <= 2; synthAttempt++) {
      const synthCall = await callMimoModel(
        [
          {
            role: "user",
            content:
              `No verify command is configured for this repository (verifyCommand: null). ` +
              `Synthesize a deterministic reproduction test that encodes the acceptance criteria.\n\n` +
              `Task:\n${task.brief}\n\nCurrent implementation:\n${fileContext(ws, task.sourceFiles)}\n\n` +
              `Write a node:test file at test/synth.test.mjs using node:test + node:assert/strict. ` +
              `Import the module by relative path. Cover every behavior the brief states, including edge cases.\n` +
              (synthAttempt === 2
                ? `IMPORTANT: your previous attempt was TRUNCATED and syntactically invalid. ` +
                  `Emit a COMPLETE file under 150 lines. No prose, no commentary.\n`
                : "") +
              `### FILE: test/synth.test.mjs\n\`\`\`javascript\n<test file content>\n\`\`\``,
          },
        ],
        CONFIG.temperature,
        ENGINEER_SYSTEM,
        {
          maxTokens: synthAttempt === 1 ? CONFIG.maxTokens : Math.min(CONFIG.maxTokens * 2, 16384),
          tag: `boost:${task.id}:synth${synthAttempt === 2 ? ":retry" : ""}`,
        },
      );
      records.push(synthCall);
      if (!synthCall.ok || !synthCall.content) continue;
      const { files, single } = extractFileMap(synthCall.content);
      const content = files ? files.get("test/synth.test.mjs") : single;
      if (!content) continue;
      writeWorkspaceFiles(ws, { "test/synth.test.mjs": content });
      const check = spawnSync(process.execPath, ["--check", synthAbs], {
        encoding: "utf8", env: CHILD_ENV,
      });
      if (check.status === 0) {
        events.synthUsed = true;
        log(`    [boost P3] verifyCommand null -> synthesized test/synth.test.mjs (syntax-validated, verify_synth.sh path)`);
        break;
      }
      const reason = String(check.stderr || "").split("\n").filter(Boolean).slice(-1)[0] || "syntax error";
      log(`    [boost P3] synthesized test invalid (${reason})${synthAttempt === 1 ? " -> re-synthesizing at doubled budget" : " -> discarding broken verify script (arm proceeds unverified)"}`);
      fs.rmSync(synthAbs, { force: true });
    }
  }

  restoreSuite();
  let run = runNodeTest(ws);
  let parsed = parseTestOutcome(run);
  log(
    `    [boost P3] verify: exit=${run.exitCode} pass=${parsed.passCount} fail=${parsed.failCount}`,
  );
  if (run.exitCode === 0) return { run, events };
  advanceCheckpoint(parsed);

  let lastSignature = computeFailureSignature(parsed.tail);
  for (let round = 1; round <= maxRounds && run.exitCode !== 0; round++) {
    events.repairRounds = round;
    const regressed = isBaselineRegression(parsed);
    let repairPrefix = "";
    if (regressed) {
      // Baseline regression: discard the poisoned state via a REAL hard reset.
      const resetRes = gitResetHard(ws, checkpointSha);
      const reflogLine = gitReflog(ws).find((l) => l.includes("reset")) || "";
      events.rollbacks += 1;
      events.rollbackEvidence.push(reflogLine.slice(0, 120));
      log(
        `    [boost P3] baseline regression (fail=${parsed.failCount}) -> git reset --hard ${checkpointSha.slice(0, 8)} ${resetRes.code === 0 ? "OK" : "FAILED"}`,
      );
      const newSig = computeFailureSignature(parsed.tail);
      if (newSig !== lastSignature) {
        events.signatureShifts += 1;
        lastSignature = newSig;
      }
      repairPrefix =
        `Your change REGRESSED previously passing tests (failure signature ${lastSignature}). ` +
        `The repository was rolled back to the last green checkpoint (git reset --hard). ` +
        `Diagnose the root cause first, then apply a scoped fix that satisfies the new tests ` +
        `WITHOUT breaking baseline tests.\n\n`;
    }
    const repairCall = await callMimoModel(
      [
        {
          role: "user",
          content:
            `${repairPrefix}Failing tests: ${parsed.failingNames.join("; ") || "unknown"}\n` +
            `Test output tail:\n${parsed.tail}\n\n` +
            `Task:\n${task.brief}\n\nCurrent files (you may modify any of them; the repository is dependency-free):\n${fileContext(ws, mutableFiles)}\n\n` +
            `${FILE_FORMAT_CONTRACT}`,
        },
      ],
      CONFIG.temperature,
      ENGINEER_SYSTEM,
      { tag: `boost:${task.id}:repair:r${round}`, maxTokens },
    );
    records.push(repairCall);
    if (!repairCall.ok || !repairCall.content) break;
    const { files, single } = extractFileMap(repairCall.content);
    if (files && files.size > 0) {
      for (const [rel, content] of files) {
        if (mutableFiles.includes(rel)) writeWorkspaceFiles(ws, { [rel]: content });
      }
    } else if (single && mutableFiles.length === 1) {
      writeWorkspaceFiles(ws, { [mutableFiles[0]]: single });
    }
    restoreSuite();
    run = runNodeTest(ws);
    parsed = parseTestOutcome(run);
    log(
      `    [boost P3] repair r${round}: exit=${run.exitCode} pass=${parsed.passCount} fail=${parsed.failCount}`,
    );
    if (run.exitCode !== 0) advanceCheckpoint(parsed);
  }
  return { run, events };
}

async function runBoostArm(task, ws, experienceStore, log, fixtureTests, baselinePassingNames) {
  const records = [];
  const t0 = performance.now();
  const fixtureSha = gitInitFixture(ws);
  const events = {
    conflictsIntercepted: 0,
    rollbacks: 0,
    rollbackEvidence: [],
    synthUsed: false,
    repairRounds: 0,
    signatureShifts: 0,
    recalledCues: 0,
  };

  // Phase 1 — complexity tier + experience recall + planner + conflict gate
  const recalled = matchExperienceCues(experienceStore.content, task.brief, 2);
  events.recalledCues = recalled ? (recalled.match(/<experience>/g) || []).length : 0;
  if (events.recalledCues > 0) {
    log(`    [boost P1] recalled ${events.recalledCues} experience cue(s) from earlier tasks`);
  }
  const plan = await boostPhase1Plan(task, ws, records, log);
  events.conflictsIntercepted = plan.conflictsIntercepted;
  const maxTokens = TIER_TOKEN_BUDGETS[plan.complexity.complexity] || CONFIG.maxTokens;

  // Phase 2 — disjoint-ownership execution with adaptive token budget (Option B)
  await boostPhase2Execute(task, ws, plan.workstreams, records, maxTokens);

  // Phase 3 — checkpoint, real tests, signature-scoped repair with rollback.
  // Repair scope covers every file a workstream owns (not just sourceFiles) —
  // a broken workstream output must stay reachable for the repair loop.
  const mutableFiles = [
    ...new Set([...task.sourceFiles, ...plan.workstreams.flatMap((w) => w.targetFiles)]),
  ];
  const verified = await boostPhase3VerifyAndRepair(
    task, ws, plan.complexity, records, log, fixtureTests, fixtureSha, baselinePassingNames, mutableFiles, maxTokens,
  );
  events.rollbacks = verified.events.rollbacks;
  events.rollbackEvidence = verified.events.rollbackEvidence;
  events.synthUsed = verified.events.synthUsed;
  events.repairRounds = verified.events.repairRounds;
  events.signatureShifts = verified.events.signatureShifts;

  let finalRun = verified.run;
  if (!task.fixtureHasTests) {
    finalRun = null; // ground truth appended later (hidden post test)
  }

  const wallMsSoFar = Math.round(performance.now() - t0);
  return {
    arm: "boost",
    fixtureSha,
    records,
    complexity: plan.complexity,
    tokenBudget: maxTokens, // adaptive tier budget (Option B) applied to exec/repair calls
    workstreams: plan.workstreams,
    events,
    finalRun,
    wallMs: wallMsSoFar,
    usage: sumUsage(records),
    meanLatencyMs: meanLatencyMs(records),
  };
}

// Phase 5 — experience reflection (deterministic lesson from what the run did)
function buildExperienceForTask(task, boostResult, groundGreen) {
  const happened = [];
  if (boostResult.events.conflictsIntercepted > 0) happened.push("target-file conflict intercepted and decoupled at planning time");
  if (boostResult.events.rollbacks > 0) happened.push("baseline regression discarded via git checkpoint + reset --hard, scoped re-fix applied");
  if (boostResult.events.synthUsed) happened.push("missing verify command replaced by synthesized reproduction test before delivery");
  if (boostResult.events.repairRounds > 0 && boostResult.events.rollbacks === 0) happened.push("failing tests repaired with failure-output feedback");
  if (happened.length === 0) happened.push("first-pass plan converged without repair");
  return formatExperienceEntry({
    cue: `${task.id} ${task.experienceKeywords}`,
    lesson: happened.join("; "),
    dimension: task.experienceDimension,
    verdict: groundGreen ? "helped" : "no_observed_effect",
    confidence: groundGreen && boostResult.events.rollbacks + boostResult.events.conflictsIntercepted > 0 ? "high" : "medium",
    evidence: `${task.id} live run, exit ${boostResult.finalRun ? boostResult.finalRun.exitCode : "n/a"}`,
  });
}

// ---------------------------------------------------------------------------
// Live task definitions (five scenarios; fixtures are real executable code)
// ---------------------------------------------------------------------------

const PKG_JSON = JSON.stringify({ name: "live-benchmark-fixture", type: "module", private: true }, null, 2) + "\n";

export const LIVE_TASKS = [
  {
    id: "LIVE-EXPRESS-RACE",
    name: "Express Gateway Route Mounting Race",
    origin: "BugsJS archetype / Express.js (live)",
    category: "Parallel Write Race",
    scenario: "parallel-race",
    experienceKeywords: "shared server entrypoint parallel route registration conflict",
    experienceDimension: "INV",
    sourceFiles: ["src/server.js"],
    testFiles: ["test/server.test.mjs"],
    assemblyFiles: ["src/server.js"],
    fixtureHasTests: true,
    expectedBaselineFails: 2,
    soloSeesTests: false,
    contracts: [
      { module: "src/routes/auth.js", api: "export function registerAuthRoutes(app) — app.mount(route)" },
      { module: "src/routes/metrics.js", api: "export function registerMetricsRoutes(app) — app.mount(route)" },
    ],
    soloSubagents: [
      {
        name: "auth-team",
        scope: "Register the OAuth2 auth routes (registerAuthRoutes) inside createApp in src/server.js.",
        sharedFiles: ["src/server.js"],
        allowedFiles: ["src/server.js"],
      },
      {
        name: "metrics-team",
        scope: "Register the metrics API routes (registerMetricsRoutes) inside createApp in src/server.js.",
        sharedFiles: ["src/server.js"],
        allowedFiles: ["src/server.js"],
      },
    ],
    brief:
      "Two feature teams extend a shared Express-style gateway in parallel.\n\n" +
      "Team A adds OAuth2 auth routes; team B adds metrics API routes. Both route modules " +
      "already exist and export registration functions (see interface contracts). The shared " +
      "entrypoint src/server.js has a route-registration area inside createApp() that is " +
      "currently empty: both teams must register their routes there. After both teams finish, " +
      "createApp() must mount /api/auth/login, /api/auth/logout, /api/metrics and " +
      "/api/metrics/summary.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/routes/auth.js":
          'export function registerAuthRoutes(app) {\n' +
          '  app.mount("/api/auth/login");\n' +
          '  app.mount("/api/auth/logout");\n' +
          "}\n",
        "src/routes/metrics.js":
          'export function registerMetricsRoutes(app) {\n' +
          '  app.mount("/api/metrics");\n' +
          '  app.mount("/api/metrics/summary");\n' +
          "}\n",
        "src/server.js":
          'import { registerAuthRoutes } from "./routes/auth.js";\n' +
          'import { registerMetricsRoutes } from "./routes/metrics.js";\n\n' +
          "export function createApp() {\n" +
          "  const mountedRoutes = [];\n" +
          "  const app = { mount: (route) => mountedRoutes.push(route) };\n" +
          "  // Route registration area — both feature teams register their routes here.\n\n" +
          "  return { app, mountedRoutes };\n" +
          "}\n",
        "test/server.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { createApp } from "../src/server.js";\n\n' +
          'test("gateway mounts OAuth2 auth routes", () => {\n' +
          "  const { mountedRoutes } = createApp();\n" +
          '  assert.ok(mountedRoutes.includes("/api/auth/login"));\n' +
          '  assert.ok(mountedRoutes.includes("/api/auth/logout"));\n' +
          "});\n\n" +
          'test("gateway mounts metrics routes", () => {\n' +
          "  const { mountedRoutes } = createApp();\n" +
          '  assert.ok(mountedRoutes.includes("/api/metrics"));\n' +
          '  assert.ok(mountedRoutes.includes("/api/metrics/summary"));\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-SEMVER-REGRESSION",
    name: "SemVer Pre-Release Hyphen Range Regression",
    origin: "SWE-bench Verified archetype / node-semver (live)",
    category: "Regression-Prone Debugging",
    scenario: "regression-rollback",
    experienceKeywords: "semver prerelease hyphen range caret regression baseline tests",
    experienceDimension: "DOM",
    sourceFiles: ["src/semver.js"],
    testFiles: ["test/semver.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix a bug in the semver range comparator module src/semver.js exporting satisfies(version, range).\n\n" +
      'Bug: satisfies("1.2.3-alpha.1", "1.2.0 - 1.2.4") must return true.\n\n' +
      "Required rule: a pre-release version satisfies a hyphen range iff its core version " +
      "(prerelease tag dropped for the bound comparison) lies within the bounds AND its " +
      "[major, minor] pair equals the [major, minor] pair of at least one bound. " +
      'Example: "1.2.6-alpha.1" in "1.1.0 - 1.3.0" is in-bounds but matches neither bound\'s ' +
      "[major, minor] pair, so it must return false.\n\n" +
      "Constraints — these existing behaviors must keep working (regressions are not acceptable):\n" +
      '  satisfies("1.2.4", "^1.2.3") === true\n' +
      '  satisfies("1.3.0", "^1.2.3") === true\n' +
      '  satisfies("2.0.0", "^1.2.3") === false\n' +
      '  satisfies("1.2.4-alpha.1", "^1.2.3") === false   // prerelease excluded from caret ranges\n' +
      '  satisfies("1.2.3", "1.2.3+build") === true        // build metadata ignored\n' +
      '  satisfies("1.2.0", "1.2.0 - 1.2.4") === true\n' +
      '  satisfies("1.2.5", "1.2.0 - 1.2.4") === false\n' +
      '  satisfies("1.3.0-alpha", "1.2.0 - 1.2.4") === false (out of bounds)',
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/semver.js":
          "function parseVersion(v) {\n" +
          '  const core = v.split("+")[0];\n' +
          '  const dashAt = core.indexOf("-");\n' +
          "  let mainPart = core;\n" +
          "  let prerelease = null;\n" +
          '  if (dashAt !== -1) {\n' +
          "    mainPart = core.slice(0, dashAt);\n" +
          "    prerelease = core.slice(dashAt + 1) || null;\n" +
          "  }\n" +
          '  const nums = mainPart.split(".").map((n) => parseInt(n, 10));\n' +
          "  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease };\n" +
          "}\n\n" +
          "function compareVersions(a, b) {\n" +
          '  for (const k of ["major", "minor", "patch"]) {\n' +
          "    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;\n" +
          "  }\n" +
          '  const ap = a.prerelease || "";\n' +
          '  const bp = b.prerelease || "";\n' +
          "  if (ap === bp) return 0;\n" +
          "  if (!ap) return 1;\n" +
          "  if (!bp) return -1;\n" +
          "  return ap < bp ? -1 : 1;\n" +
          "}\n\n" +
          "export function satisfies(version, range) {\n" +
          "  const v = parseVersion(version);\n" +
          '  const caret = range.match(/^\\^(\\d+)\\.(\\d+)\\.(\\d+)$/);\n' +
          "  if (caret) {\n" +
          "    if (v.prerelease !== null) return false;\n" +
          "    if (v.major !== +caret[1]) return false;\n" +
          "    if (v.minor > +caret[2]) return true;\n" +
          "    if (v.minor === +caret[2] && v.patch >= +caret[3]) return true;\n" +
          "    return false;\n" +
          "  }\n" +
          "  const hyphen = range.match(/^(\\S+)\\s+-\\s+(\\S+)$/);\n" +
          "  if (hyphen) {\n" +
          "    const lo = parseVersion(hyphen[1]);\n" +
          "    const hi = parseVersion(hyphen[2]);\n" +
          "    // BUG: prerelease versions are excluded from hyphen ranges entirely, so\n" +
          '    // satisfies("1.2.3-alpha.1", "1.2.0 - 1.2.4") wrongly returns false.\n' +
          "    if (v.prerelease !== null) return false;\n" +
          "    return compareVersions(v, lo) >= 0 && compareVersions(v, hi) <= 0;\n" +
          "  }\n" +
          "  const ex = parseVersion(range);\n" +
          "  return compareVersions(v, ex) === 0;\n" +
          "}\n",
        "test/semver.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { satisfies } from "../src/semver.js";\n\n' +
          'test("caret ranges keep baseline semantics", () => {\n' +
          '  assert.equal(satisfies("1.2.4", "^1.2.3"), true);\n' +
          '  assert.equal(satisfies("1.3.0", "^1.2.3"), true);\n' +
          '  assert.equal(satisfies("2.0.0", "^1.2.3"), false);\n' +
          '  assert.equal(satisfies("1.2.4-alpha.1", "^1.2.3"), false);\n' +
          "});\n\n" +
          'test("exact match ignores build metadata", () => {\n' +
          '  assert.equal(satisfies("1.2.3", "1.2.3+build"), true);\n' +
          "});\n\n" +
          'test("hyphen ranges keep baseline semantics", () => {\n' +
          '  assert.equal(satisfies("1.2.0", "1.2.0 - 1.2.4"), true);\n' +
          '  assert.equal(satisfies("1.2.5", "1.2.0 - 1.2.4"), false);\n' +
          "});\n\n" +
          'test("prerelease inside same-tuple hyphen range satisfies", () => {\n' +
          '  assert.equal(satisfies("1.2.3-alpha.1", "1.2.0 - 1.2.4"), true);\n' +
          "});\n\n" +
          'test("prerelease matching neither bound minor-pair rejected", () => {\n' +
          '  assert.equal(satisfies("1.2.6-alpha.1", "1.1.0 - 1.3.0"), false);\n' +
          "});\n\n" +
          'test("out-of-bounds prerelease rejected", () => {\n' +
          '  assert.equal(satisfies("1.3.0-alpha", "1.2.0 - 1.2.4"), false);\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-REST-SYNTH",
    name: "REST Payload Migration Without Test Command",
    origin: "SWE-bench archetype / REST migration (live)",
    category: "Unverified Synthesis",
    scenario: "test-synthesis",
    experienceKeywords: "nullable nested payload migration missing verify command synthesized test",
    experienceDimension: "INV",
    sourceFiles: ["src/transformers/v3-to-v4.js"],
    testFiles: [],
    fixtureHasTests: false,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Write the transformer in src/transformers/v3-to-v4.js exporting transformCustomer(payload) " +
      "that maps a v3 customer payload { id, billing_address: { line1, city } | null } to the v4 " +
      "shape { id, line1, city }. Legacy producers intermittently send billing_address: null; " +
      "the output must then be { id, line1: \"\", city: \"\" }.\n\n" +
      "The repository has no test command configured.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/transformers/v3-to-v4.js":
          "// v3 -> v4 customer payload transformer.\n" +
          "// NOTE: the repository has NO test command configured (verifyCommand: null).\n" +
          "export function transformCustomer(payload) {\n" +
          "  // TODO: implement the v4 mapping per the delivery brief.\n" +
          '  throw new Error("not implemented");\n' +
          "}\n",
      });
    },
    hiddenPostTest:
      "test/hidden.post.test.mjs",
    hiddenPostContent:
      'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { transformCustomer } from "../src/transformers/v3-to-v4.js";\n\n' +
      'test("maps a complete v3 payload", () => {\n' +
      '  assert.deepEqual(\n' +
      '    transformCustomer({ id: "cust_456", billing_address: { line1: "100 Main St", city: "Metropolis" } }),\n' +
      '    { id: "cust_456", line1: "100 Main St", city: "Metropolis" },\n' +
      "  );\n" +
      "});\n\n" +
      'test("null billing_address yields empty strings (legacy producer)", () => {\n' +
      '  assert.deepEqual(\n' +
      '    transformCustomer({ id: "cust_123", billing_address: null }),\n' +
      '    { id: "cust_123", line1: "", city: "" },\n' +
      "  );\n" +
      "});\n",
  },
  {
    id: "LIVE-TOKENIZER-BOUNDARY",
    name: "Streaming Tokenizer Escape Parity Across Chunk Boundary",
    origin: "HumanEval-X archetype / streaming parser (live)",
    category: "Deep Algorithmic Boundary",
    scenario: "boundary",
    experienceKeywords: "streaming tokenizer escape parity chunk boundary state machine",
    experienceDimension: "DOM",
    sourceFiles: ["src/tokenizer.js"],
    testFiles: ["test/tokenizer.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the streaming JSON tokenizer in src/tokenizer.js (createTokenizer with feed(chunk) " +
      "and isInString()).\n\n" +
      "Bug: the backslash-escape streak counter is chunk-local. When an escape sequence is split " +
      "across two feed() chunks (chunk 1 ends with a backslash, chunk 2 starts with a quote), the " +
      "streak resets to 0 at the chunk boundary, so an escaped quote is mis-tokenized as a real " +
      "string boundary. The escape-streak state must persist across chunk boundaries.\n\n" +
      "Existing single-feed behavior must keep working, including escaped-quote detection and " +
      "doubled-backslash (\\\\) handling.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/tokenizer.js":
          "// Streaming JSON tokenizer: feed() accepts arbitrary chunk boundaries.\n" +
          "export function createTokenizer() {\n" +
          "  let inString = false;\n" +
          "  const tokens = [];\n" +
          "  return {\n" +
          "    feed(chunk) {\n" +
          "      let escapeStreak = 0; // BUG: streak state is chunk-local; escapes spanning\n" +
          "      // chunk boundaries are lost, so boundary quotes are mis-tokenized.\n" +
          '      for (const ch of chunk) {\n' +
          '        if (ch === "\\\\") {\n' +
          "          escapeStreak += 1;\n" +
          "          continue;\n" +
          "        }\n" +
          '        if (ch === \'"\') {\n' +
          "          if (escapeStreak % 2 === 0) {\n" +
          "            inString = !inString;\n" +
          '            tokens.push(inString ? "STR_START" : "STR_END");\n' +
          "          } else {\n" +
          '            tokens.push("ESCAPED_QUOTE");\n' +
          "          }\n" +
          "          escapeStreak = 0;\n" +
          "          continue;\n" +
          "        }\n" +
          "        escapeStreak = 0;\n" +
          "      }\n" +
          "      return tokens;\n" +
          "    },\n" +
          "    isInString: () => inString,\n" +
          "  };\n" +
          "}\n",
        "test/tokenizer.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { createTokenizer } from "../src/tokenizer.js";\n\n' +
          'test("single-feed string tokenization keeps baseline behavior", () => {\n' +
          "  const t = createTokenizer();\n" +
          '  t.feed(\'{"a": "x"}\');\n' +
          "  const tokens = t.feed(\"\");\n" +
          '  assert.ok(tokens.includes("STR_START"));\n' +
          '  assert.ok(tokens.includes("STR_END"));\n' +
          "  assert.equal(t.isInString(), false);\n" +
          "});\n\n" +
          'test("single-feed escaped quote detection", () => {\n' +
          "  const t = createTokenizer();\n" +
          '  t.feed(\'{"a": "x\\\\"y"}\');\n' +
          '  assert.ok(t.feed("").includes("ESCAPED_QUOTE"));\n' +
          "  assert.equal(t.isInString(), false);\n" +
          "});\n\n" +
          'test("mid-string chunk split reassembles", () => {\n' +
          "  const t = createTokenizer();\n" +
          '  t.feed(\'{"a": "hel\');\n' +
          '  t.feed(\'lo"}\');\n' +
          '  const tokens = t.feed("");\n' +
          '  assert.ok(tokens.includes("STR_START"));\n' +
          '  assert.ok(tokens.includes("STR_END"));\n' +
          "  assert.equal(t.isInString(), false);\n" +
          "});\n\n" +
          'test("escape sequence split across chunk boundary", () => {\n' +
          "  const t = createTokenizer();\n" +
          "  // chunk 1 ends with a single backslash; chunk 2 starts with the quote\n" +
          '  t.feed(\'{"a": "x\\\\\');\n' +
          '  t.feed(\'"}\');\n' +
          "  const tokens = t.feed(\"\");\n" +
          '  assert.ok(tokens.includes("ESCAPED_QUOTE"));\n' +
          '  assert.equal(tokens.filter((t) => t === "STR_END").length, 1); // only the key quote — the value string stays open\n' +
          "  assert.equal(t.isInString(), true);\n" +
          "});\n\n" +
          'test("doubled backslash before boundary quote closes the string", () => {\n' +
          "  const t = createTokenizer();\n" +
          '  t.feed(\'{"a": "x\\\\\\\\\');\n' +
          '  t.feed(\'"}\');\n' +
          "  const tokens = t.feed(\"\");\n" +
          '  assert.ok(tokens.includes("STR_END"));\n' +
          "  assert.equal(t.isInString(), false);\n" +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-RATELIMIT-RACE",
    name: "Concurrent Sliding-Window Rate Limiter Race",
    origin: "HumanEval-X archetype / concurrency (live)",
    category: "Deep Algorithmic Boundary",
    scenario: "boundary",
    experienceKeywords: "sliding window rate limiter non-atomic check-then-set concurrency race",
    experienceDimension: "DOM",
    sourceFiles: ["src/limiter.js"],
    testFiles: ["test/limiter.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the sliding-window rate limiter in src/limiter.js (class SlidingWindowLimiter with an " +
      "async acquire()).\n\n" +
      "Bug: acquire() yields (await) between reading the window count and pushing into it, so a " +
      "burst of concurrent callers all observe the same stale count and over-admit: 100 " +
      "concurrent callers against a limit of 50 admit far more than 50. The check-then-set must " +
      "be atomic (complete synchronously before any await point).\n\n" +
      "Sequential semantics must keep working: the first `limit` calls return true, further " +
      "immediate calls return false, and the window slides open again once timestamps older than " +
      "windowMs are evicted (tests control the clock via the nowFn constructor argument).",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/limiter.js":
          "export class SlidingWindowLimiter {\n" +
          "  constructor(limit = 50, windowMs = 1000, nowFn = Date.now) {\n" +
          "    this.limit = limit;\n" +
          "    this.windowMs = windowMs;\n" +
          "    this.nowFn = nowFn;\n" +
          "    this.calls = [];\n" +
          "  }\n\n" +
          "  async acquire() {\n" +
          "    const now = this.nowFn();\n" +
          "    this.calls = this.calls.filter((t) => now - t < this.windowMs);\n" +
          "    const current = this.calls.length;\n" +
          "    await Promise.resolve(); // BUG: yields between check and set — concurrent callers\n" +
          "    // all read the same stale `current`, so the limit is massively over-admitted.\n" +
          "    if (current < this.limit) {\n" +
          "      this.calls.push(now);\n" +
          "      return true;\n" +
          "    }\n" +
          "    return false;\n" +
          "  }\n" +
          "}\n",
        "test/limiter.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { SlidingWindowLimiter } from "../src/limiter.js";\n\n' +
          'test("sequential admits exactly the limit", async () => {\n' +
          "  const limiter = new SlidingWindowLimiter(5, 1000, () => 0);\n" +
          "  const results = [];\n" +
          "  for (let i = 0; i < 6; i++) results.push(await limiter.acquire());\n" +
          '  assert.deepEqual(results, [true, true, true, true, true, false]);\n' +
          "});\n\n" +
          'test("window slides open after eviction", async () => {\n' +
          "  let clock = 0;\n" +
          "  const limiter = new SlidingWindowLimiter(2, 1000, () => clock);\n" +
          "  assert.equal(await limiter.acquire(), true);\n" +
          "  assert.equal(await limiter.acquire(), true);\n" +
          "  assert.equal(await limiter.acquire(), false);\n" +
          "  clock = 1001;\n" +
          "  assert.equal(await limiter.acquire(), true);\n" +
          "});\n\n" +
          'test("burst of 100 concurrent callers admits exactly the limit", async () => {\n' +
          "  const limiter = new SlidingWindowLimiter(50, 1000, () => 0);\n" +
          "  const results = await Promise.all(\n" +
          "    Array.from({ length: 100 }, () => limiter.acquire()),\n" +
          "  );\n" +
          "  const admitted = results.filter(Boolean).length;\n" +
          "  assert.equal(admitted, 50);\n" +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-DIFF-PATCH-APPLY",
    name: "Unified Diff Multi-Hunk Line Drift Patch Applicator",
    origin: "Git archetype / patch utility (live)",
    category: "Deep Algorithmic Boundary",
    scenario: "boundary",
    experienceKeywords: "unified diff multi hunk line offset drift chunk application",
    experienceDimension: "DOM",
    sourceFiles: ["src/patch.js"],
    testFiles: ["test/patch.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the unified diff patch applicator in src/patch.js (applyUnifiedDiff(originalText, diffText)).\n\n" +
      "Bug: When applying a diff containing multiple hunks (@@ -start,len +start,len @@), earlier hunks that insert " +
      "or delete lines shift line indices in the target document. The current implementation applies subsequent hunks " +
      "using the raw oldStart index from the hunk header without tracking accumulated line offset drift. This causes " +
      "subsequent hunks to replace the wrong lines on multi-hunk diffs.\n\n" +
      "Required: Track running line offset drift (accumulated delta from applied hunks) and adjust target hunk application lines accordingly.\n\n" +
      "Constraints — existing behaviors must keep working:\n" +
      "  - Empty diffs or whitespace-only diffs must return original text unchanged.\n" +
      "  - Single-hunk modifications must continue to work cleanly.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/patch.js":
          "export function applyUnifiedDiff(originalText, diffText) {\n" +
          "  if (!diffText || !diffText.trim()) return originalText;\n" +
          '  const lines = originalText.split("\\n");\n' +
          '  const diffLines = diffText.split("\\n");\n' +
          "  const hunkRegex = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/;\n" +
          "  let i = 0;\n" +
          "  while (i < diffLines.length) {\n" +
          "    const match = diffLines[i].match(hunkRegex);\n" +
          "    if (!match) { i++; continue; }\n" +
          "    const oldStart = parseInt(match[1], 10);\n" +
          "    i++;\n" +
          "    const hunkOps = [];\n" +
          '    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {\n' +
          "      const line = diffLines[i];\n" +
          '      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {\n' +
          "        hunkOps.push(line);\n" +
          "      }\n" +
          "      i++;\n" +
          "    }\n" +
          "    // BUG: uses oldStart directly without accumulating running line offset\n" +
          "    const targetIndex = oldStart - 1;\n" +
          "    const newLines = [];\n" +
          "    let oldLinesCount = 0;\n" +
          "    for (const op of hunkOps) {\n" +
          '      if (op.startsWith("+")) {\n' +
          "        newLines.push(op.slice(1));\n" +
          '      } else if (op.startsWith("-")) {\n' +
          "        oldLinesCount++;\n" +
          '      } else if (op.startsWith(" ")) {\n' +
          "        oldLinesCount++;\n" +
          "        newLines.push(op.slice(1));\n" +
          "      }\n" +
          "    }\n" +
          "    lines.splice(targetIndex, oldLinesCount, ...newLines);\n" +
          "  }\n" +
          '  return lines.join("\\n");\n' +
          "}\n",
        "test/patch.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { applyUnifiedDiff } from "../src/patch.js";\n\n' +
          'test("empty diff returns original text unchanged", () => {\n' +
          '  const orig = "line 1\\nline 2\\nline 3";\n' +
          '  assert.equal(applyUnifiedDiff(orig, ""), orig);\n' +
          '  assert.equal(applyUnifiedDiff(orig, "   "), orig);\n' +
          '});\n\n' +
          'test("single-hunk diff modification works", () => {\n' +
          '  const orig = "line 1\\nline 2\\nline 3";\n' +
          '  const diff = "@@ -2,1 +2,1 @@\\n-line 2\\n+line two";\n' +
          '  assert.equal(applyUnifiedDiff(orig, diff), "line 1\\nline two\\nline 3");\n' +
          '});\n\n' +
          'test("multi-hunk diff with line insertions shifts subsequent hunks correctly", () => {\n' +
          '  const orig = "line 1\\nline 2\\nline 3\\nline 4\\nline 5";\n' +
          '  const diff =\n' +
          '    "@@ -2,1 +2,3 @@\\n line 2\\n+extra A\\n+extra B\\n" +\n' +
          '    "@@ -4,1 +6,1 @@\\n-line 4\\n+line four modified";\n' +
          '  const expected = "line 1\\nline 2\\nextra A\\nextra B\\nline 3\\nline four modified\\nline 5";\n' +
          '  assert.equal(applyUnifiedDiff(orig, diff), expected);\n' +
          '});\n',
      });
    },
  },
  {
    id: "LIVE-ASYNC-BATCH-POOL",
    name: "Async Worker Pool Concurrency Cap and Fail-Fast Abort",
    origin: "Node.js archetype / p-limit async pool (live)",
    category: "Concurrency & Async Invariant",
    scenario: "boundary",
    experienceKeywords: "async worker pool concurrency limit fail fast unhandled rejection abort",
    experienceDimension: "DOM",
    sourceFiles: ["src/pool.js"],
    testFiles: ["test/pool.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the async batch pool in src/pool.js exporting asyncPool(items, iteratorFn, concurrency).\n\n" +
      "Bug: When an iteratorFn rejects with an error, the pool continues scheduling tasks from the queue instead of " +
      "aborting immediately. The pool must fail fast: as soon as any item fails, cancel scheduling new tasks, " +
      "let active promises settle without throwing unhandled rejections, and reject the returned promise.\n\n" +
      "Constraints:\n" +
      "  - Maximum concurrent executions of iteratorFn must never exceed concurrency.\n" +
      "  - Resolved results must preserve original item ordering.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/pool.js":
          "export async function asyncPool(items, iteratorFn, concurrency = 2) {\n" +
          "  const results = new Array(items.length);\n" +
          "  let index = 0;\n" +
          "  async function worker() {\n" +
          "    while (index < items.length) {\n" +
          "      const i = index++;\n" +
          "      // BUG: does not check abort flag; keeps pulling new items after error\n" +
          "      results[i] = await iteratorFn(items[i], i);\n" +
          "    }\n" +
          "  }\n" +
          "  const workers = [];\n" +
          "  const count = Math.min(concurrency, items.length);\n" +
          "  for (let w = 0; w < count; w++) workers.push(worker());\n" +
          "  await Promise.all(workers);\n" +
          "  return results;\n" +
          "}\n",
        "test/pool.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { asyncPool } from "../src/pool.js";\n\n' +
          'test("concurrency limit is strictly respected", async () => {\n' +
          "  let active = 0;\n" +
          "  let maxActive = 0;\n" +
          "  const items = [1, 2, 3, 4, 5, 6];\n" +
          "  const res = await asyncPool(items, async (item) => {\n" +
          "    active++;\n" +
          "    maxActive = Math.max(maxActive, active);\n" +
          "    await new Promise((r) => setTimeout(r, 20));\n" +
          "    active--;\n" +
          "    return item * 2;\n" +
          "  }, 2);\n" +
          '  assert.equal(maxActive <= 2, true, `Max concurrency exceeded: ${maxActive}`);\n' +
          "  assert.deepEqual(res, [2, 4, 6, 8, 10, 12]);\n" +
          "});\n\n" +
          'test("preserves results in original order", async () => {\n' +
          "  const items = [80, 10, 40];\n" +
          "  const res = await asyncPool(items, async (ms, idx) => {\n" +
          "    await new Promise((r) => setTimeout(r, ms));\n" +
          '    return `item-${idx}`;\n' +
          "  }, 3);\n" +
          '  assert.deepEqual(res, ["item-0", "item-1", "item-2"]);\n' +
          "});\n\n" +
          'test("fail-fast rejects immediately and cancels remaining tasks", async () => {\n' +
          "  const executed = [];\n" +
          "  let thrown = null;\n" +
          "  try {\n" +
          "    await asyncPool([1, 2, 3, 4, 5], async (item) => {\n" +
          "      executed.push(item);\n" +
          "      if (item === 1) {\n" +
          "        await new Promise((r) => setTimeout(r, 60));\n" +
          "        return item;\n" +
          "      }\n" +
          "      if (item === 2) {\n" +
          "        await new Promise((r) => setTimeout(r, 10));\n" +
          '        throw new Error("Task 2 failed");\n' +
          "      }\n" +
          "      await new Promise((r) => setTimeout(r, 30));\n" +
          "      return item;\n" +
          "    }, 2);\n" +
          "  } catch (err) {\n" +
          "    thrown = err;\n" +
          "  }\n" +
          '  assert.ok(thrown, "Expected asyncPool to reject");\n' +
          '  assert.equal(thrown.message, "Task 2 failed");\n' +
          "  await new Promise((r) => setTimeout(r, 100));\n" +
          '  assert.equal(executed.includes(3), false, "Task 3 should not have started after failure");\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-REDUX-STRUCTURAL-SHARING",
    name: "Immutable State Tree Structural Sharing Mutation Leak",
    origin: "Redux / Immer archetype (live)",
    category: "State Architecture & Invariant",
    scenario: "regression-rollback",
    experienceKeywords: "immutable state tree structural sharing direct mutation reference identity freeze",
    experienceDimension: "DOM",
    sourceFiles: ["src/state.js"],
    testFiles: ["test/state.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the state updater function in src/state.js: export function setIn(state, pathArray, value).\n\n" +
      "Bug: The current setIn mutates nested objects in-place directly on state! This breaks immutability:\n" +
      "  1. It throws a TypeError when operating on Object.freeze(state).\n" +
      "  2. It violates structural sharing: unmodified siblings and parents MUST retain their original object reference " +
      "     identity (prev === next), while every object along the modified path MUST receive a new shallow-copied reference.\n\n" +
      "Required: Pure structural sharing without mutating the input state.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/state.js":
          "export function setIn(state, pathArray, value) {\n" +
          "  if (!pathArray || pathArray.length === 0) return value;\n" +
          "  // BUG: direct in-place mutation of the input state tree\n" +
          "  let curr = state;\n" +
          "  for (let i = 0; i < pathArray.length - 1; i++) {\n" +
          "    const key = pathArray[i];\n" +
          "    if (curr[key] === undefined || curr[key] === null) {\n" +
          "      curr[key] = {};\n" +
          "    }\n" +
          "    curr = curr[key];\n" +
          "  }\n" +
          "  curr[pathArray[pathArray.length - 1]] = value;\n" +
          "  return state;\n" +
          "}\n",
        "test/state.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { setIn } from "../src/state.js";\n\n' +
          'test("updates leaf value correctly", () => {\n' +
          '  const state = { a: { b: 1 } };\n' +
          '  const next = setIn(state, ["a", "b"], 2);\n' +
          "  assert.equal(next.a.b, 2);\n" +
          "});\n\n" +
          'test("unmodified sibling branches retain reference identity", () => {\n' +
          '  const sibling = { untouched: true };\n' +
          '  const state = { a: { b: 1 }, sibling };\n' +
          '  const next = setIn(state, ["a", "b"], 2);\n' +
          '  assert.equal(next.sibling, sibling, "Sibling reference must be preserved");\n' +
          "});\n\n" +
          'test("preserves immutability and never mutates frozen input state", () => {\n' +
          "  const original = Object.freeze({\n" +
          "    user: Object.freeze({\n" +
          '      profile: Object.freeze({ name: "Alice", age: 30 }),\n' +
          '      settings: Object.freeze({ theme: "dark" }),\n' +
          "    }),\n" +
          "    meta: Object.freeze({ version: 1 }),\n" +
          "  });\n" +
          '  const next = setIn(original, ["user", "profile", "name"], "Bob");\n' +
          '  assert.equal(original.user.profile.name, "Alice");\n' +
          '  assert.equal(next.user.profile.name, "Bob");\n' +
          "  assert.notEqual(next, original);\n" +
          "  assert.notEqual(next.user, original.user);\n" +
          "  assert.notEqual(next.user.profile, original.user.profile);\n" +
          "  assert.equal(next.user.settings, original.user.settings);\n" +
          "  assert.equal(next.meta, original.meta);\n" +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-GRAPH-CYCLE-DEADLOCK",
    name: "DAG Topological Dependency Resolver Cycle Diagnosis",
    origin: "Package manager dependency archetype (live)",
    category: "Deep Algorithmic Boundary",
    scenario: "boundary",
    experienceKeywords: "topological sort dependency cycle detection diagnostic chain Kahn",
    experienceDimension: "DOM",
    sourceFiles: ["src/graph.js"],
    testFiles: ["test/graph.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the dependency topological sorter in src/graph.js: export function resolveOrder(graph).\n\n" +
      "where graph is a map of { [node]: string[] dependencies }. Returns an array of nodes in dependency-first " +
      "order (dependencies appear before the nodes that depend on them).\n\n" +
      "Bug: The sorter fails to properly format cycle diagnostics when circular dependencies exist. When a cycle " +
      "exists (e.g. A -> B -> C -> A), it must throw an Error containing 'Cycle detected:' and displaying the arrow chain '->'.\n\n" +
      "Constraints:\n" +
      "  - When multiple nodes have 0 dependencies at the same step, resolve them in alphabetical order.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/graph.js":
          "export function resolveOrder(graph) {\n" +
          "  const nodes = Object.keys(graph).sort();\n" +
          "  const resolved = [];\n" +
          "  const visited = new Set();\n" +
          "  const visiting = new Set();\n" +
          "  function visit(node) {\n" +
          "    if (visited.has(node)) return;\n" +
          "    if (visiting.has(node)) {\n" +
          '      // BUG: throws generic error without cycle chain details\n' +
          '      throw new Error("Cycle detected");\n' +
          "    }\n" +
          "    visiting.add(node);\n" +
          "    const deps = (graph[node] || []).slice().sort();\n" +
          "    for (const dep of deps) {\n" +
          "      if (graph[dep]) visit(dep);\n" +
          "    }\n" +
          "    visiting.delete(node);\n" +
          "    visited.add(node);\n" +
          "    resolved.push(node);\n" +
          "  }\n" +
          "  for (const n of nodes) visit(n);\n" +
          "  return resolved;\n" +
          "}\n",
        "test/graph.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { resolveOrder } from "../src/graph.js";\n\n' +
          'test("linear and diamond dependencies resolve in valid order", () => {\n' +
          "  const graph = {\n" +
          '    app: ["service", "config"],\n' +
          '    service: ["db", "config"],\n' +
          "    config: [],\n" +
          '    db: ["config"],\n' +
          "  };\n" +
          "  const order = resolveOrder(graph);\n" +
          '  assert.ok(order.indexOf("config") < order.indexOf("db"));\n' +
          '  assert.ok(order.indexOf("db") < order.indexOf("service"));\n' +
          '  assert.ok(order.indexOf("service") < order.indexOf("app"));\n' +
          "});\n\n" +
          'test("alphabetical tie-breaking produces deterministic order", () => {\n' +
          "  const graph = { c: [], b: [], a: [] };\n" +
          "  const order = resolveOrder(graph);\n" +
          '  assert.deepEqual(order, ["a", "b", "c"]);\n' +
          "});\n\n" +
          'test("circular dependency throws error detailing cycle path", () => {\n' +
          "  const graph = {\n" +
          '    A: ["B"],\n' +
          '    B: ["C"],\n' +
          '    C: ["A"],\n' +
          "  };\n" +
          "  assert.throws(\n" +
          "    () => resolveOrder(graph),\n" +
          "    (err) => {\n" +
          '      assert.ok(err.message.includes("Cycle detected:"));\n' +
          '      assert.ok(err.message.includes("->"));\n' +
          '      assert.ok(err.message.includes("A") && err.message.includes("B") && err.message.includes("C"));\n' +
          "      return true;\n" +
          "    },\n" +
          "  );\n" +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-CACHE-STAMPEDE-MUTEX",
    name: "Cache Stampede Single-Flight Coalescing Mutex",
    origin: "Distributed caching / singleflight archetype (live)",
    category: "High Concurrency Invariant",
    scenario: "boundary",
    experienceKeywords: "cache stampede thundering herd singleflight mutex coalescing promise dedup",
    experienceDimension: "DOM",
    sourceFiles: ["src/cache.js"],
    testFiles: ["test/cache.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix the SingleFlightCache in src/cache.js exporting class SingleFlightCache.\n\n" +
      "Bug: Thundering herd (cache stampede). When a key is uncached or expired, concurrent calls to getOrFetch(key, fetchFn) " +
      "each invoke fetchFn separately. Under a burst of 50 concurrent requests for an uncached key, fetchFn is called 50 times " +
      "instead of coalescing into a single in-flight promise.\n\n" +
      "Required:\n" +
      "  - Cache hits must return cached values without calling fetchFn.\n" +
      "  - In-flight calls for the same key must coalesce into a single execution of fetchFn.\n" +
      "  - Once expired, new requests fetch fresh data.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/cache.js":
          "export class SingleFlightCache {\n" +
          "  constructor(ttlMs = 500) {\n" +
          "    this.ttlMs = ttlMs;\n" +
          "    this.cache = new Map();\n" +
          "  }\n\n" +
          "  async getOrFetch(key, fetchFn) {\n" +
          "    const entry = this.cache.get(key);\n" +
          "    const now = Date.now();\n" +
          "    if (entry && now < entry.expiresAt) return entry.value;\n" +
          "    // BUG: does not coalesce concurrent in-flight requests for key\n" +
          "    const value = await fetchFn();\n" +
          "    this.cache.set(key, { value, expiresAt: now + this.ttlMs });\n" +
          "    return value;\n" +
          "  }\n" +
          "}\n",
        "test/cache.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { SingleFlightCache } from "../src/cache.js";\n\n' +
          'test("cache hit serves from memory without re-fetch", async () => {\n' +
          "  const cache = new SingleFlightCache(1000);\n" +
          "  let calls = 0;\n" +
          '  const val1 = await cache.getOrFetch("user:1", async () => { calls++; return "data-1"; });\n' +
          '  const val2 = await cache.getOrFetch("user:1", async () => { calls++; return "data-1"; });\n' +
          '  assert.equal(val1, "data-1");\n' +
          '  assert.equal(val2, "data-1");\n' +
          "  assert.equal(calls, 1);\n" +
          "});\n\n" +
          'test("expired entry triggers fresh fetch", async () => {\n' +
          "  const cache = new SingleFlightCache(20);\n" +
          "  let calls = 0;\n" +
          '  await cache.getOrFetch("key", async () => { calls++; return "v1"; });\n' +
          "  await new Promise((r) => setTimeout(r, 30));\n" +
          '  const val = await cache.getOrFetch("key", async () => { calls++; return "v2"; });\n' +
          '  assert.equal(val, "v2");\n' +
          "  assert.equal(calls, 2);\n" +
          "});\n\n" +
          'test("burst of 50 concurrent callers triggers fetchFn exactly once", async () => {\n' +
          "  const cache = new SingleFlightCache(1000);\n" +
          "  let calls = 0;\n" +
          "  const callers = Array.from({ length: 50 }, () =>\n" +
          '    cache.getOrFetch("burst-key", async () => {\n' +
          "      calls++;\n" +
          "      await new Promise((r) => setTimeout(r, 20));\n" +
          '      return "burst-result";\n' +
          "    }),\n" +
          "  );\n" +
          "  const results = await Promise.all(callers);\n" +
          '  assert.equal(calls, 1, `Expected exactly 1 fetchFn call, got ${calls}`);\n' +
          '  assert.equal(results.every((r) => r === "burst-result"), true);\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-CASCADE-EVENT-BUS",
    name: "Multi-Module EventBus Async Migration with Synchronous Cascade Invariant",
    origin: "Node.js EventEmitter / EventBus architectural refactor archetype (live)",
    category: "Multi-File Cascade Regression",
    scenario: "cascade-rollback",
    experienceKeywords: "eventbus async emit migration synchronous handler downstream cascade invariant",
    experienceDimension: "DOM",
    sourceFiles: ["src/bus.js"],
    testFiles: ["test/bus.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Extend the central EventBus in src/bus.js by implementing emitAsync(event, ...args) returning a Promise,\n" +
      "while strictly preserving the 100% synchronous execution contract of emit(event, ...args).\n\n" +
      "Architecture & Downstream Context:\n" +
      "Downstream services (e.g. auth-service) rely on bus.emit('user:login', session) executing synchronously to populate\n" +
      "session.permissions immediately before validating the request. If emit() is converted to asynchronous or defers\n" +
      "listener dispatch, downstream authentication breaks immediately (cascade regression).\n\n" +
      "Requirements:\n" +
      "  - Add emitAsync(event, ...args): invokes all registered listeners for event; if any returns a Promise, awaits it.\n" +
      "    Resolves to an array containing results from all listeners (via Promise.all). If any listener throws or rejects, rejects with that error.\n" +
      "  - Retain emit(event, ...args): MUST remain 100% synchronous; executes all listeners immediately and returns boolean.\n" +
      "  - Synchronous baseline tests must keep passing without regression.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/bus.js":
          "export class EventBus {\n" +
          "  constructor() {\n" +
          "    this.listeners = new Map();\n" +
          "  }\n\n" +
          "  on(event, handler) {\n" +
          "    if (!this.listeners.has(event)) this.listeners.set(event, []);\n" +
          "    this.listeners.get(event).push(handler);\n" +
          "    return () => this.off(event, handler);\n" +
          "  }\n\n" +
          "  off(event, handler) {\n" +
          "    const list = this.listeners.get(event);\n" +
          "    if (!list) return false;\n" +
          "    const idx = list.indexOf(handler);\n" +
          "    if (idx === -1) return false;\n" +
          "    list.splice(idx, 1);\n" +
          "    return true;\n" +
          "  }\n\n" +
          "  emit(event, ...args) {\n" +
          "    const list = this.listeners.get(event);\n" +
          "    if (!list || list.length === 0) return false;\n" +
          "    for (const fn of [...list]) {\n" +
          "      fn(...args);\n" +
          "    }\n" +
          "    return true;\n" +
          "  }\n\n" +
          "  async emitAsync(event, ...args) {\n" +
          "    // BUG: emitAsync is not yet implemented\n" +
          '    throw new Error("not implemented");\n' +
          "  }\n" +
          "}\n",
        "test/bus.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { EventBus } from "../src/bus.js";\n\n' +
          'test("synchronous emit executes listeners immediately before returning", () => {\n' +
          "  const bus = new EventBus();\n" +
          "  const log = [];\n" +
          '  bus.on("ping", () => log.push("a"));\n' +
          '  bus.on("ping", () => log.push("b"));\n' +
          '  const res = bus.emit("ping");\n' +
          "  assert.equal(res, true);\n" +
          '  assert.deepEqual(log, ["a", "b"]);\n' +
          "});\n\n" +
          'test("auth-service synchronous session permissions mutation works", () => {\n' +
          "  const bus = new EventBus();\n" +
          "  const session = { user: \"alice\", permissions: [] };\n" +
          '  bus.on("user:login", (s) => {\n' +
          '    s.permissions.push("read", "write");\n' +
          "  });\n" +
          '  bus.emit("user:login", session);\n' +
          '  assert.deepEqual(session.permissions, ["read", "write"]);\n' +
          "});\n\n" +
          'test("emitAsync awaits asynchronous promise-returning listeners", async () => {\n' +
          "  const bus = new EventBus();\n" +
          "  const log = [];\n" +
          '  bus.on("compute", async (val) => {\n' +
          "    await new Promise((r) => setTimeout(r, 20));\n" +
          "    log.push(val * 2);\n" +
          "    return val * 2;\n" +
          "  });\n" +
          '  bus.on("compute", (val) => {\n' +
          "    log.push(val + 10);\n" +
          "    return val + 10;\n" +
          "  });\n" +
          '  const results = await bus.emitAsync("compute", 5);\n' +
          "  assert.deepEqual(results, [10, 15]);\n" +
          "  assert.equal(log.length, 2);\n" +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-SQLITE-SCHEMA-MIGRATION",
    name: "Multi-Repo Query Executor Selective Soft-Delete Migration",
    origin: "ORM / SQL Query Builder migration archetype (live)",
    category: "Multi-File Cascade Regression",
    scenario: "cascade-rollback",
    experienceKeywords: "query builder soft delete table awareness cascade regression sql column missing",
    experienceDimension: "DOM",
    sourceFiles: ["src/query.js"],
    testFiles: ["test/query.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Enhance the SQL query compiler in src/query.js: export function compileSelect(table, conditions, options = {}).\n\n" +
      "Architecture Context:\n" +
      "The application is introducing soft-delete filtering across specific repositories:\n" +
      "  - Tables WITH soft-delete: ['users', 'articles', 'comments'].\n" +
      "  - Tables WITHOUT soft-delete: ['orders', 'audit_logs', 'sessions'].\n\n" +
      "Requirements:\n" +
      "  - If options.includeDeleted is false (or omitted):\n" +
      "    - When table is in ['users', 'articles', 'comments'], the query MUST append 'deleted_at IS NULL' to the WHERE conditions.\n" +
      "    - When table is NOT in that list (e.g. 'orders', 'audit_logs'), it MUST NEVER append 'deleted_at IS NULL' (as those tables lack that column).\n" +
      "  - If options.includeDeleted is true: never append 'deleted_at IS NULL' regardless of table.\n" +
      "  - If conditions are provided, join all WHERE clauses with ' AND '.\n" +
      "  - Baseline queries on non-soft-delete tables must keep working without regression.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/query.js":
          "const SOFT_DELETE_TABLES = new Set(['users', 'articles', 'comments']);\n\n" +
          "export function compileSelect(table, conditions = {}, options = {}) {\n" +
          "  const parts = [];\n" +
          "  for (const [key, val] of Object.entries(conditions)) {\n" +
          "    parts.push(typeof val === 'string' ? `${key} = '${val}'` : `${key} = ${val}`);\n" +
          "  }\n" +
          "  // BUG: soft-delete filter is not implemented for soft-delete tables\n" +
          "  const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';\n" +
          "  return `SELECT * FROM ${table}${where}`;\n" +
          "}\n",
        "test/query.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { compileSelect } from "../src/query.js";\n\n' +
          'test("compiles simple select on non-soft-delete tables without deleted_at", () => {\n' +
          '  const sql = compileSelect("orders", { status: "pending" });\n' +
          '  assert.equal(sql, "SELECT * FROM orders WHERE status = \'pending\'");\n' +
          '  assert.equal(sql.includes("deleted_at"), false);\n' +
          "});\n\n" +
          'test("combines multiple existing where conditions with AND", () => {\n' +
          '  const sql = compileSelect("audit_logs", { user_id: 1, action: "login" });\n' +
          '  assert.equal(sql, "SELECT * FROM audit_logs WHERE user_id = 1 AND action = \'login\'");\n' +
          "});\n\n" +
          'test("soft-delete tables automatically filter deleted_at IS NULL when includeDeleted is false", () => {\n' +
          '  const sql = compileSelect("users", { role: "admin" });\n' +
          '  assert.equal(sql, "SELECT * FROM users WHERE role = \'admin\' AND deleted_at IS NULL");\n' +
          '  const sqlAll = compileSelect("users", { role: "admin" }, { includeDeleted: true });\n' +
          '  assert.equal(sqlAll, "SELECT * FROM users WHERE role = \'admin\'");\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-BLIND-FAULT-LOCALIZATION",
    name: "Multi-Module Microservice Pipeline Blind Fault Localization",
    origin: "SWE-bench Verified / Microservice Pipeline Fault Localization (live)",
    category: "Blind Fault Localization",
    scenario: "blind-localization",
    experienceKeywords: "blind fault localization stack trace pricing discount coupon NaN microservice pipeline",
    experienceDimension: "DOM",
    sourceFiles: [
      "src/controllers/checkout.controller.js",
      "src/services/pricing.service.js",
      "src/services/discount.service.js",
      "src/utils/currency.util.js",
    ],
    testFiles: ["test/checkout.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "A high-priority bug was reported in the checkout service: VIP customers with percentage discounts receive NaN or an unrounded total when checking out with coupon codes.\n\n" +
      "Error Log / Stack Trace from Integration Run:\n" +
      "  AssertionError: expected '80.00' but received 'NaN'\n" +
      "    at TestContext.<anonymous> (test/checkout.test.mjs:42:12)\n\n" +
      "Architecture Overview:\n" +
      "The checkout flow routes requests through src/controllers/checkout.controller.js, which queries src/services/discount.service.js for applicable vouchers and delegates final bill calculation to src/services/pricing.service.js with helpers in src/utils/currency.util.js.\n\n" +
      "Task:\n" +
      "Inspect the microservice repository files, locate the root cause file among the candidate modules, and resolve the NaN / discount calculation defect.\n" +
      "Do NOT modify the test suite or any unrelated module contracts. Existing non-discount checkout operations must keep passing without regression.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/utils/currency.util.js":
          "export function formatCurrency(amount) {\n" +
          "  return Number(amount).toFixed(2);\n" +
          "}\n\n" +
          "export function roundToCents(amount) {\n" +
          "  return Math.round(Number(amount) * 100) / 100;\n" +
          "}\n",
        "src/services/discount.service.js":
          "export function resolveCoupon(code) {\n" +
          "  const coupons = {\n" +
          "    VIP20: { type: 'percent', value: 20 },\n" +
          "    FLAT10: { type: 'flat', value: 10 },\n" +
          "  };\n" +
          "  return coupons[code] || null;\n" +
          "}\n",
        "src/services/pricing.service.js":
          "import { formatCurrency, roundToCents } from '../utils/currency.util.js';\n\n" +
          "export function calculateOrderTotal(items = [], coupon = null) {\n" +
          "  const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);\n" +
          "  let discountAmount = 0;\n" +
          "  if (coupon) {\n" +
          "    if (coupon.type === 'percent') {\n" +
          "      // BUG: coupon.rate is undefined (discount.service returns value: 20)\n" +
          "      discountAmount = subtotal * coupon.rate;\n" +
          "    } else if (coupon.type === 'flat') {\n" +
          "      discountAmount = Math.min(subtotal, coupon.value);\n" +
          "    }\n" +
          "  }\n" +
          "  const total = Math.max(0, subtotal - discountAmount);\n" +
          "  return {\n" +
          "    subtotal: formatCurrency(subtotal),\n" +
          "    discount: formatCurrency(discountAmount || 0),\n" +
          "    total: formatCurrency(roundToCents(total)),\n" +
          "  };\n" +
          "}\n",
        "src/controllers/checkout.controller.js":
          "import { resolveCoupon } from '../services/discount.service.js';\n" +
          "import { calculateOrderTotal } from '../services/pricing.service.js';\n\n" +
          "export function processCheckout({ items = [], couponCode = null }) {\n" +
          "  if (!Array.isArray(items) || items.length === 0) {\n" +
          "    throw new Error('Cart is empty');\n" +
          "  }\n" +
          "  const coupon = couponCode ? resolveCoupon(couponCode) : null;\n" +
          "  return calculateOrderTotal(items, coupon);\n" +
          "}\n",
        "test/checkout.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { processCheckout } from "../src/controllers/checkout.controller.js";\n\n' +
          'test("standard checkout calculates subtotal and total without discount", () => {\n' +
          '  const res = processCheckout({\n' +
          '    items: [\n' +
          '      { name: "Widget", price: 25.5, quantity: 2 },\n' +
          '      { name: "Gadget", price: 10.0, quantity: 1 },\n' +
          '    ],\n' +
          '  });\n' +
          '  assert.equal(res.subtotal, "61.00");\n' +
          '  assert.equal(res.discount, "0.00");\n' +
          '  assert.equal(res.total, "61.00");\n' +
          '});\n\n' +
          'test("flat coupon checkout deducts fixed value correctly", () => {\n' +
          '  const res = processCheckout({\n' +
          '    items: [{ name: "Widget", price: 50.0, quantity: 1 }],\n' +
          '    couponCode: "FLAT10",\n' +
          '  });\n' +
          '  assert.equal(res.subtotal, "50.00");\n' +
          '  assert.equal(res.discount, "10.00");\n' +
          '  assert.equal(res.total, "40.00");\n' +
          '});\n\n' +
          'test("VIP percentage coupon calculates discount and final total without NaN", () => {\n' +
          '  const res = processCheckout({\n' +
          '    items: [{ name: "Widget", price: 100.0, quantity: 1 }],\n' +
          '    couponCode: "VIP20",\n' +
          '  });\n' +
          '  assert.equal(res.subtotal, "100.00");\n' +
          '  assert.equal(res.discount, "20.00");\n' +
          '  assert.equal(res.total, "80.00");\n' +
          '  assert.equal(res.total !== "NaN", true);\n' +
          '});\n',
      });
    },
  },
  {
    id: "LIVE-HARNESS-INV-DUAL-PACKAGE",
    name: "Dual ESM/CJS Package Exports Subpath Invariant Break",
    origin: "Google Research Harness² / Invariant-First Packaging (live)",
    category: "Invariant-First Environment (INV)",
    scenario: "inv-environment",
    experienceKeywords: "invariant preflight package exports subpath ERR_PACKAGE_PATH_NOT_EXPORTED dual package",
    experienceDimension: "INV",
    sourceFiles: ["package.json", "src/index.js", "src/strings.js"],
    testFiles: ["test/exports.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Subpath export resolution fails on Node.js ESM loader: importing subpath 'agent-lib/strings' throws ERR_PACKAGE_PATH_NOT_EXPORTED.\n\n" +
      "Error Diagnostics:\n" +
      "  Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './strings' is not defined by 'exports' in package.json\n\n" +
      "Architecture Context (Harness² INV-First Principle):\n" +
      "This is an Invariant / Packaging mechanics defect (INV dimension). The business logic in src/strings.js and src/index.js is already 100% correct.\n" +
      "The package is designed as a modern Node ESM package supporting root export and subpath export './strings'.\n\n" +
      "Requirements:\n" +
      "  - Configure package.json \"exports\" map so that:\n" +
      "      - Root import '.' maps to './src/index.js'\n" +
      "      - Subpath import './strings' maps to './src/strings.js'\n" +
      "  - Root package and subpath imports must resolve cleanly.\n" +
      "  - Do not break existing package.json scripts or dependencies.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": JSON.stringify(
          {
            name: "agent-lib",
            version: "1.0.0",
            type: "module",
            exports: {
              ".": "./src/index.js",
            },
            scripts: { test: "node --test" },
          },
          null,
          2,
        ),
        "src/strings.js":
          "export function slugify(str) {\n" +
          '  return String(str || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n' +
          "}\n",
        "src/index.js":
          'export { slugify } from "./strings.js";\n' +
          'export const VERSION = "1.0.0";\n',
        "test/exports.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { slugify, VERSION } from "../src/index.js";\n\n' +
          'test("root module exports resolve and functions work", () => {\n' +
          '  assert.equal(VERSION, "1.0.0");\n' +
          '  assert.equal(slugify("Hello World!"), "hello-world");\n' +
          '});\n\n' +
          'test("subpath package import agent-lib/strings resolves cleanly via package.json exports", async () => {\n' +
          '  const sub = await import("agent-lib/strings");\n' +
          '  assert.equal(typeof sub.slugify, "function");\n' +
          '  assert.equal(sub.slugify("Harness Invariant Preflight"), "harness-invariant-preflight");\n' +
          '});\n',
      });
    },
  },
  {
    id: "LIVE-LONG-HORIZON-RESOURCE-LEAK",
    name: "High-Concurrency Event Stream Pipeline Debounce Timer & Listener Leak",
    origin: "Reactive Stream / EventEmitter resource leak archetype (live)",
    category: "Long-Horizon Concurrency Leak",
    scenario: "resource-leak",
    experienceKeywords: "resource leak event listener timer debounce soak test cleanup destroy pipeline",
    experienceDimension: "DOM",
    sourceFiles: ["src/pipeline.js"],
    testFiles: ["test/pipeline.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Fix a resource leak in src/pipeline.js: StreamPipeline buffers high-frequency streaming events with a debounce timer and emits batches.\n\n" +
      "Bug & Soak Test Failure:\n" +
      "In long-running microservices, pipelines are dynamically created and destroyed per connection. Under soak testing with 50 connection lifecycles, active timers and event listeners leak, causing Node.js event emitter warnings and memory growth.\n" +
      "  AssertionError: expected 0 active timers and 0 dangling listeners after destroy(), found active references.\n\n" +
      "Requirements in src/pipeline.js:\n" +
      "  - Implement destroy(): must cancel any pending debounce timer, detach all registered listeners on the input source, and mark pipeline as destroyed.\n" +
      "  - Add getActiveTimerCount(): returns 1 if debounce timer is active/scheduled, 0 otherwise.\n" +
      "  - Ensure subsequent push() calls on a destroyed pipeline are safely ignored (no-op).\n" +
      "  - Baseline event batching and flush semantics must keep working without regression.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/pipeline.js":
          'import { EventEmitter } from "node:events";\n\n' +
          "export class StreamPipeline extends EventEmitter {\n" +
          "  constructor(options = {}) {\n" +
          "    super();\n" +
          "    this.debounceMs = options.debounceMs || 50;\n" +
          "    this.batch = [];\n" +
          "    this.timer = null;\n" +
          "    this.destroyed = false;\n" +
          "    this.attachedSource = null;\n" +
          "    this.boundHandler = null;\n" +
          "  }\n\n" +
          "  attachSource(source) {\n" +
          "    this.attachedSource = source;\n" +
          "    this.boundHandler = (data) => this.push(data);\n" +
          '    source.on("data", this.boundHandler);\n' +
          "  }\n\n" +
          "  push(item) {\n" +
          "    if (this.destroyed) return;\n" +
          "    this.batch.push(item);\n" +
          "    if (!this.timer) {\n" +
          "      this.timer = setTimeout(() => this.flush(), this.debounceMs);\n" +
          "    }\n" +
          "  }\n\n" +
          "  flush() {\n" +
          "    if (this.timer) {\n" +
          "      clearTimeout(this.timer);\n" +
          "      this.timer = null;\n" +
          "    }\n" +
          "    if (this.batch.length > 0) {\n" +
          "      const items = [...this.batch];\n" +
          "      this.batch = [];\n" +
          '      this.emit("batch", items);\n' +
          "    }\n" +
          "  }\n\n" +
          "  getActiveTimerCount() {\n" +
          "    return this.timer ? 1 : 0;\n" +
          "  }\n\n" +
          "  destroy() {\n" +
          "    // BUG: does not clearTimeout(this.timer) and does not detach listener from attachedSource\n" +
          "    this.destroyed = true;\n" +
          "  }\n" +
          "}\n",
        "test/pipeline.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { EventEmitter } from "node:events";\n' +
          'import { StreamPipeline } from "../src/pipeline.js";\n\n' +
          'test("batches and flushes incoming items upon timeout", async () => {\n' +
          "  const pipeline = new StreamPipeline({ debounceMs: 20 });\n" +
          "  const batches = [];\n" +
          '  pipeline.on("batch", (b) => batches.push(b));\n' +
          '  pipeline.push("a");\n' +
          '  pipeline.push("b");\n' +
          "  await new Promise((r) => setTimeout(r, 60));\n" +
          '  assert.deepEqual(batches, [["a", "b"]]);\n' +
          "  pipeline.destroy();\n" +
          "});\n\n" +
          'test("manual flush flushes items immediately without waiting", () => {\n' +
          "  const pipeline = new StreamPipeline({ debounceMs: 1000 });\n" +
          "  const batches = [];\n" +
          '  pipeline.on("batch", (b) => batches.push(b));\n' +
          '  pipeline.push("msg");\n' +
          "  pipeline.flush();\n" +
          '  assert.deepEqual(batches, [["msg"]]);\n' +
          "  pipeline.destroy();\n" +
          "});\n\n" +
          'test("soak test: destroy cleans up pending timers and detaches source listeners without leaks", () => {\n' +
          "  const source = new EventEmitter();\n" +
          "  const pipelines = [];\n" +
          "  for (let i = 0; i < 50; i++) {\n" +
          "    const p = new StreamPipeline({ debounceMs: 10000 });\n" +
          "    p.attachSource(source);\n" +
          '    p.push(`data-${i}`);\n' +
          "    assert.equal(p.getActiveTimerCount(), 1);\n" +
          "    pipelines.push(p);\n" +
          "  }\n" +
          '  assert.equal(source.listenerCount("data"), 50);\n\n' +
          "  for (const p of pipelines) {\n" +
          "    p.destroy();\n" +
          "  }\n\n" +
          '  assert.equal(source.listenerCount("data"), 0, "All source listeners must be detached on destroy");\n' +
          "  for (const p of pipelines) {\n" +
          '    assert.equal(p.getActiveTimerCount(), 0, "All active debounce timers must be cancelled on destroy");\n' +
          "  }\n" +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-SWE-BENCH-PRO-NODEBB",
    name: "SWE-bench Pro NodeBB: Multi-Dimensional Topic Sorting & Invariant Intersections",
    origin: "SWE-bench Pro V2 (Scale AI / NodeBB instance_NodeBB-05f22361)",
    category: "Real-World Production OSS (SWE-bench Pro V2)",
    scenario: "standard",
    experienceKeywords: "SWE-bench Pro NodeBB getSortedTopics ascending chronological sort old intersect pinned",
    experienceDimension: "DOM",
    sourceFiles: ["src/topics/sorted.js"],
    testFiles: ["test/sorted.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "Real-world task ported from SWE-bench Pro V2 (instance NodeBB-05f22361):\n" +
      "Extend NodeBB topic retrieval to support chronological ascending sort (sort: 'old', oldest replies first) across categories, tags, and global topic lists.\n\n" +
      "Problem Description:\n" +
      "The current implementation of getSortedTopics in src/topics/sorted.js only supports descending sort modes ('recent', 'posts', 'votes'). When params.sort === 'old' is supplied, the system erroneously falls back to descending or queries invalid sorted sets.\n\n" +
      "Requirements & Architecture Contracts in src/topics/sorted.js:\n" +
      "1. Global sort: when params.sort === 'old', query db.getSortedSetRange('topics:recent', 0, meta.config.recentMaxTopics - 1) instead of getSortedSetRevRange.\n" +
      "2. Tag filter (params.tags.length): when params.sort === 'old', the target set must be 'topics:recent' and the intersection method must be db.getSortedSetIntersect instead of db.getSortedSetRevIntersect.\n" +
      "3. Category filter (params.cids.length): when params.sort === 'old', include cid:${cid}:tids in sets (same as 'recent') and query with db.getSortedSetRange.\n" +
      "4. In-memory sorting: sortMap must include old: (a, b) => a.lastposttime - b.lastposttime.\n" +
      "5. Invariants: Pinned topics must continue to float to top when params.floatPinned is true, and existing 'recent', 'posts', and 'votes' behaviors must NOT regress.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/topics/sorted.js":
          "export function createTopicsModule(db, meta = { config: { recentMaxTopics: 20 } }) {\n" +
          "  const Topics = {\n" +
          "    tools: {\n" +
          "      async checkPinExpiry(tids) {\n" +
          "        return tids;\n" +
          "      },\n" +
          "    },\n" +
          "    async getTopicsFields(tids, fields) {\n" +
          "      return tids.map((tid) => db.getTopic(tid)).filter(Boolean);\n" +
          "    },\n" +
          "    async getSortedTopics(params) {\n" +
          "      let tids = [];\n" +
          "      if (params.cids && params.cids.length) {\n" +
          "        tids = await getCidTids(params);\n" +
          "      } else if (params.tags && params.tags.length) {\n" +
          "        tids = await getTagTids(params);\n" +
          "      } else {\n" +
          "        tids = await db.getSortedSetRevRange(`topics:${params.sort}`, 0, meta.config.recentMaxTopics - 1);\n" +
          "      }\n\n" +
          "      if (!tids || !tids.length) {\n" +
          "        return [];\n" +
          "      }\n\n" +
          "      const topicData = await Topics.getTopicsFields(tids, [\n" +
          '        "tid", "lastposttime", "upvotes", "downvotes", "postcount", "pinned"\n' +
          "      ]);\n\n" +
          "      const sortMap = {\n" +
          "        recent: sortRecent,\n" +
          "        posts: sortPopular,\n" +
          "        votes: sortVotes,\n" +
          "      };\n" +
          "      const sortFn = sortMap[params.sort] || sortRecent;\n\n" +
          "      if (params.floatPinned) {\n" +
          "        floatPinned(topicData, sortFn);\n" +
          "      } else {\n" +
          "        topicData.sort(sortFn);\n" +
          "      }\n" +
          "      return topicData;\n" +
          "    },\n" +
          "  };\n\n" +
          "  async function getTagTids(params) {\n" +
          "    const sets = [\n" +
          "      `topics:${params.sort}`,\n" +
          '      ...params.tags.map((tag) => `tag:${tag}:topics`),\n' +
          "    ];\n" +
          "    return await db.getSortedSetRevIntersect({\n" +
          "      sets,\n" +
          "      start: 0,\n" +
          "      stop: meta.config.recentMaxTopics - 1,\n" +
          "    });\n" +
          "  }\n\n" +
          "  async function getCidTids(params) {\n" +
          "    const sets = [];\n" +
          "    const pinnedSets = [];\n" +
          "    params.cids.forEach((cid) => {\n" +
          "      if (params.sort === 'recent') {\n" +
          "        sets.push(`cid:${cid}:tids`);\n" +
          "      } else {\n" +
          "        sets.push(`cid:${cid}:tids${params.sort ? `:${params.sort}` : ''}`);\n" +
          "      }\n" +
          "      pinnedSets.push(`cid:${cid}:tids:pinned`);\n" +
          "    });\n" +
          "    const pinnedTids = await db.getSortedSetRevRange(pinnedSets, 0, -1);\n" +
          "    const tids = await db.getSortedSetRevRange(sets, 0, meta.config.recentMaxTopics - 1);\n" +
          "    return pinnedTids.concat(tids);\n" +
          "  }\n\n" +
          "  function floatPinned(topics, sortFn) {\n" +
          "    const pinned = [];\n" +
          "    const notPinned = [];\n" +
          "    topics.forEach((topic) => {\n" +
          "      if (topic && topic.pinned) {\n" +
          "        pinned.push(topic);\n" +
          "      } else {\n" +
          "        notPinned.push(topic);\n" +
          "      }\n" +
          "    });\n" +
          "    pinned.sort(sortFn);\n" +
          "    notPinned.sort(sortFn);\n" +
          "    topics.length = 0;\n" +
          "    topics.push(...pinned, ...notPinned);\n" +
          "  }\n\n" +
          "  function sortRecent(a, b) {\n" +
          "    return b.lastposttime - a.lastposttime;\n" +
          "  }\n\n" +
          "  function sortPopular(a, b) {\n" +
          "    return b.postcount - a.postcount;\n" +
          "  }\n\n" +
          "  function sortVotes(a, b) {\n" +
          "    return (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes);\n" +
          "  }\n\n" +
          "  return Topics;\n" +
          "}\n",
        "test/sorted.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { createTopicsModule } from "../src/topics/sorted.js";\n\n' +
          "function createMockDb() {\n" +
          "  const topics = {\n" +
          "    1: { tid: 1, lastposttime: 1000, postcount: 5, upvotes: 2, downvotes: 0, pinned: false },\n" +
          "    2: { tid: 2, lastposttime: 2000, postcount: 10, upvotes: 5, downvotes: 1, pinned: false },\n" +
          "    3: { tid: 3, lastposttime: 3000, postcount: 2, upvotes: 0, downvotes: 0, pinned: true },\n" +
          "  };\n" +
          "  return {\n" +
          "    getTopic: (tid) => topics[tid],\n" +
          "    async getSortedSetRevRange(key, start, stop) {\n" +
          "      if (Array.isArray(key)) {\n" +
          '        if (key[0]?.includes("pinned")) return [3];\n' +
          "        return [2, 1];\n" +
          "      }\n" +
          '      if (key === "topics:recent") return [3, 2, 1];\n' +
          '      if (key === "topics:posts") return [2, 1, 3];\n' +
          '      if (key === "topics:votes") return [2, 1, 3];\n' +
          '      if (key?.includes("pinned")) return [3];\n' +
          "      return [];\n" +
          "    },\n" +
          "    async getSortedSetRange(key, start, stop) {\n" +
          "      if (Array.isArray(key)) {\n" +
          '        if (key[0]?.includes("pinned")) return [3];\n' +
          "        return [1, 2];\n" +
          "      }\n" +
          '      if (key === "topics:recent") return [1, 2, 3];\n' +
          "      return [];\n" +
          "    },\n" +
          "    async getSortedSetRevIntersect({ sets, start, stop }) {\n" +
          "      return [3, 2];\n" +
          "    },\n" +
          "    async getSortedSetIntersect({ sets, start, stop }) {\n" +
          "      return [2, 3];\n" +
          "    },\n" +
          "  };\n" +
          "}\n\n" +
          'test("baseline: recent sort returns topics descending by lastposttime (newest first)", async () => {\n' +
          "  const db = createMockDb();\n" +
          "  const Topics = createTopicsModule(db);\n" +
          '  const result = await Topics.getSortedTopics({ sort: "recent" });\n' +
          "  assert.equal(result.length, 3);\n" +
          "  assert.equal(result[0].tid, 3);\n" +
          "  assert.equal(result[1].tid, 2);\n" +
          "  assert.equal(result[2].tid, 1);\n" +
          "});\n\n" +
          'test("baseline: posts sort returns topics ordered by postcount", async () => {\n' +
          "  const db = createMockDb();\n" +
          "  const Topics = createTopicsModule(db);\n" +
          '  const result = await Topics.getSortedTopics({ sort: "posts" });\n' +
          "  assert.equal(result[0].tid, 2);\n" +
          "  assert.equal(result[0].postcount, 10);\n" +
          "});\n\n" +
          'test("baseline: floatPinned floats pinned topics to top in category query", async () => {\n' +
          "  const db = createMockDb();\n" +
          "  const Topics = createTopicsModule(db);\n" +
          '  const result = await Topics.getSortedTopics({ cids: [1], sort: "recent", floatPinned: true });\n' +
          "  assert.equal(result[0].pinned, true);\n" +
          "  assert.equal(result[0].tid, 3);\n" +
          "});\n\n" +
          'test("target: old sort queries ascending range for global, tag, and cid topics", async () => {\n' +
          "  const db = createMockDb();\n" +
          "  const Topics = createTopicsModule(db);\n\n" +
          '  const globalRes = await Topics.getSortedTopics({ sort: "old" });\n' +
          "  assert.equal(globalRes.length, 3);\n" +
          '  assert.equal(globalRes[0].tid, 1, "Oldest topic must be first in old sort");\n' +
          "  assert.equal(globalRes[1].tid, 2);\n" +
          "  assert.equal(globalRes[2].tid, 3);\n\n" +
          '  const catRes = await Topics.getSortedTopics({ cids: [1], sort: "old", floatPinned: true });\n' +
          '  assert.equal(catRes[0].pinned, true, "Pinned topic must remain at top");\n' +
          '  assert.equal(catRes[1].tid, 1, "Non-pinned topics must be sorted oldest first");\n' +
          "  assert.equal(catRes[2].tid, 2);\n\n" +
          '  const tagRes = await Topics.getSortedTopics({ tags: ["javascript"], sort: "old" });\n' +
          '  assert.equal(tagRes[0].tid, 2, "Tag old sort must invoke getSortedSetIntersect");\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-RED-HERRING-CIRCULAR-DECOY",
    name: "Red Herring Decoy: Downstream Serializer Crash via Upstream Circular Context Leak",
    origin: "Harness² Adversarial Invariant Injection / Agent Triage Failure Taxonomy (live)",
    category: "Adversarial Fault Localization",
    scenario: "standard",
    experienceKeywords: "red herring decoy downstream crash circular structure json response serializer upstream session context",
    experienceDimension: "DOM",
    sourceFiles: ["src/services/order-service.js", "src/serializers/response-serializer.js"],
    testFiles: ["test/order-pipeline.test.mjs"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: true,
    brief:
      "An incident was reported on the checkout API: requests with active transaction spans crash during response formatting.\n\n" +
      "Error Log / Stack Trace:\n" +
      "  TypeError: Converting circular structure to JSON\n" +
      "      --> starting at object with constructor 'Object'\n" +
      "      |     property 'transaction' -> object with constructor 'Object'\n" +
      "      --- property 'parent' closes the circle\n" +
      "      at JSON.stringify (<anonymous>)\n" +
      "      at serializeResponse (src/serializers/response-serializer.js:9:15)\n" +
      "      at TestContext.<anonymous> (test/order-pipeline.test.mjs:34:16)\n\n" +
      "System Architecture & Contracts:\n" +
      "- src/serializers/response-serializer.js: Downstream serialization gateway.\n" +
      "  INVARIANT CONTRACT: This file enforces strict DTO hygiene and MUST NOT be modified or weakened with try/catch / circular stripping hacks. The downstream serializer must throw when given corrupt circular inputs.\n" +
      "- src/services/order-service.js: Upstream checkout service. When building the order record, it must extract ONLY clean audit metadata ({ traceId, userId }) from requestContext rather than attaching the entire raw runtime context object containing circular transaction handles.\n\n" +
      "Task:\n" +
      "Fix the crash at the true architectural source so checkout requests with active request contexts serialize cleanly without leaking circular handles or violating downstream DTO invariants.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/serializers/response-serializer.js":
          "// INVARIANT CONTRACT: Downstream response serializer must remain a strict, clean JSON serializer.\n" +
          "// Do NOT swallow circular errors or modify this file — upstream services must provide clean DTOs.\n" +
          "export function serializeResponse(statusCode, data) {\n" +
          "  const payload = {\n" +
          "    status: statusCode,\n" +
          "    data,\n" +
          "    timestamp: new Date().toISOString(),\n" +
          "  };\n" +
          "  return JSON.stringify(payload);\n" +
          "}\n",
        "src/services/order-service.js":
          "export class OrderService {\n" +
          "  constructor(db) {\n" +
          "    this.db = db;\n" +
          "  }\n\n" +
          "  async checkoutOrder(orderInput, requestContext = null) {\n" +
          '    if (!orderInput || typeof orderInput.total !== "number") {\n' +
          '      throw new Error("Invalid order input");\n' +
          "    }\n" +
          '    const orderId = "ord_" + Math.random().toString(36).slice(2, 9);\n' +
          "    const order = {\n" +
          "      id: orderId,\n" +
          "      total: orderInput.total,\n" +
          "      items: orderInput.items || [],\n" +
          "      // BUG (Red Herring): attaches raw requestContext directly to order.audit.\n" +
          "      // In production, requestContext contains active event listeners, transaction handles,\n" +
          "      // and circular parent-child trace spans. Attaching raw context causes downstream\n" +
          "      // serializeResponse() to throw TypeError: Converting circular structure to JSON!\n" +
          "      // Must extract ONLY clean audit metadata: { traceId: requestContext?.traceId, userId: requestContext?.userId }\n" +
          "      audit: requestContext,\n" +
          "    };\n" +
          "    return order;\n" +
          "  }\n" +
          "}\n",
        "test/order-pipeline.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import { OrderService } from "../src/services/order-service.js";\n' +
          'import { serializeResponse } from "../src/serializers/response-serializer.js";\n\n' +
          'test("baseline: order without circular context serializes valid JSON", async () => {\n' +
          "  const service = new OrderService();\n" +
          '  const order = await service.checkoutOrder({ total: 100, items: ["item_1"] }, null);\n' +
          "  const json = serializeResponse(200, order);\n" +
          "  const parsed = JSON.parse(json);\n" +
          "  assert.equal(parsed.status, 200);\n" +
          "  assert.equal(parsed.data.total, 100);\n" +
          "});\n\n" +
          'test("baseline: downstream serializer contract: must throw on invalid circular objects to preserve DTO hygiene", () => {\n' +
          "  const circular = {};\n" +
          "  circular.self = circular;\n" +
          "  assert.throws(() => serializeResponse(200, circular), {\n" +
          '    name: "TypeError",\n' +
          "    message: /Converting circular structure to JSON/,\n" +
          "  });\n" +
          "});\n\n" +
          'test("target: order checkout with active request context extracts clean audit metadata and serializes cleanly", async () => {\n' +
          "  const service = new OrderService();\n" +
          "  const circularContext = {\n" +
          '    traceId: "trc_998877",\n' +
          '    userId: "usr_42",\n' +
          '    transaction: { id: "tx_1" },\n' +
          "  };\n" +
          "  circularContext.transaction.parent = circularContext; // circular link!\n\n" +
          '  const order = await service.checkoutOrder({ total: 250, items: ["item_a", "item_b"] }, circularContext);\n' +
          "  const json = serializeResponse(200, order);\n" +
          "  const parsed = JSON.parse(json);\n" +
          "  assert.equal(parsed.status, 200);\n" +
          "  assert.equal(parsed.data.total, 250);\n" +
          '  assert.equal(parsed.data.audit?.traceId, "trc_998877");\n' +
          '  assert.equal(order.audit?.transaction, undefined, "Must NOT leak internal circular transaction handle");\n' +
          "});\n",
      });
    },
  },
  {
    id: "LIVE-DISTRIBUTED-CONTRACT-RACE",
    name: "Distributed Microservices Contract Drift: Concurrent Dual-Agent Gateway/Billing Sync",
    origin: "Google Research Harness² Multi-Agent Stress Test (Distributed Protocol Drift)",
    category: "Multi-Agent Concurrency & Shared Contract Coordination",
    scenario: "parallel-race",
    experienceKeywords: "distributed microservices contract drift parallel dual-agent gateway billing protocol idempotency",
    experienceDimension: "INV",
    sourceFiles: ["src/contracts/protocol.js", "src/services/gateway.js", "src/services/billing.js"],
    testFiles: ["test/billing-flow.test.mjs"],
    assemblyFiles: ["src/contracts/protocol.js"],
    fixtureHasTests: true,
    expectedBaselineFails: 0,
    soloSeesTests: false,
    contracts: [
      { module: "src/contracts/protocol.js", api: "export const PROTOCOL_VERSION = '2.0.0'; export const GATEWAY_ACTIONS; export const BILLING_STATUSES;" },
      { module: "src/services/gateway.js", api: "export function routeBillingRequest(request) — validates idempotencyKey and routes v2" },
      { module: "src/services/billing.js", api: "export function settleTransaction(routedRequest) — settles in integer cents" },
    ],
    soloSubagents: [
      {
        name: "gateway-team",
        scope:
          "Upgrade Gateway to Protocol v2.0.0: Update shared src/contracts/protocol.js to export PROTOCOL_VERSION = '2.0.0' " +
          "and export const GATEWAY_ACTIONS = ['ROUTE_PAYMENT', 'REFUND_PAYMENT']. " +
          "Update src/services/gateway.js to preserve export function routeBillingRequest(request), require request.idempotencyKey " +
          "(throw Error('Missing idempotencyKey') if missing), and return { routed: true, version: PROTOCOL_VERSION, action: 'ROUTE_PAYMENT', idempotencyKey: request.idempotencyKey, payload: request }.",
        sharedFiles: ["src/contracts/protocol.js"],
        allowedFiles: ["src/contracts/protocol.js", "src/services/gateway.js"],
      },
      {
        name: "billing-team",
        scope:
          "Upgrade Billing Service to Protocol v2.0.0: Update shared src/contracts/protocol.js to export PROTOCOL_VERSION = '2.0.0' " +
          "and export const BILLING_STATUSES = ['SETTLED', 'REJECTED', 'PENDING']. " +
          "Update src/services/billing.js to preserve export function settleTransaction(routedRequest), and return " +
          "{ status: 'SETTLED', version: PROTOCOL_VERSION, cents: Math.round(Number(routedRequest.payload.amount) * 100), idempotencyKey: routedRequest.idempotencyKey }.",
        sharedFiles: ["src/contracts/protocol.js"],
        allowedFiles: ["src/contracts/protocol.js", "src/services/billing.js"],
      },
    ],
    brief:
      "Two feature teams upgrade a distributed microservices billing platform to Protocol v2.0.0 in parallel.\n\n" +
      "Architecture & Function Interface Contracts:\n" +
      "- Shared Protocol Contract (src/contracts/protocol.js): Must export PROTOCOL_VERSION = '2.0.0', SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP'], GATEWAY_ACTIONS = ['ROUTE_PAYMENT', 'REFUND_PAYMENT'], and BILLING_STATUSES = ['SETTLED', 'REJECTED', 'PENDING'].\n" +
      "- Team A (Gateway Team in src/services/gateway.js): Updates export function routeBillingRequest(request). Requires request.idempotencyKey (throws Error('Missing idempotencyKey') if missing), validates currency against SUPPORTED_CURRENCIES, and returns { routed: true, version: PROTOCOL_VERSION, action: GATEWAY_ACTIONS[0], idempotencyKey: request.idempotencyKey, payload: request }.\n" +
      "- Team B (Billing Team in src/services/billing.js): Updates export function settleTransaction(routedRequest). Returns { status: BILLING_STATUSES[0], version: PROTOCOL_VERSION, cents: Math.round(Number(routedRequest.payload.amount) * 100), idempotencyKey: routedRequest.idempotencyKey }.\n\n" +
      "Concurrency Challenge:\n" +
      "Both teams concurrently modify the shared contract src/contracts/protocol.js. They must coordinate so the shared protocol contract retains BOTH teams' exports and end-to-end payment routing succeeds.",
    fixture(ws) {
      writeWorkspaceFiles(ws, {
        "package.json": PKG_JSON,
        "src/contracts/protocol.js":
          'export const PROTOCOL_VERSION = "1.0.0";\n' +
          'export const SUPPORTED_CURRENCIES = ["USD", "EUR"];\n',
        "src/services/gateway.js":
          'import { PROTOCOL_VERSION, SUPPORTED_CURRENCIES } from "../contracts/protocol.js";\n\n' +
          "export function routeBillingRequest(request) {\n" +
          "  if (!request.currency || !SUPPORTED_CURRENCIES.includes(request.currency)) {\n" +
          '    throw new Error("Unsupported currency: " + request.currency);\n' +
          "  }\n" +
          "  return {\n" +
          "    routed: true,\n" +
          "    version: PROTOCOL_VERSION,\n" +
          "    payload: request,\n" +
          "  };\n" +
          "}\n",
        "src/services/billing.js":
          'import { PROTOCOL_VERSION } from "../contracts/protocol.js";\n\n' +
          "export function settleTransaction(routedRequest) {\n" +
          "  return {\n" +
          "    settled: true,\n" +
          "    version: PROTOCOL_VERSION,\n" +
          "    amount: routedRequest.payload.amount,\n" +
          "  };\n" +
          "}\n",
        "test/billing-flow.test.mjs":
          'import test from "node:test";\n' +
          'import assert from "node:assert/strict";\n' +
          'import * as protocol from "../src/contracts/protocol.js";\n' +
          'import { routeBillingRequest } from "../src/services/gateway.js";\n' +
          'import { settleTransaction } from "../src/services/billing.js";\n\n' +
          'test("baseline: gateway rejects unsupported currency", () => {\n' +
          '  assert.throws(() => routeBillingRequest({ currency: "XYZ", amount: 10, idempotencyKey: "k1" }), {\n' +
          "    message: /Unsupported currency/,\n" +
          "  });\n" +
          "});\n\n" +
          'test("target: protocol contract exports both GATEWAY_ACTIONS and BILLING_STATUSES under v2.0.0", () => {\n' +
          '  assert.equal(protocol.PROTOCOL_VERSION, "2.0.0");\n' +
          '  assert.ok(Array.isArray(protocol.GATEWAY_ACTIONS), "Must export GATEWAY_ACTIONS");\n' +
          '  assert.ok(protocol.GATEWAY_ACTIONS.includes("ROUTE_PAYMENT"));\n' +
          '  assert.ok(Array.isArray(protocol.BILLING_STATUSES), "Must export BILLING_STATUSES");\n' +
          '  assert.ok(protocol.BILLING_STATUSES.includes("SETTLED"));\n' +
          "});\n\n" +
          'test("target: gateway requires idempotencyKey and billing settles in cents", () => {\n' +
          '  assert.throws(() => routeBillingRequest({ currency: "USD", amount: 15.5 }), {\n' +
          "    message: /Missing idempotencyKey/,\n" +
          "  });\n\n" +
          '  const routed = routeBillingRequest({ currency: "USD", amount: 15.5, idempotencyKey: "idem_abc123" });\n' +
          "  assert.equal(routed.routed, true);\n" +
          '  assert.equal(routed.idempotencyKey, "idem_abc123");\n' +
          '  assert.equal(routed.action, "ROUTE_PAYMENT");\n\n' +
          "  const settled = settleTransaction(routed);\n" +
          '  assert.equal(settled.status, "SETTLED");\n' +
          "  assert.equal(settled.cents, 1550);\n" +
          '  assert.equal(settled.idempotencyKey, "idem_abc123");\n' +
          "});\n",
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Ground truth + orchestration
// ---------------------------------------------------------------------------

async function runTaskDuel(task, runRoot, experienceStore, log) {
  const soloWs = path.join(runRoot, `${task.id}-solo`);
  const boostWs = path.join(runRoot, `${task.id}-boost`);
  fs.mkdirSync(soloWs, { recursive: true });
  fs.mkdirSync(boostWs, { recursive: true });
  task.fixture(soloWs);
  task.fixture(boostWs);

  // Immutable-suite snapshots + pristine baseline (which tests pass/fail on
  // the seeded fixture) — identical for both arms by construction.
  const soloFixtureTests = captureFixtureTests(soloWs, task);
  const boostFixtureTests = captureFixtureTests(boostWs, task);
  const pristineRun = runNodeTest(soloWs);
  const pristineParsed = parseTestOutcome(pristineRun);
  const baselinePassingNames = pristineParsed.passingNames;
  log(
    `  pristine fixture baseline: pass=${pristineParsed.passCount} fail=${pristineParsed.failCount}` +
      `${pristineParsed.failingNames.length ? ` (seeded-bug tests: ${pristineParsed.failingNames.join("; ")})` : ""}`,
  );

  log(`  Track A (solo) starting — ${CONFIG.model}, bare prompt, no toolchain`);
  const solo = await runSoloArm(task, soloWs, log, soloFixtureTests);
  log(
    `  Track A done: attempts=${solo.attempts} calls=${solo.usage.calls} ` +
      `tokens(in/out)=${solo.usage.prompt}/${solo.usage.completion} wall=${solo.wallMs}ms`,
  );

  log(`  Track B (boost) starting — same model + five-phase toolchain`);
  const boost = await runBoostArm(task, boostWs, experienceStore, log, boostFixtureTests, baselinePassingNames);
  log(
    `  Track B done: workstreams=${boost.workstreams.length} tier=${boost.complexity.complexity} ` +
      `rounds=${boost.events.repairRounds} rollbacks=${boost.events.rollbacks} ` +
      `conflicts=${boost.events.conflictsIntercepted} calls=${boost.usage.calls} ` +
      `tokens(in/out)=${boost.usage.prompt}/${boost.usage.completion} wall=${boost.wallMs}ms`,
  );

  // Ground truth — identical for both arms. Tasks without a fixture test suite
  // get the hidden post-hoc test appended to both workspaces simultaneously.
  if (!task.fixtureHasTests && task.hiddenPostTest) {
    writeWorkspaceFiles(soloWs, { [task.hiddenPostTest]: task.hiddenPostContent });
    writeWorkspaceFiles(boostWs, { [task.hiddenPostTest]: task.hiddenPostContent });
    log(`  ground truth: appended hidden post-hoc test to BOTH workspaces`);
  }
  restoreFixtureTests(soloWs, soloFixtureTests);
  restoreFixtureTests(boostWs, boostFixtureTests);
  const soloGround = runNodeTest(soloWs);
  soloGround.parsed = parseTestOutcome(soloGround);
  const boostGround = runNodeTest(boostWs);
  boostGround.parsed = parseTestOutcome(boostGround);

  // Judge both arms with the same prompt (boost: Phase 4 gate; solo: post-hoc).
  const soloJudged = await judgeArm(task, soloWs, solo.fixtureSha, soloGround, `solo:${task.id}`);
  solo.records.push(soloJudged.judgeCall);
  const boostJudged = await judgeArm(task, boostWs, boost.fixtureSha, boostGround, `boost:${task.id}`);
  boost.records.push(boostJudged.judgeCall);

  const soloPassed = soloGround.exitCode === 0;
  const boostPassed = boostGround.exitCode === 0 && boostJudged.yardstick.passed;

  // Phase 5 — experience reflection (boost only; persists across tasks in-run)
  const entry = buildExperienceForTask(task, boost, boostGround.exitCode === 0);
  if (entry !== "NO_ENTRY") {
    experienceStore.content += `\n${entry}\n`;
    log(`  Phase 5: experience card persisted (${task.id})`);
  }

  const reflogEvidence = boost.events.rollbackEvidence.length > 0
    ? boost.events.rollbackEvidence
    : gitReflog(boostWs).filter((l) => l.includes("reset")).slice(0, 3);

  return {
    task: {
      id: task.id,
      name: task.name,
      origin: task.origin,
      category: task.category,
      scenario: task.scenario,
    },
    solo: {
      passed: soloPassed,
      groundExitCode: soloGround.exitCode,
      groundPass: soloGround.parsed.passCount,
      groundFail: soloGround.parsed.failCount,
      failingTests: soloGround.parsed.failingNames,
      attempts: solo.attempts,
      yardstickScore: soloJudged.yardstick.overallScore,
      yardstickPassed: soloJudged.yardstick.passed,
      judgeSource: soloJudged.judgeSource,
      usage: { ...solo.usage },
      meanLatencyMs: solo.meanLatencyMs,
      wallMs: solo.wallMs,
      diffStat: soloJudged.diff.stat,
    },
    boost: {
      passed: boostPassed,
      groundExitCode: boostGround.exitCode,
      groundPass: boostGround.parsed.passCount,
      groundFail: boostGround.parsed.failCount,
      failingTests: boostGround.parsed.failingNames,
      workstreams: boost.workstreams,
      complexityTier: boost.complexity.complexity,
      tokenBudget: boost.tokenBudget, // adaptive max_tokens for exec/repair calls (Option B)
      maxRepairRounds: boost.complexity.maxRepairRounds,
      repairRounds: boost.events.repairRounds,
      conflictsIntercepted: boost.events.conflictsIntercepted,
      rollbacks: boost.events.rollbacks,
      reflogEvidence,
      synthUsed: boost.events.synthUsed,
      recalledCues: boost.events.recalledCues,
      yardstickScore: boostJudged.yardstick.overallScore,
      yardstickPassed: boostJudged.yardstick.passed,
      judgeSource: boostJudged.judgeSource,
      usage: { ...boost.usage },
      meanLatencyMs: boost.meanLatencyMs,
      wallMs: boost.wallMs,
      diffStat: boostJudged.diff.stat,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtTokens(n) {
  return n.toLocaleString("en-US");
}

function printHeader(log) {
  log("=".repeat(80));
  log("  agent-boost v0.4.1 LIVE API End-to-End Benchmark Harness");
  log(`  Endpoint: ${CONFIG.endpoint}`);
  log(`  Model:    ${CONFIG.model} (temperature ${CONFIG.temperature})`);
  log(`  Session:  ${CONFIG.sessionId}   Run started: ${new Date().toISOString()}`);
  log("  Track A: Solo model, bare prompt, no toolchain");
  log("  Track B: Same model + agent-boost five-phase toolchain (real git, real tests)");
  log("=".repeat(80) + "\n");
}

function printScoreboard(results, log) {
  log("=".repeat(80));
  log("                       LIVE SCOREBOARD MATRIX");
  log("=".repeat(80));
  log(
    "| Task ID                   | Solo (exit/score)   | Boost (exit/score)  | Boost evidence | Result |",
  );
  log("| :------------------------ | :------------------ | :------------------ | :------------- | :---- |");
  for (const r of results) {
    const id = r.task.id.padEnd(25);
    const solo = `${r.solo.passed ? "PASS" : "FAIL"} (${r.solo.groundExitCode}/${r.solo.yardstickScore})`.padEnd(20);
    const boost = `${r.boost.passed ? "PASS" : "FAIL"} (${r.boost.groundExitCode}/${r.boost.yardstickScore})`.padEnd(20);
    const ev = [
      r.boost.conflictsIntercepted > 0 ? `conflict:${r.boost.conflictsIntercepted}` : null,
      r.boost.rollbacks > 0 ? `rollback:${r.boost.rollbacks}` : null,
      r.boost.synthUsed ? "synth:1" : null,
      `rounds:${r.boost.repairRounds}`,
    ].filter(Boolean).join(" ").padEnd(14);
    const status = r.boost.passed && !r.solo.passed ? "BOOST-ONLY" : r.boost.passed ? "BOTH-PASS" : r.solo.passed ? "SOLO-ONLY" : "BOTH-FAIL";
    log(`| ${id} | ${solo} | ${boost} | ${ev} | ${status} |`);
  }
  log("");
}

function printAggregate(results, log) {
  const total = results.length;
  const soloPassed = results.filter((r) => r.solo.passed).length;
  const boostPassed = results.filter((r) => r.boost.passed).length;
  const soloTokens = results.reduce((a, r) => a + r.solo.usage.prompt + r.solo.usage.completion, 0);
  const boostTokens = results.reduce((a, r) => a + r.boost.usage.prompt + r.boost.usage.completion, 0);
  const soloPrompt = results.reduce((a, r) => a + r.solo.usage.prompt, 0);
  const soloCompletion = results.reduce((a, r) => a + r.solo.usage.completion, 0);
  const boostPrompt = results.reduce((a, r) => a + r.boost.usage.prompt, 0);
  const boostCompletion = results.reduce((a, r) => a + r.boost.usage.completion, 0);
  const soloScoreAvg = results.reduce((a, r) => a + r.solo.yardstickScore, 0) / total;
  const boostScoreAvg = results.reduce((a, r) => a + r.boost.yardstickScore, 0) / total;
  const rollbacks = results.reduce((a, r) => a + r.boost.rollbacks, 0);
  const conflicts = results.reduce((a, r) => a + r.boost.conflictsIntercepted, 0);
  const synthTasks = results.filter((r) => r.task.scenario === "test-synthesis").length;
  const synthUsed = results.filter((r) => r.boost.synthUsed).length;
  const soloLat = Math.round(results.reduce((a, r) => a + r.solo.meanLatencyMs, 0) / total);
  const boostLat = Math.round(results.reduce((a, r) => a + r.boost.meanLatencyMs, 0) / total);
  const apiCalls = callLedger.filter((c) => true).length;
  const okCalls = callLedger.filter((c) => c.ok).length;

  log("=".repeat(80));
  log("                          LIVE AGGREGATE SUMMARY");
  log("=".repeat(80));
  log(`Live tasks:                                   ${total}`);
  log(`Solo ${CONFIG.model} pass rate:                ${soloPassed}/${total} (${((soloPassed / total) * 100).toFixed(1)}%)`);
  log(`${CONFIG.model} + agent-boost pass rate:      ${boostPassed}/${total} (${((boostPassed / total) * 100).toFixed(1)}%)`);
  log(`Mean yardstick score (judge):                 solo ${soloScoreAvg.toFixed(1)}/100 -> boost ${boostScoreAvg.toFixed(1)}/100`);
  log(`Metered API tokens — solo:                    prompt ${fmtTokens(soloPrompt)} + completion ${fmtTokens(soloCompletion)} = ${fmtTokens(soloTokens)}`);
  log(`Metered API tokens — boost:                   prompt ${fmtTokens(boostPrompt)} + completion ${fmtTokens(boostCompletion)} = ${fmtTokens(boostTokens)}`);
  log(`Token ratio (boost/solo):                     ${(boostTokens / (soloTokens || 1)).toFixed(3)}x`);
  log(`Mean per-call API latency:                    solo ${soloLat}ms -> boost ${boostLat}ms`);
  log(`Parallel write conflicts intercepted (boost): ${conflicts}`);
  log(`Git reset --hard rollbacks executed (boost):  ${rollbacks}`);
  log(`Test synthesis coverage (boost):              ${synthUsed}/${synthTasks}`);
  log(`Total live HTTP calls:                        ${apiCalls} (${okCalls} ok, ${apiCalls - okCalls} failed/retried)`);
  log("=".repeat(80) + "\n");
  return {
    total, soloPassed, boostPassed,
    soloTokens, boostTokens, soloPrompt, soloCompletion, boostPrompt, boostCompletion,
    soloScoreAvg, boostScoreAvg, rollbacks, conflicts, synthTasks, synthUsed,
    soloLat, boostLat, apiCalls, okCalls,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runLiveBenchmarks(options = {}) {
  const silent = Boolean(options.silent);
  const log = silent ? () => {} : console.log;
  const taskFilter = options.tasks || null;
  const tasks = taskFilter ? LIVE_TASKS.filter((t) => taskFilter.includes(t.id)) : LIVE_TASKS;

  if (options.model) {
    CONFIG.model = options.model;
  }

  API_KEY = await resolveApiKey();
  if (!API_KEY) {
    console.error(
      "No API key found. Set OPENCODE_API_KEY (or ZEN_API_KEY) in the environment, " +
        "./.env or ~/.env, then re-run.",
    );
    process.exitCode = 2;
    return null;
  }

  printHeader(log);
  // Connectivity + auth pre-flight: one tiny real call aborts early on bad creds.
  const preflight = await callMimoModel(
    [{ role: "user", content: "Reply with exactly: ok" }],
    0, ENGINEER_SYSTEM,
    { maxTokens: 512, tag: "preflight" },
  );
  if (!preflight.ok) {
    console.error(`Preflight call failed (${preflight.error}) — aborting before burning task budget.`);
    process.exitCode = 2;
    return null;
  }
  log(
    `preflight ok: HTTP ${preflight.httpStatus} in ${preflight.latencyMs}ms, ` +
      `usage prompt=${preflight.usage.promptTokens} completion=${preflight.usage.completionTokens}\n`,
  );

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-boost-live-"));
  const experienceStore = { content: "" };
  const results = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    log("-".repeat(80));
    log(`[${i + 1}/${tasks.length}] Task: ${task.id} — ${task.name}`);
    log(`     Origin: ${task.origin}   Category: ${task.category}   Scenario: ${task.scenario}`);
    try {
      const result = await runTaskDuel(task, runRoot, experienceStore, log);
      results.push(result);
      log(
        `  RESULT: solo ${result.solo.passed ? "PASS" : "FAIL"} (exit ${result.solo.groundExitCode}, score ${result.solo.yardstickScore}) ` +
          `vs boost ${result.boost.passed ? "PASS" : "FAIL"} (exit ${result.boost.groundExitCode}, score ${result.boost.yardstickScore})`,
      );
    } catch (err) {
      log(`  TASK ERROR: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n") : err}`);
      results.push({
        task: { id: task.id, name: task.name, origin: task.origin, category: task.category, scenario: task.scenario },
        error: String(err && err.message ? err.message : err),
        solo: null,
        boost: null,
      });
    }
  }

  log("");
  printScoreboard(results.filter((r) => !r.error), log);
  const aggregate = printAggregate(results.filter((r) => !r.error), log);
  log(`Workspaces preserved under: ${runRoot}`);

  return {
    meta: {
      endpoint: CONFIG.endpoint,
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      sessionId: CONFIG.sessionId,
      startedAt: results.length > 0 ? undefined : new Date().toISOString(),
      node: process.version,
      fairnessProtocol: {
        soloMaxAttempts: CONFIG.soloMaxAttempts,
        boostRounds: "evaluateTaskComplexity tiers (simple 2 / standard 3 / hard 5)",
        judgePrompt: "identical for both arms",
      },
    },
    aggregate,
    results,
    callLedger: callLedger.map(({ tag, attempt, httpStatus, latencyMs, ok, error, usage }) => ({
      tag, attempt, httpStatus, latencyMs, ok, error,
      usage: usage ? { ...usage } : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Offline harness self-test (NO network, NO benchmark claims)
// ---------------------------------------------------------------------------

const CANONICAL_FIXES = {
  // Known-good implementations used ONLY by --offline-selftest to prove the
  // workspaces, test execution and git machinery behave as designed. They are
  // never reported as model output.
  "LIVE-EXPRESS-RACE":
    'import { registerAuthRoutes } from "./routes/auth.js";\n' +
    'import { registerMetricsRoutes } from "./routes/metrics.js";\n\n' +
    "export function createApp() {\n" +
    "  const mountedRoutes = [];\n" +
    "  const app = { mount: (route) => mountedRoutes.push(route) };\n" +
    "  registerAuthRoutes(app);\n" +
    "  registerMetricsRoutes(app);\n" +
    "  return { app, mountedRoutes };\n" +
    "}\n",
  "LIVE-SEMVER-REGRESSION": null, // built inline below (patch of the fixture)
  "LIVE-REST-SYNTH":
    "export function transformCustomer(payload) {\n" +
    '  return {\n    id: payload.id,\n    line1: payload.billing_address?.line1 ?? "",\n' +
    '    city: payload.billing_address?.city ?? "",\n  };\n}\n',
  "LIVE-TOKENIZER-BOUNDARY":
    "// Streaming JSON tokenizer: feed() accepts arbitrary chunk boundaries.\n" +
    "export function createTokenizer() {\n" +
    "  let inString = false;\n" +
    "  let escapeStreak = 0; // persists across feed() chunks\n" +
    "  const tokens = [];\n" +
    "  return {\n" +
    "    feed(chunk) {\n" +
    '      for (const ch of chunk) {\n' +
    '        if (ch === "\\\\") { escapeStreak += 1; continue; }\n' +
    "        if (ch === '\"') {\n" +
    "          if (escapeStreak % 2 === 0) {\n" +
    "            inString = !inString;\n" +
    '            tokens.push(inString ? "STR_START" : "STR_END");\n' +
    "          } else {\n" +
    '            tokens.push("ESCAPED_QUOTE");\n' +
    "          }\n" +
    "          escapeStreak = 0;\n" +
    "          continue;\n" +
    "        }\n" +
    "        escapeStreak = 0;\n" +
    "      }\n" +
    "      return tokens;\n" +
    "    },\n" +
    "    isInString: () => inString,\n" +
    "  };\n" +
    "}\n",
  "LIVE-RATELIMIT-RACE":
    "export class SlidingWindowLimiter {\n" +
    "  constructor(limit = 50, windowMs = 1000, nowFn = Date.now) {\n" +
    "    this.limit = limit;\n" +
    "    this.windowMs = windowMs;\n" +
    "    this.nowFn = nowFn;\n" +
    "    this.calls = [];\n" +
    "  }\n\n" +
    "  async acquire() {\n" +
    "    const now = this.nowFn();\n" +
    "    this.calls = this.calls.filter((t) => now - t < this.windowMs);\n" +
    "    if (this.calls.length < this.limit) {\n" +
    "      this.calls.push(now);\n" +
    "      return true;\n" +
    "    }\n" +
    "    return false;\n" +
    "  }\n" +
    "}\n",
  "LIVE-DIFF-PATCH-APPLY":
    "export function applyUnifiedDiff(originalText, diffText) {\n" +
    "  if (!diffText || !diffText.trim()) return originalText;\n" +
    '  const lines = originalText.split("\\n");\n' +
    '  const diffLines = diffText.split("\\n");\n' +
    "  const hunkRegex = /^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/;\n" +
    "  let i = 0;\n" +
    "  let offset = 0;\n" +
    "  while (i < diffLines.length) {\n" +
    "    const match = diffLines[i].match(hunkRegex);\n" +
    "    if (!match) { i++; continue; }\n" +
    "    const oldStart = parseInt(match[1], 10);\n" +
    "    i++;\n" +
    "    const hunkOps = [];\n" +
    '    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {\n' +
    "      const line = diffLines[i];\n" +
    '      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {\n' +
    "        hunkOps.push(line);\n" +
    "      }\n" +
    "      i++;\n" +
    "    }\n" +
    "    const targetIndex = (oldStart - 1) + offset;\n" +
    "    const newLines = [];\n" +
    "    let oldLinesCount = 0;\n" +
    "    for (const op of hunkOps) {\n" +
    '      if (op.startsWith("+")) {\n' +
    "        newLines.push(op.slice(1));\n" +
    '      } else if (op.startsWith("-")) {\n' +
    "        oldLinesCount++;\n" +
    '      } else if (op.startsWith(" ")) {\n' +
    "        oldLinesCount++;\n" +
    "        newLines.push(op.slice(1));\n" +
    "      }\n" +
    "    }\n" +
    "    lines.splice(targetIndex, oldLinesCount, ...newLines);\n" +
    "    offset += (newLines.length - oldLinesCount);\n" +
    "  }\n" +
    '  return lines.join("\\n");\n' +
    "}\n",
  "LIVE-ASYNC-BATCH-POOL":
    "export async function asyncPool(items, iteratorFn, concurrency = 2) {\n" +
    "  const results = new Array(items.length);\n" +
    "  let index = 0;\n" +
    "  let aborted = false;\n" +
    "  let firstError = null;\n" +
    "  async function worker() {\n" +
    "    while (index < items.length && !aborted) {\n" +
    "      const i = index++;\n" +
    "      try {\n" +
    "        results[i] = await iteratorFn(items[i], i);\n" +
    "      } catch (err) {\n" +
    "        if (!aborted) {\n" +
    "          aborted = true;\n" +
    "          firstError = err;\n" +
    "        }\n" +
    "        break;\n" +
    "      }\n" +
    "    }\n" +
    "  }\n" +
    "  const workers = [];\n" +
    "  const count = Math.min(concurrency, items.length);\n" +
    "  for (let w = 0; w < count; w++) workers.push(worker());\n" +
    "  await Promise.all(workers);\n" +
    "  if (firstError) throw firstError;\n" +
    "  return results;\n" +
    "}\n",
  "LIVE-REDUX-STRUCTURAL-SHARING":
    "export function setIn(state, pathArray, value) {\n" +
    "  if (!pathArray || pathArray.length === 0) return value;\n" +
    "  function update(cur, idx) {\n" +
    "    if (idx === pathArray.length) return value;\n" +
    "    const key = pathArray[idx];\n" +
    "    const curObj = (cur && typeof cur === 'object') ? cur : {};\n" +
    "    const nextChild = update(curObj[key], idx + 1);\n" +
    "    if (curObj[key] === nextChild && cur !== undefined) return cur;\n" +
    "    const clone = Array.isArray(curObj) ? [...curObj] : { ...curObj };\n" +
    "    clone[key] = nextChild;\n" +
    "    return clone;\n" +
    "  }\n" +
    "  return update(state, 0);\n" +
    "}\n",
  "LIVE-GRAPH-CYCLE-DEADLOCK":
    "export function resolveOrder(graph) {\n" +
    "  const nodes = Object.keys(graph).sort();\n" +
    "  const resolved = [];\n" +
    "  const visited = new Set();\n" +
    "  const visiting = new Set();\n" +
    "  const pathStack = [];\n" +
    "  function visit(node) {\n" +
    "    if (visited.has(node)) return;\n" +
    "    if (visiting.has(node)) {\n" +
    "      const cycleStart = pathStack.indexOf(node);\n" +
    "      const cyclePath = [...pathStack.slice(cycleStart), node].join(' -> ');\n" +
    '      throw new Error(`Cycle detected: ${cyclePath}`);\n' +
    "    }\n" +
    "    visiting.add(node);\n" +
    "    pathStack.push(node);\n" +
    "    const deps = (graph[node] || []).slice().sort();\n" +
    "    for (const dep of deps) {\n" +
    "      if (graph[dep]) visit(dep);\n" +
    "    }\n" +
    "    pathStack.pop();\n" +
    "    visiting.delete(node);\n" +
    "    visited.add(node);\n" +
    "    resolved.push(node);\n" +
    "  }\n" +
    "  for (const n of nodes) visit(n);\n" +
    "  return resolved;\n" +
    "}\n",
  "LIVE-CACHE-STAMPEDE-MUTEX":
    "export class SingleFlightCache {\n" +
    "  constructor(ttlMs = 500) {\n" +
    "    this.ttlMs = ttlMs;\n" +
    "    this.cache = new Map();\n" +
    "    this.inFlight = new Map();\n" +
    "  }\n\n" +
    "  async getOrFetch(key, fetchFn) {\n" +
    "    const entry = this.cache.get(key);\n" +
    "    const now = Date.now();\n" +
    "    if (entry && now < entry.expiresAt) return entry.value;\n" +
    "    if (this.inFlight.has(key)) {\n" +
    "      return this.inFlight.get(key);\n" +
    "    }\n" +
    "    const promise = (async () => {\n" +
    "      try {\n" +
    "        const value = await fetchFn();\n" +
    "        this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });\n" +
    "        return value;\n" +
    "      } finally {\n" +
    "        this.inFlight.delete(key);\n" +
    "      }\n" +
    "    })();\n" +
    "    this.inFlight.set(key, promise);\n" +
    "    return promise;\n" +
    "  }\n" +
    "}\n",
  "LIVE-CASCADE-EVENT-BUS":
    "export class EventBus {\n" +
    "  constructor() {\n" +
    "    this.listeners = new Map();\n" +
    "  }\n\n" +
    "  on(event, handler) {\n" +
    "    if (!this.listeners.has(event)) this.listeners.set(event, []);\n" +
    "    this.listeners.get(event).push(handler);\n" +
    "    return () => this.off(event, handler);\n" +
    "  }\n\n" +
    "  off(event, handler) {\n" +
    "    const list = this.listeners.get(event);\n" +
    "    if (!list) return false;\n" +
    "    const idx = list.indexOf(handler);\n" +
    "    if (idx === -1) return false;\n" +
    "    list.splice(idx, 1);\n" +
    "    return true;\n" +
    "  }\n\n" +
    "  emit(event, ...args) {\n" +
    "    const list = this.listeners.get(event);\n" +
    "    if (!list || list.length === 0) return false;\n" +
    "    for (const fn of [...list]) {\n" +
    "      fn(...args);\n" +
    "    }\n" +
    "    return true;\n" +
    "  }\n\n" +
    "  async emitAsync(event, ...args) {\n" +
    "    const list = this.listeners.get(event);\n" +
    "    if (!list || list.length === 0) return [];\n" +
    "    const promises = list.map((fn) => Promise.resolve().then(() => fn(...args)));\n" +
    "    return Promise.all(promises);\n" +
    "  }\n" +
    "}\n",
  "LIVE-SQLITE-SCHEMA-MIGRATION":
    "const SOFT_DELETE_TABLES = new Set(['users', 'articles', 'comments']);\n\n" +
    "export function compileSelect(table, conditions = {}, options = {}) {\n" +
    "  const parts = [];\n" +
    "  for (const [key, val] of Object.entries(conditions)) {\n" +
    "    parts.push(typeof val === 'string' ? `${key} = '${val}'` : `${key} = ${val}`);\n" +
    "  }\n" +
    "  if (!options.includeDeleted && SOFT_DELETE_TABLES.has(table)) {\n" +
    "    parts.push('deleted_at IS NULL');\n" +
    "  }\n" +
    "  const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';\n" +
    "  return `SELECT * FROM ${table}${where}`;\n" +
    "}\n",
  "LIVE-BLIND-FAULT-LOCALIZATION":
    "import { formatCurrency, roundToCents } from '../utils/currency.util.js';\n\n" +
    "export function calculateOrderTotal(items = [], coupon = null) {\n" +
    "  const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);\n" +
    "  let discountAmount = 0;\n" +
    "  if (coupon) {\n" +
    "    if (coupon.type === 'percent') {\n" +
    "      discountAmount = subtotal * (coupon.value / 100);\n" +
    "    } else if (coupon.type === 'flat') {\n" +
    "      discountAmount = Math.min(subtotal, coupon.value);\n" +
    "    }\n" +
    "  }\n" +
    "  const total = Math.max(0, subtotal - discountAmount);\n" +
    "  return {\n" +
    "    subtotal: formatCurrency(subtotal),\n" +
    "    discount: formatCurrency(discountAmount || 0),\n" +
    "    total: formatCurrency(roundToCents(total)),\n" +
    "  };\n" +
    "}\n",
  "LIVE-HARNESS-INV-DUAL-PACKAGE":
    JSON.stringify(
      {
        name: "agent-lib",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": "./src/index.js",
          "./strings": "./src/strings.js",
        },
        scripts: { test: "node --test" },
      },
      null,
      2,
    ) + "\n",
  "LIVE-LONG-HORIZON-RESOURCE-LEAK":
    'import { EventEmitter } from "node:events";\n\n' +
    "export class StreamPipeline extends EventEmitter {\n" +
    "  constructor(options = {}) {\n" +
    "    super();\n" +
    "    this.debounceMs = options.debounceMs || 50;\n" +
    "    this.batch = [];\n" +
    "    this.timer = null;\n" +
    "    this.destroyed = false;\n" +
    "    this.attachedSource = null;\n" +
    "    this.boundHandler = null;\n" +
    "  }\n\n" +
    "  attachSource(source) {\n" +
    "    this.attachedSource = source;\n" +
    "    this.boundHandler = (data) => this.push(data);\n" +
    '    source.on("data", this.boundHandler);\n' +
    "  }\n\n" +
    "  push(item) {\n" +
    "    if (this.destroyed) return;\n" +
    "    this.batch.push(item);\n" +
    "    if (!this.timer) {\n" +
    "      this.timer = setTimeout(() => this.flush(), this.debounceMs);\n" +
    "    }\n" +
    "  }\n\n" +
    "  flush() {\n" +
    "    if (this.timer) {\n" +
    "      clearTimeout(this.timer);\n" +
    "      this.timer = null;\n" +
    "    }\n" +
    "    if (this.batch.length > 0) {\n" +
    "      const items = [...this.batch];\n" +
    "      this.batch = [];\n" +
    '      this.emit("batch", items);\n' +
    "    }\n" +
    "  }\n\n" +
    "  getActiveTimerCount() {\n" +
    "    return this.timer ? 1 : 0;\n" +
    "  }\n\n" +
    "  destroy() {\n" +
    "    this.destroyed = true;\n" +
    "    if (this.timer) {\n" +
    "      clearTimeout(this.timer);\n" +
    "      this.timer = null;\n" +
    "    }\n" +
    "    if (this.attachedSource && this.boundHandler) {\n" +
    '      this.attachedSource.off("data", this.boundHandler);\n' +
    "      this.attachedSource = null;\n" +
    "      this.boundHandler = null;\n" +
    "    }\n" +
    "    this.batch = [];\n" +
    "    this.removeAllListeners();\n" +
    "  }\n" +
    "}\n",
  "LIVE-SWE-BENCH-PRO-NODEBB":
    "export function createTopicsModule(db, meta = { config: { recentMaxTopics: 20 } }) {\n" +
    "  const Topics = {\n" +
    "    tools: {\n" +
    "      async checkPinExpiry(tids) {\n" +
    "        return tids;\n" +
    "      },\n" +
    "    },\n" +
    "    async getTopicsFields(tids, fields) {\n" +
    "      return tids.map((tid) => db.getTopic(tid)).filter(Boolean);\n" +
    "    },\n" +
    "    async getSortedTopics(params) {\n" +
    "      let tids = [];\n" +
    "      if (params.cids && params.cids.length) {\n" +
    "        tids = await getCidTids(params);\n" +
    "      } else if (params.tags && params.tags.length) {\n" +
    "        tids = await getTagTids(params);\n" +
    "      } else if (params.sort === 'old') {\n" +
    "        tids = await db.getSortedSetRange('topics:recent', 0, meta.config.recentMaxTopics - 1);\n" +
    "      } else {\n" +
    "        tids = await db.getSortedSetRevRange(`topics:${params.sort}`, 0, meta.config.recentMaxTopics - 1);\n" +
    "      }\n\n" +
    "      if (!tids || !tids.length) {\n" +
    "        return [];\n" +
    "      }\n\n" +
    "      const topicData = await Topics.getTopicsFields(tids, [\n" +
    '        "tid", "lastposttime", "upvotes", "downvotes", "postcount", "pinned"\n' +
    "      ]);\n\n" +
    "      const sortMap = {\n" +
    "        recent: sortRecent,\n" +
    "        old: sortOld,\n" +
    "        posts: sortPopular,\n" +
    "        votes: sortVotes,\n" +
    "      };\n" +
    "      const sortFn = sortMap[params.sort] || sortRecent;\n\n" +
    "      if (params.floatPinned) {\n" +
    "        floatPinned(topicData, sortFn);\n" +
    "      } else {\n" +
    "        topicData.sort(sortFn);\n" +
    "      }\n" +
    "      return topicData;\n" +
    "    },\n" +
    "  };\n\n" +
    "  async function getTagTids(params) {\n" +
    "    const sets = [\n" +
    "      params.sort === 'old' ? 'topics:recent' : `topics:${params.sort}`,\n" +
    '      ...params.tags.map((tag) => `tag:${tag}:topics`),\n' +
    "    ];\n" +
    "    const method = params.sort === 'old' ? 'getSortedSetIntersect' : 'getSortedSetRevIntersect';\n" +
    "    return await db[method]({\n" +
    "      sets,\n" +
    "      start: 0,\n" +
    "      stop: meta.config.recentMaxTopics - 1,\n" +
    "    });\n" +
    "  }\n\n" +
    "  async function getCidTids(params) {\n" +
    "    const sets = [];\n" +
    "    const pinnedSets = [];\n" +
    "    params.cids.forEach((cid) => {\n" +
    "      if (params.sort === 'recent' || params.sort === 'old') {\n" +
    "        sets.push(`cid:${cid}:tids`);\n" +
    "      } else {\n" +
    "        sets.push(`cid:${cid}:tids${params.sort ? `:${params.sort}` : ''}`);\n" +
    "      }\n" +
    "      pinnedSets.push(`cid:${cid}:tids:pinned`);\n" +
    "    });\n" +
    "    const pinnedTids = await db.getSortedSetRevRange(pinnedSets, 0, -1);\n" +
    "    const method = params.sort === 'old' ? 'getSortedSetRange' : 'getSortedSetRevRange';\n" +
    "    const tids = await db[method](sets, 0, meta.config.recentMaxTopics - 1);\n" +
    "    return pinnedTids.concat(tids);\n" +
    "  }\n\n" +
    "  function floatPinned(topics, sortFn) {\n" +
    "    const pinned = [];\n" +
    "    const notPinned = [];\n" +
    "    topics.forEach((topic) => {\n" +
    "      if (topic && topic.pinned) {\n" +
    "        pinned.push(topic);\n" +
    "      } else {\n" +
    "        notPinned.push(topic);\n" +
    "      }\n" +
    "    });\n" +
    "    pinned.sort(sortFn);\n" +
    "    notPinned.sort(sortFn);\n" +
    "    topics.length = 0;\n" +
    "    topics.push(...pinned, ...notPinned);\n" +
    "  }\n\n" +
    "  function sortRecent(a, b) {\n" +
    "    return b.lastposttime - a.lastposttime;\n" +
    "  }\n\n" +
    "  function sortOld(a, b) {\n" +
    "    return a.lastposttime - b.lastposttime;\n" +
    "  }\n\n" +
    "  function sortPopular(a, b) {\n" +
    "    return b.postcount - a.postcount;\n" +
    "  }\n\n" +
    "  function sortVotes(a, b) {\n" +
    "    return (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes);\n" +
    "  }\n\n" +
    "  return Topics;\n" +
    "}\n",
  "LIVE-RED-HERRING-CIRCULAR-DECOY":
    "export class OrderService {\n" +
    "  constructor(db) {\n" +
    "    this.db = db;\n" +
    "  }\n\n" +
    "  async checkoutOrder(orderInput, requestContext = null) {\n" +
    '    if (!orderInput || typeof orderInput.total !== "number") {\n' +
    '      throw new Error("Invalid order input");\n' +
    "    }\n" +
    '    const orderId = "ord_" + Math.random().toString(36).slice(2, 9);\n' +
    "    const order = {\n" +
    "      id: orderId,\n" +
    "      total: orderInput.total,\n" +
    "      items: orderInput.items || [],\n" +
    "      audit: requestContext ? {\n" +
    "        traceId: requestContext.traceId || null,\n" +
    "        userId: requestContext.userId || null,\n" +
    "      } : null,\n" +
    "    };\n" +
    "    return order;\n" +
    "  }\n" +
    "}\n",
  "LIVE-DISTRIBUTED-CONTRACT-RACE": {
    "src/contracts/protocol.js":
      'export const PROTOCOL_VERSION = "2.0.0";\n' +
      'export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP"];\n' +
      'export const GATEWAY_ACTIONS = ["ROUTE_PAYMENT", "REFUND_PAYMENT"];\n' +
      'export const BILLING_STATUSES = ["SETTLED", "REJECTED", "PENDING"];\n',
    "src/services/gateway.js":
      'import { PROTOCOL_VERSION, SUPPORTED_CURRENCIES, GATEWAY_ACTIONS } from "../contracts/protocol.js";\n\n' +
      "export function routeBillingRequest(request) {\n" +
      "  if (!request.idempotencyKey) {\n" +
      '    throw new Error("Missing idempotencyKey");\n' +
      "  }\n" +
      "  if (!request.currency || !SUPPORTED_CURRENCIES.includes(request.currency)) {\n" +
      '    throw new Error("Unsupported currency: " + request.currency);\n' +
      "  }\n" +
      "  return {\n" +
      "    routed: true,\n" +
      "    version: PROTOCOL_VERSION,\n" +
      "    action: GATEWAY_ACTIONS[0],\n" +
      "    idempotencyKey: request.idempotencyKey,\n" +
      "    payload: request,\n" +
      "  };\n" +
      "}\n",
    "src/services/billing.js":
      'import { PROTOCOL_VERSION, BILLING_STATUSES } from "../contracts/protocol.js";\n\n' +
      "export function settleTransaction(routedRequest) {\n" +
      "  return {\n" +
      "    status: BILLING_STATUSES[0],\n" +
      "    version: PROTOCOL_VERSION,\n" +
      "    cents: Math.round(Number(routedRequest.payload.amount) * 100),\n" +
      "    idempotencyKey: routedRequest.idempotencyKey,\n" +
      "  };\n" +
      "}\n",
  },
};

const CANONICAL_SEMVER_HYPHEN_PATCH =
  "  const hyphen = range.match(/^(\\S+)\\s+-\\s+(\\S+)$/);\n" +
  "  if (hyphen) {\n" +
  "    const lo = parseVersion(hyphen[1]);\n" +
  "    const hi = parseVersion(hyphen[2]);\n" +
  "    if (v.prerelease !== null) {\n" +
  "      const sameMinorPair = (b) => v.major === b.major && v.minor === b.minor;\n" +
  "      if (!sameMinorPair(lo) && !sameMinorPair(hi)) return false;\n" +
  "    }\n" +
  "    return compareVersions(v, lo) >= 0 && compareVersions(v, hi) <= 0;\n" +
  "  }\n";

export async function offlineSelftest(opts = {}) {
  const silent = Boolean(opts && opts.silent);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-boost-selftest-"));
  const checks = [];
  const check = (name, cond, detail = "") => {
    checks.push({ name, ok: Boolean(cond), detail });
    if (!silent) {
      console.log(`  ${cond ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  if (!silent) {
    console.log("agent-boost live harness — OFFLINE SELF-TEST (no API calls)\n");
  }

  for (const task of LIVE_TASKS) {
    const buggyWs = path.join(root, `${task.id}-buggy`);
    fs.mkdirSync(buggyWs, { recursive: true });
    task.fixture(buggyWs);
    const buggyRun = runNodeTest(buggyWs);
    const buggyParsed = parseTestOutcome(buggyRun);

    if (task.fixtureHasTests) {
      check(
        `${task.id}: fixture tests run and FAIL on the seeded bug`,
        buggyRun.exitCode !== 0 && (buggyParsed.failCount || 0) > 0,
        `exit=${buggyRun.exitCode} fail=${buggyParsed.failCount} (${buggyParsed.failingNames.slice(0, 2).join("; ")})`,
      );
      if (task.expectedBaselineFails === 0) {
        // Baseline-only integrity: every failing test must be a target test.
        check(
          `${task.id}: buggy fixture fails only target tests (baseline intact)`,
          buggyParsed.failCount === countTargetTests(task),
          `fail=${buggyParsed.failCount}`,
        );
      }
    } else {
      check(
        `${task.id}: no-test fixture runs zero tests (verifyCommand null)`,
        (buggyParsed.passCount || 0) === 0 && (buggyParsed.failCount || 0) === 0,
        `exit=${buggyRun.exitCode}`,
      );
    }

    // Canonical fix must turn the workspace fully green.
    const fixedWs = path.join(root, `${task.id}-fixed`);
    fs.mkdirSync(fixedWs, { recursive: true });
    task.fixture(fixedWs);
    if (task.id === "LIVE-SEMVER-REGRESSION") {
      const orig = fs.readFileSync(path.join(fixedWs, "src/semver.js"), "utf8");
      const buggyHyphen = orig.slice(
        orig.indexOf("  const hyphen ="),
        orig.indexOf("  const ex = parseVersion(range);"),
      );
      fs.writeFileSync(
        path.join(fixedWs, "src/semver.js"),
        orig.replace(buggyHyphen, CANONICAL_SEMVER_HYPHEN_PATCH + "\n"),
        "utf8",
      );
    } else if (task.id === "LIVE-EXPRESS-RACE") {
      fs.writeFileSync(path.join(fixedWs, "src/server.js"), CANONICAL_FIXES[task.id], "utf8");
    } else if (task.id === "LIVE-BLIND-FAULT-LOCALIZATION") {
      fs.writeFileSync(path.join(fixedWs, "src/services/pricing.service.js"), CANONICAL_FIXES[task.id], "utf8");
    } else if (task.id === "LIVE-HARNESS-INV-DUAL-PACKAGE") {
      fs.writeFileSync(path.join(fixedWs, "package.json"), CANONICAL_FIXES[task.id], "utf8");
    } else if (task.id === "LIVE-SWE-BENCH-PRO-NODEBB") {
      fs.writeFileSync(path.join(fixedWs, "src/topics/sorted.js"), CANONICAL_FIXES[task.id], "utf8");
    } else if (task.id === "LIVE-RED-HERRING-CIRCULAR-DECOY") {
      fs.writeFileSync(path.join(fixedWs, "src/services/order-service.js"), CANONICAL_FIXES[task.id], "utf8");
    } else if (task.id === "LIVE-DISTRIBUTED-CONTRACT-RACE") {
      writeWorkspaceFiles(fixedWs, CANONICAL_FIXES[task.id]);
    } else if (task.sourceFiles.length === 1 && CANONICAL_FIXES[task.id]) {
      fs.writeFileSync(path.join(fixedWs, task.sourceFiles[0]), CANONICAL_FIXES[task.id], "utf8");
    }
    if (task.hiddenPostTest) {
      writeWorkspaceFiles(fixedWs, { [task.hiddenPostTest]: task.hiddenPostContent });
    }
    const fixedRun = runNodeTest(fixedWs);
    check(
      `${task.id}: canonical fix turns the suite fully green`,
      fixedRun.exitCode === 0,
      `exit=${fixedRun.exitCode} ${parseTestOutcome(fixedRun).failCount || 0} failing`,
    );
  }

  // Git checkpoint / hard-reset roundtrip.
  const gitWs = path.join(root, "git-roundtrip");
  fs.mkdirSync(gitWs, { recursive: true });
  fs.writeFileSync(path.join(gitWs, "a.txt"), "good\n", "utf8");
  const fixtureSha = gitInitFixture(gitWs);
  fs.writeFileSync(path.join(gitWs, "a.txt"), "poisoned\n", "utf8");
  gitResetHard(gitWs, fixtureSha);
  const restored = fs.readFileSync(path.join(gitWs, "a.txt"), "utf8");
  check("git machinery: reset --hard restores checkpoint content", restored === "good\n");
  check(
    "git machinery: reflog records the reset",
    gitReflog(gitWs).some((l) => l.includes("reset")),
  );

  // verify-gate SSOT functions smoke checks.
  const conflicts = detectTargetFileConflicts([
    { title: "A", kind: "code", targetFiles: ["src/server.js"] },
    { title: "B", kind: "code", targetFiles: ["src/server.js"] },
  ]);
  check("verify-gate: detectTargetFileConflicts flags shared file", conflicts.length === 1 && conflicts[0].file === "src/server.js");
  check(
    "verify-gate: computeFailureSignature is deterministic",
    computeFailureSignature("fail x.js:12") === computeFailureSignature("fail x.js:13"),
  );
  const gated = calculateYardstickScore([
    { what: "test failure", evidence: "t", severity: "high", status: "verified", criterion: "operational_fitness" },
  ]);
  check("verify-gate: yardstick gate blocks high-severity finding", gated.passed === false);
  const cue = matchExperienceCues(
    "<experience>\ndimension: INV\ncue: semver prerelease hyphen range\ntest lesson words\nverdict: helped\nconfidence: high\nevidence: e\n</experience>",
    "fix semver prerelease hyphen range regression",
    1,
  );
  check("verify-gate: matchExperienceCues recalls stored card", cue.includes("<experience>"));
  check(
    "verify-gate: formatExperienceEntry rejects confounded verdicts",
    formatExperienceEntry({ cue: "c", lesson: "l", dimension: "INV", verdict: "confounded", confidence: "low", evidence: "e" }) === "NO_ENTRY",
  );
  check(
    "verify-gate: evaluateTaskComplexity assigns hard tier to concurrency text",
    evaluateTaskComplexity("fix race condition in limiter", "", 1).complexity === "hard",
  );

  fs.rmSync(root, { recursive: true, force: true });
  const failed = checks.filter((c) => !c.ok);
  if (!silent) {
    console.log(
      `\nself-test: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? " — FAILED" : ""}`,
    );
  }
  process.exitCode = failed.length ? 1 : 0;
  return { ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed: failed.length, checks };
}

function countTargetTests(task) {
  // Tasks with expectedBaselineFails === 0: seeded bug must fail only the
  // tests whose names mark the new behavior. Counted from the fixture text.
  const map = {
    "LIVE-SEMVER-REGRESSION": 1,
    "LIVE-TOKENIZER-BOUNDARY": 1,
    "LIVE-RATELIMIT-RACE": 1,
    "LIVE-DIFF-PATCH-APPLY": 1,
    "LIVE-ASYNC-BATCH-POOL": 1,
    "LIVE-REDUX-STRUCTURAL-SHARING": 1,
    "LIVE-GRAPH-CYCLE-DEADLOCK": 1,
    "LIVE-CACHE-STAMPEDE-MUTEX": 1,
    "LIVE-CASCADE-EVENT-BUS": 1,
    "LIVE-SQLITE-SCHEMA-MIGRATION": 1,
    "LIVE-BLIND-FAULT-LOCALIZATION": 1,
    "LIVE-HARNESS-INV-DUAL-PACKAGE": 1,
    "LIVE-LONG-HORIZON-RESOURCE-LEAK": 1,
    "LIVE-SWE-BENCH-PRO-NODEBB": 1,
    "LIVE-RED-HERRING-CIRCULAR-DECOY": 1,
    "LIVE-DISTRIBUTED-CONTRACT-RACE": 2,
  };
  return map[task.id] ?? 0;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: null, html: null, tasks: null, selftest: false, help: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = argv[++i];
    else if (argv[i] === "--html") out.html = argv[++i];
    else if (argv[i] === "--model") out.model = argv[++i];
    else if (argv[i] === "--offline-selftest") out.selftest = true;
    else if (argv[i] === "--tasks") out.tasks = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("run-live-benchmarks.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Usage:
  node scripts/run-live-benchmarks.mjs [options]
  npm run benchmark:live

Options:
  --help, -h            Show this help message
  --offline-selftest    Run 60 offline harness validation checks (no API calls)
  --tasks <id1,id2>     Run specific tasks by ID (comma-separated)
  --model <name>        Override model name (e.g. deepseek-v4.1-flash)
  --json <path>         Write results summary JSON to file
  --html <path>         Write interactive HTML report to file
`);
    process.exit(0);
  } else if (args.selftest) {
    offlineSelftest();
  } else {
    runLiveBenchmarks({ tasks: args.tasks, model: args.model })
      .then((summary) => {
        if (!summary) return;
        if (args.json) {
          fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
          fs.writeFileSync(args.json, JSON.stringify(summary, null, 2), "utf8");
          console.log(`results JSON written to ${args.json}`);
        }
        const htmlPath = args.html || path.join(REPO_ROOT, "live-results", "report.html");
        try {
          fs.mkdirSync(path.dirname(path.resolve(htmlPath)), { recursive: true });
          const html = generateHtmlReport(summary);
          fs.writeFileSync(htmlPath, html, "utf8");
          console.log(`interactive HTML report written to ${htmlPath}`);
        } catch (err) {
          console.error("Failed to generate HTML report:", err);
        }
        // Exit 0 when the live run completed; outcome deltas are empirical
        // results, not CI gate conditions.
        process.exitCode = 0;
      })
      .catch((err) => {
        console.error("Live benchmark runner error:", err);
        process.exitCode = 1;
      });
  }
}
