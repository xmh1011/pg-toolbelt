import { describe, expect, test } from "bun:test";
import { analyzeAndSort } from "../src/analyze-and-sort";
import { validateAnalyzeResultWithPostgres } from "./support/postgres-validation";

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const shuffleDeterministic = <T>(items: T[], seed: number): T[] => {
  const random = seededRandom(seed);
  const cloned = [...items];
  for (let index = cloned.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(random() * (index + 1));
    const current = cloned[index];
    cloned[index] = cloned[randomIndex] as T;
    cloned[randomIndex] = current as T;
  }
  return cloned;
};

const baseStatements = [
  "create schema app;",
  "create table app.items(id int primary key, name text, amount numeric);",
];

const assertAlterTableWaitsForExpressionFunction = async (
  statements: string[],
  seed: number,
  alterSqlNeedle: string,
): Promise<void> => {
  const result = await analyzeAndSort(shuffleDeterministic(statements, seed));
  const validation = await validateAnalyzeResultWithPostgres(result);
  const executionErrors = validation.diagnostics.filter(
    (diagnostic) => diagnostic.code === "RUNTIME_EXECUTION_ERROR",
  );
  const orderedSql = result.ordered.map((statement) =>
    statement.sql.toLowerCase(),
  );
  const functionIndex = orderedSql.findIndex((sql) =>
    sql.includes("create function app."),
  );
  const alterTableIndex = orderedSql.findIndex((sql) =>
    sql.includes(alterSqlNeedle),
  );

  expect(executionErrors).toHaveLength(0);
  expect(functionIndex).toBeGreaterThanOrEqual(0);
  expect(alterTableIndex).toBeGreaterThanOrEqual(0);
  expect(functionIndex).toBeLessThan(alterTableIndex);
};

describe("ALTER TABLE expression dependencies", () => {
  test("ADD COLUMN DEFAULT waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        ...baseStatements,
        "alter table app.items add column normalized text default app.normalize(name);",
        "create function app.normalize(input text) returns text language sql immutable as $$ select lower(input) $$;",
      ],
      28101,
      "add column normalized text default",
    );
  }, 120000);

  test("ALTER COLUMN SET DEFAULT waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        ...baseStatements,
        "alter table app.items add column normalized text;",
        "alter table app.items alter column normalized set default app.normalize(name);",
        "create function app.normalize(input text) returns text language sql immutable as $$ select lower(input) $$;",
      ],
      28102,
      "alter column normalized set default",
    );
  }, 120000);

  test("ADD CONSTRAINT CHECK waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        ...baseStatements,
        "alter table app.items add constraint items_name_check check (app.is_valid_name(name));",
        "create function app.is_valid_name(input text) returns boolean language sql immutable as $$ select input <> '' $$;",
      ],
      28103,
      "add constraint items_name_check check",
    );
  }, 120000);

  test("ADD CONSTRAINT EXCLUDE expression waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        "create extension btree_gist;",
        ...baseStatements,
        "alter table app.items add constraint items_bucket_excl exclude using gist ((app.bucket(amount)) with =);",
        "create function app.bucket(input numeric) returns numeric language sql immutable as $$ select floor(input) $$;",
      ],
      28106,
      "add constraint items_bucket_excl exclude using gist",
    );
  }, 120000);

  test("ADD CONSTRAINT EXCLUDE predicate waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        "create extension btree_gist;",
        ...baseStatements,
        "alter table app.items add constraint items_positive_excl exclude using gist (amount with =) where (app.is_positive(amount));",
        "create function app.is_positive(input numeric) returns boolean language sql immutable as $$ select input > 0 $$;",
      ],
      28107,
      "add constraint items_positive_excl exclude using gist",
    );
  }, 120000);

  test("ADD GENERATED column waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        ...baseStatements,
        "alter table app.items add column normalized text generated always as (app.normalize(name)) stored;",
        "create function app.normalize(input text) returns text language sql immutable as $$ select lower(input) $$;",
      ],
      28104,
      "generated always as",
    );
  }, 120000);

  test("ALTER COLUMN TYPE USING waits for referenced function", async () => {
    await assertAlterTableWaitsForExpressionFunction(
      [
        ...baseStatements,
        "alter table app.items alter column amount type text using app.stringify(amount);",
        "create function app.stringify(input numeric) returns text language sql immutable as $$ select input::text $$;",
      ],
      28105,
      "alter column amount type text using",
    );
  }, 120000);
});
