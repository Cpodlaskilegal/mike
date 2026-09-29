import type { Pool, PoolClient } from "pg";

export class TransactionFailure extends Error {
  constructor(
    readonly originalError: unknown,
    readonly rollbackConfirmed: boolean,
    readonly commitAttempted: boolean,
  ) {
    super("Database transaction failed");
  }
}

/** A COMMIT connection failure is indeterminate: never delete staged storage. */
export async function withTransaction<T>(
  database: Pick<Pool, "connect">,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  let commitAttempted = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    commitAttempted = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    let rollbackConfirmed = false;
    try {
      await client.query("ROLLBACK");
      rollbackConfirmed = !commitAttempted;
    } catch {
      discard = true;
    }
    discard ||= commitAttempted;
    throw new TransactionFailure(error, rollbackConfirmed, commitAttempted);
  } finally {
    client.release(discard);
  }
}
