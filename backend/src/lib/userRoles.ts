import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type AppUserRole = "user" | "admin";

export function normalizeUserRole(value: unknown): AppUserRole | null {
  return value === "admin" || value === "user" ? value : null;
}

export async function getUserRole(
  db: Db,
  userId: string,
): Promise<AppUserRole> {
  const { data } = await db
    .from("app_users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  return normalizeUserRole((data as { role?: unknown } | null)?.role) ?? "user";
}

export async function isAdminUser(db: Db, userId: string): Promise<boolean> {
  return (await getUserRole(db, userId)) === "admin";
}

