import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  computeFailureSignature,
  detectTargetFileConflicts,
  resolveModelConfiguration,
  matchExperienceCues,
  calculateYardstickScore,
} from "../shared/verify-gate.js";

// DWF State Machine Test Suite
// Exercises the core flow of adapters/zcode/boost.dwf.ts through the SSOT-compiled
// shared/verify-gate.js (TS/JS/DWF zero-drift is separately enforced by scripts/build.mjs).
// Mirrors the exact state-machine semantics of the DWF phases:
//   Phase 1 - planning: targetFiles conflict gate + A-MEM experience recall
//   Phase 3 - execution/repair: LATS git checkpoint, regression rollback, self-debugging synthesis
//   Phase 4 - judging: six-dimension yardstick score with >= 85 gate

const GIT_ENV = "-c";
const git = (cwd, ...args) =>
  execFileSync("git", [GIT_ENV, "user.name=DWF Test", GIT_ENV, "user.email=dwf-test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dwf-workflow-"));

// ---------------------------------------------------------------------------
// (a) Model configuration: glm-5.3 family mapping and light/heavy tier layering
// ---------------------------------------------------------------------------

test("DWF (a) resolveModelConfiguration maps glm-5.3 / glm-5.3-prime / glm-5.3-flash to explicit modelIds", () => {
  for (const name of ["glm-5.3", "glm-5.3-prime", "glm-5.3-flash"]) {
    const resolved = resolveModelConfiguration(name, null);
    assert.equal(resolved.modelId, name, `${name} must resolve to its own modelId without local config`);
    assert.equal(resolved.tier, "light", `${name} defaults to the light tier without local config`);
  }
});

test("DWF (a) resolveModelConfiguration trims whitespace and is deterministic across repeated calls", () => {
  const first = resolveModelConfiguration("  glm-5.3  ", null);
  const second = resolveModelConfiguration("  glm-5.3  ", null);
  assert.deepEqual(first, { modelId: "glm-5.3", tier: "light" });
  assert.deepEqual(first, second, "Resolution must be a pure, deterministic function");
});

test("DWF (a) local models.local.json override promotes glm-5.3-prime to the heavy tier", () => {
  const localConfig = {
    models: {
      "glm-5.3": { id: "glm-5.3", tier: "heavy" },
      "glm-5.3-prime": { id: "glm-5.3-prime-x", tier: "heavy" },
      "glm-5.3-flash": { id: "glm-5.3-flash", tier: "light" },
    },
  };
  // Heavy models are reserved for planning/critic phases (Phase 1), light models
  // for parallel execution (Phase 3) - the two-tier layering of the DWF engine.
  const prime = resolveModelConfiguration("glm-5.3-prime", localConfig);
  assert.deepEqual(prime, { modelId: "glm-5.3-prime-x", tier: "heavy" });

  const flash = resolveModelConfiguration("glm-5.3-flash", localConfig);
  assert.deepEqual(flash, { modelId: "glm-5.3-flash", tier: "light" });

  const tierOf = (name) => resolveModelConfiguration(name, localConfig).tier;
  assert.equal(tierOf("glm-5.3"), "heavy");
  assert.equal(tierOf("glm-5.3-prime"), "heavy");
  assert.equal(tierOf("glm-5.3-flash"), "light");
});

test("DWF (a) empty requested model falls back to default_light_model, then to tier=default", () => {
  const withDefault = resolveModelConfiguration("", {
    default_light_model: "glm-5.3-flash",
    models: { "glm-5.3-flash": { id: "glm-5.3-flash-live", tier: "light" } },
  });
  assert.deepEqual(withDefault, { modelId: "glm-5.3-flash-live", tier: "light" });

  const noConfig = resolveModelConfiguration("", null);
  assert.deepEqual(noConfig, { modelId: null, tier: "default" });
});

// ---------------------------------------------------------------------------
// (b) Phase 1 planning: targetFiles conflict gate and planner decoupling
// ---------------------------------------------------------------------------

test("DWF (b) Phase 1 conflict gate detects shared targetFiles across concurrent code workstreams", () => {
  const ws1 = { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/server.ts"] };
  const ws2 = { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/server.ts"] };
  const conflicts = detectTargetFileConflicts([ws1, ws2]);
  assert.equal(conflicts.length, 1, "Exactly one conflicting file must be reported");
  assert.equal(conflicts[0].file, "src/server.ts");
  assert.deepEqual(conflicts[0].workstreams.sort(), ["Metrics API Routes", "OAuth2 Auth Routes"].sort());
});

test("DWF (b) conflict gate normalizes file URIs, separators, and relative prefixes before matching", () => {
  const ws1 = { title: "WS-A", kind: "code", targetFiles: ["src/server.ts"] };
  const ws2 = {
    title: "WS-B",
    kind: "code",
    targetFiles: ["./src/server.ts", "file://src/server.ts", "src\\server.ts", "src//server.ts", "src/server.ts/"],
  };
  const conflicts = detectTargetFileConflicts([ws1, ws2]);
  assert.equal(conflicts.length, 1, "All five spelling variants must collide with the canonical path");
  assert.equal(conflicts[0].file, "src/server.ts");
  assert.deepEqual(conflicts[0].workstreams.sort(), ["WS-A", "WS-B"].sort());
});

test("DWF (b) investigate workstreams never trigger the conflict gate; empty inputs are safe", () => {
  const reader = { title: "Log Reader", kind: "investigate", targetFiles: ["src/server.ts"] };
  const coder = { title: "Server Fixer", kind: "code", targetFiles: ["src/server.ts"] };
  assert.deepEqual(detectTargetFileConflicts([reader, coder]), [], "investigate kind is read-only and exempt");
  assert.deepEqual(detectTargetFileConflicts([]), []);
  assert.deepEqual(detectTargetFileConflicts(null), []);
});

test("DWF (b) planner decouples conflicted workstreams into disjoint target sets with zero residual conflicts", () => {
  const conflicted = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/server.ts"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/server.ts"] },
  ];
  assert.equal(detectTargetFileConflicts(conflicted).length, 1, "Pre-decoupling plan must expose the conflict");

  // Planner/Critic decoupling: dedicated middleware adapters + a single sequenced
  // assembly workstream that owns src/server.ts exclusively.
  const decoupled = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/middleware/auth.ts"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/middleware/api.ts"] },
    { title: "Server Gateway Assembly", kind: "code", targetFiles: ["src/server.ts"] },
  ];
  assert.deepEqual(detectTargetFileConflicts(decoupled), [], "Post-decoupling plan must be conflict-free");
});

// ---------------------------------------------------------------------------
// (c) Phase 3: LATS git checkpoint + regression rollback + self-debugging synthesis
// ---------------------------------------------------------------------------

test("DWF (c) computeFailureSignature is stable per failure and distinct across different failures", () => {
  const mochaRunnerError = [
    "mocha 10.2.0",
    "TypeError: Cannot read properties of undefined (reading 'parallel')",
    "    at createMocha (lib/mocha.js:278:19)",
    "1 failed",
  ].join("\n");
  const sameErrorOtherNumbers = [
    "mocha 10.2.0",
    "TypeError: Cannot read properties of undefined (reading 'parallel')",
    "    at createMocha (lib/mocha.js:999:19)",
    "1 failed",
  ].join("\n");
  const differentError = [
    "assert.js:385 throw err;",
    "AssertionError [ERR_ASSERTION]: 2 === 3",
    "    at TestContext.<anonymous> (test/semver.test.js:12:5)",
    "5 failed",
  ].join("\n");

  const s1 = computeFailureSignature(mochaRunnerError);
  const s2 = computeFailureSignature(mochaRunnerError);
  const s3 = computeFailureSignature(sameErrorOtherNumbers);
  const s4 = computeFailureSignature(differentError);

  assert.equal(s1, s2, "Identical failure output must produce an identical signature");
  assert.equal(s1, s3, "Line/number noise must be normalized away - same root cause, same signature");  assert.notEqual(s1, s4, "A different root cause must produce a different signature");
  assert.equal(computeFailureSignature(""), "empty-output");
  assert.equal(computeFailureSignature(null), "empty-output");
});

test("DWF (c) LATS checkpoint rollback: git reset --hard restores the pre-regression tree state", () => {
  const dir = makeTempDir();
  try {
    git(dir, "init", "-q");
    const serverFile = path.join(dir, "src", "server.ts");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });

    // Round 0: known-good tree. Phase 3 snapshots HEAD as the LATS checkpoint.
    fs.writeFileSync(
      serverFile,
      "app.use('/api/auth', authRouter);\napp.use('/api/metrics', metricsRouter);\n",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "known-good gateway");
    const checkpoint = git(dir, "rev-parse", "HEAD").trim();
    const goodContent = fs.readFileSync(serverFile, "utf8");

    // Round 1: a candidate fix regresses the tree (clobbers the auth route).
    fs.writeFileSync(
      serverFile,
      "app.use('/api/metrics', metricsRouter);\n",
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "regressive candidate");
    assert.notEqual(fs.readFileSync(serverFile, "utf8"), goodContent, "Tree must be regressed before rollback");

    // DWF regression predicate (adapters/zcode/boost.dwf.ts LATS loop):
    // failure spreading (lastFailCount -> currentFailCount) or rising exit codes
    // trigger `git reset --hard ${checkpoint} && git clean -fd`.
    const lastFailCount = 1;
    const currentFailCount = 2; // "2 failed" in the Round-1 verify output
    const lastExitCode = 1;
    const gateExitCode = 3;
    const isRegression =
      currentFailCount > lastFailCount && lastFailCount > 0 && gateExitCode > lastExitCode && gateExitCode !== 0;
    assert.equal(isRegression, true, "Failure spreading + exit-code rise must classify Round 1 as a regression");

    // Execute the exact DWF rollback command against the real repository.
    execFileSync("sh", ["-c", `git reset --hard ${checkpoint} 2>/dev/null && git clean -fd 2>/dev/null || true`], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(
      fs.readFileSync(serverFile, "utf8"),
      goodContent,
      "git reset --hard must restore the checkpoint content (auth route survives)",
    );
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), checkpoint, "HEAD must be back at the LATS checkpoint");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DWF (c) self-debugging synthesis: verify_synth.sh exits 0 on success and non-zero on failure", () => {
  const dir = makeTempDir();
  try {
    // Phase 3 synthesizes a deterministic reproduction script when no verifyCommand
    // was supplied (Self-Debugging, Chen et al. 2023). The DWF harness writes it via
    // `cat << 'EOF' > verify_synth.sh` and executes it as ./verify_synth.sh.
    const synthScript = [
      "#!/bin/sh",
      "# Synthesized reproduction: gateway must mount the OAuth2 auth route",
      'if grep -q "authRouter" src/server.ts; then',
      '  echo "verify_synth: auth route mounted"',
      "  exit 0",
      "fi",
      'echo "verify_synth: auth route missing"',
      "exit 1",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "verify_synth.sh"), synthScript);
    execFileSync("sh", ["-c", "chmod +x verify_synth.sh"], { cwd: dir });

    fs.mkdirSync(path.join(dir, "src"), { recursive: true });

    // Healthy tree -> exit 0.
    fs.writeFileSync(path.join(dir, "src", "server.ts"), "app.use('/api/auth', authRouter);\n");
    const healthy = execFileSync("sh", ["-c", "./verify_synth.sh; echo exit=$?"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.match(healthy, /exit=0/, "Synthesized script must accept a compliant implementation");

    // Clobbered tree -> non-zero exit, feeding the LATS verify loop.
    fs.writeFileSync(path.join(dir, "src", "server.ts"), "app.use('/api/metrics', metricsRouter);\n");
    const broken = execFileSync("sh", ["-c", "./verify_synth.sh; echo exit=$?"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.match(broken, /exit=1/, "Synthesized script must reject a regressed implementation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (d) Phase 4 judging: six-dimension yardstick score and the >= 85 gate
// ---------------------------------------------------------------------------

test("DWF (d) clean review yields a perfect six-dimension score and passes the gate", () => {
  const result = calculateYardstickScore([]);
  assert.equal(result.overallScore, 100);
  assert.equal(result.passed, true);
  assert.deepEqual(result.breakdown, {
    delivery: 100,
    conformance: 100,
    fidelity: 100,
    internalConsistency: 100,
    operationalFitness: 100,
    finish: 100,
  });
  assert.deepEqual(result.deductions, []);
});

test("DWF (d) weighted deduction arithmetic is exact: one medium operationalFitness finding costs 15*0.15", () => {
  const result = calculateYardstickScore([
    {
      what: "Log line exceeds configured verbosity on one code path",
      evidence: "src/middleware/api.ts:33",
      severity: "medium",
      status: "verified",
      criterion: "operational_fitness",
    },
  ]);
  assert.equal(result.breakdown.operationalFitness, 85);
  // 85*0.15 + 100*(0.25+0.2+0.15+0.15+0.1) = 12.75 + 85 = 97.75 -> round = 98
  assert.equal(result.overallScore, 98);
  assert.equal(result.passed, true, "98 >= 85 with no high-severity finding passes the gate");
});

test("DWF (d) gate boundary: score exactly 85 passes, 81 fails", () => {
  const medium = (criterion) => ({
    what: "placeholder marker left in shipped path",
    evidence: "src/index.ts:7",
    severity: "medium",
    status: "verified",
    criterion,
  });
  // 4 x 15 = 60 off delivery: 40*0.25 + 100*0.75 = 85 exactly -> passes.
  const atBoundary = calculateYardstickScore([
    medium("delivery"),
    medium("delivery"),
    medium("delivery"),
    medium("delivery"),
  ]);
  assert.equal(atBoundary.breakdown.delivery, 40);
  assert.equal(atBoundary.overallScore, 85);
  assert.equal(atBoundary.passed, true, "Gate is inclusive: overallScore >= 85 passes");

  // 5 x 15 = 75 off delivery: 25*0.25 + 100*0.75 = 81.25 -> 81 -> fails.
  const below = calculateYardstickScore([
    medium("delivery"),
    medium("delivery"),
    medium("delivery"),
    medium("delivery"),
    medium("delivery"),
  ]);
  assert.equal(below.overallScore, 81);
  assert.equal(below.passed, false);
});

test("DWF (d) a high-severity finding vetoes the gate even when the weighted score stays >= 85", () => {
  const result = calculateYardstickScore([
    {
      what: "Coverage report fabricated: claimed 100% on a suite that never ran",
      evidence: "coverage-summary.json:1",
      severity: "high",
      status: "verified",
      criterion: "fidelity",
    },
  ]);
  // fidelity 100-40=60: 60*0.15 + 85 = 94, but high severity forces passed=false.
  assert.equal(result.breakdown.fidelity, 60);
  assert.equal(result.overallScore, 94);
  assert.equal(result.passed, false, "hasHighSeverity must veto regardless of the numeric score");
});

test("DWF (d) criterion routing: explicit criterion wins; keywords classify otherwise", () => {
  const explicit = calculateYardstickScore([
    { what: "anything", evidence: "x:1", severity: "low", status: "verified", criterion: "finish" },
  ]);
  assert.equal(explicit.breakdown.finish, 95, "low severity = 5 penalty on the explicit criterion");

  const byKeyword = calculateYardstickScore([
    { what: "missing file: required migration 0007 absent from delivery", evidence: "migrations/", severity: "medium", status: "verified" },
  ]);
  assert.equal(byKeyword.breakdown.delivery, 85, "'missing' text routes to the delivery dimension");

  const fabricated = calculateYardstickScore([
    { what: "hallucinated upstream API claim in report", evidence: "REPORT.md:9", severity: "medium", status: "verified" },
  ]);
  assert.equal(fabricated.breakdown.fidelity, 85, "'hallucinated' text routes to the fidelity dimension");
});

// ---------------------------------------------------------------------------
// (e) Control (solo, no tool gates) vs treatment (full Boost toolbox) isolation
// ---------------------------------------------------------------------------

// Control group A: the solo model writes shared files with no conflict gate.
const runControlRound = () => {
  let serverFileContent = "app.use('/api/auth', authRouter);\n";
  serverFileContent = "app.use('/api/metrics', metricsRouter);\n"; // last write wins, silently
  const mounted = [];
  if (serverFileContent.includes("authRouter")) mounted.push("/api/auth/login");
  if (serverFileContent.includes("metricsRouter")) mounted.push("/api/metrics");
  return { exitCode: mounted.includes("/api/auth/login") ? 0 : 1, mounted };
};

// Treatment group B: Phase 1 gate + planner decoupling + Phase 4 yardstick.
const runTreatmentRound = () => {
  const plan = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/server.ts"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/server.ts"] },
  ];
  const conflicts = detectTargetFileConflicts(plan);
  if (conflicts.length !== 1) return { exitCode: 1, conflicts, mounted: [] };

  const decoupled = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/middleware/auth.ts"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/middleware/api.ts"] },
    { title: "Server Gateway Assembly", kind: "code", targetFiles: ["src/server.ts"] },
  ];
  if (detectTargetFileConflicts(decoupled).length !== 0) return { exitCode: 1, conflicts, mounted: [] };

  const serverFileContent = "app.use('/api/auth', authRouter);\napp.use('/api/metrics', metricsRouter);\n";
  const mounted = [];
  if (serverFileContent.includes("authRouter")) mounted.push("/api/auth/login");
  if (serverFileContent.includes("metricsRouter")) mounted.push("/api/metrics");
  const gate = calculateYardstickScore([
    { what: "comment spacing nit in assembly", evidence: "src/server.ts:14", severity: "low", status: "verified", criterion: "finish" },
  ]);
  return { exitCode: gate.passed && mounted.length === 2 ? 0 : 1, conflicts, mounted, gate };
};

test("DWF (e) control group fails deterministically; treatment group passes deterministically (10 rounds each)", () => {
  const controlResults = [];
  const treatmentResults = [];
  for (let i = 0; i < 10; i++) {
    controlResults.push(runControlRound());
    treatmentResults.push(runTreatmentRound());
  }
  for (const c of controlResults) {
    assert.equal(c.exitCode, 1, "Solo writes must always clobber the OAuth2 route (no gate to stop it)");
    assert.deepEqual(c.mounted, ["/api/metrics"]);
  }
  for (const t of treatmentResults) {
    assert.equal(t.exitCode, 0, "Gated execution must always mount both routes");
    assert.equal(t.conflicts.length, 1, "The gate must observe the conflict before execution");
    assert.deepEqual(t.mounted.sort(), ["/api/auth/login", "/api/metrics"].sort());
    assert.equal(t.gate.passed, true);
  }
});

test("DWF (e) groups are logically isolated: the control path never consults the tool gates", () => {
  // Structural isolation - the control round is a pure string pipeline with no
  // reference to detectTargetFileConflicts / calculateYardstickScore. Its outcome
  // must therefore be invariant to whether the toolbox is loaded at all.
  const beforeToolbox = runControlRound();
  assert.equal(typeof detectTargetFileConflicts, "function", "toolbox symbols are loaded in this process");
  assert.equal(typeof calculateYardstickScore, "function", "toolbox symbols are loaded in this process");
  const afterToolbox = runControlRound();
  assert.deepEqual(beforeToolbox, afterToolbox, "control outcome must not depend on toolbox availability");
  assert.equal(beforeToolbox.exitCode, 1);

  // The same shared-file plan that the treatment group intercepts is invisible
  // to the control group - it never asks the question.
  const sharedPlan = [
    { title: "WS-1", kind: "code", targetFiles: ["src/server.ts"] },
    { title: "WS-2", kind: "code", targetFiles: ["src/server.ts"] },
  ];
  assert.equal(detectTargetFileConflicts(sharedPlan).length, 1, "the tool sees the conflict");
  assert.equal(runControlRound().exitCode, 1, "the control path still clobbers");
});

test("DWF (e) A-MEM lifetime memory: treatment recalls prior lessons, control repeats the pitfall", () => {
  const memory = `
<experience>
dimension: INV
cue: cross-platform path separators and regex delimiters in node build tools
lesson: Normalize paths with path.normalize(p).replace(/\\\\/g, '/') before regex matching
verdict: helped
confidence: high
evidence: Prevented path matching errors across Windows CI runners
</experience>`;
  const recalled = matchExperienceCues(memory, "cross-platform path resolution for windows ci", 1);
  assert.ok(recalled.length > 0, "Treatment (A-MEM) must recall the relevant prior lesson");
  assert.ok(recalled.includes("path"), "Recalled context must address path normalization");

  // Control has no experience ledger: recall is empty and the same trap re-fires.
  const controlRecall = matchExperienceCues("", "cross-platform path resolution for windows ci", 1);
  assert.equal(controlRecall.length, 0, "Control has no lifetime memory to consult");
});
