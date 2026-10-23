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
