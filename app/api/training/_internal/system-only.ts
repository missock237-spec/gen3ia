import "server-only";

import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { HttpError } from "@/lib/security/http-errors";
import type { AuthenticatedUser } from "@/lib/security/authenticated-request";

/**
 * Message utilisateur standard pour une ressource de mécanique interne du
 * Training Studio (demande utilisateur n° 6) : 403 JSON clair, actionnable,
 * sans détail d'infrastructure (aucun nom de variable d'environnement, aucun
 * identifiant de fournisseur).
 */
export const SYSTEM_ONLY_MESSAGE =
  "Accès réservé au système : cette ressource pilote la mécanique interne " +
  "d'entraînement (dispatch des fournisseurs, orchestrateur). " +
  "Configurez votre projet dans le studio d'entraînement : la plateforme " +
  "gère l'exécution de vos tâches.";

/**
 * GARDE « SYSTÈME-ONLY » du Training Studio (demande utilisateur n° 6).
 *
 * Principe « config only » : l'utilisateur définit UNIQUEMENT sa
 * configuration (projet, datasets, modèles, hyperparamètres, connecteurs) ;
 * la mécanique interne brute — balayage/dispatch de l'orchestrateur,
 * rafraîchissement fournisseur, lanceurs directs de calcul — n'est plus
 * exposée au standard.
 *
 * Comportement :
 *  - requête non authentifiée → 401 (sémantique inchangée) ;
 *  - utilisateur standard authentifié → 403 JSON clair (`FORBIDDEN`) ;
 *  - opérateur admin (custom claim `admin`, Bearer Firebase) → accès
 *    conservé à des fins de diagnostic plateforme.
 *
 * Honnêteté : AUCUN consommateur système ne passe par ces routes HTTP —
 * le cron de balayage (`/api/cron/training-sweep`, protégé par CRON_SECRET)
 * appelle les fonctions de `lib/training` directement. Le périmètre
 * utilisateur passe exclusivement par les routes de configuration et par
 * la vue agrégée `GET /api/training/projects/[id]`.
 */
export async function requireSystemAccess(request: NextRequest): Promise<AuthenticatedUser> {
  return requireAdmin(request).catch((error: unknown) => {
    if (error instanceof HttpError && error.status === 403) {
      throw new HttpError(403, SYSTEM_ONLY_MESSAGE, "FORBIDDEN");
    }
    throw error;
  });
}
