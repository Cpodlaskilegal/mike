import type { RequestHandler } from "express";
import { createServerSupabase } from "../lib/supabase";
import { isAdminUser } from "../lib/userRoles";

export type AdminAuthorizer = (userId: string) => Promise<boolean>;

export function createRequireAdmin(authorize: AdminAuthorizer): RequestHandler {
  return async (_req, res, next) => {
    const userId =
      typeof res.locals.userId === "string" ? res.locals.userId : null;

    if (!userId) {
      res.status(403).json({ detail: "Admin access required" });
      return;
    }

    try {
      if (!(await authorize(userId))) {
        res.status(403).json({ detail: "Admin access required" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireAdmin = createRequireAdmin((userId) =>
  isAdminUser(createServerSupabase(), userId),
);
