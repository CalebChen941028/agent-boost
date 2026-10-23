# Boost Protocol Specification

## 1. Overview

Boost is a runtime-agnostic multi-agent state machine designed for deep reasoning and complex engineering problem-solving, integrating **Magentic-One** stall mitigation, **Felix Rieseberg**'s Expert Four Questions, and **Google Research Harness²** (`INV`/`DOM` orthogonal diagnosis, `KEEP_BASE` discipline, 6-criterion conformance review, and transferable `<experience>` reflection):

- **Phase 1: Planning & Independent Critique**:
  - **Planner**: Answers the Expert Four Questions per workstream, declares explicit disjoint `targetFiles` ownership for parallel `code` workstreams, and evaluates stretch acceptance criteria.
  - **Deterministic Conflict Gate & Critic**: Automatically detects overlapping `targetFiles` across parallel `code` workstreams (`detectTargetFileConflicts`), challenges unproven causal premises, and applies Harness² `KEEP_BASE` discipline (approving sound plans without noisy churn).
- **Phase 2: Parallel Workstream Execution**:
  - Tiered dispatch (`heavy` vs. `light` models) using `Promise.allSettled` with automatic 1x escalation retry on strong models.
  - **All-Failed Circuit Breaker**: If all workstreams fail after retry, short-circuits Phase 3 and Phase 4 to prevent wasted verification tokens and reports execution failure directly.
- **Phase 3: Verification Gate, Fix Ledger & INV/DOM Diagnosis**:
  - Deterministic test execution (`verifyCommand`) or independent inspection, preserving combined `stdout`/`stderr` tail (2000 chars) and computing DJB2-hashed normalized 20-line failure signatures (preserving HTTP status codes and semantic assertion values while stripping timestamps, addresses, PIDs, and paths).
  - **Fix History Ledger (`fixHistory`)**: Tracks every repair round's `summary` and `modifiedPaths` so downstream agents never inspect stale Phase 2 context.
  - **Stall-Triggered INV/DOM Diagnosis**: When consecutive failure/gap signatures match, escalates to the Root-Cause Diagnoser to separate **INV** (procedure, tool/runner invocation, build state) from **DOM** (domain logic, algorithmic edge cases) before minimal repair.
- **Phase 4: Independent 6-Criterion Review**:
  - Fresh Reviewer inspects live workspace diffs (`git status` / `git diff --stat`), workstream results, and `fixHistory` against the Harness² 6-criterion yardstick: `DELIVERY`, `CONFORMANCE`, `FIDELITY`, `INTERNAL CONSISTENCY`, `OPERATIONAL FITNESS`, and `FINISH`.
- **Phase 5: Synthesis, Objective Conclusion & Experience Reflection**:
  - Generates grounded Markdown report and extracts at most ONE transferable Harness² `<experience>` cue (or `NO_ENTRY` if `confounded` / `no_observed_effect`).
  - Produces an objective conclusion (`formatConclusion`) reflecting failed workstreams, open verification gaps, and `high`-severity review findings.

---

## 2. State Machine Transitions

```
[Start]
   │
   ▼
Phase 1: Plan (Expert 4Q + disjoint targetFiles)
   │──► Deterministic targetFiles Conflict Check + Critic (KEEP_BASE discipline)
   └──► (Blocking issues or file conflicts?) ──► [Revised Plan]
   │
   ▼
Phase 2: Parallel Execution (Promise.allSettled + 1x Heavy Retry)
   ├── All Workstreams Failed? ──► Short-Circuit to Phase 5 (Aborted Conclusion)
   └── At Least 1 Fulfilled ──► Phase 3
   │
   ▼
Phase 3: Verification Loop (Round 1..3) + Fix History Ledger
   ├── Pass? ──► Phase 4: Independent 6-Criterion Review
   └── Fail?
         ├── Identical Normalized Signature? ──► INV/DOM Root Cause Diagnoser ──► Fixer (Append FixRecord)
         └── New Signature? ──► Fixer (Append FixRecord)
                 │
                 └── Max Rounds Exceeded? ──► Record Open Gaps ──► Phase 4
                                                                      │
                                                                      ▼
                                           Phase 5: Scribe Report + <experience> Cue + Conclusion
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
- `conclusion`: (`string`) Unbiased statement of outcome reflecting failed workstreams, open gaps, and high-severity review defects.
- `findings`: (`ReviewFinding[]`) High, medium, low severity issues.
- `verified`: (`string[]`) Concrete verification commands and inspections performed.
- `notCovered`: (`string[]`) Unverified aspects, failed workstreams, or skipped checks.
- `experience`: (`string`, optional) Formatted Harness² `<experience>` XML block or `"NO_ENTRY"`.
