import "server-only";

import { newUlid } from "@/lib/storage/user-data-store";
import {
  downloadHubFile,
  hubIntegrationStatus,
  inspectHubDataset,
  searchHubDatasets,
} from "@/lib/training/hub";

import { choisirDatasets, requeteDuCycle, type RechercheObjectif } from "./catalogue";
import { appliquerEntrainementAuto } from "./entraineur-auto";
import { lireEtatAuto, ecrireEtatAuto, ETAT_AUTO_PATH } from "./etat";
import { ingesterDataset } from "./ingesteur";
import { delaiInitialAutoMs, intervalleAutoMs, plafondsAuto, type PlafondsAuto } from "./plafonds";
import type {
  ClientHubAuto,
  HubSource,
  RapportCycleAuto,
  RapportHubCycle,
} from "./types";
import type { PaireLangage } from "@/lib/neural/generation/corpus";
import type { TrainingSample } from "@/lib/neural/training/dataset";

/**
 * LA BOUCLE D'AUTO-APPRENTISSAGE — le cycle complet, exécuté SEUL :
 *
 *   découvrir (recherche HF + Kaggle) → choisir (conservateur) → ingérer
 *   (téléchargement plafonné + conversion) → entraîner (cortex + SNN réels)
 *   → persister (cerveau + état) → rapporter (honnête).
 *
 * Démarrage : `demarrerAutoApprentissage()` est appelé par instrumentation
 * (register) au boot du serveur — premier cycle après délai, puis cycles
 * périodiques. Timers `unref()` (ne retiennent jamais le process), garde
 * d'unicité sur globalThis (résiste au HMR), `executerCycleAuto` à flight
 * unique (un cycle à la fois — jamais de double entraînement concurrent).
 */

/* ------------------------------------------------------------------ */
/* Adaptateur réel vers les connecteurs hub existants                   */
/* ------------------------------------------------------------------ */

/** Client hub réel : enrobe la façade lib/training/hub (HF + Kaggle). */
export function clientHubReel(): ClientHubAuto {
  return {
    async rechercher(provider, requete, limite) {
      const resultats = await searchHubDatasets(provider, requete, limite);
      return resultats.map((d) => ({
        ref: d.ref,
        titre: d.name,
        downloads: d.downloads,
        taille: d.sizeBytes,
      }));
    },
    async inspecter(provider, ref) {
      const detail = await inspectHubDataset(provider, ref);
      return {
        files: detail.files.map((f) => ({ name: f.name, sizeBytes: f.sizeBytes, downloadable: f.downloadable })),
      };
    },
    async telecharger(provider, ref, fichier, maxOctets) {
      const { buffer } = await downloadHubFile(provider, ref, fichier, maxOctets);
      return buffer;
    },
    estConfigure(provider) {
      return hubIntegrationStatus().some((s) => s.provider === provider && s.configured);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Garde d'unicité (globalThis — résiste au HMR)                        */
/* ------------------------------------------------------------------ */

interface GardeAuto {
  boucleArmee: boolean;
  cycleEnCours: boolean;
}

const globalAvecAuto = globalThis as typeof globalThis & {
  __gen3iaAutoApprentissage?: GardeAuto;
};

function garde(): GardeAuto {
  globalAvecAuto.__gen3iaAutoApprentissage ??= { boucleArmee: false, cycleEnCours: false };
  return globalAvecAuto.__gen3iaAutoApprentissage;
}

/** Lisible par l'API (POST refuse poliment si un cycle tourne déjà). */
export function cycleEnCours(): boolean {
  return garde().cycleEnCours;
}

function messageErreur(erreur: unknown): string {
  return (erreur instanceof Error ? erreur.message : String(erreur ?? "erreur inconnue")).slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Le cycle                                                             */
/* ------------------------------------------------------------------ */

export interface OptionsCycle {
  /** Client hub injectable (défaut : adaptateur réel). */
  client?: ClientHubAuto;
  /** Chemin d'état injectable (tests). */
  cheminEtat?: string;
  /** Plafonds injectables (tests). */
  plafonds?: PlafondsAuto;
}

/**
 * Exécute UN cycle complet. @returns le rapport du cycle, ou null si un
 * cycle était déjà en cours (refus poli, rien de lancé en double).
 */
export async function executerCycleAuto(opts: OptionsCycle = {}): Promise<RapportCycleAuto | null> {
  const g = garde();
  if (g.cycleEnCours) return null;
  g.cycleEnCours = true;

  const client = opts.client ?? clientHubReel();
  const plafonds = opts.plafonds ?? plafondsAuto();
  const cheminEtat = opts.cheminEtat ?? ETAT_AUTO_PATH;

  const demarreA = new Date().toISOString();
  const debutMs = Date.now();
  const etat = await lireEtatAuto(cheminEtat);
  etat.enCours = true;
  await ecrireEtatAuto(etat, cheminEtat);

  try {
    // 1. DÉCOUVRIR — HF toujours ; Kaggle seulement si configuré (honnête).
    const providers: HubSource[] = client.estConfigure("kaggle")
      ? ["huggingface", "kaggle"]
      : ["huggingface"];

    const recherches: RechercheObjectif[] = [];
    const considerees: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const erreursHub: Record<HubSource, string[]> = { huggingface: [], kaggle: [] };

    for (const objectif of ["langage", "intention"] as const) {
      for (const provider of providers) {
        const requete = requeteDuCycle(objectif, provider, etat.cyclesExecutes);
        try {
          const resultats = await client.rechercher(provider, requete, 6);
          considerees[provider] += resultats.length;
          recherches.push({ objectif, provider, requete, resultats });
        } catch (erreur: unknown) {
          erreursHub[provider].push(`recherche « ${requete} » : ${messageErreur(erreur)}`);
        }
      }
    }

    // 2. CHOISIR — conservateur déterministe, anti-rejoue.
    const choisis = choisirDatasets(recherches, etat.datasetsIngestes, plafonds);

    // 3. INGÉRER — budget d'octets décompté réellement.
    const paires: PaireLangage[] = [];
    const echantillons: TrainingSample[] = [];
    const ingeres: string[] = [];
    const pairesParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const echantillonsParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const ingeresParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    let budget = plafonds.totalParCycleOctets;

    for (const choix of choisis) {
      if (budget <= 0) {
        erreursHub[choix.provider].push(`${choix.ref} : budget d'octets du cycle épuisé.`);
        continue;
      }
      try {
        const apport = await ingesterDataset(choix, client, plafonds, budget);
        budget -= apport.octetsTelecharges;
        paires.push(...apport.paires);
        echantillons.push(...apport.echantillons);
        pairesParHub[choix.provider] += apport.paires.length;
        echantillonsParHub[choix.provider] += apport.echantillons.length;
        erreursHub[choix.provider].push(...apport.erreurs.slice(0, 3).map((e) => `${choix.ref} → ${e}`));
        if (apport.paires.length > 0 || apport.echantillons.length > 0) {
          ingeres.push(choix.ref);
          ingeresParHub[choix.provider] += 1;
        } else if (apport.erreurs.length === 0) {
          erreursHub[choix.provider].push(`${choix.ref} : aucune donnée exploitable extraite.`);
        }
      } catch (erreur: unknown) {
        erreursHub[choix.provider].push(`${choix.ref} : ${messageErreur(erreur)}`);
      }
    }

    // 4. ENTRAÎNER — cortex langagier + SNN supervisés (réels).
    let langage: RapportCycleAuto["langage"];
    let intention: RapportCycleAuto["intention"];
    if (paires.length > 0 || echantillons.length > 0) {
      try {
        const resultat = await appliquerEntrainementAuto(
          {
            paires,
            echantillons,
            maxEchantillonsParCycle: plafonds.maxEchantillonsParCycle,
          },
        );
        langage = resultat.langage;
        intention = resultat.intention;
      } catch (erreur: unknown) {
        erreursHub.huggingface.push(`entraînement : ${messageErreur(erreur)}`);
      }
    }

    // 5. RAPPORTER — honnêteté intégrale.
    const hubs: RapportHubCycle[] = providers.map((provider) => ({
      provider,
      configure: client.estConfigure(provider),
      datasetsConsiderees: considerees[provider],
      datasetsIngestes: ingeresParHub[provider],
      paires: pairesParHub[provider],
      echantillons: echantillonsParHub[provider],
      erreurs: erreursHub[provider].slice(0, 5),
    }));

    const kaggleNonConfigure = !client.estConfigure("kaggle");
    const mentionKaggle = kaggleNonConfigure
      ? " Kaggle ignoré (KAGGLE_API_TOKEN absent)."
      : "";
    const statut: RapportCycleAuto["statut"] =
      ingeres.length === 0 ? "echec" : "termine";
    const message =
      ingeres.length === 0
        ? `Aucun nouveau dataset ingéré (${choisis.length} candidat(s), ${considerees.huggingface + considerees.kaggle} résultat(s)).${mentionKaggle}`
        : `${ingeres.length} dataset(s) ingéré(s) — ${paires.length} paire(s), ${echantillons.length} échantillon(s) ; entraînement ${langage || intention ? "appliqué" : "non appliqué"}.${mentionKaggle}`;

    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut,
      message,
      hubs,
      ...(langage ? { langage } : {}),
      ...(intention ? { intention } : {}),
      datasetsIngestes: ingeres,
    };

    // 6. PERSISTER — état + cerveau (le cerveau est déjà sauvegardé par
    //    l'entraîneur ; l'état trace les datasets pour l'anti-rejoue).
    const etatFrais = await lireEtatAuto(cheminEtat);
    etatFrais.enCours = false;
    etatFrais.cyclesExecutes += 1;
    etatFrais.dernierRapport = rapport;
    etatFrais.historique = [rapport, ...etatFrais.historique];
    etatFrais.datasetsIngestes = [...etatFrais.datasetsIngestes, ...ingeres];
    etatFrais.pairesCumulees += paires.length;
    etatFrais.echantillonsCumules += echantillons.length;
    await ecrireEtatAuto(etatFrais, cheminEtat);

    return rapport;
  } catch (erreur: unknown) {
    // Erreur globale imprévue : rapport d'échec honnête + état libéré.
    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut: "echec",
      message: `Cycle interrompu : ${messageErreur(erreur)}`,
      hubs: [],
      datasetsIngestes: [],
    };
    try {
      const etatErreur = await lireEtatAuto(cheminEtat);
      etatErreur.enCours = false;
      etatErreur.cyclesExecutes += 1;
      etatErreur.dernierRapport = rapport;
      etatErreur.historique = [rapport, ...etatErreur.historique];
      await ecrireEtatAuto(etatErreur, cheminEtat);
    } catch {
      // L'état reste « enCours » — le prochain cycle le réécrira.
    }
    return rapport;
  } finally {
    g.cycleEnCours = false;
  }
}

/* ------------------------------------------------------------------ */
/* Démarrage automatique (appelé par instrumentation)                   */
/* ------------------------------------------------------------------ */

export interface OptionsDemarrage {
  delaiMs?: number;
  intervalleMs?: number;
}

/**
 * Arme la boucle autonome (UNE fois par process) :
 *  - uniquement runtime Node (jamais edge, jamais pendant `next build`) ;
 *  - désactivable par AUTO_APPRENTISSAGE=0 ;
 *  - timers unref() : la boucle ne retient jamais le serveur en vie ;
 *  - chaque cycle est protégé (single-flight) et loggé.
 */
export function demarrerAutoApprentissage(opts: OptionsDemarrage = {}): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AUTO_APPRENTISSAGE === "0") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const g = garde();
  if (g.boucleArmee) return;
  g.boucleArmee = true;

  const delaiMs = opts.delaiMs ?? delaiInitialAutoMs();
  const intervalleMs = opts.intervalleMs ?? intervalleAutoMs();

  const executer = () => {
    executerCycleAuto()
      .then((rapport) => {
        if (rapport) {
          console.log(
            `[AUTO-APPRENTISSAGE] cycle ${rapport.statut} (${Math.round(rapport.dureeMs / 100) / 10} s) : ${rapport.message}`,
          );
        }
      })
      .catch((erreur: unknown) => {
        console.warn("[AUTO-APPRENTISSAGE] échec de cycle :", messageErreur(erreur));
      });
  };

  const initial = setTimeout(executer, delaiMs);
  initial.unref?.();
  const periodique = setInterval(executer, intervalleMs);
  periodique.unref?.();

  console.log(
    `[AUTO-APPRENTISSAGE] boucle armée — HF + Kaggle (si KAGGLE_API_TOKEN). Premier cycle dans ${Math.round(delaiMs / 1000)} s, puis tous les ${Math.round(intervalleMs / 60_000)} min.`,
  );
}
