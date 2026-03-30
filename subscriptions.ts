import { Mutex } from "async-mutex";
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

  function toNumberArray(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is number => typeof item === "number");
  }

  function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  }

  function buildReqShape(reqPayload: unknown): ReqShape {
    const reqFilters =
      Array.isArray(reqPayload)
        ? reqPayload.filter((reqFilter): reqFilter is Record<string, unknown> => typeof reqFilter === "object" && reqFilter !== null && !Array.isArray(reqFilter))
        : typeof reqPayload === "object" && reqPayload !== null && !Array.isArray(reqPayload)
          ? [reqPayload as Record<string, unknown>]
          : [];
    const otherTagKeys = Array.from(
      new Set(
        reqFilters.flatMap((req) =>
          Object.keys(req)
            .filter((key) => key.startsWith("#") && key !== "#p" && key !== "#e")
            .sort(),
        ),
      ),
    ).sort();
    return {
      filterCount: Math.max(reqFilters.length, 1),
      kinds: Array.from(new Set(reqFilters.flatMap((req) => toNumberArray(req.kinds)))).sort((a, b) => a - b),
      authorsCount: reqFilters.reduce((sum, req) => sum + toStringArray(req.authors).length, 0),
      pTagCount: reqFilters.reduce((sum, req) => sum + toStringArray(req["#p"]).length, 0),
      eTagCount: reqFilters.reduce((sum, req) => sum + toStringArray(req["#e"]).length, 0),
      otherTagKeys,
      limit: reqFilters.length === 1 && typeof reqFilters[0]?.limit === "number" ? reqFilters[0].limit : undefined,
    };
  }

  function trackReq(subscriptionId: string, reqPayload: unknown, mode: ReqExecutionStats["mode"] = "passthrough"): void {
    const socketAndSubscriptionId = getSocketSubscriptionId(subscriptionId);
    activeSubscriptions.add(socketAndSubscriptionId);
    reqStartedAt.set(socketAndSubscriptionId, Date.now());
    reqPayloads.set(socketAndSubscriptionId, reqPayload);
    reqExecutionStats.set(socketAndSubscriptionId, {
      shape: buildReqShape(reqPayload),
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
