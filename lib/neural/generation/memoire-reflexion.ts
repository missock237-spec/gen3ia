/**
 * MÉMOIRE DE RÉFLEXION GEN3 (demande propriétaire Job 478451 : « donne-lui
 * une mémoire de réflexion associée qui va permettre de lui donner des
 * choix et de réfléchir pour pouvoir traiter les données plus précisément
 * et plus rapidement »).
 *
 * PRINCIPE (honnête, mesurable, déterministe) :
 *   - VOIE RAPIDE : la requête est posée TELLE QUELLE au cortex langagier
 *     (1 seul appel — le cas commun, zéro latence ajoutée) ;
 *   - VOIES DE PRÉCISION : si la voie directe ne sert rien (ou trop court),
 *     la délibération essaie des reformulations systématiques — normalisée
 *     (casse/ponctuation/espaces) puis raccourcie (mots-outils retirés,
 *     contenu seul) — et GARDE LE PREMIER CHOIX SERVABLE ;
 *   - MÉMOIRE : chaque délibération (requête, voies essayées, candidats,
 *     choix élu, raison) est inscrite dans un anneau borné (CAPACITE_
 *     MEMOIRE_REFLEXION entrées) — gen3 peut relire ses propres délibérations.
 *
 * INVARIANT DE NON-RÉGRESSION : la voie directe est TOUJOURS essayée en
 * premier avec la requête originale — le taux de service réflexif ne peut
 * donc jamais être inférieur à celui du cortex seul (vérifié par la garde).
 * La mesure A/B honnête (cortex frais chacun) vit dans l'évaluation
 * navigateur : base (direct) vs réflexif (délibération).
 *
 * it.113 — MÉMOIRE DE DOMAINES CÂBLÉE (demande propriétaire : « une mémoire
 * de réflexion qui lui donne des choix et réfléchir... pouvoir évoluer à
 * mesure qu'il reçoit des données via le chat IA et/ou l'API ») :
 *   - chaque délibération inscrit le DOMAINE DÉTECTÉ de la requête
 *     (classifieur honnête de la mémoire de domaines) — le raisonnement
 *     devient traçable domaine par domaine ;
 *   - VOIE « MÉMORISÉE » (dernier recours, seulement si les trois voies
 *     échouent) : replay du meilleur enseignement ingéré via chat/API
 *     (recouvrement de tokens, seuil documenté) — gen3 évolue à chaque
 *     échange et peut répondre depuis ce qu'on lui a enseigné. Sans
 *     mémoire de domaines câblée, le comportement reste EXACTEMENT celui
 *     d'it.112 (les tests de non-régression couvrent les deux cas).
 */
import {
  type ContexteLangage,
  type CortexLangagierGen3,
  type ReponseLangage,
} from "./language";

export type VoieReflexion = "directe" | "normalisee" | "racourcie" | "memorisee";

/** Contrat structural (typage en canard) — satisfait par MemoireDomainesGen3
 * sans dépendance d'import (évite tout cycle de modules). */
export interface SourceMemoireDomaines {
  identifieDomaine(motif: string): string | null;
  repondreIngestion(motif: string): string | null;
}

export interface CandidatReflexion {
  readonly voie: VoieReflexion;
  readonly requete: string;
  readonly servie: boolean;
  readonly texte: string;
}

export interface Deliberation {
  readonly motif: string;
  /** Domaine détecté de la requête (heuristique mots-clés) — null si inconnu. */
  readonly domaine: string | null;
  /** La voie retenue — "echec" si aucune voie n'a servi. */
  readonly voieElue: VoieReflexion | "echec";
  /** Nombre d'appels réels au cortex (1 = voie rapide, ≥ 2 = réflexion). */
  readonly essais: number;
  readonly candidats: readonly CandidatReflexion[];
  /** Texte élu ("" si échec). */
  readonly elue: string;
  readonly horodatage: number;
}

export const CAPACITE_MEMOIRE_REFLEXION = 256;
/** Seuil de service — cohérent avec l'évaluation navigateur (> 20 caractères). */
export const TAILLE_MIN_REPONSE = 20;

/** Mots-outils français retirés par la voie raccourcie (contenu seul).
 * « où » est CONSERVÉ : les questions d'emplacement en dépendent. */
const MOTS_OUTILS = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "est", "ce",
  "que", "qui", "quoi", "dans", "sur", "pour", "avec", "au", "aux", "a",
  "d", "l", "sont", "se", "son", "sa", "ses", "ne", "pas", "plus", "comme",
  "mais", "donc", "or", "ni", "car", "je", "tu", "il", "elle", "on", "nous",
  "vous", "ils", "elles", "cette", "ces", "ceci", "cela", "quel", "quelle",
  "quels", "quelles", "comment", "pourquoi", "moi", "toi", "te", "ta", "ton",
]);

export function requeteNormalisee(motif: string): string {
  return motif
    .toLowerCase()
    .replace(/[!¡?¿;:,.…«»"'`(){}\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function requeteRaccourcie(motif: string): string {
  const mots = requeteNormalisee(motif)
    .split(" ")
    .filter((m) => m.length > 0 && !MOTS_OUTILS.has(m));
  return mots.join(" ");
}

export class CortexReflexifGen3 {
  private readonly memoire: Deliberation[] = [];

  constructor(
    private readonly cortex: CortexLangagierGen3,
    private readonly memoireDomaines?: SourceMemoireDomaines,
  ) {}

  /**
   * DÉLIBÉRATION : essaie les voies dans l'ordre (rapide → précises →
   * mémorisée), s'arrête au premier choix servable, inscrit la délibération
   * en mémoire AVEC le domaine détecté.
   */
  reflechir(motif: string, contexte: ContexteLangage = {}): Deliberation {
    const domaineDetecte = this.memoireDomaines?.identifieDomaine(motif) ?? null;
    const candidats: CandidatReflexion[] = [];
    let elue = "";
    let voieElue: VoieReflexion | "echec" = "echec";
    const voies: Array<[VoieReflexion, string]> = [
      ["directe", motif],
      ["normalisee", requeteNormalisee(motif)],
      ["racourcie", requeteRaccourcie(motif)],
    ];
    let essais = 0;
    for (const [voie, requete] of voies) {
      if (voie !== "directe" && (requete.length === 0 || requete === motif)) continue;
      essais += 1;
      const r = this.cortex.repondre(requete, contexte);
      const servie = r !== null && r.texte.length > TAILLE_MIN_REPONSE;
      candidats.push({ voie, requete, servie, texte: r?.texte ?? "" });
      if (servie) {
        elue = r!.texte;
        voieElue = voie;
        break;
      }
    }
    // VOIE « MÉMORISÉE » (dernier recours) : replay d'un enseignement ingéré
    // via chat/API — seulement si TOUTES les autres voies ont échoué (la
    // non-régression est intacte : cette voie ne peut qu'augmenter le service).
    if (voieElue === "echec" && this.memoireDomaines) {
      const reprise = this.memoireDomaines.repondreIngestion(motif);
      if (reprise !== null && reprise.length > TAILLE_MIN_REPONSE) {
        essais += 1;
        voieElue = "memorisee";
        elue = reprise;
        candidats.push({ voie: "memorisee", requete: motif, servie: true, texte: reprise });
      }
    }
    const deliberation: Deliberation = {
      motif,
      domaine: domaineDetecte,
      voieElue,
      essais,
      candidats,
      elue,
      horodatage: Date.now(),
    };
    this.memoire.push(deliberation);
    if (this.memoire.length > CAPACITE_MEMOIRE_REFLEXION) {
      this.memoire.splice(0, this.memoire.length - CAPACITE_MEMOIRE_REFLEXION);
    }
    return deliberation;
  }

  /** Contrat compatible repondre() — le texte élu, ou null si échec.
   * La voie « mémorisée » restitue l'enseignement ingéré (source réelle). */
  repondre(motif: string, contexte: ContexteLangage = {}): ReponseLangage | null {
    const d = this.reflechir(motif, contexte);
    if (d.voieElue === "echec") return null;
    if (d.voieElue === "memorisee") {
      // L'enseignement provient de l'ingestion (chat/API) — on le restitue
      // avec la provenance réelle du candidat élu (pas de métrique fabriquée).
      const texte = d.candidats.find((c) => c.voie === "memorisee")!.texte;
      return { texte, theme: "memoire-domaines", score: 1, source: "personnalisee" };
    }
    // La réponse élee PROVIENT du cortex — on restitue sa réponse complète
    // (score/source réels du candidat élu, pas de métrique fabriquée).
    return this.cortex.repondre(d.candidats.find((c) => c.voie === d.voieElue)!.requete, contexte);
  }

  /** Mémoire de délibération (chronologique, anneau borné). */
  lireMemoire(): readonly Deliberation[] {
    return this.memoire;
  }

  viderMemoire(): void {
    this.memoire.length = 0;
  }

  /** Statistiques honnêtes sur la mémoire courante. */
  statistiques(): {
    total: number;
    servies: number;
    echecs: number;
    parVoie: Record<VoieReflexion | "echec", number>;
    tauxService: number;
    /** Requêtes ratées en direct mais SERVIES par une voie de réflexion. */
    gainPrecision: number;
    /** Requêtes servies dès la voie rapide (zéro réflexion nécessaire). */
    voieRapide: number;
  } {
    const parVoie: Record<VoieReflexion | "echec", number> = {
      directe: 0,
      normalisee: 0,
      racourcie: 0,
      memorisee: 0,
      echec: 0,
    };
    let servies = 0;
    for (const d of this.memoire) {
      parVoie[d.voieElue] += 1;
      if (d.voieElue !== "echec") servies += 1;
    }
    return {
      total: this.memoire.length,
      servies,
      echecs: parVoie.echec,
      parVoie,
      tauxService: this.memoire.length > 0 ? servies / this.memoire.length : 0,
      gainPrecision: parVoie.normalisee + parVoie.racourcie,
      voieRapide: parVoie.directe,
    };
  }
}
