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
};

export type ConnectionReleaseState = {
  connectionCountForIP: number;
  totalProcessingCostMsForIP: number;
  shouldResetIPState: boolean;
  isProcessingCostBlocked: boolean;
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
