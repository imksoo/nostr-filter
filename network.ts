import http from "http";
import WebSocket from "ws";
import { ClientAddress } from "./types";

const idleTimeouts = new Map<WebSocket, NodeJS.Timeout>();
const timeoutValues = new Map<WebSocket, number>();
const defaultTimeoutValue = 10 * 60 * 1000;

export function getClientAddress(req: http.IncomingMessage): ClientAddress {
  const ip = (typeof req.headers["cloudfront-viewer-address"] === "string" ? req.headers["cloudfront-viewer-address"].split(":").slice(0, -1).join(":") : undefined) || (typeof req.headers["x-real-ip"] === "string" ? req.headers["x-real-ip"] : undefined) || (typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0].trim() : undefined) || (typeof req.socket.remoteAddress === "string" ? req.socket.remoteAddress : "unknown-ip-addr");

  const port = (typeof req.headers["cloudfront-viewer-address"] === "string" ? parseInt(req.headers["cloudfront-viewer-address"].split(":").slice(-1)[0]) : undefined) || (typeof req.headers["x-real-port"] === "string" ? parseInt(req.headers["x-real-port"]) : 0);

  return { ip, port };
}

export function buildForwardHeaders(req: http.IncomingMessage, clientAddress: ClientAddress): http.OutgoingHttpHeaders {
  const forwardedFor = typeof req.headers["x-forwarded-for"] === "string" && req.headers["x-forwarded-for"].trim() !== "" ? req.headers["x-forwarded-for"] : clientAddress.ip;
  const { ["sec-websocket-protocol"]: _secWebSocketProtocol, ...headersWithoutSubprotocol } = req.headers;
  return {
    ...headersWithoutSubprotocol,
    "x-real-ip": clientAddress.ip,
    "x-real-port": String(clientAddress.port),
    "x-forwarded-for": forwardedFor,
    "x-forwarded-host": typeof req.headers.host === "string" ? req.headers.host : "",
    "x-forwarded-proto": typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "http",
    "x-forwarded-server": typeof req.headers["x-forwarded-server"] === "string" ? req.headers["x-forwarded-server"] : typeof req.headers.host === "string" ? req.headers.host : "",
  };
}

export function getRequestedSubprotocols(req: http.IncomingMessage): string[] | undefined {
  if (typeof req.headers["sec-websocket-protocol"] !== "string") return undefined;
  const protocols = req.headers["sec-websocket-protocol"].split(",").map((protocol) => protocol.trim()).filter((protocol) => protocol !== "");
  return protocols.length > 0 ? protocols : undefined;
}

export function setIdleTimeout(socket: WebSocket, timeout: number = defaultTimeoutValue): void {
  const timeoutId = setTimeout(() => {
    socket.close();
  }, timeout);
  idleTimeouts.set(socket, timeoutId);
  timeoutValues.set(socket, timeout);
}

export function resetIdleTimeout(socket: WebSocket, fallbackTimeout: number = defaultTimeoutValue): void {
  clearTimeout(idleTimeouts.get(socket));
  setIdleTimeout(socket, timeoutValues.get(socket) ?? fallbackTimeout);
}

export function clearIdleTimeout(socket: WebSocket): void {
  clearTimeout(idleTimeouts.get(socket));
  idleTimeouts.delete(socket);
  timeoutValues.delete(socket);
}
