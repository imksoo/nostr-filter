import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import url from "url";
import * as net from "net";
import { Mutex } from "async-mutex";
import { v7 as uuidv7 } from "uuid";
import * as mime from "mime-types";
import dotenv from "dotenv";

dotenv.config();
const NODE_ENV = process.env.NODE_ENV || "production";
if (NODE_ENV === "production") {
  // Suppress log and debug messages from console. console.info, console.warn, and console.error are still available in production mode
  console.log = (...data) => {

  };
  console.debug = (...data) => {

  };
}
const listenPort: number = parseInt(process.env.LISTEN_PORT ?? "8081"); // クライアントからのWebSocket待ち受けポート
const upstreamHttpUrl: string = process.env.UPSTREAM_HTTP_URL ??
  "http://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsUrl: string = process.env.UPSTREAM_WS_URL ??
  "ws://localhost:8080"; // 上流のWebSocketサーバのURL
const upstreamWsForFastBotUrl: string = process.env.UPSTREAM_WS_FOR_FAST_BOT_URL ??
  "ws://localhost:8080"; // 上流のWebSocketサーバのURL

// 書き込み用の上流リレーとの接続(あらかじめ接続しておいて、WS接続直後のイベントでも取りこぼしを防ぐため)
let upstreamWriteSocket = new WebSocket(upstreamWsForFastBotUrl);

// NostrのEvent contentsのフィルタリング用正規表現パターンの配列
const contentFilters: RegExp[] = Object.keys(process.env)
  .filter(key => key.startsWith('MUTE_FILTER_'))
  .map(key => {
    const pattern = process.env[key]!;
    const match = pattern.match(/^\/(.+)\/([gimy]*)$/);
    if (!match) {
      return new RegExp(pattern);
    } else {
      return new RegExp(match[1], match[2]);
    }
  });

console.info(JSON.stringify({ msg: "process.env", ...process.env }));

// ブロックするユーザーの公開鍵の配列
const blockedPubkeys: string[] =
  (typeof process.env.BLOCKED_PUBKEYS !== "undefined" && process.env.BLOCKED_PUBKEYS !== "")
    ? process.env.BLOCKED_PUBKEYS.split(",").map((pubkey) => pubkey.trim())
    : [];
// Allow only whitelisted pubkey to write events
const whitelistedPubkeys: string[] =
  (typeof process.env.WHITELISTED_PUBKEYS !== "undefined" &&
    process.env.WHITELISTED_PUBKEYS !== "")
    ? process.env.WHITELISTED_PUBKEYS.split(",").map((pubkey) => pubkey.trim())
    : [];
// Filter proxy events
const filterProxyEvents = process.env.FILTER_PROXY_EVENTS === "true";
// Forward request headers to upstream
const enableForwardReqHeaders = process.env.ENABLE_FORWARD_REQ_HEADERS === "true";
// Set maximum websocket server payload size (maximum allowed message size) in bytes
const maxWebsocketPayloadSize: number = parseInt(process.env.MAX_WEBSOCKET_PAYLOAD_SIZE ?? "1000000");

// クライアントIPアドレスのCIDRフィルタ
const cidrRanges: string[] = Object.keys(process.env)
  .filter(key => key.startsWith('BLOCKED_IP_ADDR_'))
  .map(key => (process.env[key]!));

// CIDRマッチ用のフィルタ関数
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);

  if (net.isIPv4(ip) && net.isIPv4(range)) {
    const ipNum = ip
      .split(".")
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
    const rangeNum = range
      .split(".")
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);

    return (ipNum & mask) === (rangeNum & mask);
  } else if (net.isIPv6(ip) && net.isIPv6(range)) {
    const ipNum = BigInt(`0x${ip.replace(/:/g, "")}`);
    const rangeNum = BigInt(`0x${range.replace(/:/g, "")}`);
    const mask6 = BigInt(
      `0x${"f".repeat(32 - parseInt(bits, 10))}${"0".repeat(
        parseInt(bits, 10),
      )
      }`,
    );

    return (ipNum & mask6) === (rangeNum & mask6);
  }

  return false;
}

console.info(
  JSON.stringify({
    msg: "configs",
    listenPort,
    upstreamHttpUrl,
    upstreamWsUrl,
    upstreamWsForFastBotUrl,
    contentFilters: contentFilters.map(regex => `/${regex.source}/${regex.flags}`),
    blockedIPAddresses: cidrRanges,
    processingCostBlockThresholdMs: parseInt(
      process.env.PROCESSING_COST_BLOCK_THRESHOLD_MS ?? "0",
    ),
    processingCostBlockDurationSec: parseInt(
      process.env.PROCESSING_COST_BLOCK_DURATION_SEC ?? "600",
    ),
    maxTrackedReqsPerSocket: parseInt(
      process.env.MAX_TRACKED_REQS_PER_SOCKET ?? "100",
    ),
  }),
);

// 全体の接続数
let connectionCount = 0;
// IPアドレスごとの接続数
const connectionCountsByIP = new Map<string, number>();
// IPアドレスごとのREQ->EOSE累積処理コスト
const totalProcessingCostMsByIP = new Map<string, number>();
// 累積処理コスト超過で一時的にブロック中のIPアドレス
const blockedIPsByProcessingCost = new Set<string>();
// IPアドレスごとの処理コストブロック解除予定時刻
const processingCostBlockedUntilByIP = new Map<string, number>();
// IPアドレスごとの処理コストブロック解除タイマー
const processingCostBlockTimeoutsByIP = new Map<string, NodeJS.Timeout>();
// IPアドレスごとのアクティブな下流ソケット
const activeSocketsByIP = new Map<string, Set<WebSocket>>();
// Mutexインスタンスを作成
const connectionCountMutex = new Mutex();
const processingCostBlockThresholdMs: number = parseInt(
  process.env.PROCESSING_COST_BLOCK_THRESHOLD_MS ?? "0",
);
const processingCostBlockDurationSec: number = parseInt(
  process.env.PROCESSING_COST_BLOCK_DURATION_SEC ?? "600",
);
const maxTrackedReqsPerSocket = parseInt(
  process.env.MAX_TRACKED_REQS_PER_SOCKET ?? "100",
);

type RelayDecision = {
  shouldRelay: boolean;
  because: string;
};

type ClientAddress = {
  ip: string;
  port: number;
};

type SubscriptionState = {
  ipAddresses: Map<string, string>;
  portNumbers: Map<string, number>;
  transferredSizes: Map<string, number>;
  reqStartedAt: Map<string, number>;
  reqPayloads: Map<string, unknown>;
};

function getClientAddress(req: http.IncomingMessage): ClientAddress {
  const ip =
    (typeof req.headers["cloudfront-viewer-address"] === "string"
      ? req.headers["cloudfront-viewer-address"]
        .split(":")
        .slice(0, -1)
        .join(":")
      : undefined) ||
    (typeof req.headers["x-real-ip"] === "string"
      ? req.headers["x-real-ip"]
      : undefined) ||
    (typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : undefined) ||
    (typeof req.socket.remoteAddress === "string"
      ? req.socket.remoteAddress
      : "unknown-ip-addr");
  const port =
    (typeof req.headers["cloudfront-viewer-address"] === "string"
      ? parseInt(
        req.headers["cloudfront-viewer-address"].split(":").slice(-1)[0],
      )
      : undefined) ||
    (typeof req.headers["x-real-port"] === "string"
      ? parseInt(req.headers["x-real-port"])
      : 0);
  return { ip, port };
}

function evaluateKind1Event(
  event: { content: string; pubkey: string; tags: string[][] },
  options: { filterProxyTags: boolean },
): RelayDecision {
  for (const filter of contentFilters) {
    if (filter.test(event.content)) {
      return { shouldRelay: false, because: "Blocked event by content filter" };
    }
  }

  for (const block of blockedPubkeys) {
    if (event.pubkey === block) {
      return { shouldRelay: false, because: "Blocked event by pubkey" };
    }
  }

  if (options.filterProxyTags) {
    for (const tag of event.tags) {
      if (tag[0] === "proxy") {
        return { shouldRelay: false, because: "Blocked event by proxied event" };
      }
    }
  }

  return { shouldRelay: true, because: "" };
}

function evaluateDownstreamEvent(event: any[]): RelayDecision {
  if (event[0] !== "EVENT") {
    return { shouldRelay: true, because: "" };
  }

  let decision: RelayDecision = { shouldRelay: true, because: "" };
  if (event[1].kind === 1) {
    decision = evaluateKind1Event(event[1], { filterProxyTags: filterProxyEvents });
  }

  if (decision.shouldRelay && whitelistedPubkeys.length > 0) {
    const isWhitelistPubkey = whitelistedPubkeys.includes(event[1].pubkey);
    if (!isWhitelistPubkey) {
      return {
        shouldRelay: false,
        because: "Only whitelisted pubkey can write events",
      };
    }
  }

  return decision;
}

function evaluateUpstreamEvent(event: any[]): RelayDecision {
  if (event[0] === "INVALID") {
    return { shouldRelay: false, because: event[1] };
  }
  if (event[0] === "EVENT" && event[2].kind === 1) {
    return evaluateKind1Event(event[2], { filterProxyTags: false });
  }
  return { shouldRelay: true, because: "" };
}

async function registerSocketForIP(
  ip: string,
  socket: WebSocket,
): Promise<void> {
  await connectionCountMutex.runExclusive(async () => {
    const sockets = activeSocketsByIP.get(ip) ?? new Set<WebSocket>();
    sockets.add(socket);
    activeSocketsByIP.set(ip, sockets);
  });
}

async function unregisterSocketForIP(
  ip: string,
  socket: WebSocket,
): Promise<void> {
  await connectionCountMutex.runExclusive(async () => {
    const sockets = activeSocketsByIP.get(ip);
    if (!sockets) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      activeSocketsByIP.delete(ip);
    }
  });
}

async function addProcessingCostForIP(
  ip: string,
  processingCostMs: number,
): Promise<{
  totalProcessingCostMsForIP: number;
  isNewlyBlocked: boolean;
  blockedUntil?: number;
}> {
  let totalProcessingCostMsForIP = 0;
  let isNewlyBlocked = false;
  let blockedUntil: number | undefined;
  await connectionCountMutex.runExclusive(async () => {
    totalProcessingCostMsForIP =
      (totalProcessingCostMsByIP.get(ip) ?? 0) + processingCostMs;
    totalProcessingCostMsByIP.set(ip, totalProcessingCostMsForIP);
    if (
      processingCostBlockThresholdMs > 0 &&
      totalProcessingCostMsForIP >= processingCostBlockThresholdMs &&
      !blockedIPsByProcessingCost.has(ip)
    ) {
      blockedIPsByProcessingCost.add(ip);
      blockedUntil = Date.now() + processingCostBlockDurationSec * 1000;
      processingCostBlockedUntilByIP.set(ip, blockedUntil);
      isNewlyBlocked = true;
    }
  });
  return { totalProcessingCostMsForIP, isNewlyBlocked, blockedUntil };
}

async function getSocketsForIP(ip: string): Promise<WebSocket[]> {
  let sockets: WebSocket[] = [];
  await connectionCountMutex.runExclusive(async () => {
    sockets = Array.from(activeSocketsByIP.get(ip) ?? []);
  });
  return sockets;
}

async function unblockIPByProcessingCost(ip: string): Promise<void> {
  let totalProcessingCostMsForIP = 0;
  let hadBlockedState = false;
  await connectionCountMutex.runExclusive(async () => {
    hadBlockedState = blockedIPsByProcessingCost.delete(ip);
    totalProcessingCostMsForIP = totalProcessingCostMsByIP.get(ip) ?? 0;
    totalProcessingCostMsByIP.delete(ip);
    processingCostBlockedUntilByIP.delete(ip);
    const timeoutId = processingCostBlockTimeoutsByIP.get(ip);
    if (timeoutId) {
      clearTimeout(timeoutId);
      processingCostBlockTimeoutsByIP.delete(ip);
    }
  });
  if (hadBlockedState) {
    console.info(
      JSON.stringify({
        msg: "IP PROCESSING COST UNBLOCKED",
        ip,
        totalProcessingCostMsForIP,
        processingCostBlockDurationSec,
        currentTime: new Date().toISOString(),
      }),
    );
  }
}

async function scheduleProcessingCostUnblock(
  ip: string,
  blockedUntil: number,
): Promise<void> {
  await connectionCountMutex.runExclusive(async () => {
    const currentTimeout = processingCostBlockTimeoutsByIP.get(ip);
    if (currentTimeout) {
      clearTimeout(currentTimeout);
    }
    const delayMs = Math.max(0, blockedUntil - Date.now());
    const timeoutId = setTimeout(() => {
      void unblockIPByProcessingCost(ip);
    }, delayMs);
    processingCostBlockTimeoutsByIP.set(ip, timeoutId);
  });
}

function loggingMemoryUsage(): void {
  const currentTime = new Date().toISOString();
  const memoryUsage = process.memoryUsage();
  const usedHeapSize = Math.round(memoryUsage.heapUsed / 1024 / 1024);
  const totalHeapSize = Math.round(memoryUsage.heapTotal / 1024 / 1024);
  const rssSize = Math.round(memoryUsage.rss / 1024 / 1024);
  console.debug(
    JSON.stringify({
      msg: "memoryUsage",
      currentTime,
      usedHeapSize,
      totalHeapSize,
      rssSize,
      connectionCount,
    }),
  );
}

loggingMemoryUsage(); // 起動時のヒープ状態を出力
setInterval(() => {
  loggingMemoryUsage();
}, 10 * 60 * 1000); // ヒープ状態を10分ごとに実行

function listen(): void {
  console.info(JSON.stringify({ msg: "Started", listenPort }));

  // HTTPサーバーの構成
  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === "/" && req.headers.accept !== "application/nostr+json") {
        // リレー自身のURLに通常のWebブラウザーからアクセスされたら、とりあえずindex.htmlへリダイレクトする
        console.log(JSON.stringify({ msg: "HTTP GET", url: req.url }));
        res.writeHead(301, { Location: "/index.html" });
        res.end();
      } else if (req.url && req.headers.accept !== "application/nostr+json") {
        // staticディレクトリ配下の静的ファイルを返却する
        console.log(JSON.stringify({ msg: "HTTP GET", url: req.url }));
        const pathname = url.parse(req.url).pathname || "";
        const filePath = path.join(__dirname, "/static/", pathname);
        const contentType = mime.contentType(path.extname(filePath)) ||
          "application/octet-stream";
        fs.readFile(filePath, (err, data) => {
          if (err) {
            console.warn(
              JSON.stringify({ msg: "HTTP RESOURCE NOT FOUND", url: req.url }),
            );
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("Please use a Nostr client to connect...\n");
          } else {
            console.log(
              JSON.stringify({
                msg: "HTTP RESPONSE",
                url: req.url,
                contentType,
                length: data.length,
              }),
            );
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
          }
        });
      } else {
        // Upgrade以外のリクエストとNIP-11を上流に転送する
        const proxyReq = http.request(
          upstreamHttpUrl,
          {
            method: req.method,
            headers: req.headers,
            path: req.url,
            agent: false,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        req.pipe(proxyReq);
      }
    },
  );
  // WebSocketサーバーの構成
  const wss = new WebSocket.Server({ server: server, maxPayload: maxWebsocketPayloadSize });
  wss.on(
    "connection",
    async (downstreamSocket: WebSocket, req: http.IncomingMessage) => {
      const subscriptionState: SubscriptionState = {
        ipAddresses: new Map<string, string>(),
        portNumbers: new Map<string, number>(),
        transferredSizes: new Map<string, number>(),
        reqStartedAt: new Map<string, number>(),
        reqPayloads: new Map<string, unknown>(),
      };
      // Mutexインスタンスを作成
      const subscriptionSizeMutex = new Mutex();

      // ソケットごとにユニークなIDを付与
      const socketId = uuidv7();
      const connectionStartTime = new Date();
      const connectionStartTimeISO = connectionStartTime.toISOString();
      const elapsedMs = (): number =>
        Date.now() - connectionStartTime.getTime();
      const withTiming = (
        payload: Record<string, unknown>,
        includeElapsed: boolean = true,
      ): Record<string, unknown> => ({
        ...payload,
        connectionStartTime: connectionStartTimeISO,
        ...(includeElapsed ? { elapsedMs: elapsedMs() } : {}),
      });

      function getSocketSubscriptionId(subscriptionId: string): string {
        return `${socketId}:${subscriptionId}`;
      }

      function rememberSubscription(subscriptionId: string): string {
        const socketAndSubscriptionId = getSocketSubscriptionId(subscriptionId);
        subscriptionState.ipAddresses.set(socketAndSubscriptionId, ip);
        subscriptionState.portNumbers.set(socketAndSubscriptionId, port);
        return socketAndSubscriptionId;
      }

      function forgetSubscription(subscriptionId: string): string {
        const socketAndSubscriptionId = getSocketSubscriptionId(subscriptionId);
        subscriptionState.reqStartedAt.delete(socketAndSubscriptionId);
        subscriptionState.reqPayloads.delete(socketAndSubscriptionId);
        return socketAndSubscriptionId;
      }

      function trackReq(subscriptionId: string, reqPayload: unknown): void {
        const socketAndSubscriptionId = rememberSubscription(subscriptionId);
        subscriptionState.reqStartedAt.set(socketAndSubscriptionId, Date.now());
        subscriptionState.reqPayloads.set(socketAndSubscriptionId, reqPayload);
        if (subscriptionState.reqPayloads.size > maxTrackedReqsPerSocket) {
          const oldestTrackedSubscriptionId =
            subscriptionState.reqPayloads.keys().next().value;
          if (oldestTrackedSubscriptionId) {
            subscriptionState.reqPayloads.delete(oldestTrackedSubscriptionId);
          }
        }
      }

      function getTrackedReqsForSocket(): Array<{ subscriptionId: string; req: unknown }> {
        return Array.from(subscriptionState.reqPayloads.entries())
          .filter(([trackedSocketAndSubscriptionId]) =>
            trackedSocketAndSubscriptionId.startsWith(`${socketId}:`)
          )
          .map(([trackedSocketAndSubscriptionId, trackedReq]) => ({
            subscriptionId: trackedSocketAndSubscriptionId.slice(socketId.length + 1),
            req: trackedReq,
          }));
      }

      function sendBlockedNoticeAndClose(
        because: string,
        closeCode: number,
        closeReason: string,
        extraPayload: Record<string, unknown> = {},
      ): void {
        console.warn(
          JSON.stringify(
            withTiming({
              msg: "CONNECTING BLOCKED",
              because,
              ip,
              port,
              socketId,
              ...extraPayload,
            }),
          ),
        );
        const blockedMessage = JSON.stringify([
          "NOTICE",
          `blocked: ${because}`,
        ]);
        console.log(
          JSON.stringify(
            withTiming({
              msg: "BLOCKED NOTICE",
              ip,
              port,
              socketId,
              because,
              blockedMessage,
              ...extraPayload,
            }),
          ),
        );
        upstreamSocket.close();
        downstreamSocket.send(blockedMessage);
        downstreamSocket.close(closeCode, closeReason);
      }

      // Check whether we want to forward original request headers to the upstream server
      // This will be useful if the upstream server need original request headers to do operations like rate-limiting, etc.
      let wsClientOptions = enableForwardReqHeaders ? { headers: req.headers } : undefined;

      // 上流となるリレーサーバーと接続
      let upstreamSocket = new WebSocket(upstreamWsUrl, wsClientOptions);
      connectUpstream(upstreamSocket, downstreamSocket);

      // クライアントとの接続が確立したら、アイドルタイムアウトを設定
      setIdleTimeout(downstreamSocket);

      const { ip, port } = getClientAddress(req);

      // IPアドレスが指定したCIDR範囲内にあるかどうかを判断
      const isIpBlocked = cidrRanges.some((cidr) => ipMatchesCidr(ip, cidr));
      if (isIpBlocked) {
        // IPアドレスがCIDR範囲内にある場合、接続を拒否
        sendBlockedNoticeAndClose("Blocked by CIDR filter", 1008, "Forbidden");
        return;
      }

      // IPごとの接続数を取得・更新
      let connectionCountForIP = 0;
      let totalProcessingCostMsForIP = 0;
      let isProcessingCostBlocked = false;
      let processingCostBlockedUntil: number | undefined;
      await connectionCountMutex.runExclusive(async () => {
        connectionCountForIP = (connectionCountsByIP.get(ip) ?? 0) + 1;
        totalProcessingCostMsForIP = totalProcessingCostMsByIP.get(ip) ?? 0;
        isProcessingCostBlocked = blockedIPsByProcessingCost.has(ip);
        processingCostBlockedUntil = processingCostBlockedUntilByIP.get(ip);
        if (
          isProcessingCostBlocked &&
          typeof processingCostBlockedUntil === "number" &&
          processingCostBlockedUntil <= Date.now()
        ) {
          const timeoutId = processingCostBlockTimeoutsByIP.get(ip);
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          blockedIPsByProcessingCost.delete(ip);
          processingCostBlockedUntilByIP.delete(ip);
          processingCostBlockTimeoutsByIP.delete(ip);
          totalProcessingCostMsByIP.delete(ip);
          totalProcessingCostMsForIP = 0;
          isProcessingCostBlocked = false;
          processingCostBlockedUntil = undefined;
        }
      });
      if (isProcessingCostBlocked) {
        sendBlockedNoticeAndClose(
          "Blocked by accumulated processing cost",
          1008,
          "Forbidden",
          {
            connectionCountForIP,
            totalProcessingCostMsForIP,
            processingCostBlockThresholdMs,
            processingCostBlockedUntil,
          },
        );
        return;
      } else if (connectionCountForIP > 100) {
        sendBlockedNoticeAndClose(
          "Blocked by too many connections",
          1008,
          "Too many requests.",
          { connectionCountForIP },
        );
        return;
      } else {
        connectionCount++;
        console.info(
          JSON.stringify(
            withTiming({
              msg: "CONNECTED",
              ip,
              port,
              socketId,
              connectionCountForIP,
              headers: req.headers,
            }),
          ),
        );
        connectionCountsByIP.set(ip, connectionCountForIP);
        await registerSocketForIP(ip, downstreamSocket);
      }

      // クライアントからメッセージを受信したとき
      downstreamSocket.on("message", async (data: WebSocket.Data) => {
        // メッセージを受信するたびに、タイムアウトをリセット
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
        // kind1だけフィルタリングを行う
        if (event[0] === "EVENT") {
          rememberSubscription(event[1].id);
          const decision = evaluateDownstreamEvent(event);
          shouldRelay = decision.shouldRelay;
          because = decision.because;

          // イベント内容とフィルターの判定結果をコンソールにログ出力
          if (shouldRelay) {
            console.info(
              JSON.stringify(
                withTiming({
                  msg: "EVENT",
                  ip,
                  port,
                  socketId,
                  connectionCountForIP,
                  event: event[1],
                }),
              ),
            );
          } else {
            console.info(
              JSON.stringify(
                withTiming({
                  msg: "EVENT BLOCKED",
                  because,
                  ip,
                  port,
                  socketId,
                  connectionCountForIP,
                  event: event[1],
                }),
              ),
            );
          }
        } else if (event[0] === "REQ") {
          const subscriptionId = event[1];
          trackReq(subscriptionId, event[2]);

          if (event[2].limit && event[2].limit > 500) {
            event[2].limit = 500;
            isMessageEdited = true;
            trackReq(subscriptionId, event[2]);
          }
        } else if (event[0] === "CLOSE") {
          const subscriptionId = event[1];
          const socketAndSubscriptionId = forgetSubscription(subscriptionId);
          subscriptionState.ipAddresses.set(socketAndSubscriptionId, ip + " CLOSED");
          subscriptionState.portNumbers.set(socketAndSubscriptionId, -port);
          // REQイベントの内容をコンソールにログ出力
          console.log(
            JSON.stringify(
              withTiming({
                msg: "CLOSE SUBSCRIPTION",
                ip,
                port,
                socketId,
                connectionCountForIP,
                subscriptionId,
                req: event[2],
                subscriptionSize: subscriptionState.transferredSizes.get(
                  socketAndSubscriptionId,
                ),
              }),
            ),
          );
        } else {
          console.log(
            JSON.stringify(
              withTiming({
                msg: "UNKNOWN",
                ip,
                port,
                socketId,
                connectionCountForIP,
                message: event,
              }),
            ),
          );

          if (event[0] === "INVALID") {
            shouldRelay = false;
            because = event[1];
          }
        }

        if (shouldRelay) {
          // 送信が成功したかどうかを確認するフラグ
          let isMessageSent = false;
          let isWebSocketClosed = false;
          // リトライ回数をカウントする変数
          let retryCount = 0;

          function sendMessage(): boolean {
            let msg = message;
            if (isMessageEdited) {
              msg = JSON.stringify(event);
            }

            // 書き込んで良いイベントはあらかじめ接続済みのソケットに送信する
            if (event[0] === "EVENT") {
              upstreamWriteSocket.send(msg);
            }

            // REQやEVENTを個別のソケットでやり取りする(OKメッセージの受信のため)
            if (upstreamSocket.readyState === WebSocket.OPEN) {
              upstreamSocket.send(msg);

              // メッセージが送信されたのでフラグをtrueにする
              isMessageSent = true;
              if (retryCount > 0) {
                console.log(
                  JSON.stringify(
                    withTiming({
                      msg: "RETRY SUCCEEDED",
                      ip,
                      port,
                      socketId,
                      connectionCountForIP,
                      retryCount,
                    }),
                  ),
                );
              }
              return false;
            } else if (upstreamSocket.readyState === WebSocket.CONNECTING) {
              // リトライ回数をカウント
              retryCount++;
              return true;
            } else {
              isWebSocketClosed = true;

              upstreamSocket.close();
              downstreamSocket.close();

              console.log(
                JSON.stringify(
                  withTiming({
                    msg: "RETRY DISCONTINUED",
                    ip,
                    port,
                    socketId,
                    connectionCountForIP,
                    retryCount,
                  }),
                ),
              );
              return false;
            }
          }

          // 送信して良いと判断したメッセージは上流のWebSocketに送信
          if (sendMessage()) {
            let intervalId = setInterval(() => {
              if (!sendMessage()) {
                clearInterval(intervalId);
              }
            }, 0.5 * 1000);

            // WebSocketが接続されない場合、もしくは5秒経ってもメッセージが送信されない場合は下流のWebSocketを閉じる
            setTimeout(() => {
              if (!isMessageSent && !isWebSocketClosed) {
                clearInterval(intervalId);

                upstreamSocket.close();
                downstreamSocket.close();

                console.log(
                  JSON.stringify(
                    withTiming({
                      msg: "RETRY TIMEOUT",
                      ip,
                      port,
                      socketId,
                      connectionCountForIP,
                      retryCount,
                    }),
                  ),
                );
              }
            }, 30 * 1000);
          }
        } else {
          // ブロック対象のメッセージを送ってきたクライアントには警告メッセージを返却
          if (event[0] === "EVENT") {
            const blockedMessage = JSON.stringify([
              "OK",
              event[1].id,
              false,
              `blocked: ${because}`,
            ]);
            console.log(
              JSON.stringify(
                withTiming({
                  msg: "BLOCKED EVENT",
                  ip,
                  port,
                  socketId,
                  connectionCountForIP,
                  blockedMessage,
                  event,
                }),
              ),
            );
            downstreamSocket.send(blockedMessage);
          } else {
            const blockedMessage = JSON.stringify([
              "NOTICE",
              `blocked: ${because}`,
            ]);
            console.log(
              JSON.stringify(
                withTiming({
                  msg: "BLOCKED NOTICE",
                  ip,
                  port,
                  socketId,
                  connectionCountForIP,
                  blockedMessage,
                  event,
                }),
              ),
            );
            downstreamSocket.send(blockedMessage);
          }
          downstreamSocket.close();
        }
      });

      downstreamSocket.on("close", async () => {
        connectionCount--; // 接続が閉じられるたびにカウントを減らす

        let connectionCountForIP = 1;
        let totalProcessingCostMsForIP = 0;
        let shouldResetIPState = false;
        let isProcessingCostBlocked = false;
        await connectionCountMutex.runExclusive(async () => {
          connectionCountForIP = connectionCountsByIP.get(ip) ?? 1;
          const nextConnectionCountForIP = connectionCountForIP - 1;
          totalProcessingCostMsForIP = totalProcessingCostMsByIP.get(ip) ?? 0;
          isProcessingCostBlocked = blockedIPsByProcessingCost.has(ip);
          if (nextConnectionCountForIP <= 0) {
            connectionCountsByIP.delete(ip);
            if (!isProcessingCostBlocked) {
              totalProcessingCostMsByIP.delete(ip);
              shouldResetIPState = true;
            }
          } else {
            connectionCountsByIP.set(ip, nextConnectionCountForIP);
          }
        });
        await unregisterSocketForIP(ip, downstreamSocket);
        console.log(
          JSON.stringify(
            withTiming({
              msg: "DISCONNECTED",
              ip,
              port,
              socketId,
              connectionCountForIP,
            }),
          ),
        );
        if (shouldResetIPState || (connectionCountForIP - 1 <= 0 && isProcessingCostBlocked)) {
          console.info(
            JSON.stringify(
              withTiming({
                msg: "IP PROCESSING COST SUMMARY",
                ip,
                socketId,
                totalProcessingCostMsForIP,
                ...(isProcessingCostBlocked
                  ? { resetPendingUntilUnblock: true }
                  : {}),
              }),
            ),
          );
        }
        upstreamSocket.close();
        clearIdleTimeout(downstreamSocket);
      });

      downstreamSocket.on("error", async (error: Error) => {
        console.warn(
          JSON.stringify(
            withTiming({
              msg: "DOWNSTREAM ERROR",
              ip,
              port,
              socketId,
              connectionCountForIP,
              error,
            }),
          ),
        );
        downstreamSocket.close();
        upstreamSocket.close();
      });

      // 上流のリレーサーバーとの接続
      function connectUpstream(
        upstreamSocket: WebSocket,
        downstreamSocket: WebSocket,
      ): void {
        upstreamSocket.on("open", async () => {
          console.log(
            JSON.stringify(
              withTiming({
                msg: "UPSTREAM CONNECTED",
                socketId,
              }),
            ),
          );
          setIdleTimeout(upstreamSocket);
        });

        upstreamSocket.on("close", async () => {
          console.log(
            JSON.stringify(
              withTiming({
                msg: "UPSTREAM DISCONNECTED",
                socketId,
              }),
            ),
          );
          downstreamSocket.close();
          clearIdleTimeout(upstreamSocket);
        });

        upstreamSocket.on("error", async (error: Error) => {
          console.warn(
            JSON.stringify(
              withTiming({
                msg: "UPSTREAM ERROR",
                socketId,
                error,
              }),
            ),
          );
          downstreamSocket.close();
          upstreamSocket.close();
        });

        upstreamSocket.on("message", async (data: WebSocket.Data) => {
          const message = data.toString();
          let event: any[];
          try {
            event = JSON.parse(message);
          } catch (err: any) {
            event = ["INVALID", err.message ?? JSON.stringify(err)];
          }
          resetIdleTimeout(downstreamSocket);
          resetIdleTimeout(upstreamSocket);

          let shouldRelay = true;
          let because = "";
          const relayDecision = evaluateUpstreamEvent(event);
          shouldRelay = relayDecision.shouldRelay;
          because = relayDecision.because;

          let result: any[];
          try {
            result = JSON.parse(message);
          } catch (err: any) {
            result = ["INVALID", err.message ?? JSON.stringify(err)];
          }
          const resultType = result[0];
          if (resultType === "OK") {
            console.log(
              JSON.stringify(
                withTiming({
                  msg: "EVENT WRITE",
                  ip,
                  port,
                  resultType,
                  socketId,
                  eventId: result[1],
                }),
              ),
            );
          } else if (resultType === "NOTICE") {
            console.log(
              JSON.stringify(
                withTiming({
                  msg: "NOTICE",
                  ip,
                  port,
                  resultType,
                  socketId,
                  message: result,
                }),
              ),
            );
          } else if (resultType === "EOSE") {
            const subscriptionId = result[1];
            const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
            const reqStartedAt = subscriptionState.reqStartedAt.get(
              socketAndSubscriptionId,
            );
            const processingCostMs =
              typeof reqStartedAt === "number" ? Date.now() - reqStartedAt : undefined;
            if (typeof processingCostMs === "number") {
              const reqPayload = subscriptionState.reqPayloads.get(
                socketAndSubscriptionId,
              );
              subscriptionState.reqStartedAt.delete(socketAndSubscriptionId);
              const {
                totalProcessingCostMsForIP,
                isNewlyBlocked,
                blockedUntil,
              } = await addProcessingCostForIP(ip, processingCostMs);
              console.info(
                JSON.stringify(
                  withTiming({
                    msg: "EOSE",
                    ip,
                    port,
                    resultType,
                    socketId,
                    subscriptionId,
                    processingCostMs,
                    totalProcessingCostMsForIP,
                    ...(typeof blockedUntil === "number"
                      ? { processingCostBlockedUntil: new Date(blockedUntil).toISOString() }
                      : {}),
                  }),
                ),
              );
              if (isNewlyBlocked) {
                if (typeof blockedUntil === "number") {
                  await scheduleProcessingCostUnblock(ip, blockedUntil);
                }
                const trackedReqsForIP = getTrackedReqsForSocket();
                console.warn(
                  JSON.stringify(
                    withTiming({
                      msg: "IP PROCESSING COST BLOCKED",
                      ip,
                      port,
                      socketId,
                      subscriptionId,
                      processingCostMs,
                      totalProcessingCostMsForIP,
                      processingCostBlockThresholdMs,
                      req: reqPayload,
                      trackedReqsForSocket: trackedReqsForIP,
                      ...(typeof blockedUntil === "number"
                        ? { processingCostBlockedUntil: new Date(blockedUntil).toISOString() }
                        : {}),
                    }),
                  ),
                );
                const blockedMessage = JSON.stringify([
                  "NOTICE",
                  "blocked: Blocked by accumulated processing cost",
                ]);
                const sockets = await getSocketsForIP(ip);
                for (const socket of sockets) {
                  socket.send(blockedMessage);
                  socket.close(1008, "Forbidden");
                }
              }
              subscriptionState.reqPayloads.delete(socketAndSubscriptionId);
            } else {
              console.info(
                JSON.stringify(
                  withTiming({
                    msg: "EOSE",
                    ip,
                    port,
                    resultType,
                    socketId,
                    subscriptionId,
                  }),
                ),
              );
            }
          } else if (resultType === "INVALID") {
            shouldRelay = false;
            because = result[1];
          } else {
            const subscriptionId = result[1];
            const socketAndSubscriptionId = `${socketId}:${subscriptionId}`;
            let subscriptionSize;
            await subscriptionSizeMutex.runExclusive(async () => {
              subscriptionSize = (subscriptionState.transferredSizes.get(
                socketAndSubscriptionId,
              ) ?? 0) + message.length;
              subscriptionState.transferredSizes.set(
                socketAndSubscriptionId,
                subscriptionSize,
              );
            });
            console.log(
              JSON.stringify(
                withTiming({
                  msg: "SUBSCRIBE",
                  ip,
                  port,
                  resultType,
                  socketId,
                  subscriptionId,
                  subscriptionSize,
                }),
              ),
            );
          }
          if (shouldRelay) {
            downstreamSocket.send(message);
          } else {
            console.log(
              JSON.stringify(
                withTiming({
                  msg: "EVENT MUTED",
                  because,
                  ip,
                  port,
                  socketId,
                  event,
                }),
              ),
            );
          }
        });
      }
    },
  );
  // HTTP+WebSocketサーバーの起動
  server.listen(listenPort);
}

listen();

// ソケットとタイムアウトIDを関連付けるためのMap
const idleTimeouts = new Map<WebSocket, NodeJS.Timeout>();

// ソケットとタイムアウト値を関連付けるためのMap
const timeoutValues = new Map<WebSocket, number>();

// タイムアウト値のデフォルト
const defaultTimeoutValue = 10 * 60 * 1000;

function setIdleTimeout(
  socket: WebSocket,
  timeout: number = defaultTimeoutValue,
): void {
  const timeoutId = setTimeout(() => {
    socket.close();
  }, timeout);

  idleTimeouts.set(socket, timeoutId);
  timeoutValues.set(socket, timeout);
}

function resetIdleTimeout(
  socket: WebSocket,
  defaultTimeout: number = defaultTimeoutValue,
): void {
  clearTimeout(idleTimeouts.get(socket));
  const timeout = timeoutValues.get(socket) ?? defaultTimeout;
  setIdleTimeout(socket, timeout); // タイムアウトを再利用、もしくはデフォルト値を使用
}

function clearIdleTimeout(socket: WebSocket): void {
  clearTimeout(idleTimeouts.get(socket));
  idleTimeouts.delete(socket);
  timeoutValues.delete(socket);
}
