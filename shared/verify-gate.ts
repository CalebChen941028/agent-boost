/**
 * Pure functions for verification gates, failure output formatting,
 * stall detection signatures, teamwork gap calculations, and workflow conclusion formatting.
 * Shared between agent-boost and agent-teamwork.
 */

export interface FindingLike {
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  status: "verified" | "unconfirmed";
}

export interface MilestoneOutcomeLike {
  milestone: string;
  passed: boolean;
  evidence: string;
  gaps: string[];
  reworkRounds: number;
  superseded?: boolean;
}

export interface ChallengeLike {
  foundIssue?: boolean;
  evidence?: string;
}

/**
 * Combines stdout and stderr, prioritizing the tail where assertion failures
 * and stack traces reside (B2, C3).
 */
export function formatFailureOutput(
  stdout: string = "",
  stderr: string = "",
  maxLength: number = 2000,
): string {
  const out = (stdout || "").trim();
  const err = (stderr || "").trim();

  let combined = "";
  if (out && err) {
    combined = `${out}\n--- stderr ---\n${err}`;
  } else {
    combined = out || err;
  }

  if (combined.length <= maxLength) {
    return combined;
  }

  // Preserve the tail rather than the head
  return combined.slice(-maxLength);
}

/**
 * Computes a normalized failure signature from test output (B3, C3).
 * Strips volatile elements: line numbers, memory addresses, timestamps, file paths.
 * Takes the last 20 non-empty lines to ensure static initial runner lines
 * (e.g. "> test", "TAP version 13", "pytest ...") do not cause false positives.
 */
export function computeFailureSignature(output: string): string {
  if (!output || !output.trim()) {
    return "empty-failure";
  }

  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return "empty-failure";
  }

  // Take the last 20 lines
  const tailLines = lines.slice(-20);

  const normalized = tailLines.map((line) => {
    return line
      // Strip ISO timestamps or times (HH:MM:SS)
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/gi, "")
      .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "")
      // Strip hex memory addresses (0x...)
      .replace(/0x[a-f0-9]+/gi, "0xHEX")
      // Strip file line/column numbers (e.g. :42:10 or line 42)
      .replace(/:\d+:\d+/g, ":L:C")
      .replace(/:\d+/g, ":L")
      .replace(/\bline \d+\b/gi, "line N")
      // Strip durations/percentages (e.g. 120ms, 1.4s, 85%)
      .replace(/\b\d+(\.\d+)?(ms|s|m|%)\b/gi, "NUM_UNIT")
      // Strip volatile number constants
      .replace(/\b\d+\b/g, "N")
      // Strip absolute directory paths (/Users/... or /home/...)
      .replace(/(?:\/[\w.-]+){2,}/g, "/PATH")
      .trim();
  });

  return normalized.filter((l) => l.length > 0).join(" | ");
}

/**
 * Computes signature for acceptance gaps across rounds.
 */
export function computeGapSignature(gaps: string[]): string {
  if (!gaps || gaps.length === 0) {
    return "no-gaps";
  }
  return gaps
    .map((g) => {
      const firstLine = g.split("\n").find((l) => l.trim().length > 0) ?? "";
      return firstLine
        .replace(/\d+/g, "N")
        .replace(/(?:\/[\w.-]+){2,}/g, "/PATH")
        .trim();
    })
    .sort()
    .join(" ; ");
}

/**
 * Formats conclusion reflecting both verification gaps AND reviewer findings.
 * Fixes P0 bug B1: if reviewer found high severity defects, conclusion must not claim success.
 */
export function formatConclusion(
  shortTask: string,
  workstreamCount: number,
  gaps: string[],
  findings: FindingLike[],
  lang: "zh" | "en" = "zh",
): string {
  const highFindings = findings.filter((f) => f.severity === "high");
  const hasGaps = gaps.length > 0;
  const hasHighDefects = highFindings.length > 0;

  if (lang === "en") {
    if (hasGaps && hasHighDefects) {
      return `Task "${shortTask}" completed with unresolved gaps: ${gaps.length} verification gap(s) and ${highFindings.length} high-severity defect(s) pending.`;
    }
    if (hasGaps) {
      return `Task "${shortTask}" implemented but verification incomplete: ${gaps.length} gap(s) remaining.`;
    }
    if (hasHighDefects) {
      return `Task "${shortTask}" executed across ${workstreamCount} workstream(s), but independent review identified ${highFindings.length} high-severity defect(s).`;
    }
    return `Task "${shortTask}" successfully completed and verified: ${workstreamCount} workstream(s) landed; review noted ${findings.length} feedback item(s).`;
  }

  // Chinese
  if (hasGaps && hasHighDefects) {
    return `任务「${shortTask}」实施完成但验收与复核未通过：存在 ${gaps.length} 个验证缺口及 ${highFindings.length} 项高危缺陷，详见报告。`;
  }
  if (hasGaps) {
    return `任务「${shortTask}」已实现但验收未全过：${gaps.length} 个缺口待处理，详见报告与 findings。`;
  }
  if (hasHighDefects) {
    return `任务「${shortTask}」各工作流已落地，但独立复核发现 ${highFindings.length} 项高危缺陷未解决，不能视为已完成。`;
  }
  return `任务「${shortTask}」已完成并通过验证：${workstreamCount} 条工作流落地，独立复核提出 ${findings.length} 条意见。`;
}

/**
 * Validates teamProfile enum value (B7, C7).
 */
export function validateTeamProfile(profile: string): "hybrid" | "quality" | "economy" {
  const p = (profile || "").trim().toLowerCase();
  if (p === "hybrid" || p === "quality" || p === "economy") {
    return p;
  }
  throw new Error(
    `Invalid teamProfile "${profile}". Expected one of: "hybrid", "quality", "economy".`,
  );
}

/**
 * Validates integrityMode enum value (C7).
 */
export function validateIntegrityMode(mode: string): "development" | "demo" | "benchmark" {
  const m = (mode || "").trim().toLowerCase();
  if (m === "development" || m === "demo" || m === "benchmark") {
    return m;
  }
  throw new Error(
    `Invalid integrityMode "${mode}". Expected one of: "development", "demo", "benchmark".`,
  );
}

/**
 * Evaluates whether an adversarial challenger report identifies a substantive issue (C4).
 * Distinguishes genuine evidence from statements indicating "no issues found".
 */
export function isSubstantiveChallenge(challenge: ChallengeLike | null | undefined): boolean {
  return Boolean(
    challenge &&
    challenge.foundIssue === true &&
    typeof challenge.evidence === "string" &&
    challenge.evidence.trim().length > 0,
  );
}

/**
 * Computes open gaps for Teamwork initiatives (C1, C2).
 * Excludes superseded milestones that were replaced by replanning.
 * Counts failed verifyCommand accurately.
 */
export function calculateTeamworkOpenGaps(
  milestoneOutcomes: MilestoneOutcomeLike[],
  auditPassed: boolean,
  verifyCommandRan: boolean,
  verifyPassed: boolean,
): number {
  const failedActiveMilestones = (milestoneOutcomes || []).filter(
    (o) => !o.passed && !o.superseded,
  ).length;

  return (
    failedActiveMilestones +
    (auditPassed ? 0 : 1) +
    (verifyCommandRan && !verifyPassed ? 1 : 0)
  );
}

/**
 * Formats teamwork conclusion text (C1, C2).
 * Strictly prevents claiming "终局验收命令通过" when verifyPassed is false.
 */
export function formatTeamworkConclusion(
  openGaps: number,
  verifyCommandRan: boolean,
  verifyPassed: boolean,
  replansUsed: number = 0,
  lang: "zh" | "en" = "zh",
): string {
  if (lang === "en") {
    if (openGaps === 0) {
      const verifyText = verifyCommandRan && verifyPassed ? ", final verification command passed" : "";
      return `Initiative completed: all milestones passed acceptance${replansUsed > 0 ? ` (with ${replansUsed} replan)` : ""}${verifyText}, audit passed.`;
    }
    const verifyFailText = verifyCommandRan && !verifyPassed ? ", final verification command failed" : "";
    return `Initiative partially completed with ${openGaps} open gap(s)${verifyFailText}${replansUsed > 0 ? ` (${replansUsed} replans used)` : ""}. See findings and report.`;
  }

  // Chinese
  if (openGaps === 0) {
    const verifyText = verifyCommandRan && verifyPassed ? "，终局验收命令通过" : "";
    return `任务已完成：所有里程碑全部通过验收${replansUsed > 0 ? `（期间整体重规划 ${replansUsed} 次）` : ""}${verifyText}，总审计结论通过。`;
  }
  const verifyFailText = verifyCommandRan && !verifyPassed ? "，终局验收命令未通过" : "";
  return `任务主体完成，但有 ${openGaps} 处验收缺口待处理${verifyFailText}${replansUsed > 0 ? `（已用尽 ${replansUsed} 次整体重规划仍遗留）` : ""}（详见 findings 与报告）。`;
}

/**
 * Resolves model ID and tier from requested name and local models configuration (B11).
 */
export function resolveModelConfiguration(
  requestedName: string,
  localConfig: any = null,
): { modelId: string | null; tier: "light" | "heavy" | "default" } {
  const req = (requestedName || "").trim();
  if (req) {
    if (localConfig && localConfig.models && localConfig.models[req]) {
      const m = localConfig.models[req];
      return { modelId: m.id || req, tier: m.tier || "light" };
    }
    return { modelId: req, tier: "light" };
  }

  if (localConfig && localConfig.default_light_model) {
    const def = localConfig.default_light_model;
    const m = localConfig.models && localConfig.models[def];
    return { modelId: (m && m.id) || def, tier: "light" };
  }

  return { modelId: null, tier: "default" };
}
