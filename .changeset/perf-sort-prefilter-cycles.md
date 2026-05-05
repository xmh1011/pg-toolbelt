---
"@supabase/pg-delta": minor
---

perf(sortChanges): 97% wall-time reduction by pre-filtering sequence-ownership 2-cycles

`sortChanges` previously spent ~75% of `bench:e2e`'s wall time inside
`attemptSortRound`'s cycle-breaking loop. On a 400-table benchmark that
loop ran **404 iterations** (one per sequence-owned column), each
iteration paying a full `findCycle` + `getEdgesInCycle` + `edges.filter`
sweep over the ~22 000-edge dependency graph. Total observed: 1505 ms.

Inspection showed every iteration found the **same shape of cycle**: a
`sequence:X -> column:Y` ownership edge paired with the reverse
`column:Y -> sequence:X` default-expression edge. The only filter rule
the cycle-breaker applies (`shouldFilterSequenceOwnershipDependency`) is
intrinsic to that pair plus a `CreateSequence`-OWNED-BY check on
`phaseChanges` — it doesn't depend on which other edges happen to share
the cycle. So the per-cycle inspection was paying a quadratic cost to
discover something an O(E) sweep can decide once.

`preemptivelyFilterIntrinsicallyBreakableEdges` (new) runs ahead of the
cycle loop. For every edge it:

1. Checks the existing `shouldFilterStableIdDependencyForCycleBreaking`
   rule (custom-source edges and edges without a `dependentStableId`
   are skipped, just like before).
2. **Only drops the edge if the reverse edge `target -> source` is also
   present in the same edge list.** That reverse-edge check is the
   correctness invariant: it proves a 2-cycle actually exists in this
   plan. Edges that match the rule but live outside any cycle (e.g.
   a stand-alone `ALTER SEQUENCE OWNED BY` with no matching column
   default) are left alone, exactly as the original per-cycle filter
   would have decided.

The existing `findCycle`/`filterEdgesForCycleBreaking` loop is kept as
a safety net for any cycle the pre-pass can't decide locally (none in
the current rule set, but the architecture stays open to additions).

Bench numbers (`bench:e2e`, pg17, N=400, post-base-init synthetic schema):

| metric                 | before                       | after            |
| ---------------------- | ---------------------------- | ---------------- |
| `sortChanges` wall     | 1505 ms (1486-1567 range)    | **42 ms (-97%)** |
| cycle-loop iterations  | 404                          | 1                |
| `bench:e2e` total      | 8448 ms (was 8331 baseline)  | **542 ms (-94%)**|

`bench:e2e-mutations` wins similarly — twin-schema scenario drops from
13 478 ms → 788 ms (-94%), branch-mutations from 23 803 ms → 759 ms
(-97%), since both extracts and the sort each now compute in tens of
milliseconds.

After this change, `extract` and `diff` are the two largest remaining
phases in `bench:e2e` (54% and 26%). The sort phase is no longer
worth optimising further on this workload.

Tests: all 1064 unit tests + 90 dependency/cycle/ordering integration
tests pass (`dependencies-cycles`, `complex-dependency-ordering`,
`fk-constraint-ordering`, `index-extension-deps`, `depend-extraction`,
`catalog-model`, `default-privileges-*`, `check-constraint-ordering`,
`ordering-validation`, `mixed-objects`, `overloaded-functions-roundtrip`,
`declarative-apply`).

Refs #250.

Also adds `bench:quick-sort` — fast-iteration sort bench against the
long-running `bench:serve-db` (~1s/run vs ~5min for a fresh-container
e2e run).
