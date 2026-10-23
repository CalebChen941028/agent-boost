export interface FindingLike {
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  status: "verified" | "unconfirmed";
}

export declare function formatFailureOutput(stdout?: string, stderr?: string, maxLength?: number): string;
export declare function computeFailureSignature(output: string): string;
export declare function formatConclusion(
  task: string,
  workstreamCount: number,
  reviewFindings?: FindingLike[],
  gaps?: string[],
  lang?: "zh" | "en",
): { conclusion: string; hasBlockingIssues: boolean };
export declare function validateTeamProfile(profile?: string): "hybrid" | "quality" | "economy";
export declare function resolveModelConfiguration(
  requestedName: string,
  localConfig?: any,
): { modelId: string | null; tier: "light" | "heavy" | "default" };
