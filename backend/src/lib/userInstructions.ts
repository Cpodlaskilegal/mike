import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 5000;

export function parseCustomInstructionsBody(
  body: unknown,
): { ok: true; instructions: string } | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "instructions") {
    return { ok: false, detail: "Expected only an instructions field" };
  }
  const raw = (body as { instructions?: unknown }).instructions;
  if (typeof raw !== "string") {
    return { ok: false, detail: "instructions must be a string" };
  }
  const instructions = raw.trim();
  if (instructions.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
    return {
      ok: false,
      detail: `instructions must be at most ${CUSTOM_INSTRUCTIONS_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, instructions };
}

function readInstructions(
  data: Record<string, unknown> | null,
  field: string,
): string {
  if (!data) return "";
  const instructions = data[field];
  if (typeof instructions !== "string") {
    throw new Error(`Invalid ${field} value in database`);
  }
  return instructions;
}

/** Fetch both current instruction sets for a user-facing assistant turn. */
export async function getEffectiveCustomInstructions(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<{ personalInstructions: string; firmInstructions: string }> {
  const [personal, firm] = await Promise.all([
    db
      .from("user_profiles")
      .select("personal_instructions")
      .eq("user_id", userId)
      .maybeSingle(),
    db
      .from("firm_instructions")
      .select("instructions")
      .eq("id", 1)
      .maybeSingle(),
  ]);
  if (personal.error) throw new Error("Unable to load personal instructions");
  if (firm.error) throw new Error("Unable to load firm instructions");
  return {
    personalInstructions: readInstructions(
      personal.data,
      "personal_instructions",
    ),
    firmInstructions: readInstructions(firm.data, "instructions"),
  };
}

export async function savePersonalInstructions(
  userId: string,
  instructions: string,
  db: Db = createServerSupabase(),
): Promise<string> {
  const { data, error } = await db
    .from("user_profiles")
    .upsert(
      {
        user_id: userId,
        personal_instructions: instructions,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select("personal_instructions")
    .single();
  if (error || !data) throw new Error("Unable to save personal instructions");
  return readInstructions(data, "personal_instructions");
}

export async function saveFirmInstructions(
  adminUserId: string,
  instructions: string,
  db: Db = createServerSupabase(),
): Promise<string> {
  const { data, error } = await db
    .from("firm_instructions")
    .upsert(
      {
        id: 1,
        instructions,
        updated_by_user_id: adminUserId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("instructions")
    .single();
  if (error || !data) throw new Error("Unable to save firm instructions");
  return readInstructions(data, "instructions");
}
