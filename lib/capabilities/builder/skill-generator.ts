/**
 * SKILL GENERATOR (UCE-011) — création de compétences VALIDÉES par exercices
 * réels. Réutilise le motif éprouvé du dépôt (lib/autonomous/skills/
 * moteur-competences : compétence = connaissance + exercices pratiques en
 * sandbox) — l'UCE ne redéfinit PAS ce qu'est une compétence.
 *
 * Distingue explicitement (mission §4 / RÈGLE 4) : acquérir une compétence
 * ≠ acquérir des connaissances ≠ modifier des paramètres neuronaux.
 */

import "server-only";

import { maintenantIso, type CapabilityLearning } from "../core/capability-contract";
import { executerEnSandboxUce } from "../security/sandbox-manager";
import { sauvegarder } from "../storage/capability-repository";
import { refuserSiSecret } from "../security/secrets-protection";

export interface DemandeCompetence {
  nom: string;
  domaine: string;
  /** Contenu de la compétence (technique apprise, en langage naturel). */
  contenu: string;
  /** Code de l'exercice finalisé (script sandbox « emettre() »). */
  scriptExercice: string;
  /** Jeu de données de l'exercice. */
  donneesExercice?: unknown;
  /** Vérification attendue du résultat d'exercice (ex. ok:true). */
  attendu?: (resultat: unknown) => boolean;
  dossier?: string;
}

export interface CompetenceGeneree {
  nom: string;
  domaine: string;
  statut: "validee" | "echec";
  essais: number;
  dureeMs: number;
  detail: string;
}

/**
 * Génère et VALIDE une compétence : la compétence n'est enregistrée
 * « validee » QUE si l'exercice sandbox réussit réellement.
 */
export async function genererCompetence(demande: DemandeCompetence): Promise<CompetenceGeneree> {
  const debut = Date.now();
  let essais = 0;
  let dernierDetail = "";
  while (essais < 3) {
    essais++;
    const resultat = await executerEnSandboxUce(
      `skill_${demande.nom.replace(/[^a-z0-9-]/gi, "-")}_${essais}`,
      "systeme-uce",
      demande.scriptExercice,
      demande.donneesExercice,
    );
    if (resultat.ok) {
      if (!demande.attendu || demande.attendu(resultat.resultat)) {
        const competence: CompetenceGeneree = {
          nom: demande.nom,
          domaine: demande.domaine,
          statut: "validee",
          essais,
          dureeMs: Date.now() - debut,
          detail: `exercice sandbox réussi (${essais} essai(s), ${resultat.dureeMs} ms au dernier run)`,
        };
        await enregistrerLearning({
          kind: "competence",
          lecon: `compétence « ${demande.nom} » (${demande.domaine}) validée par exercice sandbox réel`,
          valide: true,
          regressionDetectee: false,
          dossier: demande.dossier,
        });
        return competence;
      }
      // Sandbox ok mais vérification métier refusée : l'exécution est
      // DÉTERMINISTE — re-tenter le même script donne le même résultat.
      dernierDetail = "sandbox ok mais vérification métier refusée";
      break;
    }
    dernierDetail = resultat.erreur ?? "échec sandbox";
    // Régénération interdite côté generator (aucune IA) : seul un timeout est
    // retenté une fois (transitoire réel), sinon échec honnête immédiat.
    if (!/timeout|deadline/i.test(dernierDetail)) break;
  }
  const echec: CompetenceGeneree = {
    nom: demande.nom,
    domaine: demande.domaine,
    statut: "echec",
    essais,
    dureeMs: Date.now() - debut,
    detail: `exercice sandbox non validé (${dernierDetail.slice(0, 160)}) — compétence NON acquise, rien n'est enregistré comme réussi`,
  };
  await enregistrerLearning({
    kind: "connaissance",
    lecon: `tentative de compétence « ${demande.nom} » échouée en sandbox : exercice non validé`,
    valide: false,
    regressionDetectee: false,
    dossier: demande.dossier,
  });
  return echec;
}

/** Enregistre un learning UCE (collection cap_learning, garde secrets). */
export async function enregistrerLearning(params: {
  kind: CapabilityLearning["kind"];
  lecon: string;
  avant?: number;
  apres?: number;
  jeuTest?: string;
  capabilityId?: string;
  valide: boolean;
  regressionDetectee: boolean;
  dossier?: string;
}): Promise<CapabilityLearning> {
  const garde = refuserSiSecret(params.lecon);
  const record: CapabilityLearning = {
    id: `learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: params.kind,
    capabilityId: params.capabilityId,
    lecon: garde.autorise ? params.lecon : "leçon masquée (secret détecté — contenu refusé)",
    avant: params.avant,
    apres: params.apres,
    jeuTest: params.jeuTest,
    regressionDetectee: params.regressionDetectee,
    valide: params.valide,
    apprentiLe: maintenantIso(),
    schemaVersion: 1,
  };
  try {
    await sauvegarder("learning", record, { dossier: params.dossier });
  } catch {
    // non fatal : l'appelant a déjà son retour honnête
  }
  return record;
}
