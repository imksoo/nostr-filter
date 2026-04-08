export type RelayDecision = {
  shouldRelay: boolean;
  because: string;
};

export type ClientAddress = {
  ip: string;
  port: number;
};

export type ConnectionAttemptState = {
  connectionCountForIP: number;
  totalProcessingCostMsForIP: number;
  isProcessingCostBlocked: boolean;
  processingCostBlockedUntil?: number;
  isRuleBlocked: boolean;
  ruleBlockedUntil?: number;
  ruleBlockedReason?: string;
};

export type ConnectionReleaseState = {
  connectionCountForIP: number;
  totalProcessingCostMsForIP: number;
  shouldResetIPState: boolean;
  isProcessingCostBlocked: boolean;
  isRuleBlocked: boolean;
};

export type ProcessingCostUpdate = {
  totalProcessingCostMsForIP: number;
  chargedProcessingCostMs: number;
  isNewlyBlocked: boolean;
  blockedUntil?: number;
};

export type TrackedReq = {
  subscriptionId: string;
  req: unknown;
};

export type ReqShape = {
  filterCount: number;
  kinds: number[];
  idsCount: number;
  authorsCount: number;
  pTagCount: number;
  eTagCount: number;
  totalTagValueCount: number;
  otherTagKeys: string[];
  hasSince: boolean;
  hasUntil: boolean;
  hasSearch: boolean;
  limit?: number;
};

export type ReqFilterAnalysis = {
  filterIndex: number;
  kinds: number[];
  idsCount: number;
  authorsCount: number;
  tagCounts: Record<string, number>;
  hasSince: boolean;
  hasUntil: boolean;
  hasSearch: boolean;
  limit?: number;
  rewriteEligibleModes: ReqExecutionStats["mode"][];
};

export type ReqAnalysis = {
  shape: ReqShape;
  filters: ReqFilterAnalysis[];
  hasMultiFilter: boolean;
  hasMultiKindFilter: boolean;
  candidatePlans: ReqExecutionStats["mode"][];
  activeRewriteModes: ReqExecutionStats["mode"][];
  signature: string;
};

export type ReqExecutionStats = {
  shape: ReqShape;
  analysis: ReqAnalysis;
  mode: "passthrough" | "strip_p_e_tags" | "split_authors";
  upstreamEventCount: number;
  downstreamEventCount: number;
};

export type ReqPlanStatsSummary = {
  mode: ReqExecutionStats["mode"];
  sampleCount: number;
  avgProcessingCostMs: number;
  maxProcessingCostMs: number;
  avgUpstreamEventCount: number;
  avgDownstreamEventCount: number;
  avgExpansionRatio: number;
  avgResultDensityPerAuthorTagUnit: number;
};

export type ReqPlanRewriteHeuristic = {
  shouldPreferRewrite: boolean;
  reason:
    | "insufficient_data"
    | "no_alternative"
    | "below_sample_threshold"
    | "below_cost_threshold"
    | "above_density_threshold"
    | "above_downstream_threshold"
    | "below_tag_threshold"
    | "prefer_rewrite";
  sourceMode?: ReqExecutionStats["mode"];
  candidateMode?: ReqExecutionStats["mode"];
  minSampleCount: number;
  minAvgProcessingCostMs: number;
  maxAvgResultDensityPerAuthorTagUnit: number;
  maxAvgDownstreamEventCount: number;
  minTotalTagValueCount: number;
};

export type ReqPlanRecommendation = {
  recommendedMode: ReqExecutionStats["mode"];
  basis: "none" | "shape" | "signature" | "heuristic";
  signature?: string;
  consideredModes: ReqExecutionStats["mode"][];
  statsByMode: ReqPlanStatsSummary[];
  heuristic?: ReqPlanRewriteHeuristic;
};

export type ReqPlanExperimentCandidate = {
  shouldExperiment: boolean;
  reason: "no_alternative" | "no_history" | "low_sample" | "close_cost" | "heuristic_probe" | "stable_winner";
  recommendedMode: ReqExecutionStats["mode"];
  challengerMode?: ReqExecutionStats["mode"];
  sampleCountByMode: Array<{ mode: ReqExecutionStats["mode"]; sampleCount: number }>;
  costDeltaMs?: number;
};
