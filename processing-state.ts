import WebSocket from "ws";
import { Mutex } from "async-mutex";
import { blockedActionBanDurationSec, processingCostBlockDurationSec, processingCostBlockThresholdMs } from "./config";
import { ConnectionAttemptState, ConnectionReleaseState, ProcessingCostUpdate } from "./types";

let connectionCount = 0;
const connectionCountsByIP = new Map<string, number>();
const totalProcessingCostMsByIP = new Map<string, number>();
const blockedIPsByProcessingCost = new Set<string>();
const processingCostBlockedUntilByIP = new Map<string, number>();
const processingCostBlockTimeoutsByIP = new Map<string, NodeJS.Timeout>();
const blockedIPsByRule = new Set<string>();
const ruleBlockedUntilByIP = new Map<string, number>();
const ruleBlockReasonsByIP = new Map<string, string>();
const ruleBlockTimeoutsByIP = new Map<string, NodeJS.Timeout>();
const activeSocketsByIP = new Map<string, Set<WebSocket>>();
const connectionCountMutex = new Mutex();

async function unregisterSocketForIPInternal(ip: string, socket: WebSocket): Promise<void> {
  const sockets = activeSocketsByIP.get(ip);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) activeSocketsByIP.delete(ip);
}

export function getConnectionCount(): number {
  return connectionCount;
}

export async function getConnectionAttemptState(ip: string): Promise<ConnectionAttemptState> {
  const state: ConnectionAttemptState = {
    connectionCountForIP: 0,
    totalProcessingCostMsForIP: 0,
    isProcessingCostBlocked: false,
    isRuleBlocked: false,
  };

  await connectionCountMutex.runExclusive(async () => {
    state.connectionCountForIP = (connectionCountsByIP.get(ip) ?? 0) + 1;
    state.totalProcessingCostMsForIP = totalProcessingCostMsByIP.get(ip) ?? 0;
    state.isProcessingCostBlocked = blockedIPsByProcessingCost.has(ip);
    state.processingCostBlockedUntil = processingCostBlockedUntilByIP.get(ip);
    state.isRuleBlocked = blockedIPsByRule.has(ip);
    state.ruleBlockedUntil = ruleBlockedUntilByIP.get(ip);
    state.ruleBlockedReason = ruleBlockReasonsByIP.get(ip);

    if (state.isProcessingCostBlocked && typeof state.processingCostBlockedUntil === "number" && state.processingCostBlockedUntil <= Date.now()) {
      const timeoutId = processingCostBlockTimeoutsByIP.get(ip);
      if (timeoutId) clearTimeout(timeoutId);
      blockedIPsByProcessingCost.delete(ip);
      processingCostBlockedUntilByIP.delete(ip);
      processingCostBlockTimeoutsByIP.delete(ip);
      totalProcessingCostMsByIP.delete(ip);
      state.totalProcessingCostMsForIP = 0;
      state.isProcessingCostBlocked = false;
      state.processingCostBlockedUntil = undefined;
    }

    if (state.isRuleBlocked && typeof state.ruleBlockedUntil === "number" && state.ruleBlockedUntil <= Date.now()) {
      const timeoutId = ruleBlockTimeoutsByIP.get(ip);
      if (timeoutId) clearTimeout(timeoutId);
      blockedIPsByRule.delete(ip);
      ruleBlockedUntilByIP.delete(ip);
      ruleBlockReasonsByIP.delete(ip);
      ruleBlockTimeoutsByIP.delete(ip);
      state.isRuleBlocked = false;
      state.ruleBlockedUntil = undefined;
      state.ruleBlockedReason = undefined;
    }
  });

  return state;
}

export async function acceptConnection(ip: string, socket: WebSocket): Promise<number> {
  let connectionCountForIP = 0;
  await connectionCountMutex.runExclusive(async () => {
    connectionCount++;
    connectionCountForIP = (connectionCountsByIP.get(ip) ?? 0) + 1;
    connectionCountsByIP.set(ip, connectionCountForIP);
    const sockets = activeSocketsByIP.get(ip) ?? new Set<WebSocket>();
    sockets.add(socket);
    activeSocketsByIP.set(ip, sockets);
  });
  return connectionCountForIP;
}

export async function releaseConnection(ip: string, socket: WebSocket): Promise<ConnectionReleaseState> {
  const releaseState: ConnectionReleaseState = {
    connectionCountForIP: 1,
    totalProcessingCostMsForIP: 0,
    shouldResetIPState: false,
    isProcessingCostBlocked: false,
    isRuleBlocked: false,
  };

  await connectionCountMutex.runExclusive(async () => {
    connectionCount--;
    releaseState.connectionCountForIP = connectionCountsByIP.get(ip) ?? 1;
    const nextConnectionCountForIP = releaseState.connectionCountForIP - 1;
    releaseState.totalProcessingCostMsForIP = totalProcessingCostMsByIP.get(ip) ?? 0;
    releaseState.isProcessingCostBlocked = blockedIPsByProcessingCost.has(ip);
    releaseState.isRuleBlocked = blockedIPsByRule.has(ip);

    if (nextConnectionCountForIP <= 0) {
      connectionCountsByIP.delete(ip);
      if (!releaseState.isProcessingCostBlocked) {
        totalProcessingCostMsByIP.delete(ip);
      }
      releaseState.shouldResetIPState = true;
    } else {
      connectionCountsByIP.set(ip, nextConnectionCountForIP);
    }

    await unregisterSocketForIPInternal(ip, socket);
  });

  return releaseState;
}

export async function addProcessingCostForIP(ip: string, processingCostMs: number): Promise<ProcessingCostUpdate> {
  const update: ProcessingCostUpdate = { totalProcessingCostMsForIP: 0, isNewlyBlocked: false };

  await connectionCountMutex.runExclusive(async () => {
    update.totalProcessingCostMsForIP = (totalProcessingCostMsByIP.get(ip) ?? 0) + processingCostMs;
    totalProcessingCostMsByIP.set(ip, update.totalProcessingCostMsForIP);
    if (processingCostBlockThresholdMs > 0 && update.totalProcessingCostMsForIP >= processingCostBlockThresholdMs && !blockedIPsByProcessingCost.has(ip)) {
      blockedIPsByProcessingCost.add(ip);
      update.blockedUntil = Date.now() + processingCostBlockDurationSec * 1000;
      processingCostBlockedUntilByIP.set(ip, update.blockedUntil);
      update.isNewlyBlocked = true;
    }
  });

  return update;
}

export async function getSocketsForIP(ip: string): Promise<WebSocket[]> {
  let sockets: WebSocket[] = [];
  await connectionCountMutex.runExclusive(async () => {
    sockets = Array.from(activeSocketsByIP.get(ip) ?? []);
  });
  return sockets;
}

export async function blockIPByRule(ip: string, reason: string): Promise<{ blockedUntil: number; isNewlyBlocked: boolean }> {
  const update = { blockedUntil: Date.now() + blockedActionBanDurationSec * 1000, isNewlyBlocked: false };

  await connectionCountMutex.runExclusive(async () => {
    if (blockedIPsByRule.has(ip)) {
      ruleBlockReasonsByIP.set(ip, reason);
      ruleBlockedUntilByIP.set(ip, update.blockedUntil);
      return;
    }
    blockedIPsByRule.add(ip);
    ruleBlockReasonsByIP.set(ip, reason);
    ruleBlockedUntilByIP.set(ip, update.blockedUntil);
    update.isNewlyBlocked = true;
  });

  return update;
}

export async function unblockIPByProcessingCost(ip: string): Promise<{ totalProcessingCostMsForIP: number; hadBlockedState: boolean }> {
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

  return { totalProcessingCostMsForIP, hadBlockedState };
}

export async function unblockIPByRule(ip: string): Promise<{ hadBlockedState: boolean; ruleBlockedReason?: string }> {
  let hadBlockedState = false;
  let ruleBlockedReason: string | undefined;

  await connectionCountMutex.runExclusive(async () => {
    hadBlockedState = blockedIPsByRule.delete(ip);
    ruleBlockedReason = ruleBlockReasonsByIP.get(ip);
    ruleBlockedUntilByIP.delete(ip);
    ruleBlockReasonsByIP.delete(ip);
    const timeoutId = ruleBlockTimeoutsByIP.get(ip);
    if (timeoutId) {
      clearTimeout(timeoutId);
      ruleBlockTimeoutsByIP.delete(ip);
    }
  });

  return { hadBlockedState, ruleBlockedReason };
}

export async function scheduleProcessingCostUnblock(ip: string, blockedUntil: number, onUnblock: (ip: string) => Promise<void>): Promise<void> {
  await connectionCountMutex.runExclusive(async () => {
    const currentTimeout = processingCostBlockTimeoutsByIP.get(ip);
    if (currentTimeout) clearTimeout(currentTimeout);
    const delayMs = Math.max(0, blockedUntil - Date.now());
    const timeoutId = setTimeout(() => {
      void onUnblock(ip);
    }, delayMs);
    processingCostBlockTimeoutsByIP.set(ip, timeoutId);
  });
}

export async function scheduleRuleUnblock(ip: string, blockedUntil: number, onUnblock: (ip: string) => Promise<void>): Promise<void> {
  await connectionCountMutex.runExclusive(async () => {
    const currentTimeout = ruleBlockTimeoutsByIP.get(ip);
    if (currentTimeout) clearTimeout(currentTimeout);
    const delayMs = Math.max(0, blockedUntil - Date.now());
    const timeoutId = setTimeout(() => {
      void onUnblock(ip);
    }, delayMs);
    ruleBlockTimeoutsByIP.set(ip, timeoutId);
  });
}
