"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
const listenUrl = "ws://localhost:8081"; // クライアントからのWebSocket接続先のURL
const upstreamUrl = "ws://localhost:8080"; // 上流のWebSocketサーバのURL
const filters = [/^avive/i, /web3$/i]; // 正規表現パターンの配列
function listen() {
    const wss = new ws_1.default.Server({ port: 8081 });
    wss.on("connection", (clientStream, req) => {
        // console.log("WebSocket connected");
        let upstreamSocket = new ws_1.default(upstreamUrl);
        connectUpstream(upstreamSocket, clientStream);
        clientStream.on("message", (data) => __awaiter(this, void 0, void 0, function* () {
            const message = data.toString();
            const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
            if (message.indexOf("EVENT") > -1) {
                console.log(`${ip}: ${message}`);
            }
            let shouldRelay = true;
            for (const filter of filters) {
                if (filter.test(message)) {
                    // 正規表現パターンにマッチする場合はコンソールにログ出力
                    console.log(`${ip}: ${message}`);
                    shouldRelay = false;
                    break;
                }
            }
            if (shouldRelay) {
                // 正規表現パターンにマッチしない場合は上流のWebSocketに送信
                if (upstreamSocket.readyState === ws_1.default.OPEN) {
                    upstreamSocket.send(message);
                }
            }
        }));
        clientStream.on("close", () => {
            // console.log("WebSocket disconnected");
        });
        clientStream.on("error", (error) => {
            console.log("WebSocket error:", error);
        });
        clientStream.pong = () => {
            clientStream.ping();
        };
    });
    console.log(`WebSocket server listening on ${listenUrl}`);
}
function connectUpstream(upstreamSocket, clientStream) {
    upstreamSocket.on("open", () => {
        // console.log("Upstream WebSocket connected");
    });
    upstreamSocket.on("close", () => {
        // console.log("Upstream WebSocket disconnected");
        reconnect(upstreamSocket, clientStream);
    });
    upstreamSocket.on("error", (error) => {
        console.log("Upstream WebSocket error:", error);
    });
    upstreamSocket.on("message", (data) => __awaiter(this, void 0, void 0, function* () {
        const message = data.toString();
        clientStream.send(message);
    }));
}
function reconnect(upstreamSocket, clientStream) {
    console.log(`Retry connection...`);
    setTimeout(() => {
        if (upstreamSocket.readyState === ws_1.default.CLOSED) {
            console.log("Trying to reconnect to upstream WebSocket...");
            upstreamSocket.removeAllListeners(); // イベントリスナーをクリア
            upstreamSocket = new ws_1.default(upstreamUrl);
            connectUpstream(upstreamSocket, clientStream);
        }
        else {
            console.log("Upstream WebSocket is already connected or connecting");
        }
    }, 1000);
}
listen();
