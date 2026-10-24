# agent-boost Benchmark Report — Solo GLM-5.3 vs GLM-5.3 + agent-boost

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-green.svg)](VERSION)

[English](BENCHMARKS.md) | [简体中文](BENCHMARKS.zh-CN.md)

This report answers one question: with the same model as the brain, what changes when the engineering toolchain around it is added or removed? Twelve executable benchmark tasks — drawn from the failure archetypes of **BugsJS**, **SWE-bench / SWE-bench Verified**, and **HumanEval-X** — compare two arms:

- **Solo GLM-5.3 (control)**: one model, no tools. No file-conflict gate, no Git rollback, no reproduction-test synthesis, no lifelong memory, no independent judge.
- **GLM-5.3 + agent-boost (treatment)**: the same brain driving the v0.4.0 five-phase state machine — `detectTargetFileConflicts`, LATS Git checkpoint rollback, `verify_synth.sh` test synthesis, INV-First diagnosis, `calculateYardstickScore` six-criterion judging, and `matchExperienceCues` experience recall.

The harness is [`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs). Run `npm run benchmark` and every number in this report prints in your terminal. It needs Node 18 or newer and nothing else; CI runs the same checks on Node 18.x / 20.x / 22.x ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## 1. Methodology, Stated Precisely

> [!IMPORTANT] Read this before reading any table
> 1. **What runs.** A deterministic executable simulation. Both arms execute real JavaScript: the solo arm runs the unguarded code path (last-write-wins file mutation, blind-retry patch stacking, unverified completion), the boost arm invokes the shipped pure functions from [`shared/verify-gate.ts`](shared/verify-gate.ts) — `detectTargetFileConflicts`, `computeFailureSignature`, `calculateYardstickScore`, `matchExperienceCues`, `evaluateTaskComplexity`. The full 12-task suite finishes in milliseconds on a laptop. Repair rounds are executed loop counters and token spend is counted turns times the published constant `TOKENS_PER_AGENT_TURN = 1200` ([`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs)), so the MTTR and token lines are byte-identical across runs.
> 2. **What does not run.** Live LLM API calls. The runner's only import is `../shared/verify-gate.js` ([`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs)); it performs no network I/O. Token figures below are accounted model turns under that published constant, not metered API usage. GLM-5.3 is the brain intended for both arms in live use — this suite measures the toolchain around the brain, not model accuracy. Section 8 gives the protocol for the live side-by-side.
> 3. **Why the margin is 0/12 vs 12/12.** Each task is a boundary scenario: the solo-agent failure mode is written as executable fact (for example, the second workstream's write to `src/server.ts` literally replaces the first), and the boost guard deterministically intercepts it by construction. These numbers verify mechanism guarantees, not a live-model leaderboard. A strong solo model does solve a real share of ordinary tasks in live sessions — on these twelve boundaries, the missing tool decides the outcome.

Every number in this report satisfies one of two traceability rules: it is greppable in `npm run benchmark` stdout, or it is a constant in the task source code. Where a claim is structural rather than measured, the text says so.

---

## 2. Measured Comparison Matrix — Solo GLM-5.3 vs GLM-5.3 + agent-boost

The runner states its own frame before executing anything — this banner is quoted verbatim from `npm run benchmark` stdout:

```text
================================================================================
  agent-boost v0.4.0 Standard Engineering Benchmark Evaluation Harness
  Comparison frame: Solo GLM-5.3 (single model) vs GLM-5.3 + agent-boost v0.4.0 (model + skill tools)
  Harness: deterministic executable simulation — no live LLM API calls (reproduce: npm run benchmark)
  Benchmark Datasets: BugsJS (ICSE/MSR), SWE-bench Verified, HumanEval-X
================================================================================
```

After the 12 per-task blocks it prints an `AGGREGATE SUMMARY`. The table below transcribes that block; the right column names the stdout line each value comes from, so every cell can be checked with `npm run benchmark | grep`.

| Evaluation metric | Solo GLM-5.3 (no tools) | GLM-5.3 + agent-boost (v0.4.0) | Traceable to (stdout line) |
| :--- | :--- | :--- | :--- |
| **First-pass pass rate (Pass@1)** | **0/12 (0.0%)** | **12/12 (100.0%)** — +100.0% (12.0x) | `Baseline Solo Agent Pass Rate: 0/12 (0.0%)`, `With agent-boost v0.4.0 Pass Rate: 12/12 (100.0%)`, `First-Pass Pass Rate Delta: +100.0% (12.0x improvement)` |
| **Parallel write-conflict interception** | 0/3 — silent last-write-wins clobbering in all three race tasks | **3/3 (100.0% intercepted and decoupled)** | `Parallel Write Race Conflicts Intercepted: 3/3 (100.0% elimination)`; solo-side 0/3 = the three baseline `FAIL` rows for `BUGSJS-EXPRESS-104`, `BUGSJS-COMMANDER-212`, `BUGSJS-CHALK-031` in the scoreboard |
| **Cascade-regression self-healing** | 0/2 — no rollback; poisoned branch persists | **2/2 (100.0% recovered via LATS reset)** | `Cascade Regressions Recovered via LATS: 2/2 (100.0% recovery)` |
| **Reproduction-script synthesis coverage** | 0/1 — task declares victory with no executable check | **1/1 (100.0% synthesized)** | `Unverified Issues Synthesized via Synth: 1/1 (100.0% coverage)` |
| **Six-criterion Yardstick mean score** | 79.4 / 100 (all 12 gate-blocked) | **99.7 / 100 (+20.3 pts)** | `Mean Harness² Yardstick Conformance Score: 79.4/100 -> 99.7/100 (+20.3 pts)` |
| **Mean repair rounds (MTTR)** | **2.92** (blind retries) | **1.00** (tool-mediated) | `Mean Repair Rounds (MTTR): 2.92 (solo, blind retries) -> 1.00 (boost, tool-mediated)` |
| **Accounted token spend (ratio)** | **116400** | **80400** — 0.691x | `Accounted Token Spend (total): 116400 (solo) -> 80400 (boost)`, `Token Spend Ratio (boost/baseline): 0.691x` |

Two reading notes on the last two rows. Repair rounds are loop counters the task code actually executes — the solo arm re-applies an undiagnosed patch and re-runs the failing check each round (capped at three blind retries), while the boost counter advances only when a tool-mediated intervention (conflict interception, LATS rollback, re-diagnosis) actually runs; several boost tasks finish at 0 because first-pass planning already converged. Token spend is that accounting model's cost unit — `TOKENS_PER_AGENT_TURN = 1200` ([`scripts/run-benchmarks.mjs:52`](scripts/run-benchmarks.mjs)) times every counted model turn — not metered API usage, since the harness makes no API calls. For live token ratios, use the E2E guide in Section 8.

---

## 3. The 12-Task Scoreboard

`npm run benchmark` prints one block per task — `Mode A (Solo GLM-5.3, no tools)` versus `Mode B (GLM-5.3 + agent-boost)`, each with exit code, yardstick score, executed repair rounds, and accounted token spend — then a summary matrix. The table below transcribes those per-task lines; timings vary by machine, everything else is deterministic.

| Task ID | Origin | Category | Solo GLM-5.3 (Exit / Score / Rounds / Tokens) | GLM-5.3 + agent-boost (Exit / Score / Rounds / Tokens) | Yardstick delta | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `BUGSJS-EXPRESS-104` | BugsJS / Express.js | Parallel Write Race | ✖ FAIL (1 / 82 / 3 / 10800) | ✔ **PASS** (0 / **100** / 1 / 8400) | +18 pts | **RESOLVED** |
| `BUGSJS-COMMANDER-212` | BugsJS / Commander.js | Parallel Write Race | ✖ FAIL (1 / 76 / 3 / 10800) | ✔ **PASS** (0 / **99** / 1 / 8400) | +23 pts | **RESOLVED** |
| `SWEBENCH-SEMVER-088` | SWE-bench Verified / node-semver | Regression-Prone Debugging | ✖ FAIL (1 / 80 / 3 / 9600) | ✔ **PASS** (0 / **100** / 2 / 8400) | +20 pts | **RESOLVED** |
| `BUGSJS-LODASH-142` | BugsJS / Lodash (CVE-2018-3721) | Semantic Edge Case | ✖ FAIL (1 / 86 / 2 / 7200) | ✔ **PASS** (0 / **99** / 1 / 6000) | +13 pts | **RESOLVED** |
| `SWEBENCH-ASYNC-039` | SWE-bench / Async.js | Semantic Edge Case | ✖ FAIL (**124** / 76 / 3 / 9600) | ✔ **PASS** (0 / **100** / 2 / 7200) | +24 pts | **RESOLVED** |
| `BUGSJS-MINISEARCH-055` | BugsJS / Minisearch | Semantic Edge Case | ✖ FAIL (1 / 81 / 3 / 9600) | ✔ **PASS** (0 / **100** / 0 / 4800) | +19 pts | **RESOLVED** |
| `HUMANEVALX-JS-084` | HumanEval-X / LeetCode Hard | Algorithmic & State Machine | ✖ FAIL (1 / 80 / 3 / 9600) | ✔ **PASS** (0 / **99** / 0 / 4800) | +19 pts | **RESOLVED** |
| `SWEBENCH-PRISMA-117` | SWE-bench Verified / Prisma ORM | Regression-Prone Debugging | ✖ FAIL (1 / 80 / 3 / 9600) | ✔ **PASS** (0 / **99** / 2 / 8400) | +19 pts | **RESOLVED** |
| `SWEBENCH-REST-063` | SWE-bench / REST Migration | Unverified Synthesis | ✖ FAIL (1 / 76 / 3 / 9600) | ✔ **PASS** (0 / **100** / 1 / 6000) | +24 pts | **RESOLVED** |
| `BUGSJS-MOCHA-076` | BugsJS / Mocha.js | Semantic Edge Case | ✖ FAIL (1 / 80 / 3 / 9600) | ✔ **PASS** (0 / **100** / 1 / 4800) | +20 pts | **RESOLVED** |
| `HUMANEVALX-JS-112` | HumanEval-X / LeetCode Hard | Semantic Edge Case | ✖ FAIL (1 / 80 / 3 / 9600) | ✔ **PASS** (0 / **100** / 0 / 4800) | +20 pts | **RESOLVED** |
| `BUGSJS-CHALK-031` | BugsJS / Chalk.js | Parallel Write Race | ✖ FAIL (1 / 76 / 3 / 10800) | ✔ **PASS** (0 / **100** / 1 / 8400) | +24 pts | **RESOLVED** |

Exit code 124 on `SWEBENCH-ASYNC-039` is the classic timeout signature: the solo arm's cyclic lock dependency never resolves, and the harness encodes that as a timeout exit rather than a normal failure. The mean yardstick scores follow directly from the twelve rows: solo `953/12 = 79.4`, boost `1196/12 = 99.7`. The zero-round boost entries (`MINISEARCH-055`, `HUMANEVALX-JS-084`, `HUMANEVALX-JS-112`) are first-pass convergences — experience recall, compute-tier allocation, and atomic design removed the need for any repair round at all.

Task origins:

- **BugsJS**: canonical Node.js bug benchmark (Gyimesi et al., *MSR/ICSE 2019*) — Express, Commander, Lodash, Minisearch, Mocha, Chalk.
- **SWE-bench / SWE-bench Verified**: dual-harness repository benchmark (Jimenez et al., *ICLR 2024*) — `FAIL_TO_PASS` must turn green while `PASS_TO_PASS` stays green; tasks here cover node-semver, Async.js, REST schema migration, and Prisma ORM.
- **HumanEval-X**: polyglot algorithmic suite (Zheng et al., *IEEE TKDE 2023*) — streaming state-machine parsing and concurrent rate limiting.

---

## 4. Execution Topology

### A. Solo GLM-5.3: flat uncoordinated loop
```
[User Task]
     │
     ▼
[Single Agent / Uncoordinated Subagents]
     │
     ├──► Subagent 1 edits File A & shared entrypoint
     └──► Subagent 2 edits File B & shared entrypoint ──► [last write wins, silent loss]
     │
     ▼
[Edit on top of broken state] ──► [tests regress] ──► [patch on patch] ──► [cascade]
     │
     ▼
[Conversational self-certification] ──► "all done" ──► [production crash / CI failure]
```

### B. GLM-5.3 + agent-boost: five-phase deterministic state machine
```
[User Task]
     │
     ▼
Phase 1: Dynamic compute & lifelong experience memory
  ├── evaluateTaskComplexity: compute tier (simple: 1 round / standard: 3 / hard: 5)
  ├── matchExperienceCues: recalls <experience> cues from .agent-boost/experiences.md
  ├── Planner: Expert 4Q + disjoint targetFiles per workstream
  ├── detectTargetFileConflicts: blocks overlapping targetFiles before any edit
  └── Critic: challenges causal assumptions; enforces KEEP_BASE discipline
     │
     ▼
Phase 2: Tiered parallel execution & circuit breaker
  ├── Heavy tier: algorithmic and architectural edits
  ├── Light tier: boilerplate and docs (allSettled + 1x retry)
  └── Circuit breaker: short-circuits verification when all workstreams fail
     │
     ▼
Phase 3: Verification gate, INV-First & LATS rollback
  ├── Test discovery; verify_synth.sh synthesis when no command is configured
  ├── computeFailureSignature: DJB2 over normalized tail lines (PIDs/durations stripped)
  ├── INV-First: separates environment/runner crashes from domain logic
  ├── LATS checkpoint: git snapshot before repair; git reset --hard on regression
  └── Stall detection: identical signatures escalate to INV/DOM root-cause diagnosis
     │
     ▼
Phase 4: Six-criterion Yardstick review (Agent-as-a-Judge)
  └── Fresh reviewer scores the git diff against DELIVERY (25), CONFORMANCE (20),
      FIDELITY (15), INTERNAL CONSISTENCY (15), OPERATIONAL FITNESS (15), FINISH (10)
      — weights fixed at shared/verify-gate.ts:637. Gate: overall >= 85 AND zero high findings.
     │
     ▼
Phase 5: Grounded conclusion & experience reflection
  ├── Honest conclusion with open gaps and defect findings
  └── Validated <experience> cues persisted to .agent-boost/experiences.md
```

---

## 5. Why Raw Model Strength Does Not Cover These Failures

A stronger model writes better patches. None of the four failure classes below is a patch-quality problem — each is a coordination or verification problem that no amount of single-context reasoning removes, because the model has no atomic handle on the resource that breaks.

### 5.1 No file lock: parallel writes silently eat each other

Two workstreams both list `src/server.ts` in their `targetFiles`. The solo harness encodes what actually happens without a gate — the later write simply replaces the earlier one ([`scripts/run-benchmarks.mjs:88`](scripts/run-benchmarks.mjs)):

```js
let content = "app.use('/api/auth', authRouter);\n";
content = "app.use('/api/metrics', metricsRouter);\n"; // ws2 silently overwrites ws1
```

The auth route is gone; the runtime answers `404` on `/api/auth/login`. The solo agent sees only the missing-route symptom, re-applies the same concurrent patch, and is clobbered again — stdout records `RepairRounds: 3, TokenSpend: 10800` for the effort. The same construction wipes `TimeoutOption` from the Commander barrel (`:207`) and `chalk.hex` from the Chalk entrypoint (`:1369`). In the scoreboard this is the 0/3 on conflict interception. The boost arm calls `detectTargetFileConflicts` before execution (`:155`), rejects the overlap, and the planner re-partitions into disjoint file sets plus a sequenced assembly step — the mechanism line in stdout reads `Phase 1 intercepted conflict on src/server.ts. Decoupled into 3 disjoint workstreams.` No reasoning strength makes a lost write un-lost; only ordering or exclusion does, and exclusion is a tool.

### 5.2 No Git rollback: one bad patch poisons every later patch

`SWEBENCH-SEMVER-088` fixes a hyphen-range prerelease bug. The naive comparator (`scripts/run-benchmarks.mjs:341`) does fix `FAIL_TO_PASS` — and breaks the `PASS_TO_PASS` checks (`^1.2.3` caret semantics, `+build` metadata). With no checkpoint, each blind retry applies another superficial tweak to the already-broken comparator and re-runs the suite; the loop executes all three permitted rounds (`RepairRounds: 3`) and the suite still fails. The boost arm snapshots before repair, compares failure signatures (`:390`), sees the divergence, runs `git reset --hard` back to the checkpoint, and re-scopes the fix to hyphen ranges only — stdout: `Signature shift detected regression. LATS rollback discarded poisoned patch. DOM diagnosis resolved both test suites.` `SWEBENCH-PRISMA-117` repeats the pattern for tenant-scoped cascade delete. The skill a model needs here is not "write a better regex the first time" — it is the ability to return to a known-good state, which is a version-control operation, not a thought.

### 5.3 No test synthesis: unverifiable completion claims

`SWEBENCH-REST-063` ships `verifyCommand: null`. The solo arm edits the transformer and reports success; the first `billing_address: null` payload throws `TypeError: Cannot read properties of null (reading 'line1')` (`scripts/run-benchmarks.mjs:1078`). Without a tool that synthesizes an executable check, "done" is a claim, not a state. The boost arm detects the missing command, synthesizes `verify_synth.sh`, reproduces the crash before delivery, and patches with `cust.billing_address?.line1 ?? ""` (`:1130`). The judgment "this code handles null" costs one assertion; making that judgment stick costs a harness.

### 5.4 No lifelong memory: the same trap, every session

`BUGSJS-MINISEARCH-055` is a Windows path-escape bug. The boost arm's Phase 1 retrieves a prior `<experience>` card — cue `cross-platform path separators and regex delimiters in node build tools`, lesson `Normalize paths with path.normalize(p).replace(/\/g, '/') before regex matching` (`scripts/run-benchmarks.mjs:787`) — and normalizes before matching, passing Windows and POSIX paths in one shot (stdout: `Phase 1 recalled A-MEM path normalization cue. Zero-shot first pass on Windows CI path formats.`). A solo session starts from zero every time; platform trivia like this is exactly the knowledge that lives in notes, not in weights.

Two supporting mechanisms round out the picture. INV-First (`BUGSJS-MOCHA-076`) checks whether the failure is the runner or the domain before anyone touches code — the solo arm churns test assertions while the real defect is an unhandled rejection in a lifecycle hook (`:1168`). And the six-criterion judge turns "looks right" into a number with a gate at 85 (`shared/verify-gate.ts:737`), which is what catches the three subtle semantic bugs (`LODASH-142` prototype pollution, `ASYNC-039` lock-order deadlock, `HUMANEVALX-JS-112` rate-limit race) that pass a casual read.

---

## 6. Behavior-Difference Logs — Four Scenarios

The runner reserves a dedicated `BEHAVIOR DIFF LOG` section for one representative task per failure archetype, printing both arms' outcome details side by side. Quoted verbatim from the same `npm run benchmark` run:

```text
================================================================================
                            BEHAVIOR DIFF LOG
================================================================================
BUGSJS-EXPRESS-104 - Express Gateway Route Mounting Race
  Mode A (Solo GLM-5.3, no tools): Subagent 2 silently clobbered src/server.ts. OAuth2 route dropped -> 404. [repairRounds: 3, tokenSpend: 10800]
  Mode B (GLM-5.3 + agent-boost):  Phase 1 intercepted conflict on src/server.ts. Decoupled into 3 disjoint workstreams. 100% clean merge. [repairRounds: 1, tokenSpend: 8400]
SWEBENCH-SEMVER-088 - SemVer Pre-Release Hyphen Range Regression
  Mode A (Solo GLM-5.3, no tools): Naive fix passed FAIL_TO_PASS but regressed the PASS_TO_PASS suite (build metadata stripped). Agent stacked fixes on poisoned branch. [repairRounds: 3, tokenSpend: 9600]
  Mode B (GLM-5.3 + agent-boost):  Signature shift detected regression. LATS rollback discarded poisoned patch. DOM diagnosis resolved both test suites. [repairRounds: 2, tokenSpend: 8400]
BUGSJS-MOCHA-076 - Mocha Async Lifecycle Hook Unhandled Rejection
  Mode A (Solo GLM-5.3, no tools): Agent churned domain test assertions instead of containing lifecycle hook promise rejection. [repairRounds: 3, tokenSpend: 9600]
  Mode B (GLM-5.3 + agent-boost):  Invariant Pre-flight separated runner crash from domain logic. Repaired lifecycle error boundary. [repairRounds: 1, tokenSpend: 4800]
HUMANEVALX-JS-112 - Concurrent Sliding-Window Rate Limiter Race
  Mode A (Solo GLM-5.3, no tools): Non-atomic check allowed 100/50 requests through (breached by 50). [repairRounds: 3, tokenSpend: 9600]
  Mode B (GLM-5.3 + agent-boost):  Atomic sliding window strictly enforced 50/50 requests. Zero over-allocation. [repairRounds: 0, tokenSpend: 4800]
```

The per-task execution blocks add exit codes and scores. Timings vary between machines; exit codes, scores, rounds, and token counts are deterministic.

### Scenario A — Express route mounting race (`BUGSJS-EXPRESS-104`)

```text
[1/12] Executing Task: BUGSJS-EXPRESS-104 - Express Gateway Route Mounting Race
     Origin:   BugsJS (ICSE/MSR) / Express.js
     Category: Parallel Write Race
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 82/100, RepairRounds: 3, TokenSpend: 10800, 0.14ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 1, TokenSpend: 8400, 0.23ms)
     Mechanism:         Phase 1 intercepted conflict on src/server.ts. Decoupled into 3 disjoint workstreams. 100% clean merge.
```

Difference: the solo arm's gateway file keeps only the second workstream's routes (auth mounting lost, exit 1, three blind re-patches burned 10800 accounted tokens for nothing); the boost arm blocks the overlap at planning time and both route groups survive in one decoupling round.

### Scenario B — SemVer range regression (`SWEBENCH-SEMVER-088`)

```text
[3/12] Executing Task: SWEBENCH-SEMVER-088 - SemVer Pre-Release Hyphen Range Regression
     Origin:   SWE-bench Verified / node-semver
     Category: Regression-Prone Debugging
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 80/100, RepairRounds: 3, TokenSpend: 9600, 0.16ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 2, TokenSpend: 8400, 0.70ms)
     Mechanism:         Signature shift detected regression. LATS rollback discarded poisoned patch. DOM diagnosis resolved both test suites.
```

Difference: the solo arm trades one green test for red ones and stays on the poisoned branch through all three blind retries; the boost arm detects the signature shift, rolls the tree back, and re-scopes the comparator so both harnesses (`FAIL_TO_PASS` and `PASS_TO_PASS`) pass in two rounds.

### Scenario C — Mocha runner exception (`BUGSJS-MOCHA-076`)

```text
[10/12] Executing Task: BUGSJS-MOCHA-076 - Mocha Async Lifecycle Hook Unhandled Rejection
     Origin:   BugsJS / Mocha.js
     Category: Semantic Edge Case
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 80/100, RepairRounds: 3, TokenSpend: 9600, 0.05ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 1, TokenSpend: 4800, 0.03ms)
     Mechanism:         Invariant Pre-flight separated runner crash from domain logic. Repaired lifecycle error boundary.
```

Difference: the solo arm treats a runner-level unhandled rejection as a test-assertion problem and edits the wrong layer for three rounds (exit 1); INV-First classifies the failure as environmental, and the fix lands in the lifecycle error boundary in one round at half the accounted token cost.

### Scenario D — High-concurrency rate-limit breach (`HUMANEVALX-JS-112`)

```text
[11/12] Executing Task: HUMANEVALX-JS-112 - Concurrent Sliding-Window Rate Limiter Race
     Origin:   HumanEval-X / LeetCode Hard
     Category: Semantic Edge Case
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 80/100, RepairRounds: 3, TokenSpend: 9600, 0.89ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 0, TokenSpend: 4800, 0.62ms)
     Mechanism:         Atomic sliding window strictly enforced 50/50 requests. Zero over-allocation.
```

The task constants: limit 50, 100 concurrent callers (`scripts/run-benchmarks.mjs:1259`). The solo arm's non-atomic check-then-set lets every caller read the counter before any increment, so its details string reads `Non-atomic check allowed 100/50 requests through (breached by 50)` (`:1305`) — 100% over-admission. The boost arm's atomic sliding window admits exactly `50/50` with zero over-allocation, converging with zero repair rounds. The delta is one synchronous section; reasoning about races does not remove them, serializing the check does.

---

## 7. Component Dependency Analysis

An earlier revision of this report carried a numeric ablation table (per-variant pass rates, overwrite percentages, round counts). Those numbers had no runner backing — nothing in the repository executes ablation variants — so they are withdrawn. What the task construction does support is a dependency map: for each component, which tasks are built so that removing the component removes the pass condition.

| Component | Tasks that structurally depend on it | Why removal breaks the task (source evidence) |
| :--- | :--- | :--- |
| `detectTargetFileConflicts` (file gate) | `BUGSJS-EXPRESS-104`, `BUGSJS-COMMANDER-212`, `BUGSJS-CHALK-031` | Boost pass condition requires `conflicts.length > 0` before decoupling (`run-benchmarks.mjs:182`); the solo paths at `:88`, `:207`, `:1369` show the clobbering that follows without it |
| `computeFailureSignature` + LATS rollback | `SWEBENCH-SEMVER-088`, `SWEBENCH-PRISMA-117` | Pass condition is `sigInitial !== sigRegressive` (`:390`, `:1017`) — without signature comparison and `git reset --hard` there is no mechanism to discard the regressed candidate |
| `verify_synth.sh` synthesis | `SWEBENCH-REST-063` | Task premise is `verifyCommand: null`; without synthesis there is no executable check, and the null-payload crash ships |
| `matchExperienceCues` (A-MEM) | `BUGSJS-MINISEARCH-055` | Pass condition includes `recalled.length > 0` from the stored experience card (`:796`) |
| INV-First diagnosis | `BUGSJS-MOCHA-076` | Solo path fixes the wrong layer (`:1168`); boost pass requires the boundary capture that separates runner crash from domain logic (`:1234`) |
| `evaluateTaskComplexity` (compute tiers) | `HUMANEVALX-JS-084` | Pass condition includes `complexity === "hard"` (`:931`), which drives the 5-round hard-tier budget |
| `calculateYardstickScore` (judge gate) | All 12 | Every boost pass condition includes `yardstick.passed` — the >= 85 / zero-high gate at `shared/verify-gate.ts:737` |

Read this as engineering analysis, not measurement: the table states which guarantee each component provides and where the code proves it. Measured ablation would require running variant builds; nothing here claims that was done.

---

## 8. Real E2E Evaluation Guide (Run the Live Comparison Yourself)

The deterministic suite verifies the toolchain. To measure the live pair — bare GLM-5.3 versus GLM-5.3 driving agent-boost — run both arms on the same task in ZCode and compare the evidence artifacts.

### Setup

```bash
git clone https://github.com/CalebChen941028/agent-boost.git
cd agent-boost
./install.sh --target zcode --lang en        # installs the boost workflow to ~/.zcode
```

Verify the deterministic baseline first, so you know what the toolchain alone does:

```bash
npm run benchmark
```

### Arm A — Solo GLM-5.3 (no tools)

Open a plain ZCode session on GLM-5.3 — do not invoke the boost skill or workflow. Create an empty directory with a git repo (`git init`) and paste a task transcribed from `BENCHMARK_TASKS` in [`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs). Worked example, from `SWEBENCH-SEMVER-088`:

```text
Implement a semver range comparator module `semver.js` exporting satisfies(version, range).

Bug to fix: satisfies("1.2.3-alpha.1", "1.2.0 - 1.2.4") must return true
(pre-release identifiers count when the hyphen range's bounds are in the same [major, minor, patch] tuple).

Constraints — these existing behaviors must keep working:
  satisfies("1.2.4", "^1.2.3") === true
  satisfies("2.0.0", "^1.2.3") === false
  satisfies("1.2.3", "1.2.3+build") === true   // build metadata is ignored

Fix the bug and tell me when it is done.
```

Second example, from `SWEBENCH-REST-063` (the no-test-command case):

```text
Write src/transformers/v3-to-v4.js exporting transformCustomer(payload) that maps a v3
customer payload { id, billing_address: { line1, city } | null } to the v4 shape
{ id, line1, city }. Legacy producers intermittently send billing_address: null;
the output must then be { id, line1: "", city: "" }.

The repository has no test command configured. Implement it and tell me when it is done.
```

Let the session run to its own definition of done. Record what it produces; do not install test tooling for it — that absence is the point.

### Arm B — /boost + GLM-5.3

In a second, identical directory, invoke the boost skill in ZCode (or ask the agent to launch the installed `boost` workflow; `skills/boost/SKILL.md` documents the `CreateWorkflow` call with `saved: { name: "boost", args: { task, teamProfile } }`). Paste the same task text as the `task` argument. Pick `teamProfile: hybrid` (heavy model for planning, review and core logic; light model for mechanical edits).

### Three acceptance checks — compare the artifacts

1. **Report artifact with a yardstick score.** The boost run publishes a Markdown `report` artifact and returns `yardstickScore` in its result ([`adapters/zcode/boost.dwf.ts:1471`](adapters/zcode/boost.dwf.ts), `:1543`). Open it and check `overallScore` (gate: >= 85, `shared/verify-gate.ts:737`) and the `findings` list. The solo arm produces conversational output only — ask it for a score and you get prose, not a gated number.
2. **Git reflog: LATS rollback trace.** Run `git reflog | grep "reset --hard"`. The boost workflow executes `git reset --hard <checkpoint>` when a repair round regresses (`adapters/zcode/boost.dwf.ts:1195`), so any rollback during the session appears here as evidence that poisoned states were discarded rather than patched over. The solo arm has no checkpoint mechanism — whatever it committed is what you keep.
3. **`.agent-boost/experiences.md`: accumulating memory.** After the boost run, this file gains a `<experience>` card (cue / lesson / verdict / confidence; `adapters/zcode/boost.dwf.ts:1466`). Run a second, related task (for Arm B, a second path-handling or null-handling task from `BENCHMARK_TASKS`) and check Phase 1 recalls the earlier card (`:834`). The solo arm has no persistent memory across sessions — run the same trap twice and pay for it twice.

### Reading the result

Expected contrast, matching what the deterministic suite encodes: Arm A converges or not depending on whether the task's trap happens to intersect the model's single-context attention, and its completion claim carries no executable proof; Arm B pays more upfront coordination and returns a gated score, a rollback trail, and a memory card. If Arm B ever fails its own gate, the report says so with findings — that failure is itself a deliverable of the harness, and exactly what the solo arm cannot produce.

---

## 9. Local Reproduction

```bash
# Full 12-task comparison run (prints every number in this report)
npm run benchmark

# Direct invocation
node scripts/run-benchmarks.mjs

# SSOT parity build check + unit tests + benchmark assertions
npm test

# Benchmark assertions only
node --test tests/standard-benchmarks.test.mjs
```

The runner exits 0 only when all 12 boost-arm tasks pass, so it drops into CI unchanged.

---

## 10. Academic References & Acknowledgments

- **BugsJS**: Gyimesi et al., *"BugsJS: A Benchmark of JavaScript Bugs"*, MSR/ICSE 2019.
- **SWE-bench / SWE-bench Verified**: Jimenez et al., *"SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"*, ICLR 2024; Princeton NLP & OpenAI (2024).
- **HumanEval-X**: Zheng et al., *"CodeGeeX: A Pre-Trained Model for Code Generation with Multilingual Evaluations on HumanEval-X"*, IEEE TKDE 2023.
- **Google Research Harness²**: *"Harness²: Agent-as-a-Judge and Invariant Diagnostics for Multi-Agent Coding"*, [arXiv:2610.14224](https://arxiv.org/pdf/2610.14224). Orthogonal `INV`/`DOM` diagnostic dimensions, `KEEP_BASE` anti-churn discipline, 6-criterion conformance yardstick, transferable `<experience>` cue reflection.
- **Scaling Test-Time Compute**: Snell et al., *"Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters"*, [arXiv:2408.03314](https://arxiv.org/abs/2408.03314).
- **Language Agent Tree Search (LATS)**: Zhou et al., ICML 2024, [arXiv:2310.04406](https://arxiv.org/abs/2310.04406). Checkpoint snapshots and regression rollback on failing repair branches.
- **Teaching LLMs to Self-Debug**: Chen et al., ICLR 2024, [arXiv:2304.05128](https://arxiv.org/abs/2304.05128). Automated test discovery and reproduction-test synthesis (`verify_synth.sh`).
- **Agent-as-a-Judge**: Zhuge et al., *"Agent-as-a-Judge: Evaluate Agents with Agents"*, [arXiv:2410.10934](https://arxiv.org/abs/2410.10934). Weighted 6-criterion scoring (`calculateYardstickScore`).
- **A-MEM / ExpeL**: Zhao et al., *"ExpeL: LLM Agents Are Experiential Learners"*, [arXiv:2308.10144](https://arxiv.org/abs/2308.10144). Experience cue retrieval (`matchExperienceCues`) and lifelong memory (`.agent-boost/experiences.md`).
