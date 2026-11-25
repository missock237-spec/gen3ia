/**
 * RESULT VERIFIER (UCE-008) — moteur INDÉPENDANT de vérification des
 * résultats. Règle mission §2.H : « Un résultat non vérifié ne doit jamais
 * être présenté comme une réussite confirmée. »
 *
 * Le vérificateur ne fait jamais confiance à l'exécuteur : il rejoue des
 * contrôles réels (fichier existant, code rejoué en sandbox, API rappelée,
 * cohérence sortie/demande) selon la preuve demandée.
 */

import "server-only";

import { verifierApiRepond } from "./api-validator";
import { verifierFichier, verifierDossierNonVide } from "./artifact-validator";
import { verifierCodeFonctionne } from "./code-validator";
import { sanitiserTexte } from "../security/secrets-protection";
import type { ExecutionVerification } from "../core/capability-contract";

/** Preuves demandables au vérificateur (choisies par l'appelant). */
export interface SpecPreuve {
  /** Le résultat contient un chemin de fichier qui doit exister non vide. */
  fichier?: { chemin: string; extensions?: string[] };
  /** Le résultat doit contenir un dossier non vide. */
  dossier?: { chemin: string };
  /** Une API réellement rappelée doit répondre correctement. */
  api?: { url: string; contient?: string };
  /** Un code rejoué en sandbox doit produire la valeur de vérité attendue. */
  code?: { script: string; valeurVerite?: unknown };
  /** La sortie doit contenir ces marqueurs (cohérence sortie/demande). */
  marqueurs?: string[];
  /** La sortie ne doit PAS être vide/tronquée. */
  nonVide?: boolean;
}

export interface DemandeVerification {
  executionId: string;
  resultat: unknown;
  spec: SpecPreuve;
}

/**
 * Vérifie un résultat selon la preuve demandée. Retourne TOUJOURS une
 * preuve explicite : verifie=false = résultat NON confirmé (jamais fiable).
 */
export async function verifierResultat(demande: DemandeVerification): Promise<ExecutionVerification> {
  const raisons: string[] = [];
  const methodes: string[] = [];
  let verifie = true;

  // Cohérence minimale : une sortie vide n'est pas un succès confirmé.
  const sortieTexte = sanitiserTexte(
    typeof demande.resultat === "string" ? demande.resultat : JSON.stringify(demande.resultat ?? ""),
  ).texte;

  if (demande.spec.nonVide !== false && sortieTexte.trim().length === 0) {
    verifie = false;
    raisons.push("sortie vide");
  } else {
    methodes.push("non-vide");
  }

  if ((demande.spec.marqueurs ?? []).length > 0) {
    methodes.push("marqueurs");
    for (const marqueur of demande.spec.marqueurs ?? []) {
      if (!sortieTexte.includes(marqueur)) {
        verifie = false;
        raisons.push(`marqueur attendu absent : « ${marqueur.slice(0, 60)} »`);
      }
    }
  }

  if (demande.spec.fichier) {
    methodes.push("fichier");
    const verdict = await verifierFichier(demande.spec.fichier.chemin, { extensions: demande.spec.fichier.extensions });
    if (!verdict.verifie) {
      verifie = false;
      raisons.push(`fichier : ${verdict.cause}`);
    } else {
      raisons.push(`fichier confirmé (${verdict.tailleOctets} octets)`);
    }
  }

  if (demande.spec.dossier) {
    methodes.push("dossier");
    const verdict = await verifierDossierNonVide(demande.spec.dossier.chemin);
    if (!verdict.verifie) {
      verifie = false;
      raisons.push(`dossier : ${verdict.cause}`);
    } else {
      raisons.push("dossier non vide confirmé");
    }
  }

  if (demande.spec.api) {
    methodes.push("api");
    const verdict = await verifierApiRepond(demande.spec.api.url, { contient: demande.spec.api.contient });
    if (!verdict.verifie) {
      verifie = false;
      raisons.push(`api : ${verdict.cause}`);
    } else {
      raisons.push(`api confirmée (HTTP ${verdict.httpStatut}, ${verdict.latenceMs} ms)`);
    }
  }

  if (demande.spec.code) {
    methodes.push("code-sandbox");
    const verdict = await verifierCodeFonctionne(demande.executionId, demande.spec.code.script, {
      valeurVerite: demande.spec.code.valeurVerite,
    });
    if (!verdict.ok) {
      verifie = false;
      raisons.push(`code : ${verdict.cause}`);
    } else {
      raisons.push(`code rejoué en sandbox avec succès (${verdict.dureeMs} ms)`);
    }
  }

  if (methodes.length === 0) {
    // Aucune preuve spécifique demandée : vérification minimale = non-vide.
    methodes.push("non-vide");
    raisons.push("vérification minimale (sortie non vide) — aucune preuve forte demandée");
  }

  return {
    verifie,
    methode: "rejoue-indépendant",
    details: `[preuves : ${methodes.join("+")}] ${raisons.join(" ; ")}`.slice(0, TAILLE_DETAILS),
  };
}

const TAILLE_DETAILS = 600;
