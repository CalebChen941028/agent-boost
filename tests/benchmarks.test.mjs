import test from "node:test";
import assert from "node:assert/strict";
import {
  detectTargetFileConflicts,
  computeFailureSignature,
  calculateYardstickScore,
  formatConclusion,
  matchExperienceCues,
  formatExperienceEntry,
  evaluateTaskComplexity,
} from "../shared/verify-gate.js";

/**
 * Empirical Benchmark Test Suite
 * Verifies the mathematical and logical guarantees of agent-boost's four core benchmark scenarios:
 * - Scenario A: Parallel Write Race Condition Detection (detectTargetFileConflicts)
 * - Scenario B: Cascade Regression Detection & LATS Rollback Signaling (computeFailureSignature)
 * - Scenario C: Anti-Self-Certification Gate & Quantitative Yardstick Scoring (calculateYardstickScore + formatConclusion)
 * - Scenario D: Long-Horizon Pitfall Avoidance & A-MEM Memory Recall (matchExperienceCues)
 */

test("Benchmark Scenario A: Parallel write race conditions are deterministically caught and blocked", () => {
  // Baseline failure pattern: Uncoordinated subagents simultaneously touching shared gateway entrypoint
  const uncoordinatedParallelWorkstreams = [
    {
      title: "OAuth2 Gateway Integration",
      kind: "code",
      targetFiles: ["src/routes/auth.ts", "src/server.ts"],
    },
    {
      title: "OpenTelemetry Tracing Pipeline",
      kind: "code",
      targetFiles: ["src/telemetry/tracer.ts", "src/server.ts"],
    },
    {
      title: "Read-only Architecture Security Audit",
      kind: "investigate",
      targetFiles: ["src/server.ts"], // Non-code investigate workstreams do not mutate files
    },
  ];

  // In standard solo/uncoordinated multi-agent runtimes, last-write-wins clobbers src/server.ts.
  // In agent-boost, detectTargetFileConflicts intercepts the race condition before execution:
  const conflicts = detectTargetFileConflicts(uncoordinatedParallelWorkstreams);
  assert.equal(conflicts.length, 1, "Must intercept exactly 1 conflicting file");
  assert.equal(conflicts[0].file, "src/server.ts");
  assert.deepEqual(conflicts[0].workstreams, [
    "OAuth2 Gateway Integration",
    "OpenTelemetry Tracing Pipeline",
  ]);

  // Once decoupled by Boost's Planner into disjoint targetFiles:
  const coordinatedWorkstreams = [
    {
      title: "OAuth2 Gateway Integration",
      kind: "code",
      targetFiles: ["src/routes/auth.ts", "src/middleware/oauth.ts"],
    },
    {
      title: "OpenTelemetry Tracing Pipeline",
      kind: "code",
      targetFiles: ["src/telemetry/tracer.ts", "src/middleware/tracing.ts"],
    },
    {
      title: "Server Assembly Pipeline (Sequenced)",
      kind: "code",
      targetFiles: ["src/server.ts"],
    },
  ];
  const zeroConflicts = detectTargetFileConflicts(coordinatedWorkstreams);
  assert.equal(zeroConflicts.length, 0, "Disjoint targetFiles guarantee zero write clobbering");

  // Edge Case A2: Path representations with leading slashes, backslashes, and file:// URIs must still trigger conflict
  const pathVariantWorkstreams = [
    {
      title: "POSIX Relative",
      kind: "code",
      targetFiles: ["src/server.ts"],
    },
    {
      title: "POSIX Leading Slash",
      kind: "code",
      targetFiles: ["/src/server.ts"],
    },
    {
      title: "File URI Scheme",
      kind: "code",
      targetFiles: ["file:///src/server.ts"],
    },
  ];
  const uriConflicts = detectTargetFileConflicts(pathVariantWorkstreams);
  assert.equal(uriConflicts.length, 1, "Must detect conflict across relative, leading-slash, and file:// URI representations");
  assert.equal(uriConflicts[0].file, "src/server.ts");
  assert.equal(uriConflicts[0].workstreams.length, 3);
});

test("Benchmark Scenario B: Cascade regression signature shift triggers LATS rollback, stall triggers INV/DOM diagnosis", () => {
  // Baseline initial failure: Intermittent database transaction deadlock
  const initialDeadlockFailure = `
    PostgresError: deadlock detected
    DETAIL: Process 4102 waits for ExclusiveLock on transaction 9410; blocked by process 4103.
    at /var/jenkins/workspace/src/db/transaction.ts:42:15 (pid: 10452 in 34.2ms)
    FAIL tests/concurrency.test.ts (1 failed, 15 passed)
  `;

  // Candidate Fix 1 (Regressive patch: SERIALIZABLE isolation causing connection pool exhaustion)
  const regressiveFailure = `
    PostgresError: remaining connection slots are reserved for non-replication superuser connections
    at /var/jenkins/workspace/src/db/pool.ts:88:10 (pid: 10452 in 12.1ms)
    FAIL tests/concurrency.test.ts
    FAIL tests/pool.test.ts
    FAIL tests/read.test.ts (3 failed, 13 passed)
  `;

  const initialSig = computeFailureSignature(initialDeadlockFailure);
  const regressiveSig = computeFailureSignature(regressiveFailure);

  // Signatures diverge, signaling failure escalation to LATS tree search
  assert.notEqual(
    initialSig,
    regressiveSig,
    "Regressive patch produces distinct signature, preventing false convergence",
  );

  // Candidate Fix 2 (Stalled fix: Repeating the exact same underlying deadlock despite code churn)
  const stalledDeadlockFailure = `
    PostgresError: deadlock detected
    DETAIL: Process 9811 waits for ExclusiveLock on transaction 9410; blocked by process 9812.
    at /Users/dev/workspace/src/db/transaction.ts:48:15 (pid: 99182 in 142.5ms)
    FAIL tests/concurrency.test.ts (1 failed, 15 passed)
  `;
  const stalledSig = computeFailureSignature(stalledDeadlockFailure);

  // Normalized signature matches initial failure despite PID, timestamp, line and directory changes
  assert.equal(
    initialSig,
    stalledSig,
    "Volatile runtime lines normalize to identical signature, triggering stall detection & INV/DOM diagnosis",
  );

  // Candidate Fix 3 (Stalled fix with volatile whitespace in timing outputs: e.g. "142.5 ms" vs "34.2ms")
  const stalledWhitespaceTimingFailure = `
    PostgresError: deadlock detected
    DETAIL: Process 9811 waits for ExclusiveLock on transaction 9410; blocked by process 9812.
    at /Users/dev/workspace/src/db/transaction.ts:48:15 (pid: 99182 in 142.5 ms)
    FAIL tests/concurrency.test.ts (1 failed, 15 passed)
  `;
  const stalledWhitespaceSig = computeFailureSignature(stalledWhitespaceTimingFailure);
  assert.equal(
    initialSig,
    stalledWhitespaceSig,
    "Timing outputs with whitespace (142.5 ms) must normalize to identical signature as 34.2ms to ensure stall detection",
  );
});

test("Benchmark Scenario C: Anti-self-certification gate blocks false victory and requires >=85 Yardstick score", () => {
  // Case C1: High severity specification drift blocks passing regardless of overall percentage
  const highSeveritySpecDrift = [
    {
      what: "Legacy v3 payload triggers unhandled NullPointer on billing_address in production transformer",
      evidence: "src/transformers/v3-to-v4.ts:64",
      severity: "high",
      status: "verified",
      criterion: "conformance",
    },
  ];

  const highSevYardstick = calculateYardstickScore(highSeveritySpecDrift);
  assert.equal(highSevYardstick.passed, false, "High-severity finding MUST fail the Yardstick pass gate");
  assert.equal(highSevYardstick.breakdown.conformance, 60, "High severity deducts 40 points from criterion");

  // Case C2: Cumulative medium defects drop overall score strictly below 85
  const cumulativeDefects = [
    { what: "Missing migration audit rollback script 1", evidence: "scripts/rollback.sh", severity: "medium", criterion: "delivery" },
    { what: "Missing migration audit rollback script 2", evidence: "scripts/audit.sh", severity: "medium", criterion: "delivery" },
    { what: "Deprecated schema field unmapped 1", evidence: "src/transformers/v3-to-v4.ts:10", severity: "medium", criterion: "conformance" },
    { what: "Deprecated schema field unmapped 2", evidence: "src/transformers/v3-to-v4.ts:25", severity: "medium", criterion: "conformance" },
    { what: "Inaccurate log metric claim in docstring", evidence: "src/metrics.ts:5", severity: "medium", criterion: "fidelity" },
  ];
  const failingScoreYardstick = calculateYardstickScore(cumulativeDefects);
  assert.equal(failingScoreYardstick.passed, false);
  assert.ok(failingScoreYardstick.overallScore < 85, "Cumulative defects must drop overall score below 85");

  // formatConclusion refuses to claim success when high-severity defects or open gaps exist
  const honestConclusionZh = formatConclusion(
    "v3 to v4 customer schema migration",
    2,
    highSeveritySpecDrift,
    ["Production legacy fixture backwards-compatibility test"],
    "zh",
  );
  assert.equal(honestConclusionZh.hasBlockingIssues, true, "Must flag blocking issues");
  assert.ok(
    honestConclusionZh.conclusion.includes("存在未闭环问题") &&
      honestConclusionZh.conclusion.includes("高风险复核缺陷待解决"),
    "Conclusion text must explicitly call out high-risk review defects",
  );
  assert.ok(!honestConclusionZh.conclusion.includes("已完成并通过验证"));

  // When repaired and fully verified:
  const cleanReview = [
    {
      what: "Minor formatting spacing in JSON-LD context header",
      evidence: "src/schemas/customer.v4.json:12",
      severity: "low",
      status: "verified",
      criterion: "finish",
    },
  ];
  const passedYardstick = calculateYardstickScore(cleanReview);
  assert.equal(passedYardstick.passed, true, "Low-severity minor findings safely pass the gate");
  assert.ok(passedYardstick.overallScore >= 85, "Clean implementation achieves >=85 pass score");

  const successConclusionEn = formatConclusion(
    "v3 to v4 customer schema migration",
    2,
    cleanReview,
    [],
    "en",
  );
  assert.equal(successConclusionEn.hasBlockingIssues, false);
  assert.ok(successConclusionEn.conclusion.includes("completed and verified"));
});

test("Benchmark Scenario D: Long-horizon pitfall avoidance via A-MEM experience cue retrieval", () => {
  const experiences = `
# Engineering Experience Memory Ledger

<experience>
dimension: INV
cue: cross-platform path separators and regex delimiters in node build tools
lesson: Normalize paths with path.normalize(p).replace(/\\\\/g, '/') before regex matching to prevent Windows CI failures
verdict: helped
confidence: high
evidence: Prevented 14 path ENOENT errors across Windows CI runners
</experience>

<experience>
dimension: DOM
cue: postgresql concurrent advisory lock acquisition order deadlocks
lesson: Always sort row IDs with ORDER BY id ASC prior to acquiring row-level locks
verdict: helped
confidence: high
evidence: Completely eliminated 40P01 deadlocks in concurrent transfer suite
</experience>

<experience>
dimension: DOM
cue: confounded observation with uncertain root cause
lesson: Uncertain lesson
verdict: confounded
confidence: low
evidence: Inconclusive
</experience>
  `;

  // Query 1: Windows build tool task matches path separator cue
  const pathTask = "Fix cross-platform build script path resolution for Windows CI release";
  const pathMatches = matchExperienceCues(experiences, pathTask, 3);
  assert.ok(pathMatches.length > 0, "Must recall relevant path handling cue");
  assert.ok(pathMatches.includes("cross-platform path separators and regex delimiters"));
  assert.ok(pathMatches.includes("dimension: INV"));

  // Query 2: Database concurrency task matches lock acquisition cue
  const dbTask = "Resolve concurrent advisory lock deadlocks in postgresql transaction worker";
  const dbMatches = matchExperienceCues(experiences, dbTask, 3);
  assert.ok(dbMatches.length > 0, "Must recall database locking cue");
  assert.ok(dbMatches.includes("postgresql concurrent advisory lock acquisition order deadlocks"));
  assert.ok(dbMatches.includes("dimension: DOM"));
  assert.ok(!dbMatches.includes("confounded observation"), "Confounded cues must be excluded");

  // Format experience entry filtering confounded cues
  const validCue = formatExperienceEntry({
    dimension: "INV",
    cue: "regex catastrophic backtracking in parser tokenizers",
    lesson: "Use atomic grouping or length caps to avoid ReDoS",
    verdict: "helped",
    confidence: "high",
    evidence: "Parser benchmark latency dropped from 12000ms to 4ms",
  });
  assert.ok(validCue.includes("<experience>"));
  assert.ok(validCue.includes("dimension: INV"));

  const confoundedCue = formatExperienceEntry({
    dimension: "DOM",
    cue: "random tweak",
    lesson: "something maybe helped",
    verdict: "confounded",
    confidence: "low",
    evidence: "No clear evidence",
  });
  assert.equal(confoundedCue, "NO_ENTRY", "Confounded cues must be discarded as NO_ENTRY");
});
