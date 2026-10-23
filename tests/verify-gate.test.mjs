import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFailureOutput,
  computeFailureSignature,
  formatConclusion,
  validateTeamProfile,
  resolveModelConfiguration,
} from "../shared/verify-gate.js";

test("formatFailureOutput preserves tail instead of head", () => {
  const head = "FIRST_LINE_INITIAL_SETUP_LOGS\n".repeat(50);
  const tail = "ASSERTION_FAILED: expected true but got false at test.js:42\n".repeat(5);
  const combined = head + tail;

  const result = formatFailureOutput(combined, "", 150);
  assert.ok(!result.includes("FIRST_LINE_INITIAL_SETUP_LOGS"), "Head lines should be truncated");
  assert.ok(result.includes("ASSERTION_FAILED"), "Tail assertion must be retained");
});

test("computeFailureSignature normalizes volatile lines and ignores static header", () => {
  const runnerOutput1 = `
> my-pkg@1.0.0 test
TAP version 13
# Subtest: test suite
    at /Users/test/workspace/repo/src/index.js:104:12 (pid: 12345 in 14.5ms)
    AssertionError [ERR_ASSERTION]: expected 200 == 500 at 0x7ffee1234567
    not ok 1 - test failed
`;

  const runnerOutput2 = `
> my-pkg@1.0.0 test
TAP version 13
# Subtest: test suite
    at /var/jenkins/workspace/repo/src/index.js:205:99 (pid: 99881 in 98.2ms)
    AssertionError [ERR_ASSERTION]: expected 200 == 500 at 0x7faab9876543
    not ok 1 - test failed
`;

  const sig1 = computeFailureSignature(runnerOutput1);
  const sig2 = computeFailureSignature(runnerOutput2);

  assert.equal(sig1, sig2, "Volatile paths, pids, durations, and addresses must normalize to the same signature");
});

test("computeFailureSignature distinguishes different failures", () => {
  const failA = "Error: Connection refused to database at 127.0.0.1:5432";
  const failB = "SyntaxError: Unexpected token '}' in parser.js";

  assert.notEqual(computeFailureSignature(failA), computeFailureSignature(failB));
});

test("formatConclusion reflects high severity review findings (B1 fix)", () => {
  const result = formatConclusion(
    "Implement auth module",
    2,
    [
      {
        what: "Security bypass in JWT validation",
        evidence: "auth.js:45",
        severity: "high",
        status: "verified",
      },
    ],
    [], // no gaps
    "zh",
  );

  assert.equal(result.hasBlockingIssues, true);
  assert.ok(result.conclusion.includes("未闭环问题"));
  assert.ok(result.conclusion.includes("高风险复核缺陷"));
  assert.ok(!result.conclusion.includes("已完成并通过验证"), "Must not falsely claim full completion");
});

test("formatConclusion reports success when no gaps and no high defects", () => {
  const result = formatConclusion(
    "Implement auth module",
    2,
    [
      {
        what: "Minor typo in comment",
        evidence: "auth.js:12",
        severity: "low",
        status: "verified",
      },
    ],
    [],
    "zh",
  );

  assert.equal(result.hasBlockingIssues, false);
  assert.ok(result.conclusion.includes("已完成并通过验证"));
});

test("validateTeamProfile rejects invalid profile (B7 fix)", () => {
  assert.equal(validateTeamProfile("HYBRID"), "hybrid");
  assert.equal(validateTeamProfile("quality"), "quality");
  assert.equal(validateTeamProfile("economy"), "economy");

  assert.throws(() => validateTeamProfile("super-fast"), /Invalid teamProfile/);
});

test("resolveModelConfiguration maps aliases and defaults from config (B11 fix)", () => {
  const config = {
    default_light_model: "glm-flash",
    models: {
      "glm-flash": { id: "opencode-go-chat/glm-5.3-flash", tier: "light" },
      "qwen-flash": { id: "opencode-go-messages/qwen3.8-flash", tier: "light" },
    },
  };

  const resolvedAlias = resolveModelConfiguration("qwen-flash", config);
  assert.equal(resolvedAlias.modelId, "opencode-go-messages/qwen3.8-flash");
  assert.equal(resolvedAlias.tier, "light");

  const resolvedDefault = resolveModelConfiguration("", config);
  assert.equal(resolvedDefault.modelId, "opencode-go-chat/glm-5.3-flash");
  assert.equal(resolvedDefault.tier, "light");
});
