"use client";

/**
 * AGENT GEN3 CÔTÉ NAVIGATEUR — le runtime de l'essaim média.
 *
 * À l'inscription / à la connexion, `installerAgentGen3()` :
 *  1. télécharge le PETIT AGENT dans le cache du navigateur (Service
 *     Worker /gen3-agent/sw.js — présence permanente, coffre des poids) ;
 *  2. sonde le GPU local (WebGPU) et émet le PREMIER BATTEMENT D'ONDE
 *     vers l'IA centrale (POST /api/essaim/ondes) ;
 *  3. se SYNTONISE sur l'onde porteuse (SSE /api/essaim/canal) pour
 *     recevoir les parts de tâche en temps réel ;
 *  4. boucle de vie : battement toutes les ~12 s (avec gigue anti-synchronisation).
 *
 * Quand l'IA centrale confie une part (affectation / relance), l'agent
 * l'exécute via son WebGPU (moteurs SD photoréalisme / Kokoro voix) et
 * RENVOIE le signal à l'IA centrale (POST /api/essaim/resultat). En cas
 * d'échec local, il le déclare : l'IA centrale RELANCE la part ailleurs.
 *
 * Toutes les erreurs sont honnêtes : un agent sans WebGPU s'annonce
 * inutilisable (score 0) et ne reçoit jamais de part.
 */

import { authFetch } from "@/lib/firebase/auth-client";
import { détecterWebGpu } from "@/lib/neural/webgpu/detect";

/* --------------------------------------------------------------- états --- */

export interface ÉtatAgentGen3 {
  statut: "inactif" | "installation" | "actif" | "échec";
  noeudId?: string;
  adaptateur?: string;
  score?: number;
  noeudsEnLigne?: number;
  /** Part en cours d'exécution (libellé lisible). */
  partEnCours?: string;
  partsTerminées: number;
  relancesReçues: number;
  raison?: string;
}

type Auditeur = (état: ÉtatAgentGen3) => void;

const état: ÉtatAgentGen3 = {
  statut: "inactif",
  partsTerminées: 0,
  relancesReçues: 0,
};
const auditeurs = new Set<Auditeur>();

function notifier(): void {
  for (const a of auditeurs) {
    try {
      a({ ...état });
    } catch {
      /* un auditeur défaillant n'empoisonne pas les autres */
    }
  }
}

/** S'abonne aux changements d'état de l'agent (panneau UI). */
export function sAbonnerAgent(a: Auditeur): () => void {
  auditeurs.add(a);
  a({ ...état });
  return () => auditeurs.delete(a);
}

/** État instantané (sans abonnement). */
export function étatAgentActuel(): ÉtatAgentGen3 {
  return { ...état };
}

/* ------------------------------------------------------------ identité --- */

const CLÉ_NOEUD = "gen3-agent-noeud";

function identitéNoeud(): string {
  try {
    const existant = sessionStorage.getItem(CLÉ_NOEUD);
    if (existant && /^[a-zA-Z0-9_-]{8,80}$/.test(existant)) return existant;
    const frais = `essaim-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    sessionStorage.setItem(CLÉ_NOEUD, frais);
    return frais;
  } catch {
    return `essaim-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }
}

/* ------------------------------------------------------------ ondes POST -- */

interface AffectationBrute {
  fragmentId: string;
  jobId: string;
  kind: "image" | "voice" | "video";
  index: number;
  total: number;
  génération: number;
  charge:
    | { sous: "keyframe" | "image"; prompt: string; ratio: string; seed: number; steps: number; guidance: number; largeur?: number; hauteur?: number }
    | { sous: "segment"; texte: string; voix: string; vitesse: number };
}

let noeudCourant: string | null = null;
let battementTimer: ReturnType<typeof setInterval> | null = null;
let porteuse: EventSource | null = null;
let fileParts: AffectationBrute[] = [];
let exécutionEnCours = false;
let installation: Promise<ÉtatAgentGen3> | null = null;

/** Émet un battement d'onde (et signale le démarrage d'une part si besoin). */
async function battre(fragmentId?: string): Promise<AffectationBrute[]> {
  if (!noeudCourant) return [];
  const cap = await détecterWebGpu();
  try {
    const r = await authFetch("/api/essaim/ondes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noeudId: noeudCourant,
        fragmentId,
        capacités: {
          webgpu: cap.disponible,
          memoireGo: cap.memoireGo,
          adaptateur: cap.adaptateur,
          features: cap.features,
          appareil: `${navigator.platform ?? ""} ${navigator.userAgent.slice(0, 60)}`,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as {
      noeud?: { score: number };
      essaim?: { noeudsEnLigne: number };
      affectations?: AffectationBrute[];
    };
    état.score = data.noeud?.score;
    état.noeudsEnLigne = data.essaim?.noeudsEnLigne;
    for (const f of data.affectations ?? []) enqueuer(f);
    notifier();
    return data.affectations ?? [];
  } catch {
    return []; // onde perdue : le prochain battement rattrapera
  }
}

/* --------------------------------------------------------- exécution GPU -- */

function libelléPart(f: AffectationBrute): string {
  if (f.charge.sous === "segment") return `segment vocal ${f.index + 1}/${f.total}`;
  if (f.charge.sous === "keyframe") return `keyframe ${f.index + 1}/${f.total}`;
  return "image photoréaliste";
}

async function exécuterPart(f: AffectationBrute): Promise<void> {
  état.partEnCours = libelléPart(f);
  notifier();
  try {
    let blob: Blob;
    if (f.charge.sous === "segment") {
      const { générerVoixHumaine } = await import("@/lib/neural/webgpu/voice-engine");
      const res = await générerVoixHumaine({
        texte: f.charge.texte,
        voix: f.charge.voix,
        vitesse: f.charge.vitesse,
      });
      blob = res.blob;
    } else {
      const { générerImageWebGpu } = await import("@/lib/neural/webgpu/image-engine");
      const res = await générerImageWebGpu({
        prompt: f.charge.prompt,
        ratio: f.charge.ratio,
        seed: f.charge.seed,
        steps: f.charge.steps,
        guidance: f.charge.guidance,
      });
      blob = res.blob;
    }
    const form = new FormData();
    form.set("noeudId", noeudCourant ?? "");
    form.set("fragmentId", f.fragmentId);
    form.set("file", blob, `fragment-${f.fragmentId.slice(0, 8)}.${f.kind === "voice" ? "wav" : "png"}`);
    const r = await authFetch("/api/essaim/resultat", { method: "POST", body: form });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `retour refusé (${r.status})`);
    }
    état.partsTerminées += 1;
  } catch (e) {
    // Échec local déclaré : l'IA centrale RELANCE la part vers un autre agent.
    try {
      const form = new FormData();
      form.set("noeudId", noeudCourant ?? "");
      form.set("fragmentId", f.fragmentId);
      form.set("echec", "1");
      form.set("raison", e instanceof Error ? e.message : "échec GPU local");
      await authFetch("/api/essaim/resultat", { method: "POST", body: form });
    } catch {
      /* la sentinelle centrale détectera le nœud muet de toute façon */
    }
  } finally {
    état.partEnCours = undefined;
    notifier();
  }
}

/** Boucle d'exécution séquentielle (UN GPU = UNE part à la fois). */
async function viderFile(): Promise<void> {
  if (exécutionEnCours) return;
  exécutionEnCours = true;
  try {
    while (fileParts.length > 0) {
      const f = fileParts.shift();
      if (!f) break;
      await exécuterPart(f);
      // Battement intermédiaire : le registre central garde une onde fraîche.
      void battre();
    }
  } finally {
    exécutionEnCours = false;
  }
}

function enqueuer(f: AffectationBrute): void {
  if (fileParts.some((x) => x.fragmentId === f.fragmentId)) return;
  if (f.génération > 0) état.relancesReçues += 1;
  fileParts.push(f);
  notifier();
  void viderFile();
}

/* -------------------------------------------------------- onde porteuse -- */

function syntoniser(): void {
  if (!noeudCourant || porteuse) return;
  try {
    porteuse = new EventSource(`/api/essaim/canal?noeudId=${encodeURIComponent(noeudCourant)}`);
    const traiter = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(event.data) as
          | { type: "affectation"; fragments: AffectationBrute[] }
          | { type: "relance"; fragment: AffectationBrute }
          | { type: "syntonise"; noeudId: string };
        if (data.type === "affectation") for (const f of data.fragments) enqueuer(f);
        if (data.type === "relance") enqueuer(data.fragment);
      } catch {
        /* onde illisible : ignorée */
      }
    };
    porteuse.addEventListener("affectation", traiter as EventListener);
    porteuse.addEventListener("relance", traiter as EventListener);
    porteuse.onerror = () => {
      // Onde SSE perdue : le battement POST reste la double ceinture.
      porteuse?.close();
      porteuse = null;
    };
  } catch {
    porteuse = null;
  }
}

/* ------------------------------------------------------------- installer -- */

/**
 * Installe l'agent gen3 dans le navigateur (idempotent — promesse unique).
 * Appelé automatiquement à la session active (inscription OU connexion).
 */
export function installerAgentGen3(): Promise<ÉtatAgentGen3> {
  if (installation) return installation;
  installation = (async () => {
    état.statut = "installation";
    notifier();
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      état.statut = "échec";
      état.raison = "Service Worker indisponible sur ce navigateur.";
      notifier();
      return { ...état };
    }
    try {
      // 1. LE PETIT AGENT SE TÉLÉCHARGE DANS LE CACHE DU NAVIGATEUR.
      await navigator.serviceWorker.register("/gen3-agent/sw.js", {
        scope: "/gen3-agent/",
        updateViaCache: "none",
      });
      // 2. SONDE GPU + IDENTITÉ D'ONDE.
      const cap = await détecterWebGpu();
      noeudCourant = identitéNoeud();
      état.noeudId = noeudCourant;
      état.adaptateur = cap.adaptateur;
      if (!cap.disponible) {
        // Honnêteté : sans WebGPU le nœud s'annonce à score 0 — l'essaim
        // ne lui confiera jamais de part, mais sa présence est enregistrée.
        état.raison = cap.raison ?? "WebGPU indisponible";
      }
      // 3. PREMIER BATTEMENT + 4. SYNTONIE SUR L'ONDE PORTEUSE.
      await battre();
      if (cap.disponible) syntoniser();
      battementTimer = setInterval(() => {
        void battre().then(() => {
          if (état.statut !== "actif") {
            état.statut = "actif";
            notifier();
          }
        });
      }, 12_000 + Math.floor(Math.random() * 1500));
      état.statut = cap.disponible ? "actif" : "échec";
      notifier();
      return { ...état };
    } catch (e) {
      état.statut = "échec";
      état.raison = e instanceof Error ? e.message : "installation impossible";
      notifier();
      return { ...état };
    }
  })();
  return installation;
}

/** Départ PROPRE (déconnexion) : onde d'adieu + arrêt des fréquences. */
export async function désinstallerAgentGen3(): Promise<void> {
  if (battementTimer) {
    clearInterval(battementTimer);
    battementTimer = null;
  }
  if (porteuse) {
    porteuse.close();
    porteuse = null;
  }
  fileParts = [];
  if (noeudCourant) {
    try {
      await authFetch("/api/essaim/ondes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noeudId: noeudCourant }),
      });
    } catch {
      /* le TTL central nettoiera de toute façon */
    }
  }
  noeudCourant = null;
  état.statut = "inactif";
  état.score = undefined;
  état.partEnCours = undefined;
  notifier();
}

/* ------------------------------------------------- soumission (demandeur) -- */

export interface SoumissionEssaim {
  jobId: string;
  conversationId: string;
  kind: "image" | "voice" | "video";
  prompt: string;
  ratio?: string;
  durationSeconds?: number;
}

export interface RéponseSoumission {
  ok: boolean;
  jobId?: string;
  fragments?: number;
  équipe?: number;
  enAttente?: number;
  error?: string;
}

/** Le demandeur SOUMET sa requête à l'IA centrale (décomposition + top-5). */
export async function soumettreJobEssaim(s: SoumissionEssaim): Promise<RéponseSoumission> {
  try {
    const r = await authFetch("/api/essaim/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await r.json()) as {
      success?: boolean;
      jobId?: string;
      fragments?: number;
      équipe?: number;
      enAttente?: number;
      error?: string;
    };
    if (!r.ok || !data.success || !data.jobId) {
      return { ok: false, error: data.error ?? `soumission refusée (${r.status})` };
    }
    return {
      ok: true,
      jobId: data.jobId,
      fragments: data.fragments,
      équipe: data.équipe,
      enAttente: data.enAttente,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "réseau indisponible" };
  }
}

export interface SuiviJobEssaim {
  ok: boolean;
  état?: "planifie" | "en-cours" | "fusion" | "termine" | "echoue";
  pourcent?: number;
  fragments?: number;
  terminés?: number;
  relances?: number;
  erreur?: string;
  livraison?: { message: Record<string, unknown>; artifact: Record<string, unknown> };
}

/** Sonde la progression réelle du job (état par fragments, relances incluses). */
export async function sonderJobEssaim(jobId: string): Promise<SuiviJobEssaim> {
  try {
    const r = await authFetch(`/api/essaim/job/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) return { ok: false, erreur: "job inconnu" };
    const data = (await r.json()) as {
      success?: boolean;
      job?: {
        état: SuiviJobEssaim["état"];
        pourcent: number;
        fragments: number;
        terminés: number;
        relances: number;
        erreur?: string;
        livraison?: SuiviJobEssaim["livraison"];
      };
    };
    if (!r.ok || !data.success || !data.job) return { ok: false, erreur: "sonde refusée" };
    return {
      ok: true,
      état: data.job.état,
      pourcent: data.job.pourcent,
      fragments: data.job.fragments,
      terminés: data.job.terminés,
      relances: data.job.relances,
      erreur: data.job.erreur,
      livraison: data.job.livraison,
    };
  } catch (e) {
    return { ok: false, erreur: e instanceof Error ? e.message : "réseau indisponible" };
  }
}
