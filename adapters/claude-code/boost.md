# Claude Code /boost Custom Command & Subagent Setup

## Overview
Configure `/boost` in Claude Code as a multi-stage reasoning and verification workflow.

## Custom Command Definition (`.claude/commands/boost.md`)

```markdown
Run deep multi-agent reasoning on task: $ARGUMENTS

Stages:
1. Planner: Inspect files and decompose task into independent workstreams using the Expert Four Questions.
2. Critic: Review plan, identify risks, and check unverified causal premises.
3. Executors: Implement changes per workstream.
4. Verifier: Execute test commands (preserving output tail) and run up to 3 repair rounds.
5. Reviewer: Inspect git diffs for regressions and high-severity defects.
6. Scribe: Generate final summary markdown.
```
