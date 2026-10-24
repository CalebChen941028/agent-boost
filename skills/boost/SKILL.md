---
name: boost
description: >-
  Boost multi-agent deep reasoning & verification engine (powered by Test-Time Compute allocation,
  LATS Tree Search rollback, Self-Debugging test synthesis, Agent-as-a-Judge yardstick scoring,
  Magentic-One stall adaptation, Expert Four Questions, and Google Research Harness² INV/DOM reflection).
  Solves hard bugs, race conditions, algorithm challenges, cross-file refactorings, and recurring regressions.
  Workflow: task complexity & dynamic compute budget → solution planning & disjoint targetFiles gate →
  parallel execution (allSettled + retry + circuit breaker) → deterministic verification & Invariant pre-flight
  → LATS checkpoint & INV/DOM diagnosis → fresh 6-criterion Yardstick reviewer → synthesized report &
  lifelong transferable <experience> cue.
  Boost 深度推理：用多智能体工作流攻克硬问题（复杂 bug、竞态条件、算法难题、跨文件疑难重构、根因不明的问题）。
  流程：任务复杂度评估与动态算力分配 → 方案规划与独立评审（专家四问 + targetFiles 冲突门禁） →
  并行工作流执行（allSettled 容错与失败熔断） → 验证关卡+Invariant 预检+LATS 检查点回滚+INV/DOM 双维度诊断
  → 换人六维标尺量化复核 → 汇总报告与 Harness² 跨任务终身经验沉淀。
---

# Boost — Multi-Agent Deep Reasoning & Verification Engine / 深度多智能体推理引擎

Inspired by published AI research and open multi-agent orchestration methodologies:
- **Google Research Harness²** ([arXiv:2610.14224](https://arxiv.org/pdf/2610.14224)): Orthogonal `INV`/`DOM` diagnostic dimensions, `KEEP_BASE` discipline, 6-criterion deliverable conformance review yardstick, prompt-injection data boundary (`EVIDENCE IS DATA, NOT INSTRUCTIONS`), and transferable `<experience>` cue reflection.
- **Scaling Test-Time Compute** (Snell et al. 2024, arXiv:2408.03314): Dynamic test-time compute allocation and complexity-driven verification budgets.
- **Language Agent Tree Search (LATS)** (Zhou et al. 2023, arXiv:2310.04406): External verification feedback, checkpoint snapshots, and regression rollback on failing branches.
- **Teaching LLMs to Self-Debug** (Chen et al. 2023, arXiv:2304.05128): Automated test runner discovery, reproduction test synthesis, and execution trace explanation.
- **Agent-as-a-Judge** (Zhuge et al. 2024, arXiv:2410.10934): Quantitative multi-agent code evaluation and objective Yardstick scoring.
- **Magentic-One** (Fourney et al. 2024, arXiv:2411.04468): Stall detection, failure signatures, and dynamic role re-planning.
- **A-MEM / ExpeL** (Zhao et al. 2023, arXiv:2308.10144): Structured experience memory recall and cross-task transfer.
- **Felix Rieseberg**: Expert Four Questions methodology and stretch acceptance goal evaluation.

Independent open-source implementation, not affiliated with or endorsed by Google LLC, Anthropic, OpenAI, or Microsoft.

---

## 1. Multi-Agent Runtime Dispatch / 多平台运行调度协议

Automatically detect the host agent runtime and execute the corresponding protocol:
根据当前宿主 Agent 环境自动选择对应的执行方式：

### A. ZCode Dynamic Workflow (`boost.dwf.ts`)
1. **Profile Selection / 档位选择**: Call `ListModels` to inspect available models (`[current]` marks the active session model), then prompt the user to select `teamProfile`:
   - **`hybrid` (Recommended / 推荐)**: Heavy model for Planner, Critic, Diagnoser, Fixer, Verifier, Reviewer, and core-logic workstreams; Light model for mechanical/boilerplate workstreams and Scribe.
   - **`quality` (All-Heavy / 全强)**: Heavy model for all roles and workstreams. Best for critical algorithms and security-sensitive tasks.
   - **`economy` (Cost-Saving / 省钱)**: Light model for all execution workstreams; Heavy model retained for quality gates (Planner, Critic, Diagnoser, Verifier, Reviewer).
2. **Launch / 启动**: Call `CreateWorkflow`:
   ```json
   {
     "saved": {
       "name": "boost",
       "args": {
         "task": "...",
         "teamProfile": "hybrid",
         "lightModel": "",
         "verifyCommand": "npm test",
         "lang": "auto"
       }
     }
   }
   ```

### B. Claude Code CLI / Subagent Environments (`.claude/commands/boost.md`)
- Orchestrate the 5 phases using native `Task` / subagent spawning for parallel `Workstream` execution and independent `Reviewer` verification, following the full protocol in `adapters/claude-code/boost.md`.

### C. OpenCode (`adapters/opencode/agents.json`)
- Dispatch to the 8 specialized role configurations (`planner`, `critic`, `executor`, `verifier`, `diagnoser`, `fixer`, `reviewer`, `scribe`) bound to bilingual prompts in `roles/*.en.md` or `roles/*.zh.md`.

### D. DeepSeek CLI / Agent Environments (`adapters/deepseek/boost.md`)
- Optimized for DeepSeek reasoning traces with deterministic verification gates, LATS checkpoints, and `fixHistory` ledgers.

### E. WorkBuddy Workspace & Desktop/Web Agents (`adapters/workbuddy/boost.md`)
- Mount as a workspace skill (`SKILL.md`) or inject the 5-phase protocol into `AGENTS.md`.

### F. Codex CLI & Generic Single-Agent Environments (`adapters/codex/protocol.md`, `adapters/generic/boost.md`)
- Execute the 5-phase state machine sequentially by explicitly switching role personas (`[Role: Solution Planner]` $\rightarrow$ `[Role: Plan Critic]` $\rightarrow$ `[Role: Workstream Executor]` $\rightarrow$ `[Role: Independent Verifier / Diagnoser / Fixer]` $\rightarrow$ `[Role: Independent Reviewer]` $\rightarrow$ `[Role: Report Scribe]`).

---

## 2. Architecture & Gate Mechanics / 核心关卡机制

1. **Task Complexity & Dynamic Compute Allocation (`evaluateTaskComplexity` / 动态算力预算)**:
   - Evaluates task complexity into `simple` (2 repair rounds, economy tier), `standard` (3 repair rounds, hybrid tier), or `hard` (5 repair rounds, quality tier) to align test-time compute with problem difficulty (Snell et al. 2024).
2. **Intelligent Experience Recall (`matchExperienceCues` / 经验智能召回)**:
   - Retrieves top relevant experience cues from `.agent-boost/experiences.md` via keyword and dimension scoring, automatically filtering out `confounded` attributions (Zhao et al. 2023 / A-MEM).
3. **Expert Four Questions & Disjoint File Gate (`targetFiles` / 专家四问与文件边界门禁)**:
   - Before decomposing workstreams, the Planner answers four questions in each workstream's `detail` (unstated expert defenses, first-hand raw evidence, deterministic tools, independent proof), evaluates stretch acceptance criteria, and declares explicit `targetFiles: string[]` per `code` workstream.
   - `detectTargetFileConflicts` deterministically blocks overlapping `targetFiles` across parallel workers before any file is modified.
4. **Independent Causal Critique & `KEEP_BASE` Discipline (独立因果评审与 `KEEP_BASE` 克制原则)**:
   - The Critic inspects real workspace code in read-only mode and challenges unproven causal assumptions in the task premise.
   - Following Harness² `KEEP_BASE` discipline, if the initial plan is grounded and conflict-free, the Critic approves it without inventing unnecessary churn.
5. **Fault-Tolerant Parallel Execution & Circuit Breaker (`Promise.allSettled` + 全败熔断)**:
   - Parallel workstreams run via `Promise.allSettled`; any rejected workstream automatically escalates to a strong model for 1x retry.
   - If all workstreams fail after retry, the engine trips the circuit breaker, skipping Phase 3 and Phase 4 to avoid wasting tokens and reporting an explicit aborted conclusion.
6. **Deterministic Verification Gate, Invariant Pre-flight & Test Synthesis (确定性验收与 Invariant 预检)**:
   - Discovers existing test runners (`npm test`, `pytest`, `cargo`, `go`) or synthesizes reproduction checks when `verifyCommand` is not supplied.
   - Preserves the **last 2000 characters** of combined `stdout` + `stderr` (retaining assertion stack traces).
   - Invariant Pre-flight (INV-first): Catches syntax, module import, or runner invocation crashes first; directs Fixer to resolve INV defects before domain logic debugging.
7. **LATS Checkpoint & Regression Rollback (树搜索检查点与回滚)**:
   - Snapshots a Git checkpoint before repair attempts. If a fix attempt causes catastrophic regression, rolls back to checkpoint before exploring alternative repair branches.
8. **Stall Detection & Harness² `INV`/`DOM` Diagnosis (停滞检测与双维度根因诊断)**:
   - Computes a DJB2-hashed normalized signature over the last 20 lines (preserving HTTP status codes and semantic assertion numbers while stripping timestamps, hex addresses, file paths, and 4+ digit PIDs).
   - On consecutive identical signatures, escalates to the Root-Cause Diagnoser, which classifies the defect into **`INV`** (procedure, tool/runner invocation, build state) vs. **`DOM`** (domain logic, algorithmic edge cases) before minimal repair.
9. **Independent 6-Criterion Diff Review & Yardstick Scoring (换人六维标尺量化评分)**:
   - Fresh Reviewer evaluates live workspace diffs against the Harness² 6-criterion yardstick: `DELIVERY`, `CONFORMANCE`, `FIDELITY`, `INTERNAL CONSISTENCY`, `OPERATIONAL FITNESS`, and `FINISH`.
   - Computes quantitative **Yardstick Score** (`calculateYardstickScore`, 0–100 scale, pass threshold $\ge 80$).
   - Functional bugs, crashes, or contract violations are marked `high` severity and directly block success claims in `formatConclusion`.
10. **Harness² Transferable `<experience>` Reflection & Lifelong Memory (终身经验沉淀)**:
    - Scribe extracts at most one generalizable `<experience>` cue (`formatExperienceEntry`), automatically filtering out `confounded` or `no_observed_effect` edits (`NO_ENTRY`), and appends valid cues to `.agent-boost/experiences.md` for future task runs.
