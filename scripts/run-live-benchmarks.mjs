#!/usr/bin/env node
/**
 * LIVE API End-to-End Benchmark Runner for agent-boost (v0.4.0)
 * Comparison frame: Solo mimo-v2.6-flash (single model, no tools)
 *                 vs mimo-v2.6-flash + agent-boost v0.4.0 (model + five-phase toolchain)
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
  maxTokens: 6144, // mimo spends completion tokens on reasoning before content
  plannerMaxTokens: 2048,
  judgeMaxTokens: 2048,
  requestTimeoutMs: 180_000,
  httpRetries: 3, // network error / 429 / 5xx
  retryBackoffMs: [3000, 9000],
  sessionId: `agent-boost-live-${crypto.randomUUID().slice(0, 8)}`,
  userAgent: "agent-boost-live-benchmark/0.4.0",
  soloMaxAttempts: 3,
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

async function boostPhase2Execute(task, ws, workstreams, records) {
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
      { tag: `boost:${task.id}:exec:${w.title}` },
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

async function boostPhase3VerifyAndRepair(task, ws, complexity, records, log, fixtureTests, fixtureSha, baselinePassingNames, mutableFiles) {
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
      { tag: `boost:${task.id}:repair:r${round}` },
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

  // Phase 2 — disjoint-ownership execution
  await boostPhase2Execute(task, ws, plan.workstreams, records);

  // Phase 3 — checkpoint, real tests, signature-scoped repair with rollback.
  // Repair scope covers every file a workstream owns (not just sourceFiles) —
  // a broken workstream output must stay reachable for the repair loop.
  const mutableFiles = [
    ...new Set([...task.sourceFiles, ...plan.workstreams.flatMap((w) => w.targetFiles)]),
  ];
  const verified = await boostPhase3VerifyAndRepair(
    task, ws, plan.complexity, records, log, fixtureTests, fixtureSha, baselinePassingNames, mutableFiles,
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
  log("  agent-boost v0.4.0 LIVE API End-to-End Benchmark Harness");
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

async function offlineSelftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-boost-selftest-"));
  const checks = [];
  const check = (name, cond, detail = "") => {
    checks.push({ name, ok: Boolean(cond), detail });
    console.log(`  ${cond ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  console.log("agent-boost live harness — OFFLINE SELF-TEST (no API calls)\n");

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
  console.log(
    `\nself-test: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? " — FAILED" : ""}`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

function countTargetTests(task) {
  // Tasks with expectedBaselineFails === 0: seeded bug must fail only the
  // tests whose names mark the new behavior. Counted from the fixture text.
  const map = {
    "LIVE-SEMVER-REGRESSION": 1,
    "LIVE-TOKENIZER-BOUNDARY": 1,
    "LIVE-RATELIMIT-RACE": 1,
  };
  return map[task.id] ?? 0;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: null, tasks: null, selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = argv[++i];
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
  --offline-selftest    Run 21 offline harness validation checks (no API calls)
  --tasks <id1,id2>     Run specific tasks by ID (comma-separated)
  --json <path>         Write results summary JSON to file
`);
    process.exit(0);
  } else if (args.selftest) {
    offlineSelftest();
  } else {
    runLiveBenchmarks({ tasks: args.tasks })
      .then((summary) => {
        if (!summary) return;
        if (args.json) {
          fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
          fs.writeFileSync(args.json, JSON.stringify(summary, null, 2), "utf8");
          console.log(`results JSON written to ${args.json}`);
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
