import fs from "fs";
import path from "path";
import { log } from "./logger";
import { ReqExecutionStats, ReqShape } from "./types";

type ReqShapeAggregate = {
  shape: ReqShape;
  mode: ReqExecutionStats["mode"];
  sampleCount: number;
  totalProcessingCostMs: number;
  maxProcessingCostMs: number;
  totalUpstreamEventCount: number;
  totalDownstreamEventCount: number;
};

const reqShapeAggregates = new Map<string, ReqShapeAggregate>();

function getReqShapeKey(shape: ReqShape, mode: ReqExecutionStats["mode"]): string {
  return JSON.stringify({ mode, shape });
}

function shouldLogAggregate(sampleCount: number): boolean {
  return sampleCount === 1 || sampleCount === 5 || sampleCount === 10 || sampleCount === 25 || sampleCount === 50 || sampleCount % 100 === 0;
}

export function recordReqExecutionStats(stats: ReqExecutionStats, processingCostMs: number): void {
  const key = getReqShapeKey(stats.shape, stats.mode);
  const aggregate = reqShapeAggregates.get(key) ?? {
    shape: stats.shape,
    mode: stats.mode,
    sampleCount: 0,
    totalProcessingCostMs: 0,
    maxProcessingCostMs: 0,
    totalUpstreamEventCount: 0,
    totalDownstreamEventCount: 0,
  };

  aggregate.sampleCount += 1;
  aggregate.totalProcessingCostMs += processingCostMs;
  aggregate.maxProcessingCostMs = Math.max(aggregate.maxProcessingCostMs, processingCostMs);
  aggregate.totalUpstreamEventCount += stats.upstreamEventCount;
  aggregate.totalDownstreamEventCount += stats.downstreamEventCount;
  reqShapeAggregates.set(key, aggregate);

  if (!shouldLogAggregate(aggregate.sampleCount)) return;

  log("INFO", {
    msg: "REQ SHAPE STATS",
    mode: aggregate.mode,
    shape: aggregate.shape,
    sampleCount: aggregate.sampleCount,
    avgProcessingCostMs: Math.round(aggregate.totalProcessingCostMs / aggregate.sampleCount),
    maxProcessingCostMs: aggregate.maxProcessingCostMs,
    avgUpstreamEventCount: Number((aggregate.totalUpstreamEventCount / aggregate.sampleCount).toFixed(2)),
    avgDownstreamEventCount: Number((aggregate.totalDownstreamEventCount / aggregate.sampleCount).toFixed(2)),
    avgExpansionRatio: Number(((aggregate.totalUpstreamEventCount || 0) / Math.max(aggregate.totalDownstreamEventCount, 1)).toFixed(2)),
  });
}

type ReqShapeAggregateSnapshot = ReqShapeAggregate & { key: string };

function getSnapshot(): ReqShapeAggregateSnapshot[] {
  return Array.from(reqShapeAggregates.entries()).map(([key, aggregate]) => ({ key, ...aggregate }));
}

export function loadReqPlannerStats(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof item.key !== "string") continue;
      reqShapeAggregates.set(item.key, {
        shape: item.shape,
        mode: item.mode,
        sampleCount: item.sampleCount,
        totalProcessingCostMs: item.totalProcessingCostMs,
        maxProcessingCostMs: item.maxProcessingCostMs,
        totalUpstreamEventCount: item.totalUpstreamEventCount,
        totalDownstreamEventCount: item.totalDownstreamEventCount,
      });
    }
    log("INFO", { msg: "REQ SHAPE STATS LOADED", filePath, aggregateCount: reqShapeAggregates.size });
  } catch (error) {
    log("WARN", { msg: "REQ SHAPE STATS LOAD FAILED", filePath, error });
  }
}

export function persistReqPlannerStats(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(getSnapshot()));
    log("DEBUG", { msg: "REQ SHAPE STATS SAVED", filePath, aggregateCount: reqShapeAggregates.size });
  } catch (error) {
    log("WARN", { msg: "REQ SHAPE STATS SAVE FAILED", filePath, error });
  }
}
