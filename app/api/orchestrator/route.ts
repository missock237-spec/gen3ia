import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { coordinateTeamExecution } from "@/lib/orchestrator/team-coordination";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

const RequestSchema = z.object({
  teamId: z.string().trim().min(1).max(256),
  objective: z.string().trim().min(1).max(20_000),
  context: z.record(z.string(), z.unknown()).optional(),
  customerId: z.string().trim().min(1).max(256).optional(),
  requestedRoles: z.array(z.enum(["customer_service", "sales", "content", "admin", "analytics"])).max(5).optional(),
});

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const body = RequestSchema.parse(await request.json());
    const result = await coordinateTeamExecution({ userId: token.uid, ...body });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    // Cloisonnement équipe (adhésion / rôle / archivage) : 403 explicite —
    // cas métier dominant ici, classification canonique pour le reste
    // (401 auth, 422 Zod, repli 400).
    const message = error instanceof Error ? error.message : "";
    if (/team|membership|archived|role/i.test(message)) {
      return NextResponse.json(errorBody(error, "Orchestrator execution failed"), { status: 403 });
    }
    return NextResponse.json(errorBody(error, "Orchestrator execution failed"), { status: errorStatus(error, 400) });
  }
}
