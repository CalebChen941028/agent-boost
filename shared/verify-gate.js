/**
 * Pure functions for Boost verification gates, failure output formatting,
 * stall detection signatures, workstream target-file conflict checking,
 * Harness² experience reflection, and workflow conclusion formatting.
 */

/**
 * Combines stdout and stderr, prioritizing the tail where assertion failures
 * and stack traces reside (B2).
 */
export function formatFailureOutput(
  stdout = "",
  stderr = "",
  maxLength = 2000,
) {
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
 * Strips volatile elements: line numbers, memory addresses, timestamps, file paths,
 * while preserving HTTP status codes and small semantic assertion numbers (<4 digits).
 * Takes the last 20 non-empty lines to ensure static initial runner lines
 * (e.g. "> test", "TAP version 13", "pytest ...") do not cause false positives.
 */
export function computeFailureSignature(output) {
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
      // Standalone numbers >= 4 digits that might be pids, ports, or row counts
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
 * Detects overlapping targetFiles across parallel 'code' workstreams to prevent race overwrites.
 */
export function detectTargetFileConflicts(workstreams = []) {
  const fileOwners = new Map();

  for (const ws of workstreams || []) {
    if (ws.kind && ws.kind !== "code") continue;
    for (const rawFile of ws.targetFiles || []) {
      const normalized = String(rawFile || "")
        .trim()
        .replace(/^\.\//, "")
        .replace(/\\/g, "/");
      if (!normalized) continue;
      const list = fileOwners.get(normalized) || [];
      if (!list.includes(ws.title)) {
        list.push(ws.title);
      }
      fileOwners.set(normalized, list);
    }
  }

  const conflicts = [];
  for (const [file, owners] of fileOwners.entries()) {
    if (owners.length > 1) {
      conflicts.push({ file, workstreams: owners });
    }
  }
  return conflicts;
}

/**
 * Formats conclusion text ensuring review findings severity, verification gaps,
 * and failed workstreams are accurately reflected (B1 + execution failure awareness).
 */
export function formatConclusion(
  task,
  workstreamCount,
  reviewFindings = [],
  gaps = [],
  lang = "zh",
  failedWorkstreamCount = 0,
) {
  const shortTask = Array.from(task || "").slice(0, 60).join("");
  const highSeverityIssues = (reviewFindings || []).filter((f) => f.severity === "high");
  const hasBlockingIssues =
    gaps.length > 0 || highSeverityIssues.length > 0 || failedWorkstreamCount > 0;

  if (lang === "en") {
    if (workstreamCount > 0 && failedWorkstreamCount >= workstreamCount) {
      return {
        conclusion: `Task "${shortTask}" aborted: all ${workstreamCount} workstream(s) failed during execution after retry.`,
        hasBlockingIssues: true,
      };
    }
    if (!hasBlockingIssues) {
      return {
        conclusion: `Task "${shortTask}" completed and verified: ${workstreamCount} workstream(s) implemented, independent review raised ${reviewFindings.length} observation(s).`,
        hasBlockingIssues: false,
      };
    }
    const reasons = [];
    if (failedWorkstreamCount > 0)
      reasons.push(`${failedWorkstreamCount} workstream(s) failed execution`);
    if (gaps.length > 0) reasons.push(`${gaps.length} acceptance gap(s) unresolved`);
    if (highSeverityIssues.length > 0)
      reasons.push(`${highSeverityIssues.length} high-severity review issue(s) identified`);

    return {
      conclusion: `Task "${shortTask}" implemented with open issues (${reasons.join(", ")}): see findings and report for resolution path.`,
      hasBlockingIssues: true,
    };
  }

  // Chinese default
  if (workstreamCount > 0 && failedWorkstreamCount >= workstreamCount) {
    return {
      conclusion: `任务「${shortTask}」执行中止：全部 ${workstreamCount} 条工作流在重试后均执行失败。`,
      hasBlockingIssues: true,
    };
  }
  if (!hasBlockingIssues) {
    return {
      conclusion: `任务「${shortTask}」已完成并通过验证：${workstreamCount} 条工作流落地，独立复核提出 ${reviewFindings.length} 条意见。`,
      hasBlockingIssues: false,
    };
  }

  const reasons = [];
  if (failedWorkstreamCount > 0) reasons.push(`${failedWorkstreamCount} 条工作流执行失败`);
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
export function validateTeamProfile(profile = "hybrid") {
  const p = (profile || "hybrid").toLowerCase().trim();
  if (p === "hybrid" || p === "quality" || p === "economy") {
    return p;
  }
  throw new Error(
    `Invalid teamProfile "${profile}". Expected one of: "hybrid", "quality", "economy".`,
  );
}

/**
 * Resolves model ID and tier from requested name and local models configuration (B11).
 */
export function resolveModelConfiguration(
  requestedName,
  localConfig = null,
) {
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

/**
 * Formats a Harness²-inspired transferable experience cue into a structured block,
 * rejecting low-confidence or confounded attributions so they do not pollute future runs.
 */
export function formatExperienceEntry(entry) {
  if (!entry || !entry.cue || !entry.lesson) {
    return "NO_ENTRY";
  }
  if (entry.verdict === "confounded" || entry.verdict === "no_observed_effect") {
    return "NO_ENTRY";
  }
  const cue = entry.cue.trim();
  const lesson = entry.lesson.trim();
  if (!cue || !lesson || cue === "NO_ENTRY" || lesson === "NO_ENTRY") {
    return "NO_ENTRY";
  }
  return [
    "<experience>",
    `dimension: ${entry.dimension || "INV"}`,
    `cue: ${cue}`,
    `lesson: ${lesson}`,
    `verdict: ${entry.verdict}`,
    `confidence: ${entry.confidence || "medium"}`,
    `evidence: ${(entry.evidence || "").trim()}`,
    "</experience>",
  ].join("\n");
}
