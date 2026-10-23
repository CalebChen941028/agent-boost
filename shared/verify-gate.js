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
  if (typeof maxLength !== "number" || isNaN(maxLength) || maxLength <= 0) {
    return "";
  }

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
      // Posix file paths with line/column (e.g. /path/to/file.js:12:34)
      .replace(/(?:\/[a-zA-Z0-9_.\-]+)+:\d+(?::\d+)?/g, "PATH:LINE")
      // Windows paths (both backslash and forward slash) with subdirectories and line/col (e.g. C:\path\to\file.py(45) or D:/dir/app.js:10:5)
      .replace(/[a-zA-Z]:[\\/][a-zA-Z0-9_.\-\\/]+(?::\d+(?::\d+)?|\(\d+\))/g, "PATH:LINE")
      // Standard Python tracebacks
      .replace(/, line \d+/g, ", line LINE")
      // Go and relative file line numbers
      .replace(/([a-zA-Z0-9_.\-]+\.(?:[a-zA-Z0-9]+)):\d+(?::\d+)?/g, "PATH:LINE")
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
  const cleanPrefix = firstDistinct
    .slice(0, 30)
    .replace(/[^\p{L}\p{N}_\-]/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefix = cleanPrefix || "error";
  return `${prefix}-${unsignedHash}`;
}

/**
 * Detects overlapping targetFiles across parallel 'code' workstreams to prevent race overwrites.
 */
export function detectTargetFileConflicts(workstreams = []) {
  const fileOwners = new Map();
  const canonicalFiles = new Map();

  for (const ws of workstreams || []) {
    if (ws.kind && ws.kind !== "code") continue;
    for (const rawFile of ws.targetFiles || []) {
      const normalized = String(rawFile || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^(\.\/)+/, "")
        .replace(/\/+/g, "/")
        .replace(/\/+$/, "")
        .trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (!canonicalFiles.has(key)) {
        canonicalFiles.set(key, normalized);
      }
      const list = fileOwners.get(key) || [];
      if (!list.includes(ws.title)) {
        list.push(ws.title);
      }
      fileOwners.set(key, list);
    }
  }

  const conflicts = [];
  for (const [key, owners] of fileOwners.entries()) {
    if (owners.length > 1) {
      conflicts.push({ file: canonicalFiles.get(key) || key, workstreams: owners });
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
  const safeFindings = Array.isArray(reviewFindings) ? reviewFindings : [];
  const safeGaps = Array.isArray(gaps) ? gaps : [];
  const highSeverityIssues = safeFindings.filter(
    (f) => f && String(f.severity || "").trim().toLowerCase() === "high",
  );
  const hasBlockingIssues =
    safeGaps.length > 0 || highSeverityIssues.length > 0 || failedWorkstreamCount > 0;

  if (lang === "en") {
    if (workstreamCount > 0 && failedWorkstreamCount >= workstreamCount) {
      return {
        conclusion: `Task "${shortTask}" aborted: all ${workstreamCount} workstream(s) failed during execution after retry.`,
        hasBlockingIssues: true,
      };
    }
    if (!hasBlockingIssues) {
      const wsPhrase =
        workstreamCount > 0 ? `${workstreamCount} workstream(s) implemented` : "direct verification completed";
      return {
        conclusion: `Task "${shortTask}" completed and verified: ${wsPhrase}, independent review raised ${safeFindings.length} observation(s).`,
        hasBlockingIssues: false,
      };
    }
    const reasons = [];
    if (failedWorkstreamCount > 0)
      reasons.push(`${failedWorkstreamCount} workstream(s) failed execution`);
    if (safeGaps.length > 0) reasons.push(`${safeGaps.length} acceptance gap(s) unresolved`);
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
    const wsPhrase =
      workstreamCount > 0 ? `${workstreamCount} 条工作流落地` : "直接验证完成";
    return {
      conclusion: `任务「${shortTask}」已完成并通过验证：${wsPhrase}，独立复核提出 ${safeFindings.length} 条意见。`,
      hasBlockingIssues: false,
    };
  }

  const reasons = [];
  if (failedWorkstreamCount > 0) reasons.push(`${failedWorkstreamCount} 条工作流执行失败`);
  if (safeGaps.length > 0) reasons.push(`${safeGaps.length} 个验收缺口待处理`);
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
  const p = String(profile || "hybrid").toLowerCase().trim();
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
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "NO_ENTRY";
  }
  if (typeof entry.cue !== "string" || typeof entry.lesson !== "string") {
    return "NO_ENTRY";
  }
  if (entry.verdict === "confounded" || entry.verdict === "no_observed_effect") {
    return "NO_ENTRY";
  }
  const sanitize = (str) =>
    typeof str === "string"
      ? str.replace(/<\/?experience>/gi, "").replace(/\s+/g, " ").trim()
      : "";

  const cue = sanitize(entry.cue);
  const lesson = sanitize(entry.lesson);
  if (!cue || !lesson || cue === "NO_ENTRY" || lesson === "NO_ENTRY") {
    return "NO_ENTRY";
  }
  const dim = entry.dimension === "DOM" || entry.dimension === "INV" ? entry.dimension : "INV";
  const verdict = typeof entry.verdict === "string" ? sanitize(entry.verdict) : "";
  if (!verdict || verdict === "confounded" || verdict === "no_observed_effect") {
    return "NO_ENTRY";
  }
  const confidence = typeof entry.confidence === "string" ? sanitize(entry.confidence) : "medium";
  const evidence = sanitize(entry.evidence);

  return [
    "<experience>",
    `dimension: ${dim}`,
    `cue: ${cue}`,
    `lesson: ${lesson}`,
    `verdict: ${verdict}`,
    `confidence: ${confidence || "medium"}`,
    `evidence: ${evidence}`,
    "</experience>",
  ].join("\n");
}
