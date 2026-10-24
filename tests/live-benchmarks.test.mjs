import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_TASKS, offlineSelftest } from "../scripts/run-live-benchmarks.mjs";
import { generateHtmlReport, generateMarkdownSummary } from "../scripts/generate-benchmark-report.mjs";

test("Live Benchmark Suite: 10 canonical live engineering tasks are defined with required metadata", () => {
  assert.equal(LIVE_TASKS.length, 10, "Must contain exactly 10 canonical live benchmark tasks");

  for (const task of LIVE_TASKS) {
    assert.ok(task.id, "Task must have an ID");
    assert.ok(task.name, "Task must have a name");
    assert.ok(task.category, "Task must state category");
    assert.ok(task.origin, "Task must state benchmark origin");
    assert.equal(typeof task.fixture, "function", "Task must provide a fixture generator");
  }
});

test("Live Benchmark Suite: offline harness machinery selftest executes and passes all 36 checks", async () => {
  const result = await offlineSelftest({ silent: true });
  assert.equal(result.ok, true, "All offline harness machinery checks must pass");
  assert.equal(result.failed, 0, "Zero failures allowed in offline harness machinery");
  assert.equal(result.passed, 36, "Must pass exactly 36 offline harness checks");
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
