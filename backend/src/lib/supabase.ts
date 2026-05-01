import { Pool, type QueryResult } from "pg";

type DbError = { message: string };
type DbResult<T = any> = { data: any; error: DbError | null; count?: number | null };
type Filter = {
  kind: "eq" | "neq" | "in" | "contains" | "is" | "not";
  column: string;
  value: unknown;
  operator?: string;
};
type Order = { column: string; ascending: boolean; nullsFirst?: boolean };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.PGSSLMODE === "disable" || process.env.NODE_ENV === "development"
      ? undefined
      : { rejectUnauthorized: false },
});

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function selectList(columns: string | undefined): string {
  if (!columns || columns.trim() === "*") return "*";
  return columns
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(quoteIdent)
    .join(", ");
}

function normalizeRows<T extends Record<string, unknown>>(input: T | T[]): T[] {
  return Array.isArray(input) ? input : [input];
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined),
  );
}

function splitOrFilter(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < filter.length; i += 1) {
    const c = filter[i];
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(filter.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(filter.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

class QueryBuilder implements PromiseLike<DbResult<any>> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private columns = "*";
  private rows: Record<string, unknown>[] = [];
  private updates: Record<string, unknown> = {};
  private filters: Filter[] = [];
  private orFilter: string | null = null;
  private orders: Order[] = [];
  private maxRows: number | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private head = false;
  private countMode: "exact" | null = null;
  private conflictColumns: string[] = [];
  private ignoreDuplicates = false;

  constructor(private table: string) {}

  select(columns = "*", options?: { count?: "exact"; head?: boolean }) {
    this.columns = columns;
    this.head = !!options?.head;
    this.countMode = options?.count ?? null;
    return this;
  }

  insert(row: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = "insert";
    this.rows = normalizeRows(row).map(cleanRow);
    return this;
  }

  update(values: Record<string, unknown>) {
    this.op = "update";
    this.updates = cleanRow(values);
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  upsert(
    row: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    this.op = "upsert";
    this.rows = normalizeRows(row).map(cleanRow);
    this.conflictColumns =
      options?.onConflict?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
    this.ignoreDuplicates = !!options?.ignoreDuplicates;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.filters.push({ kind: "in", column, value });
    return this;
  }

  contains(column: string, value: unknown) {
    this.filters.push({ kind: "contains", column, value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.filters.push({ kind: "not", column, value, operator });
    return this;
  }

  or(filter: string) {
    this.orFilter = filter;
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
    });
    return this;
  }

  limit(count: number) {
    this.maxRows = count;
    return this;
  }

  single() {
    this.singleMode = "single";
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  then<TResult1 = DbResult<any>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private addWhere(values: unknown[]): string {
    const clauses = this.filters.map((filter) => {
      const column = quoteIdent(filter.column);
      if (filter.kind === "eq") {
        values.push(filter.value);
        return `${column} = $${values.length}`;
      }
      if (filter.kind === "neq") {
        values.push(filter.value);
        return `${column} <> $${values.length}`;
      }
      if (filter.kind === "in") {
        const items = Array.isArray(filter.value) ? filter.value : [];
        if (items.length === 0) return "false";
        const placeholders = items.map((item) => {
          values.push(item);
          return `$${values.length}`;
        });
        return `${column} in (${placeholders.join(", ")})`;
      }
      if (filter.kind === "is") {
        if (filter.value === null) return `${column} is null`;
        values.push(filter.value);
        return `${column} is not distinct from $${values.length}`;
      }
      if (filter.kind === "not") {
        if (filter.operator === "is" && filter.value === null) {
          return `${column} is not null`;
        }
        throw new Error(`Unsupported not() filter: ${filter.column}.${filter.operator}`);
      }
      values.push(
        typeof filter.value === "string"
          ? filter.value
          : JSON.stringify(filter.value),
      );
      return `${column} @> $${values.length}::jsonb`;
    });

    if (this.orFilter) {
      const orClauses = splitOrFilter(this.orFilter).map((part) =>
        this.parsePostgrestFilter(part, values),
      );
      if (orClauses.length) clauses.push(`(${orClauses.join(" or ")})`);
    }

    return clauses.length ? ` where ${clauses.join(" and ")}` : "";
  }

  private parsePostgrestFilter(part: string, values: unknown[]): string {
    const eqMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\.eq\.(.*)$/.exec(part);
    if (eqMatch) {
      values.push(eqMatch[2]);
      return `${quoteIdent(eqMatch[1])} = $${values.length}`;
    }
    const inMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\.in\.\((.*)\)$/.exec(part);
    if (inMatch) {
      const items = inMatch[2].split(",").map((v) => v.trim()).filter(Boolean);
      if (!items.length) return "false";
      const placeholders = items.map((item) => {
        values.push(item);
        return `$${values.length}`;
      });
      return `${quoteIdent(inMatch[1])} in (${placeholders.join(", ")})`;
    }
    throw new Error(`Unsupported or() filter: ${part}`);
  }

  private addOrderAndLimit(): string {
    const orderSql = this.orders.length
      ? ` order by ${this.orders
          .map((order) => {
            const nulls =
              order.nullsFirst == null
                ? ""
                : order.nullsFirst
                  ? " nulls first"
                  : " nulls last";
            return `${quoteIdent(order.column)} ${order.ascending ? "asc" : "desc"}${nulls}`;
          })
          .join(", ")}`
      : "";
    const limitSql = this.maxRows != null ? ` limit ${Number(this.maxRows)}` : "";
    return `${orderSql}${limitSql}`;
  }

  private async execute(): Promise<DbResult<any>> {
    try {
      const result =
        this.op === "select"
          ? await this.executeSelect()
          : this.op === "insert"
            ? await this.executeInsert(false)
            : this.op === "upsert"
              ? await this.executeInsert(true)
              : this.op === "update"
                ? await this.executeUpdate()
                : await this.executeDelete();
      return this.shapeResult(result);
    } catch (error) {
      return {
        data: null,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private async executeSelect(): Promise<QueryResult> {
    const values: unknown[] = [];
    const where = this.addWhere(values);
    if (this.countMode && this.head) {
      return pool.query(
        `select count(*)::int as count from ${quoteIdent(this.table)}${where}`,
        values,
      );
    }
    return pool.query(
      `select ${selectList(this.columns)} from ${quoteIdent(this.table)}${where}${this.addOrderAndLimit()}`,
      values,
    );
  }

  private async executeInsert(isUpsert: boolean): Promise<QueryResult> {
    if (this.rows.length === 0) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    const columns = [...new Set(this.rows.flatMap((row) => Object.keys(row)))];
    const values: unknown[] = [];
    const rowSql = this.rows.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(row[column] ?? null);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const conflictSql = isUpsert
      ? this.buildConflictSql(columns)
      : "";
    const returning = this.head ? "" : ` returning ${selectList(this.columns)}`;
    return pool.query(
      `insert into ${quoteIdent(this.table)} (${columns.map(quoteIdent).join(", ")}) values ${rowSql.join(", ")}${conflictSql}${returning}`,
      values,
    );
  }

  private buildConflictSql(columns: string[]): string {
    if (!this.conflictColumns.length) return "";
    const target = ` on conflict (${this.conflictColumns.map(quoteIdent).join(", ")})`;
    if (this.ignoreDuplicates) return `${target} do nothing`;
    const updateColumns = columns.filter((column) => !this.conflictColumns.includes(column));
    if (!updateColumns.length) return `${target} do nothing`;
    return `${target} do update set ${updateColumns
      .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
      .join(", ")}`;
  }

  private async executeUpdate(): Promise<QueryResult> {
    const columns = Object.keys(this.updates);
    const values: unknown[] = [];
    const setSql = columns.map((column) => {
      values.push(this.updates[column]);
      return `${quoteIdent(column)} = $${values.length}`;
    });
    const where = this.addWhere(values);
    const returning = this.head ? "" : ` returning ${selectList(this.columns)}`;
    return pool.query(
      `update ${quoteIdent(this.table)} set ${setSql.join(", ")}${where}${returning}`,
      values,
    );
  }

  private async executeDelete(): Promise<QueryResult> {
    const values: unknown[] = [];
    const where = this.addWhere(values);
    return pool.query(`delete from ${quoteIdent(this.table)}${where}`, values);
  }

  private shapeResult(result: QueryResult): DbResult<any> {
    if (this.countMode && this.head) {
      return { data: null, error: null, count: Number(result.rows[0]?.count ?? 0) };
    }
    if (this.singleMode) {
      const row = result.rows[0] ?? null;
      if (!row && this.singleMode === "single") {
        return { data: null, error: { message: "No rows found" } };
      }
      return { data: row, error: null };
    }
    return { data: result.rows, error: null };
  }
}

export function createServerSupabase() {
  return {
    from(table: string) {
      return new QueryBuilder(table);
    },
    auth: {
      admin: {
        async listUsers(..._args: any[]) {
          const { rows } = await pool.query(
            'select id, email from "app_users" order by "created_at" asc',
          );
          return { data: { users: rows }, error: null };
        },
        async deleteUser(userId: string) {
          await pool.query('delete from "app_users" where "id" = $1', [userId]);
          return { data: null, error: null };
        },
      },
    },
  };
}

export async function ensureAppUser(user: { id: string; email: string }) {
  await pool.query(
    `insert into "app_users" ("id", "email")
     values ($1, $2)
     on conflict ("id") do update set "email" = excluded."email", "updated_at" = now()`,
    [user.id, user.email],
  );
  await pool.query(
    `insert into "user_profiles" ("user_id")
     values ($1)
     on conflict ("user_id") do nothing`,
    [user.id],
  );
}

export { pool };
