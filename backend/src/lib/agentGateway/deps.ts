// The outside world the Docket Agent gateway talks to, in one type, so the
// tests can swap every piece for a fake. Production values are set in
// routes/agentMcp.ts.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectorRow, Db } from "../mcp/types";

export type AgentGatewayDeps = {
  db: () => Db;
  now: () => number;
  /** Opens an MCP session to the connector as its owner. Default: withMcpClient. */
  withUpstreamClient: <T>(
    connector: ConnectorRow,
    run: (client: { callTool: Client["callTool"] }) => Promise<T>,
    db: Db,
  ) => Promise<T>;
  /** Refreshes the connector's stored sign-in. Throws when it cannot. */
  refreshUpstreamToken: (connector: ConnectorRow, db: Db) => Promise<void>;
  /** Runs one refresh per connector at a time. */
  withRefreshLock: <T>(connectorId: string, run: () => Promise<T>) => Promise<T>;
  /** Re-reads the connector's tool list from the upstream server. */
  refreshTools: (userId: string, connectorId: string, db: Db) => Promise<unknown>;
  /** Address check for a server URL before a row is pointed at it. */
  validateServerUrl: (url: string) => Promise<string>;
  /**
   * The stored Box access token of the connector's owner, for the Box file
   * routes. It only reads: the refresh is done before, under the lock.
   */
  boxAccessToken: (connector: ConnectorRow, db: Db) => Promise<string | null>;
  /** HTTP for the Box file routes. Default: the global fetch. */
  boxFetch: typeof fetch;
  /**
   * How long the Box upload routes wait, in milliseconds. Fixed values in
   * production; the tests shorten them.
   * - `bodyMs`: the whole upload body must have arrived by then. After it
   *   the request is given up and its place is free again.
   * - `unreadBodyGraceMs`: after an answer that did not wait for the body,
   *   the rest of the body may still arrive for this long. Then the
   *   connection is cut.
   */
  boxUploadTimeouts: { bodyMs: number; unreadBodyGraceMs: number };
};
