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
  isNewlyBlocked: boolean;
  blockedUntil?: number;
};

export type TrackedReq = {
  subscriptionId: string;
  req: unknown;
};
