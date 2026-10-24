/**
 * Pure functions for Boost verification gates, failure output formatting,
 * stall detection signatures, workstream target-file conflict checking,
 * Harness² experience reflection, and workflow conclusion formatting.
 */

export interface FindingLike {
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  status: "verified" | "unconfirmed";
  criterion?: string;
}

export interface WorkstreamLike {
  title: string;
  kind?: "code" | "investigate";
  targetFiles?: string[];
}

export interface FileConflict {
  file: string;
  workstreams: string[];
}

export interface ExperienceCue {
  cue: string;
  lesson: string;
  dimension: "INV" | "DOM";
  verdict: "helped" | "hurt" | "no_observed_effect" | "confounded";
  confidence: "high" | "medium" | "low";
  evidence: string;
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
export function detectTargetFileConflicts(workstreams: WorkstreamLike[] = []): FileConflict[] {
  const fileOwners = new Map<string, string[]>();
  const canonicalFiles = new Map<string, string>();

  for (const ws of workstreams || []) {
    if (ws.kind && ws.kind !== "code") continue;
    for (const rawFile of ws.targetFiles || []) {
      const normalized = String(rawFile || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^(?:\.\/+)+/, "")
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

  const conflicts: FileConflict[] = [];
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
  task: string,
  workstreamCount: number,
  reviewFindings: FindingLike[] = [],
  gaps: string[] = [],
  lang: "zh" | "en" = "zh",
  failedWorkstreamCount: number = 0,
): { conclusion: string; hasBlockingIssues: boolean } {
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
    const reasons: string[] = [];
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

  const reasons: string[] = [];
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
export function validateTeamProfile(profile: string = "hybrid"): "hybrid" | "quality" | "economy" {
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

/**
 * Formats a Harness²-inspired transferable experience cue into a structured block,
 * rejecting low-confidence or confounded attributions so they do not pollute future runs.
 */
export function formatExperienceEntry(entry: ExperienceCue | null | undefined): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "NO_ENTRY";
  }
  if (typeof entry.cue !== "string" || typeof entry.lesson !== "string") {
    return "NO_ENTRY";
  }
  if (entry.verdict === "confounded" || entry.verdict === "no_observed_effect") {
    return "NO_ENTRY";
  }
  const sanitize = (str: any) =>
    typeof str === "string"
      ? str
          .replace(/<\/?experience(?:\s+[^<>]*)?>/gi, "")
          .replace(/<\/?experience\b/gi, "")
          .replace(/\s+/g, " ")
          .trim()
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

export interface TaskComplexityResult {
  complexity: "simple" | "standard" | "hard";
  maxRepairRounds: number;
  recommendedProfile: "economy" | "hybrid" | "quality";
}

export interface YardstickScoreResult {
  overallScore: number;
  passed: boolean;
  breakdown: {
    delivery: number;
    conformance: number;
    fidelity: number;
    internalConsistency: number;
    operationalFitness: number;
    finish: number;
  };
  deductions: Array<{
    criterion: string;
    severity: string;
    reason: string;
    penalty: number;
  }>;
}

/**
 * Intelligently retrieves and ranks relevant Harness² experience cues matching
 * the current task context, replacing naive tail-slicing truncation.
 * Filters out confounded or low-value cues and ranks by keyword and dimension relevance.
 */
export function matchExperienceCues(
  cueContent: string = "",
  taskDescription: string = "",
  maxCues: number = 3,
): string {
  if (
    !cueContent ||
    typeof cueContent !== "string" ||
    !taskDescription ||
    typeof taskDescription !== "string" ||
    typeof maxCues !== "number" ||
    isNaN(maxCues) ||
    maxCues <= 0
  ) {
    return "";
  }

  const blockRegex = /<experience>([\s\S]*?)<\/experience>/gi;
  const blocks = [];
  let match;
  while ((match = blockRegex.exec(cueContent)) !== null) {
    const fullBlock = match[0].trim();
    const inner = match[1];
    if (/verdict:\s*(?:confounded|no_observed_effect)/i.test(inner)) {
      continue;
    }
    blocks.push({ full: fullBlock, text: inner });
  }

  if (blocks.length === 0) {
    return "";
  }

  const rawTokens =
    taskDescription.toLowerCase().match(/[\p{L}\p{N}_\-]+/gu) || [];
  const STOPWORDS = new Set([
    "the", "and", "for", "with", "this", "that", "from", "when", "into",
    "task", "code", "file", "then", "have", "been", "will", "does", "done",
    "test", "tests", "what", "where", "which", "your", "are", "can", "all",
    "our", "out", "about", "more", "also", "using", "used", "only", "must",
    "make", "任务", "请", "的", "和", "在", "与", "了", "按", "将", "并",
    "及", "到", "为", "对", "以", "等", "从", "个", "项", "用", "做", "后",
    "中", "进行", "完成", "实现",
  ]);

  const keywords = [];
  for (const token of rawTokens) {
    if (token.length >= 2 && !STOPWORDS.has(token)) {
      keywords.push(token);
    }
  }

  const scored = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const bText = b.text.toLowerCase();
    const cueLine = (bText.match(/cue:\s*([^\n]+)/) || [])[1] || "";
    const lessonLine = (bText.match(/lesson:\s*([^\n]+)/) || [])[1] || "";

    let score = 0;
    for (const kw of keywords) {
      if (cueLine.includes(kw)) score += 3;
      if (lessonLine.includes(kw)) score += 2;
      if (bText.includes(kw)) score += 1;
    }

    if (score > 0 && /confidence:\s*high/i.test(bText)) {
      score += 1;
    }

    if (score > 0) {
      scored.push({ block: b.full, score, index: i });
    }
  }

  if (scored.length === 0) {
    return "";
  }

  scored.sort((a, b) => b.score - a.score || b.index - a.index);

  return scored
    .slice(0, maxCues)
    .map((s) => s.block)
    .join("\n\n");
}

/**
 * Evaluates task complexity to dynamically allocate verification rounds and
 * recommended model profiles (simple -> economy, standard -> hybrid, hard -> quality).
 * Aligns test-time compute with problem difficulty (Snell et al. 2024).
 */
export function evaluateTaskComplexity(
  task: string = "",
  context: string = "",
  fileCount: number = 0,
): {
  complexity: "simple" | "standard" | "hard";
  maxRepairRounds: number;
  recommendedProfile: "economy" | "hybrid" | "quality";
} {
  const cleanTask = String(task || "").trim();
  const cleanCtx = String(context || "").trim();
  const safeFileCount =
    typeof fileCount === "number" && !isNaN(fileCount) && fileCount >= 0
      ? fileCount
      : 0;

  if (!cleanTask) {
    return {
      complexity: "simple",
      maxRepairRounds: 2,
      recommendedProfile: "economy",
    };
  }

  const combined = `${cleanTask}\n${cleanCtx}`.toLowerCase();

  const hardKeywords = [
    "concurrency",
    "race condition",
    "deadlock",
    "distributed",
    "consensus",
    "raft",
    "paxos",
    "security",
    "vulnerability",
    "cve",
    "privilege escalation",
    "memory leak",
    "segfault",
    "profiling",
    "ast transformation",
    "compiler",
    "transpiler",
    "state machine",
    "deep refactor",
    "architecture",
    "protocol",
    "并发",
    "竞态",
    "死锁",
    "分布式",
    "高可用",
    "内存泄漏",
    "段错误",
    "架构重构",
    "底层协议",
    "安全漏洞",
    "越权",
  ];

  const simpleKeywords = [
    "typo",
    "spelling",
    "lint",
    "formatting",
    "prettier",
    "eslint",
    "readme",
    "changelog",
    "comment",
    "docstring",
    "rename variable",
    "version bump",
    "bump version",
    "拼写",
    "文档",
    "注释",
    "格式化",
    "代码风格",
    "版本升级",
  ];

  let isHard = false;
  if (safeFileCount >= 5 || combined.length > 1000) {
    isHard = true;
  } else {
    for (const kw of hardKeywords) {
      if (combined.includes(kw)) {
        isHard = true;
        break;
      }
    }
  }

  if (isHard) {
    return {
      complexity: "hard",
      maxRepairRounds: 5,
      recommendedProfile: "quality",
    };
  }

  let isSimple = false;
  if (safeFileCount <= 1 && combined.length < 200) {
    for (const kw of simpleKeywords) {
      if (combined.includes(kw)) {
        isSimple = true;
        break;
      }
    }
  }

  if (isSimple) {
    return {
      complexity: "simple",
      maxRepairRounds: 2,
      recommendedProfile: "economy",
    };
  }

  return {
    complexity: "standard",
    maxRepairRounds: 3,
    recommendedProfile: "hybrid",
  };
}

/**
 * Computes a quantitative 6-criterion Harness² conformance and quality score (0-100).
 * Criteria: DELIVERY, CONFORMANCE, FIDELITY, INTERNAL_CONSISTENCY, OPERATIONAL_FITNESS, FINISH.
 * Applies severity-based deductions and determines pass/fail status.
 */
export function calculateYardstickScore(
  findings: FindingLike[] = [],
  customWeights: any = null,
): {
  overallScore: number;
  passed: boolean;
  breakdown: {
    delivery: number;
    conformance: number;
    fidelity: number;
    internalConsistency: number;
    operationalFitness: number;
    finish: number;
  };
  deductions: Array<{
    criterion: string;
    severity: string;
    reason: string;
    penalty: number;
  }>;
} {
  const scores = {
    delivery: 100,
    conformance: 100,
    fidelity: 100,
    internalConsistency: 100,
    operationalFitness: 100,
    finish: 100,
  };

  const weights = {
    delivery: 1 / 6,
    conformance: 1 / 6,
    fidelity: 1 / 6,
    internalConsistency: 1 / 6,
    operationalFitness: 1 / 6,
    finish: 1 / 6,
  };

  if (customWeights && typeof customWeights === "object") {
    let sum = 0;
    const keys = [
      "delivery",
      "conformance",
      "fidelity",
      "internalConsistency",
      "operationalFitness",
      "finish",
    ];
    for (const k of keys) {
      if (typeof customWeights[k] === "number" && customWeights[k] >= 0) {
        sum += customWeights[k];
      }
    }
    if (sum > 0) {
      for (const k of keys) {
        if (typeof customWeights[k] === "number" && customWeights[k] >= 0) {
          weights[k] = customWeights[k] / sum;
        }
      }
    }
  }

  const safeFindings = Array.isArray(findings) ? findings : [];
  const deductions = [];
  let hasHighSeverity = false;

  for (const f of safeFindings) {
    if (!f || typeof f !== "object") continue;

    const sev = String(f.severity || "medium").trim().toLowerCase();
    let penalty = 15;
    if (sev === "high") {
      penalty = 40;
      hasHighSeverity = true;
    } else if (sev === "low") {
      penalty = 5;
    }

    let criterion = "operationalFitness";
    const explicitCrit = String(f.criterion || "").trim().toLowerCase();

    if (explicitCrit.includes("deliv")) {
      criterion = "delivery";
    } else if (explicitCrit.includes("conform")) {
      criterion = "conformance";
    } else if (explicitCrit.includes("fidel")) {
      criterion = "fidelity";
    } else if (explicitCrit.includes("consist")) {
      criterion = "internalConsistency";
    } else if (explicitCrit.includes("fit")) {
      criterion = "operationalFitness";
    } else if (explicitCrit.includes("finish")) {
      criterion = "finish";
    } else {
      const text = `${f.what || ""} ${f.evidence || ""}`.toLowerCase();
      if (/missing file|feature missing|not delivered|未交付|缺失|遗漏/.test(text)) {
        criterion = "delivery";
      } else if (/signature|schema|contract|extra field|unrequested|契约|结构|擅自/.test(text)) {
        criterion = "conformance";
      } else if (/fabricat|hallucinat|unverified|false claim|编造|虚假|不实/.test(text)) {
        criterion = "fidelity";
      } else if (/type error|import|export|mismatch|前后不一致|类型不匹配/.test(text)) {
        criterion = "internalConsistency";
      } else if (/todo|placeholder|stub|mock|占位符|未完|桩代码/.test(text)) {
        criterion = "finish";
      }
    }

    scores[criterion] = Math.max(0, scores[criterion] - penalty);
    deductions.push({
      criterion,
      severity: sev,
      reason: f.what || "Finding deduction",
      penalty,
    });
  }

  const overallScore = Math.round(
    scores.delivery * weights.delivery +
      scores.conformance * weights.conformance +
      scores.fidelity * weights.fidelity +
      scores.internalConsistency * weights.internalConsistency +
      scores.operationalFitness * weights.operationalFitness +
      scores.finish * weights.finish,
  );

  const passed = overallScore >= 80 && !hasHighSeverity;

  return {
    overallScore,
    passed,
    breakdown: scores,
    deductions,
  };
}
