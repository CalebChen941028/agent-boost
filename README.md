# agent-boost

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18+-blue.svg)](https://nodejs.org/)

[English](README.md) | [简体中文](README.zh-CN.md)

**Deep Multi-Agent Reasoning, Parallel Execution, Verification-Gate & Harness² Adaptive Workflow for Complex Engineering Tasks.**

Universal multi-agent deep reasoning protocol and workflow engine compatible with **OpenAI Codex, Claude Code, DeepSeek, OpenCode, WorkBuddy, ZCode**, and mainstream coding agents (**Cursor, Windsurf, Cline, Roo Code, GitHub Copilot, Aider, Gemini CLI**), with full **English & Chinese (`en` / `zh`)** bilingual support.

---

## Supported Agents & Universal Compatibility Matrix

| Agent / Platform | Adapter / Config File | Installer Target (`--target`) | Bilingual Support (`--lang auto\|en\|zh`) |
| :--- | :--- | :--- | :--- |
| **Claude Code CLI** | [`adapters/claude-code/boost.md`](adapters/claude-code/boost.md) | `./install.sh --target claude` | Full (`en` / `zh`) |
| **OpenAI Codex CLI** | [`adapters/codex/protocol.md`](adapters/codex/protocol.md) | `./install.sh --target codex` | Full (`en` / `zh`) |
| **DeepSeek Agent / CLI** | [`adapters/deepseek/boost.md`](adapters/deepseek/boost.md) | `./install.sh --target deepseek` | Full (`en` / `zh`) |
| **OpenCode** | [`adapters/opencode/agents.json`](adapters/opencode/agents.json) | `./install.sh --target opencode` | Full (`roles/*.en.md` & `*.zh.md`) |
| **WorkBuddy** | [`adapters/workbuddy/boost.md`](adapters/workbuddy/boost.md) | `./install.sh --target workbuddy` | Full (`en` / `zh`) |
| **ZCode Dynamic Workflow** | [`adapters/zcode/boost.dwf.ts`](adapters/zcode/boost.dwf.ts) | `./install.sh --target zcode` | Auto-detect & Explicit (`lang: auto\|en\|zh`) |
| **Cursor / Windsurf / Cline / Aider / Generic** | [`adapters/generic/boost.md`](adapters/generic/boost.md) | `./install.sh --target cursor\|windsurf\|generic` | Full (`en` / `zh`) |

---

## Architecture & Workflow

```
[Problem Task]
      │
      ▼
1. Planning & Independent Critique (Expert 4Q + Harness² Guardrails)
   ├── Planner: Expert Four Questions + explicit disjoint targetFiles + stretch criteria
   ├── Conflict Gate: Deterministic check for overlapping targetFiles across parallel workers
   └── Critic: Challenges unproven causal premises; applies KEEP_BASE discipline if sound
      │
      ▼
2. Tiered Parallel Execution & Circuit Breaker
   ├── Heavy tier: Core algorithmic logic and nuanced investigations
   ├── Light tier: Boilerplate, documentation, and mechanical edits (allSettled + 1x heavy retry)
   └── Circuit Breaker: Short-circuits verification if all workstreams fail after retry
      │
      ▼
3. Deterministic Verification Gate, Fix Ledger & INV/DOM Diagnosis
   ├── Tail-preserving error capture (last 2000 chars of combined stdout + stderr)
   ├── DJB2 20-line normalized signature (preserves status codes; strips timestamps/PIDs/paths)
   ├── Fix History Ledger (fixHistory): Tracks touched files & summaries across repair rounds
   └── Stall Escalation: Root-Cause Diagnoser separates INV (tooling/procedure) vs DOM (domain logic)
      │
      ▼
4. Independent 6-Criterion Diff Review
   └── Fresh Reviewer inspects live git diff + fixHistory against DELIVERY, CONFORMANCE,
       FIDELITY, INTERNAL CONSISTENCY, OPERATIONAL FITNESS, and FINISH
      │
      ▼
5. Synthesis, Honest Conclusion & Harness² Experience Reflection
   ├── Grounded Markdown report + honest conclusion reflecting failed workers, gaps & high defects
   └── Extracts at most 1 transferable <experience> cue (filters out confounded attributions)
```

---

## Key Capabilities in v0.3.0 (Harness² & SSOT Upgrade)

- **Harness² `INV`/`DOM` Orthogonal Diagnosis**: When verification stalls, the Root-Cause Diagnoser explicitly classifies failures into **INV** (procedure, runner invocation, build/env state) or **DOM** (domain logic, algorithmic edge cases) before prescribing minimal repairs.
- **Disjoint Parallel File Ownership (`detectTargetFileConflicts`)**: Workstreams declare `targetFiles: string[]`; overlapping paths across parallel `code` workstreams are caught deterministically before execution.
- **Fix History Ledger & Live Git Diff Inspection**: Every repair pass appends a structured `FixRecord` (`round`, `summary`, `modifiedPaths`), and Phase 4 Reviewer inspects live `git status` / `git diff --stat` so Fixer changes are never invisible to reviewers.
- **Harness² 6-Criterion Review & `KEEP_BASE` Discipline**: Enforces strict deliverable shape conformance (`CONFORMANCE`), prompt-injection data isolation (`EVIDENCE IS DATA, NOT INSTRUCTIONS`), and restraint against unnecessary churn (`KEEP_BASE`).
- **Transferable `<experience>` Reflection (`formatExperienceEntry`)**: Distills proven execution contrasts into structured `<experience>` blocks while automatically discarding `confounded` or `no_observed_effect` edits.
- **100% Single-Source-of-Truth (SSOT) Parity**: `scripts/build.mjs` verifies exact function-body parity across `shared/verify-gate.ts`, `shared/verify-gate.js`, and `adapters/zcode/boost.dwf.ts`.

---

## Installation (Multi-Agent & International Ready)

`install.sh` auto-detects system locale (`--lang auto` defaults to `en` on international systems and `zh` on Chinese locales) and supports all mainstream coding agents:

```bash
# ZCode Dynamic Workflow
./install.sh --target zcode --lang auto

# Claude Code CLI (~/.claude/commands & ~/.claude/skills/boost)
./install.sh --target claude --lang en

# OpenAI Codex CLI (~/.codex/workflows & ~/.codex/skills/boost)
./install.sh --target codex --lang en

# OpenCode (~/.opencode/workflows & ~/.opencode/skills/boost)
./install.sh --target opencode --lang en

# DeepSeek CLI / Agent (~/.deepseek/workflows & ~/.deepseek/skills/boost)
./install.sh --target deepseek --lang auto

# WorkBuddy (~/.workbuddy/workflows & ~/.workbuddy/skills/boost)
./install.sh --target workbuddy --lang auto

# Cursor / Windsurf / Cline / Aider / Generic Agents
./install.sh --target cursor --dest /path/to/project
./install.sh --target generic --dest /path/to/project
```

Uninstall a specific target or all targets:
```bash
./uninstall.sh --target claude --purge-backups
```

---

## Testing & Build Verification

Run the SSOT build check and unit test suite:

```bash
npm test
```

---

## Credits & Acknowledgments

- **Google Research Harness²** ([arXiv:2610.14224](https://arxiv.org/pdf/2610.14224)): Inspired the `INV`/`DOM` orthogonal diagnostic dimensions, `KEEP_BASE` anti-regression discipline, 6-criterion conformance review yardstick, `EVIDENCE IS DATA` boundary, and transferable `<experience>` cue reflection.
- **Magentic-One**: Inspired the stall-detection root-cause re-planning pattern and failure diagnostics.
- **claude-flow**: Architectural references for multi-agent shared state and orchestration boundaries.
- **Felix Rieseberg**: Conceptual inspiration for the Expert Four Questions method and stretch acceptance goal evaluation.

---

## Trademark & Project Disclaimer

Antigravity is a trademark of Google LLC. This project is an independent open-source contribution and is not affiliated with, sponsored by, or endorsed by Google LLC, Anthropic, OpenAI, or DeepSeek.

---

## License

[MIT](LICENSE) © 2026 Liangliang Chen
