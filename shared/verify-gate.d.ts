export interface FindingLike {
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  status: "verified" | "unconfirmed";
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

export declare function formatFailureOutput(stdout?: string, stderr?: string, maxLength?: number): string;
export declare function computeFailureSignature(output: string): string;
export declare function detectTargetFileConflicts(workstreams?: WorkstreamLike[]): FileConflict[];
export declare function formatConclusion(
  task: string,
  workstreamCount: number,
  reviewFindings?: FindingLike[],
  gaps?: string[],
  lang?: "zh" | "en",
  failedWorkstreamCount?: number,
): { conclusion: string; hasBlockingIssues: boolean };
export declare function validateTeamProfile(profile?: string): "hybrid" | "quality" | "economy";
export declare function resolveModelConfiguration(
  requestedName: string,
  localConfig?: any,
): { modelId: string | null; tier: "light" | "heavy" | "default" };
export declare function formatExperienceEntry(entry?: ExperienceCue | null): string;

export declare function matchExperienceCues(
  cueContent?: string,
  taskDescription?: string,
  maxCues?: number,
): string;

export declare function evaluateTaskComplexity(
  task?: string,
  context?: string,
  fileCount?: number,
): TaskComplexityResult;

export declare function calculateYardstickScore(
  findings?: FindingLike[],
  customWeights?: any,
): YardstickScoreResult;
