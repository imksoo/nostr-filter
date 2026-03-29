import dotenv from "dotenv";
import { log } from "./logger";

dotenv.config();

export const NODE_ENV = process.env.NODE_ENV || "production";
export const listenPort = parseInt(process.env.LISTEN_PORT ?? "8081");
export const upstreamHttpUrl = process.env.UPSTREAM_HTTP_URL ?? "http://localhost:8080";
export const upstreamWsUrl = process.env.UPSTREAM_WS_URL ?? "ws://localhost:8080";
export const upstreamWsForFastBotUrl = process.env.UPSTREAM_WS_FOR_FAST_BOT_URL ?? "ws://localhost:8080";

export const contentFilters: RegExp[] = Object.keys(process.env)
  .filter((key) => key.startsWith("MUTE_FILTER_"))
  .map((key) => {
    const pattern = process.env[key]!;
    const match = pattern.match(/^\/(.+)\/([gimy]*)$/);
    return match ? new RegExp(match[1], match[2]) : new RegExp(pattern);
  });

export const blockedPubkeys = typeof process.env.BLOCKED_PUBKEYS !== "undefined" && process.env.BLOCKED_PUBKEYS !== "" ? process.env.BLOCKED_PUBKEYS.split(",").map((pubkey) => pubkey.trim()) : [];

export const whitelistedPubkeys = typeof process.env.WHITELISTED_PUBKEYS !== "undefined" && process.env.WHITELISTED_PUBKEYS !== "" ? process.env.WHITELISTED_PUBKEYS.split(",").map((pubkey) => pubkey.trim()) : [];
export const blockedReqKinds = typeof process.env.BLOCKED_REQ_KINDS !== "undefined" && process.env.BLOCKED_REQ_KINDS !== "" ? process.env.BLOCKED_REQ_KINDS.split(",").map((kind) => parseInt(kind.trim(), 10)).filter((kind) => !Number.isNaN(kind)) : [];
export const blockedWriteKinds = typeof process.env.BLOCKED_WRITE_KINDS !== "undefined" && process.env.BLOCKED_WRITE_KINDS !== "" ? process.env.BLOCKED_WRITE_KINDS.split(",").map((kind) => parseInt(kind.trim(), 10)).filter((kind) => !Number.isNaN(kind)) : blockedReqKinds;
export const blockEphemeralWrites = process.env.BLOCK_EPHEMERAL_WRITES === "true";

export const filterProxyEvents = process.env.FILTER_PROXY_EVENTS === "true";
export const enableForwardReqHeaders = process.env.ENABLE_FORWARD_REQ_HEADERS === "true";
export const maxWebsocketPayloadSize = parseInt(process.env.MAX_WEBSOCKET_PAYLOAD_SIZE ?? "1000000");
export const cidrRanges = Object.keys(process.env)
  .filter((key) => key.startsWith("BLOCKED_IP_ADDR_"))
  .map((key) => process.env[key]!);
export const processingCostBlockThresholdMs = parseInt(process.env.PROCESSING_COST_BLOCK_THRESHOLD_MS ?? "0");
export const processingCostBlockDurationSec = parseInt(process.env.PROCESSING_COST_BLOCK_DURATION_SEC ?? "600");
export const singleReqProcessingCostWarnThresholdMs = parseInt(process.env.SINGLE_REQ_PROCESSING_COST_WARN_THRESHOLD_MS ?? "10000");
export const maxTrackedReqsPerSocket = parseInt(process.env.MAX_TRACKED_REQS_PER_SOCKET ?? "100");
export const maxConcurrentReqsPerSocket = parseInt(process.env.MAX_CONCURRENT_REQS_PER_SOCKET ?? "8");
export const blockedActionBanDurationSec = parseInt(process.env.BLOCKED_ACTION_BAN_DURATION_SEC ?? "600");
export const concurrentReqBanThreshold = parseInt(process.env.CONCURRENT_REQ_BAN_THRESHOLD ?? "3");
export const concurrentReqBanDurationSec = parseInt(process.env.CONCURRENT_REQ_BAN_DURATION_SEC ?? "60");
export const reconnectBanThreshold = parseInt(process.env.RECONNECT_BAN_THRESHOLD ?? "20");
export const reconnectBanWindowSec = parseInt(process.env.RECONNECT_BAN_WINDOW_SEC ?? "60");
export const reconnectBanDurationSec = parseInt(process.env.RECONNECT_BAN_DURATION_SEC ?? "300");

export function logStartupConfig(): void {
  log("INFO", { msg: "process.env", ...process.env });
  log("INFO", {
    msg: "configs",
    listenPort,
    upstreamHttpUrl,
    upstreamWsUrl,
    upstreamWsForFastBotUrl,
    contentFilters: contentFilters.map((regex) => `/${regex.source}/${regex.flags}`),
    blockedReqKinds,
    blockedWriteKinds,
    blockEphemeralWrites,
    blockedIPAddresses: cidrRanges,
    processingCostBlockThresholdMs,
    processingCostBlockDurationSec,
    singleReqProcessingCostWarnThresholdMs,
    maxTrackedReqsPerSocket,
    maxConcurrentReqsPerSocket,
    blockedActionBanDurationSec,
    concurrentReqBanThreshold,
    concurrentReqBanDurationSec,
    reconnectBanThreshold,
    reconnectBanWindowSec,
    reconnectBanDurationSec,
  });
}
