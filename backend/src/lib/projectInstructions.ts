import type { Pool } from "pg";
import { pool, type createServerSupabase } from "./supabase";
import { withTransaction, TransactionFailure } from "./databaseTransaction";
import { CUSTOM_INSTRUCTIONS_MAX_LENGTH } from "./userInstructions";

export type ProjectInstructionsState = {
  instructions: string;
  version: number;
  owner_user_id: string;
  can_edit: boolean;
};

export class ProjectInstructionsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function parseProjectInstructionsBody(body: unknown):
  { ok: true; instructions: string; expectedVersion: number } | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, detail: "Expected a JSON object" };
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "instructions" && key !== "expected_version") ||
    typeof value.instructions !== "string" || !Number.isInteger(value.expected_version) || Number(value.expected_version) < 0) {
    return { ok: false, detail: "Expected instructions and a non-negative expected_version" };
  }
  const instructions = value.instructions.trim();
  if (instructions.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
    return { ok: false, detail: `instructions must be at most ${CUSTOM_INSTRUCTIONS_MAX_LENGTH} characters` };
  }
  return { ok: true, instructions, expectedVersion: Number(value.expected_version) };
}

/** Caller authorizes current project membership before reading this state. */
export async function getProjectInstructions(projectId: string, userId: string, db: ReturnType<typeof createServerSupabase>): Promise<ProjectInstructionsState> {
  const { data, error } = await db.from("projects")
    .select("user_id, instructions, instruction_version").eq("id", projectId).maybeSingle();
  if (error) throw new Error("Unable to load project instructions");
  if (!data) throw new ProjectInstructionsError(404, "Project not found");
  if (typeof data.instructions !== "string" || !Number.isInteger(data.instruction_version)) {
    throw new Error("Invalid project instructions in database");
  }
  return { instructions: data.instructions, version: data.instruction_version, owner_user_id: data.user_id, can_edit: data.user_id === userId };
}

/** Ownership, optimistic version, content and history commit together. */
export async function saveProjectInstructions(input: {
  projectId: string; userId: string; userEmail: string; instructions: string; expectedVersion: number;
}, database: Pick<Pool, "connect"> = pool): Promise<ProjectInstructionsState> {
  try {
    return await withTransaction(database, async (client) => {
      const { rows } = await client.query("select user_id, instructions, instruction_version from projects where id = $1 for update", [input.projectId]);
      const project = rows[0];
      if (!project) throw new ProjectInstructionsError(404, "Project not found");
      if (project.user_id !== input.userId) throw new ProjectInstructionsError(403, "Only the project owner may edit project instructions");
      if (project.instruction_version !== input.expectedVersion) throw new ProjectInstructionsError(409, "Project instructions changed. Reload before saving your edit.");
      if (project.instructions === input.instructions) {
        return { instructions: project.instructions, version: project.instruction_version, owner_user_id: project.user_id, can_edit: true };
      }
      const version = project.instruction_version + 1;
      await client.query("update projects set instructions = $2, instruction_version = $3, updated_at = now() where id = $1", [input.projectId, input.instructions, version]);
      await client.query("insert into project_instruction_history (project_id, version, instructions, edited_by_user_id, editor_email) values ($1, $2, $3, $4, $5)", [input.projectId, version, input.instructions, input.userId, input.userEmail]);
      return { instructions: input.instructions, version, owner_user_id: project.user_id, can_edit: true };
    });
  } catch (error) {
    if (error instanceof TransactionFailure && error.rollbackConfirmed && !error.commitAttempted && error.originalError instanceof ProjectInstructionsError) throw error.originalError;
    throw error;
  }
}
