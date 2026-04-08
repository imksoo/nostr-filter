import { reqSplitAuthorsChunkSize, reqSplitAuthorsMinCount, upstreamHttpUrl } from "./config";
import { log } from "./logger";

type ReqSplitAuthorsPolicy = {
  source: "fallback" | "nip11";
  maxLimit?: number;
  minCount: number;
  chunkSize: number;
};

function buildFallbackPolicy(): ReqSplitAuthorsPolicy {
  return {
    source: "fallback",
    minCount: Math.max(reqSplitAuthorsMinCount, 1),
    chunkSize: Math.max(reqSplitAuthorsChunkSize, 1),
  };
}

function buildPolicyFromMaxLimit(maxLimit: number): ReqSplitAuthorsPolicy {
  return {
    source: "nip11",
    maxLimit,
    minCount: Math.max(maxLimit * 2 + 1, 1),
    chunkSize: Math.max(maxLimit, 1),
  };
}

let currentReqSplitAuthorsPolicy: ReqSplitAuthorsPolicy = buildFallbackPolicy();

export function getReqSplitAuthorsPolicy(): ReqSplitAuthorsPolicy {
  return currentReqSplitAuthorsPolicy;
}

export async function refreshReqSplitAuthorsPolicy(): Promise<void> {
  try {
    const response = await fetch(upstreamHttpUrl, {
      headers: {
        Accept: "application/nostr+json",
      },
    });

    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }

    const relayInfo = (await response.json()) as { limitation?: { max_limit?: unknown } };
    const maxLimit = relayInfo?.limitation?.max_limit;
    if (typeof maxLimit !== "number" || !Number.isFinite(maxLimit) || maxLimit <= 0) {
      throw new Error(`missing or invalid limitation.max_limit: ${JSON.stringify(maxLimit)}`);
    }

    currentReqSplitAuthorsPolicy = buildPolicyFromMaxLimit(Math.floor(maxLimit));
    log("INFO", {
      msg: "REQ SPLIT AUTHORS POLICY UPDATED",
      source: currentReqSplitAuthorsPolicy.source,
      upstreamHttpUrl,
      maxLimit: currentReqSplitAuthorsPolicy.maxLimit,
      reqSplitAuthorsMinCount: currentReqSplitAuthorsPolicy.minCount,
      reqSplitAuthorsChunkSize: currentReqSplitAuthorsPolicy.chunkSize,
    });
  } catch (error) {
    currentReqSplitAuthorsPolicy = buildFallbackPolicy();
    log("WARN", {
      msg: "REQ SPLIT AUTHORS POLICY FALLBACK",
      upstreamHttpUrl,
      reqSplitAuthorsMinCount: currentReqSplitAuthorsPolicy.minCount,
      reqSplitAuthorsChunkSize: currentReqSplitAuthorsPolicy.chunkSize,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
