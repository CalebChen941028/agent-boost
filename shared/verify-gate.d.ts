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

export function formatFailureOutput(
  stdout?: string,
  stderr?: string,
  maxLength?: number,
): string;

export function computeFailureSignature(output: string): string;

export function computeGapSignature(gaps: string[]): string;

export function formatConclusion(
  shortTask: string,
  workstreamCount: number,
  gaps: string[],
  findings: FindingLike[],
  lang?: "zh" | "en",
): string;

export function validateTeamProfile(profile: string): "hybrid" | "quality" | "economy";

export function validateIntegrityMode(mode: string): "development" | "demo" | "benchmark";

export function isSubstantiveChallenge(challenge: ChallengeLike | null | undefined): boolean;

export function calculateTeamworkOpenGaps(
  milestoneOutcomes: MilestoneOutcomeLike[],
  auditPassed: boolean,
  verifyCommandRan: boolean,
  verifyPassed: boolean,
): number;

export function formatTeamworkConclusion(
  openGaps: number,
  verifyCommandRan: boolean,
  verifyPassed: boolean,
  replansUsed?: number,
  lang?: "zh" | "en",
): string;

export function resolveModelConfiguration(
  requestedName: string,
  localConfig?: any,
): { modelId: string | null; tier: "light" | "heavy" | "default" };
