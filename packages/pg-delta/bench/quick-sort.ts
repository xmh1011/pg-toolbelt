/**
 * Fast-iteration sort bench against the long-running benchmark database
 * (`bench:serve-db`). Times each phase of `sortChanges`:
 *   - logicalSort
 *   - graph build
 *   - constraint conversion
 *   - cycle detection / breaking loop
 *   - performStableTopologicalSort
 *
 * Usage:
 *   bun bench/serve-db.ts > /tmp/bench-db.log 2>&1 &
 *   export BENCH_DB_URL="$(grep '^READY url=' /tmp/bench-db.log | sed 's/READY url=//')"
 *   bun bench/quick-sort.ts
 */

import { diffCatalogs } from "../src/core/catalog.diff.ts";
import {
  createEmptyCatalog,
  extractCatalog,
} from "../src/core/catalog.model.ts";
import { createPool } from "../src/core/postgres-config.ts";
import { generateCustomConstraints } from "../src/core/sort/custom-constraints.ts";
import {
  buildGraphData,
  convertCatalogDependenciesToConstraints,
  convertConstraintsToEdges,
  convertExplicitRequirementsToConstraints,
  edgesToPairs,
} from "../src/core/sort/graph-builder.ts";
import { dedupeEdges } from "../src/core/sort/graph-utils.ts";
import { logicalSort } from "../src/core/sort/logical-sort.ts";
import { sortChanges } from "../src/core/sort/sort-changes.ts";
import {
  findCycle,
  performStableTopologicalSort,
} from "../src/core/sort/topological-sort.ts";
import { getExecutionPhase, type Phase } from "../src/core/sort/utils.ts";

const url = process.env.BENCH_DB_URL;
if (!url) {
  console.error(
    "BENCH_DB_URL not set. Start `bun bench/serve-db.ts` first and export the URL.",
  );
  process.exit(1);
}

const ITERS = Number(process.env.BENCH_ITERS ?? "5");
const WARMUP = Number(process.env.BENCH_WARMUP ?? "2");

const pool = createPool(url, { connectionTimeoutMillis: 30_000 });

function nsToMs(ns: number): string {
  return (ns / 1e6).toFixed(2);
}
function median(nums: readonly number[]): number {
  if (nums.length === 0) return Number.NaN;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

try {
  console.log(
    `bench:quick-sort — url=${url.replace(/:[^@]+@/, ":***@")}, iters=${ITERS} warmup=${WARMUP}`,
  );

  // Setup: extract real catalog once; diff against an empty baseline to get
  // a realistic Change[] list (this matches `bench:e2e`'s shape).
  const branchCat = await extractCatalog(pool);
  const fromCat = await createEmptyCatalog(
    branchCat.version,
    branchCat.currentUser,
  );
  const changes = diffCatalogs(fromCat, branchCat, {});
  console.log(`Total changes from diffCatalogs: ${changes.length}`);

  // Pre-split into phases (same as sort-changes.ts internal logic) so we can
  // measure the create_alter_object phase (the dominant one) in isolation.
  const logicallySorted = logicalSort(changes);
  const phasesArr: Record<Phase, ReturnType<typeof logicalSort>> = {
    drop: [],
    create_alter_object: [],
  };
  for (const c of logicallySorted) phasesArr[getExecutionPhase(c)].push(c);
  const createAlterChanges = phasesArr.create_alter_object;
  const dropChanges = phasesArr.drop;
  console.log(
    `  create_alter: ${createAlterChanges.length} | drop: ${dropChanges.length}`,
  );

  // Top-level sortChanges p50
  const totalSamples: number[] = [];
  for (let i = 0; i < WARMUP + ITERS; i++) {
    const t = Bun.nanoseconds();
    sortChanges({ mainCatalog: fromCat, branchCatalog: branchCat }, changes);
    if (i >= WARMUP) totalSamples.push(Bun.nanoseconds() - t);
  }
  console.log(
    `\nsortChanges total p50: **${nsToMs(median(totalSamples))} ms**\n`,
  );

  // Replicate exactly what sortChanges does, with timing for each line.
  for (let i = 0; i < WARMUP; i++) {
    sortChanges({ mainCatalog: fromCat, branchCatalog: branchCat }, changes);
  }
  {
    const tA = Bun.nanoseconds();
    const lsLocal = logicalSort(changes);
    const tB = Bun.nanoseconds();

    const phasesArrLocal: Record<Phase, ReturnType<typeof logicalSort>> = {
      drop: [],
      create_alter_object: [],
    };
    for (const c of lsLocal) phasesArrLocal[getExecutionPhase(c)].push(c);
    const tC = Bun.nanoseconds();

    const dropPhase = phasesArrLocal.drop;
    const caPhase = phasesArrLocal.create_alter_object;

    // sortPhaseChanges(drop) — usually empty, fast
    const tD = Bun.nanoseconds();

    // attemptSortRound on create_alter
    const graphData = buildGraphData(caPhase, {});
    const tE = Bun.nanoseconds();
    const catC = convertCatalogDependenciesToConstraints(
      branchCat.depends,
      graphData,
    );
    const tF = Bun.nanoseconds();
    const expC = convertExplicitRequirementsToConstraints(caPhase, graphData);
    const tG = Bun.nanoseconds();
    const cusC = generateCustomConstraints(caPhase);
    const tH = Bun.nanoseconds();
    const allC = [...catC, ...expC, ...cusC];
    const tI = Bun.nanoseconds();
    const cEdges = convertConstraintsToEdges(allC, {});
    const tJ = Bun.nanoseconds();
    const dEdges = dedupeEdges(cEdges);
    const tK = Bun.nanoseconds();
    const ePairs = edgesToPairs(dEdges);
    const tL = Bun.nanoseconds();
    findCycle(caPhase.length, ePairs);
    const tM = Bun.nanoseconds();
    performStableTopologicalSort(caPhase.length, ePairs);
    const tN = Bun.nanoseconds();

    void dropPhase;
    console.log("Per-line breakdown of one sortChanges call (single-shot):");
    console.log(`  logicalSort                 : ${nsToMs(tB - tA)} ms`);
    console.log(`  partition into phases       : ${nsToMs(tC - tB)} ms`);
    console.log(`  drop (no-op since 0 changes): ${nsToMs(tD - tC)} ms`);
    console.log(`  buildGraphData              : ${nsToMs(tE - tD)} ms`);
    console.log(
      `  catalog → Constraints       : ${nsToMs(tF - tE)} ms (${catC.length} rows)`,
    );
    console.log(
      `  explicit → Constraints      : ${nsToMs(tG - tF)} ms (${expC.length} rows)`,
    );
    console.log(
      `  custom Constraints          : ${nsToMs(tH - tG)} ms (${cusC.length} rows)`,
    );
    console.log(`  spread allConstraints       : ${nsToMs(tI - tH)} ms`);
    console.log(`  Constraints → edges         : ${nsToMs(tJ - tI)} ms`);
    console.log(`  dedupeEdges                 : ${nsToMs(tK - tJ)} ms`);
    console.log(`  edgesToPairs                : ${nsToMs(tL - tK)} ms`);
    console.log(`  findCycle                   : ${nsToMs(tM - tL)} ms`);
    console.log(`  performStableTopologicalSort: ${nsToMs(tN - tM)} ms`);
    console.log(`  TOTAL accounted             : ${nsToMs(tN - tA)} ms`);
  }

  // Per-phase breakdown — build graph, convert constraints, run topo sort.
  const phaseLogicalSamples: number[] = [];
  const phaseGraphBuildSamples: number[] = [];
  const phaseConstraintsSamples: number[] = [];
  const phaseDedupeSamples: number[] = [];
  const phaseCycleSamples: number[] = [];
  const phaseTopoSortSamples: number[] = [];
  let edgeCount = 0;
  let constraintCount = 0;

  for (let i = 0; i < WARMUP + ITERS; i++) {
    const t0 = Bun.nanoseconds();
    const ls = logicalSort(changes);
    const t1 = Bun.nanoseconds();

    const phaseChanges = ls.filter(
      (c) => getExecutionPhase(c) === "create_alter_object",
    );
    const t2 = Bun.nanoseconds();
    const graphData = buildGraphData(phaseChanges, {});
    const t3 = Bun.nanoseconds();

    const catalogConstraints = convertCatalogDependenciesToConstraints(
      branchCat.depends,
      graphData,
    );
    const explicitConstraints = convertExplicitRequirementsToConstraints(
      phaseChanges,
      graphData,
    );
    const customConstraints = generateCustomConstraints(phaseChanges);
    const allConstraints = [
      ...catalogConstraints,
      ...explicitConstraints,
      ...customConstraints,
    ];
    const t4 = Bun.nanoseconds();

    const edges = dedupeEdges(convertConstraintsToEdges(allConstraints, {}));
    const t5 = Bun.nanoseconds();

    const edgePairs = edgesToPairs(edges);
    findCycle(phaseChanges.length, edgePairs);
    const t6 = Bun.nanoseconds();

    performStableTopologicalSort(phaseChanges.length, edgePairs);
    const t7 = Bun.nanoseconds();

    if (i >= WARMUP) {
      phaseLogicalSamples.push(t1 - t0);
      phaseGraphBuildSamples.push(t3 - t2);
      phaseConstraintsSamples.push(t4 - t3);
      phaseDedupeSamples.push(t5 - t4);
      phaseCycleSamples.push(t6 - t5);
      phaseTopoSortSamples.push(t7 - t6);
      edgeCount = edges.length;
      constraintCount = allConstraints.length;
    }
  }

  console.log(
    `create_alter phase breakdown (${createAlterChanges.length} changes, ${constraintCount} constraints, ${edgeCount} edges):`,
  );
  console.log(
    `  logicalSort                 : ${nsToMs(median(phaseLogicalSamples))} ms`,
  );
  console.log(
    `  buildGraphData              : ${nsToMs(median(phaseGraphBuildSamples))} ms`,
  );
  console.log(
    `  convert*ToConstraints       : ${nsToMs(median(phaseConstraintsSamples))} ms`,
  );
  console.log(
    `  dedupeEdges                 : ${nsToMs(median(phaseDedupeSamples))} ms`,
  );
  console.log(
    `  findCycle                   : ${nsToMs(median(phaseCycleSamples))} ms`,
  );
  console.log(
    `  performStableTopologicalSort: ${nsToMs(median(phaseTopoSortSamples))} ms`,
  );
} finally {
  await pool.end();
}
