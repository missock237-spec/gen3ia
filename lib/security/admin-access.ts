import "server-only";

import type { NextRequest } from "next/server";
import { HttpError } from "./http-errors";
import { requireUser, type AuthenticatedUser } from "./authenticated-request";

export async function requireAdmin(request: NextRequest): Promise<AuthenticatedUser> {
  const user = await requireUser(request);
  if (user.claims?.admin !== true) {
    // 403 explicite (et non 500 générique) : les clients distinguent
    // proprement « route protégée admin » d'une panne serveur.
    throw new HttpError(403, "Administrator access required.", "FORBIDDEN");
  }
  return user;
}
