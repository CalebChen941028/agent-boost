/**
 * Pure functions for Boost verification gates, failure output formatting,
 * stall detection signatures, and workflow conclusion formatting.
 */

export interface FindingLike {
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  status: "verified" | "unconfirmed";
}

/**
 * Combines stdout and stderr, prioritizing the tail where assertion failures
 * and stack traces reside (B2).
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
 * Computes a normalized failure signature from test output (B3).
 * Strips volatile elements: line numbers, memory addresses, timestamps, file paths.
 * Takes the last 20 non-empty lines to ensure static initial runner lines
 * (e.g. "> test", "TAP version 13", "pytest ...") do not cause false positives.
 */
export function computeFailureSignature(output: string): string {
  if (!output || typeof output !== "string") {
    return "empty-output";
  }

  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return "empty-output";
  }

  // Focus on the tail where the failure root cause / assertion is located
  const tailLines = lines.slice(-20);

  const normalized = tailLines.map((line) => {
    return line
      // Hex addresses
      .replace(/0x[a-fA-F0-9]+/g, "0xHEX")
      // File paths with line/column (e.g. /path/to/file.js:12:34 or C:\path\file.py(45))
      .replace(/(?:\/[a-zA-Z0-9_.\-]+)+:\d+(?::\d+)?/g, "PATH:LINE")
      .replace(/(?:[a-zA-Z]:\\[a-zA-Z0-9_.\-]+)+\(?\d+\)?/g, "PATH:LINE")
      // Standalone line/col numbers
      .replace(/:\d+:\d+/g, ":LINE:COL")
      // Durations / timings (e.g. 12.34ms, 1.2s)
      .replace(/\b\d+(?:\.\d+)?(?:ms|s|m)\b/g, "DURATION")
      // Generic timestamps (ISO / date-time)
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "TIMESTAMP")
      // Standalone numbers that might be pids or row counts
      .replace(/\b\d{4,}\b/g, "NUM");
  });

  const joined = normalized.join("\n");

  // DJB2 hash implementation
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = (hash * 33) ^ joined.charCodeAt(i);
  }
  const unsignedHash = (hash >>> 0).toString(16);

  // Return readable signature combining key snippet and hash
  const firstDistinct = normalized[0] || "error";
  const prefix = firstDistinct.slice(0, 30).replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `${prefix}-${unsignedHash}`;
}

/**
 * Formats conclusion text ensuring review findings severity is accurately reflected (B1).
 * If there are high-severity defects or unresolved gaps, conclusion must NOT claim success.
 */
export function formatConclusion(
  task: string,
  workstreamCount: number,
  reviewFindings: FindingLike[] = [],
  gaps: string[] = [],
  lang: "zh" | "en" = "zh",
): { conclusion: string; hasBlockingIssues: boolean } {
  const shortTask = Array.from(task || "").slice(0, 60).join("");
  const highSeverityIssues = (reviewFindings || []).filter((f) => f.severity === "high");
  const hasBlockingIssues = gaps.length > 0 || highSeverityIssues.length > 0;

  if (lang === "en") {
    if (!hasBlockingIssues) {
      return {
        conclusion: `Task "${shortTask}" completed and verified: ${workstreamCount} workstream(s) implemented, independent review raised ${reviewFindings.length} observation(s).`,
        hasBlockingIssues: false,
      };
    }
    const reasons: string[] = [];
    if (gaps.length > 0) reasons.push(`${gaps.length} acceptance gap(s) unresolved`);
    if (highSeverityIssues.length > 0)
      reasons.push(`${highSeverityIssues.length} high-severity review issue(s) identified`);

    return {
      conclusion: `Task "${shortTask}" implemented with open issues (${reasons.join(", ")}): see findings and report for resolution path.`,
      hasBlockingIssues: true,
    };
  }

  // Chinese default
  if (!hasBlockingIssues) {
    return {
      conclusion: `任务「${shortTask}」已完成并通过验证：${workstreamCount} 条工作流落地，独立复核提出 ${reviewFindings.length} 条意见。`,
      hasBlockingIssues: false,
    };
  }

  const reasons: string[] = [];
  if (gaps.length > 0) reasons.push(`${gaps.length} 个验收缺口待处理`);
  if (highSeverityIssues.length > 0) reasons.push(`${highSeverityIssues.length} 个高风险复核缺陷待解决`);

  return {
    conclusion: `任务「${shortTask}」已实现但存在未闭环问题（${reasons.join("，")}）：详见报告与 findings。`,
    hasBlockingIssues: true,
  };
}

/**
 * Validates teamProfile enum (B7).
 */
export function validateTeamProfile(profile: string = "hybrid"): "hybrid" | "quality" | "economy" {
  const p = (profile || "hybrid").toLowerCase().trim();
  if (p === "hybrid" || p === "quality" || p === "economy") {
    return p;
  }
  throw new Error(`Invalid teamProfile "${profile}". Expected one of: "hybrid", "quality", "economy".`);
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
