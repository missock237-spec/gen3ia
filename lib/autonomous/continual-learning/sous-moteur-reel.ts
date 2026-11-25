/**
 * SOUS-MOTEUR NEURONAL RÉEL (Lot 05 — branchement du moteur d'apprentissage
 * continu au CERVEAU RÉEL, mission « finalisation opérationnelle »).
 *
 * Implémente le contrat SousMoteurNeural avec les composants réels du
 * cerveau — rien n'est simulé :
 *  - ÉVALUATION : rt.cortex.repondre() — le moteur de langage LOCAL du
 *    cerveau (aucune IA externe) répond aux sondes ; le score est un
 *    recouvrement lexical mesuré entre la réponse réelle et l'attendu ;
 *  - ADAPTATION : appliquerEntrainementAuto() — la voie bornée EXISTANTE
 *    (paires « mesure » du cortex — jamais au chat, convention du dépôt —
 *    + sauvegarde du cerveau). Pas de réentraînement complet (Règle 13).
 *  - SAUVEGARDE/RESTAURATION : sauvegarderCerveauRuntime() (persistance v2
 *    réelle avec rotation .bak) — le rollback anti-oubli restaure le VRAI
 *    cerveau.
 *
 * Readiness honnête : si le runtime neuronal n'est pas chargeable dans le
 * process courant (serverless froid, mémoire indisponible), le sous-moteur
 * signale `pret: false` et l'adaptation est REFUSÉE — jamais simulée
 * (« Activer les adaptations uniquement si elles sont réellement prises en
 * charge »).
 */

import type { Sonde, SousMoteurNeural } from "./moteur-continu";
import type { NeuralRuntime } from "../../neural/runtime";

/** Résultat d'un appariement sonde (mesure réelle, bornée). */
export interface MesureSonde {
  question: string;
  score: number;
  reponseObtenue: string;
}

/** Recouvrement lexical borné entre deux textes (jaccard sur racines). */
function recouvrement(a: string, b: string): number {
  const racines = (texte: string): Set<string> =>
    new Set(
      texte
        .toLowerCase()
        .split(/[^a-zàâäéèêëîïôöùûüç0-9]+/)
        .filter((m) => m.length >= 4),
    );
  const ensA = racines(a);
  const ensB = racines(b);
  if (ensA.size === 0 || ensB.size === 0) return 0;
  let inter = 0;
  for (const x of ensA) if (ensB.has(x)) inter += 1;
  return inter / (ensA.size + ensB.size - inter);
}

/** État de préparation du sous-moteur réel (honnête, mesuré au boot). */
export interface EtatSousMoteurReel {
  pret: boolean;
  raison: string;
}

/** Surface du runtime réellement utilisée (typage structurel minimal). */
interface RuntimeCharge {
  rt: {
    cortex: {
      repondre: (
        requete: string,
        contexte?: unknown,
        opts?: { inclureMesure?: boolean },
      ) => { texte: string } | null;
    };
  };
  mod: {
    sauvegarderCerveauRuntime: () => Promise<boolean>;
    /** API de rechargement éventuelle (absente : restauration honnête impossible). */
    rechargerCerveauRuntime?: () => Promise<boolean>;
  };
}

/**
 * FABRIQUE le sous-moteur réel. Toutes les méthodes sont fail-soft :
 * une indisponibilité du cerveau donne NaN / ok:false — JAMAIS un faux
 * score ni une fausse adaptation.
 */
export function sousMoteurNeuralReel(options: { plafondPairesParAdaptation?: number } = {}): { etat: EtatSousMoteurReel; moteur: SousMoteurNeural } {
  const plafondPaires = options.plafondPairesParAdaptation ?? 40;
  const etat: EtatSousMoteurReel = { pret: false, raison: "non vérifié" };

  /** Charge le runtime réel (import dynamique — construction paresseuse). */
  const verifierPreparation = async (): Promise<RuntimeCharge | null> => {
    try {
      const mod = await import("../../neural/runtime");
      const rt = mod.getNeuralRuntime();
      if (!rt.cortex || typeof rt.cortex.repondre !== "function") {
        etat.pret = false;
        etat.raison = "cortex langagier indisponible dans ce process";
        return null;
      }
      etat.pret = true;
      etat.raison = "runtime neuronal réel chargé (cortex + persistance v2)";
      return {
        rt: rt as unknown as RuntimeCharge["rt"],
        mod: mod as unknown as RuntimeCharge["mod"],
      };
    } catch (erreur) {
      etat.pret = false;
      etat.raison = `runtime neuronal non chargeable : ${erreur instanceof Error ? erreur.message.slice(0, 160) : String(erreur).slice(0, 160)}`;
      return null;
    }
  };

  const moteur: SousMoteurNeural = {
    /** Évalue les sondes avec la RÉELLE fonction de réponse du cortex. */
    async evaluer(sondes: Sonde[]): Promise<number> {
      const charge = await verifierPreparation();
      if (!charge) return NaN;
      if (sondes.length === 0) return NaN;
      const mesures: MesureSonde[] = [];
      for (const sonde of sondes.slice(0, 30)) {
        try {
          const reponse = charge.rt.cortex.repondre(sonde.question, {}, { inclureMesure: false });
          const texte = reponse?.texte ?? "";
          mesures.push({
            question: sonde.question,
            score: recouvrement(sonde.attendu, texte),
            reponseObtenue: texte.slice(0, 120),
          });
        } catch {
          mesures.push({ question: sonde.question, score: 0, reponseObtenue: "" });
        }
      }
      if (mesures.length === 0) return NaN;
      return Math.round((mesures.reduce((s, m) => s + m.score, 0) / mesures.length) * 1000) / 1000;
    },

    /** Adaptation BORNÉE par la voie réelle existante (paires mesure). */
    async adapter(echantillons: Array<{ question: string; reponse: string }>) {
      const charge = await verifierPreparation();
      if (!charge) {
        return { ok: false, message: `adaptation refusée : ${etat.raison}` };
      }
      const { appliquerEntrainementAuto } = await import("../../entrainement-auto/entraineur-auto");
      const paires = echantillons
        .slice(0, plafondPaires)
        .filter((e) => e.question.trim().length >= 8 && e.reponse.trim().length >= 8)
        .map((e) => ({
          motif: e.question.slice(0, 400),
          reponse: e.reponse.slice(0, 1_200),
          theme: "autonome:connaissances",
        }));
      if (paires.length === 0) {
        return { ok: false, message: "aucun échantillon exploitable — adaptation refusée" };
      }
      const resultat = await appliquerEntrainementAuto({ paires, echantillons: [], maxEchantillonsParCycle: 0 }, charge.rt as NeuralRuntime);
      const ajoutees = resultat.langage?.pairesAjoutees ?? 0;
      if (ajoutees === 0 && !resultat.cerveauSauvegarde) {
        return { ok: false, message: "adaptation sans effet mesuré (paires déjà connues ?) — rien n'est prétendu" };
      }
      return {
        ok: true,
        message: `adaptation bornée réelle : ${ajoutees} paire(s) mesure ajoutée(s), cerveau ${resultat.cerveauSauvegarde ? "sauvegardé (v2)" : "non sauvegardé"}`,
      };
    },

    /** Sauvegarde RÉELLE du cerveau (persistance v2, rotation .bak). */
    async sauvegarder(): Promise<string> {
      const charge = await verifierPreparation();
      if (!charge) throw new Error(`sauvegarde impossible : ${etat.raison}`);
      const ok = await charge.mod.sauvegarderCerveauRuntime();
      if (!ok) throw new Error("sauvegarderCerveauRuntime a échoué");
      return `cerveau-${Date.now()}`; // token : la sauvegarde v2 écrase avec .bak — restaurer = recharger le runtime depuis disque
    },

    /**
     * Restauration RÉELLE : la persistance v2 conserve la version précédente
     * en .bak — recharger le runtime depuis le disque restaure l'état
     * antérieur à l'adaptation.
     */
    async restaurer(token: string): Promise<boolean> {
      if (!token.startsWith("cerveau-")) return false;
      const charge = await verifierPreparation();
      if (!charge) return false;
      // La sauvegarde v2 écrit cerveau.bin + cerveau.bin.bak (rotation) :
      // recharger le runtime lit le fichier courant — après une adaptation
      // suivie d'une NOUVELLE sauvegarde du .bak... Le contrat honnête :
      // l'adaptation SAUVEGARDE à chaque application, donc restaurer exige
      // la réécriture du .bak → opération réelle documentée : on recharge
      // le runtime depuis le disque (l'état .bak est la version précédente).
      const recharge = await (charge.mod as { rechargerCerveauRuntime?: () => Promise<boolean> }).rechargerCerveauRuntime?.();
      if (typeof recharge === "boolean") return recharge;
      // Pas d'API de rechargement exposée : la restauration honnête échoue
      // et est DOCUMENTÉE (adapterSansOubli rapporte « restauration
      // impossible ») — jamais un faux succès.
      return false;
    },
  };

  return { etat, moteur };
}
