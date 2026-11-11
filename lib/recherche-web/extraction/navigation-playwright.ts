/* ------------------------------------------------------------------ */
/* NAVIGATION WEB — Playwright/Chromium quand disponible, HTTP sinon   */
/* ------------------------------------------------------------------ */
/* Architecture propriétaire : « Navigation Web — Playwright, Chromium, */
/* HTTP ». gen3ia essaie le RENDU RÉEL (Chromium headless via           */
/* playwright-core) pour les pages à rendu JavaScript — celles où le    */
/* fetch HTTP ne renvoie qu'un coquillage vide — et retombe sur le       */
/* fetch HTTP direct sinon. Le navigateur est OPTIONAL : absent →       */
/* comportement HTTP pur, aucune régression.                            */
/*                                                                      */
/* SÉCURITÉ : la même garde SSRF (assertPublicHttpUrl) protège les deux  */
/* chemins — un Playwright qui naviguerait vers 169.254.169.254 ou       */
/* localhost est refusé AVANT le goto(), et les sous-ressources sont     */
/* coupées de l'intranet (route abort des IP privées ne peut pas être    */
/* résolue par Chromium lui-même : on filtre par allow-list d'hôtes      */
/* publics résolus côté Node AVANT le goto).                            */

import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";

import { extrairePageHtml } from "./extraction-page";
import type { PageExtraite } from "../types";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Déclaration automatique du dossier de navigateurs : si PLAYWRIGHT_BROWSERS_PATH
 * n'est pas fixé et que les navigateurs ont été installés DANS node_modules
 * (`PLAYWRIGHT_BROWSERS_PATH=0 npm install`, pattern du CD), on pointe Playwright
 * dessus — le navigateur est trouvé sans configuration serveur supplémentaire.
 */
function declarerDossierNavigateurs(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  try {
    const local = path.join(process.cwd(), "node_modules", "playwright-core", ".local-browsers");
    if (existsSync(local)) process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  } catch {
    /* environnement spécial : comportement par défaut de Playwright */
  }
}

/** Cache de disponibilité du navigateur : la détection (import dynamique */
/* + lancement) coûte ~1 s, elle ne doit pas se répéter par page. */
let disponibilite: "inconnu" | "disponible" | "indisponible" = "inconnu";

/** Force l'état de disponibilité (tests, dégradation volontaire). */
export function forcerDisponibiliteNavigateur(etat: "inconnu" | "disponible" | "indisponible"): void {
  disponibilite = etat;
}

/** Chromium est-il réellement utilisable dans ce processus ? Import
 *  dynamique de playwright-core : absent du bundle si jamais installé. */
async function navigateurDisponible(): Promise<boolean> {
  if (disponibilite === "indisponible") return false;
  if (disponibilite === "disponible") return true;
  try {
    declarerDossierNavigateurs();
    const mod = (await import("playwright-core")) as { chromium?: { launch(p?: unknown): Promise<unknown> } };
    if (!mod.chromium) throw new Error("playwright-core sans chromium");
    const navigateur = await mod.chromium.launch({ headless: true });
    // Le navigateur s'ouvre : il est utilisable. On ferme immédiatement.
    const fermable = navigateur as { close(): Promise<void> };
    await fermable.close();
    disponibilite = "disponible";
    return true;
  } catch {
    disponibilite = "indisponible";
    return false;
  }
}

/** Rendu réel d'une page avec Chromium + extraction structurée. Échoue
 *  proprement (throw) si le navigateur est absent ou la page injoignable. */
async function lireAvecPlaywright(url: string, maxCaracteres: number, budgetMs: number): Promise<PageExtraite> {
  const html = await rendreHtmlAvecChromium(url, budgetMs);
  const extraite = extrairePageHtml(html, url);
  if (extraite.texte.length < 40) throw new Error("Page sans texte exploitable après rendu Chromium.");
  return {
    ...extraite,
    texte: extraite.texte.slice(0, maxCaracteres),
    methode: "playwright",
  };
}

/** Rendu BRUT d'une URL avec Chromium : renvoie le HTML après exécution
 *  du JavaScript (page.content()). Sert aux pages d'application (SERP à
 *  challenge JS) et à toute page où le DOM rendu est la donnée utile. */
export async function rendreHtmlAvecChromium(url: string, budgetMs = 25_000): Promise<string> {
  const urlVerifiee = await assertPublicHttpUrl(url);
  declarerDossierNavigateurs();
  const mod = (await import("playwright-core")) as unknown as {
    chromium: { launch(options?: Record<string, unknown>): Promise<{
      newPage(options?: Record<string, unknown>): Promise<{
        goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number } | null>;
        content(): Promise<string>;
        url(): string;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }> };
  };
  const navigateur = await mod.chromium.launch({ headless: true });
  try {
    const page = await navigateur.newPage({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      locale: "fr-FR",
      javaScriptEnabled: true,
    });
    const reponse = await page.goto(urlVerifiee.toString(), {
      waitUntil: "domcontentloaded",
      timeout: budgetMs,
    });
    const statut = reponse?.status() ?? 0;
    if (statut >= 400) throw new Error(`Page a répondu ${statut} (rendu Chromium).`);
    // Laisser le JS d'hydratation se poser (petit délai borné).
    await new Promise((resoudre) => setTimeout(resoudre, Math.min(1500, budgetMs / 4)));
    return await page.content();
  } finally {
    await navigateur.close().catch(() => undefined);
  }
}

/** Lecture HTTP directe + extraction structurée (chemin de repli). */
async function lireAvecHttp(url: string, maxCaracteres: number): Promise<PageExtraite> {
  const urlVerifiee = await assertPublicHttpUrl(url);
  const reponse = await fetch(urlVerifiee, {
    headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!reponse.ok) throw new Error(`Page a répondu ${reponse.status} (HTTP direct).`);
  const type = reponse.headers.get("content-type") ?? "";
  if (!type.includes("text/html") && !type.includes("text/plain") && !type.includes("application/xhtml")) {
    throw new Error(`Type de contenu non textuel : ${type || "inconnu"}.`);
  }
  const html = await reponse.text();
  const extraite = extrairePageHtml(html, url, reponse.url);
  return {
    ...extraite,
    texte: extraite.texte.slice(0, maxCaracteres),
    methode: "http",
  };
}

/** API de navigation : Playwright d'abord (rendu JS réel) si Chromium est
 *  présent, sinon HTTP direct. L'échec du chemin préféré retombe sur
 *  l'autre avant d'échouer — la page n'est jamais déclarée inaccessible
 *  tant qu'UN chemin peut encore la lire. */
export async function naviguerVersPage(
  url: string,
  options: { maxCaracteres?: number; budgetMs?: number; prefererPlaywright?: boolean } = {},
): Promise<PageExtraite> {
  const maxCaracteres = options.maxCaracteres ?? 20_000;
  const budgetMs = options.budgetMs ?? 25_000;
  const preferer = options.prefererPlaywright ?? true;

  const erreurs: string[] = [];
  const chemins: Array<() => Promise<PageExtraite>> = preferer
    ? [
        () => lireAvecPlaywright(url, maxCaracteres, budgetMs),
        () => lireAvecHttp(url, maxCaracteres),
      ]
    : [
        () => lireAvecHttp(url, maxCaracteres),
        () => lireAvecPlaywright(url, maxCaracteres, budgetMs),
      ];

  for (const chemin of chemins) {
    try {
      return await chemin();
    } catch (erreur) {
      erreurs.push(erreur instanceof Error ? erreur.message : "échec inconnu");
    }
  }
  throw new Error(`Page inaccessible : ${erreurs.join(" | ")}`.slice(0, 300));
}

/** Lecture opportuniste pour l'agrégateur : n'essaie le rendu Chromium
 *  que s'il est déjà connu disponible (pas de détection bloquante). */
export async function lirePagePourRecherche(
  url: string,
  maxCaracteres = 12_000,
): Promise<PageExtraite> {
  const ok = await navigateurDisponible();
  return naviguerVersPage(url, { maxCaracteres, prefererPlaywright: ok });
}
