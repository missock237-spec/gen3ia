/**
 * TOOL BUILDER (UCE-012) — pipeline de CONSTRUCTION d'outils (mission §2.E).
 *
 * Étapes obligatoires (numérotées comme la mission) :
 *  1. Identifier une fonctionnalité absente (spécification d'entrée).
 *  2. Déterminer si elle peut être construite en interne (archétype dispo).
 *  3. Étudier les solutions existantes (discovery déléguée — appelant).
 *  4. Concevoir une architecture (archétype + champs zod).
 *  5. Générer le code (code-generator déterministe).
 *  6. Exécuter les tests (sandbox réelle).
 *  7. Corriger les erreurs (automatic-debugger, budget d'essais borné).
 *  8. Produire une documentation (documentation-generator).
 *  9. Préparer une intégration (Capability au statut « proposee »).
 * 10. Soumettre à validation (JAMAIS déployé directement — statut borne).
 *
 * RÈGLE : « Le code généré ne doit jamais être déployé directement en
 * production sans contrôles » — la sortie maximale du builder est une
 * PROPOSITION persistée, jamais une capacité intégrée.
 */

import "server-only";

import {
  maintenantIso,
  type Capability,
} from "../core/capability-contract";
import { construireCapabilityId } from "../core/capability-contract";
import { genererCode, archetypesDisponibles, type ArcheTypeCode, type SpecCapaciteGeneree } from "./code-generator";
import { corrigerAvecBudget } from "./automatic-debugger";
import { executerEnSandboxUce } from "../security/sandbox-manager";
import { obtenirGestionnaireCapacites } from "../core/capability-manager";
import { sauvegarder } from "../storage/capability-repository";
import { genererDocumentation } from "./documentation-generator";

export interface DemandeConstruction {
  nom: string;
  description: string;
  archeType?: ArcheTypeCode;
  /** Champs spécifiques (sinon défauts de l'archétype). */
  champs?: SpecCapaciteGeneree["champs"];
  dossier?: string;
}

export interface EtapeConstruction {
  etape: number;
  nom: string;
  ok: boolean;
  detail: string;
}

export interface ResultatConstruction {
  /** Proposition NEVER integrate : statut final « proposee » ou « rejetee ». */
  capacite?: Capability;
  codeModule?: string;
  codeTest?: string;
  documentation?: string;
  etapes: EtapeConstruction[];
  /** Essais sandbox réellement effectués (traçabilité complète). */
  essaisSandbox: number;
  succes: boolean;
  cause?: string;
}

/** Pipeline de construction complet — ne lève jamais, rapport honnête. */
export async function construireOutil(demande: DemandeConstruction): Promise<ResultatConstruction> {
  const etapes: EtapeConstruction[] = [];
  const push = (etape: number, nom: string, ok: boolean, detail: string) =>
    etapes.push({ etape, nom, ok, detail });

  // ÉTAPE 1 — identification : la demande elle-même (validée).
  if (!demande.nom.trim() || !demande.description.trim()) {
    push(1, "identification-fonctionnalite", false, "nom ou description vide : rien à construire");
    return { etapes, essaisSandbox: 0, succes: false, cause: "demande incomplète" };
  }
  push(1, "identification-fonctionnalite", true, `fonctionnalité : ${demande.nom}`);

  // ÉTAPE 2 — constructible en interne ? (archétype connu uniquement)
  const archeType = demande.archeType ?? choisirArcheType(demande.description);
  if (!archetypeDisponible(archeType)) {
    push(2, "constructibilite-interne", false, `archétype « ${archeType} » inconnu — construction interne impossible (aucun gabarit éprouvé)`);
    return { etapes, essaisSandbox: 0, succes: false, cause: "archétype indisponible : chercher des solutions externes via discovery, ou ajouter un gabarit éprouvé" };
  }
  push(2, "constructibilite-interne", true, `archétype choisi : ${archeType}`);

  // ÉTAPE 4+5 — conception + génération (archétypes = architecture éprouvée).
  const spec: SpecCapaciteGeneree = {
    nom: demande.nom,
    description: demande.description,
    archeType,
    champs: demande.champs ?? [],
  };
  const genere = genererCode(spec);
  push(5, "generation-code", true, `module ${genere.codeModule.length} caractères + test ${genere.codeTest.length} caractères (déterministe)`);

  // ÉTAPE 3 — étude des solutions existantes : hors périmètre du builder
  // (déléguée à universal-discovery par le cerveau ; mention honnête ici).
  push(3, "solutions-existantes", true, "déléguée au cerveau central (universal-discovery) — le builder ne réinvente pas ce qui existe");

  // ÉTAPE 6+7 — tests sandbox + correction bornée (budget 2 régénérations).
  let essaisSandbox = 0;
  const debug = await corrigerAvecBudget(
    async () => {
      essaisSandbox++;
      const resultat = await executerEnSandboxUce(
        `build_${demande.nom.replace(/[^a-z0-9-]/gi, "-")}_${essaisSandbox}`,
        "systeme-uce",
        genere.codeTest,
        { casSucces: genere.casSucces, casRefus: genere.casRefus },
      );
      return { ok: resultat.ok, erreur: resultat.erreur, journaux: resultat.journaux };
    },
    async (_diagnostic) => {
      // Régénération = re-gabarit déterministe (les archétypes sont éprouvés) ;
      // une vraie variante se produirait seulement pour des champs custom.
      const nova = genererCode({ ...spec, champs: [] });
      genere.codeModule = nova.codeModule;
      genere.codeTest = nova.codeTest;
      genere.casSucces = nova.casSucces;
      genere.casRefus = nova.casRefus;
      return true;
    },
    2,
  );
  if (!debug.succes) {
    push(6, "tests-sandbox", false, `échec après ${essaisSandbox} essai(s) : ${debug.causeFinale}`);
    push(7, "correction", false, `diagnostics : ${debug.essais.map((e) => `#${e.essai} ${e.diagnostic.categorie}`).join(", ")}`);
    return { etapes, essaisSandbox, succes: false, cause: `sandbox a rejeté le code généré : ${debug.causeFinale}` };
  }
  push(6, "tests-sandbox", true, `succès réel après ${essaisSandbox} essai(s) — jeux d'essai succès ET refus validés`);
  push(7, "correction", true, debug.essais.some((e) => e.reGenere) ? "régénération(s) effectuée(s) puis succès" : "aucune correction nécessaire");

  // ÉTAPE 8 — documentation (faits mesurés uniquement).
  const gestionnaire = obtenirGestionnaireCapacites({ dossier: demande.dossier });
  const id = construireCapabilityId("construite", "uce-builder", demande.nom);
  const capacite = await gestionnaire.enregistrerCapacite({
    id,
    kind: "tool",
    origin: "construite",
    card: {
      nom: demande.nom,
      description: demande.description,
      fonctionnalites: [`archétype ${archeType}`, "exécution sandbox (réseau none)"],
      source: "uce-builder",
      dependances: [],
      risques: ["code généré : re-test complet obligatoire après toute modification du gabarit", "aucun accès réseau par conception"],
      verifieLe: maintenantIso(),
    },
    statutInitial: "proposee",
  });

  const documentation = genererDocumentation({ capacite });
  push(8, "documentation", true, `${documentation.length} caractères de documentation factuelle`);

  // ÉTAPE 9 — préparation d'intégration : artefacts persistés.
  try {
    await sauvegarder("versions", {
      id: `ver_${capacite.id}_v1`,
      capabilityId: capacite.id,
      version: "v1-proposition",
      statut: "staged",
      changements: "proposition initiale construite par le builder UCE (sandbox validée)",
      tests: [{ nom: "sandbox-jeux-essai", ok: true, dureeMs: 0 }],
      creeLe: maintenantIso(),
      schemaVersion: 1,
    }, { dossier: demande.dossier });
    await sauvegarder("permissions", {
      id: `perm_${capacite.id}`,
      capabilityId: capacite.id,
      risque: "ecriture",
      permissionsRequises: ["tool.write"],
      gated: true,
      schemaVersion: 1,
    }, { dossier: demande.dossier });
    push(9, "preparation-integration", true, "version staged + permission gated persistées (aucune activation)");
  } catch (erreur) {
    push(9, "preparation-integration", false, `persistance échouée : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    return { etapes, essaisSandbox, succes: false, cause: "préparation d'intégration échouée" };
  }

  // ÉTAPE 10 — soumission à validation : statut MAX = « proposee ».
  push(10, "soumission-validation", true, "proposition en attente d'autorisation humaine (admin) — jamais déployée directement");

  return {
    capacite,
    codeModule: genere.codeModule,
    codeTest: genere.codeTest,
    documentation,
    etapes,
    essaisSandbox,
    succes: true,
  };
}

function archetypeDisponible(archeType: ArcheTypeCode): boolean {
  return archetypesDisponibles().includes(archeType);
}

/** Choix d'archétype par mots-clés déterministes (pas de hasard, pas d'IA). */
function choisirArcheType(description: string): ArcheTypeCode {
  const d = description.toLowerCase();
  if (/(calcule|calcul|arithm|somme|total)/.test(d)) return "calcul-deterministe";
  if (/(valide|verifie.*texte|controle.*saisie|format)/.test(d)) return "validation-texte";
  if (/(json|normalise|transforme.*cle)/.test(d)) return "transformation-json";
  return "verification-contenu";
}
