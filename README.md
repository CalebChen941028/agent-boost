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
1. Dynamic Compute & Experience Recall (Scaling Test-Time Compute + A-MEM)
   ├── Dynamic Allocation: evaluateTaskComplexity scales workstreams (1–5) and iterations (1–5)
   ├── Memory Retrieval: matchExperienceCues retrieves relevant cues from .agent-boost/experiences.md
   ├── Planner: Expert Four Questions + explicit disjoint targetFiles + stretch criteria
   ├── Conflict Gate: detectTargetFileConflicts blocks overlapping parallel edits
   └── Critic: Challenges unproven causal premises; enforces KEEP_BASE discipline
      │
      ▼
2. Tiered Parallel Execution & Circuit Breaker
   ├── Heavy tier: Core algorithmic logic and root-cause investigations
   ├── Light tier: Boilerplate, documentation, and mechanical edits (allSettled + 1x heavy retry)
   └── Circuit Breaker: Short-circuits verification if all workstreams fail execution
      │
      ▼
3. Deterministic Verification Gate, Test Synthesis & LATS Rollback
   ├── Automated Discovery & Synthesis: Probes test suites; synthesizes reproduction tests (Self-Debugging)
   ├── DJB2 20-line normalized signature (preserves HTTP status codes; strips volatile timestamps/PIDs)
   ├── Git Checkpoint Snapshot & LATS Rollback: Rolls back regressions (git reset --hard)
   ├── Fix History Ledger (fixHistory): Tracks touched files & summaries across repair rounds
   └── Invariant Pre-Flight (INV-First): Diagnoser checks environment/runner invariants before DOM code
      │
      ▼
4. Quantitative Yardstick 6-Criterion Review (Agent-as-a-Judge)
   └── Fresh Reviewer inspects live git diff + fixHistory against DELIVERY (25), CONFORMANCE (20),
       FIDELITY (15), INTERNAL CONSISTENCY (15), OPERATIONAL FITNESS (15), and FINISH (10)
       Pass Gate: Score >= 85 and 0 high-severity findings
      │
      ▼
5. Synthesis, Honest Conclusion & Lifelong Experience Memory
   ├── Grounded Markdown report + honest conclusion reflecting failed workers, gaps & Yardstick score
   └── Lifelong Memory: Persists valid <experience> cues to .agent-boost/experiences.md
```

---

## Key Capabilities in v0.4.0 (Test-Time Compute, LATS Rollback & Yardstick Scoring)

- **Dynamic Test-Time Compute Allocation (`evaluateTaskComplexity`)**: Dynamically allocates compute budget based on task complexity, prompt length, and modified file count across `simple` (1 workstream, 1 repair round), `standard` (2–3 workstreams, 3 rounds), and `hard` (3–5 workstreams, 5 rounds) tiers.
- **LATS Regression Rollback & Git Checkpoints**: Takes an automated git snapshot before each repair round. If a repair candidate escalates test failures or introduces regressions, the tree search automatically rolls back (`git reset --hard`).
- **Self-Debugging Reproduction Test Synthesis**: Verifiers automatically discover repository test harnesses and synthesize deterministic reproduction test scripts (e.g. `verify_synth.sh`) when native tests are missing or unconfigured.
- **Agent-as-a-Judge Quantitative Yardstick Scoring (`calculateYardstickScore`)**: Computes a weighted 6-criterion score (DELIVERY, CONFORMANCE, FIDELITY, INTERNAL_CONSISTENCY, OPERATIONAL_FITNESS, FINISH) with an explicit 85-point passing gate.
- **A-MEM / ExpeL Intelligent Experience Cue Recall (`matchExperienceCues`)**: Intelligently searches and ranks relevant historical `<experience>` cues from `.agent-boost/experiences.md` to guide task planning and avoid past pitfalls.
- **Invariant Pre-Flight (INV-First) Priority**: Root-Cause Diagnoser validates runtime environment and test runner invariants (`isInvariantFailure`) before analyzing domain application code.
- **100% Single-Source-of-Truth (SSOT) Parity (10/10 functions)**: `scripts/build.mjs` verifies exact parameter and function body parity across TypeScript, JavaScript, and ZCode workflows.

---

## Empirical Benchmarks: Solo GLM-5.3 vs GLM-5.3 + agent-boost

Twelve executable benchmark tasks drawn from **BugsJS (ICSE/MSR)**, **SWE-bench / SWE-bench Verified (ICLR 2024)**, and **HumanEval-X (TKDE 2023)** compare one model with no tools against the same model driving the agent-boost state machine. The harness is deterministic and executable — it makes no live LLM API calls — and `npm run benchmark` prints every number below on Node 18+ (CI exercises the same checks on Node 18.x / 20.x / 22.x, see [`ci.yml`](.github/workflows/ci.yml)).

| Benchmark Metric | Solo GLM-5.3 (No Tools) | GLM-5.3 + agent-boost (v0.4.0) |
| :--- | :--- | :--- |
| **First-Pass Pass Rate (Pass@1)** | 0/12 (0.0%) | **12/12 (100.0%)** — +100.0% (12.0x) |
| **Parallel Write Conflict Interception** | 0/3 (silent last-write-wins) | **3/3 (100.0% intercepted)** (`detectTargetFileConflicts`) |
| **Cascade Regression Recovery** | 0/2 (no rollback; poisoned branch persists) | **2/2 (100.0%)** (LATS `git reset --hard`) |
| **Reproduction-Test Synthesis Coverage** | 0/1 (unverified completion claim) | **1/1 (100.0%)** (Self-Debugging `verify_synth.sh`) |
| **Six-Criterion Yardstick Mean Score** | 79.4 / 100 (all 12 gate-blocked) | **99.7 / 100 (+20.3 pts)** (`calculateYardstickScore`) |
| **Mean Repair Rounds (MTTR)** | 2.92 (blind retries) | **1.00** (tool-mediated) |
| **Accounted Token Spend (ratio)** | 116400 | **80400** — 0.691x (`TOKENS_PER_AGENT_TURN = 1200` accounting model) |

> 📊 **Full Report & Case Studies**: per-task scoreboard with exit codes, four behavior-difference scenario logs, component dependency analysis, and the withdrawn-ablation disclosure — [**`BENCHMARKS.md`**](BENCHMARKS.md) (or [**`BENCHMARKS.zh-CN.md`**](BENCHMARKS.zh-CN.md)).
>
> 🧪 **Reproduce Locally**: `npm run benchmark` or `npm test` executes the full 12-task suite in your terminal, in milliseconds.
>
> 🚀 **Run the Live Comparison**: the [Real E2E Evaluation Guide](BENCHMARKS.md#8-real-e2e-evaluation-guide-run-the-live-comparison-yourself) gives copy-paste prompts for racing bare GLM-5.3 against `/boost` + GLM-5.3 on the same tasks in ZCode, with three acceptance checks (report artifact with `yardstickScore`, `git reflog` rollback trace, `.agent-boost/experiences.md` accumulation).

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

- **Google Research Harness² (Xu et al. 2026)** ([arXiv:2610.14224](https://arxiv.org/abs/2610.14224)): Inspired by *"Harness^2: Recursive Agent Harnessing for an Open World"* (Google Cloud AI Research), featuring `INV`/`DOM` orthogonal diagnostic dimensions, `KEEP_BASE` anti-regression discipline, 6-criterion conformance review yardstick, `EVIDENCE IS DATA` boundary, and transferable `<experience>` cue reflection.
- **Scaling Test-Time Compute (Snell et al. 2024)** ([arXiv:2408.03314](https://arxiv.org/abs/2408.03314)): Dynamic test-time compute allocation across task complexity tiers.
- **Self-Debugging (Chen et al. 2023)** ([arXiv:2304.05128](https://arxiv.org/abs/2304.05128)): Automated test discovery and deterministic reproduction test synthesis (`verify_synth.sh`).
- **LATS / Language Agent Tree Search (Zhou et al. 2023)** ([arXiv:2310.04406](https://arxiv.org/abs/2310.04406)): Git checkpoint snapshotting and regression rollback on failing repair branches.
- **Agent-as-a-Judge (Zhuge et al. 2024)** ([arXiv:2410.10934](https://arxiv.org/abs/2410.10934)): Quantitative Yardstick 6-criterion weighted scoring (`calculateYardstickScore`).
- **ExpeL / Experiential Learning (Zhao et al. 2023)** ([arXiv:2308.10144](https://arxiv.org/abs/2308.10144)): Keyword/tag experience cue retrieval (`matchExperienceCues`) and lifelong workspace memory persistence (`.agent-boost/experiences.md`).
- **Magentic-One (Fourney et al. 2024)** ([arXiv:2411.04468](https://arxiv.org/abs/2411.04468)): Inspired the stall-detection root-cause re-planning pattern and failure diagnostics.
- **claude-flow**: Architectural references for multi-agent shared state and orchestration boundaries.
- **Felix Rieseberg**: Conceptual inspiration for the Expert Four Questions method and stretch acceptance goal evaluation.


---

## Trademark & Project Disclaimer

Antigravity is a trademark of Google LLC. This project is an independent open-source contribution and is not affiliated with, sponsored by, or endorsed by Google LLC, Anthropic, OpenAI, DeepSeek, or WorkBuddy. All product names, logos, and brands are property of their respective owners.

---

## License

[MIT](LICENSE) © 2026 Liangliang Chen
