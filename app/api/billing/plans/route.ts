import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { getPlanState } from "@/lib/billing/abonnements";
import { PLAN_ORDER, toPublicPlan, type PlanId } from "@/lib/billing/plans";
import { captureServerException } from "@/lib/observability/sentry";

/**
 * GET /api/billing/plans
 *
 * Grille tarifaire Gen3ia (4 offres) + état d'abonnement de l'utilisateur
 * authentifié. Un visiteur non connecté reçoit le catalogue (purchasable
 * indique si le produit Chariow du plan est déjà configuré).
 */
export async function GET(request: Request) {
  try {
    let activePlan: PlanId | null = null;
    let authenticated = false;
    try {
      const token = await verifyFirebaseRequest(request);
      authenticated = true;
      const state = await getPlanState(token.uid);
      activePlan = state.planId;
    } catch {
      // Catalogue public : l'authentification n'est pas requise pour consulter.
    }

    return Response.json({
      success: true,
      authenticated,
      activePlan,
      plans: PLAN_ORDER.map((planId) => toPublicPlan(planId, activePlan)),
    });
  } catch (error) {
    captureServerException(error, { route: "billing.plans" });
    return Response.json({ error: "Impossible de charger la grille tarifaire." }, { status: 500 });
  }
}
