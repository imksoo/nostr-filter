import fs from "fs";
import http from "http";
import path from "path";
import url from "url";
import * as mime from "mime-types";
import { v7 as uuidv7 } from "uuid";
import WebSocket from "ws";
import { blockedActionBanDurationSec, blockedReqKinds, cidrRanges, enableForwardReqHeaders, listenPort, logStartupConfig, maxConcurrentReqsPerSocket, maxTrackedReqsPerSocket, maxWebsocketPayloadSize, processingCostBlockDurationSec, processingCostBlockThresholdMs, singleReqProcessingCostWarnThresholdMs, upstreamHttpUrl, upstreamWsForFastBotUrl, upstreamWsUrl } from "./config";
import { evaluateDownstreamEvent, evaluateUpstreamEvent, ipMatchesCidr } from "./filters";
import { log } from "./logger";
import { buildForwardHeaders, clearIdleTimeout, getClientAddress, resetIdleTimeout, setIdleTimeout } from "./network";
import { acceptConnection, addProcessingCostForIP, blockIPByRule, getConnectionAttemptState, getConnectionCount, getSocketsForIP, releaseConnection, scheduleProcessingCostUnblock, scheduleRuleUnblock, unblockIPByProcessingCost, unblockIPByRule } from "./processing-state";
import { createSubscriptionTracker } from "./subscriptions";

let upstreamWriteSocket = new WebSocket(upstreamWsForFastBotUrl);
const blockedConnectLogUntilByIP = new Map<string, number>();

logStartupConfig();

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
    const wsClientOptions = enableForwardReqHeaders ? { headers: buildForwardHeaders(req, clientAddress) } : undefined;
    const upstreamSocket = new WebSocket(upstreamWsUrl, wsClientOptions);

    function beginSocketTermination(): boolean {
      if (isSocketTerminating) return false;
      isSocketTerminating = true;
      return true;
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
      upstreamSocket.close();
      downstreamSocket.send(blockedMessage);
      downstreamSocket.close(closeCode, closeReason);
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
        log("WARN", withTiming({ msg: "UPSTREAM ERROR", socketId, error }));
        downstreamSocket.close();
        upstreamSocket.close();
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
          const reqStartedAt = subscriptionTracker.getReqStartedAt(subscriptionId);
          const processingCostMs = typeof reqStartedAt === "number" ? Date.now() - reqStartedAt : undefined;

          if (typeof processingCostMs === "number") {
            const reqPayload = subscriptionTracker.getReqPayload(subscriptionId);
            subscriptionTracker.deleteReqTracking(subscriptionId);
            const { totalProcessingCostMsForIP, isNewlyBlocked, blockedUntil } = await addProcessingCostForIP(ip, processingCostMs);

            log("INFO", withTiming({ msg: "EOSE", ip, port, resultType, socketId, subscriptionId, processingCostMs, totalProcessingCostMsForIP, ...(typeof blockedUntil === "number" ? { processingCostBlockedUntil: new Date(blockedUntil).toISOString() } : {}) }));

            if (singleReqProcessingCostWarnThresholdMs > 0 && processingCostMs >= singleReqProcessingCostWarnThresholdMs) {
              log("WARN", withTiming({ msg: "HEAVY SINGLE REQ", ip, port, socketId, subscriptionId, processingCostMs, singleReqProcessingCostWarnThresholdMs, totalProcessingCostMsForIP, req: reqPayload, trackedReqsForSocket: subscriptionTracker.getTrackedReqsForSocket() }));
            }

            if (isNewlyBlocked) {
              if (typeof blockedUntil === "number") {
                await scheduleProcessingCostUnblock(ip, blockedUntil, handleProcessingCostUnblock);
              }
              log("WARN", withTiming({ msg: "IP PROCESSING COST BLOCKED", ip, port, socketId, subscriptionId, processingCostMs, totalProcessingCostMsForIP, processingCostBlockThresholdMs, req: reqPayload, trackedReqsForSocket: subscriptionTracker.getTrackedReqsForSocket(), ...(typeof blockedUntil === "number" ? { processingCostBlockedUntil: new Date(blockedUntil).toISOString() } : {}) }));
              const blockedMessage = JSON.stringify(["NOTICE", "blocked: Blocked by accumulated processing cost"]);
              const sockets = await getSocketsForIP(ip);
              for (const socket of sockets) {
                socket.send(blockedMessage);
                socket.close(1008, "Forbidden");
              }
            }
          } else {
            log("INFO", withTiming({ msg: "EOSE", ip, port, resultType, socketId, subscriptionId }));
          }
        } else if (resultType === "INVALID") {
          shouldRelay = false;
          because = result[1];
        } else {
          const subscriptionId = result[1];
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

    if (cidrRanges.some((cidr) => ipMatchesCidr(ip, cidr))) {
      sendBlockedNoticeAndClose("Blocked by CIDR filter", 1008, "Forbidden");
      return;
    }

    const connectionAttempt = await getConnectionAttemptState(ip);
    if (connectionAttempt.isProcessingCostBlocked) {
      sendBlockedNoticeAndClose("Blocked by accumulated processing cost", 1008, "Forbidden", {
        connectionCountForIP: connectionAttempt.connectionCountForIP,
        totalProcessingCostMsForIP: connectionAttempt.totalProcessingCostMsForIP,
        processingCostBlockThresholdMs,
        processingCostBlockedUntil: connectionAttempt.processingCostBlockedUntil,
      }, connectionAttempt.processingCostBlockedUntil);
      return;
    }

    if (connectionAttempt.isRuleBlocked) {
      sendBlockedNoticeAndClose(connectionAttempt.ruleBlockedReason ?? "Blocked by repeated blocked requests", 1008, "Forbidden", {
        connectionCountForIP: connectionAttempt.connectionCountForIP,
        ruleBlockedUntil: connectionAttempt.ruleBlockedUntil,
      }, connectionAttempt.ruleBlockedUntil);
      return;
    }

    if (connectionAttempt.connectionCountForIP > 100) {
      sendBlockedNoticeAndClose("Blocked by too many connections", 1008, "Too many requests.", {
        connectionCountForIP: connectionAttempt.connectionCountForIP,
      });
      return;
    }

    const connectionCountForIP = await acceptConnection(ip, downstreamSocket);
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
        const reqFilter = event[2];
        const reqKinds = Array.isArray(reqFilter?.kinds) ? reqFilter.kinds.filter((kind: unknown): kind is number => typeof kind === "number") : [];
        const blockedReqKind = reqKinds.find((kind: number) => blockedReqKinds.includes(kind));
        if (typeof blockedReqKind === "number") {
          if (!beginSocketTermination()) return;
          shouldRelay = false;
          because = `Blocked by blocked REQ kind: ${blockedReqKind}`;
          const { blockedUntil, isNewlyBlocked } = await blockIPByRule(ip, because);
          await scheduleRuleUnblock(ip, blockedUntil, handleRuleUnblock);
          const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
          log("WARN", withTiming({ msg: "REQ BLOCKED", because, ip, port, socketId, connectionCountForIP, subscriptionId, blockedReqKind, blockedReqKinds, req: reqFilter, blockedMessage }));
          if (isNewlyBlocked) {
            log("WARN", withTiming({ msg: "IP RULE BLOCKED", because, ip, port, socketId, blockedActionBanDurationSec, ruleBlockedUntil: new Date(blockedUntil).toISOString(), subscriptionId, blockedReqKind, req: reqFilter }));
          }
          downstreamSocket.send(blockedMessage);
          downstreamSocket.close(1008, "Blocked REQ kind");
          upstreamSocket.close();
          return;
        }
        const isNewSubscription = !subscriptionTracker.hasActiveSubscription(subscriptionId);
        const activeSubscriptionCount = subscriptionTracker.getActiveSubscriptionCount();
        if (isNewSubscription && activeSubscriptionCount >= maxConcurrentReqsPerSocket) {
          if (!beginSocketTermination()) return;
          shouldRelay = false;
          because = "Blocked by too many concurrent REQs";
          const blockedMessage = JSON.stringify(["NOTICE", `blocked: ${because}`]);
          log("WARN", withTiming({ msg: "REQ BLOCKED", because, ip, port, socketId, connectionCountForIP, subscriptionId, activeSubscriptionCount, maxConcurrentReqsPerSocket, req: reqFilter, blockedMessage }));
          downstreamSocket.send(blockedMessage);
          downstreamSocket.close(1008, "Too many concurrent REQs");
          upstreamSocket.close();
          return;
        }
        subscriptionTracker.trackReq(subscriptionId, reqFilter);
        if (reqFilter.limit && reqFilter.limit > 500) {
          reqFilter.limit = 500;
          isMessageEdited = true;
          subscriptionTracker.trackReq(subscriptionId, reqFilter);
        }
      } else if (event[0] === "CLOSE") {
        const subscriptionId = event[1];
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

listen();
