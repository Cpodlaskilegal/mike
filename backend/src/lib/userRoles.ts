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

export async function getUserRoleStrict(
  db: Db,
  userId: string,
): Promise<AppUserRole> {
  const { data, error } = await db
    .from("app_users")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) {
    throw new Error("Docket could not verify the current user's role.");
  }
  const role = normalizeUserRole((data as { role?: unknown }).role);
  if (!role) throw new Error("Docket could not verify the current user's role.");
  return role;
}

export async function isAdminUser(db: Db, userId: string): Promise<boolean> {
  return (await getUserRole(db, userId)) === "admin";
}
