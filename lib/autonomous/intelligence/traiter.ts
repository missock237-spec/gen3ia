/**
 * DATA INTELLIGENCE ENGINE (Lot 4 du plan « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Transforme les lots bruts en informations exploitables — les sept
 * opérations du plan :
 *   1. Extraction        — titre/texte selon le type de contenu
 *   2. Nettoyage         — réutilise nettoyerTexte de l'ingesteur existant
 *                          (lib/entrainement-auto — Règle 2 : réutiliser)
 *   3. Déduplication     — empreinte SHA-256 du concept normalisé
 *   4. Classification    — réutilise le ROUTEUR DU CERVEAU
 *                          (predireDomaineLexical, 18 domaines — pas un
 *                          classifieur parallèle)
 *   5. Structuration     — enregistrement concept/propriétés/provenance
 *   6. Analyse           — relations sujet→objet simples
 *   7. Évaluation        — score de qualité mesuré (longueur, ratio lettres)
 *
 * Le document original reste dans le lot (pipeline) — la provenance est
 * conservée INTÉGRALEMENT (source, url, date, lot).
 */

import { createHash } from "node:crypto";

import { nettoyerTexte } from "../../entrainement-auto/ingesteur";
import { predireDomaineLexical } from "../../neural/training/domaines";
import type { LotPersiste } from "../pipeline/queue";

/** Provenance conservée avec chaque information (Règle 10 de la mission). */
export interface Provenance {
  lotId: string;
  sourceId: string;
  url: string;
  collecteLe: string;
}

/** Enregistrement structuré prêt pour la vérification (Lot 5). */
export interface EnregistrementStructure {
  /** Identifiant du concept = empreinte du nom normalisé (déduplication). */
  idConcept: string;
  concept: string;
  /** Domaine du cerveau (routeur lexical) ou null si hors 18 domaines. */
  domaine: string | null;
  /** Propriétés : phrases descriptives (clé = mot-clé détecté). */
  proprietes: Array<{ cle: string; valeur: string }>;
  /** Relations simples sujet→relation→objet repérées dans le texte. */
  relations: Array<{ relation: string; cible: string }>;
  resume: string;
  langue: "fr" | "en" | "autre";
  /** Qualité mesurée 0..1 (jamais inventée). */
  qualite: number;
  provenance: Provenance;
  contentType: string;
  statut: "pending_validation";
}

/** Résultat du traitement d'un lot. */
export interface ResultatTraitement {
  ok: boolean;
  enregistrement?: EnregistrementStructure;
  message: string;
  /** Doublon de contenu déjà traité (idempotence au niveau concept). */
  doublon?: boolean;
}

/** Longueurs bornées honnêtes (RAM/disque). */
const MAX_RESUME = 2_000;
const MAX_PROPRIETES = 12;
const MAX_RELATIONS = 8;

/** Extraction selon le type de contenu (aucune IA externe). */
export function extraireContenu(contenu: string, contentType: string): { titre: string; texte: string } {
  const texteNettoye = nettoyerTexte(contenu, MAX_RESUME) ?? "";
  if (contentType.includes("json")) {
    try {
      const data = JSON.parse(contenu) as Record<string, unknown>;
      const titre = typeof data.title === "string" ? data.title : typeof data.titles === "string" ? data.titles : "";
      const texte = typeof data.extract === "string" ? data.extract : typeof data.abstract === "string" ? data.abstract : texteNettoye;
      return { titre: titre.slice(0, 200), texte: texte.slice(0, MAX_RESUME) };
    } catch {
      return { titre: "", texte: texteNettoye };
    }
  }
  if (contentType.includes("xml") || contenu.startsWith("<?xml") || contenu.includes("<entry>")) {
    // API atom arXiv : titres et résumés des entrées.
    const titres = [...contenu.matchAll(/<title>(?:\s*\n\s*)?([\s\S]*?)<\/title>/g)].map((m) => m[1].trim());
    const resumes = [...contenu.matchAll(/<summary>(?:\s*\n\s*)?([\s\S]*?)<\/summary>/g)].map((m) => m[1].trim());
    const titre = titres.slice(1).join(" · ").slice(0, 200) || titres[0]?.slice(0, 200) || "";
    const texte = resumes.join("\n\n").slice(0, MAX_RESUME) || texteNettoye;
    return { titre, texte };
  }
  // HTML : retirer scripts/styles/balises, puis titre <title>.
  const titre = contenu.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 200) ?? "";
  const sansScripts = contenu
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { titre, texte: (sansScripts || texteNettoye).slice(0, MAX_RESUME) };
}

/** Détecte la langue par mots fonctionnels (local, honnête, borné). */
export function detecterLangue(texte: string): "fr" | "en" | "autre" {
  const bas = texte.toLowerCase();
  const fr = (bas.match(/\b(le|la|les|des|une|est|dans|pour|avec|sur)\b/g) ?? []).length;
  const en = (bas.match(/\b(the|is|are|and|of|in|for|with|that)\b/g) ?? []).length;
  if (fr >= 2 && fr > en) return "fr";
  if (en >= 2 && en >= fr) return "en";
  return "autre";
}

/** Évalue la qualité du texte (0..1 — mesure réelle, jamais inventée). */
export function evaluerQualite(texte: string): number {
  if (texte.length < 80) return 0.1;
  const lettres = (texte.match(/[a-zA-ZàâäéèêëîïôöùûüçÀ-ÿ]/g) ?? []).length;
  const ratioLettres = lettres / Math.max(1, texte.length);
  const phrases = texte.split(/[.!?]+/).filter((p) => p.trim().length > 20).length;
  const scoreLongueur = Math.min(1, texte.length / 600);
  return Math.round(Math.min(1, ratioLettres * 0.5 + scoreLongueur * 0.3 + Math.min(1, phrases / 5) * 0.2) * 100) / 100;
}

/** Propriétés : phrases descriptives clés du texte (borné). */
export function extraireProprietes(texte: string): Array<{ cle: string; valeur: string }> {
  const phrases = texte
    .split(/[.!?]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 25 && p.length <= 320);
  const proprietes: Array<{ cle: string; valeur: string }> = [];
  for (const phrase of phrases.slice(0, MAX_PROPRIETES)) {
    const mots = phrase.toLowerCase().split(/\s+/);
    const cle = mots.find((m) => m.length >= 5 && /^[a-zà-ÿ]+$/.test(m)) ?? "description";
    proprietes.push({ cle, valeur: phrase });
  }
  return proprietes;
}

/** Relations simples : « X est Y », « X means Y », « X permet Y » (borné). */
export function extraireRelations(texte: string): Array<{ relation: string; cible: string }> {
  const relations: Array<{ relation: string; cible: string }> = [];
  const motifs: Array<[RegExp, string]> = [
    [/\b(\S[\S ]{2,60}?)\s+(?:est|sont)\s+(?:un|une|des|le|la|les)?\s*([\S ]{3,80})/i, "est"],
    [/\b(\S[\S ]{2,60}?)\s+(?:is|are)\s+(?:a|an|the)?\s*([\S ]{3,80})/i, "is"],
    [/\b(\S[\S ]{2,60}?)\s+(?:permet|allows|enables)\s+(?:de\s+|to\s+)?([\S ]{3,80})/i, "permet"],
  ];
  for (const [motif, relation] of motifs) {
    const m = texte.match(motif);
    if (m) relations.push({ relation, cible: m[2].trim().slice(0, 80) });
    if (relations.length >= MAX_RELATIONS) break;
  }
  return relations;
}

/**
 * TRAITE un lot : les sept opérations — produit un enregistrement structuré
 * à charge de la vérification (Lot 5). Un lot vide/indigeste donne
 * ok=false avec un message honnête (le lot sera rejeté par le worker).
 */
export function traiterLot(lot: LotPersiste): ResultatTraitement {
  const { titre, texte } = extraireContenu(lot.contenu, lot.contentType);
  const conceptBrut = (titre || texte.split(/[.!?]/)[0] || "").trim();
  if (conceptBrut.length < 3 || texte.length < 80) {
    return { ok: false, message: `Lot ${lot.id} indigeste : contenu trop court pour structuration honnête.` };
  }
  const concept = conceptBrut.slice(0, 200);
  const idConcept = createHash("sha256").update(concept.toLowerCase()).digest("hex").slice(0, 16);
  const detection = predireDomaineLexical(`${concept}. ${texte}`);
  const qualite = evaluerQualite(texte);
  return {
    ok: true,
    enregistrement: {
      idConcept,
      concept,
      domaine: detection?.id ?? null,
      proprietes: extraireProprietes(texte),
      relations: extraireRelations(texte),
      resume: texte.slice(0, MAX_RESUME),
      langue: detecterLangue(texte),
      qualite,
      provenance: {
        lotId: lot.id,
        sourceId: lot.sourceId,
        url: lot.url,
        collecteLe: lot.collecteLe,
      },
      contentType: lot.contentType,
      statut: "pending_validation",
    },
    message: `Lot ${lot.id} structuré : « ${concept.slice(0, 60)} » — domaine ${detection?.id ?? "hors 18 domaines"}, qualité ${qualite}.`,
  };
}
