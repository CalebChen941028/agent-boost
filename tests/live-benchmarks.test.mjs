import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_TASKS, offlineSelftest } from "../scripts/run-live-benchmarks.mjs";

test("Live Benchmark Suite: 5 canonical live engineering tasks are defined with required metadata", () => {
  assert.equal(LIVE_TASKS.length, 5, "Must contain exactly 5 canonical live benchmark tasks");

  for (const task of LIVE_TASKS) {
    assert.ok(task.id, "Task must have an ID");
    assert.ok(task.name, "Task must have a name");
    assert.ok(task.category, "Task must state category");
    assert.ok(task.origin, "Task must state benchmark origin");
    assert.equal(typeof task.fixture, "function", "Task must provide a fixture generator");
  }
});

test("Live Benchmark Suite: offline harness machinery selftest executes and passes all 21 checks", async () => {
  const result = await offlineSelftest({ silent: true });
  assert.equal(result.ok, true, "All offline harness machinery checks must pass");
  assert.equal(result.failed, 0, "Zero failures allowed in offline harness machinery");
  assert.equal(result.passed, 21, "Must pass exactly 21 offline harness checks");
});
