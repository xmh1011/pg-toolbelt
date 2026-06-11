import { describe, expect, test } from "bun:test";
import { analyzeAndSort } from "../src/analyze-and-sort";
import { extractDependencies } from "../src/extract/extract-dependencies";
import { objectRefKey } from "../src/model/object-ref";

const emptyAnnotations = {
  dependsOn: [],
  requires: [],
  provides: [],
};

describe("ALTER PUBLICATION dependencies", () => {
  test("extracts continuation publication table and schema dependencies", () => {
    const tableResult = extractDependencies(
      "ALTER_PUBLICATION",
      {
        AlterPublicationStmt: {
          pubname: "pub_orders",
          action: "AP_AddObjects",
          pubobjects: [
            {
              PublicationObjSpec: {
                pubobjtype: "PUBLICATIONOBJ_TABLE",
                pubtable: {
                  relation: { schemaname: "public", relname: "orders" },
                },
              },
            },
            {
              PublicationObjSpec: {
                pubobjtype: "PUBLICATIONOBJ_CONTINUATION",
                pubtable: {
                  relation: { schemaname: "public", relname: "events" },
                },
              },
            },
          ],
        },
      },
      emptyAnnotations,
    );
    const schemaResult = extractDependencies(
      "ALTER_PUBLICATION",
      {
        AlterPublicationStmt: {
          pubname: "pub_sales",
          action: "AP_SetObjects",
          pubobjects: [
            {
              PublicationObjSpec: {
                pubobjtype: "PUBLICATIONOBJ_TABLES_IN_SCHEMA",
                name: "sales",
              },
            },
            {
              PublicationObjSpec: {
                pubobjtype: "PUBLICATIONOBJ_CONTINUATION",
                name: "marketing",
              },
            },
          ],
        },
      },
      emptyAnnotations,
    );

    expect(tableResult.requires.map(objectRefKey).sort()).toEqual(
      expect.arrayContaining([
        "publication::pub_orders:",
        "table:public:orders:",
        "table:public:events:",
      ]),
    );
    expect(schemaResult.requires.map(objectRefKey).sort()).toEqual(
      expect.arrayContaining([
        "publication::pub_sales:",
        "schema::sales:",
        "schema::marketing:",
      ]),
    );
  });

  test("orders ALTER PUBLICATION row filter after referenced function", async () => {
    const result = await analyzeAndSort([
      "alter publication pub_orders add table public.orders where (public.is_visible(id));",
      "create table public.orders(id int primary key);",
      "create publication pub_orders;",
      "create function public.is_visible(order_id int) returns boolean language sql immutable as $$ select true $$;",
    ]);
    const orderedSql = result.ordered.map((statement) =>
      statement.sql.toLowerCase(),
    );
    const functionIndex = orderedSql.findIndex((sql) =>
      sql.includes("create function public.is_visible"),
    );
    const alterPublicationIndex = orderedSql.findIndex((sql) =>
      sql.includes("alter publication pub_orders add table"),
    );

    expect(functionIndex).toBeGreaterThanOrEqual(0);
    expect(alterPublicationIndex).toBeGreaterThanOrEqual(0);
    expect(functionIndex).toBeLessThan(alterPublicationIndex);
    expect(
      result.graph.edges.some(
        (edge) =>
          edge.objectRef?.kind === "function" &&
          edge.objectRef.schema === "public" &&
          edge.objectRef.name === "is_visible",
      ),
    ).toBe(true);
  });
});
