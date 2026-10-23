import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFailureOutput,
  computeFailureSignature,
  formatConclusion,
  validateTeamProfile,
  validateIntegrityMode,
  resolveModelConfiguration,
} from "../shared/verify-gate.js";

test("formatFailureOutput preserves tail instead of head", () => {
  const stdout = "START_OF_BUILD_LOG\n" + "x".repeat(1500) + "\n";
  const stderr = "CRITICAL_ASSERTION_FAILURE: expected 42 to equal 0\nEND_OF_TRACE";
  const formatted = formatFailureOutput(stdout, stderr, 500);

  assert.ok(formatted.length <= 500);
  assert.ok(formatted.includes("CRITICAL_ASSERTION_FAILURE"));
  assert.ok(formatted.includes("END_OF_TRACE"));
  assert.ok(!formatted.includes("START_OF_BUILD_LOG"));
});

test("computeFailureSignature normalizes volatile lines and ignores static header", () => {
  const log1 = `
> test runner v1.0.0
[2026-10-23T14:00:00Z] TestSuite running at /Users/user/project/test.js
FAIL: test_addition (0.12s)
AssertionError: Expected 10 at /Users/user/project/math.ts:45:12, pointer 0x7fff89ab
`;

  const log2 = `
> test runner v1.0.0
[2026-10-23T14:05:00Z] TestSuite running at /Users/other/app/test.js
FAIL: test_addition (0.95s)
AssertionError: Expected 10 at /Users/other/app/math.ts:45:12, pointer 0x8aef1234
`;

  const sig1 = computeFailureSignature(log1);
  const sig2 = computeFailureSignature(log2);

  assert.equal(sig1, sig2);
  assert.ok(!sig1.includes("0x7fff89ab"));
  assert.ok(!sig1.includes("/Users/user"));
});

test("computeFailureSignature distinguishes different failures", () => {
  const logA = "FAIL: Expected 42 but got 0";
  const logB = "FAIL: Timeout after 5000ms waiting for database";

  const sigA = computeFailureSignature(logA);
  const sigB = computeFailureSignature(logB);

  assert.notEqual(sigA, sigB);
});

test("formatConclusion reflects high severity review findings (B1 fix)", () => {
  const gaps = [];
  const findings = [
    {
      what: "Data corruption on retry",
      evidence: "db.ts:120",
      severity: "high",
      status: "verified",
    },
  ];

  const zhConclusion = formatConclusion("优化缓存机制", 2, gaps, findings, "zh");
  assert.ok(!zhConclusion.includes("已完成并通过验证"), "Must not claim success when high defects exist");
  assert.ok(zhConclusion.includes("高危缺陷"));

  const enConclusion = formatConclusion("optimize cache", 2, gaps, findings, "en");
  assert.ok(!enConclusion.includes("successfully completed"), "Must not claim success in English either");
  assert.ok(enConclusion.includes("high-severity defect"));
});

test("formatConclusion reports success when no gaps and no high defects", () => {
  const gaps = [];
  const findings = [
    {
      what: "Minor typo in comment",
      evidence: "file.ts:10",
      severity: "low",
      status: "verified",
    },
  ];

  const conclusion = formatConclusion("修复拼写", 1, gaps, findings, "zh");
  assert.ok(conclusion.includes("已完成并通过验证"));
});

test("validateTeamProfile rejects invalid profile (B7 fix)", () => {
  assert.equal(validateTeamProfile("HYBRID"), "hybrid");
  assert.equal(validateTeamProfile("quality"), "quality");
  assert.equal(validateTeamProfile("economy"), "economy");

  assert.throws(() => {
    validateTeamProfile("invalid_mode");
  }, /Invalid teamProfile/);
});

test("validateIntegrityMode validates development, demo, and benchmark", () => {
  assert.equal(validateIntegrityMode("DEVELOPMENT"), "development");
  assert.equal(validateIntegrityMode("demo"), "demo");
  assert.equal(validateIntegrityMode("benchmark"), "benchmark");

  assert.throws(() => {
    validateIntegrityMode("unknown");
  }, /Invalid integrityMode/);
});

test("resolveModelConfiguration maps aliases and defaults from config (B11 fix)", () => {
  const config = {
    default_light_model: "glm-4-flash",
    models: {
      "glm-4-flash": { id: "glm-4-flash-001", tier: "light" },
      "claude-3-5-haiku": { id: "claude-3-5-haiku-20241022", tier: "light" },
    },
  };

  // Explicit alias
  const res1 = resolveModelConfiguration("claude-3-5-haiku", config);
  assert.equal(res1.modelId, "claude-3-5-haiku-20241022");
  assert.equal(res1.tier, "light");

  // Empty request falls back to default light model
  const res2 = resolveModelConfiguration("", config);
  assert.equal(res2.modelId, "glm-4-flash-001");

  // No config falls back to null/default
  const res3 = resolveModelConfiguration("", null);
  assert.equal(res3.modelId, null);
  assert.equal(res3.tier, "default");
});
