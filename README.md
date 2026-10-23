# agent-boost

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18+-blue.svg)](https://nodejs.org/)

**Deep Multi-Agent Reasoning, Parallel Execution, and Verification-Gate Workflow for Complex Engineering Tasks.**

`agent-boost` is an open-source multi-agent orchestration architecture designed to solve difficult engineering problems (subtle concurrency bugs, algorithmic hurdles, complex multi-file refactoring, elusive regressions) through structured role specialization, tiered execution, deterministic verification gates, and stall-triggered root-cause diagnosis.

---

## Architecture & Workflow

```
[Problem Task]
      │
      ▼
1. Planning & Critique
   ├── Planner: Scoping with the Expert Four Questions + stretch goal evaluation
   └── Critic: Independent review challenging unverified causal premises
      │
      ▼
2. Tiered Parallel Execution
   ├── Heavy tier: Core algorithmic logic and nuanced investigations
   └── Light tier: Boilerplate, documentation, and mechanical edits (allSettled + retry)
      │
      ▼
3. Deterministic Verification Gate & Stall Prevention
   ├── Tail-preserving error capture (preserves assertion stack traces)
   ├── Normalized 20-line signature comparison (prevents test-runner header false positives)
   └── Automatic escalation to Root-Cause Diagnoser upon repeated failures
      │
      ▼
4. Independent Final Review
   └── Strict diff scrutiny for omissions, regressions, and high-severity defects
      │
      ▼
5. Synthesis & Reporting
   └── User-facing report with honest conclusions reflecting both gaps and findings
```

---

## Key Bug Fixes in v0.2.0

- **B1 (Honest Conclusions)**: Fixes a critical flaw where conclusions blindly claimed success even when independent reviewers flagged high-severity functional bugs.
- **B2 (Tail-Slice Preserved)**: Fixes error truncation that previously discarded assertion failures by keeping head output; now captures combined stdout and stderr tail up to 2000 characters.
- **B3 (Normalized Stall Signatures)**: Fixes static header false-positives in test runners (e.g. `npm test`, `pytest`) by stripping timestamps, addresses, and paths over the last 20 lines.
- **B4 (Neutral Verifier Prompts)**: Replaces biased recheck phrasing ("issues are fixed") with neutral instructions ("Fixer reports changes made. Independently re-verify.").
- **B5 (Fault-Tolerant Execution)**: Replaces fail-fast `Promise.all` with `Promise.allSettled` and automatic single-retry escalation.
- **B7 (Enum Validation)**: Explicit validation for `teamProfile` (`hybrid`, `quality`, `economy`).

---

## Installation

### ZCode Dynamic Workflow
```bash
./install.sh --target zcode --lang zh
```

### Claude Code CLI / Generic Agents
```bash
./install.sh --target claude
./install.sh --target generic --dest /path/to/project
```

---

## Testing

Run unit tests directly:

```bash
node --test tests/verify-gate.test.mjs
```

---

## Credits & Acknowledgments

- **Magentic-One**: Inspired the stall-detection root-cause re-planning pattern and failure diagnostics.
- **claude-flow**: Architectural references for multi-agent shared state and orchestration boundaries.
- **Felix Rieseberg**: Conceptual inspiration for the Expert Four Questions method and stretch acceptance goal evaluation.

---

## Trademark & Project Disclaimer

Antigravity is a trademark of Google LLC. This project is an independent open-source contribution and is not affiliated with, sponsored by, or endorsed by Google LLC or Anthropic.

---

## License

[MIT](LICENSE) © 2026 Liangliang Chen
