import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const userRouter = Router();

const PROFILE_COLUMNS =
  "user_id, display_name, organisation, tier, message_credits_used, credits_reset_date, tabular_model, claude_api_key, gemini_api_key";

function profileOut(row: any) {
  return {
    user_id: row.user_id,
    display_name: row.display_name ?? null,
    organisation: row.organisation ?? null,
    tier: row.tier ?? "Free",
    message_credits_used: row.message_credits_used ?? 0,
    credits_reset_date: row.credits_reset_date,
    tabular_model: row.tabular_model ?? "gemini-3-flash-preview",
    claude_api_key: row.claude_api_key ?? null,
    gemini_api_key: row.gemini_api_key ?? null,
  };
}

async function getProfile(userId: string) {
  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(error.message);
  return profileOut(data);
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
  try {
    res.json(await getProfile(res.locals.userId as string));
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : String(error) });
  }
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  try {
    res.json(await getProfile(res.locals.userId as string));
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : String(error) });
  }
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const updates: Record<string, unknown> = {};
  const body = req.body ?? {};

  if ("display_name" in body) updates.display_name = body.display_name ?? null;
  if ("organisation" in body) updates.organisation = body.organisation ?? null;
  if ("tabular_model" in body) updates.tabular_model = body.tabular_model;
  if ("claude_api_key" in body) updates.claude_api_key = body.claude_api_key ?? null;
  if ("gemini_api_key" in body) updates.gemini_api_key = body.gemini_api_key ?? null;
  if ("message_credits_used" in body)
    updates.message_credits_used = body.message_credits_used;
  if ("credits_reset_date" in body) updates.credits_reset_date = body.credits_reset_date;
  updates.updated_at = new Date().toISOString();

  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .update(updates)
    .eq("user_id", userId)
    .select(PROFILE_COLUMNS)
    .single();
  if (error || !data) {
    res.status(500).json({ detail: error?.message ?? "Profile update failed" });
    return;
  }
  res.json(profileOut(data));
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: (error as { message: string }).message });
  res.status(204).send();
});
