/**
 * CERVEAU ONDULATOIRE GEN3 — prototype CPU d'architecture cognitive adaptative.
 *
 * Assemble sans modèle externe :
 *   - encodage déterministe texte → onde ;
 *   - entraînement RPIA par association, sauvegardé par souvenir ;
 *   - mémoire associative à long terme avec refus de rappel incertain ;
 *   - hippocampe à court terme ;
 *   - graphe synaptique clairsemé dont la propagation ne parcourt que les
 *     connexions sortantes des unités activées ;
 *   - budget d'activation borné et état exportable/importable.
 *
 * Limite importante : l'encodage texte actuel est un fingerprint fondé sur
 * le hachage, pas un embedding sémantique appris. Cette première version
 * apprend/rappelle des associations, mais ne constitue pas à elle seule un
 * modèle de langage général ni une reproduction biologique du cerveau.
 */

import { CoucheOndesNeuronales } from "../core/couche-rpia";
import type { EtatRPIA } from "../core/couche-rpia";
import { hachagePrompt } from "../../ondes/conditionneur";
import { encoderTexteLexicalEnOnde } from "./encodeur-lexical-ondulatoire";
import { RPIA_DEFAUTS, validerConfigRPIA } from "../../ondes/types-entrainement";
import type { ConfigRPIA, RapportEntrainement } from "../../ondes/types-entrainement";

export interface OptionsCerveauGen3 {
  /** Dimensions de l'espace ondulatoire et du cortex clairsemé (8–512). */
  taille?: number;
  /** Nombre maximal d'unités activées par étage (1–taille). */
  budgetActif?: number;
  /** Nombre maximal d'associations à long terme conservées. */
  capaciteMemoire?: number;
  /** Seuil de rappel associatif. Le rappel textuel exact ne dépend pas de ce seuil. */
  seuilRappel?: number;
  /** Graine déterministe des oscillateurs. */
  graine?: number;
  /** Époques RPIA par association (1–1000). */
  epoquesParAssociation?: number;
  /** Taux d'apprentissage synaptique local (0–1). */
  tauxPlasticite?: number;
  /** Configuration du moteur RPIA CPU. */
  configRPIA?: ConfigRPIA;
}

export type ModeRappelCerveau = "RAPPEL_EXACT" | "RAPPEL_ASSOCIATIF" | "INCONNU";

export interface RapportApprentissageCerveau {
  idMemoire: string;
  remplaceMemoire: boolean;
  associationsMemorisees: number;
  neuronesSourceActives: number;
  synapsesRenforcees: number;
  erreurRPIAInitiale: number;
  erreurRPIAFinale: number;
  convergenceRPIA: boolean;
  epoquesRPIA: number;
}

export interface RapportConsolidationCerveau {
  /** Nombre d'expériences hippocampiques rejouées dans le cortex. */
  toursRejoues: number;
  /** Nombre de connexions dont le poids a réellement augmenté. */
  synapsesRenforcees: number;
  /** Nombre total de connexions après consolidation. */
  synapsesTotales: number;
}

export interface RapportPerceptionCerveau {
  /** Réponse mémorisée ou null si le cerveau ne dispose pas d'un rappel fiable. */
  sortie: string | null;
  mode: ModeRappelCerveau;
  confiance: number;
  idMemoire: string | null;
  /** Nombre de souvenirs comparés lors de la recherche. */
  souvenirsEvalues: number;
  /** Comparaisons vectorielles estimées : souvenirsEvalues × taille. */
  comparaisonsVectorielles: number;
  /** Unités source du cortex clairsemé activées. */
  unitesSourceActives: number;
  /** Unités de sortie qui reçoivent une activation synaptique. */
  unitesSortieActives: number;
  /** Connexions effectivement parcourues pendant cette propagation. */
  evenementsSynaptiques: number;
  budgetActif: number;
}

export interface SouvenirCerveauGen3 {
  id: string;
  entree: string;
  entreeNormalisee: string;
  sortie: string;
  representation: number[];
  etatOnde: EtatRPIA;
  erreurRPIAInitiale: number;
  erreurRPIAFinale: number;
  epoquesRPIA: number;
}

interface SynapseMemorisee {
  source: number;
  cible: number;
  poids: number;
}

export interface EtatCerveauGen3 {
  version: 2;
  taille: number;
  graine: number;
  prochainId: number;
  configRPIA: ConfigRPIA;
  /** État courant du cortex ondulatoire partagé entre toutes les expériences. */
  etatOndulatoire: EtatRPIA;
  souvenirs: SouvenirCerveauGen3[];
  synapses: SynapseMemorisee[];
  hippocampe: Array<{ entree: string; sortie: string }>;
}

interface Activation {
  index: number;
  valeur: number;
}

interface RapportPropagation {
  unitesSourceActives: number;
  unitesSortieActives: number;
  evenementsSynaptiques: number;
}

const TAILLE_DEFAUT = 64;
const BUDGET_DEFAUT = 8;
const CAPACITE_MEMOIRE_DEFAUT = 512;
const SEUIL_RAPPEL_DEFAUT = 1.0;
const EPOQUES_DEFAUT = 24;
const PLASTICITE_DEFAUT = 0.12;
const MAX_HIPPOCAMPE = 10;
const MAX_TEXTE = 20_000;

function normaliserTexte(texte: string): string {
  return texte.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function validerTexte(texte: unknown, champ: string): asserts texte is string {
  if (typeof texte !== "string" || texte.trim().length === 0 || texte.length > MAX_TEXTE) {
    throw new Error(`${champ} doit être un texte non vide de ${MAX_TEXTE} caractères maximum.`);
  }
}

function borner(valeur: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, valeur));
}

function cosinus(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let produit = 0;
  let normeA = 0;
  let normeB = 0;
  for (let i = 0; i < a.length; i++) {
    produit += a[i] * b[i];
    normeA += a[i] * a[i];
    normeB += b[i] * b[i];
  }
  const denominateur = Math.sqrt(normeA * normeB);
  return denominateur > 0 ? borner(produit / denominateur, -1, 1) : 0;
}

/** Sélection top-k stable : coût O(N log N), avec limite N ≤ 512 par défaut. */
function topK(valeurs: readonly number[], k: number): Activation[] {
  return valeurs
    .map((valeur, index) => ({ index, valeur: Math.abs(valeur) }))
    .filter((item) => item.valeur > 1e-8)
    .sort((a, b) => b.valeur - a.valeur || a.index - b.index)
    .slice(0, k);
}

function validerEtatOnde(etat: EtatRPIA | undefined, taille: number): asserts etat is EtatRPIA {
  if (!etat || typeof etat !== "object" || etat.taille !== taille) {
    throw new Error("Checkpoint Gen3 invalide : dimensions de l'état RPIA.");
  }
  if (
    !Number.isSafeInteger(etat.pasTotaux) ||
    etat.pasTotaux < 0 ||
    (etat.pasDeTemps !== undefined &&
      (!Number.isFinite(etat.pasDeTemps) ||
        !Number.isFinite(Math.fround(etat.pasDeTemps)) ||
        etat.pasDeTemps <= 0 ||
        Math.fround(etat.pasDeTemps) <= 0))
  ) {
    throw new Error("Checkpoint Gen3 invalide : horloge RPIA.");
  }
  if (
    !Array.isArray(etat.poids) ||
    etat.poids.length !== taille * 4 ||
    !etat.poids.every((valeur) => Number.isFinite(valeur) && Number.isFinite(Math.fround(valeur)))
  ) {
    throw new Error("Checkpoint Gen3 invalide : poids RPIA.");
  }
  for (let i = 0; i < taille; i++) {
    const offset = i * 4;
    const amplitude = etat.poids[offset];
    const frequence = etat.poids[offset + 1];
    const amortissement = etat.poids[offset + 3];
    if (amplitude < 0 || amplitude > 2 || frequence < 0 || amortissement < 0.001 || amortissement > 0.5) {
      throw new Error(`Checkpoint Gen3 invalide : oscillateur hors limites à l'indice ${i}.`);
    }
  }
}

function signatureDepuisOnde(etat: EtatRPIA, taille: number): number[] {
  if (etat.taille !== taille || etat.poids.length !== taille * 4) {
    throw new Error("État RPIA incompatible avec la taille du cerveau.");
  }
  const temps = Math.fround((etat.pasDeTemps ?? RPIA_DEFAUTS.pasDeTemps) * etat.pasTotaux);
  if (!Number.isFinite(temps)) throw new Error("Horloge RPIA non finie.");
  const resultat = new Array<number>(taille);
  for (let i = 0; i < taille; i++) {
    const offset = i * 4;
    const amplitude = etat.poids[offset];
    const frequence = etat.poids[offset + 1];
    const phase = etat.poids[offset + 2];
    resultat[i] = borner((amplitude * Math.cos(frequence * temps + phase)) / 2, -1, 1);
  }
  return resultat;
}

/**
 * Cerveau de recherche expérimentale : apprentissage d'associations textuelles
 * par RPIA, rappel associatif explicite et propagation synaptique clairsemée.
 * Toutes les opérations sont exécutées en JavaScript/TypeScript sur CPU.
 */
export class CerveauOndulatoireGen3 {
  readonly taille: number;
  readonly budgetActif: number;
  readonly capaciteMemoire: number;
  readonly seuilRappel: number;
  readonly graine: number;
  readonly epoquesParAssociation: number;
  readonly tauxPlasticite: number;
  readonly configRPIA: ConfigRPIA;

  private souvenirs: SouvenirCerveauGen3[] = [];
  /** Cortex RPIA partagé : chaque nouvel apprentissage modifie ce même réseau. */
  private coucheRPIA: CoucheOndesNeuronales;
  /** source = index d'entrée 0..taille-1 ; cible = taille..2*taille-1. */
  private synapses = new Map<number, Map<number, number>>();
  private hippocampe: Array<{ entree: string; sortie: string }> = [];
  private prochainId = 1;

  constructor(options: OptionsCerveauGen3 = {}) {
    const taille = options.taille ?? TAILLE_DEFAUT;
    const budgetActif = options.budgetActif ?? BUDGET_DEFAUT;
    const capaciteMemoire = options.capaciteMemoire ?? CAPACITE_MEMOIRE_DEFAUT;
    const seuilRappel = options.seuilRappel ?? SEUIL_RAPPEL_DEFAUT;
    const graine = options.graine ?? 42;
    const epoques = options.epoquesParAssociation ?? EPOQUES_DEFAUT;
    const plasticite = options.tauxPlasticite ?? PLASTICITE_DEFAUT;

    if (!Number.isInteger(taille) || taille < 8 || taille > 512) {
      throw new Error("taille doit être un entier compris entre 8 et 512.");
    }
    if (!Number.isInteger(budgetActif) || budgetActif < 1 || budgetActif > taille) {
      throw new Error("budgetActif doit être un entier compris entre 1 et taille.");
    }
    if (!Number.isInteger(capaciteMemoire) || capaciteMemoire < 1 || capaciteMemoire > 10_000) {
      throw new Error("capaciteMemoire doit être un entier compris entre 1 et 10000.");
    }
    // Budget mémoire : chaque souvenir garde un vecteur, un état RPIA et du
    // texte utilisateur/réponse. On borne les vecteurs et la taille cumulée
    // maximale des textes pour éviter une configuration démesurée.
    if (capaciteMemoire * taille > 1_000_000 || capaciteMemoire * MAX_TEXTE > 20_000_000) {
      throw new Error("La configuration dépasse le budget mémoire expérimental (vecteurs ou textes stockés).");
    }
    if (!Number.isFinite(seuilRappel) || seuilRappel < 0 || seuilRappel > 1) {
      throw new Error("seuilRappel doit être compris entre 0 et 1.");
    }
    if (!Number.isSafeInteger(graine) || graine < 0) {
      throw new Error("graine doit être un entier sûr positif ou nul.");
    }
    if (!Number.isInteger(epoques) || epoques < 1 || epoques > 1000) {
      throw new Error("epoquesParAssociation doit être un entier entre 1 et 1000.");
    }
    if (!Number.isFinite(plasticite) || plasticite < 0 || plasticite > 1) {
      throw new Error("tauxPlasticite doit être compris entre 0 et 1.");
    }

    this.taille = taille;
    this.budgetActif = budgetActif;
    this.capaciteMemoire = capaciteMemoire;
    this.seuilRappel = seuilRappel;
    this.graine = graine;
    this.epoquesParAssociation = epoques;
    this.tauxPlasticite = plasticite;
    this.configRPIA = { ...(options.configRPIA ?? RPIA_DEFAUTS) };
    validerConfigRPIA(this.configRPIA);
    this.coucheRPIA = new CoucheOndesNeuronales(this.taille, { graine: this.graine });
  }

  /** Apprend une association entrée → réponse en entraînant son état ondulatoire. */
  apprendre(entree: string, sortie: string): RapportApprentissageCerveau {
    validerTexte(entree, "entree");
    validerTexte(sortie, "sortie");
    const entreeNormalisee = normaliserTexte(entree);
    const representation = Array.from(encoderTexteLexicalEnOnde(entreeNormalisee, this.taille));
    const cibleSortie = Array.from(encoderTexteLexicalEnOnde(normaliserTexte(sortie), this.taille));

    const ancienIndex = this.souvenirs.findIndex((item) => item.entreeNormalisee === entreeNormalisee);
    const remplaceMemoire = ancienIndex >= 0;
    const id = remplaceMemoire ? this.souvenirs[ancienIndex].id : `m-${(this.prochainId++).toString(36)}`;
    // Toutes les expériences entraînent le MÊME cortex ondulatoire : les
    // modifications s'accumulent dans le réseau partagé, tandis que chaque
    // souvenir conserve un instantané épisodique de l'état d'onde appris.
    const rapportRPIA: RapportEntrainement = this.coucheRPIA.entrainerVersOnde(
      Float32Array.from(representation),
      this.epoquesParAssociation,
      this.configRPIA,
    );
    const etatOnde = this.coucheRPIA.exporterEtat();

    const nouveauSouvenir: SouvenirCerveauGen3 = {
      id,
      entree: entree.trim(),
      entreeNormalisee,
      sortie,
      representation,
      etatOnde,
      erreurRPIAInitiale: rapportRPIA.erreurInitiale,
      erreurRPIAFinale: rapportRPIA.erreurFinale,
      epoquesRPIA: rapportRPIA.epoques,
    };

    if (remplaceMemoire) {
      this.souvenirs[ancienIndex] = nouveauSouvenir;
    } else {
      this.souvenirs.push(nouveauSouvenir);
      if (this.souvenirs.length > this.capaciteMemoire) this.souvenirs.shift();
    }

    const synapsesRenforcees = this.apprendreSynapses(representation, cibleSortie);
    this.rememorerCourtTerme(entree.trim(), sortie);

    return {
      idMemoire: id,
      remplaceMemoire,
      associationsMemorisees: this.souvenirs.length,
      neuronesSourceActives: topK(representation, this.budgetActif).length,
      synapsesRenforcees,
      erreurRPIAInitiale: rapportRPIA.erreurInitiale,
      erreurRPIAFinale: rapportRPIA.erreurFinale,
      convergenceRPIA: rapportRPIA.convergence,
      epoquesRPIA: rapportRPIA.epoques,
    };
  }

  /**
   * Perçoit une entrée, propage un signal dans les seules synapses accessibles
   * depuis les unités actives, et rappelle une association uniquement si le
   * score passe le seuil configuré. Aucun texte de réponse n'est inventé.
   */
  percevoir(entree: string): RapportPerceptionCerveau {
    validerTexte(entree, "entree");
    const normalisee = normaliserTexte(entree);
    const representation = Array.from(encoderTexteLexicalEnOnde(normalisee, this.taille));

    let meilleur: SouvenirCerveauGen3 | null = null;
    let meilleurScore = -1;
    let exact = false;
    for (const souvenir of this.souvenirs) {
      if (souvenir.entreeNormalisee === normalisee) {
        meilleur = souvenir;
        meilleurScore = 1;
        exact = true;
        break;
      }
      const score = cosinus(representation, souvenir.representation);
      if (score > meilleurScore) {
        meilleurScore = score;
        meilleur = souvenir;
      }
    }

    // Avec le seuil par défaut (1.0), seul le texte normalisé identique est
    // rappelé. L'association approximative est une option explicite : elle
    // doit être activée en choisissant un seuil strictement inférieur à 1,
    // car l'empreinte actuelle n'est pas un embedding sémantique appris.
    const rappelAccepte = Boolean(
      meilleur && (exact || (this.seuilRappel < 1 && meilleurScore >= this.seuilRappel)),
    );
    // Le cortex reçoit une fusion du signal sensoriel et de l'état ondulatoire appris.
    // Pour une entrée inconnue, il ne fabrique pas d'état mémorisé : il propage
    // seulement le fingerprint sensoriel courant.
    const signatureGlobale = signatureDepuisOnde(this.coucheRPIA.exporterEtat(), this.taille);
    const signatureSouvenir = rappelAccepte && meilleur
      ? signatureDepuisOnde(meilleur.etatOnde, this.taille)
      : null;
    // Le cortex courant est toujours actif ; lorsqu'un souvenir est rappelé,
    // sa trace épisodique module aussi la propagation, comme un rappel
    // hippocampo-cortical, sans inventer une réponse textuelle.
    const modulationOnde = signatureSouvenir
      ? signatureGlobale.map((valeur, i) => (valeur + signatureSouvenir[i]) / 2)
      : signatureGlobale;
    const propagation = this.propagerEvenements(representation, modulationOnde);
    const mode: ModeRappelCerveau = rappelAccepte
      ? exact ? "RAPPEL_EXACT" : "RAPPEL_ASSOCIATIF"
      : "INCONNU";

    return {
      sortie: rappelAccepte && meilleur ? meilleur.sortie : null,
      mode,
      confiance: rappelAccepte ? meilleurScore : 0,
      idMemoire: rappelAccepte && meilleur ? meilleur.id : null,
      souvenirsEvalues: this.souvenirs.length,
      comparaisonsVectorielles: this.souvenirs.length * this.taille,
      ...propagation,
      budgetActif: this.budgetActif,
    };
  }

  /** Contexte récent, limité à dix tours pour contenir la RAM. */
  contexteCourtTerme(): Array<{ entree: string; sortie: string }> {
    return this.hippocampe.map((tour) => ({ ...tour }));
  }

  /**
   * REJEU HIPPOCAMPIQUE — consolidation de type "sommeil".
   *
   * Les expériences récentes sont rejouées dans le graphe cortical pour
   * renforcer les associations déjà observées. La mémoire à court terme n'est
   * pas effacée et aucun nouveau texte n'est inventé. Cette opération est
   * déterministe et bornée à dix tours.
   */
  consoliderHippocampe(): RapportConsolidationCerveau {
    let synapsesRenforcees = 0;
    const tours = [...this.hippocampe];
    for (const tour of tours) {
      const entree = Array.from(
        encoderTexteLexicalEnOnde(normaliserTexte(tour.entree), this.taille),
      );
      const sortie = Array.from(
        encoderTexteLexicalEnOnde(normaliserTexte(tour.sortie), this.taille),
      );
      synapsesRenforcees += this.apprendreSynapses(entree, sortie);
    }
    return {
      toursRejoues: tours.length,
      synapsesRenforcees,
      synapsesTotales: this.compterSynapses(),
    };
  }

  /** Statistiques réelles du noyau et de la mémoire. */
  statistiques(): {
    associationsMemorisees: number;
    capaciteMemoire: number;
    tailleOndulatoire: number;
    budgetActif: number;
    synapsesApprises: number;
    toursHippocampe: number;
    pasRPIATotaux: number;
  } {
    const synapsesApprises = this.compterSynapses();
    const pasRPIATotaux = this.coucheRPIA.pasTotaux;
    return {
      associationsMemorisees: this.souvenirs.length,
      capaciteMemoire: this.capaciteMemoire,
      tailleOndulatoire: this.taille,
      budgetActif: this.budgetActif,
      synapsesApprises,
      toursHippocampe: this.hippocampe.length,
      pasRPIATotaux,
    };
  }

  /** Export complet JSON-safe pour checkpoint serveur ou stockage applicatif. */
  exporterEtat(): EtatCerveauGen3 {
    const synapses: SynapseMemorisee[] = [];
    for (const [source, cibles] of this.synapses) {
      for (const [cible, poids] of cibles) synapses.push({ source, cible, poids });
    }
    return {
      version: 2,
      taille: this.taille,
      graine: this.graine,
      prochainId: this.prochainId,
      configRPIA: { ...this.configRPIA },
      etatOndulatoire: this.coucheRPIA.exporterEtat(),
      souvenirs: this.souvenirs.map((souvenir) => ({
        ...souvenir,
        representation: [...souvenir.representation],
        etatOnde: { ...souvenir.etatOnde, poids: [...souvenir.etatOnde.poids] },
      })),
      synapses,
      hippocampe: this.contexteCourtTerme(),
    };
  }

  /**
   * Restauration atomique : toutes les données sont vérifiées dans des structures
   * temporaires avant de remplacer l'état actuellement actif du cerveau.
   */
  importerEtat(etat: EtatCerveauGen3): void {
    if (!etat || etat.version !== 2 || etat.taille !== this.taille || etat.graine !== this.graine) {
      throw new Error("Checkpoint Gen3 incompatible (version, taille ou graine).");
    }
    validerConfigRPIA(etat.configRPIA);
    if (
      etat.configRPIA.tauxApprentissage !== this.configRPIA.tauxApprentissage ||
      etat.configRPIA.pasDeTemps !== this.configRPIA.pasDeTemps
    ) {
      throw new Error("Checkpoint Gen3 incompatible : configuration RPIA différente.");
    }
    validerEtatOnde(etat.etatOndulatoire, this.taille);
    if (!Number.isSafeInteger(etat.prochainId) || etat.prochainId < 1) {
      throw new Error("Checkpoint Gen3 invalide : prochainId.");
    }
    if (!Array.isArray(etat.souvenirs) || etat.souvenirs.length > this.capaciteMemoire) {
      throw new Error("Checkpoint Gen3 invalide : capacité de mémoire dépassée.");
    }
    if (!Array.isArray(etat.synapses) || etat.synapses.length > this.taille * this.taille) {
      throw new Error("Checkpoint Gen3 invalide : nombre de synapses incorrect.");
    }
    if (!Array.isArray(etat.hippocampe) || etat.hippocampe.length > MAX_HIPPOCAMPE) {
      throw new Error("Checkpoint Gen3 invalide : hippocampe incorrect.");
    }

    const souvenirs = etat.souvenirs.map((souvenir) => {
      validerTexte(souvenir.entree, "Checkpoint entree");
      validerTexte(souvenir.sortie, "Checkpoint sortie");
      validerEtatOnde(souvenir.etatOnde, this.taille);
      if (
        typeof souvenir.id !== "string" ||
        souvenir.id.length > 80 ||
        souvenir.entreeNormalisee !== normaliserTexte(souvenir.entree) ||
        !Array.isArray(souvenir.representation) ||
        souvenir.representation.length !== this.taille ||
        !souvenir.representation.every((valeur) => Number.isFinite(valeur)) ||
        !Number.isFinite(souvenir.erreurRPIAInitiale) ||
        !Number.isFinite(souvenir.erreurRPIAFinale) ||
        !Number.isSafeInteger(souvenir.epoquesRPIA) ||
        souvenir.epoquesRPIA < 1
      ) {
        throw new Error("Checkpoint Gen3 invalide : association ou état ondulatoire corrompu.");
      }
      return {
        ...souvenir,
        representation: [...souvenir.representation],
        etatOnde: { ...souvenir.etatOnde, poids: [...souvenir.etatOnde.poids] },
      };
    });

    const indexSynapses = new Map<number, Map<number, number>>();
    for (const synapse of etat.synapses) {
      if (
        !Number.isInteger(synapse.source) ||
        synapse.source < 0 ||
        synapse.source >= this.taille ||
        !Number.isInteger(synapse.cible) ||
        synapse.cible < this.taille ||
        synapse.cible >= this.taille * 2 ||
        !Number.isFinite(synapse.poids) ||
        synapse.poids < 0 ||
        synapse.poids > 1
      ) {
        throw new Error("Checkpoint Gen3 invalide : synapse hors limites.");
      }
      const cibles = indexSynapses.get(synapse.source) ?? new Map<number, number>();
      if (cibles.has(synapse.cible)) throw new Error("Checkpoint Gen3 invalide : synapse dupliquée.");
      cibles.set(synapse.cible, synapse.poids);
      indexSynapses.set(synapse.source, cibles);
    }

    const hippocampe = etat.hippocampe.map((tour) => {
      validerTexte(tour.entree, "Checkpoint hippocampe entree");
      validerTexte(tour.sortie, "Checkpoint hippocampe sortie");
      return { entree: tour.entree, sortie: tour.sortie };
    });

    // Créer et valider le cortex candidat avant de muter l'état actif :
    // un checkpoint ondulatoire invalide ne peut pas laisser un demi-cerveau.
    const coucheCandidate = new CoucheOndesNeuronales(this.taille, { graine: this.graine });
    coucheCandidate.importerEtat(etat.etatOndulatoire);

    this.souvenirs = souvenirs;
    this.synapses = indexSynapses;
    this.hippocampe = hippocampe;
    this.prochainId = etat.prochainId;
    this.coucheRPIA = coucheCandidate;
  }

  private apprendreSynapses(entree: readonly number[], sortie: readonly number[]): number {
    const sources = topK(entree, this.budgetActif);
    const cibles = topK(sortie, this.budgetActif);
    let renforcees = 0;
    for (const source of sources) {
      let connexions = this.synapses.get(source.index);
      if (!connexions) {
        connexions = new Map<number, number>();
        this.synapses.set(source.index, connexions);
      }
      for (const cible of cibles) {
        const idCible = this.taille + cible.index;
        const poidsAvant = connexions.get(idCible) ?? 0;
        const poidsApres = Math.min(
          1,
          poidsAvant + this.tauxPlasticite * source.valeur * cible.valeur,
        );
        connexions.set(idCible, poidsApres);
        if (poidsApres > poidsAvant) renforcees += 1;
      }
    }
    return renforcees;
  }

  private propagerEvenements(
    signal: readonly number[],
    modulationOnde?: readonly number[],
  ): RapportPropagation {
    const sources = topK(signal, this.budgetActif);
    const sorties = new Map<number, number>();
    let evenementsSynaptiques = 0;

    // Parcourt seulement les connexions des sources actives, pas toute la matrice.
    for (const source of sources) {
      const connexions = this.synapses.get(source.index);
      if (!connexions) continue;
      for (const [cible, poids] of connexions) {
        evenementsSynaptiques += 1;
        // L'onde apprise module l'efficacité de transmission sans changer
        // le classement d'activation sensoriel du cortex.
        const facteurOnde = modulationOnde
          ? 0.5 + 0.5 * Math.abs(modulationOnde[source.index] ?? 0)
          : 1;
        const contribution = source.valeur * facteurOnde * poids;
        sorties.set(cible, (sorties.get(cible) ?? 0) + contribution);
      }
    }

    const vecteurSortie = new Array<number>(this.taille).fill(0);
    for (const [cible, valeur] of sorties) {
      const index = cible - this.taille;
      if (index >= 0 && index < this.taille) vecteurSortie[index] = valeur;
    }
    const activesSortie = topK(vecteurSortie, this.budgetActif).length;
    return {
      unitesSourceActives: sources.length,
      unitesSortieActives: activesSortie,
      evenementsSynaptiques,
    };
  }

  private rememorerCourtTerme(entree: string, sortie: string): void {
    this.hippocampe.push({ entree: entree.slice(0, 2000), sortie: sortie.slice(0, 2000) });
    if (this.hippocampe.length > MAX_HIPPOCAMPE) this.hippocampe.shift();
  }

  private compterSynapses(): number {
    let total = 0;
    for (const connexions of this.synapses.values()) total += connexions.size;
    return total;
  }
}
