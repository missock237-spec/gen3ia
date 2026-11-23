import {
  CortexLangagierGen3,
  type EtatLangage,
  type StatsApprentissageLangage,
} from "@/lib/neural/generation/language";
import { EntraineurRPIA } from "@/lib/ondes/entrainement-rpia";

import { CAPACITES_PAR_NIVEAU, RANG_NIVEAU, type NiveauEntrainement } from "@/lib/training/cles-entrainement";
import { creerAlea, type ExempleClassification } from "@/lib/training/synthetique";

/**
 * ADAPTATEURS D'ENTRAÎNEMENT — gen3 s'adapte au système neuronal du modèle
 * FOURNI par l'utilisateur au lieu d'imposer le sien. Trois familles
 * réellement entraînables en local (CPU, déterministe, mesuré) :
 *
 *   - « cortex-langagier » : paires Q/R → mémoire résonante gen3
 *     (apprendre() idempotent, rappel mesuré par repondre()) ;
 *   - « tenseur-mlp »      : vecteurs + labels → rétropropagation SGD
 *     complète écrite ici (softmax + entropie croisée, initialisation
 *     seedée, poids ET biais fournis par l'utilisateur acceptés) ;
 *   - « onde-rpia »        : cibles d'onde → règle d'apprentissage par
 *     interférence (EntraineurRPIA, miroir CPU exact du shader WebGPU).
 *
 * Chaque adaptateur EXPORTE son état complet (poids, biais, état langage,
 * nœuds d'onde) en JSON : un modèle entraîné peut être ENREGISTRÉ puis
 * CHARGÉ à l'identique (registre-modeles.ts) — l'IA garde ce que gen3 lui
 * a appris entre les sessions.
 *
 * HONNÊTETÉ : chaque rapport porte la courbe d'erreur MESURÉE ; aucune
 * métrique n'est déclarée sans exécution réelle. Les limites le sont
 * aussi : pas de fine-tuning de LLM externes en sandbox (la voie
 * text-lora/services/training-worker existe pour ça, hors ce module).
 */

export type FamilleModele = "cortex-langagier" | "tenseur-mlp" | "onde-rpia";

export const FAMILLES_MODELE: readonly FamilleModele[] = ["cortex-langagier", "tenseur-mlp", "onde-rpia"];

export interface ModeleFourni {
  famille: FamilleModele;
  /** tenseur-mlp : architecture (défaut : 13 → [12] → nb classes). */
  architecture?: { entrees: number; caches?: number[]; sorties: number };
  /** tenseur-mlp : poids initiaux fournis (sinon initialisation seedée). */
  poids?: number[];
  /** tenseur-mlp : biais fournis (restauration d'un export complet). */
  biais?: number[];
  /** cortex-langagier : état exporté (paires apprises + poids d'usage). */
  etatLangage?: EtatLangage;
  /** onde-rpia : poids de nœuds fournis [amplitude, fréquence, phase, amortissement]×n. */
  poidsOnde?: number[];
  /** tenseur-mlp : ordre des classes en sortie (restauration d'un modèle enregistré). */
  labelsSortieFournies?: string[];
  /** onde-rpia : nombre de nœuds d'onde (défaut 64). */
  noeuds?: number;
  graine?: number;
}

export interface DonneesEntrainement {
  /** famille cortex-langagier — paires Q/R. */
  langage?: { question: string; reponse: string }[];
  /** famille tenseur-mlp — vecteurs + labels. */
  classification?: ExempleClassification[];
  /** famille onde-rpia — cibles d'onde. */
  onde?: Float32Array[];
}

export interface EstimationRessources {
  parametres: number;
  memoireMoEstimee: number;
  /** Estimation grossière mais honnête du coût CPU (ms) par époque. */
  cpuMsEstimeParEpoch: number;
  niveauRequis: NiveauEntrainement;
}

export interface ResultatEntrainementIA {
  famille: FamilleModele;
  epoques: number;
  erreurInitiale: number;
  erreurFinale: number;
  convergence: boolean;
  historiqueErreur: number[];
  details: string;
}

export interface ResultatEvaluationIA {
  famille: FamilleModele;
  echantillons: number;
  exactitude: number | null;
  metriques: Array<{ nom: string; valeur: number }>;
  details: string;
}

export interface AdaptateurEntrainementIA {
  famille: FamilleModele;
  ressources: EstimationRessources;
  entrainer(donnees: DonneesEntrainement, opts: { epoques: number }): Promise<ResultatEntrainementIA>;
  evaluer(donnees: DonneesEntrainement, opts?: { pasParCible?: number }): Promise<ResultatEvaluationIA>;
  /** Inférence vectorielle (politique d'action du monde virtuel) — famille tenseur. */
  inference?(entrees: number[]): Promise<number[]>;
  /** Ordre RÉEL des classes en sortie (argmax → label) — famille tenseur. */
  labelsSortie?(): Promise<string[]>;
  exporter(): { format: string; octets: number; resume: string; contenu: string };
}

/** Plus petit niveau de clé dont les capacités couvrent les paramètres. */
export function niveauRequisPourParametres(parametres: number): NiveauEntrainement {
  for (const niveau of ["standard", "avance", "integral"] as NiveauEntrainement[]) {
    if (parametres <= CAPACITES_PAR_NIVEAU[niveau].parametresMax) return niveau;
  }
  return "integral";
}

function estimer(famille: FamilleModele, parametres: number, echantillonsParEpoch: number): EstimationRessources {
  return {
    parametres,
    memoireMoEstimee: Number(((parametres * 8) / 1_048_576 + 12).toFixed(2)),
    cpuMsEstimeParEpoch: Math.max(1, Math.round(parametres * echantillonsParEpoch * 0.0002)),
    niveauRequis: niveauRequisPourParametres(parametres),
  };
}

/* ── tenseur-mlp : rétropropagation réelle ───────────────────────────── */

interface ReseauMlp {
  entrees: number;
  caches: number[];
  sorties: number;
  /** W[l] : [sortiesDeLaCouche][entreesDeLaCouche]. */
  poids: number[][][];
  biais: number[][];
}

function creerMlp(modele: ModeleFourni, nbSortiesEffectif: number, nbEntreesEffectif: number, graine: number): ReseauMlp {
  const entrees = modele.architecture?.entrees ?? nbEntreesEffectif;
  const caches = modele.architecture?.caches ?? [12];
  const sorties = modele.architecture?.sorties ?? nbSortiesEffectif;
  const tailles = [entrees, ...caches, sorties];
  const alea = creerAlea(modele.graine ?? graine);
  const poids = tailles.slice(0, -1).map((entree, l) =>
    Array.from({ length: tailles[l + 1] }, () => Array.from({ length: entree }, () => (alea() - 0.5) * 0.8)),
  );
  const reseauxBiais = tailles.slice(1).map((taille) => Array.from({ length: taille }, () => 0));
  // Poids FOURNIS par l'utilisateur : ils pré-remplissent la structure séquentiellement.
  if (modele.poids && modele.poids.length > 0) {
    let curseur = 0;
    for (let l = 0; l < poids.length; l += 1) {
      for (let i = 0; i < poids[l].length; i += 1) {
        for (let j = 0; j < poids[l][i].length; j += 1) {
          if (curseur < modele.poids.length) poids[l][i][j] = modele.poids[curseur];
          curseur += 1;
        }
      }
    }
  }
  // Biais FOURNIS (restauration d'un export complet — même ordre séquentiel).
  if (modele.biais && modele.biais.length > 0) {
    let curseur = 0;
    for (let l = 0; l < reseauxBiais.length; l += 1) {
      for (let i = 0; i < reseauxBiais[l].length; i += 1) {
        if (curseur < modele.biais.length) reseauxBiais[l][i] = modele.biais[curseur];
        curseur += 1;
      }
    }
  }
  return { entrees, caches, sorties, poids, biais: reseauxBiais };
}

function propagationAvant(reseau: ReseauMlp, x: number[]): { activations: number[][]; sortie: number[] } {
  const activations: number[][] = [x];
  let courant = x;
  let logits: number[] = [];
  for (let l = 0; l < reseau.poids.length; l += 1) {
    const suivante = reseau.poids[l].map((ligne, i) =>
      ligne.reduce((s, w, j) => s + w * courant[j], reseau.biais[l][i]),
    );
    if (l < reseau.poids.length - 1) {
      activations.push(suivante.map(Math.tanh));
      courant = activations[activations.length - 1];
    } else {
      // Sortie SOFTMAX (classification) — logits normalisés, entropie croisée.
      const maxLogit = Math.max(...suivante);
      const exp = suivante.map((z) => Math.exp(z - maxLogit));
      const somme = exp.reduce((a, b) => a + b, 0) || 1;
      logits = exp.map((e) => e / somme);
      activations.push(logits);
      courant = logits;
    }
  }
  return { activations, sortie: courant };
}

function entraînerMlp(
  reseau: ReseauMlp,
  exemples: ExempleClassification[],
  labels: string[],
  epoques: number,
  graine: number,
  tauxApprentissage = 0.25,
): number[] {
  const indexLabel = new Map(labels.map((l, i) => [l, i]));
  const alea = creerAlea(graine * 7 + 13);
  const historique: number[] = [];
  for (let epoque = 0; epoque < epoques; epoque += 1) {
    let perte = 0;
    // Ordre mélangé seedé (reproductible).
    const ordre = exemples.map((_, i) => i).sort(() => alea() - 0.5);
    for (const idx of ordre) {
      const ex = exemples[idx];
      const cible = indexLabel.get(ex.label) ?? 0;
      const { activations, sortie } = propagationAvant(reseau, ex.entrees);
      // Entropie croisée + rétropropagation (softmax : delta = o − t).
      perte -= Math.log(Math.max(1e-9, sortie[cible] ?? 1e-9));
      const deltaSortie = sortie.map((o, i) => o - (i === cible ? 1 : 0));
      let delta = deltaSortie;
      for (let l = reseau.poids.length - 1; l >= 0; l -= 1) {
        const entree = activations[l];
        const nouveauxDelta = new Array<number>(entree.length).fill(0);
        for (let i = 0; i < reseau.poids[l].length; i += 1) {
          const d = delta[i];
          for (let j = 0; j < reseau.poids[l][i].length; j += 1) {
            nouveauxDelta[j] += reseau.poids[l][i][j] * delta[i];
            reseau.poids[l][i][j] -= tauxApprentissage * d * entree[j];
          }
          reseau.biais[l][i] -= tauxApprentissage * d;
        }
        if (l > 0) {
          delta = nouveauxDelta.map((v, k) => v * (1 - entree[k] ** 2)); // tanh'
        }
      }
    }
    historique.push(Number((perte / Math.max(1, exemples.length)).toFixed(6)));
  }
  return historique;
}

function evaluerMlp(reseau: ReseauMlp, exemples: ExempleClassification[], labels: string[]): number {
  const indexLabel = new Map(labels.map((l, i) => [l, i]));
  let corrects = 0;
  for (const ex of exemples) {
    const { sortie } = propagationAvant(reseau, ex.entrees);
    const argmax = sortie.indexOf(Math.max(...sortie));
    if (labels[argmax] === ex.label || argmax === indexLabel.get(ex.label)) corrects += 1;
  }
  return exemples.length > 0 ? corrects / exemples.length : 0;
}

function compterParametresMlp(reseau: ReseauMlp): number {
  let total = 0;
  for (let l = 0; l < reseau.poids.length; l += 1) {
    total += reseau.poids[l].length * reseau.poids[l][0].length + reseau.biais[l].length;
  }
  return total;
}

function aplatirPoidsMlp(reseau: ReseauMlp): { poids: number[]; biais: number[] } {
  const poids = reseau.poids.flatMap((couche) => couche.flatMap((ligne) => [...ligne]));
  const biais = reseau.biais.flatMap((couche) => [...couche]);
  return { poids, biais };
}

/* ── Adaptateur TENSEUR-MLP ──────────────────────────────────────────── */

function creerAdaptateurMlp(modele: ModeleFourni): AdaptateurEntrainementIA {
  const graine = modele.graine ?? 20261122;
  // Poids OU architecture fournie : réseau créé IMMÉDIATEMENT — évaluation
  // et inférence possibles avant tout entraînement (tester un modèle reçu).
  let reseau: ReseauMlp | null =
    modele.poids?.length || modele.architecture
      ? creerMlp(modele, modele.architecture?.sorties ?? 4, modele.architecture?.entrees ?? 13, graine)
      : null;
  const labelsConnus: string[] = [];
  // Ordre des classes FOURNI (restauration) : l'argmax du monde reste aligné
  // avec les poids restaurés — sans lui, un modèle chargé serait muet.
  if (modele.labelsSortieFournies) {
    for (const label of modele.labelsSortieFournies) if (!labelsConnus.includes(label)) labelsConnus.push(label);
  }
  return {
    famille: "tenseur-mlp",
    ressources: estimer("tenseur-mlp", 0, 1), // recalculé après création (architecture réelle)
    async entrainer(donnees, { epoques }) {
      const exemples = donnees.classification ?? [];
      if (exemples.length === 0) throw new Error("tenseur-mlp : aucune donnée de classification fournie.");
      // Labels CUMULATIFS (indices stables entre les phases : imitation puis
      // renforcement) — jamais de ré-indexation qui invaliderait les poids.
      for (const ex of exemples) if (!labelsConnus.includes(ex.label)) labelsConnus.push(ex.label);
      if (!reseau) {
        reseau = creerMlp(modele, labelsConnus.length, exemples[0].entrees.length, graine);
      }
      if (labelsConnus.length > reseau.sorties) {
        throw new Error(
          `tenseur-mlp : ${labelsConnus.length} classes cumulées > ${reseau.sorties} sorties — augmenter architecture.sorties.`,
        );
      }
      (this as { ressources: EstimationRessources }).ressources = estimer(
        "tenseur-mlp",
        compterParametresMlp(reseau),
        exemples.length,
      );
      const historique = entraînerMlp(reseau, exemples, labelsConnus, Math.max(1, epoques), graine);
      return {
        famille: "tenseur-mlp",
        epoques: historique.length,
        erreurInitiale: historique[0],
        erreurFinale: historique[historique.length - 1],
        convergence: historique[historique.length - 1] < historique[0],
        historiqueErreur: historique,
        details: `MLP ${reseau.entrees}→[${reseau.caches.join(",")}]→${reseau.sorties}, ${labelsConnus.length} classes, ${exemples.length} échantillons — entropie croisée mesurée à chaque époque.`,
      };
    },
    async evaluer(donnees) {
      const exemples = donnees.classification ?? [];
      for (const ex of exemples) if (!labelsConnus.includes(ex.label)) labelsConnus.push(ex.label);
      if (!reseau) throw new Error("tenseur-mlp : fournir des poids ou entraîner avant d'évaluer.");
      const exactitude = evaluerMlp(reseau, exemples, labelsConnus);
      return {
        famille: "tenseur-mlp",
        echantillons: exemples.length,
        exactitude,
        metriques: [{ nom: "exactitude_argmax", valeur: Number(exactitude.toFixed(4)) }],
        details: "Argmax de la couche de sortie comparé au label réel (mesuré, pas déclaré).",
      };
    },
    async inference(entrees: number[]) {
      if (!reseau) throw new Error("tenseur-mlp : aucun réseau initialisé — fournir des poids ou entraîner d'abord.");
      return propagationAvant(reseau, entrees).sortie;
    },
    async labelsSortie() {
      return [...labelsConnus];
    },
    exporter() {
      if (!reseau) throw new Error("tenseur-mlp : rien à exporter avant l'entraînement.");
      const { poids, biais } = aplatirPoidsMlp(reseau);
      const contenu = JSON.stringify({
        famille: "tenseur-mlp",
        architecture: { entrees: reseau.entrees, caches: reseau.caches, sorties: reseau.sorties },
        poids,
        biais,
        labels: [...labelsConnus],
      });
      return {
        format: "json",
        octets: Buffer.byteLength(contenu, "utf-8"),
        resume: `MLP ${reseau.entrees}→[${reseau.caches.join(",")}]→${reseau.sorties} sérialisé (poids + biais + architecture + labels) — restaurable à l'identique.`,
        contenu,
      };
    },
  };
}

/* ── Adaptateur CORTEX-LANGAGIER ─────────────────────────────────────── */

function creerAdaptateurCortex(modele: ModeleFourni): AdaptateurEntrainementIA {
  const cortex = new CortexLangagierGen3();
  // Modèle fourni AVEC son état (restauration d'un modèle enregistré) :
  // les paires apprises et les poids d'usage reviennent à l'identique.
  if (modele.etatLangage) cortex.importerEtat(modele.etatLangage);
  const theme = modele.graine ? `fourni-${modele.graine}` : "fourni";
  let totalPairesDemandees = 0;
  return {
    famille: "cortex-langagier",
    ressources: estimer("cortex-langagier", 2_000, 500),
    async entrainer(donnees, { epoques }) {
      const paires = donnees.langage ?? [];
      if (paires.length === 0) throw new Error("cortex-langagier : aucune paire Q/R fournie.");
      totalPairesDemandees = paires.length;
      // Erreur AVANT : rappel mesuré sur un cortex vierge (0 % par construction).
      const avant = await this.evaluer({ langage: paires.slice(0, Math.min(20, paires.length)) });
      const stats: StatsApprentissageLangage = cortex.apprendre(
        paires.map((p) => ({ motif: p.question, reponse: p.reponse, theme })),
        { personnalisees: true },
      );
      const apres = await this.evaluer({ langage: paires.slice(0, Math.min(20, paires.length)) });
      const erreurInitiale = 1 - (avant.exactitude ?? 0);
      const erreurFinale = 1 - (apres.exactitude ?? 0);
      void epoques; // le cortex est monotone : un passage indexe tout, plasticité à l'usage.
      return {
        famille: "cortex-langagier",
        epoques: 1,
        erreurInitiale,
        erreurFinale,
        convergence: erreurFinale < erreurInitiale,
        historiqueErreur: [erreurInitiale, erreurFinale],
        details: `Cortex langagier : ${stats.pairesAjoutees} paires indexées, ${stats.pairesDoublons} doublons ignorés, vocabulaire ${stats.vocabulaire} tokens (mesuré par rappel réel repondre()).`,
      };
    },
    async evaluer(donnees) {
      const paires = donnees.langage ?? [];
      let corrects = 0;
      for (const paire of paires) {
        const r = cortex.repondre(paire.question);
        if (r && r.texte === paire.reponse) corrects += 1;
      }
      const exactitude = paires.length > 0 ? corrects / paires.length : null;
      return {
        famille: "cortex-langagier",
        echantillons: paires.length,
        exactitude,
        metriques: exactitude === null ? [] : [{ nom: "rappel_exact", valeur: Number(exactitude.toFixed(4)) }],
        details: `Rappel exact des réponses apprises sur ${paires.length} question(s) — ${corrects} correct(s).`,
      };
    },
    exporter() {
      const etat = cortex.exporterEtat();
      const contenu = JSON.stringify({ famille: "cortex-langagier", etat });
      return {
        format: "json",
        octets: Buffer.byteLength(contenu, "utf-8"),
        resume: `État complet du cortex (${totalPairesDemandees} paires demandées) — restaurable via etatLangage (persistance cerveau v2).`,
        contenu,
      };
    },
  };
}

/* ── Adaptateur ONDE-RPIA ────────────────────────────────────────────── */

function creerAdaptateurRpia(modele: ModeleFourni): AdaptateurEntrainementIA {
  const noeuds = Math.max(
    16,
    Math.min(4096, modele.noeuds ?? (modele.poidsOnde ? Math.floor(modele.poidsOnde.length / 4) : 64)),
  );
  const graine = modele.graine ?? 20261122;
  let entraineur: EntraineurRPIA | null = null;
  // Modèle fourni AVEC ses poids de nœuds : restauration immédiate (l'onde
  // apprise revient exactement — pas de réinitialisation).
  if (modele.poidsOnde && modele.poidsOnde.length > 0) {
    entraineur = new EntraineurRPIA(noeuds, { graine });
    entraineur.importerPoids(Float32Array.from(modele.poidsOnde.slice(0, noeuds * 4)));
  }
  return {
    famille: "onde-rpia",
    ressources: estimer("onde-rpia", noeuds * 4, 10),
    async entrainer(donnees, { epoques }) {
      const cibles = donnees.onde ?? [];
      if (cibles.length === 0) throw new Error("onde-rpia : aucune cible d'onde fournie.");
      entraineur = new EntraineurRPIA(noeuds, { graine });
      const historique: number[] = [];
      for (let epoque = 0; epoque < Math.max(1, epoques); epoque += 1) {
        let somme = 0;
        for (const cible of cibles) somme += entraineur.pasEntrainement(cible);
        historique.push(Number((somme / cibles.length).toFixed(6)));
      }
      const erreurInitiale = historique[0];
      const erreurFinale = historique[historique.length - 1];
      return {
        famille: "onde-rpia",
        epoques: historique.length,
        erreurInitiale,
        erreurFinale,
        convergence: erreurFinale < erreurInitiale,
        historiqueErreur: historique,
        details: `RPIA ${noeuds} nœuds — erreur d'interférence moyenne mesurée par époque sur ${cibles.length} cible(s).`,
      };
    },
    async evaluer(donnees, opts) {
      const cibles = donnees.onde ?? [];
      const pasParCible = Math.max(1, opts?.pasParCible ?? 8);
      // Apprentissabilité : pour chaque cible test, un entraîneur neuf doit
      // converger en pasParCible pas — mesure RÉELLE de la vitesse d'adaptation.
      const erreurs: number[] = [];
      for (let i = 0; i < cibles.length; i += 1) {
        const mesureur = new EntraineurRPIA(noeuds, { graine: graine + 1_000 + i });
        let erreur = 0;
        for (let k = 0; k < pasParCible; k += 1) erreur = mesureur.pasEntrainement(cibles[i]);
        erreurs.push(erreur);
      }
      const erreurMoyenne = erreurs.length > 0 ? erreurs.reduce((a, b) => a + b, 0) / erreurs.length : 0;
      const apprisesRapide = erreurs.filter((e) => e < 0.15).length;
      return {
        famille: "onde-rpia",
        echantillons: cibles.length,
        exactitude: null,
        metriques: [
          { nom: "erreur_moyenne_apres_pas", valeur: Number(erreurMoyenne.toFixed(6)) },
          { nom: "cibles_convergees_rapide", valeur: apprisesRapide / Math.max(1, cibles.length) },
        ],
        details: `Erreur résiduelle après ${pasParCible} pas par cible test (seuil annihilation 0.15) — ${apprisesRapide}/${cibles.length} convergée(s) rapidement.`,
      };
    },
    exporter() {
      if (!entraineur) throw new Error("onde-rpia : rien à exporter avant l'entraînement.");
      const poids = entraineur.exporterPoids();
      const contenu = JSON.stringify({ famille: "onde-rpia", noeuds, poids: Array.from(poids) });
      return {
        format: "json",
        octets: Buffer.byteLength(contenu, "utf-8"),
        resume: `${noeuds} nœuds [amplitude, fréquence, phase, amortissement] — restaurable via poidsOnde (paquet d'ondes).`,
        contenu,
      };
    },
  };
}

/**
 * Estimation PRÉFLIGHT (avant toute création) — sert au garde de niveau des
 * outils : le niveau de clé requis doit être connu AVANT d'entraîner.
 */
export function estimerRessourcesModele(
  modele: ModeleFourni,
  opts?: { entrees?: number; sorties?: number },
): EstimationRessources {
  if (modele.famille === "onde-rpia") {
    const noeuds = modele.noeuds ?? (modele.poidsOnde ? Math.floor(modele.poidsOnde.length / 4) : 64);
    return estimer("onde-rpia", noeuds * 4, 10);
  }
  if (modele.famille === "cortex-langagier") return estimer("cortex-langagier", 2_000, 500);
  const entrees = modele.architecture?.entrees ?? opts?.entrees ?? 13;
  const caches = modele.architecture?.caches ?? [12];
  const sorties = modele.architecture?.sorties ?? opts?.sorties ?? 4;
  const tailles = [entrees, ...caches, sorties];
  let parametres = 0;
  for (let l = 0; l < tailles.length - 1; l += 1) {
    parametres += tailles[l] * tailles[l + 1] + tailles[l + 1];
  }
  return estimer("tenseur-mlp", parametres, 500);
}

/** Fabrique l'adaptateur correspondant au système neuronal du modèle fourni. */
export function adapterPour(modele: ModeleFourni): AdaptateurEntrainementIA {
  switch (modele.famille) {
    case "tenseur-mlp":
      return creerAdaptateurMlp(modele);
    case "cortex-langagier":
      return creerAdaptateurCortex(modele);
    case "onde-rpia":
      return creerAdaptateurRpia(modele);
    default:
      throw new Error(`Famille de modèle inconnue : ${String((modele as { famille?: unknown }).famille)}`);
  }
}

/**
 * Reconstruit un ModeleFourni depuis le CONTENU JSON d'un export
 * (registre des modèles entraînés) — la boucle sauver → charger → réutiliser.
 */
export function modeleFourniDepuisContenu(contenu: string, graine?: number): ModeleFourni {
  let brut: {
    famille?: FamilleModele;
    architecture?: ModeleFourni["architecture"];
    poids?: number[];
    biais?: number[];
    labels?: string[];
    etat?: EtatLangage;
    noeuds?: number;
    poidsOnde?: number[];
  };
  try {
    brut = JSON.parse(contenu);
  } catch {
    throw new Error("Contenu de modèle illisible (JSON attendu).");
  }
  const graineFinale = graine ?? 20261122;
  switch (brut.famille) {
    case "tenseur-mlp":
      return {
        famille: "tenseur-mlp",
        architecture: brut.architecture,
        poids: brut.poids,
        biais: brut.biais,
        labelsSortieFournies: brut.labels,
        graine: graineFinale,
      };
    case "cortex-langagier":
      return { famille: "cortex-langagier", etatLangage: brut.etat, graine: graineFinale };
    case "onde-rpia":
      return { famille: "onde-rpia", noeuds: brut.noeuds, poidsOnde: brut.poidsOnde ?? brut.poids, graine: graineFinale };
    default:
      throw new Error("Famille de modèle absente du contenu exporté.");
  }
}

/** Garde-fou capacité : le niveau de clé couvre-t-il les ressources estimées ? */
export function niveauCouvre(niveau: NiveauEntrainement, ressources: EstimationRessources): boolean {
  const capacites = CAPACITES_PAR_NIVEAU[niveau];
  return (
    RANG_NIVEAU[niveau] >= RANG_NIVEAU[ressources.niveauRequis] &&
    ressources.parametres <= capacites.parametresMax &&
    ressources.memoireMoEstimee <= capacites.memoireMoMax
  );
}
