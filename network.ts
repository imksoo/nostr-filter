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
