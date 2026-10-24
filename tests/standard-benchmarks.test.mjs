import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_TASKS, runAllBenchmarks } from "../scripts/run-benchmarks.mjs";

test("Standard Benchmark Suite: All 12 canonical tasks are defined with required metadata", () => {
  assert.equal(BENCHMARK_TASKS.length, 12, "Must contain exactly 12 standard engineering benchmark tasks");

  for (const task of BENCHMARK_TASKS) {
    assert.ok(task.id, "Task must have an ID");
    assert.ok(task.name, "Task must have a name");
    assert.ok(task.origin, "Task must state benchmark dataset origin");
    assert.ok(task.category, "Task must state category");
    assert.equal(typeof task.runBaseline, "function", "Task must provide runBaseline function");
    assert.equal(typeof task.runBoost, "function", "Task must provide runBoost function");
  }
});

test("Standard Benchmark Suite: Mode A (Baseline Solo Agent) fails all race/regression/unverified traps", async () => {
  for (const task of BENCHMARK_TASKS) {
    const baseline = await task.runBaseline();
    assert.equal(
      baseline.passed,
      false,
      `Task ${task.id} must fail under Mode A (Baseline Solo Agent) due to uncoordinated failure modes`,
    );
    assert.ok(
      baseline.exitCode !== 0 || !baseline.passed,
      `Task ${task.id} must indicate failure via exitCode or passed=false`,
    );
  }
});

test("Standard Benchmark Suite: Mode B (With agent-boost v0.4.0) resolves all 12 tasks with >=85 Yardstick score", async () => {
  for (const task of BENCHMARK_TASKS) {
    const boost = await task.runBoost();
    assert.equal(
      boost.passed,
      true,
      `Task ${task.id} must pass under Mode B (agent-boost v0.4.0)`,
    );
    assert.equal(boost.exitCode, 0, `Task ${task.id} must exit with code 0 under agent-boost`);
    assert.ok(
      boost.yardstickScore >= 85,
      `Task ${task.id} must achieve Yardstick score >= 85 (got ${boost.yardstickScore})`,
    );
  }
});

test("Standard Benchmark Suite: Full runner execution and aggregation matrix", async () => {
  const summary = await runAllBenchmarks({ silent: true });
  assert.equal(summary.total, 12);
  assert.equal(summary.baselinePassed, 0, "Baseline solo agent pass rate must be 0/12 on hard multi-agent traps");
  assert.equal(summary.boostPassed, 12, "agent-boost v0.4.0 must achieve 12/12 (100%) pass rate");
  assert.ok(summary.boostScoreAvg > summary.baselineScoreAvg, "Boost Yardstick average must surpass baseline");
});

test("Standard Benchmark Suite: every task reports deterministic repairRounds and tokenSpend fields", async () => {
  for (const task of BENCHMARK_TASKS) {
    const baseline = await task.runBaseline();
    const boost = await task.runBoost();

    assert.ok(
      Number.isInteger(baseline.repairRounds) && baseline.repairRounds > 0,
      `Task ${task.id} baseline must report an executed blind repair round count > 0 (got ${baseline.repairRounds})`,
    );
    assert.ok(
      Number.isInteger(boost.repairRounds) && boost.repairRounds >= 0,
      `Task ${task.id} boost must report an executed convergence round count >= 0 (got ${boost.repairRounds})`,
    );
    assert.ok(
      Number.isInteger(baseline.tokenSpend) && baseline.tokenSpend > 0 && baseline.tokenSpend % 1200 === 0,
      `Task ${task.id} baseline tokenSpend must be a positive multiple of the 1200 tokens/turn accounting constant (got ${baseline.tokenSpend})`,
    );
    assert.ok(
      Number.isInteger(boost.tokenSpend) && boost.tokenSpend > 0 && boost.tokenSpend % 1200 === 0,
      `Task ${task.id} boost tokenSpend must be a positive multiple of the 1200 tokens/turn accounting constant (got ${boost.tokenSpend})`,
    );
  }
});

test("Standard Benchmark Suite: boost converges in fewer mean repair rounds and lower token spend", async () => {
  let baselineRoundsTotal = 0;
  let boostRoundsTotal = 0;
  let baselineTokensTotal = 0;
  let boostTokensTotal = 0;

  for (const task of BENCHMARK_TASKS) {
    const baseline = await task.runBaseline();
    const boost = await task.runBoost();
    baselineRoundsTotal += baseline.repairRounds;
    boostRoundsTotal += boost.repairRounds;
    baselineTokensTotal += baseline.tokenSpend;
    boostTokensTotal += boost.tokenSpend;
  }

  const n = BENCHMARK_TASKS.length;
  assert.ok(
    boostRoundsTotal / n < baselineRoundsTotal / n,
    `Boost mean repair rounds (${(boostRoundsTotal / n).toFixed(2)}) must be < baseline mean (${(baselineRoundsTotal / n).toFixed(2)})`,
  );
  assert.ok(
    boostTokensTotal / baselineTokensTotal < 1,
    `Token spend ratio boost/baseline (${(boostTokensTotal / baselineTokensTotal).toFixed(3)}) must be < 1`,
  );
});

test("Standard Benchmark Suite: runner summary aggregates MTTR and token ratio fields", async () => {
  const summary = await runAllBenchmarks({ silent: true });

  assert.ok(
    Number.isFinite(summary.baselineRepairRoundsAvg) && Number.isFinite(summary.boostRepairRoundsAvg),
    "Summary must expose baselineRepairRoundsAvg and boostRepairRoundsAvg",
  );
  assert.ok(
    summary.boostRepairRoundsAvg < summary.baselineRepairRoundsAvg,
    `Summary boostRepairRoundsAvg (${summary.boostRepairRoundsAvg}) must be < baselineRepairRoundsAvg (${summary.baselineRepairRoundsAvg})`,
  );
  assert.ok(
    Number.isFinite(summary.tokenSpendRatio) && summary.tokenSpendRatio < 1,
    `Summary tokenSpendRatio (${summary.tokenSpendRatio}) must be < 1`,
  );
  assert.ok(
    summary.boostTokenSpendTotal < summary.baselineTokenSpendTotal,
    "Summary boostTokenSpendTotal must be < baselineTokenSpendTotal",
  );
});
