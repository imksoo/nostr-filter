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
export const whitelistedIpCidrs = Object.keys(process.env)
  .filter((key) => key.startsWith("WHITELISTED_IP_ADDR_"))
  .map((key) => process.env[key]!);
export const blockedReqKinds =
  typeof process.env.BLOCKED_REQ_KINDS !== "undefined" && process.env.BLOCKED_REQ_KINDS !== ""
    ? process.env.BLOCKED_REQ_KINDS.split(",")
        .map((kind) => parseInt(kind.trim(), 10))
        .filter((kind) => !Number.isNaN(kind))
    : [];
export const blockedWriteKinds =
  typeof process.env.BLOCKED_WRITE_KINDS !== "undefined" && process.env.BLOCKED_WRITE_KINDS !== ""
    ? process.env.BLOCKED_WRITE_KINDS.split(",")
        .map((kind) => parseInt(kind.trim(), 10))
        .filter((kind) => !Number.isNaN(kind))
    : blockedReqKinds;
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
export const reqRewriteEnabledKinds =
  typeof process.env.REQ_REWRITE_ENABLED_KINDS !== "undefined" && process.env.REQ_REWRITE_ENABLED_KINDS !== ""
    ? process.env.REQ_REWRITE_ENABLED_KINDS.split(",")
        .map((kind) => parseInt(kind.trim(), 10))
        .filter((kind) => !Number.isNaN(kind))
    : [1984];
export const reqRewriteDisabledKinds =
  typeof process.env.REQ_REWRITE_DISABLED_KINDS !== "undefined" && process.env.REQ_REWRITE_DISABLED_KINDS !== ""
    ? process.env.REQ_REWRITE_DISABLED_KINDS.split(",")
        .map((kind) => parseInt(kind.trim(), 10))
        .filter((kind) => !Number.isNaN(kind))
    : [1];
export const reqDualRunEnabledKinds =
  typeof process.env.REQ_DUAL_RUN_ENABLED_KINDS !== "undefined" && process.env.REQ_DUAL_RUN_ENABLED_KINDS !== ""
    ? process.env.REQ_DUAL_RUN_ENABLED_KINDS.split(",")
        .map((kind) => parseInt(kind.trim(), 10))
        .filter((kind) => !Number.isNaN(kind))
    : [];
export const reqDualRunSampleRate = Number.parseFloat(process.env.REQ_DUAL_RUN_SAMPLE_RATE ?? "0");
export const reqPlanRewriteMinSampleCount = parseInt(process.env.REQ_PLAN_REWRITE_MIN_SAMPLE_COUNT ?? "20");
export const reqPlanRewriteMinAvgProcessingCostMs = parseInt(process.env.REQ_PLAN_REWRITE_MIN_AVG_PROCESSING_COST_MS ?? "250");
export const reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit = Number.parseFloat(process.env.REQ_PLAN_REWRITE_MAX_AVG_RESULT_DENSITY_PER_AUTHOR_TAG_UNIT ?? "0.05");
export const reqPlanRewriteMaxAvgDownstreamEventCount = Number.parseFloat(process.env.REQ_PLAN_REWRITE_MAX_AVG_DOWNSTREAM_EVENT_COUNT ?? "1");
export const reqPlanRewriteMinTotalTagValueCount = parseInt(process.env.REQ_PLAN_REWRITE_MIN_TOTAL_TAG_VALUE_COUNT ?? "2");
export const reqPlannerStatsPath = process.env.REQ_PLANNER_STATS_PATH ?? "./data/req-planner-stats.json";
export const reqPlannerStatsFlushIntervalSec = parseInt(process.env.REQ_PLANNER_STATS_FLUSH_INTERVAL_SEC ?? "60");

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
    whitelistedIpAddresses: whitelistedIpCidrs,
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
    reqRewriteEnabledKinds,
    reqRewriteDisabledKinds,
    reqDualRunEnabledKinds,
    reqDualRunSampleRate,
    reqPlanRewriteMinSampleCount,
    reqPlanRewriteMinAvgProcessingCostMs,
    reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit,
    reqPlanRewriteMaxAvgDownstreamEventCount,
    reqPlanRewriteMinTotalTagValueCount,
    reqPlannerStatsPath,
    reqPlannerStatsFlushIntervalSec,
  });
}
