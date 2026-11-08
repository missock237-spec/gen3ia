/**
 * EFFECTEUR PONT MÉDIA PHOTORÉALISTE — branchement honnête des pools
 * GENERER_IMAGE / GENERER_AUDIO / GENERER_VIDEO aux moteurs réels du
 * gen3-media-pack (SDXL, F5-TTS/Kokoro, LTX-Video) via le pont REST
 * `training/gen3-media-pack/bridge/gen3_media_bridge.py`.
 *
 * PHILOSOPHIE (inchangée) : le cerveau SNN décide (résonance de pool ≥ 0.80),
 * l'effecteur exécute. Le pont média est un ORGANE du corps sémantique, pas
 * une IA externe : les poids des modèles restent auto-hébergés (conforme
 * « 100 % interne » — aucune clé de service d'IA tierce n'est impliquée).
 *
 * HONNÊTETÉ : sans MEDIA_BRIDGE_URL + MEDIA_BRIDGE_API_KEY injectés par le
 * runtime, toute action retourne PONT_NON_CONFIGURE — jamais de faux média.
 * La sonde /capabilities du pont ne déclare que ce qui tourne réellement.
 * L'exécution sandbox d'un pont non configuré remonte ECHEC au noyau
 * (statutEffectifPont) — jamais un succès déguisé.
 *
 * CONTRAT TOOL OS : executerEnSandbox est synchrone ; la génération GPU est
 * asynchrone (jusqu'à 30 min). L'outil lancé retourne donc
 * PONT_GENERATION_LANCEE avec un identifiant, et le résultat réel se lit via
 * attendreResultat(id) — la promesse est résolue par le pont, jamais simulée.
 *
 * Module PUR — aucune dépendance Node : la fonction fetch et la configuration
 * (url, clé) sont injectées au constructeur (cf. runtime.ts).
 */

import {
  POOL_GENERER_IMAGE,
  POOL_GENERER_AUDIO,
  POOL_GENERER_VIDEO,
} from "../core/types";
import type {
  Effecteur,
  EffectorActionResult,
  EffectorStatus,
} from "../core/types";
import { actionEffecteur } from "../core/types";
import type { EspaceFiltreResonant } from "../core/resonant-space";
import type { SystemeExploitationOutils } from "./tool-os";
import { statutEffectifDuResultat } from "./audio";
// Canaux écoutés : DÉFINIS UNE SEULE FOIS dans les effecteurs existants
// (visual.ts / audio.ts / video.ts) et importés ici — aucune redéfinition,
// le barrel index.ts reste sans ambiguïté (TS2308, CI PR #136).
import { CANAL_GENERER_IMAGE } from "./visual";
import { CANAL_GENERER_AUDIO } from "./audio";
import { CANAL_GENERER_VIDEO } from "./video";

/** Configuration injectée par le runtime — aucun accès direct à l'environnement. */
export interface ConfigPontMedia {
  /** URL de base du pont (ex : http://gpu-host:8787). */
  url?: string;
  /** Clé partagée MEDIA_BRIDGE_API_KEY (comparée en temps constant côté pont). */
  cleApi?: string;
  /** Fetch injectable (tests, edge, audit). */
  fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
  }>;
  /** Délai global de génération (défaut 1 800 000 ms — borne du pont). */
  timeoutMs?: number;
}

export interface ParametresImage {
  prompt: string;
  largeur?: number;
  hauteur?: number;
  steps?: number;
  graine?: number;
}

export interface ParametresVoix {
  texte: string;
  moteur?: "f5" | "kokoro";
  ref?: string;
  langue?: string;
  voix?: string;
}

export interface ParametresVideoPont {
  prompt: string;
  largeur?: number;
  hauteur?: number;
  frames?: number;
  steps?: number;
  graine?: number;
}

/** Résultat honnête : aucun statut inventé, chaque échec porte sa raison. */
export interface ResultatMedia {
  statut_rendu: "SUCCES" | "PONT_NON_CONFIGURE" | "PONT_INACCESSIBLE" | "ECHEC_GENERATION";
  mime?: string;
  base64?: string;
  octets?: number;
  gpuSecondes?: number;
  details?: string;
}

/** Sonde /capabilities du pont (convention honnêteté gen3). */
export interface CapacitesPont {
  joignable: boolean;
  gpu?: boolean;
  profil?: string;
  vramGo?: number;
  capacites?: string[];
  engines?: Record<string, string>;
  refus?: string;
}

const DEFAUTS_MOTEUR = {
  largeurImage: 1024,
  hauteurImage: 1024,
  stepsImage: 30,
  largeurVideo: 480,
  hauteurVideo: 288,
  framesVideo: 41,
  stepsVideo: 40,
} as const;

export class EffecteurMediaBridge implements Effecteur {
  readonly nom = "effecteur_media_bridge";

  private readonly url?: string;
  private readonly cleApi?: string;
  private readonly fetchImpl?: NonNullable<ConfigPontMedia["fetchImpl"]>;
  private readonly timeoutMs: number;
  private compteur = 0;
  private readonly promesses = new Map<string, Promise<ResultatMedia>>();

  constructor(
    private readonly espaceResonant: EspaceFiltreResonant,
    private readonly toolOs: SystemeExploitationOutils,
    config: ConfigPontMedia = {},
  ) {
    this.url = config.url;
    this.cleApi = config.cleApi;
    this.fetchImpl = config.fetchImpl;
    this.timeoutMs = config.timeoutMs ?? 1_800_000;

    this.espaceResonant.registerOutputPool(CANAL_GENERER_IMAGE, [...POOL_GENERER_IMAGE]);
    this.espaceResonant.registerOutputPool(CANAL_GENERER_AUDIO, [...POOL_GENERER_AUDIO]);
    this.espaceResonant.registerOutputPool(CANAL_GENERER_VIDEO, [...POOL_GENERER_VIDEO]);

    this.toolOs.enregistrerOutil(
      "generer_media_photoreal",
      (args) => this.lancerDepuisOutil(args),
      "Génère un média photoréaliste (image SDXL, voix F5/Kokoro, clip LTX-Video) via le pont média GPU — honnête : PONT_NON_CONFIGURE si le pont est absent.",
    );
  }

  /** Sonde honnête : GET /capabilities (lecture sans clé, écriture avec clé). */
  async proberCapacites(): Promise<CapacitesPont> {
    if (!this.url || !this.fetchImpl) {
      return {
        joignable: false,
        refus: "PONT_NON_CONFIGURE — MEDIA_BRIDGE_URL / MEDIA_BRIDGE_API_KEY absents du runtime.",
      };
    }
    try {
      const reponse = await avecDelai(
        this.fetchImpl(joinUrl(this.url, "/capabilities"), { method: "GET", headers: {} }),
        this.timeoutMs,
      );
      const corps = (await reponse.json()) as {
        gpu?: boolean;
        profil?: string;
        vram_go?: number;
        capacites?: string[];
        engines?: Record<string, string>;
        refus?: string;
      };
      return {
        joignable: true,
        gpu: corps.gpu === true,
        profil: corps.profil,
        vramGo: corps.vram_go,
        capacites: corps.capacites ?? [],
        engines: corps.engines,
        refus: corps.refus,
      };
    } catch (erreur) {
      return { joignable: false, refus: `PONT_INACCESSIBLE : ${message(erreur)}` };
    }
  }

  /** Génération d'une image photoréaliste (SDXL + LoRA gen3). */
  async genererImage(p: ParametresImage): Promise<ResultatMedia> {
    if (!p.prompt || p.prompt.length === 0) {
      return { statut_rendu: "ECHEC_GENERATION", details: "Prompt requis." };
    }
    if (p.prompt.length > 2000) {
      return { statut_rendu: "ECHEC_GENERATION", details: "Prompt > 2000 caractères — borne du pont." };
    }
    return this.appelerPont("image", {
      prompt: p.prompt,
      largeur: p.largeur ?? DEFAUTS_MOTEUR.largeurImage,
      hauteur: p.hauteur ?? DEFAUTS_MOTEUR.hauteurImage,
      steps: p.steps ?? DEFAUTS_MOTEUR.stepsImage,
      ...(p.graine !== undefined ? { graine: p.graine } : {}),
    });
  }

  /** Génération d'une voix parlée (F5-TTS CC-BY-NC ou Kokoro Apache-2.0). */
  async genererVoix(p: ParametresVoix): Promise<ResultatMedia> {
    if (!p.texte || p.texte.trim().length === 0) {
      return { statut_rendu: "ECHEC_GENERATION", details: "Texte à vocaliser requis." };
    }
    if (p.texte.length > 4000) {
      return { statut_rendu: "ECHEC_GENERATION", details: "Texte > 4000 caractères — borne du pont." };
    }
    return this.appelerPont("tts", {
      texte: p.texte,
      moteur: p.moteur ?? "f5",
      ...(p.ref ? { ref: p.ref } : {}),
      langue: p.langue ?? "f",
      voix: p.voix ?? "ff_siwis",
    });
  }

  /** Génération d'un clip vidéo réaliste (LTX-Video + LoRA gen3). */
  async genererVideo(p: ParametresVideoPont): Promise<ResultatMedia> {
    if (!p.prompt || p.prompt.length === 0) {
      return { statut_rendu: "ECHEC_GENERATION", details: "Prompt requis." };
    }
    if (p.prompt.length > 2000) {
      return { statut_rendu: "ECHEC_GENERATION", details: "Prompt > 2000 caractères — borne du pont." };
    }
    return this.appelerPont("video", {
      prompt: p.prompt,
      largeur: p.largeur ?? DEFAUTS_MOTEUR.largeurVideo,
      hauteur: p.hauteur ?? DEFAUTS_MOTEUR.hauteurVideo,
      frames: p.frames ?? DEFAUTS_MOTEUR.framesVideo,
      steps: p.steps ?? DEFAUTS_MOTEUR.stepsVideo,
      ...(p.graine !== undefined ? { graine: p.graine } : {}),
    });
  }

  /**
   * Écoute du noyau : pour chaque canal dont la résonance atteint 0.80,
   * la commande est lancée via le Tool OS (sandbox, métriques d'usage,
   * feedback). Le statut remonté au noyau est HONNÊTE (statutEffectifPont) :
   * un pont non configuré / inaccessible / en échec remonte ECHEC.
   */
  evaluerEtExecuter(
    spikedNeurones: number[],
    parametres?: Record<string, unknown>,
  ): EffectorActionResult[] {
    const resultats: EffectorActionResult[] = [];
    const canaux: Array<[string, string]> = [
      [CANAL_GENERER_IMAGE, "image"],
      [CANAL_GENERER_AUDIO, "voix"],
      [CANAL_GENERER_VIDEO, "video"],
    ];
    for (const [canal, mode] of canaux) {
      const score = this.espaceResonant.readResonance(spikedNeurones, canal);
      if (score < 0.8) continue;
      const parametresMode = { mode, ...(parametres ?? {}) };
      const executions = this.toolOs.executerEnSandbox("generer_media_photoreal", parametresMode);
      for (const execution of executions) {
        resultats.push(
          actionEffecteur(canal, statutEffectifPont(execution), {
            outil: execution["outil"],
            dureeMs: execution["dureeMs"],
            resultat: execution["resultat"],
            scoreResonance: score,
            parametres: parametresMode,
          }),
        );
      }
    }
    return resultats;
  }

  /**
   * Lancement synchrone (contrat Tool OS) d'une génération asynchrone :
   * retourne immédiatement un accusé honnête PONT_GENERATION_LANCEE ; le
   * résultat réel se lit via attendreResultat(id). Sans pont configuré,
   * aucune promesse n'est créée : PONT_NON_CONFIGURE immédiat.
   */
  private lancerDepuisOutil(args: Record<string, unknown>): Record<string, unknown> {
    const mode = typeof args["mode"] === "string" ? args["mode"] : "";
    if (!this.url || !this.cleApi || !this.fetchImpl) {
      return {
        statut_rendu: "PONT_NON_CONFIGURE",
        details:
          "MEDIA_BRIDGE_URL et MEDIA_BRIDGE_API_KEY doivent être injectés par le runtime (cf. docs/entrainement/plan-multimodal-ondes.md).",
      };
    }
    let promesse: Promise<ResultatMedia>;
    if (mode === "image") {
      promesse = this.genererImage(normaliserImage(args));
    } else if (mode === "voix") {
      promesse = this.genererVoix(normaliserVoix(args));
    } else if (mode === "video") {
      promesse = this.genererVideo(normaliserVideo(args));
    } else {
      return { statut_rendu: "ECHEC_GENERATION", details: "mode requis : image | voix | video." };
    }
    this.compteur += 1;
    const id = `pont-${Date.now()}-${this.compteur}`;
    this.promesses.set(id, promesse);
    void promesse
      .then(() => this.promesses.delete(id))
      .catch(() => this.promesses.delete(id));
    return {
      statut_rendu: "PONT_GENERATION_LANCEE",
      id_promesse: id,
      mode,
      note: "Génération GPU asynchrone — lire le résultat via attendreResultat(id).",
    };
  }

  /** Résultat d'une génération lancée par l'outil (jamais simulé). */
  async attendreResultat(id: string): Promise<ResultatMedia> {
    const promesse = this.promesses.get(id);
    if (!promesse) {
      return { statut_rendu: "ECHEC_GENERATION", details: `Promesse inconnue : ${id}` };
    }
    return promesse;
  }

  /** Appel POST authentifié vers le pont — statuts honnêtes en tout cas. */
  private async appelerPont(
    action: "image" | "tts" | "video",
    corps: Record<string, unknown>,
  ): Promise<ResultatMedia> {
    if (!this.url || !this.cleApi || !this.fetchImpl) {
      return {
        statut_rendu: "PONT_NON_CONFIGURE",
        details: "MEDIA_BRIDGE_URL et MEDIA_BRIDGE_API_KEY doivent être injectés par le runtime (cf. docs/entrainement/plan-multimodal-ondes.md).",
      };
    }
    const chemin = action === "image" ? "/v1/image" : action === "tts" ? "/v1/tts" : "/v1/video";
    try {
      const reponse = await avecDelai(
        this.fetchImpl(joinUrl(this.url, chemin), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cleApi}` },
          body: JSON.stringify(corps),
        }),
        this.timeoutMs,
      );
      if (!reponse.ok) {
        const texte = (await reponse.text()).slice(-400);
        return { statut_rendu: "ECHEC_GENERATION", details: `Pont ${reponse.status} : ${texte}` };
      }
      const donnees = (await reponse.json()) as {
        mime?: string;
        base64?: string;
        octets?: number;
        gpu_secondes?: number;
      };
      if (!donnees || typeof donnees.base64 !== "string" || donnees.base64.length === 0) {
        return { statut_rendu: "ECHEC_GENERATION", details: "Le pont n'a renvoyé aucun média." };
      }
      return {
        statut_rendu: "SUCCES",
        mime: donnees.mime,
        base64: donnees.base64,
        octets: donnees.octets,
        gpuSecondes: donnees.gpu_secondes,
      };
    } catch (erreur) {
      return { statut_rendu: "PONT_INACCESSIBLE", details: message(erreur) };
    }
  }
}

/**
 * Statut effectif d'une action pont : l'exécution sandbox est SUCCES dès que
 * l'outil a tourné, mais un rendu honnête qui déclare un échec du pont
 * (non configuré, inaccessible, génération échouée) remonte ECHEC au noyau —
 * jamais un succès déguisé. PONT_GENERATION_LANCEE reste SUCCES : le
 * lancement réel a eu lieu (id de promesse remis, résultat lisible).
 */
function statutEffectifPont(execution: EffectorActionResult): EffectorStatus {
  const statutBase = statutEffectifDuResultat(execution);
  if (statutBase !== "SUCCES") return statutBase;
  const rendu = execution["resultat"];
  const statutRendu =
    typeof rendu === "object" && rendu !== null
      ? (rendu as { statut_rendu?: unknown }).statut_rendu
      : undefined;
  if (
    statutRendu === "PONT_NON_CONFIGURE" ||
    statutRendu === "PONT_INACCESSIBLE" ||
    statutRendu === "ECHEC_GENERATION"
  ) {
    return "ECHEC";
  }
  return statutBase;
}

function joinUrl(base: string, chemin: string): string {
  return base.endsWith("/") ? `${base}${chemin.slice(1)}` : `${base}${chemin}`;
}

function avecDelai<T>(promesse: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promesse,
    new Promise<never>((_, rejeter) => {
      setTimeout(() => rejeter(new Error(`Délai dépassé après ${ms} ms`)), ms);
    }),
  ]);
}

function message(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : String(erreur);
}

function chaine(valeur: unknown): string | undefined {
  return typeof valeur === "string" && valeur.length > 0 ? valeur : undefined;
}

function nombre(valeur: unknown): number | undefined {
  return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : undefined;
}

function normaliserImage(args: Record<string, unknown>): ParametresImage {
  return {
    prompt: chaine(args["prompt"]) ?? "Fractale neuronale abstraite",
    largeur: nombre(args["largeur"]),
    hauteur: nombre(args["hauteur"]),
    steps: nombre(args["steps"]),
    graine: nombre(args["graine"]),
  };
}

function normaliserVoix(args: Record<string, unknown>): ParametresVoix {
  const moteur = chaine(args["moteur"]);
  return {
    texte: chaine(args["texte"]) ?? "",
    moteur: moteur === "kokoro" || moteur === "f5" ? moteur : "f5",
    ref: chaine(args["ref"]),
    langue: chaine(args["langue"]),
    voix: chaine(args["voix"]),
  };
}

function normaliserVideo(args: Record<string, unknown>): ParametresVideoPont {
  return {
    prompt: chaine(args["prompt"]) ?? "Onde corticale en propagation",
    largeur: nombre(args["largeur"]),
    hauteur: nombre(args["hauteur"]),
    frames: nombre(args["frames"]),
    steps: nombre(args["steps"]),
    graine: nombre(args["graine"]),
  };
}
