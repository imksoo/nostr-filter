import { Mutex } from "async-mutex";
import { analyzeReq } from "./req-analyzer";
import { ReqExecutionStats, ReqShape, TrackedReq } from "./types";

export type SubscriptionTracker = ReturnType<typeof createSubscriptionTracker>;

export function createSubscriptionTracker(socketId: string, maxTrackedReqsPerSocket: number) {
  const transferredSizes = new Map<string, number>();
  const reqStartedAt = new Map<string, number>();
  const reqPayloads = new Map<string, unknown>();
  const reqExecutionStats = new Map<string, ReqExecutionStats>();
  const activeSubscriptions = new Set<string>();
  const sizeMutex = new Mutex();

  function getSocketSubscriptionId(subscriptionId: string): string {
    return `${socketId}:${subscriptionId}`;
  }

  function trackReq(subscriptionId: string, reqPayload: unknown, mode: ReqExecutionStats["mode"] = "passthrough"): void {
    const socketAndSubscriptionId = getSocketSubscriptionId(subscriptionId);
    const analysis = analyzeReq(reqPayload);
    activeSubscriptions.add(socketAndSubscriptionId);
    reqStartedAt.set(socketAndSubscriptionId, Date.now());
    reqPayloads.set(socketAndSubscriptionId, reqPayload);
    reqExecutionStats.set(socketAndSubscriptionId, {
      shape: analysis.shape,
      analysis,
      mode,
      upstreamEventCount: 0,
      downstreamEventCount: 0,
    });
    if (reqPayloads.size > maxTrackedReqsPerSocket) {
      const oldestTrackedSubscriptionId = reqPayloads.keys().next().value;
      if (oldestTrackedSubscriptionId) {
        reqPayloads.delete(oldestTrackedSubscriptionId);
        reqExecutionStats.delete(oldestTrackedSubscriptionId);
      }
    }
  }

  function forgetSubscription(subscriptionId: string): string {
    const socketAndSubscriptionId = getSocketSubscriptionId(subscriptionId);
    activeSubscriptions.delete(socketAndSubscriptionId);
    reqStartedAt.delete(socketAndSubscriptionId);
    reqPayloads.delete(socketAndSubscriptionId);
    reqExecutionStats.delete(socketAndSubscriptionId);
    return socketAndSubscriptionId;
  }

  function getActiveSubscriptionCount(): number {
    return activeSubscriptions.size;
  }

  function getSocketId(): string {
    return socketId;
  }

  function hasActiveSubscription(subscriptionId: string): boolean {
    return activeSubscriptions.has(getSocketSubscriptionId(subscriptionId));
  }

  function getReqStartedAt(subscriptionId: string): number | undefined {
    return reqStartedAt.get(getSocketSubscriptionId(subscriptionId));
  }

  function getReqPayload(subscriptionId: string): unknown {
    return reqPayloads.get(getSocketSubscriptionId(subscriptionId));
  }

  function deleteReqTracking(subscriptionId: string): void {
    reqStartedAt.delete(getSocketSubscriptionId(subscriptionId));
    reqPayloads.delete(getSocketSubscriptionId(subscriptionId));
  }

  function recordUpstreamEvent(subscriptionId: string, isRelayed: boolean): void {
    const stats = reqExecutionStats.get(getSocketSubscriptionId(subscriptionId));
    if (!stats) return;
    stats.upstreamEventCount += 1;
    if (isRelayed) stats.downstreamEventCount += 1;
  }

  function getReqExecutionStats(subscriptionId: string): ReqExecutionStats | undefined {
    return reqExecutionStats.get(getSocketSubscriptionId(subscriptionId));
  }

  function getTrackedReqsForSocket(): TrackedReq[] {
    return Array.from(reqPayloads.entries()).map(([trackedSocketAndSubscriptionId, trackedReq]) => ({
      subscriptionId: trackedSocketAndSubscriptionId.slice(socketId.length + 1),
      req: trackedReq,
    }));
  }

  async function addTransferredSize(subscriptionId: string, messageLength: number): Promise<number> {
    const socketAndSubscriptionId = getSocketSubscriptionId(subscriptionId);
    let subscriptionSize = 0;
    await sizeMutex.runExclusive(async () => {
      subscriptionSize = (transferredSizes.get(socketAndSubscriptionId) ?? 0) + messageLength;
      transferredSizes.set(socketAndSubscriptionId, subscriptionSize);
    });
    return subscriptionSize;
  }

  function getTransferredSize(subscriptionId: string): number | undefined {
    return transferredSizes.get(getSocketSubscriptionId(subscriptionId));
  }

  return {
    trackReq,
    forgetSubscription,
    getSocketId,
    getActiveSubscriptionCount,
    hasActiveSubscription,
    getReqStartedAt,
    getReqPayload,
    deleteReqTracking,
    recordUpstreamEvent,
    getReqExecutionStats,
    getTrackedReqsForSocket,
    addTransferredSize,
    getTransferredSize,
  };
}
