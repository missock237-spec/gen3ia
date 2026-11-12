/* ------------------------------------------------------------------ */
/* RECHERCHE TEMPS RÉEL AUTOMATIQUE DU CHAT gen3ia                     */
/* ------------------------------------------------------------------ */
/* Gemini répond « à jour » : quand l'utilisateur demande ce qui se      */
/* passe MAINTENANT (actualités, prix, météo, sorties récentes, scores,  */
/* chiffres de l'année courante…), le modèle a besoin de sources web     */
/* fraîches — son savoir d'entraînement a une date de coupure. gen3ia    */
/* fait pareil, avec SON moteur de recherche temps réel réel :           */
/*   1. détection DÉTERMINISTE (zéro LLM, zéro variance) du besoin ;     */
/*   2. recherche réelle via lib/recherche-web (multi-moteurs,           */
/*      dédoublonnage, vérification, lecture des pages) ;                */
/*   3. bloc de contexte SOURCÉ numéroté injecté au tour chat — le       */
/*      modèle cite [n] et ne peut pas inventer ce qu'il n'a pas lu.     */
/* Honnêteté : si la recherche échoue, le tour continue SANS contexte    */
/* web et le modèle est prévenu (il le dit à l'utilisateur).             */

import "server-only";

import { rechercheWebTempsReel, blocContexteSource } from "@/lib/recherche-web";
import type { ReponseRechercheWeb } from "@/lib/recherche-web";

/* ------------------------------------------------------------------ */
/* 1. Détection déterministe du besoin de recherche temps réel         */
/* ------------------------------------------------------------------ */

/** Signaux lexicaux d'actualité / d'immédiateté (français). */
const SIGNAUX_TEMPS_REEL: RegExp[] = [
  /\b(aujourd'?hui|hier|ce matin|cet après[- ]midi|ce soir|maintenant|en ce moment|tout de suite)\b/i,
  /\b(derniè?res? (?:nouvelles|actualités|infos?|heures?|minutes?|sorties?|versions?))\b/i,
  /\b(quoi de neuf|que s'est[- ]il passé|dernier(?:e)?s? (?:news|annonces))\b/i,
  /\b(météo|température|cours de|prix (?:de|du|d')|bourse|cotation|taux (?:de change|directeur))\b/i,
  /\b(score|résultat (?:du match|de la rencontre)|classement|ligue)\b/i,
  /\b(mise à jour|dernière version|nouvelle version|release|changelog)\b/i,
  /\b(cette (?:semaine|année|saison)|en \d{4}\b)/i,
  /\b(actuel(?:lement)?|récent(?:ement)?|nouveau|nouvelle|dernier(?:ère)?)\b.{0,40}\b(20[2-9]\d)\b/i,
  /\b(vivant|mort|décès|arrêté|licencié|élu|nommé)\b.{0,30}\?/i,
];

/** Intention explicite de recherche (verbes de commande). */
const COMMANDES_RECHERCHE: RegExp[] = [
  /^\s*(cherche|moteur|recherche|va chercher|trouve[- ]moi|informe[- ]?s?[- ]toi|renseigne[- ]toi|consulte le web|sur le web|sur internet)\b/i,
  /\b(cherche|recherche)\s+(sur|dans|via)\s+(le\s+)?(web|internet|google)\b/i,
];

export interface BesoinRechercheTempsReel {
  besoin: boolean;
  /** Signal qui a déclenché (traçable dans le diagnostic du tour). */
  signal: string;
}

/** Détection déterministe : question d'actualité/immédiat OU commande
 *  explicite de recherche web. Pas d'URL dans le message ? Le contexte
 *  des liens (loadWebPageContext) est un autre chemin — la recherche par
 *  requête s'applique quand l'utilisateur DEMANDE une information, pas
 *  quand il partage un lien. */
export function besoinRechercheTempsReel(message: string): BesoinRechercheTempsReel {
  const msg = message.trim();
  if (msg.length < 8) return { besoin: false, signal: "" };
  // URL collée → le chemin « contenu des liens » la traite déjà : pas de
  // recherche par requête en plus (évite le doublon de contexte).
  if (/https?:\/\//i.test(msg)) return { besoin: false, signal: "" };
  for (const commande of COMMANDES_RECHERCHE) {
    if (commande.test(msg)) return { besoin: true, signal: `commande de recherche web : « ${msg.match(commande)?.[0]} »` };
  }
  for (const signal of SIGNAUX_TEMPS_REEL) {
    if (signal.test(msg)) return { besoin: true, signal: `signal d'actualité : « ${msg.match(signal)?.[0]} »` };
  }
  return { besoin: false, signal: "" };
}

/* ------------------------------------------------------------------ */
/* 2. Recherche réelle + 3. bloc de contexte sourcé                    */
/* ------------------------------------------------------------------ */

/** La requête envoyée aux moteurs : le message nettoyé (préfixes de
 *  conversation retirés, borné — les moteurs attendent une requête). */
export function requeteDepuisMessage(message: string): string {
  let requete = message.trim();
  const prefixes = [
    /^\s*(salut|bonjour|bonsoir|coucou|hey)[!,. ]+/i,
    /^\s*(est[- ]ce que|dis[- ]moi|peux[- ]tu (me )?dire|sais[- ]tu|tu sais|tu peux me dire)\b[,:\s]+/i,
    /^\s*(what(?:'s| is)|tell me)\b[,:\s]+/i,
  ];
  for (const prefixe of prefixes) {
    const suivant = requete.replace(prefixe, "");
    if (suivant !== requete) {
      requete = suivant.trim();
      break;
    }
  }
  return requete.replace(/[\s.!?]+$/, "").slice(0, 300).trim() || message.trim().slice(0, 300);
}

/** Exécute la recherche temps réel et renvoie le bloc de contexte sourcé
 *  (chaîne vide si la recherche n'apporte rien — jamais de mensonge). */
export async function contexteRechercheTempsReel(
  message: string,
  options: { maxResults?: number } = {},
): Promise<{ bloc: string; reponse: ReponseRechercheWeb | null }> {
  try {
    const reponse = await rechercheWebTempsReel(requeteDepuisMessage(message), {
      maxResults: options.maxResults ?? 6,
      lirePages: true,
    });
    if (reponse.resultats.length === 0) return { bloc: "", reponse };
    return { bloc: blocContexteSource(reponse, 20_000), reponse };
  } catch {
    // Fail-soft total : le tour chat continue sans contexte web.
    return { bloc: "", reponse: null };
  }
}

/** Directive système ajoutée au tour quand un contexte temps réel existe :
 *  le modèle SAIT ce que le bloc contient et comment citer honnêtement.
 *  DÉMANDE PROPRIÉTAIRE « rapport sans sources » : les numéros [n] du bloc
 *  sont un repère INTERNE — la réponse ne produit JAMAIS de liste de
 *  sources/URLs ; une citation [n] n'apparaît que si l'utilisateur demande
 *  explicitement les sources. */
export const DIRECTIVE_TEMPS_REEL = [
  "Une RECHERCHE WEB TEMPS RÉEL vient d'être exécutée par la plateforme gen3ia (moteurs multi-source réels, pages réellement lues) au moment de la demande.",
  "Règles impératives : 1) appuie ta réponse sur ce bloc — ne l'invente jamais ; 2) ne JAMAIS inventer une source, un chiffre ou une date absents du bloc ; 3) si le bloc ne répond pas à la question, dis-le honnêtement et réponds avec ton expertise générale en signalant que c'est ton savoir d'entraînement, pas du temps réel ; 4) ne produis JAMAIS de liste de sources, de liens, d'URLs ni de bibliographie — les numéros [n] du bloc sont un repère interne : cite [n] dans le texte uniquement si l'utilisateur demande explicitement les sources ; 5) mentionne brièvement le nombre d'informations recueillies.",
].join("\n");
