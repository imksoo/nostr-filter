import fs from "fs";
import path from "path";
import {
  reqPlanRewriteMaxAvgDownstreamEventCount,
  reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit,
  reqPlanRewriteMinAvgProcessingCostMs,
  reqPlanRewriteMinSampleCount,
  reqPlanRewriteMinTotalTagValueCount,
} from "./config";
import { log } from "./logger";
import { ReqAnalysis, ReqExecutionStats, ReqPlanExperimentCandidate, ReqPlanRecommendation, ReqPlanRewriteHeuristic, ReqPlanStatsSummary, ReqShape } from "./types";

type ReqShapeAggregate = {
  key: string;
  shape: ReqShape;
  signature?: string;
  mode: ReqExecutionStats["mode"];
  sampleCount: number;
  totalProcessingCostMs: number;
  maxProcessingCostMs: number;
  totalUpstreamEventCount: number;
  totalDownstreamEventCount: number;
};

const reqShapeAggregates = new Map<string, ReqShapeAggregate>();
const reqSignatureAggregates = new Map<string, ReqShapeAggregate>();

function getReqShapeKey(shape: ReqShape, mode: ReqExecutionStats["mode"]): string {
  return JSON.stringify({ mode, shape });
}

function getReqSignatureKey(signature: string, mode: ReqExecutionStats["mode"]): string {
  return JSON.stringify({ mode, signature });
}

function shouldLogAggregate(sampleCount: number): boolean {
  return sampleCount === 1 || sampleCount === 5 || sampleCount === 10 || sampleCount === 25 || sampleCount === 50 || sampleCount % 100 === 0;
}

function createAggregate(key: string, shape: ReqShape, mode: ReqExecutionStats["mode"], signature?: string): ReqShapeAggregate {
  return {
    key,
    shape,
    signature,
    mode,
    sampleCount: 0,
    totalProcessingCostMs: 0,
    maxProcessingCostMs: 0,
    totalUpstreamEventCount: 0,
    totalDownstreamEventCount: 0,
  };
}

function updateAggregate(aggregate: ReqShapeAggregate, stats: ReqExecutionStats, processingCostMs: number): void {
  aggregate.sampleCount += 1;
  aggregate.totalProcessingCostMs += processingCostMs;
  aggregate.maxProcessingCostMs = Math.max(aggregate.maxProcessingCostMs, processingCostMs);
  aggregate.totalUpstreamEventCount += stats.upstreamEventCount;
  aggregate.totalDownstreamEventCount += stats.downstreamEventCount;
}

function getShapeCounts(shape: ReqShape): Record<string, unknown> {
  return {
    filterCount: shape.filterCount,
    kinds: shape.kinds,
    idsCount: shape.idsCount,
    authorsCount: shape.authorsCount,
    pTagCount: shape.pTagCount,
    eTagCount: shape.eTagCount,
    totalTagValueCount: shape.totalTagValueCount,
  };
}

function toStatsSummary(aggregate: ReqShapeAggregate): ReqPlanStatsSummary {
  const authorTagUnitCount = Math.max(aggregate.shape.authorsCount * Math.max(aggregate.shape.pTagCount + aggregate.shape.eTagCount, 1), 1);
  return {
    mode: aggregate.mode,
    sampleCount: aggregate.sampleCount,
    avgProcessingCostMs: Math.round(aggregate.totalProcessingCostMs / aggregate.sampleCount),
    maxProcessingCostMs: aggregate.maxProcessingCostMs,
    avgUpstreamEventCount: Number((aggregate.totalUpstreamEventCount / aggregate.sampleCount).toFixed(2)),
    avgDownstreamEventCount: Number((aggregate.totalDownstreamEventCount / aggregate.sampleCount).toFixed(2)),
    avgExpansionRatio: Number((aggregate.totalUpstreamEventCount / Math.max(aggregate.totalDownstreamEventCount, 1)).toFixed(2)),
    avgResultDensityPerAuthorTagUnit: Number((aggregate.totalDownstreamEventCount / Math.max(aggregate.sampleCount * authorTagUnitCount, 1)).toFixed(6)),
  };
}

function pickRecommendedMode(statsByMode: ReqPlanStatsSummary[], fallbackMode: ReqExecutionStats["mode"]): ReqExecutionStats["mode"] {
  if (statsByMode.length === 0) return fallbackMode;

  const ranked = [...statsByMode].sort((left, right) => {
    if (left.avgProcessingCostMs !== right.avgProcessingCostMs) return left.avgProcessingCostMs - right.avgProcessingCostMs;
    if (left.avgExpansionRatio !== right.avgExpansionRatio) return left.avgExpansionRatio - right.avgExpansionRatio;
    if (left.avgResultDensityPerAuthorTagUnit !== right.avgResultDensityPerAuthorTagUnit) return right.avgResultDensityPerAuthorTagUnit - left.avgResultDensityPerAuthorTagUnit;
    return right.sampleCount - left.sampleCount;
  });

  return ranked[0]?.mode ?? fallbackMode;
}

function getRewriteHeuristic(shape: ReqShape, statsByMode: ReqPlanStatsSummary[], consideredModes: ReqExecutionStats["mode"][]): ReqPlanRewriteHeuristic {
  const candidateMode = consideredModes.find((mode) => mode !== "passthrough");
  if (!candidateMode) {
    return {
      shouldPreferRewrite: false,
      reason: "no_alternative",
      minSampleCount: reqPlanRewriteMinSampleCount,
      minAvgProcessingCostMs: reqPlanRewriteMinAvgProcessingCostMs,
      maxAvgResultDensityPerAuthorTagUnit: reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit,
      maxAvgDownstreamEventCount: reqPlanRewriteMaxAvgDownstreamEventCount,
      minTotalTagValueCount: reqPlanRewriteMinTotalTagValueCount,
    };
  }

  const passthroughStats = statsByMode.find((stats) => stats.mode === "passthrough");
  if (!passthroughStats) {
    return {
      shouldPreferRewrite: false,
      reason: "insufficient_data",
      candidateMode,
      minSampleCount: reqPlanRewriteMinSampleCount,
      minAvgProcessingCostMs: reqPlanRewriteMinAvgProcessingCostMs,
      maxAvgResultDensityPerAuthorTagUnit: reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit,
      maxAvgDownstreamEventCount: reqPlanRewriteMaxAvgDownstreamEventCount,
      minTotalTagValueCount: reqPlanRewriteMinTotalTagValueCount,
    };
  }

  const heuristic: ReqPlanRewriteHeuristic = {
    shouldPreferRewrite: false,
    reason: "prefer_rewrite",
    sourceMode: passthroughStats.mode,
    candidateMode,
    minSampleCount: reqPlanRewriteMinSampleCount,
    minAvgProcessingCostMs: reqPlanRewriteMinAvgProcessingCostMs,
    maxAvgResultDensityPerAuthorTagUnit: reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit,
    maxAvgDownstreamEventCount: reqPlanRewriteMaxAvgDownstreamEventCount,
    minTotalTagValueCount: reqPlanRewriteMinTotalTagValueCount,
  };

  if (passthroughStats.sampleCount < reqPlanRewriteMinSampleCount) return { ...heuristic, reason: "below_sample_threshold" };
  if (passthroughStats.avgProcessingCostMs < reqPlanRewriteMinAvgProcessingCostMs) return { ...heuristic, reason: "below_cost_threshold" };
  if (passthroughStats.avgResultDensityPerAuthorTagUnit > reqPlanRewriteMaxAvgResultDensityPerAuthorTagUnit) return { ...heuristic, reason: "above_density_threshold" };
  if (passthroughStats.avgDownstreamEventCount > reqPlanRewriteMaxAvgDownstreamEventCount) return { ...heuristic, reason: "above_downstream_threshold" };
  if (shape.totalTagValueCount < reqPlanRewriteMinTotalTagValueCount) return { ...heuristic, reason: "below_tag_threshold" };

  return { ...heuristic, shouldPreferRewrite: true, reason: "prefer_rewrite" };
}

export function getReqPlanRecommendation(analysis: ReqAnalysis): ReqPlanRecommendation {
  const shapeStatsByMode = analysis.candidatePlans
    .map((mode) => reqShapeAggregates.get(getReqShapeKey(analysis.shape, mode)))
    .filter((aggregate): aggregate is ReqShapeAggregate => typeof aggregate !== "undefined")
    .map(toStatsSummary);

  const signatureStatsByMode = analysis.candidatePlans
    .map((mode) => reqSignatureAggregates.get(getReqSignatureKey(analysis.signature, mode)))
    .filter((aggregate): aggregate is ReqShapeAggregate => typeof aggregate !== "undefined")
    .map(toStatsSummary);

  const heuristic = getRewriteHeuristic(analysis.shape, signatureStatsByMode.length > 0 ? signatureStatsByMode : shapeStatsByMode, analysis.candidatePlans);
  if (heuristic.shouldPreferRewrite && heuristic.candidateMode) {
    return {
      recommendedMode: heuristic.candidateMode,
      basis: "heuristic",
      signature: analysis.signature,
      consideredModes: analysis.candidatePlans,
      statsByMode: signatureStatsByMode.length > 0 ? signatureStatsByMode : shapeStatsByMode,
      heuristic,
    };
  }

  if (signatureStatsByMode.length > 0) {
    return {
      recommendedMode: pickRecommendedMode(signatureStatsByMode, "passthrough"),
      basis: "signature",
      signature: analysis.signature,
      consideredModes: analysis.candidatePlans,
      statsByMode: signatureStatsByMode,
      heuristic,
    };
  }

  if (shapeStatsByMode.length > 0) {
    return {
      recommendedMode: pickRecommendedMode(shapeStatsByMode, "passthrough"),
      basis: "shape",
      signature: analysis.signature,
      consideredModes: analysis.candidatePlans,
      statsByMode: shapeStatsByMode,
      heuristic,
    };
  }

  return {
    recommendedMode: "passthrough",
    basis: "none",
    signature: analysis.signature,
    consideredModes: analysis.candidatePlans,
    statsByMode: [],
    heuristic,
  };
}

export function getReqPlanExperimentCandidate(recommendation: ReqPlanRecommendation): ReqPlanExperimentCandidate {
  if (recommendation.consideredModes.length <= 1) {
    return {
      shouldExperiment: false,
      reason: "no_alternative",
      recommendedMode: recommendation.recommendedMode,
      sampleCountByMode: recommendation.statsByMode.map(({ mode, sampleCount }) => ({ mode, sampleCount })),
    };
  }

  if (recommendation.statsByMode.length === 0) {
    return {
      shouldExperiment: true,
      reason: "no_history",
      recommendedMode: recommendation.recommendedMode,
      challengerMode: recommendation.consideredModes.find((mode) => mode !== recommendation.recommendedMode),
      sampleCountByMode: [],
    };
  }

  const statsByMode = recommendation.statsByMode.map((stats) => ({ ...stats })).sort((left, right) => left.avgProcessingCostMs - right.avgProcessingCostMs || right.sampleCount - left.sampleCount);

  const recommendedStats = statsByMode.find((stats) => stats.mode === recommendation.recommendedMode) ?? statsByMode[0];
  const challengerStats = statsByMode.find((stats) => stats.mode !== recommendation.recommendedMode);
  const sampleCountByMode = statsByMode.map(({ mode, sampleCount }) => ({ mode, sampleCount }));

  if (!challengerStats) {
    return {
      shouldExperiment: false,
      reason: "no_alternative",
      recommendedMode: recommendation.recommendedMode,
      sampleCountByMode,
    };
  }

  if (statsByMode.some((stats) => stats.sampleCount < 20)) {
    return {
      shouldExperiment: true,
      reason: "low_sample",
      recommendedMode: recommendation.recommendedMode,
      challengerMode: challengerStats.mode,
      sampleCountByMode,
      costDeltaMs: challengerStats.avgProcessingCostMs - recommendedStats.avgProcessingCostMs,
    };
  }

  const costDeltaMs = challengerStats.avgProcessingCostMs - recommendedStats.avgProcessingCostMs;
  if (Math.abs(costDeltaMs) <= 250) {
    return {
      shouldExperiment: true,
      reason: "close_cost",
      recommendedMode: recommendation.recommendedMode,
      challengerMode: challengerStats.mode,
      sampleCountByMode,
      costDeltaMs,
    };
  }

  if (recommendation.basis === "heuristic" && recommendation.heuristic?.shouldPreferRewrite) {
    return {
      shouldExperiment: true,
      reason: "heuristic_probe",
      recommendedMode: recommendation.recommendedMode,
      challengerMode: challengerStats.mode,
      sampleCountByMode,
      costDeltaMs,
    };
  }

  return {
    shouldExperiment: false,
    reason: "stable_winner",
    recommendedMode: recommendation.recommendedMode,
    challengerMode: challengerStats.mode,
    sampleCountByMode,
    costDeltaMs,
  };
}

export function recordReqExecutionStats(stats: ReqExecutionStats, processingCostMs: number): void {
  const shapeKey = getReqShapeKey(stats.shape, stats.mode);
  const shapeAggregate = reqShapeAggregates.get(shapeKey) ?? createAggregate(shapeKey, stats.shape, stats.mode);
  updateAggregate(shapeAggregate, stats, processingCostMs);
  reqShapeAggregates.set(shapeKey, shapeAggregate);

  const signatureKey = getReqSignatureKey(stats.analysis.signature, stats.mode);
  const signatureAggregate = reqSignatureAggregates.get(signatureKey) ?? createAggregate(signatureKey, stats.shape, stats.mode, stats.analysis.signature);
  updateAggregate(signatureAggregate, stats, processingCostMs);
  reqSignatureAggregates.set(signatureKey, signatureAggregate);

  if (!shouldLogAggregate(shapeAggregate.sampleCount) && !shouldLogAggregate(signatureAggregate.sampleCount)) return;

  log("INFO", {
    msg: "REQ SHAPE STATS",
    shape: shapeAggregate.shape,
    shapeCounts: getShapeCounts(shapeAggregate.shape),
    ...toStatsSummary(shapeAggregate),
  });

  log("INFO", {
    msg: "REQ SIGNATURE STATS",
    shape: signatureAggregate.shape,
    shapeCounts: getShapeCounts(signatureAggregate.shape),
    signature: signatureAggregate.signature,
    ...toStatsSummary(signatureAggregate),
  });
}

type ReqShapeAggregateSnapshot = ReqShapeAggregate & { key: string };

function getSnapshot(): ReqShapeAggregateSnapshot[] {
  return [...reqShapeAggregates.values(), ...reqSignatureAggregates.values()].map((aggregate) => ({ ...aggregate, key: aggregate.key }));
}

export function loadReqPlannerStats(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof item.key !== "string") continue;
      const aggregate = {
        key: item.key,
        shape: item.shape,
        signature: item.signature,
        mode: item.mode,
        sampleCount: item.sampleCount,
        totalProcessingCostMs: item.totalProcessingCostMs,
        maxProcessingCostMs: item.maxProcessingCostMs,
        totalUpstreamEventCount: item.totalUpstreamEventCount,
        totalDownstreamEventCount: item.totalDownstreamEventCount,
      };
      if (typeof item.signature === "string") reqSignatureAggregates.set(item.key, aggregate);
      else reqShapeAggregates.set(item.key, aggregate);
    }
    log("INFO", { msg: "REQ SHAPE STATS LOADED", filePath, shapeAggregateCount: reqShapeAggregates.size, signatureAggregateCount: reqSignatureAggregates.size });
  } catch (error) {
    log("WARN", { msg: "REQ SHAPE STATS LOAD FAILED", filePath, error });
  }
}

export function persistReqPlannerStats(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(getSnapshot()));
    log("DEBUG", { msg: "REQ SHAPE STATS SAVED", filePath, shapeAggregateCount: reqShapeAggregates.size, signatureAggregateCount: reqSignatureAggregates.size });
  } catch (error) {
    log("WARN", { msg: "REQ SHAPE STATS SAVE FAILED", filePath, error });
  }
}
