/**
 * DWF state-machine tests for adapters/zcode/boost.dwf.ts.
 *
 * Why this tests through shared/verify-gate.js instead of importing the DWF
 * file: boost.dwf.ts line 796 onwards runs the ZCode workflow DSL (args /
 * world.run / agent(...)) — globals that only exist inside the DWF runtime, so
 * plain Node cannot import that file. The 10 pure helpers embedded in
 * boost.dwf.ts between the "BEGIN/END SHARED VERIFY-GATE HELPERS" markers are
 * enforced parameter- and body-identical to shared/verify-gate.ts and
 * shared/verify-gate.js by scripts/build.mjs:364-425, and npm test runs that
 * build as its first step — so behavior asserted here against
 * shared/verify-gate.js holds for the DWF copy too. DSL-only mechanics (LATS
 * git checkpoint/rollback, verify_synth.sh synthesis, the >= 85 gate) are
 * covered by deterministic string assertions on the raw boost.dwf.ts source
 * read via node:fs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  resolveModelConfiguration,
  detectTargetFileConflicts,
  computeFailureSignature,
  calculateYardstickScore,
} from "../shared/verify-gate.js";

const dwfSource = fs.readFileSync(
  new URL("../adapters/zcode/boost.dwf.ts", import.meta.url),
  "utf8",
);

// ---------------------------------------------------------------------------
// Group 1: resolveModelConfiguration — model alias mapping and tiering
// ---------------------------------------------------------------------------

test("DWF 1a. resolveModelConfiguration maps entries of models.example.json with light/heavy tiering", () => {
  const modelsExample = JSON.parse(
    fs.readFileSync(new URL("../models.example.json", import.meta.url), "utf8"),
  );

  // Real entries shipped with the repo
  assert.deepEqual(resolveModelConfiguration("mimo-v2.6-flash", modelsExample), {
    modelId: "opencode/mimo-v2.6-flash",
    tier: "light",
  });
  assert.deepEqual(resolveModelConfiguration("claude-sonnet-5.5", modelsExample), {
    modelId: "anthropic/claude-sonnet-5.5",
    tier: "heavy",
  });

  // Light/heavy layering: flash is the light tier, sonnet the heavy tier
  const flash = resolveModelConfiguration("mimo-v2.6-flash", modelsExample);
  const sonnet = resolveModelConfiguration("claude-sonnet-5.5", modelsExample);
  assert.notEqual(flash.tier, sonnet.tier);
  assert.notEqual(flash.modelId, sonnet.modelId);

  // Every alias in the shipped config resolves to its declared id and tier
  for (const [alias, entry] of Object.entries(modelsExample.models)) {
    assert.deepEqual(
      resolveModelConfiguration(alias, modelsExample),
      { modelId: entry.id, tier: entry.tier },
      `alias "${alias}" must resolve to its declared entry`,
    );
  }

  // Whitespace around the requested name is trimmed before lookup
  assert.deepEqual(
    resolveModelConfiguration("  claude-sonnet-5.5  ", modelsExample),
    { modelId: "anthropic/claude-sonnet-5.5", tier: "heavy" },
  );
});

test("DWF 1b. resolveModelConfiguration: inline custom model fixture, unknown-alias passthrough, default_light_model fallback, empty-request default tier", () => {
  const customConfig = {
    default_light_model: "mimo-v2.6-flash",
    models: {
      "mimo-v2.6-flash": { id: "opencode/mimo-v2.6-flash", vendor: "opencode", tier: "heavy" },
    },
  };
  assert.deepEqual(resolveModelConfiguration("mimo-v2.6-flash", customConfig), {
    modelId: "opencode/mimo-v2.6-flash",
    tier: "heavy",
  });

  // Without local config the requested name passes through as the model id
  assert.deepEqual(resolveModelConfiguration("custom-model", null), {
    modelId: "custom-model",
    tier: "light",
  });

  // A models entry without an explicit tier defaults to "light"
  const noTierConfig = { models: { "custom-model": { id: "provider/custom-model" } } };
  assert.deepEqual(resolveModelConfiguration("custom-model", noTierConfig), {
    modelId: "provider/custom-model",
    tier: "light",
  });

  // An alias absent from the config passes through verbatim with tier light
  assert.deepEqual(
    resolveModelConfiguration("custom-vendor/unknown-model", customConfig),
    { modelId: "custom-vendor/unknown-model", tier: "light" },
  );

  // Empty request falls back to default_light_model ("mimo-v2.6-flash" -> opencode/mimo-v2.6-flash)
  assert.deepEqual(resolveModelConfiguration("", customConfig), {
    modelId: "opencode/mimo-v2.6-flash",
    tier: "light",
  });

  // Empty request against the shipped repo config resolves its own default
  const modelsExample = JSON.parse(
    fs.readFileSync(new URL("../models.example.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(resolveModelConfiguration("", modelsExample), {
    modelId: "anthropic/claude-haiku-5.5",
    tier: "light",
  });

  // Empty request with no usable config yields the tier:"default" sentinel
  assert.deepEqual(resolveModelConfiguration("", null), {
    modelId: null,
    tier: "default",
  });
  assert.deepEqual(resolveModelConfiguration("", { models: {} }), {
    modelId: null,
    tier: "default",
  });
});

// ---------------------------------------------------------------------------
// Group 2: Phase 1 planning — targetFiles conflict detection and decoupling
// ---------------------------------------------------------------------------

test("DWF 2a. detectTargetFileConflicts flags the Express-style shared-server overlap", () => {
  const ws1 = {
    title: "OAuth2 Auth Routes",
    kind: "code",
    targetFiles: ["src/routes/auth.ts", "src/server.ts"],
  };
  const ws2 = {
    title: "Metrics API Routes",
    kind: "code",
    targetFiles: ["src/routes/api.ts", "src/server.ts"],
  };

  const conflicts = detectTargetFileConflicts([ws1, ws2]);
  assert.equal(conflicts.length, 1, "exactly one file is double-owned");
  assert.equal(conflicts[0].file, "src/server.ts");
  assert.deepEqual(conflicts[0].workstreams.sort(), [
    "Metrics API Routes",
    "OAuth2 Auth Routes",
  ]);
});

test("DWF 2b. detectTargetFileConflicts exempts investigate workstreams; empty inputs are safe", () => {
  const code = {
    title: "OAuth2 Auth Routes",
    kind: "code",
    targetFiles: ["src/server.ts"],
  };
  const probeA = {
    title: "Route Registration Probe",
    kind: "investigate",
    targetFiles: ["src/server.ts"],
  };
  const probeB = {
    title: "Gateway Middleware Probe",
    kind: "investigate",
    targetFiles: ["src/server.ts"],
  };

  // Read-only investigation may share files with a writer and with each other
  assert.deepEqual(detectTargetFileConflicts([code, probeA, probeB]), []);
  assert.deepEqual(detectTargetFileConflicts([probeA, probeB]), []);
  assert.deepEqual(detectTargetFileConflicts([]), []);
  assert.deepEqual(detectTargetFileConflicts(null), []);
});

test("DWF 2c. detectTargetFileConflicts normalizes file://, backslash, leading-slash and relative spellings before comparing", () => {
  const wsA = {
    title: "Auth Gateway",
    kind: "code",
    targetFiles: ["file://src/server.ts"],
  };
  const wsB = {
    title: "Metrics Gateway",
    kind: "code",
    targetFiles: ["src\\server.ts"],
  };
  const wsC = {
    title: "Health Gateway",
    kind: "code",
    targetFiles: ["/src//server.ts", "./src/server.ts", "src/server.ts/"],
  };

  const conflicts = detectTargetFileConflicts([wsA, wsB, wsC]);
  assert.equal(conflicts.length, 1, "all spellings denote one canonical file");
  assert.equal(conflicts[0].file, "src/server.ts");
  assert.equal(conflicts[0].workstreams.length, 3);
});

test("DWF 2d. planner decoupling: disjoint workstreams produce zero residual conflicts", () => {
  // Same starting point as BUGSJS-EXPRESS-104: two code workstreams collide on
  // src/server.ts, so Phase 1 must intercept before execution begins
  const coupled = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/server.ts"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/server.ts"] },
  ];
  assert.equal(detectTargetFileConflicts(coupled).length, 1);

  // Decoupled plan: dedicated adapters per workstream plus a single sequenced
  // owner for the server entrypoint
  const decoupled = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.ts", "src/middleware/auth.ts"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.ts", "src/middleware/api.ts"] },
    { title: "Server Gateway Assembly", kind: "code", targetFiles: ["src/server.ts"] },
  ];
  assert.deepEqual(detectTargetFileConflicts(decoupled), []);
});

// ---------------------------------------------------------------------------
// Group 3: Phase 3 LATS — failure signature stability and source anchors
// ---------------------------------------------------------------------------

test("DWF 3a. computeFailureSignature diverges on SemVer-style regression semantics", () => {
  const regressionSurvivedBadPatch = [
    "SWE-BENCH SEMVER-RANGE REGRESSION",
    "AssertionError: semver.satisfies('1.9.0', '~1.2.3') must be false — range bypass admitted",
    "at /repo/test/version-range.js:88:9",
  ].join("\n");
  const regressionSurvivedOtherPatch = [
    "SWE-BENCH SEMVER-RANGE REGRESSION",
    "AssertionError: semver.satisfies('1.2.9', '~1.2.3') must be false — range bypass admitted",
    "at /repo/test/version-range.js:88:9",
  ].join("\n");

  const sigBad = computeFailureSignature(regressionSurvivedBadPatch);
  const sigOther = computeFailureSignature(regressionSurvivedOtherPatch);
  assert.ok(typeof sigBad === "string" && sigBad.length > 0);
  assert.ok(typeof sigOther === "string" && sigOther.length > 0);
  assert.notEqual(
    sigBad,
    sigOther,
    "a patch that changes the failing version digits must yield a new signature (progress), not a stall",
  );

  // Degenerate inputs collapse to the sentinel signature
  assert.equal(computeFailureSignature(""), "empty-output");
  assert.equal(computeFailureSignature(null), "empty-output");
});

test("DWF 3b. computeFailureSignature is stable across pid / duration / timestamp noise", () => {
  // Volatile values use epoch timestamps and cross-unit durations: both are
  // normalized by the verify-gate chain (>= 4-digit numbers -> NUM, ms/s/min
  // -> DURATION). ISO datetimes with differing month/day digits are NOT fully
  // normalized by the chain, so they are deliberately not varied here.
  const mochaRunA = [
    "mocha 10.2.0 (runner pid 4312, ts 1780001234) finished 3 test files in 14.5ms",
    "1) API contract regression:",
    "AssertionError [ERR_ASSERTION]: expected 200 to equal 500 (HTTP status)",
    "at /repo/test/api.spec.js:104:12",
    "at Context.<anonymous> (/repo/test/api.spec.js:104:12)",
  ].join("\n");
  const mochaRunB = [
    "mocha 10.2.0 (runner pid 90210, ts 1799998765) finished 3 test files in 1.2s",
    "1) API contract regression:",
    "AssertionError [ERR_ASSERTION]: expected 200 to equal 500 (HTTP status)",
    "at /repo/test/api.spec.js:104:12",
    "at Context.<anonymous> (/repo/test/api.spec.js:104:12)",
  ].join("\n");

  assert.equal(
    computeFailureSignature(mochaRunA),
    computeFailureSignature(mochaRunB),
    "same root cause with volatile pid/duration/timestamp values must map to one signature (stall detection)",
  );
});

test("DWF 3c. boost.dwf.ts source anchors: LATS checkpoint, rollback and verify_synth.sh lifecycle", () => {
  // Snapshot checkpoint creation (git stash create, falling back to HEAD)
  assert.ok(
    dwfSource.includes("git stash create"),
    "boost.dwf.ts must create git checkpoints via 'git stash create'",
  );
  // LATS rollback on failure-count spread, plus untracked-debris cleanup
  assert.ok(
    dwfSource.includes("git reset --hard"),
    "boost.dwf.ts must roll back to the checkpoint via 'git reset --hard'",
  );
  assert.ok(
    dwfSource.includes("git clean -fd"),
    "boost.dwf.ts must purge untracked debris via 'git clean -fd' during rollback",
  );
  // Self-Debugging test synthesis: heredoc write, execution, cleanup
  assert.ok(
    dwfSource.includes("cat << 'EOF' > verify_synth.sh"),
    "boost.dwf.ts must materialize the synthesized verify_synth.sh script",
  );
  assert.ok(
    dwfSource.includes('"./verify_synth.sh"'),
    "boost.dwf.ts must execute the synthesized script as the verify command",
  );
  assert.ok(
    dwfSource.includes("rm -f verify_synth.sh"),
    "boost.dwf.ts must clean up verify_synth.sh after verification",
  );
  assert.ok(
    dwfSource.includes("sh -n verify_synth.sh"),
    "boost.dwf.ts must validate verify_synth.sh syntax via 'sh -n' before running it",
  );
  assert.ok(
    dwfSource.includes("git clean -fd -e verify_synth.sh"),
    "boost.dwf.ts must exclude verify_synth.sh during LATS rollback git clean",
  );
  assert.ok(
    dwfSource.includes("let yardstickScore: YardstickScoreResult | undefined = undefined;"),
    "boost.dwf.ts must declare yardstickScore in outer scope so Phase 5 never throws ReferenceError",
  );
  assert.ok(
    dwfSource.includes("const claimedFiles = new Set<string>();"),
    "boost.dwf.ts must deterministically deduplicate overlapping targetFiles after Phase 1 revision",
  );
  assert.ok(
    dwfSource.includes("cat << 'EOF_BOOST_EXP' >> .agent-boost/experiences.md"),
    "boost.dwf.ts must persist experience cues via single-quoted heredoc to prevent shell expansion",
  );
});

// ---------------------------------------------------------------------------
// Group 4: Phase 4 — six-dimension yardstick scoring and the >= 85 gate
// ---------------------------------------------------------------------------

test("DWF 4a. calculateYardstickScore applies the default 25/20/15/15/15/10 weights", () => {
  // Clean run: 100 across all six dimensions
  const clean = calculateYardstickScore([]);
  assert.equal(clean.overallScore, 100);
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.breakdown, {
    delivery: 100,
    conformance: 100,
    fidelity: 100,
    internalConsistency: 100,
    operationalFitness: 100,
    finish: 100,
  });
  assert.deepEqual(clean.deductions, []);

  // One medium finding on delivery: 85*0.25 + 100*0.75 = 96.25 -> 96.
  // Only the canonical 25% delivery weight produces exactly 96.
  const oneMedium = calculateYardstickScore([
    { what: "Auth route missing from gateway", severity: "medium", criterion: "delivery" },
  ]);
  assert.equal(oneMedium.breakdown.delivery, 85, "medium severity deducts 15");
  assert.equal(oneMedium.overallScore, 96);
  assert.equal(oneMedium.passed, true);
  assert.equal(oneMedium.deductions[0].penalty, 15);

  // Low severity deducts 5: finish 95 -> 100*0.9 + 95*0.1 = 99.5 -> 100
  const oneLow = calculateYardstickScore([
    { what: "comment spacing nit", severity: "low", criterion: "finish" },
  ]);
  assert.equal(oneLow.breakdown.finish, 95);
  assert.equal(oneLow.overallScore, 100);
});

test("DWF 4b. calculateYardstickScore: high severity deducts 40 and blocks passing at any score", () => {
  const result = calculateYardstickScore([
    { what: "Verifier fabricated passing evidence", severity: "high", criterion: "fidelity" },
  ]);

  assert.equal(result.breakdown.fidelity, 60, "high severity deducts 40 from its criterion");
  assert.equal(result.breakdown.operationalFitness, 100, "other dimensions stay untouched");
  // 60*0.15 + 100*0.85 = 94 — above 85, yet blocked by the high-severity finding
  assert.equal(result.overallScore, 94);
  assert.equal(result.passed, false, "passed requires no high-severity findings, not just >= 85");
  assert.deepEqual(result.deductions[0], {
    criterion: "fidelity",
    severity: "high",
    reason: "Verifier fabricated passing evidence",
    penalty: 40,
  });
});

test("DWF 4c. calculateYardstickScore gate at 85 is inclusive; below 85 without high findings fails", () => {
  // 4 medium delivery findings: delivery = 100-60 = 40 -> 40*0.25 + 75 = 85 exactly
  const atBoundary = calculateYardstickScore([
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
  ]);
  assert.equal(atBoundary.overallScore, 85);
  assert.equal(atBoundary.passed, true, "overallScore == 85 with no high finding passes");

  // 5 medium delivery findings: delivery = 25 -> 25*0.25 + 75 = 81.25 -> 81
  const belowBoundary = calculateYardstickScore([
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
    { severity: "medium", criterion: "delivery" },
  ]);
  assert.equal(belowBoundary.overallScore, 81);
  assert.equal(belowBoundary.passed, false);

  // The gate formula itself is anchored in the DWF source
  assert.ok(
    dwfSource.includes("overallScore >= 85 && !hasHighSeverity"),
    "boost.dwf.ts must gate on overallScore >= 85 with no high-severity findings",
  );
});

test("DWF 4d. calculateYardstickScore normalizes customWeights to sum 1; zero-sum input falls back to defaults", () => {
  // Raw weights 2 and 1 (sum 3) — normalization must yield 2/3 and 1/3
  const custom = {
    delivery: 2,
    conformance: 0,
    fidelity: 0,
    internalConsistency: 0,
    operationalFitness: 0,
    finish: 1,
  };

  const clean = calculateYardstickScore([], custom);
  assert.equal(clean.overallScore, 100);

  // Medium on finish: 100*(2/3) + 85*(1/3) = 95
  const finishHit = calculateYardstickScore(
    [{ severity: "medium", criterion: "finish" }],
    custom,
  );
  assert.equal(finishHit.overallScore, 95);
  assert.equal(finishHit.passed, true);

  // Medium on delivery: 85*(2/3) + 100*(1/3) = 90.
  // Without normalization this would clamp to 100 — 90 proves normalization ran.
  const deliveryHit = calculateYardstickScore(
    [{ severity: "medium", criterion: "delivery" }],
    custom,
  );
  assert.equal(deliveryHit.overallScore, 90);
  assert.equal(deliveryHit.passed, true);

  // Zero-sum customWeights leave the default weights in place
  const zeroSum = calculateYardstickScore(
    [{ severity: "medium", criterion: "delivery" }],
    {
      delivery: 0,
      conformance: 0,
      fidelity: 0,
      internalConsistency: 0,
      operationalFitness: 0,
      finish: 0,
    },
  );
  assert.equal(
    zeroSum.overallScore,
    96,
    "zero-sum weights must fall back to the 25/20/15/15/15/10 defaults",
  );
});

// ---------------------------------------------------------------------------
// Group 5: control vs experiment track conflict isolation and determinism
// ---------------------------------------------------------------------------

test("DWF 5. Express route mounting race: uncoordinated parallel code workstreams collide on shared gateway, planner decoupling eliminates conflict", () => {
  // Control track: two code workstreams collide on shared entrypoint src/server.js
  const coupled = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.js", "src/server.js"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.js", "src/server.js"] },
  ];
  const conflicts = detectTargetFileConflicts(coupled);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].file, "src/server.js");
  assert.deepEqual(conflicts[0].workstreams.sort(), ["Metrics API Routes", "OAuth2 Auth Routes"]);

  // Experiment track: planner decouples targetFiles into disjoint sets
  const decoupled = [
    { title: "OAuth2 Auth Routes", kind: "code", targetFiles: ["src/routes/auth.js", "src/middleware/auth.js"] },
    { title: "Metrics API Routes", kind: "code", targetFiles: ["src/routes/api.js", "src/middleware/metrics.js"] },
    { title: "Server Gateway Assembly", kind: "code", targetFiles: ["src/server.js"] },
  ];
  const zeroConflicts = detectTargetFileConflicts(decoupled);
  assert.equal(zeroConflicts.length, 0, "Disjoint targetFiles guarantee zero write clobbering");
});
