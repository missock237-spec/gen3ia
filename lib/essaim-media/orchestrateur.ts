import "server-only";

/**
 * ORCHESTRATEUR DE L'ESSAIM MÉDIA — le chef d'orchestre des ondes.
 *
 * Reçoit une requête média (image/voix/vidéo), la DÉCOMPOSE en fragments
 * exécutables via WebGPU, les DISTRIBUE aux 5 meilleurs appareils de
 * l'essaim, ramasse les résultats, et — cœur de la demande utilisateur —
 * RELANCE automatiquement la part de tout agent qui se déconnecte
 * brusquement (sentinelle + générations de relance plafonnées).
 *
 * Le module est une machine à états PURE (horloge et UUID injectables) :
 * la fusion des signaux (binaire MP4/WAV) vit dans ./fusion, la
 * persistance dans la couche routes.
 */

import { randomUUID } from "node:crypto";
import {
  BORNES_ESSAIM,
  découperEnSegments,
  type ChargeFragment,
  type FragmentTravail,
  type JobEssaim,
  type TypeMédiaEssaim,
} from "./types";
import { RegistreEssaim, registreEssaim } from "./registre";

/** Dimensions par ratio (grille SD 512 — cohérente avec image-engine). */
export function dimensionsPourRatio(ratio: string): { w: number; h: number } {
  const GRILLE: Record<string, { w: number; h: number }> = {
    "1:1": { w: 512, h: 512 },
    "3:4": { w: 448, h: 576 },
    "4:3": { w: 576, h: 448 },
    "16:9": { w: 576, h: 320 },
    "9:16": { w: 320, h: 576 },
    "2:3": { w: 416, h: 608 },
    "3:2": { w: 608, h: 416 },
    "21:9": { w: 640, h: 288 },
  };
  return GRILLE[ratio] ?? GRILLE["1:1"];
}

export interface ParamètresJobEssaim {
  conversationId: string;
  userId: string;
  kind: TypeMédiaEssaim;
  prompt: string;
  ratio?: string;
  duréeSecondes?: number;
  jobIdOrigine?: string;
}

export type ActionFusion = {
  action: "fusionner";
  job: JobEssaim;
  résultats: Map<number, Uint8Array>;
};

export class OrchestrateurEssaim {
  private jobs = new Map<string, JobEssaim>();
  private résultats = new Map<string, Uint8Array>(); // fragmentId → bytes
  private octetsRésultats = 0;
  private maintenant: () => number;
  private registre: RegistreEssaim;
  private identifiant: () => string;

  constructor(
    registre: RegistreEssaim,
    horloge: () => number = Date.now,
    identifiant: () => string = () => randomUUID(),
  ) {
    this.registre = registre;
    this.maintenant = horloge;
    this.identifiant = identifiant;
  }

  /* --------------------------------------------------------- planification */

  /** PLAN DE FRAGMENTS — décompose la requête en parts WebGPU (pur). */
  planifierFragments(params: {
    kind: TypeMédiaEssaim;
    prompt: string;
    ratio?: string;
    seed: number;
  }): ChargeFragment[] {
    const ratio = params.ratio ?? "1:1";
    const steps = BORNES_ESSAIM.stepsHaute;
    const guidance = BORNES_ESSAIM.guidanceHaute;
    if (params.kind === "image") {
      return [{ sous: "image", prompt: params.prompt, ratio, seed: params.seed, steps, guidance }];
    }
    if (params.kind === "video") {
      // Vidéo HAUTE QUALITÉ : 6 keyframes par défaut (jusqu'à 8) — chaque
      // keyframe est UN fragment, généré EN PARALLÈLE par un appareil différent.
      const dims = dimensionsPourRatio(ratio);
      const n = BORNES_ESSAIM.keyframesDéfaut;
      return Array.from({ length: n }, (_, i) => ({
        sous: "keyframe" as const,
        prompt: params.prompt,
        ratio,
        seed: (params.seed + i * 17) % 2 ** 31,
        steps,
        guidance,
        largeur: dims.w,
        hauteur: dims.h,
      }));
    }
    // Voix HAUTE QUALITÉ : découpage en segments courts (≤ 300 caractères —
    // plus de fragments = plus de PARALLÉLISME dans l'essaim), chaque segment
    // est UN fragment réparti dans l'essaim ; le débit varie par rang
    // (prosodie vivante après fusion).
    const segments = découperEnSegments(params.prompt, 300).slice(0, BORNES_ESSAIM.segmentsMax);
    return segments.map((texte, i) => ({
      sous: "segment" as const,
      texte,
      voix: "ff_siwis",
      vitesse: [1.0, 0.97, 1.03][i % 3],
    }));
  }

  /**
   * Crée un job : plan + enregistrement. Retourne null si les bornes
   * (jobs actifs, prompt vide) sont atteintes — jamais de surcharge muette.
   */
  créerJob(params: ParamètresJobEssaim): JobEssaim | null {
    this.purger();
    const actifs = [...this.jobs.values()].filter(
      (j) => j.état === "planifie" || j.état === "en-cours" || j.état === "fusion",
    ).length;
    if (actifs >= BORNES_ESSAIM.jobsActifsMax) return null;
    const prompt = params.prompt.trim().slice(0, 4000);
    if (!prompt) return null;

    const seed = Math.floor(this.maintenant() % 2 ** 31);
    const charges = this.planifierFragments({ ...params, prompt, seed });
    if (charges.length === 0) return null;

    const job: JobEssaim = {
      jobId: this.identifiant(),
      conversationId: params.conversationId,
      userId: params.userId,
      kind: params.kind,
      prompt,
      ratio: params.ratio,
      duréeSecondes: params.duréeSecondes,
      jobIdOrigine: params.jobIdOrigine,
      état: "planifie",
      relances: [],
      crééA: this.maintenant(),
      fragments: charges.map((charge, index) => ({
        fragmentId: this.identifiant(),
        jobId: "",
        kind: params.kind,
        index,
        total: charges.length,
        état: "en-attente",
        génération: 0,
        charge,
      })),
    };
    for (const f of job.fragments) f.jobId = job.jobId;
    this.jobs.set(job.jobId, job);
    return job;
  }

  /* ------------------------------------------------------------ attribution */

  /**
   * DISTRIBUE les fragments en attente aux 5 meilleurs appareils —
   * round-robin par score décroissant, charge plafonnée par GPU.
   * Retourne les fragments fraîchement confiés (pour l'onde SSE).
   */
  attribuer(): FragmentTravail[] {
    const confiés: FragmentTravail[] = [];
    for (const job of this.jobs.values()) {
      if (job.état !== "planifie" && job.état !== "en-cours") continue;
      const enAttente = job.fragments.filter((f) => f.état === "en-attente");
      if (enAttente.length === 0) continue;
      for (const fragment of enAttente) {
        // Essaim OUVERT : tout nœud vivant peut aider (le demandeur n'est pas
        // privilégié — la sélection est purement méritocratique par score).
        const équipe = this.registre.sélectionnerÉquipe();
        if (équipe.length === 0) break;
        const élu = équipe[0];
        if (!this.registre.charger(élu.noeudId)) break;
        fragment.état = "attribue";
        fragment.noeudId = élu.noeudId;
        fragment.attribueA = this.maintenant();
        confiés.push(fragment);
      }
      if (job.état === "planifie" && job.fragments.some((f) => f.état !== "en-attente")) {
        job.état = "en-cours";
      }
    }
    return confiés;
  }

  /** L'agent annonce qu'il EXÉCUTE le fragment (idempotent, propriété vérifiée). */
  démarrerFragment(fragmentId: string, noeudId: string): FragmentTravail | null {
    for (const job of this.jobs.values()) {
      const f = job.fragments.find((x) => x.fragmentId === fragmentId);
      if (!f) continue;
      if (f.noeudId !== noeudId) return null; // pas le propriétaire
      if (f.état === "attribue") f.état = "en-cours";
      return f;
    }
    return null;
  }

  /* --------------------------------------------------------------- résultats */

  /**
   * RÉCEPTION D'UN RÉSULTAT — le nœud renvoie sa part ; l'IA centrale
   * l'accumule. Quand TOUT est réuni, retourne l'action « fusionner »
   * (l'orchestrateur ne touche pas au binaire lui-même).
   */
  déclarerRésultat(
    fragmentId: string,
    noeudId: string,
    octets: Uint8Array,
  ): { ok: boolean; fusion?: ActionFusion; erreur?: string } {
    for (const job of this.jobs.values()) {
      const f = job.fragments.find((x) => x.fragmentId === fragmentId);
      if (!f) continue;
      if (f.noeudId !== noeudId) return { ok: false, erreur: "Fragment non attribué à ce nœud." };
      if (f.état === "termine") return { ok: false, erreur: "Fragment déjà réceptionné." };
      if (octets.byteLength > BORNES_ESSAIM.tailleFragmentMax) {
        return { ok: false, erreur: "Fragment trop volumineux." };
      }
      if (this.octetsRésultats + octets.byteLength > 48 * 1024 * 1024) {
        return { ok: false, erreur: "Mémoire centrale de fusion saturée — réessayez." };
      }
      f.état = "termine";
      f.tailleRésultat = octets.byteLength;
      this.résultats.set(fragmentId, octets);
      this.octetsRésultats += octets.byteLength;
      this.registre.décharger(noeudId);
      this.registre.créditerSuccès(noeudId);
      if (job.fragments.every((x) => x.état === "termine")) {
        job.état = "fusion";
        return {
          ok: true,
          fusion: { action: "fusionner", job, résultats: this.prendreRésultats(job) },
        };
      }
      return { ok: true };
    }
    return { ok: false, erreur: "Fragment inconnu." };
  }

  /** Consomme les résultats du job (bytes retirés de la mémoire centrale). */
  private prendreRésultats(job: JobEssaim): Map<number, Uint8Array> {
    const map = new Map<number, Uint8Array>();
    for (const f of job.fragments) {
      const b = this.résultats.get(f.fragmentId);
      if (b) {
        map.set(f.index, b);
        this.résultats.delete(f.fragmentId);
        this.octetsRésultats -= b.byteLength;
      }
    }
    return map;
  }

  /* --------------------------------------------------------------- sentinelle */

  /**
   * SENTINELLE DE RELANCE — le cœur de la demande utilisateur.
   * Balaye le registre : tout fragment attribué à un nœud DÉCONNECTÉ
   * BRUSQUEMENT (ou muet au-delà du TTL fragment) est remis en file et
   * RELANCÉ vers un autre agent (jusqu'à générationsMax). Un fragment
   * au-delà du plafond échoue HONNÊTEMENT (jamais de faux succès).
   * Retourne les fragments re-relancés (diffusion d'onde « relance »).
   */
  surveiller(): { relancés: FragmentTravail[]; échoués: FragmentTravail[] } {
    const relancés: FragmentTravail[] = [];
    const échoués: FragmentTravail[] = [];
    const ts = this.maintenant();

    this.registre.balayageRuptures((noeudPerdu) => {
      // Le nœud vient de mourir : relance immédiate de ses fragments.
      for (const job of this.jobs.values()) {
        for (const f of job.fragments) {
          if (f.noeudId === noeudPerdu.noeudId && (f.état === "attribue" || f.état === "en-cours")) {
            this.relancer(job, f, noeudPerdu.noeudId, relancés, échoués);
          }
        }
      }
    });

    // Fragments muets : nœud vivant mais part jamais rendue (onglet figé…).
    for (const job of this.jobs.values()) {
      if (job.état !== "en-cours" && job.état !== "planifie") continue;
      for (const f of job.fragments) {
        if (
          (f.état === "attribue" || f.état === "en-cours") &&
          f.attribueA !== undefined &&
          ts - f.attribueA > BORNES_ESSAIM.ttlFragmentMs
        ) {
          this.registre.décharger(f.noeudId ?? "");
          this.relancer(job, f, f.noeudId ?? "?", relancés, échoués);
        }
      }
      const reste = job.fragments.filter((f) => f.état !== "termine");
      if (reste.length === 0 && job.état === "en-cours") {
        job.état = "fusion";
      }
    }

    this.purger();
    return { relancés, échoués };
  }

  /** Relance un fragment vers l'essaim (ou le déclare échoué). */
  private relancer(
    job: JobEssaim,
    f: FragmentTravail,
    noeudPerdu: string,
    relancés: FragmentTravail[],
    échoués: FragmentTravail[],
  ): void {
    if (f.génération >= BORNES_ESSAIM.générationsMax) {
      f.état = "echoue";
      job.état = "echoue";
      job.erreur = `Fragment ${f.index + 1}/${f.total} : ${BORNES_ESSAIM.générationsMax} relances épuisées — aucun appareil n'a pu terminer cette part.`;
      job.terminéA = this.maintenant();
      échoués.push(f);
      return;
    }
    f.génération += 1;
    f.état = "en-attente";
    f.noeudId = undefined;
    f.attribueA = undefined;
    job.relances.push({
      ts: this.maintenant(),
      fragmentId: f.fragmentId,
      noeudPerdu,
    });
    relancés.push(f);
  }

  /** Échec explicite d'un fragment signalé par le nœud lui-même. */
  échouerFragment(fragmentId: string, noeudId: string, raison: string): FragmentTravail | null {
    for (const job of this.jobs.values()) {
      const f = job.fragments.find((x) => x.fragmentId === fragmentId);
      if (!f || f.noeudId !== noeudId) continue;
      this.registre.décharger(noeudId);
      const relancés: FragmentTravail[] = [];
      const échoués: FragmentTravail[] = [];
      this.relancer(job, f, noeudId, relancés, échoués);
      if (échoués.length === 0) job.erreur = undefined;
      else job.erreur = raison.slice(0, 300);
      return f;
    }
    return null;
  }

  /* ---------------------------------------------------------------- lecture */

  /** État d'un job pour son propriétaire (progression réelle par fragments). */
  étatJob(jobId: string, userId: string): JobEssaim | null {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return job;
  }

  /** Job par jobIdOrigine (le flux webgpu_media garde son identifiant). */
  jobParOrigine(jobIdOrigine: string, userId: string): JobEssaim | null {
    for (const job of this.jobs.values()) {
      if (job.jobIdOrigine === jobIdOrigine && job.userId === userId) return job;
    }
    return null;
  }

  /** Jobs actifs d'un utilisateur (panneau + diagnostics). */
  jobsDe(userId: string): JobEssaim[] {
    return [...this.jobs.values()].filter(
      (j) =>
        j.userId === userId &&
        (j.état === "planifie" || j.état === "en-cours" || j.état === "fusion"),
    );
  }

  /** Retourne un fragment par identifiant (contrôle d'accès route). */
  fragment(fragmentId: string): { job: JobEssaim; fragment: FragmentTravail } | null {
    for (const job of this.jobs.values()) {
      const f = job.fragments.find((x) => x.fragmentId === fragmentId);
      if (f) return { job, fragment: f };
    }
    return null;
  }

  /** Marque l'œuvre fusionnée (URL persistée) — fin heureuse du job. */
  scellerJob(jobId: string, url: string, taille: number): JobEssaim | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.état = "termine";
    job.résultat = { url, kind: job.kind, taille };
    job.terminéA = this.maintenant();
    return job;
  }

  /** Purge les jobs terminés au-delà de la rétention (et leurs octets restants). */
  purger(): void {
    const ts = this.maintenant();
    for (const [id, job] of this.jobs) {
      const fini = job.terminéA ?? (job.état === "termine" || job.état === "echoue" ? ts : undefined);
      if (fini && ts - fini > BORNES_ESSAIM.retentionJobMs) {
        for (const f of job.fragments) {
          const b = this.résultats.get(f.fragmentId);
          if (b) {
            this.octetsRésultats -= b.byteLength;
            this.résultats.delete(f.fragmentId);
          }
        }
        this.jobs.delete(id);
      }
    }
  }

  /** Vide tout (tests). */
  réinitialiser(): void {
    this.jobs.clear();
    this.résultats.clear();
    this.octetsRésultats = 0;
  }
}

/** Instances centrales (le registre est partagé avec les routes). */
export const orchestrateurEssaim = new OrchestrateurEssaim(registreEssaim);
