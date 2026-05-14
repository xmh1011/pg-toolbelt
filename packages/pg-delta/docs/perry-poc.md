# PoC: Compiling pg-delta to a native binary with Perry (perryts.com)

> **Status:** Exploratory PoC, not merged into the build. Tested against
> `@perryts/perry` **0.5.891** on `linux-x64` with clang 18 / GCC 13.
> Date: 2026-05-14.

## TL;DR

Perry (a Rust-based TypeScript → LLVM AOT compiler) **almost** compiles the
pg-delta CLI today. The compiler successfully lowers ~250 of pg-delta's
TypeScript modules to native object files in a single pass. It fails on three
fronts that are unrelated to pg-delta's architecture:

1. **Three pg-delta modules hit unimplemented Perry codegen paths** —
   variadic `Array.push(...a, ...b, c)` with more than one spread, and
   `arr[i]++`-style `IndexUpdate` expressions. These are Perry bugs/TODOs, not
   pg-delta bugs.
2. **Most npm dependencies (`zod`, `@stricli/core`, `picomatch`, `debug`,
   `@ts-safeql/sql-tag`) fall back to Perry's V8/JS-runtime mode** rather
   than native compilation, which requires an extra `libperry_jsruntime.a`
   that is **not shipped in the npm package** at this version. So even with
   `--enable-js-runtime` the link step fails.
3. **The `pg` driver surface Perry exposes natively is far smaller than what
   pg-delta needs.** Perry's `pg` binding currently lists only
   `Client`, `Pool`, `connect`, `end`, `query`. pg-delta calls
   `pg.types.setTypeParser` on at least 9 OIDs in
   `src/core/postgres-config.ts`, plus `pg.Client.connect` event hooks,
   parameter binding (`$1`-style), notice/error listeners, and so on.

Net: **not viable as a native build today**, but the compiler gets
surprisingly close. With ~2-3 small upstream Perry fixes plus a handful of
pg-delta source workarounds, a pure-native CLI binary is plausible within a
release or two of Perry.

## What Perry is

[`perryts.com`](https://www.perryts.com/) — "Perry" — is a TypeScript-to-native
AOT compiler written in Rust. It parses TS with SWC and emits machine code via
LLVM (clang as the linker). Output is a single statically-linkable executable;
the hello-world is ~1.1 MB on linux-x64 in this PoC. There's an optional
embedded V8 fallback (`--enable-js-runtime`) for npm packages that haven't
been ported to Perry's native stdlib.

The model is appealing for pg-delta because pg-delta is essentially a CLI that
talks to two PostgreSQL connections and emits SQL — a profile Perry advertises
direct native support for (`pg` is on Perry's "natively supported" list).

## Reproducing the PoC

```bash
# from any scratch directory
mkdir /tmp/perry-poc && cd /tmp/perry-poc
npm init -y
npm install @perryts/perry            # installs the platform-specific binary
npx perry doctor                      # verifies clang + linker

# from the pg-toolbelt repo root
bun install                           # populates root node_modules (hoisted)
cd packages/pg-delta
/tmp/perry-poc/node_modules/.bin/perry check --check-deps src/cli/bin/cli.ts
#   -> All checks passed
/tmp/perry-poc/node_modules/.bin/perry compile src/cli/bin/cli.ts -o /tmp/pgdelta
#   -> stops at pg.setTypeParser unimplemented
PERRY_ALLOW_UNIMPLEMENTED=1 \
  /tmp/perry-poc/node_modules/.bin/perry compile src/cli/bin/cli.ts -o /tmp/pgdelta
#   -> 3 modules fail codegen, link fails on missing libperry_jsruntime.a
PERRY_ALLOW_UNIMPLEMENTED=1 \
  /tmp/perry-poc/node_modules/.bin/perry compile src/cli/bin/cli.ts \
    -o /tmp/pgdelta --enable-js-runtime
#   -> same link failure: libperry_jsruntime.a missing from npm distribution
```

> **Monorepo gotcha.** Perry looks for `node_modules/<pkg>` inside the package
> directory. Bun's workspace install hoists everything to the **repo root**
> `node_modules`. Perry walks up the directory tree to find it, so running
> `perry compile` from `packages/pg-delta` works as long as `bun install` was
> run at the root. From any other cwd, Perry reports `R003 Package not found`.

## Findings in detail

### 1. pg-delta TS source is mostly Perry-clean

After `bun install`, `perry check --check-deps src/cli/bin/cli.ts` returns
**zero errors and zero warnings**. The full `perry compile` then lowers the
following directories to native `.o` files without any TypeScript-level
complaint:

- `src/core/catalog*`, `src/core/depend.ts`, `src/core/expand-replace-dependencies.ts`
- All of `src/core/objects/**` — every change class for tables, views,
  materialized views, indexes, sequences, types, FDWs, triggers, rules,
  publications, subscriptions, policies, roles, schemas, etc.
- `src/core/plan/**` including the SQL formatter (`sql-format/**`)
- `src/core/sort/**` (except `topological-sort.ts`, see below)
- `src/core/integrations/**` (DSL, merge, serialize, filter)
- `src/cli/**` (commands, formatters, utils, exit-code)

That's ~250 native object files. The "no parser/AST library in the diff
path" rule from `CLAUDE.md` is paying off here — pg-delta's core is plain
TypeScript that Perry's lowering handles fine.

### 2. Three modules hit Perry codegen bugs

With `PERRY_ALLOW_UNIMPLEMENTED=1` the compiler emits empty stubs for these
and continues:

| File | Failure |
| --- | --- |
| `src/core/fingerprint.ts` (`collectStableIds`) | `array.push_spread expects exactly 1 arg, got 3` — Perry can't yet lower `arr.push(...a, ...b, c)` with more than one spread. |
| `src/core/objects/table/changes/table.alter.ts` (`AlterTableAddConstraint.requires` getter) | Same: `array.push_spread expects exactly 1 arg, got 2`. |
| `src/core/sort/topological-sort.ts` (`performStableTopologicalSort`) | `perry-codegen Phase 2: expression IndexUpdate not yet supported` — typically `arr[i]++` or `obj.x++`. |

All three are **Perry compiler TODOs**, not pg-delta bugs. They would either
be fixed upstream (`PerryTS/perry` issue tracker) or worked around in
pg-delta with trivial refactors:

- Replace `arr.push(...a, ...b)` with two `arr.push(...a); arr.push(...b);` calls.
- Replace `++` on index/property expressions with `x = x + 1` reads/writes.

The cost of those refactors is low and they would not regress readability much,
but they should be **gated on whether the Perry build is something we want to
support at all** rather than landed proactively.

### 3. Dependency story: most fall back to JS bundling

Even though `pg` is on Perry's "native" list, the actual `pg` API surface
Perry implements is *minimal*:

```
pg
  Classes: Client, Pool
  Methods: Pool (module), connect (module + Client instance),
           end (Pool instance + generic), query (Pool + generic)
```

pg-delta needs more than that. The first hard stop is `pg.types.setTypeParser`,
called nine times in `src/core/postgres-config.ts` to coerce numeric, bigint,
and array types. Other likely landmines (haven't been reached yet because the
compile errors out first):

- `pg.Client` event listeners (`on('notice', ...)`, `on('error', ...)`)
- Parameter binding via `query(text, values)` — Perry only lists `query`, doesn't
  document parameterized form
- `pg.escapeIdentifier`/`escapeLiteral` (if used in any code path; pg-delta
  predominantly assembles SQL via the tagged template anyway)
- `pg.Pool` connection-error events surfaced from the connection lifecycle

For the other deps, Perry's compile log shows them resolving to
`JS module:` lines, which means they go into a generated `__perry_js_bundle.js`
that requires `libperry_jsruntime.a`:

| Package | Why it falls back |
| --- | --- |
| `@stricli/core` | Not on Perry's native list; complex generic-heavy class trees. |
| `zod` | Heavy use of constructors / runtime introspection — Perry's docs explicitly recommend "keep as V8-interpreted" for libraries like this. |
| `@ts-safeql/sql-tag` | Pure ESM, but uses dynamic class wiring that Perry's static lowering doesn't track. |
| `debug` | Common-JS module; works fine under V8. |
| `picomatch` | Heavy regex / dynamic require; same. |
| `@supabase/pg-topo` | (Workspace package — only used in tests, but the import graph still pulls it.) Native-compilable in principle, hasn't been audited. |

This is the **biggest blocker** today: Perry's npm-distributed binary does not
ship `libperry_jsruntime.a`, so `--enable-js-runtime` fails to link with
`Error: JavaScript modules found but libperry_jsruntime.a not found.
Build it with: cargo build --release -p perry-jsruntime`. Until either (a)
Perry ships the JS runtime in the npm package, or (b) we convert/replace
those five packages with Perry-native equivalents, there is no path to a
working binary.

### 4. Dynamic imports

Perry warns (but does not fail) on the four dynamic `await import(...)` sites
in pg-delta:

```
src/core/catalog.model.ts:184  await import(\`./fixtures/empty-catalogs/postgres-${...}-baseline.json\`)
src/core/catalog.model.ts:192  await import("./catalog.snapshot.ts")
src/core/catalog.model.ts:201  await import("./catalog.snapshot.ts")
src/cli/utils/integrations.ts  await import(\`../../core/integrations/${name}.ts\`)
```

Perry returns `undefined` from these instead of fully resolving the module.
The `catalog.snapshot.ts` lazy import is a circular-import workaround that
can be lifted to a static `import` — the change is mechanical and matches
guidance in `CLAUDE.md`. The integration-loader path (`./integrations/${name}`)
is a deliberate plugin shape and a real design tension with AOT: a binary by
definition can't load TS files at runtime. For an AOT build we'd need to swap
this for a closed registry (e.g. a generated `integrations.ts` barrel that
statically imports `supabase`, etc.).

### 5. Binary-size and startup expectations

We never produced a final binary, so this is extrapolation:

- The native-only hello-world produced here was **1.1 MB**.
- Perry's own docs cite **~330 KB** hello-world / **~48 MB** with full stdlib,
  **~7 MB** for a non-trivial app like a MongoDB GUI.
- Pure-native pg-delta would land somewhere in the 5-15 MB range; with the V8
  fallback embedded for zod/stricli/etc., add ~15 MB.
- Startup is the more interesting win — there's no Node.js / Bun boot, no V8
  warmup for the natively compiled portions, and no `tsc` / loader hooks.

## Recommendation

**Don't take a hard dependency on Perry yet, but it's worth tracking.** The
concrete next steps if we want to revisit this in a quarter or two:

1. **File the three codegen bugs upstream** at
   `https://github.com/PerryTS/perry/issues` with minimal repros (push_spread
   variadic, IndexUpdate lowering). These are real Perry gaps that pg-delta
   only happened to hit; fixing them benefits everyone.
2. **Wait for Perry to ship `libperry_jsruntime.a`** in the npm package, or
   build it ourselves from source (`cargo build --release -p perry-jsruntime`)
   if we want to experiment further. Without it `--enable-js-runtime` is dead.
3. **Audit `pg-delta`'s `pg` usage** against Perry's manifest
   (`perry --print-api-manifest=markdown`) and either (a) push Perry to widen
   its `pg` binding (`setTypeParser`, event emitters, parameterized queries) or
   (b) refactor pg-delta to use only the supported subset and do client-side
   type coercion where possible. `setTypeParser` is the load-bearing one and
   would need a sanctioned replacement before the native build is realistic.
4. **Skip the AOT-hostile features for now:** the `./integrations/${name}.ts`
   plugin loader is the only piece of pg-delta with no natural AOT story.
   Any future "native pg-delta" build would have to bake the integration
   list in at compile time.

The exciting result of this PoC is how *little* code in pg-delta itself is
hostile to AOT compilation. The architecture is essentially Perry-ready —
the blockers all live in the ecosystem (Perry's stdlib coverage, the JS-runtime
distribution gap, and a few common npm libraries).

## Appendix: failure outputs (verbatim)

### Native-only compile (no `--enable-js-runtime`)

```
$ PERRY_ALLOW_UNIMPLEMENTED=1 perry compile src/cli/bin/cli.ts -o /tmp/pgdelta-bin
...
Warning: Dynamic import('./fixtures/empty-catalogs/postgres-15-16-baseline.json') not fully supported, returning undefined
Warning: Dynamic import('./catalog.snapshot.ts') not fully supported, returning undefined
Warning: Dynamic import('<dynamic>') not fully supported, returning undefined
Error compiling module 'core/fingerprint.ts': lowering function 'collectStableIds':
  array.push_spread expects exactly 1 arg, got 3
Error compiling module 'core/objects/table/changes/table.alter.ts':
  lowering getter 'AlterTableAddConstraint::requires':
  array.push_spread expects exactly 1 arg, got 2
Error compiling module 'core/sort/topological-sort.ts':
  lowering function 'performStableTopologicalSort':
  perry-codegen Phase 2: expression IndexUpdate not yet supported
⚠ 3 module(s) failed to compile — linking with empty stubs
Error: JavaScript modules found but libperry_jsruntime.a not found.
Build it with: cargo build --release -p perry-jsruntime
```

### Default compile (no `PERRY_ALLOW_UNIMPLEMENTED`)

```
Error: `pg.setTypeParser` is not implemented in Perry — see
`perry --print-api-manifest` for the supported surface, or set
`PERRY_ALLOW_UNIMPLEMENTED=1` to ignore. (#463)
```
