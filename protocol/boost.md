# Boost Protocol Specification

## 1. Overview

Boost is a runtime-agnostic multi-agent state machine designed for deep reasoning and complex engineering problem-solving, integrating **Test-Time Compute Allocation** (Snell et al. 2024, arXiv:2408.03314), **Language Agent Tree Search (LATS)** checkpoint snapshots & rollback (Zhou et al. 2023, arXiv:2310.04406), **Self-Debugging test synthesis** (Chen et al. 2023, arXiv:2304.05128), **Agent-as-a-Judge quantitative yardstick scoring** (Zhuge et al. 2024, arXiv:2410.10934), **ExpeL experiential learning & recall** (Zhao et al. 2023, arXiv:2308.10144), **Magentic-One** stall mitigation (Fourney et al. 2024, arXiv:2411.04468), **Felix Rieseberg**'s Expert Four Questions, and **Google Research Harness²** (`INV`/`DOM` orthogonal diagnosis, `KEEP_BASE` discipline, 6-criterion conformance review, and transferable `<experience>` reflection, arXiv:2610.14224):

- **Phase 1: Planning, Task Complexity & Independent Critique**:
  - **Dynamic Compute Allocation**: Classifies task into `simple`, `standard`, or `hard` (`evaluateTaskComplexity`), dynamically sizing the verification round budget (2, 3, or 5 rounds) and recommending model profiles (`economy`, `hybrid`, `quality`).
  - **Experience Memory Recall**: Intelligently matches relevant historical experience cues (`matchExperienceCues`) from `.agent-boost/experiences.md` based on keyword relevance and confidence, filtering out confounded noise.
  - **Planner**: Answers the Expert Four Questions per workstream, declares explicit disjoint `targetFiles` ownership for parallel `code` workstreams, and evaluates stretch acceptance criteria.
  - **Deterministic Conflict Gate & Critic**: Automatically detects overlapping `targetFiles` across parallel `code` workstreams (`detectTargetFileConflicts`), challenges unproven causal premises, and applies Harness² `KEEP_BASE` discipline (approving sound plans without noisy churn).
- **Phase 2: Parallel Workstream Execution**:
  - Tiered dispatch (`heavy` vs. `light` models) using `Promise.allSettled` with automatic 1x escalation retry on strong models.
  - **All-Failed Circuit Breaker**: If all workstreams fail after retry, short-circuits Phase 3 and Phase 4 to prevent wasted verification tokens and reports execution failure directly.
- **Phase 3: Verification Gate, Invariant Pre-flight, LATS Rollback & INV/DOM Diagnosis**:
  - Deterministic test execution (`verifyCommand`), automatic test runner discovery (`npm test`, `pytest`, `cargo test`, `go test`), or synthesized reproduction check (`verify_synth.sh`), preserving combined `stdout`/`stderr` tail (2000 chars) and computing DJB2-hashed normalized 20-line failure signatures.
  - **Invariant Pre-flight (INV-first)**: Detects syntax, environment, missing module, or runner invocation crashes before domain logic debugging, directing Fixer to repair invariant mechanics first.
  - **LATS Checkpoint & Rollback**: Snapshots a Git checkpoint before repair attempts. If a fix attempt causes catastrophic regression, rolls back to checkpoint before exploring alternative repair branches.
  - **Fix History Ledger (`fixHistory`)**: Tracks every repair round's `{ round, summary, modifiedPaths, dimension, rolledBack }` so downstream agents never inspect stale Phase 2 context.
  - **Stall-Triggered INV/DOM Diagnosis**: When consecutive failure/gap signatures match, escalates to the Root-Cause Diagnoser to separate **INV** (procedure, tool/runner invocation, build state) from **DOM** (domain logic, algorithmic edge cases) before minimal repair.
- **Phase 4: Independent 6-Criterion Review & Quantitative Yardstick Scoring**:
  - Fresh Reviewer inspects live workspace diffs (`git status` / `git diff --stat`), workstream results, and `fixHistory` against the Harness² 6-criterion yardstick: `DELIVERY`, `CONFORMANCE`, `FIDELITY`, `INTERNAL CONSISTENCY`, `OPERATIONAL FITNESS`, and `FINISH`.
  - Computes quantitative **Yardstick Score** (`calculateYardstickScore`, 0–100 scale, pass threshold $\ge 85$).
- **Phase 5: Synthesis, Objective Conclusion & Lifelong Experience Reflection**:
  - Generates grounded Markdown report including Yardstick Score breakdown and extracts at most ONE transferable Harness² `<experience>` cue (or `NO_ENTRY` if `confounded` / `no_observed_effect`), persisting valid cues to `.agent-boost/experiences.md`.
  - Produces an objective conclusion (`formatConclusion`) reflecting failed workstreams, open verification gaps, Yardstick failures, and `high`-severity review findings.

---

## 2. State Machine Transitions

```
[Start]
   │
   ▼
Phase 1: Task Complexity & Plan (Dynamic Compute + Expert 4Q + disjoint targetFiles)
   │──► Deterministic targetFiles Conflict Check + Critic (KEEP_BASE discipline)
   └──► (Blocking issues or file conflicts?) ──► [Revised Plan]
   │
   ▼
Phase 2: Parallel Execution (Promise.allSettled + 1x Heavy Retry)
   ├── All Workstreams Failed? ──► Short-Circuit to Phase 5 (Aborted Conclusion)
   └── At Least 1 Fulfilled ──► Phase 3
   │
   ▼
Phase 3: Verification Loop (Dynamic Rounds) + INV-First Check + LATS Checkpoint
   ├── Pass? ──► Phase 4: Independent 6-Criterion Review
   └── Fail?
         ├── Invariant Pre-flight Failure? ──► INV Root Cause Diagnoser ──► Fixer (Repair INV)
         ├── Identical Normalized Signature? ──► INV/DOM Root Cause Diagnoser ──► Fixer
         ├── Regression Detected? ──► LATS Git Rollback ──► Alternative Repair Branch
         └── New Signature? ──► Fixer (Append FixRecord to fixHistory)
                 │
                 └── Max Rounds Exceeded? ──► Record Open Gaps ──► Phase 4
                                                                      │
                                                                      ▼
                                           Phase 4: 6-Criterion Yardstick Scoring (0-100)
                                                                      │
                                                                      ▼
                                           Phase 5: Scribe Report + Yardstick Breakdown + <experience> Persistence + Conclusion
```

---

## 3. Input & Output Schema

### Inputs
- `task`: (`string`, required) Objective and acceptance criteria.
- `context`: (`string`, optional) Relevant files, constraints, architectural context.
- `verifyCommand`: (`string`, optional) Deterministic command executed via shell.
- `teamProfile`: (`string`, enum: `"hybrid" | "quality" | "economy"`, default: `"hybrid"`).
- `lightModel`: (`string`, optional) Model identifier or alias for light-tier tasks.
- `lang`: (`string`, enum: `"auto" | "zh" | "en"`, default: `"auto"`).

### Outputs
- `conclusion`: (`string`) Unbiased statement of outcome reflecting failed workstreams, open gaps, Yardstick score, and high-severity review defects.
- `findings`: (`ReviewFinding[]`) High, medium, low severity issues.
- `yardstickScore`: (`YardstickScoreResult`, optional) Quantitative 0–100 score across 6 criteria with pass/fail gate.
- `verified`: (`string[]`) Concrete verification commands and inspections performed.
- `notCovered`: (`string[]`) Unverified aspects, failed workstreams, or skipped checks.
- `experience`: (`string`, optional) Formatted Harness² `<experience>` XML block or `"NO_ENTRY"`.
