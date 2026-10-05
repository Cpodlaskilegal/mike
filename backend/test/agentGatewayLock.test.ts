// The lock that keeps two refreshes of one sign-in apart across backend
// replicas (withPostgresAdvisoryLock in upstreamAuth.ts).
//
// What these pin, and why:
// - The lock holder's connection never comes from the pool the web app's
//   queries use. It did, and a refresh needs that pool too: ten refreshes
//   at once each held one of its ten connections and waited for an
//   eleventh, and every query of the backend hung.
// - The lock is a transaction lock, so it cannot leak behind a connection
//   pooler in transaction mode and always goes when the connection goes.
// - A connection that drops while the lock is held or waited for must not
//   end the backend process. The pool does not listen for a lent-out
//   connection's errors, and Node ends a process on an 'error' event
//   nobody hears. It did: the lock code had no listener of its own.
// No real database: the connection is a stand-in that records what it is
// asked.

import "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  withPostgresAdvisoryLock,
  type LockClient,
} from "../src/lib/agentGateway/upstreamAuth";

class FakeClient implements LockClient {
  readonly statements: string[] = [];
  released = 0;
  private inTransaction = false;
  constructor(private readonly held: Map<string, FakeClient>) {}
  async query(text: string, values?: unknown[]) {
    this.statements.push(text);
    if (text === "begin") {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (text === "rollback" || text === "commit") {
      this.inTransaction = false;
      for (const [key, owner] of this.held) {
        if (owner === this) this.held.delete(key);
      }
      return { rows: [] };
    }
    if (text.includes("pg_try_advisory_xact_lock")) {
      assert.ok(this.inTransaction, "a transaction lock needs a transaction");
      const key = String(values?.[0]);
      const owner = this.held.get(key);
      if (owner && owner !== this) return { rows: [{ locked: false }] };
      this.held.set(key, this);
      return { rows: [{ locked: true }] };
    }
    throw new Error(`unexpected statement: ${text}`);
  }
  release() {
    this.released += 1;
  }
}

/** A fake database that knows which keys are locked, and by whom. */
function lockWorld() {
  const held = new Map<string, FakeClient>();
  const clients: FakeClient[] = [];
  const connect = async (): Promise<LockClient> => {
    const client = new FakeClient(held);
    clients.push(client);
    return client;
  };
  return { held, clients, connect };
}

test("the lock is taken in a transaction and ends with it", async () => {
  const world = lockWorld();
  const result = await withPostgresAdvisoryLock(
    "docket-agent-oauth:c1",
    async () => {
      assert.equal(world.held.size, 1, "held while the refresh runs");
      return "done";
    },
    world.connect,
  );
  assert.equal(result, "done");
  const [client] = world.clients;
  assert.deepEqual(client.statements, [
    "begin",
    "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
    "rollback",
  ]);
  assert.equal(client.released, 1);
  assert.equal(world.held.size, 0);
});

test("a failing refresh still ends the transaction and gives the connection back", async () => {
  const world = lockWorld();
  await assert.rejects(
    withPostgresAdvisoryLock(
      "docket-agent-oauth:c1",
      async () => {
        throw new Error("invalid_grant");
      },
      world.connect,
    ),
    /invalid_grant/,
  );
  assert.equal(world.clients[0].statements.at(-1), "rollback");
  assert.equal(world.clients[0].released, 1);
  assert.equal(world.held.size, 0);
});

test("a second holder waits for the first; different connectors do not wait", async () => {
  const world = lockWorld();
  const order: string[] = [];
  let letFirstGo!: () => void;
  const firstMayEnd = new Promise<void>((done) => {
    letFirstGo = done;
  });
  const first = withPostgresAdvisoryLock(
    "docket-agent-oauth:c1",
    async () => {
      order.push("first in");
      await firstMayEnd;
      order.push("first out");
    },
    world.connect,
  );
  const second = withPostgresAdvisoryLock(
    "docket-agent-oauth:c1",
    async () => {
      order.push("second in");
    },
    world.connect,
  );
  await withPostgresAdvisoryLock(
    "docket-agent-oauth:c2",
    async () => {
      order.push("other connector");
    },
    world.connect,
  );
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(order, ["first in", "other connector"]);
  letFirstGo();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first in", "other connector", "first out", "second in"]);
  assert.ok(world.clients.every((client) => client.released === 1));
});

test("a lock that never comes free times out, and the connection is given back", async () => {
  const world = lockWorld();
  let letHolderGo!: () => void;
  const holder = withPostgresAdvisoryLock(
    "docket-agent-oauth:c1",
    () =>
      new Promise<void>((done) => {
        letHolderGo = done;
      }),
    world.connect,
  );
  await new Promise((done) => setTimeout(done, 20));
  let ran = false;
  await assert.rejects(
    withPostgresAdvisoryLock(
      "docket-agent-oauth:c1",
      async () => {
        ran = true;
      },
      world.connect,
      300,
    ),
    /Timed out waiting for the sign-in refresh lock/,
  );
  assert.equal(ran, false);
  assert.equal(world.clients[1].released, 1);
  assert.equal(world.clients[1].statements.at(-1), "rollback");
  letHolderGo();
  await holder;
});

test("a connection that cannot be had fails the refresh and holds nothing", async () => {
  await assert.rejects(
    withPostgresAdvisoryLock(
      "docket-agent-oauth:c1",
      async () => "never",
      async () => {
        throw new Error("timeout exceeded when trying to connect");
      },
    ),
    /timeout exceeded/,
  );
});

/**
 * A lent-out connection as the real one behaves: an event emitter with no
 * 'error' listener of the pool's while it is checked out, whose queries
 * fail once the connection is gone.
 */
class DroppableClient extends EventEmitter implements LockClient {
  readonly statements: string[] = [];
  readonly releases: Array<boolean | undefined> = [];
  private gone = false;
  async query(text: string) {
    if (this.gone) throw new Error("Connection terminated unexpectedly");
    this.statements.push(text);
    return { rows: text.includes("pg_try_advisory_xact_lock") ? [{ locked: true }] : [] };
  }
  release(destroy?: boolean) {
    this.releases.push(destroy);
  }
  /** What the database does on a restart or a failover. */
  drop() {
    this.gone = true;
    // With no listener this throws, as an unheard 'error' event ends Node.
    this.emit("error", new Error("Connection terminated unexpectedly"));
  }
}

test("a connection that drops while the lock is held does not end the process", async () => {
  const client = new DroppableClient();
  assert.equal(client.listenerCount("error"), 0, "as lent out by the pool");
  const result = await withPostgresAdvisoryLock(
    "docket-agent-oauth:c1",
    async () => {
      assert.equal(client.listenerCount("error"), 1, "the lock listens while it holds");
      client.drop();
      return "the refresh still finished";
    },
    async () => client,
  );
  assert.equal(result, "the refresh still finished");
  // Nothing more is asked of a dead connection, it is closed and not handed
  // out again, and the lock's listener is gone with it.
  assert.deepEqual(client.statements, [
    "begin",
    "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
  ]);
  assert.deepEqual(client.releases, [true]);
  assert.equal(client.listenerCount("error"), 0);
});

test("a connection that drops while the lock is waited for fails that refresh only", async () => {
  class Waiting extends DroppableClient {
    async query(text: string) {
      const answer = await super.query(text);
      if (!text.includes("pg_try_advisory_xact_lock")) return answer;
      // Someone else holds the lock. The connection drops during the wait.
      setTimeout(() => this.drop(), 20);
      return { rows: [{ locked: false }] };
    }
  }
  const client = new Waiting();
  let ran = false;
  await assert.rejects(
    withPostgresAdvisoryLock(
      "docket-agent-oauth:c1",
      async () => {
        ran = true;
      },
      async () => client,
    ),
    /Connection terminated unexpectedly/,
  );
  assert.equal(ran, false);
  assert.deepEqual(client.releases, [true]);
  assert.equal(client.listenerCount("error"), 0);
});

test("a connection that did not drop goes back to the pool as before, with no listener left on it", async () => {
  const client = new DroppableClient();
  await withPostgresAdvisoryLock("docket-agent-oauth:c1", async () => "done", async () => client);
  assert.deepEqual(client.statements.at(-1), "rollback");
  assert.deepEqual(client.releases, [undefined]);
  assert.equal(client.listenerCount("error"), 0);
});

test("the lock never borrows a connection from the web app's pool", () => {
  const text = readFileSync(
    resolve(import.meta.dirname, "../src/lib/agentGateway/upstreamAuth.ts"),
    "utf8",
  );
  // The shared pool is not imported here at all.
  assert.doesNotMatch(text, /from "\.\.\/supabase"/);
  assert.doesNotMatch(text, /\bpool\.connect\(\)/);
  // Its own pool is small and a wait for it ends.
  assert.match(text, /lockPool = new Pool\(\{/);
  assert.match(text, /max: LOCK_POOL_SIZE,/);
  assert.match(text, /connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS,/);
  assert.match(text, /const LOCK_POOL_SIZE = 3;/);
  // A transaction lock, never a session lock.
  assert.match(text, /pg_try_advisory_xact_lock\(/);
  assert.doesNotMatch(text, /pg_try_advisory_lock\(|pg_advisory_unlock\(/);
  // The production lock is still the default of the gateway.
  assert.match(
    text,
    /withPostgresAdvisoryLock\(\s*`docket-agent-oauth:\$\{connectorId\}`,\s*run,\s*\)/,
  );
});
