import type {
  McpApprovalPool,
  McpApprovalRow,
} from "../../src/lib/mcp/approvals";
import type { McpToolEvent } from "../../src/lib/mcp/types";

type QueryResult<T> = Promise<{ rows: T[] }>;

export class MemoryApprovalPool implements McpApprovalPool {
  readonly rows = new Map<string, McpApprovalRow>();

  async connect() {
    return {
      query: <T = Record<string, unknown>>(text: string, values?: unknown[]) =>
        this.query<T>(text, values),
      release() {},
    };
  }

  async query<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): QueryResult<T> {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [] };
    }

    if (sql.startsWith("insert into user_mcp_tool_approvals")) {
      const requestKey = String(values[1]);
      const existing = [...this.rows.values()].find(
        (row) => row.request_key === requestKey,
      );
      if (existing) return { rows: [] };
      const now = values[21] as Date;
      const row: McpApprovalRow = {
        id: String(values[0]),
        request_key: requestKey,
        user_id: String(values[2]),
        actor_email: String(values[22]),
        connector_id: String(values[3]),
        tool_id: String(values[4]),
        connector_name: String(values[5]),
        tool_name: String(values[6]),
        openai_tool_name: String(values[7]),
        encrypted_arguments: String(values[8]),
        arguments_iv: String(values[9]),
        arguments_tag: String(values[10]),
        arguments_hash: String(values[11]),
        arguments_preview: JSON.parse(String(values[12])) as Record<
          string,
          unknown
        >,
        policy_version: String(values[13]),
        status: "pending",
        chat_id: values[14] ? String(values[14]) : null,
        assistant_message_id: values[15] ? String(values[15]) : null,
        assistant_run_id: values[16] ? String(values[16]) : null,
        trace_id: values[17] ? String(values[17]) : null,
        project_id: values[18] ? String(values[18]) : null,
        tool_call_id: values[19] ? String(values[19]) : null,
        expires_at: values[20] as Date,
        decided_at: null,
        executed_at: null,
        error_message: null,
        result_event: null,
        result_content: null,
        created_at: now,
        updated_at: now,
      };
      this.rows.set(row.id, row);
      return { rows: [row as T] };
    }

    if (
      sql.startsWith("select * from user_mcp_tool_approvals") &&
      sql.includes("request_key = $1")
    ) {
      const row = [...this.rows.values()].find(
        (candidate) =>
          candidate.request_key === String(values[0]) &&
          candidate.user_id === String(values[1]),
      );
      return { rows: row ? [row as T] : [] };
    }

    if (
      sql.startsWith("select * from user_mcp_tool_approvals") &&
      sql.includes("id = $1") &&
      sql.includes("user_id = $2")
    ) {
      const row = this.rows.get(String(values[0]));
      return {
        rows: row && row.user_id === String(values[1]) ? [row as T] : [],
      };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'expired'")
    ) {
      const row = this.rows.get(String(values[0]));
      const userMatches =
        !sql.includes("user_id = $2") || row?.user_id === String(values[1]);
      if (
        row &&
        userMatches &&
        row.status === "pending" &&
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        row.status = "expired";
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("execution status is indeterminate")
    ) {
      const row = this.rows.get(String(values[0]));
      if (
        row &&
        row.user_id === String(values[1]) &&
        row.status === "executing" &&
        new Date(row.updated_at).getTime() <= Date.now() - Number(values[2])
      ) {
        row.status = "indeterminate";
        row.executed_at = new Date();
        row.error_message =
          "Execution status is indeterminate because Docket did not receive a final completion record. Verify the action in PracticePanther before attempting it again.";
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'failed'") &&
      sql.includes("integrity validation")
    ) {
      const row = this.rows.get(String(values[0]));
      if (row) {
        row.status = "failed";
        row.error_message =
          "Stored approval arguments failed integrity validation";
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'executing'")
    ) {
      const row = this.rows.get(String(values[0]));
      if (!row || row.status !== "pending") return { rows: [] };
      row.status = "executing";
      row.decided_at = new Date();
      row.updated_at = new Date();
      return { rows: [row as T] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'rejected'")
    ) {
      const row = this.rows.get(String(values[0]));
      if (!row || row.status !== "pending") return { rows: [] };
      row.status = "rejected";
      row.decided_at = new Date();
      row.updated_at = new Date();
      return { rows: [row as T] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = $3")
    ) {
      const row = this.rows.get(String(values[0]));
      if (
        !row ||
        row.user_id !== String(values[1]) ||
        row.status !== "executing"
      ) {
        return { rows: [] };
      }
      row.status = values[2] as "succeeded" | "failed" | "indeterminate";
      row.executed_at = new Date();
      row.error_message = values[3] ? String(values[3]) : null;
      row.result_event = values[4]
        ? (JSON.parse(String(values[4])) as McpToolEvent)
        : null;
      row.result_content = values[5] ? String(values[5]) : null;
      row.updated_at = new Date();
      return { rows: [row as T] };
    }

    throw new Error(`Unexpected approval SQL in test: ${sql}`);
  }
}
