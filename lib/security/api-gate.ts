/**
 * GARDE D'AUTHENTIFICATION OBLIGATOIRE — le verrou unique de l'API (P0).
 *
 * Demande « amélioration des performances de gen3 », point 1 : « Une seule
 * garde d'auth obligatoire sur chaque route (withAuth avec vérification
 * cryptographique), sans dépendre du décodage JWT du middleware Edge. »
 *
 * ARCHITECTURE RETENUE :
 *   La garde vit dans le MIDDLEWARE (runtime NODEJS, configuré dans
 *   middleware.ts — PAS un runtime Edge) et applique une règle unique à
 *   TOUTES les routes API sans exception :
 *
 *     Toute requête MUTANTE (POST / PUT / PATCH / DELETE) sur un chemin
 *     non public doit porter une identité VÉRIFIÉE CRYPTOGRAPHIQUEMENT :
 *       - Bearer Firebase ID token — signature RS256 contre les
 *         certificats publics Google (node:crypto, PAS un simple décodage) ;
 *       - OU cookie de session `gen3ia_session` — HMAC-SHA256 serveur
 *         (lib/server/session-cookie.ts, timingSafeEqual).
 *     Sans identité ou avec une identité INVALIDE → 401 AVANT d'atteindre
 *     la route. Aucune route métier n'est plus accessible à l'anonyme en
 *     écriture, y compris une future route qu'on aurait oubliée de garder.
 *
 *   Les LECTURES (GET/HEAD) ne passent PAS par ce verrou : chacune des 265
 *   routes qui les exposent applique déjà sa propre garde vérifiée
 *   (protectRoute / requireUser / requireAdmin / requireDeveloperAccess /
 *   requireCodeAgentOwner / requireSystemAccess — audit scripts/
 *   audit-gardes-auth.mjs) et de nombreux GET sont légitimement anonymes
 *   (sondes de santé, flux d'auth, docs publiques v1).
 *
 *   La défense en PROFONDEUR reste la règle : les routes sensibles
 *   re-vérifient l'identité ELLES-MÊMES via la primitive withAuth
 *   (lib/server/with-auth.ts) ou leurs gardes existantes — ce module est la
 *   barrière OBLIGATOIRE, pas un substitut aux gardes de route.
 *
 * CHEMINS PUBLICS (non verrouillés, source lib/security/user-access.ts) :
 *   santé, /api/auth/* (login, signup, reset — rate-limités par IP),
 *   /api/public/*, /api/webhooks/* (signature HMAC Chariow / token),
 *   /api/cron/*, /api/queue/*, /api/video/worker/* (signature interne
 *   verifyTickRequest ou CRON_SECRET), /api/metrics (METRICS_TOKEN).
 *
 * CAS /api/v1/* : authentification par clé développeur `g3a_` — vérifiée
 *   par HMAC dans franchirPorteV1 (lib/api/v1/porte-v1.ts) À L'INTÉRIEUR de
 *   chaque route. La porte reconnaît la présence de l'en-tête `x-api-key`
 *   et laisse passer vers la route, qui seule peut valider la clé.
 *
 * CAS /api/essaim/ondes + /api/essaim/resultat (NŒUDS MACHINE — Colab /
 *   worker GPU distant, commit b8dd38c) : leur Bearer `ESSAIM_NOEUD_TOKEN`
 *   est un jeton de service OPAQUE, pas un JWT Firebase — l'étape 4 ne
 *   peut pas l'évaluer et renverrait 401 AVANT la garde de route, rendant
 *   la voie machine inopérante en production. On reconnaît donc ce
 *   credential ICI (comparaison timing-safe, FAIL-CLOSED si le jeton n'est
 *   pas configuré) pour laisser passer vers la route, dont la garde
 *   `résoudreIdentitéNœud` (lib/security/noeud-service.ts) fait la
 *   VÉRIFICATION COMPLÈTE : même jeton re-comparé, rate limit IP, identité
 *   de service « system-noeud-essaim ». Défense en profondeur conservée :
 *   ce pré-contrôle n'autorise RIEN seul, il évite seulement une 401 pour
 *   un credential que l'étape 4 ne sait pas lire. Les autres chemins
 *   /api/essaim/* (canal, état, job) restent verrouillés : ils sont
 *   réservés aux agents navigateur AUTHENTIFIÉS (contrat « demande n°7 »).
 *
 * Ce module ne décide PAS de la réponse HTTP : il rend un verdict, le
 * middleware construit la 401 (traçage W3C + en-têtes de sécurité).
 */

import { classifyApiPath } from "@/lib/security/user-access";

/** Méthodes qui modifient l'état serveur — verrouillées par la garde. */
const METHODES_MUTATION: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Minimal shape requis : compatible Request, NextRequest et tests unitaires. */
export interface RequetePorte {
  method: string;
  headers: { get(name: string): string | null };
}

export type VerdictPorte =
  | {
      verdict: "passer";
      /** uid vérifié (identité) ou null (public / lecture / clé v1 / nœud). */
      uid: string | null;
      voie: "public" | "lecture" | "cle-api-v1" | "noeud-essaim" | "identite-verifiee";
    }
  | {
      verdict: "refuser";
      statut: 401;
      code: "AUTH_REQUIRED";
      raison: string;
    };

const RAISON_401 =
  "Authentification requise : connectez-vous pour effectuer cette action.";

/**
 * Décide si une requête API peut atteindre la route cible.
 *
 * Ordre d'évaluation (coût minimal d'abord) :
 *   1. méthode non mutante              → passage (comportement existant) ;
 *   2. chemin public (classification)   → passage (anonyme inclus) ;
 *   3. /api/v1 avec x-api-key           → passage (porte-v1 vérifie la clé) ;
 *   4. identité cryptographique         → passage (uid) ou 401.
 */
export async function deciderMutationApi(
  requete: RequetePorte,
  pathname: string,
): Promise<VerdictPorte> {
  // 1. Lectures et préflights CORS : hors périmètre du verrou.
  if (!METHODES_MUTATION.has(requete.method.toUpperCase())) {
    return { verdict: "passer", uid: null, voie: "lecture" };
  }

  // 2. Chemins publics par conception (webhooks signés, auth, cron…).
  const decision = classifyApiPath(pathname);
  if (decision.access === "public") {
    return { verdict: "passer", uid: null, voie: "public" };
  }

  // 3. API publique v1 : la clé `g3a_` est vérifiée par franchirPorteV1
  //    dans la route (HMAC + projet lié + rôle développeur).
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
    if (requete.headers.get("x-api-key")) {
      return { verdict: "passer", uid: null, voie: "cle-api-v1" };
    }
  }

  // 3bis. Nœuds machine de l'essaim (Colab / worker GPU) : voir le CAS en
  //    tête de fichier. Scoping EXACT aux deux routes machine — les autres
  //    chemins /api/essaim/* restent soumis à l'identité Firebase.
  if (pathname === "/api/essaim/ondes" || pathname === "/api/essaim/resultat") {
    const authorization = requete.headers.get("authorization") ?? "";
    if (authorization.toLowerCase().startsWith("bearer ")) {
      const { jetonServiceValide } = await import("@/lib/security/noeud-service");
      if (jetonServiceValide(authorization.slice(7).trim())) {
        return { verdict: "passer", uid: null, voie: "noeud-essaim" };
      }
    }
  }

  // 4. Identité cryptographique obligatoire : RS256 Google OU cookie HMAC.
  try {
    const { verifyFirebaseAuth } = await import("@/lib/firebase/auth-server");
    const identite = await verifyFirebaseAuth(requete);
    return { verdict: "passer", uid: identite.uid, voie: "identite-verifiee" };
  } catch {
    // Anonyme OU identité invalide (jeton expiré, signature fausse, cookie
    // ressigné) : même verdict, même message — pas d'oracle sur la cause.
    return { verdict: "refuser", statut: 401, code: "AUTH_REQUIRED", raison: RAISON_401 };
  }
}
