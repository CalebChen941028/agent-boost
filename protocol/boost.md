# Boost Protocol Specification

## 1. Overview

Boost is a runtime-agnostic multi-agent state machine designed for deep reasoning and complex coding problem-solving:
- **Phase 1: Planning & Critique**: Expert 4-question scoping, stretch goal proposal, independent causal scrutiny.
- **Phase 2: Parallel Workstream Execution**: Tiered dispatch (heavy vs. light models) with `Promise.allSettled` and fallback retry.
- **Phase 3: Verification Gate & Stall-Triggered Diagnosis**: Deterministic test execution or independent inspection, tail-output preservation, normalized signature-based stall detection, and root-cause diagnosis.
- **Phase 4: Independent Review**: Unbiased review of actual workspace diffs.
- **Phase 5: Synthesis & Reporting**: Grounded markdown artifact generation, balanced conclusion reflecting both gaps and high-severity findings.

---

## 2. State Machine Transitions

```
[Start]
   │
   ▼
Phase 1: Plan ──(Critique: blocking issues?)──► [Revised Plan]
   │
   ▼
Phase 2: Parallel Execution (allSettled + 1x retry on rejection)
   │
   ▼
Phase 3: Verification Loop (Round 1..3)
   ├── Pass? ──► Phase 4: Independent Review
   └── Fail?
         ├── Identical Normalized Signature? ──► Root Cause Diagnoser ──► Fixer
         └── New Signature? ──► Fixer
                 │
                 └── Max Rounds Exceeded? ──► Record Open Gaps ──► Phase 4
                                                                      │
                                                                      ▼
                                                                Phase 5: Report & Conclusion
```

---

## 3. Input & Output Schema

### Inputs
- `task`: (string, required) Objective and acceptance criteria.
- `context`: (string, optional) Relevant files, constraints, architectural context.
- `verifyCommand`: (string, optional) Deterministic command executed via shell.
- `teamProfile`: (string, enum: `"hybrid" | "quality" | "economy"`, default: `"hybrid"`).
- `lightModel`: (string, optional) Model identifier for light-tier tasks.
- `lang`: (string, enum: `"auto" | "zh" | "en"`, default: `"auto"`).

### Outputs
- `conclusion`: (string) Unbiased statement of outcome reflecting both open gaps and review defects.
- `findings`: (`ReviewFinding[]`) High, medium, low severity issues.
- `verified`: (string[]) Concrete verification commands and inspections performed.
- `notCovered`: (string[]) Unverified aspects or skipped verification checks.
