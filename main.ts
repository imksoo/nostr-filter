import fs from "fs";
import http from "http";
import path from "path";
import url from "url";
import * as mime from "mime-types";
import { v7 as uuidv7 } from "uuid";
import WebSocket from "ws";
import { blockedActionBanDurationSec, cidrRanges, concurrentReqBanDurationSec, concurrentReqBanThreshold, enableForwardReqHeaders, listenPort, logStartupConfig, maxConcurrentReqsPerSocket, maxTrackedReqsPerSocket, maxWebsocketPayloadSize, processingCostBlockDurationSec, processingCostBlockThresholdMs, reconnectBanDurationSec, reconnectBanThreshold, reconnectBanWindowSec, reqDualRunEnabledKinds, reqDualRunSampleRate, reqPlannerStatsFlushIntervalSec, reqPlannerStatsPath, singleReqProcessingCostWarnThresholdMs, upstreamHttpUrl, upstreamWsForFastBotUrl, upstreamWsUrl, whitelistedIpCidrs } from "./config";
import { evaluateDownstreamEvent, evaluateUpstreamEvent, ipMatchesCidr } from "./filters";
import { log } from "./logger";
import { buildForwardHeaders, clearIdleTimeout, getClientAddress, getRequestedSubprotocols, resetIdleTimeout, setIdleTimeout } from "./network";
import { acceptConnection, addProcessingCostForIP, blockIPByRule, getConnectionAttemptState, getConnectionCount, getSocketsForIP, recordConcurrentReqViolation, recordReconnectAttempt, releaseConnection, scheduleProcessingCostUnblock, scheduleRuleUnblock, unblockIPByProcessingCost, unblockIPByRule } from "./processing-state";
import { getReqPlanExperimentCandidate, getReqPlanRecommendation, loadReqPlannerStats, persistReqPlannerStats, recordReqExecutionStats } from "./req-planner-stats";
import { planReqRewrite, shouldRelayRewrittenEvent } from "./req-rewrite";
import { refreshReqSplitAuthorsPolicy } from "./req-split-authors-policy";
import { createSubscriptionTracker, SubscriptionTracker } from "./subscriptions";

let upstreamWriteSocket = new WebSocket(upstreamWsForFastBotUrl);
const blockedConnectLogUntilByIP = new Map<string, number>();
const subscriptionTrackersByIP = new Map<string, Map<string, SubscriptionTracker>>();

function registerSubscriptionTracker(ip: string, subscriptionTracker: SubscriptionTracker): void {
  const trackersForIP = subscriptionTrackersByIP.get(ip) ?? new Map<string, SubscriptionTracker>();
  trackersForIP.set(subscriptionTracker.getSocketId(), subscriptionTracker);
  subscriptionTrackersByIP.set(ip, trackersForIP);
}

function unregisterSubscriptionTracker(ip: string, socketId: string): void {
  const trackersForIP = subscriptionTrackersByIP.get(ip);
  if (!trackersForIP) return;
  trackersForIP.delete(socketId);
  if (trackersForIP.size === 0) subscriptionTrackersByIP.delete(ip);
}

function getActiveSubscriptionCountForIP(ip: string): number {
  const trackersForIP = subscriptionTrackersByIP.get(ip);
  if (!trackersForIP) return 0;
  let activeSubscriptionCountForIP = 0;
  for (const subscriptionTracker of trackersForIP.values()) activeSubscriptionCountForIP += subscriptionTracker.getActiveSubscriptionCount();
  return activeSubscriptionCountForIP;
}

function isWhitelistedIP(ip: string): boolean {
  return whitelistedIpCidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

logStartupConfig();
loadReqPlannerStats(path.resolve(__dirname, reqPlannerStatsPath));
setInterval(() => persistReqPlannerStats(path.resolve(__dirname, reqPlannerStatsPath)), reqPlannerStatsFlushIntervalSec * 1000);

async function handleProcessingCostUnblock(ip: string): Promise<void> {
  const { totalProcessingCostMsForIP, hadBlockedState } = await unblockIPByProcessingCost(ip);
  if (!hadBlockedState) return;

  log("INFO", { msg: "IP PROCESSING COST UNBLOCKED", ip, totalProcessingCostMsForIP, processingCostBlockDurationSec, currentTime: new Date().toISOString() });
}

async function handleRuleUnblock(ip: string): Promise<void> {
  const { hadBlockedState, ruleBlockedReason } = await unblockIPByRule(ip);
  if (!hadBlockedState) return;
  log("INFO", { msg: "IP RULE BLOCK UNBLOCKED", ip, ruleBlockedReason, blockedActionBanDurationSec, currentTime: new Date().toISOString() });
}

function loggingMemoryUsage(): void {
  const currentTime = new Date().toISOString();
  const memoryUsage = process.memoryUsage();
  const usedHeapSize = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  const totalHeapSize = Math.round(memoryUsage.heapTotal / 1024 / 1024);
  const rssSize = Math.round(memoryUsage.rss / 1024 / 1024);
  log("DEBUG", { msg: "memoryUsage", currentTime, usedHeapSize, totalHeapSize, rssSize, connectionCount: getConnectionCount() });
}

loggingMemoryUsage();
setInterval(loggingMemoryUsage, 10 * 60 * 1000);

function listen(): void {
  log("INFO", { msg: "Started", listenPort });

  const server = http.createServer(async (req, res) => {
    if (req.url && req.headers.accept !== "application/nostr+json") {
      log("DEBUG", { msg: "HTTP GET", url: req.url });
      const requestUrl = url.parse(req.url);
      const pathname = requestUrl.pathname === "/" && req.method === "GET" ? "/index.html" : requestUrl.pathname || "";
      const filePath = path.join(__dirname, "static", pathname.replace(/^\/+/, ""));
      const contentType = mime.contentType(path.extname(filePath)) || "application/octet-stream";
      fs.readFile(filePath, (err, data) => {
        if (err) {
          log("WARN", { msg: "HTTP RESOURCE NOT FOUND", url: req.url });
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("Please use a Nostr client to connect...\n");
          return;
        }

        log("DEBUG", { msg: "HTTP RESPONSE", url: req.url, contentType, length: data.length });
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      });
      return;
    }

    const proxyReq = http.request(upstreamHttpUrl, { method: req.method, headers: req.headers, path: req.url, agent: false }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
  });

  const wss = new WebSocket.Server({ server, maxPayload: maxWebsocketPayloadSize });
  wss.on("connection", async (downstreamSocket, req) => {
    const socketId = uuidv7();
    const subscriptionTracker = createSubscriptionTracker(socketId, maxTrackedReqsPerSocket);
    let isSocketTerminating = false;
    let downstreamMessageQueue = Promise.resolve();
    const connectionStartTime = new Date();
    const connectionStartTimeISO = connectionStartTime.toISOString();
    const elapsedMs = (): number => Date.now() - connectionStartTime.getTime();
    const withTiming = (payload: Record<string, unknown>, includeElapsed: boolean = true): Record<string, unknown> => ({
      ...payload,
      connectionStartTime: connectionStartTimeISO,
      ...(includeElapsed ? { elapsedMs: elapsedMs() } : {}),
    });

    const clientAddress = getClientAddress(req);
    const { ip, port } = clientAddress;
    const isWhitelistedClientIP = isWhitelistedIP(ip);
    registerSubscriptionTracker(ip, subscriptionTracker);
    const requestedSubprotocols = getRequestedSubprotocols(req);
    const wsClientOptions = enableForwardReqHeaders ? { headers: buildForwardHeaders(req, clientAddress) } : undefined;
    const upstreamSocket = requestedSubprotocols ? new WebSocket(upstreamWsUrl, requestedSubprotocols, wsClientOptions) : new WebSocket(upstreamWsUrl, wsClientOptions);
    const dualRunShadowToPrimary = new Map<string, string>();
    const dualRunValidations = new Map<
      string,
      {
        shadowSubscriptionId: string;
        shadowMode: "strip_p_e_tags" | "split_authors";
        authoritativeEventIds: Set<string>;
        shadowEventIds: Set<string>;
        authoritativeUpstreamEventCount: number;
        shadowUpstreamEventCount: number;
        authoritativeProcessingCostMs?: number;
        shadowProcessingCostMs?: number;
      }
    >();

    function beginSocketTermination(): boolean {
      if (isSocketTerminating) return false;
      isSocketTerminating = true;
      return true;
    }

    function closeUpstreamSocket(): void {
      if (upstreamSocket.readyState === WebSocket.CONNECTING) {
        upstreamSocket.terminate();
        return;
      }
      if (upstreamSocket.readyState === WebSocket.OPEN) {
        upstreamSocket.close();
      }
    }

    function sendBlockedNoticeAndClose(because: string, closeCode: number, closeReason: string, extraPayload: Record<string, unknown> = {}, logUntil?: number): void {
      if (!beginSocketTermination()) return;
      const shouldLogBlockedConnect = typeof logUntil !== "number" || (blockedConnectLogUntilByIP.get(ip) ?? 0) < Date.now();
      if (shouldLogBlockedConnect) {
        if (typeof logUntil === "number") blockedConnectLogUntilByIP.set(ip, logUntil);
        log("WARN", withTiming({ msg: "CONNECTING BLOCKED", because, ip, port, socketId, ...extraPayload }));
      }
      const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
      log("DEBUG", withTiming({ msg: "BLOCKED NOTICE", ip, port, socketId, because, blockedMessage, ...extraPayload }));
      closeUpstreamSocket();
      downstreamSocket.send(blockedMessage);
      downstreamSocket.close(closeCode, closeReason);
    }

    function shouldStartDualRun(reqExecutionStats: ReturnType<typeof subscriptionTracker.getReqExecutionStats>, experimentCandidate: ReturnType<typeof getReqPlanExperimentCandidate> | undefined): boolean {
      if (!reqExecutionStats || !experimentCandidate?.shouldExperiment || reqDualRunSampleRate <= 0) return false;
      if (!experimentCandidate.challengerMode || experimentCandidate.challengerMode === "passthrough") return false;
      if (reqDualRunEnabledKinds.length > 0 && !reqExecutionStats.analysis.filters.some((analysis) => analysis.kinds.some((kind) => reqDualRunEnabledKinds.includes(kind)))) return false;
      return Math.random() < reqDualRunSampleRate;
    }

    function getDualRunShadowSubscriptionId(subscriptionId: string, shadowMode: "strip_p_e_tags" | "split_authors"): string {
      return `${subscriptionId}__dual_run__${shadowMode}`;
    }

    function finalizeDualRunValidation(primarySubscriptionId: string): void {
      const validation = dualRunValidations.get(primarySubscriptionId);
      const reqExecutionStats = subscriptionTracker.getReqExecutionStats(primarySubscriptionId);
      if (!validation || typeof validation.authoritativeProcessingCostMs !== "number" || typeof validation.shadowProcessingCostMs !== "number") return;

      const authoritativeEventIds = [...validation.authoritativeEventIds];
      const shadowEventIds = [...validation.shadowEventIds];
      const missingEventIds = authoritativeEventIds.filter((eventId) => !validation.shadowEventIds.has(eventId));
      const unexpectedEventIds = shadowEventIds.filter((eventId) => !validation.authoritativeEventIds.has(eventId));

      log(
        "INFO",
        withTiming({
          msg: "REQ DUAL RUN VALIDATION",
          ip,
          port,
          socketId,
          subscriptionId: primarySubscriptionId,
          authoritativeMode: "passthrough",
          shadowMode: validation.shadowMode,
          authoritativeProcessingCostMs: validation.authoritativeProcessingCostMs,
          shadowProcessingCostMs: validation.shadowProcessingCostMs,
          authoritativeUpstreamEventCount: validation.authoritativeUpstreamEventCount,
          shadowUpstreamEventCount: validation.shadowUpstreamEventCount,
          missingEventCount: missingEventIds.length,
          unexpectedEventCount: unexpectedEventIds.length,
          missingEventIds: missingEventIds.slice(0, 10),
          unexpectedEventIds: unexpectedEventIds.slice(0, 10),
          ...(reqExecutionStats ? { reqShape: reqExecutionStats.shape, reqAnalysisSignature: reqExecutionStats.analysis.signature } : {}),
        }),
      );

      dualRunValidations.delete(primarySubscriptionId);
    }

    function connectUpstream(): void {
      upstreamSocket.on("open", async () => {
        log("DEBUG", withTiming({ msg: "UPSTREAM CONNECTED", socketId }));
        setIdleTimeout(upstreamSocket);
      });

      upstreamSocket.on("close", async () => {
        log("DEBUG", withTiming({ msg: "UPSTREAM DISCONNECTED", socketId }));
        downstreamSocket.close();
        clearIdleTimeout(upstreamSocket);
      });

      upstreamSocket.on("error", async (error: Error) => {
        if (isSocketTerminating && error.message === "WebSocket was closed before the connection was established") return;
        log("WARN", withTiming({ msg: "UPSTREAM ERROR", socketId, error }));
        downstreamSocket.close();
        closeUpstreamSocket();
      });

      upstreamSocket.on("message", async (data) => {
        const message = data.toString();
        let event: any[];
        try {
          event = JSON.parse(message);
        } catch (err: any) {
          event = ["INVALID", err.message ?? JSON.stringify(err)];
        }

        resetIdleTimeout(downstreamSocket);
        resetIdleTimeout(upstreamSocket);

        const relayDecision = evaluateUpstreamEvent(event);
        let shouldRelay = relayDecision.shouldRelay;
        let because = relayDecision.because;

        let result: any[];
        try {
          result = JSON.parse(message);
        } catch (err: any) {
          result = ["INVALID", err.message ?? JSON.stringify(err)];
        }

        const resultType = result[0];
        if (resultType === "OK") {
          log("DEBUG", withTiming({ msg: "EVENT WRITE", ip, port, resultType, socketId, eventId: result[1] }));
        } else if (resultType === "NOTICE") {
          log("DEBUG", withTiming({ msg: "NOTICE", ip, port, resultType, socketId, message: result }));
        } else if (resultType === "EOSE") {
          const subscriptionId = result[1];
          const primarySubscriptionId = dualRunShadowToPrimary.get(subscriptionId);
          if (primarySubscriptionId) {
            const reqStartedAt = subscriptionTracker.getReqStartedAt(subscriptionId);
            const validation = dualRunValidations.get(primarySubscriptionId);
            if (validation && typeof reqStartedAt === "number") validation.shadowProcessingCostMs = Date.now() - reqStartedAt;
            subscriptionTracker.deleteReqTracking(subscriptionId);
            finalizeDualRunValidation(primarySubscriptionId);
            return;
          }
          const reqStartedAt = subscriptionTracker.getReqStartedAt(subscriptionId);
          const processingCostMs = typeof reqStartedAt === "number" ? Date.now() - reqStartedAt : undefined;

          if (typeof processingCostMs === "number") {
            const reqPayload = subscriptionTracker.getReqPayload(subscriptionId);
            const reqExecutionStats = subscriptionTracker.getReqExecutionStats(subscriptionId);
            subscriptionTracker.deleteReqTracking(subscriptionId);
            const { totalProcessingCostMsForIP, chargedProcessingCostMs, isNewlyBlocked, blockedUntil } = await addProcessingCostForIP(ip, processingCostMs);
            if (reqExecutionStats) recordReqExecutionStats(reqExecutionStats, processingCostMs);
            const validation = dualRunValidations.get(subscriptionId);
            if (validation) validation.authoritativeProcessingCostMs = processingCostMs;

            log("INFO", withTiming({ msg: "EOSE", ip, port, resultType, socketId, subscriptionId, processingCostMs, chargedProcessingCostMs, totalProcessingCostMsForIP, activeSubscriptionCountForSocket: subscriptionTracker.getActiveSubscriptionCount(), activeSubscriptionCountForIP: getActiveSubscriptionCountForIP(ip), ...(reqExecutionStats ? { reqShape: reqExecutionStats.shape, reqAnalysisSignature: reqExecutionStats.analysis.signature, reqCandidatePlans: reqExecutionStats.analysis.candidatePlans, reqMode: reqExecutionStats.mode, upstreamEventCount: reqExecutionStats.upstreamEventCount, downstreamEventCount: reqExecutionStats.downstreamEventCount } : {}), ...(typeof blockedUntil === "number" ? { processingCostBlockedUntil: new Date(blockedUntil).toISOString() } : {}) }));
            finalizeDualRunValidation(subscriptionId);

            if (singleReqProcessingCostWarnThresholdMs > 0 && processingCostMs >= singleReqProcessingCostWarnThresholdMs) {
              log("WARN", withTiming({ msg: "HEAVY SINGLE REQ", ip, port, socketId, subscriptionId, processingCostMs, singleReqProcessingCostWarnThresholdMs, totalProcessingCostMsForIP, req: reqPayload, ...(reqExecutionStats ? { reqShape: reqExecutionStats.shape, reqAnalysisSignature: reqExecutionStats.analysis.signature, reqCandidatePlans: reqExecutionStats.analysis.candidatePlans, reqFilters: reqExecutionStats.analysis.filters, reqMode: reqExecutionStats.mode, upstreamEventCount: reqExecutionStats.upstreamEventCount, downstreamEventCount: reqExecutionStats.downstreamEventCount } : {}), trackedReqsForSocket: subscriptionTracker.getTrackedReqsForSocket() }));
            }

            if (!isWhitelistedClientIP && isNewlyBlocked) {
              if (typeof blockedUntil === "number") {
                await scheduleProcessingCostUnblock(ip, blockedUntil, handleProcessingCostUnblock);
              }
              log("WARN", withTiming({ msg: "IP PROCESSING COST BLOCKED", ip, port, socketId, subscriptionId, processingCostMs, chargedProcessingCostMs, totalProcessingCostMsForIP, processingCostBlockThresholdMs, req: reqPayload, ...(reqExecutionStats ? { reqShape: reqExecutionStats.shape, reqAnalysisSignature: reqExecutionStats.analysis.signature, reqCandidatePlans: reqExecutionStats.analysis.candidatePlans, reqFilters: reqExecutionStats.analysis.filters, reqMode: reqExecutionStats.mode, upstreamEventCount: reqExecutionStats.upstreamEventCount, downstreamEventCount: reqExecutionStats.downstreamEventCount } : {}), trackedReqsForSocket: subscriptionTracker.getTrackedReqsForSocket(), ...(typeof blockedUntil === "number" ? { processingCostBlockedUntil: new Date(blockedUntil).toISOString() } : {}) }));
              const blockedMessage = JSON.stringify(["NOTICE", "blocked: Blocked by accumulated processing cost"]);
              const sockets = await getSocketsForIP(ip);
              for (const socket of sockets) {
                socket.send(blockedMessage);
                socket.close(1008, "Forbidden");
              }
            }
          } else {
            log("INFO", withTiming({ msg: "EOSE", ip, port, resultType, socketId, subscriptionId, activeSubscriptionCountForSocket: subscriptionTracker.getActiveSubscriptionCount(), activeSubscriptionCountForIP: getActiveSubscriptionCountForIP(ip) }));
          }
        } else if (resultType === "INVALID") {
          shouldRelay = false;
          because = result[1];
        } else {
          const subscriptionId = result[1];
          const primarySubscriptionId = dualRunShadowToPrimary.get(subscriptionId);
          if (primarySubscriptionId && resultType === "EVENT") {
            const validation = dualRunValidations.get(primarySubscriptionId);
            if (validation) {
              validation.shadowUpstreamEventCount += 1;
              if (shouldRelayRewrittenEvent(subscriptionTracker.getReqPayload(primarySubscriptionId), result[2]) && typeof result[2]?.id === "string") {
                validation.shadowEventIds.add(result[2].id);
              }
            }
            return;
          }
          const reqExecutionStats = subscriptionTracker.getReqExecutionStats(subscriptionId);
          if (resultType === "EVENT" && reqExecutionStats?.mode === "strip_p_e_tags") {
            shouldRelay = shouldRelay && shouldRelayRewrittenEvent(subscriptionTracker.getReqPayload(subscriptionId), result[2]);
            if (!shouldRelay && because === "") because = "Locally filtered rewritten REQ tags";
          }
          if (resultType === "EVENT") subscriptionTracker.recordUpstreamEvent(subscriptionId, shouldRelay);
          if (resultType === "EVENT") {
            const validation = dualRunValidations.get(subscriptionId);
            if (validation) {
              validation.authoritativeUpstreamEventCount += 1;
              if (shouldRelay && typeof result[2]?.id === "string") validation.authoritativeEventIds.add(result[2].id);
            }
          }
          const subscriptionSize = await subscriptionTracker.addTransferredSize(subscriptionId, message.length);
          log("DEBUG", withTiming({ msg: "SUBSCRIBE", ip, port, resultType, socketId, subscriptionId, subscriptionSize }));
        }

        if (shouldRelay) {
          downstreamSocket.send(message);
        } else {
          log("DEBUG", withTiming({ msg: "EVENT MUTED", because, ip, port, socketId, event }));
        }
      });
    }

    connectUpstream();
    setIdleTimeout(downstreamSocket);

    if (!isWhitelistedClientIP && cidrRanges.some((cidr) => ipMatchesCidr(ip, cidr))) {
      sendBlockedNoticeAndClose("Blocked by CIDR filter", 1008, "Forbidden");
      return;
    }

    const connectionAttempt = await getConnectionAttemptState(ip);
    if (!isWhitelistedClientIP && connectionAttempt.isProcessingCostBlocked) {
      sendBlockedNoticeAndClose(
        "Blocked by accumulated processing cost",
        1008,
        "Forbidden",
        {
          connectionCountForIP: connectionAttempt.connectionCountForIP,
          totalProcessingCostMsForIP: connectionAttempt.totalProcessingCostMsForIP,
          processingCostBlockThresholdMs,
          processingCostBlockedUntil: connectionAttempt.processingCostBlockedUntil,
        },
        connectionAttempt.processingCostBlockedUntil,
      );
      return;
    }

    if (!isWhitelistedClientIP && connectionAttempt.isRuleBlocked) {
      sendBlockedNoticeAndClose(
        connectionAttempt.ruleBlockedReason ?? "Blocked by repeated blocked requests",
        1008,
        "Forbidden",
        {
          connectionCountForIP: connectionAttempt.connectionCountForIP,
          ruleBlockedUntil: connectionAttempt.ruleBlockedUntil,
        },
        connectionAttempt.ruleBlockedUntil,
      );
      return;
    }

    if (!isWhitelistedClientIP && connectionAttempt.connectionCountForIP > 100) {
      sendBlockedNoticeAndClose("Blocked by too many connections", 1008, "Too many requests.", {
        connectionCountForIP: connectionAttempt.connectionCountForIP,
      });
      return;
    }

    const connectionCountForIP = await acceptConnection(ip, downstreamSocket);
    const reconnectAttemptCount = await recordReconnectAttempt(ip);
    if (!isWhitelistedClientIP && reconnectBanThreshold > 0 && reconnectAttemptCount >= reconnectBanThreshold) {
      const because = `Blocked by repeated reconnects (${reconnectAttemptCount}/${reconnectBanThreshold} in ${reconnectBanWindowSec}s)`;
      const { blockedUntil, isNewlyBlocked } = await blockIPByRule(ip, because, reconnectBanDurationSec);
      await scheduleRuleUnblock(ip, blockedUntil, handleRuleUnblock);
      if (isNewlyBlocked) {
        log("WARN", withTiming({ msg: "IP RULE BLOCKED", because, ip, port, socketId, reconnectAttemptCount, reconnectBanThreshold, reconnectBanWindowSec, reconnectBanDurationSec, ruleBlockedUntil: new Date(blockedUntil).toISOString() }));
        const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
        const sockets = await getSocketsForIP(ip);
        for (const socket of sockets) {
          if (socket === downstreamSocket) continue;
          socket.send(blockedMessage);
          socket.close(1008, "Forbidden");
        }
      }
      sendBlockedNoticeAndClose(because, 1008, "Forbidden", { connectionCountForIP, reconnectAttemptCount, reconnectBanThreshold, reconnectBanWindowSec, reconnectBanDurationSec }, blockedUntil);
      return;
    }
    log("INFO", withTiming({ msg: "CONNECTED", ip, port, socketId, connectionCountForIP, headers: req.headers }));

    async function handleDownstreamMessage(data: WebSocket.RawData): Promise<void> {
      if (isSocketTerminating) return;
      resetIdleTimeout(downstreamSocket);
      resetIdleTimeout(upstreamSocket);

      const message = data.toString();
      let event: any[];
      try {
        event = JSON.parse(message);
      } catch (err: any) {
        event = ["INVALID", err.message ?? JSON.stringify(err)];
      }

      let shouldRelay = true;
      let because = "";
      let isMessageEdited = false;
      let shadowMessage: string | undefined;

      if (event[0] === "EVENT") {
        const decision = evaluateDownstreamEvent(event);
        shouldRelay = decision.shouldRelay;
        because = decision.because;

        if (!shouldRelay && because.startsWith("Blocked event by blocked kind:")) {
          if (!beginSocketTermination()) return;
          const { blockedUntil, isNewlyBlocked } = await blockIPByRule(ip, because);
          await scheduleRuleUnblock(ip, blockedUntil, handleRuleUnblock);
          const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
          if (isNewlyBlocked) {
            log("WARN", withTiming({ msg: "IP RULE BLOCKED", because, ip, port, socketId, blockedActionBanDurationSec, ruleBlockedUntil: new Date(blockedUntil).toISOString(), event: event[1] }));
            const sockets = await getSocketsForIP(ip);
            for (const socket of sockets) {
              if (socket === downstreamSocket) continue;
              socket.send(blockedMessage);
              socket.close(1008, "Forbidden");
            }
          }
          downstreamSocket.send(blockedMessage);
          downstreamSocket.close(1008, "Forbidden");
          upstreamSocket.close();
          return;
        }

        const msg = shouldRelay ? "EVENT" : "EVENT BLOCKED";
        log("INFO", withTiming({ msg, ...(shouldRelay ? {} : { because }), ip, port, socketId, connectionCountForIP, event: event[1] }));
      } else if (event[0] === "REQ") {
        const subscriptionId = event[1];
        const reqPayload = structuredClone(event.length === 3 ? event[2] : event.slice(2));
        const reqFilter = event[2];
        const isNewSubscription = !subscriptionTracker.hasActiveSubscription(subscriptionId);
        const activeSubscriptionCount = subscriptionTracker.getActiveSubscriptionCount();
        if (!isWhitelistedClientIP && isNewSubscription && activeSubscriptionCount >= maxConcurrentReqsPerSocket) {
          if (!beginSocketTermination()) return;
          shouldRelay = false;
          because = "Blocked by too many concurrent REQs";
          const concurrentReqViolationCount = await recordConcurrentReqViolation(ip);
          const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
          log("WARN", withTiming({ msg: "REQ BLOCKED", because, ip, port, socketId, connectionCountForIP, subscriptionId, activeSubscriptionCount, maxConcurrentReqsPerSocket, concurrentReqViolationCount, concurrentReqBanThreshold, req: reqFilter, blockedMessage }));
          if (concurrentReqViolationCount >= concurrentReqBanThreshold) {
            const ruleBlockReason = `Blocked by repeated too many concurrent REQs (${concurrentReqViolationCount}/${concurrentReqBanThreshold})`;
            const { blockedUntil, isNewlyBlocked } = await blockIPByRule(ip, ruleBlockReason, concurrentReqBanDurationSec);
            await scheduleRuleUnblock(ip, blockedUntil, handleRuleUnblock);
            if (isNewlyBlocked) log("WARN", withTiming({ msg: "IP RULE BLOCKED", because: ruleBlockReason, ip, port, socketId, concurrentReqViolationCount, concurrentReqBanThreshold, concurrentReqBanDurationSec, ruleBlockedUntil: new Date(blockedUntil).toISOString(), subscriptionId, activeSubscriptionCount, maxConcurrentReqsPerSocket, req: reqFilter }));
          }
          downstreamSocket.send(blockedMessage);
          downstreamSocket.close(1008, "Too many concurrent REQs");
          upstreamSocket.close();
          return;
        }
        const rewritePlan = planReqRewrite(event);
        subscriptionTracker.trackReq(subscriptionId, reqPayload, rewritePlan.mode);
        const reqExecutionStats = subscriptionTracker.getReqExecutionStats(subscriptionId);
        const reqPlanRecommendation = reqExecutionStats ? getReqPlanRecommendation(reqExecutionStats.analysis) : undefined;
        const reqPlanExperimentCandidate = reqPlanRecommendation ? getReqPlanExperimentCandidate(reqPlanRecommendation) : undefined;
        const shouldDualRunReq = shouldStartDualRun(reqExecutionStats, reqPlanExperimentCandidate);
        if (shouldDualRunReq && rewritePlan.isMessageEdited) {
          const shadowMode = reqPlanExperimentCandidate?.challengerMode === "split_authors" ? "split_authors" : "strip_p_e_tags";
          subscriptionTracker.trackReq(subscriptionId, reqPayload, "passthrough");
          const shadowSubscriptionId = getDualRunShadowSubscriptionId(subscriptionId, shadowMode);
          const shadowEvent = [event[0], shadowSubscriptionId, ...rewritePlan.rewrittenEvent.slice(2)];
          shadowMessage = JSON.stringify(shadowEvent);
          dualRunShadowToPrimary.set(shadowSubscriptionId, subscriptionId);
          dualRunValidations.set(subscriptionId, {
            shadowSubscriptionId,
            shadowMode,
            authoritativeEventIds: new Set(),
            shadowEventIds: new Set(),
            authoritativeUpstreamEventCount: 0,
            shadowUpstreamEventCount: 0,
          });
          subscriptionTracker.trackReq(shadowSubscriptionId, reqPayload, shadowMode);
          log("INFO", withTiming({ msg: "REQ DUAL RUN START", ip, port, socketId, connectionCountForIP, subscriptionId, shadowSubscriptionId, authoritativeMode: "passthrough", shadowMode, originalReq: reqPayload, shadowReq: shadowEvent.slice(2), recommendationBasis: reqPlanRecommendation?.basis, experimentReason: reqPlanExperimentCandidate?.reason }));
        } else {
          event = rewritePlan.rewrittenEvent;
          isMessageEdited = isMessageEdited || rewritePlan.isMessageEdited;
        }
        if (reqPlanRecommendation) {
          log(
            "DEBUG",
            withTiming({
              msg: "REQ PLAN CHOSEN",
              ip,
              port,
              socketId,
              connectionCountForIP,
              subscriptionId,
              chosenMode: shouldDualRunReq ? "passthrough" : rewritePlan.mode,
              recommendedMode: reqPlanRecommendation.recommendedMode,
              recommendationBasis: reqPlanRecommendation.basis,
              reqShape: reqExecutionStats?.shape,
              reqShapeCounts: reqExecutionStats
                ? {
                    filterCount: reqExecutionStats.shape.filterCount,
                    kinds: reqExecutionStats.shape.kinds,
                    idsCount: reqExecutionStats.shape.idsCount,
                    authorsCount: reqExecutionStats.shape.authorsCount,
                    pTagCount: reqExecutionStats.shape.pTagCount,
                    eTagCount: reqExecutionStats.shape.eTagCount,
                    totalTagValueCount: reqExecutionStats.shape.totalTagValueCount,
                  }
                : undefined,
              reqAnalysisSignature: reqPlanRecommendation.signature,
              reqCandidatePlans: reqPlanRecommendation.consideredModes,
              reqActiveRewriteModes: reqExecutionStats?.analysis.activeRewriteModes ?? [],
              reqPlanStatsByMode: reqPlanRecommendation.statsByMode,
              reqPlanHeuristic: reqPlanRecommendation.heuristic,
            }),
          );
        }
        if (reqPlanExperimentCandidate?.shouldExperiment) {
          log("DEBUG", withTiming({ msg: "REQ PLAN EXPERIMENT CANDIDATE", ip, port, socketId, connectionCountForIP, subscriptionId, chosenMode: rewritePlan.mode, recommendedMode: reqPlanExperimentCandidate.recommendedMode, challengerMode: reqPlanExperimentCandidate.challengerMode, reason: reqPlanExperimentCandidate.reason, sampleCountByMode: reqPlanExperimentCandidate.sampleCountByMode, costDeltaMs: reqPlanExperimentCandidate.costDeltaMs, reqAnalysisSignature: reqPlanRecommendation?.signature }));
        }
        if (rewritePlan.mode !== "passthrough") {
          log("INFO", withTiming({ msg: "REQ REWRITTEN", ip, port, socketId, connectionCountForIP, subscriptionId, mode: rewritePlan.mode, originalReq: reqPayload, rewrittenReq: event.length === 3 ? event[2] : event.slice(2), ...(reqExecutionStats ? { reqShape: reqExecutionStats.shape, reqAnalysisSignature: reqExecutionStats.analysis.signature, reqCandidatePlans: reqExecutionStats.analysis.candidatePlans, reqFilters: reqExecutionStats.analysis.filters } : {}) }));
        }
        if (reqFilter.limit && reqFilter.limit > 500) {
          reqFilter.limit = 500;
          isMessageEdited = true;
          if (typeof event[2] === "object" && event[2] !== null && !Array.isArray(event[2])) (event[2] as Record<string, unknown>).limit = 500;
          const reqExecutionStats = subscriptionTracker.getReqExecutionStats(subscriptionId);
          subscriptionTracker.trackReq(subscriptionId, reqFilter, reqExecutionStats?.mode ?? "passthrough");
        }
      } else if (event[0] === "CLOSE") {
        const subscriptionId = event[1];
        const shadowSubscriptionId = dualRunValidations.get(subscriptionId)?.shadowSubscriptionId;
        if (shadowSubscriptionId && dualRunShadowToPrimary.has(shadowSubscriptionId)) {
          dualRunShadowToPrimary.delete(shadowSubscriptionId);
          dualRunValidations.delete(subscriptionId);
          subscriptionTracker.forgetSubscription(shadowSubscriptionId);
          if (upstreamSocket.readyState === WebSocket.OPEN) upstreamSocket.send(JSON.stringify(["CLOSE", shadowSubscriptionId]));
        }
        subscriptionTracker.forgetSubscription(subscriptionId);
        log("DEBUG", withTiming({ msg: "CLOSE SUBSCRIPTION", ip, port, socketId, connectionCountForIP, subscriptionId, req: event[2], subscriptionSize: subscriptionTracker.getTransferredSize(subscriptionId) }));
      } else {
        log("DEBUG", withTiming({ msg: "UNKNOWN", ip, port, socketId, connectionCountForIP, message: event }));
        if (event[0] === "INVALID") {
          shouldRelay = false;
          because = event[1];
        }
      }

      if (shouldRelay) {
        let isMessageSent = false;
        let isWebSocketClosed = false;
        let retryCount = 0;

        function sendMessage(): boolean {
          let msg = message;
          if (isMessageEdited) msg = JSON.stringify(event);

          if (event[0] === "EVENT") upstreamWriteSocket.send(msg);

          if (upstreamSocket.readyState === WebSocket.OPEN) {
            upstreamSocket.send(msg);
            if (shadowMessage) upstreamSocket.send(shadowMessage);
            isMessageSent = true;
            if (retryCount > 0) {
              log("DEBUG", withTiming({ msg: "RETRY SUCCEEDED", ip, port, socketId, connectionCountForIP, retryCount }));
            }
            return false;
          }

          if (upstreamSocket.readyState === WebSocket.CONNECTING) {
            retryCount++;
            return true;
          }

          isWebSocketClosed = true;
          upstreamSocket.close();
          downstreamSocket.close();
          log("DEBUG", withTiming({ msg: "RETRY DISCONTINUED", ip, port, socketId, connectionCountForIP, retryCount }));
          return false;
        }

        if (sendMessage()) {
          const intervalId = setInterval(() => {
            if (!sendMessage()) clearInterval(intervalId);
          }, 0.5 * 1000);

          setTimeout(() => {
            if (isMessageSent || isWebSocketClosed) return;
            clearInterval(intervalId);
            upstreamSocket.close();
            downstreamSocket.close();
            log("DEBUG", withTiming({ msg: "RETRY TIMEOUT", ip, port, socketId, connectionCountForIP, retryCount }));
          }, 30 * 1000);
        }
      } else {
        if (event[0] === "EVENT") {
          const blockedMessage = JSON.stringify(["OK", event[1].id, false, `blocked: ${because}`]);
          log("DEBUG", withTiming({ msg: "BLOCKED EVENT", ip, port, socketId, connectionCountForIP, blockedMessage, event }));
          downstreamSocket.send(blockedMessage);
        } else {
          const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
          log("DEBUG", withTiming({ msg: "BLOCKED NOTICE", ip, port, socketId, connectionCountForIP, blockedMessage, event }));
          downstreamSocket.send(blockedMessage);
        }
        downstreamSocket.close();
      }
    }

    downstreamSocket.on("message", (data) => {
      downstreamMessageQueue = downstreamMessageQueue
        .then(async () => {
          await handleDownstreamMessage(data);
        })
        .catch(async (error: Error) => {
          log("WARN", withTiming({ msg: "DOWNSTREAM MESSAGE ERROR", ip, port, socketId, connectionCountForIP, error }));
          if (!isSocketTerminating) {
            isSocketTerminating = true;
            downstreamSocket.close();
            upstreamSocket.close();
          }
        });
    });

    downstreamSocket.on("close", async () => {
      unregisterSubscriptionTracker(ip, socketId);
      const releaseState = await releaseConnection(ip, downstreamSocket);
      log("DEBUG", withTiming({ msg: "DISCONNECTED", ip, port, socketId, connectionCountForIP: releaseState.connectionCountForIP }));
      if (releaseState.shouldResetIPState || (releaseState.connectionCountForIP - 1 <= 0 && releaseState.isProcessingCostBlocked)) {
        log("INFO", withTiming({ msg: "IP PROCESSING COST SUMMARY", ip, socketId, totalProcessingCostMsForIP: releaseState.totalProcessingCostMsForIP, ...(releaseState.isProcessingCostBlocked ? { resetPendingUntilUnblock: true } : {}) }));
      }
      upstreamSocket.close();
      clearIdleTimeout(downstreamSocket);
    });

    downstreamSocket.on("error", async (error: Error) => {
      log("WARN", withTiming({ msg: "DOWNSTREAM ERROR", ip, port, socketId, connectionCountForIP, error }));
      downstreamSocket.close();
      upstreamSocket.close();
    });
  });

  server.listen(listenPort);
}

async function start(): Promise<void> {
  await refreshReqSplitAuthorsPolicy();
  listen();
}

start().catch((error: Error) => {
  log("ERROR", { msg: "STARTUP FAILED", error });
  process.exit(1);
});
