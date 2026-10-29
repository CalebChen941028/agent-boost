import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LIVE_TASKS,
  offlineSelftest,
  normalizeForMatching,
  extractSurgicalBlocks,
  applySurgicalFileWrites,
  verifyWorkspaceSyntax,
} from "../scripts/run-live-benchmarks.mjs";
import { generateHtmlReport, generateMarkdownSummary, generateMultiModelReport, renderExecutionTimelineSvg } from "../scripts/generate-benchmark-report.mjs";

test("Live Benchmark Suite: 18 canonical live engineering tasks are defined with required metadata", () => {
  assert.equal(LIVE_TASKS.length, 18, "Must contain exactly 18 canonical live benchmark tasks");

  for (const task of LIVE_TASKS) {
    assert.ok(task.id, "Task must have an ID");
    assert.ok(task.name, "Task must have a name");
    assert.ok(task.category, "Task must state category");
    assert.ok(task.origin, "Task must state benchmark origin");
    assert.equal(typeof task.fixture, "function", "Task must provide a fixture generator");
  }
});

test("Live Benchmark Suite: offline harness machinery selftest executes and passes all 60 checks", async () => {
  const result = await offlineSelftest({ silent: true });
  assert.equal(result.ok, true, "All offline harness machinery checks must pass");
  assert.equal(result.failed, 0, "Zero failures allowed in offline harness machinery");
  assert.equal(result.passed, 60, "Must pass exactly 60 offline harness checks");
});

test("Benchmark Report Generator: generates valid standalone HTML and Markdown reports", () => {
  const mockSummary = {
    meta: {
      model: "mimo-v2.6-flash",
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
      sessionId: "test-session-1234",
    },
    aggregate: {
      total: 2,
      soloPassed: 1,
      boostPassed: 2,
      soloTokens: 1000,
      boostTokens: 1500,
      soloScoreAvg: 85.0,
      boostScoreAvg: 98.0,
      conflicts: 1,
      rollbacks: 0,
      synthUsed: 1,
    },
    results: [
      {
        task: { id: "TASK-1", name: "Sample Task 1", category: "Race" },
        solo: { passed: false, groundExitCode: 1, yardstickScore: 80 },
        boost: { passed: true, groundExitCode: 0, yardstickScore: 99, conflictsIntercepted: 1 },
      },
      {
        task: { id: "TASK-2", name: "Sample Task 2", category: "Algorithmic" },
        solo: { passed: true, groundExitCode: 0, yardstickScore: 90 },
        boost: { passed: true, groundExitCode: 0, yardstickScore: 97 },
      },
    ],
  };

  const html = generateHtmlReport(mockSummary);
  assert.ok(html.startsWith("<!DOCTYPE html>"), "Report must be valid HTML5");
  assert.ok(html.includes("mimo-v2.6-flash"), "Report must include model name");
  assert.ok(html.includes("TASK-1"), "Report must list TASK-1");
  assert.ok(html.includes("BOOST-ONLY"), "Report must show BOOST-ONLY badge");

  const md = generateMarkdownSummary(mockSummary);
  assert.ok(md.includes("TASK-1"), "Markdown summary must list TASK-1");
  assert.ok(md.includes("BOOST-ONLY"), "Markdown summary must show verdict");
});

test("Benchmark Report Generator: renders SVG timeline and generates cross-model comparison", () => {
  const armA = { wallMs: 15000, attempts: 2, usage: { calls: 4 } };
  const armB = { wallMs: 30000, complexityTier: "standard", usage: { calls: 6 } };
  const svg = renderExecutionTimelineSvg(armA, armB, "Model1", "Model2");
  assert.ok(svg.includes("<svg"), "Must render SVG tag");
  assert.ok(svg.includes("Model1"), "Must include Model1 label");
  assert.ok(svg.includes("Model2"), "Must include Model2 label");

  const mockRunA = {
    meta: { model: "mimo-v2.6-flash" },
    aggregate: { total: 1, soloPassed: 0, boostPassed: 1, soloTokens: 1000, boostTokens: 2000, boostScoreAvg: 99 },
    results: [
      {
        task: { id: "LIVE-EXPRESS-RACE", name: "Express Race", category: "Race" },
        solo: { passed: false, groundExitCode: 1, yardstickScore: 84 },
        boost: { passed: true, groundExitCode: 0, yardstickScore: 100, complexityTier: "standard" },
      },
    ],
  };

  const mockRunB = {
    meta: { model: "deepseek-v4.1-flash" },
    aggregate: { total: 1, soloPassed: 1, boostPassed: 1, soloTokens: 1200, boostTokens: 2100, boostScoreAvg: 98 },
    results: [
      {
        task: { id: "LIVE-EXPRESS-RACE", name: "Express Race", category: "Race" },
        solo: { passed: true, groundExitCode: 0, yardstickScore: 95 },
        boost: { passed: true, groundExitCode: 0, yardstickScore: 98, complexityTier: "standard" },
      },
    ],
  };

  const crossHtml = generateMultiModelReport(mockRunA, mockRunB);
  assert.ok(crossHtml.startsWith("<!DOCTYPE html>"), "Cross-model report must be valid HTML5");
  assert.ok(crossHtml.includes("mimo-v2.6-flash"), "Report must include model A");
  assert.ok(crossHtml.includes("deepseek-v4.1-flash"), "Report must include model B");
  assert.ok(crossHtml.includes("LIVE-EXPRESS-RACE"), "Report must include task row");
  assert.ok(crossHtml.includes("DUAL BOOST PASS"), "Report must include dual pass badge");
});

test("Surgical Block Edit & Pre-Flight Syntax Verification: parses <replace>, tolerates CRLF/trailing spaces, blocks path traversal, and validates syntax", () => {
  assert.equal(normalizeForMatching("const a = 1;  \r\nconst b = 2;\t\r\n"), "const a = 1;\nconst b = 2;\n");

  const llmOutput = `
<replace path="src/math.js">
<target>
function add(a, b) {
  return a - b;
}
</target>
<replacement>
function add(a, b) {
  return a + b;
}
</replacement>
</replace>
<file path="src/helper.js">
export const VERSION = 2;
</file>
<file path="../escape.js">
throw new Error("should be blocked");
</file>
`;

  const blocks = extractSurgicalBlocks(llmOutput);
  const replaceBlocks = blocks.filter((b) => b.type === "replace");
  const fileBlocks = blocks.filter((b) => b.type === "file");
  assert.equal(replaceBlocks.length, 1);
  assert.equal(replaceBlocks[0].path, "src/math.js");
  assert.equal(fileBlocks.length, 2);

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "boost-surgical-test-"));
  try {
    fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
    // Seed math.js with CRLF and trailing whitespace to test Tier 2 normalized matching
    fs.writeFileSync(
      path.join(tmpWs, "src", "math.js"),
      "// header\r\nfunction add(a, b) {   \r\n  return a - b;\t\r\n}\r\nexport { add };\r\n",
      "utf8",
    );

    const writeRes = applySurgicalFileWrites(tmpWs, blocks, ["src/math.js", "src/helper.js"]);
    assert.deepEqual(writeRes.written.sort(), ["src/helper.js", "src/math.js"]);
    assert.deepEqual(writeRes.escaped, ["../escape.js"]);
    assert.deepEqual(writeRes.failed, []);
    assert.ok(!fs.existsSync(path.join(tmpWs, "..", "escape.js")), "Path traversal must be blocked");

    const updatedMath = fs.readFileSync(path.join(tmpWs, "src", "math.js"), "utf8");
    assert.ok(updatedMath.includes("return a + b;"), "Surgical <replace> must update target block");
    assert.ok(updatedMath.includes("// header") && updatedMath.includes("export { add };"), "Surrounding lines must be preserved");

    const syntaxOk = verifyWorkspaceSyntax(tmpWs, writeRes.written);
    assert.equal(syntaxOk.ok, true, "Valid JS files must pass pre-flight syntax verification");

    // Introduce a syntax error and verify verifyWorkspaceSyntax catches it
    fs.writeFileSync(path.join(tmpWs, "src", "broken.js"), "function broken( { return 1;", "utf8");
    const syntaxBadJs = verifyWorkspaceSyntax(tmpWs, ["src/broken.js"]);
    assert.equal(syntaxBadJs.ok, false);
    assert.ok(syntaxBadJs.errors[0].startsWith("src/broken.js:"));

    // Introduce malformed JSON and verify verifyWorkspaceSyntax catches it
    fs.writeFileSync(path.join(tmpWs, "package.json"), "{ invalid json ", "utf8");
    const syntaxBadJson = verifyWorkspaceSyntax(tmpWs, ["package.json"]);
    assert.equal(syntaxBadJson.ok, false);
    assert.ok(syntaxBadJson.errors[0].startsWith("package.json:"));
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
