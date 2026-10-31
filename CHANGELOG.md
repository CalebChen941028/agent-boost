# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Fixed
- **Codex adapter filename collision (`install.sh`)**
  - The `codex` target now installs its protocol to `~/.codex/workflows/boost.protocol.md` instead of the shared `protocol.md`, so multiple skill packs (for example `agent-teamwork` and `agent-boost`) can be installed side by side without silently overwriting each other.
  - If a legacy `~/.codex/workflows/protocol.md` is byte-identical to this adapter, the installer removes it after writing `boost.protocol.md`, keeping content loss at zero.
  - Added regression coverage for the scoped filename, the legacy migration, and manifest entries.

## [0.6.1] - 2026-10-29

### Added
- **Surgical Block Edit Protocol & Pre-Flight Syntax Verification (`scripts/run-live-benchmarks.mjs`, `protocol/boost.md`, `skills/boost/SKILL.md`, `roles/executor.*.md`)**:
  - Exported `normalizeForMatching`, `extractSurgicalBlocks`, `applySurgicalFileWrites`, and `verifyWorkspaceSyntax` in `scripts/run-live-benchmarks.mjs`.
  - Enabled `<replace path="..."><target>...</target><replacement>...</replacement></replace>` surgical edits with 3-tier matching (exact match, CRLF-to-LF + per-line `trimEnd`, and outer trim) and path-traversal guards.
  - Enforced pre-flight syntax checks (`node --check`, `sh -n`, `JSON.parse`) after Phase 2 workstream execution and Phase 3 repair steps to catch truncation before running test suites.
- **Budget-Aware Action Urgency (`protocol/boost.md`, `roles/*.md`, `adapters/*`)**:
  - Added strict turn-budget limits prohibiting open-ended exploration loops during execution and repair.
- **Full Multi-Platform Installer & Uninstaller Symmetry (`install.sh`, `uninstall.sh`)**:
  - Upgraded `uninstall.sh` with `--target all` (iterating across `zcode`, `claude`, `codex`, `opencode`, `deepseek`, `workbuddy`, `antigravity`, `agents`, `cursor`, `windsurf`, `generic`) and target aliases (`claude-code` -> `claude`, `gemini` -> `antigravity`, `dsh` -> `deepseek`).

### Fixed
- **Phase 5 `yardstickScore` Block-Scope Bug (`adapters/zcode/boost.dwf.ts`)**:
  - Hoisted `let yardstickScore: YardstickScoreResult | undefined` above the `if (allWorkstreamsFailed)` branch in `boost.dwf.ts`, eliminating a runtime `ReferenceError` in Phase 5 when building the Scribe prompt and return payload.
- **Quantitative Yardstick `< 85` Gate Enforcement (`shared/verify-gate.ts`, `shared/verify-gate.js`, `adapters/zcode/boost.dwf.ts`)**:
  - Updated `formatConclusion` across all 3 SSOT files so a Yardstick score below `85` (even with zero `high`-severity findings, e.g., five `medium` findings yielding `81/100`) sets `hasBlockingIssues: true` and reports the threshold failure in `conclusion`.
- **Deterministic Post-Revision `targetFiles` Deduplication (`adapters/zcode/boost.dwf.ts`)**:
  - Added a deterministic deduplication pass after Phase 1 plan revision so no two parallel `code` workstreams ever retain overlapping `targetFiles` ownership.
- **Synthesized Script Validation & LATS Rollback Protection (`adapters/zcode/boost.dwf.ts`)**:
  - Validated synthesized `verify_synth.sh` scripts with `sh -n verify_synth.sh` before execution, and excluded `verify_synth.sh` during LATS checkpoint rollback (`git clean -fd -e verify_synth.sh`).
- **Shell-Safe Experience Persistence (`adapters/zcode/boost.dwf.ts`)**:
  - Replaced double-quoted `printf` experience persistence with a single-quoted heredoc (`cat << 'EOF_BOOST_EXP' >> .agent-boost/experiences.md`) to prevent shell expansion of backticks or `$` in `<experience>` entries.
- **TypeScript Definition & Documentation Alignment (`shared/verify-gate.d.ts`, `README*.md`, `roles/planner.*.md`)**:
  - Added `criterion?: string` to `FindingLike` in `shared/verify-gate.d.ts` and aligned `simple` tier repair budget documentation (`2` repair rounds) across all adapters and role prompts.

## [0.6.0] - 2026-10-25

### Added
- **Unified Standalone CLI & npm Distribution (`bin/agent-boost.mjs`, `npx agent-boost`)**:
  - Direct executable entrypoint exposing `install`, `uninstall`, `selftest`, `benchmark`, and `report` subcommands.
  - Zero-clone developer experience: enables executing `npx agent-boost install --target zcode` or running 60 offline checks directly from any terminal.
  - Configured `"bin": { "agent-boost", "boost" }` and explicit `"files"` manifest in `package.json`, verified via `npm pack --dry-run` with a compact 161.3 kB production footprint.
  - Dedicated CLI unit test suite (`tests/cli.test.mjs`, 5 tests), expanding test coverage to 46 unit tests.
- **18-Task Cross-Model Grand Slam Evaluation (`mimo-v2.6-flash` vs `deepseek-v4.1-flash`)**:
  - Completed 235 live HTTP calls across two top reasoning model families with zero network/protocol failures.
  - **Empirical Invariant Proof**: Verified 100% interception of multi-agent parallel write collisions in `LIVE-EXPRESS-RACE` across both models (where Solo deterministically failed all 3 retry rounds).
  - **Live LATS Hard Rollback Verification**: Observed and recorded automated `git reset --hard` rollback and pristine-checkpoint recovery in live traffic (`LIVE-REDUX-STRUCTURAL-SHARING` on `mimo-v2.6-flash`, git reflog evidence `6af795d HEAD@{0}: reset`) after a baseline regression, recovering to a 100/100 score in Round 1.
  - **Interactive Cross-Model Comparison Report**: Generated `live-results/cross-model-18tasks-grand-slam.html` and updated preview selector in `adapters/zcode/report-preview.html`.
- **Dynamic Single-Source-of-Truth Version Resolution**:
  - Dynamically extracts package version from `package.json` across CLI runners and benchmark report generators, preventing version drift.
- **CI/CD Packaging Integrity Gate**:
  - Integrated `npm pack --dry-run` into `.github/workflows/ci.yml` across Node.js 18, 20, and 22 matrices.

## [0.5.0] - 2026-10-25

### Added
- **Expanded 18-Task Frontier Live API Suite & 60-Check Offline Harness (`scripts/run-live-benchmarks.mjs`, `npm run benchmark:selftest`)**:
  - **Ceiling-Break Archetypes (Tasks 13–15)**: Added `LIVE-BLIND-FAULT-LOCALIZATION` (multi-module microservice pipeline blind fault localization across candidate files), `LIVE-HARNESS-INV-DUAL-PACKAGE` (dual ESM/CJS subpath package export packaging failure resolution), and `LIVE-LONG-HORIZON-RESOURCE-LEAK` (debounce timer and event listener leak under 50-connection soak testing).
  - **High-Intensity Production & Concurrency Suite (Tasks 16–18)**: Ported real-world SWE-bench Pro V2 NodeBB issue (`LIVE-SWE-BENCH-PRO-NODEBB` - 4-dimensional sorting and invariant set intersection), adversarial downstream serializer crash decoy (`LIVE-RED-HERRING-CIRCULAR-DECOY` - strict DTO contract invariants vs upstream circular context leak), and distributed microservices dual-agent contract race (`LIVE-DISTRIBUTED-CONTRACT-RACE` - concurrent gateway and billing protocol v2 synchronization).
  - **60 Automated Offline Checks**: Expanded zero-API-spend offline selftest from 42 to 60 checks, ensuring 100% deterministic regression protection across all 18 tasks and git rollback machinery.
- **Empirical Multi-Agent Concurrency Decoupling**:
  - Live empirical evaluation on `LIVE-DISTRIBUTED-CONTRACT-RACE` demonstrated that agent-boost's Phase 1 planning-time single-ownership decoupling delivers a 1-shot pass (100/100 score, 0 conflicts, 0 repair rounds) consuming **only 35.1% of tokens (5,563 vs 15,836)** and completing in **19.5s (over 2x faster than Solo's 41.8s)**, while uncoordinated subagents suffered destructive write-clobbering on shared contract files and required expensive retry recovery.
- **Preview Dashboard Integration (`adapters/zcode/report-preview.html`)**:
  - Added Tasks 16–18 High-Intensity Benchmark Report selector, aligned with default runner output paths for direct zero-copy verification.

### Fixed
- **Distributed Contract Signature Scoping**: Explicitly specified exact interface signatures (`routeBillingRequest`, `settleTransaction`) and literal return properties (`cents`, `idempotencyKey`) in T18 brief and subagent scopes, isolating multi-agent concurrency coordination from blind identifier guessing.
- **Report Preview Selector URL Alignment**: Synchronized report preview drop-down options with default benchmark runner HTML output paths.

## [0.4.1] - 2026-10-25

### Added
- **Expanded 12-Task Live API Suite & 42-Check Offline Harness (`scripts/run-live-benchmarks.mjs`, `npm run benchmark:selftest`)**: Added Task 11 (`LIVE-CASCADE-EVENT-BUS` - Multi-Module EventBus Async Migration with Synchronous Cascade Invariant) and Task 12 (`LIVE-SQLITE-SCHEMA-MIGRATION` - Selective Soft-Delete Migration with Whitelist Constraints). Expanded zero-spend offline selftest from 36 to 42 automated checks.
- **Adaptive CoT Token Budgeting (`TIER_TOKEN_BUDGETS`)**: Introduced dynamic test-time compute token budgeting mapping task complexity tiers (`simple`: 2048, `standard`: 4096, `hard`: 6144) to Phase 2 execution and Phase 3 repair calls. Prevents runaway reasoning loops on deep-thinking models, reducing total token consumption below bare models (0.989x on `deepseek-v4.1-flash`) and cutting average call latency by 52% (16.5s → 8.5s).
- **SVG Execution Timeline Profiles (`renderExecutionTimelineSvg`)**: Apple-style SVG Gantt/timeline bars embedded in HTML report detail rows, visualizing wall-clock execution duration, attempts, and API call latency proportions.
- **Cross-Model Live API Benchmark & Comparison (`npm run benchmark:compare`, `generateMultiModelReport`)**: Added `--model <name>` CLI support for dynamic benchmark execution, and automated side-by-side cross-model reporting comparing `mimo-v2.6-flash` and `deepseek-v4.1-flash`.
- **Interactive Report Preview Switcher (`adapters/zcode/report-preview.html`)**: Added a drop-down selector in the ZCode preview panel to switch between default latest run, cross-model comparison, deepseek 12-task report, and tier-budget reports.

### Fixed
- **Cross-Model Absent Task Representation**: Tasks run in only one model arm now display neutral `NOT-RUN` status and badges in cross-model HTML and Markdown reports instead of false failures or erroneous victory badges.
- **Report Generator Default Run Resolution**: Automatically selects the newest live-run JSON by mtime, preventing stale reports from being regenerated on bare `npm run benchmark:report`.
- **Token Budget Transparency**: Recorded applied per-task `tokenBudget` in live-run results JSON for transparent auditing.

## [0.4.0] - 2026-10-24

### Added
- **Expanded 10-Task Live API Benchmark Suite (`scripts/run-live-benchmarks.mjs`, `npm run benchmark`)**: Expanded live benchmark tasks from 5 to 10 canonical engineering challenges (adding unified diff line drift patch application, async worker pool fail-fast concurrency, immutable Redux state structural sharing, DAG topological cycle diagnosis, and single-flight cache stampede mutex). Harness includes 36 automated offline verification checks (`npm run benchmark:selftest`) with zero API spend.
- **Interactive Visual HTML Dashboard & Report Generator (`scripts/generate-benchmark-report.mjs`, `npm run benchmark:report`)**: Added an Apple-inspired, responsive, standalone HTML report generator. Renders pass@1 comparison cards, metered token efficiency ratios, 6-criterion yardstick radar comparisons, interactive task-by-task accordion ledger, and protocol integrity badges. Integrates with ZCode and OpenCode IDE panels via `adapters/zcode/report-preview.html`.
- **Live API End-to-End Benchmark Suite (`scripts/run-live-benchmarks.mjs`, `npm run benchmark`)**: Real dual-track duels against the OpenCode Zen gateway (`https://opencode.ai/zen/go/v1/chat/completions`, model `mimo-v2.6-flash`, temperature 0.2) — zero third-party dependencies, native `fetch` with whole-request deadlines and retry/backoff. Ten executable fixture tasks run in isolated temp Git workspaces with real `node --test` ground truth. Fairness protocol: identical briefs, immutable test suites (ownership gate strips test-file declarations; suite restored and stray test files purged before every run), pristine-baseline regression definition driving real LATS `git reset --hard` checkpoints, KEEP_BASE execution discipline, syntax-validated `verify_synth.sh` synthesis (`node --check` + doubled-budget re-synthesis), identical agent-as-a-judge scoring for both arms, and cross-task experience recall/persistence (`matchExperienceCues` + `formatExperienceEntry`).
- **Dynamic Test-Time Compute Allocation (`evaluateTaskComplexity`)**: Inspired by Snell et al. (2024, arXiv:2408.03314), dynamically scales test-time compute allocation across task tiers (`simple`, `standard`, `hard`), adjusting workstream parallelism (1–5), repair iteration limits (1–5), and verification depth (`shallow`, `standard`, `deep`).
- **LATS Regression Rollback & Git Checkpoint Snapshots**: Inspired by Language Agent Tree Search (Zhou et al. 2023, arXiv:2310.04406), automatically takes git snapshots before each repair round and rolls back (`git reset --hard`) when repair candidates introduce test regressions or escalate error signatures.
- **Automated Test Discovery & Reproduction Test Synthesis (Self-Debugging)**: Inspired by Self-Debugging (Chen et al. 2023, arXiv:2304.05128), probes existing test runners and synthesizes deterministic reproduction tests (e.g., `verify_synth.sh`) when test coverage is absent.
- **Agent-as-a-Judge Quantitative Yardstick Scoring (`calculateYardstickScore`)**: Inspired by Zhuge et al. (2024, arXiv:2410.10934), introduces weighted 6-criterion quantitative scoring (DELIVERY: 25, CONFORMANCE: 20, FIDELITY: 15, INTERNAL_CONSISTENCY: 15, OPERATIONAL_FITNESS: 15, FINISH: 10) with an 85-point passing gate and zero-high-severity defect requirement.
- **ExpeL Intelligent Experience Cue Recall (`matchExperienceCues`)**: Inspired by ExpeL (Zhao et al. 2023, arXiv:2308.10144), enables keyword- and tag-driven retrieval of historical `<experience>` cues from `.agent-boost/experiences.md` to guide task planning and avoid historical traps.
- **Invariant Pre-Flight (INV-First) Priority**: Root Cause Diagnosers enforce procedural and runtime environment verification (`isInvariantFailure`) before analyzing domain application code.
- **SSOT Pure Functions Parity (10/10 functions)**: Expanded Single-Source-of-Truth from 7 to 10 pure functions (`matchExperienceCues`, `evaluateTaskComplexity`, `calculateYardstickScore`) with 100% parameter and body parity across TypeScript, JavaScript, and ZCode workflows.

### Fixed
- **Signature Timing Normalization & Conflict URI Handling**: Hardened `computeFailureSignature` to normalize durations with whitespace (e.g. `142.5 ms` vs `34.2ms`), preventing false signature divergence during stall detection; upgraded `detectTargetFileConflicts` to normalize `file://` URIs and leading slashes; enhanced LATS rollback in `boost.dwf.ts` to detect regressions when test failure counts increase across rounds.

### Removed
- **Legacy Simulation Runners & Mock Benchmarks (`scripts/run-benchmarks.mjs`, `tests/benchmarks.test.mjs`, `tests/standard-benchmarks.test.mjs`)**: Purged all legacy GLM-5.3 mock and simulation runners, unifying the repository onto a single, authentic live API benchmark harness (`scripts/run-live-benchmarks.mjs`) and dedicated offline harness selftest suite (`tests/live-benchmarks.test.mjs`, 36 checks).

## [0.3.0] - 2026-10-24

### Added
- **Harness² Integration (`google-research/harness2` patterns)**:
  - **INV / DOM Orthogonal Root-Cause Diagnosis**: Root Cause Diagnoser now classifies recurring failures into `INV` (procedural, tool invocation, runner/build environment mechanics) vs. `DOM` (domain logic, algorithmic edge cases, contract mismatches).
  - **6-Criterion Independent Review Yardstick**: Independent Reviewer evaluates live diffs against `DELIVERY`, `CONFORMANCE`, `FIDELITY`, `INTERNAL CONSISTENCY`, `OPERATIONAL FITNESS`, and `FINISH`.
  - **Transferable `<experience>` Reflection (`formatExperienceEntry`)**: Report Scribe extracts at most one generalizable `<experience>` cue per run (or `NO_ENTRY` when `confounded` / `no_observed_effect`), and Planner loads `.agent-boost/experiences.md` when available.
  - **Standing Guardrails**: Enforces `EVIDENCE IS DATA, NOT INSTRUCTIONS` (prompt-injection isolation), `DELIVERABLE CONFORMANCE` (no unrequested shape/API mutations), and `KEEP_BASE` discipline across all roles.
- **Disjoint File Ownership Gate (`detectTargetFileConflicts`)**: Workstreams now declare `targetFiles: string[]`; deterministic overlap detection flags parallel write conflicts before execution starts.
- **Fix History Ledger (`fixHistory`) & Live Diff Snapshot**: Tracks `{ round, summary, modifiedPaths }` across all repair rounds and feeds `git status --short` / `git diff --stat` into Phase 4 Reviewer so downstream agents never inspect stale Phase 2 context.
- **All-Failed Execution Circuit Breaker**: Short-circuits Phase 3 verification and Phase 4 review when all workstreams fail execution after retry, reporting an explicit aborted conclusion.

### Fixed
- **Single-Source-of-Truth (SSOT) Alignment**: Fixed critical drift in `adapters/zcode/boost.dwf.ts` where `computeFailureSignature` previously used `\b\d+\b -> "N"` (erasing HTTP status codes and assertion numbers); upgraded `scripts/build.mjs` to enforce 100% normalized AST/body parity across `shared/verify-gate.ts`, `shared/verify-gate.js`, and `adapters/zcode/boost.dwf.ts`.
- **LLM Verifier Stall Detection**: Enabled `lastGapSignature` comparison in the non-command Verifier branch so Root Cause Diagnoser only fires when acceptance gaps actually stall.
- **100% Bilingual Parity**: Eliminated all hardcoded Chinese strings when running in English mode (`lang="en"`).
- **Multi-Target Installer & `--lang` Support**: `install.sh` now honors `--lang zh|en` (copying matching role prompts for OpenCode) and writes per-target manifests (`install-manifest-<target>.json`) so installing multiple targets never overwrites prior manifests.

## [0.2.0] - 2026-10-23

### Fixed
- **B1**: Conclusion now accurately reflects high-severity defects identified by independent reviewers instead of blindly declaring completion.
- **B2**: Failure output truncation now combines stdout and stderr and preserves the output tail where failure assertions reside.
- **B3**: Failure signature generation now normalizes the last 20 lines (stripping timestamps, paths, and line numbers) to eliminate false-positive stall detections from static test runner headers.
- **B4**: Verifier recheck prompt in subsequent rounds now uses neutral language ("Fixer reports changes made. Independently re-verify.") rather than declaring issues fixed.
- **B5**: Parallel workstream execution now utilizes `Promise.allSettled` with automatic single-retry escalation using strong models on failure.
- **B7**: `teamProfile` is strictly validated against allowed enum values (`hybrid`, `quality`, `economy`), throwing descriptive errors on invalid inputs.

### Added
- Pure TypeScript verification module `shared/verify-gate.ts` with full unit tests.
- Extracted protocol specification `protocol/boost.md` and bilingual role prompts under `roles/`.
- Multi-agent adapter templates for Claude Code, OpenCode, Codex, and Generic workflows.
- Clean configuration architecture separating personal credentials into `models.local.json` and providing `models.example.json`.
- Dual-language README and automated GitHub Actions CI workflow.
