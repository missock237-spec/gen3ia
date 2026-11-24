/**
 * COLLECTEUR AUTONOME (Lot 2 — Gen3ia Autonomous Data Acquisition).
 *
 * Module-agent du Gen3ia Autonomous Core : à CHAQUE cycle de 5 minutes, il
 * prend la prochaine source due (tour de rôle, débit respecté), collecte
 * UNE unité bornée (timeout + plafond d'octets), et dépose un LOT dans la
 * file persistante du pipeline — puis rend la main IMMÉDIATEMENT (le
 * traitement est un autre module ; aucun blocage possible).
 *
 * Types "hub" (HF/Kaggle) : SKIP volontaire — la boucle existante
 * `lib/entrainement-auto` les collecte déjà (Règle 2 du plan : réutiliser,
 * ne pas reconstruire ; zéro double collecte).
 *
 * Respect des sources (obligatoire) : API publiques documentées, User-Agent
 * honnête, timeout, plafond d'octets, intervalle minimum par source.
 */

import { createHash } from "node:crypto";

import type { ModuleAgent } from "../core/types";
import type { FileLots } from "../pipeline/queue";
import { RegistreSources } from "./source-registry";
import type { Fetcher, LotCollecte } from "./types";

/** Caps de collecte honnêtes (plan : commencer léger, augmenter ensuite). */
const MAX_OCTETS_COLLECTE = 256 * 1024; // 256 Ko par lot
const TIMEOUT_COLLECTE_MS = 20_000;
const USER_AGENT = "gen3ia-autonomous-brain/1.0 (acquisition publique respectueuse; contact: operateur gen3ia.online)";

/** Types de contenus acceptés (API publiques) — tout le reste est refusé. */
const CONTENT_TYPES_OK = ["application/json", "text/html", "application/atom+xml", "text/plain", "application/xml", "text/xml"];

/** Fetcher RÉEL (production) : timeout + plafond d'octets en streaming. */
export function fetcherReel(): Fetcher {
  return async (url, { timeoutMs, maxOctets, userAgent }) => {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), timeoutMs);
    try {
      const reponse = await fetch(url, {
        signal: controleur.signal,
        headers: { "user-agent": userAgent, accept: "application/json, text/html, application/atom+xml, text/plain" },
        redirect: "follow",
      });
      const contentType = reponse.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!reponse.ok) {
        return { ok: false, statut: reponse.status, contentType, contenu: "", erreur: `HTTP ${reponse.status}` };
      }
      if (!CONTENT_TYPES_OK.some((t) => contentType === t || contentType.startsWith(t.split("/")[0] + "/"))) {
        return { ok: false, statut: reponse.status, contentType, contenu: "", erreur: `type de contenu non collectable : ${contentType || "absent"}` };
      }
      // Lecture bornée : jamais plus de maxOctets (plafond en streaming).
      const reader = reponse.body?.getReader();
      if (!reader) {
        return { ok: false, statut: reponse.status, contentType, contenu: "", erreur: "corps illisible" };
      }
      const morceaux: Uint8Array[] = [];
      let total = 0;
      let tronque = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxOctets) {
          morceaux.push(value.slice(0, value.byteLength - (total - maxOctets)));
          tronque = true;
          break;
        }
        morceaux.push(value);
      }
      try {
        await reader.cancel();
      } catch {
        /* flux déjà fermé — rien à faire. */
      }
      const texte = new TextDecoder("utf-8", { fatal: false }).decode(concat(morceaux));
      return { ok: true, statut: reponse.status, contentType, contenu: texte + (tronque ? "\n[TRONQUÉ]" : "") };
    } catch (erreur) {
      const message = erreur instanceof Error ? erreur.message : String(erreur);
      return { ok: false, statut: null, contentType: "", contenu: "", erreur: message.includes("abort") ? `timeout ${timeoutMs} ms` : message };
    } finally {
      clearTimeout(minuteur);
    }
  };
}

function concat(morceaux: Uint8Array[]): Uint8Array {
  const total = morceaux.reduce((s, m) => s + m.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const m of morceaux) {
    out.set(m, offset);
    offset += m.byteLength;
  }
  return out;
}

/** Empreinte stable d'un contenu (déduplication pipeline). */
export function empreinteContenu(contenu: string): string {
  return createHash("sha256").update(contenu).digest("hex").slice(0, 16);
}

/** Options du collecteur (tout injectable pour les tests). */
export interface OptionsCollecteur {
  registre: RegistreSources;
  file: FileLots;
  fetcher?: Fetcher;
  maxOctets?: number;
  timeoutMs?: number;
}

/**
 * Le module-agent "acquisition" — connecté au core, il collecte une unité
 * par cycle et dépose le lot dans la file (collecte ≠ traitement).
 */
export function agentCollecteur(options: OptionsCollecteur): ModuleAgent {
  const fetcher = options.fetcher ?? fetcherReel();
  const maxOctets = options.maxOctets ?? MAX_OCTETS_COLLECTE;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_COLLECTE_MS;
  return {
    id: "acquisition",
    nom: "Agent d'acquisition autonome",
    role: "01. DATA ACQUISITION — collecte publique bornée, cycles 5 min",
    async tick(ctx) {
      const source = options.registre.prochaineDue(Date.now());
      if (!source) {
        return {
          statut: "rien_a_faire",
          message: "Aucune source due à ce cycle (intervalles de débit respectés).",
        };
      }
      const tache = ctx.taches.creer({ module: "acquisition", cycle: ctx.cycle, type: `collecte:${source.id}` });
      if (tache) ctx.taches.demarrer(tache.id);

      const resultat = await fetcher(source.url, { timeoutMs, maxOctets, userAgent: USER_AGENT });
      // Le registre est persisté après CHAQUE tentative (collecte ou erreur) :
      // tour de rôle et erreurs survivent au redémarrage (traçabilité).
      const persisterRegistre = (): void => {
        options.registre.persister();
      };
      if (!resultat.ok) {
        options.registre.noterErreur(source.id, resultat.erreur ?? `HTTP ${resultat.statut}`);
        persisterRegistre();
        if (tache) ctx.taches.terminer(tache.id, `échec honnête : ${resultat.erreur}`);
        return {
          statut: "echec",
          message: `Collecte ${source.id} échouée : ${resultat.erreur ?? `HTTP ${resultat.statut}`} — source conservée, débit respecté.`,
          taches: tache ? [tache.id] : [],
        };
      }

      const maintenant = new Date().toISOString();
      const empreinte = empreinteContenu(resultat.contenu);
      const lot: LotCollecte = {
        id: `${source.id}-c${ctx.cycle}-${empreinte.slice(0, 8)}`,
        cycle: ctx.cycle,
        sourceId: source.id,
        url: source.url,
        collecteLe: maintenant,
        contenu: resultat.contenu,
        contentType: resultat.contentType,
        tailleOctets: Buffer.byteLength(resultat.contenu, "utf8"),
        empreinte,
      };
      const enFile = options.file.enqueuer(lot);
      if (!enFile) {
        // Doublon maîtrisé : contenu déjà collecté (idempotence pipeline) —
        // ce n'est PAS une perte : le lot original est déjà tracé.
        options.registre.noterCollecte(source.id, maintenant);
        persisterRegistre();
        if (tache) ctx.taches.terminer(tache.id, "doublon maîtrisé (empreinte déjà vue)");
        return {
          statut: "rien_a_faire",
          message: `Collecte ${source.id} : contenu identique déjà en pipeline (idempotence) — aucune perte.`,
          taches: tache ? [tache.id] : [],
        };
      }
      options.registre.noterCollecte(source.id, maintenant);
      persisterRegistre();
      if (tache) ctx.taches.terminer(tache.id, `lot ${enFile.id} en file (${enFile.tailleOctets} o)`);
      ctx.emettreEvenement({
        de: "acquisition",
        sujet: "lot-collecte",
        charge: { lotId: enFile.id, sourceId: source.id, tailleOctets: enFile.tailleOctets },
      });
      return {
        statut: "succes",
        message: `Lot ${enFile.id} collecté depuis ${source.id} (${enFile.tailleOctets} o, ${resultat.contentType}) et mis en file.`,
        taches: tache ? [tache.id] : [],
        details: { lotId: enFile.id, sourceId: source.id, tailleOctets: enFile.tailleOctets },
      };
    },
  };
}
