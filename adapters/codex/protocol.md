# Codex Serial Boost Protocol

For single-agent CLI environments such as Codex CLI:
The agent systematically assumes roles in sequence:
1. **[Role: Planner]**: Analyze codebase and output workstreams with Expert Four Questions.
2. **[Role: Critic]**: Self-critique plan for risks and causal assumptions.
3. **[Role: Executor]**: Implement code changes.
4. **[Role: Verifier]**: Run verification command, capturing tail output.
5. **[Role: Reviewer]**: Inspect diffs.
6. **[Role: Scribe]**: Output final report.
