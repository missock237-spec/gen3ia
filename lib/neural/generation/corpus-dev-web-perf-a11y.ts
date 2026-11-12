/**
 * CORPUS DÉVELOPPEMENT WEB — SOUS-THÈMES PERFORMANCE + ACCESSIBILITÉ +
 * NODE/NPM (it.150).
 *
 * Core Web Vitals (LCP, INP, CLS — seuils et verdicts CALCULÉS), techniques
 * de performance (lazy loading, hints, formats d'image, caching), WCAG
 * (POUR, niveaux, contrastes CALCULÉS par la formule officielle), ARIA,
 * Node/npm (commandes, semver CALCULÉ).
 *
 * Deux sources honnêtes : paires RÉDIGÉES (cœur de qualité) + unités
 * déterministes du générateur lib/gen3/generateur-dev-web-it150.ts.
 * Module PUR — aucune dépendance Node.
 */

import type { PaireLangage } from "./corpus";
import {
  unitesFamilleDevWeb,
  type UniteDevWeb,
} from "../../gen3/generateur-dev-web-it150";

const THEME = "developpement-web:perf-a11y";

const ECRIRE = (motif: string, reponse: string): PaireLangage => ({
  motif,
  reponse,
  theme: THEME,
});

export const CORPUS_DEV_WEB_PERF_A11Y_ECRIT: readonly PaireLangage[] = [
  // ─── Core Web Vitals ────────────────────────────────────────────────────
  ECRIRE(
    "Quels sont les Core Web Vitals et leurs seuils ?",
    "LCP (Largest Contentful Paint) : bon ≤ 2,5 s, à améliorer ≤ 4 s. INP (Interaction to Next Paint) : bon ≤ 200 ms, à améliorer ≤ 500 ms. CLS (Cumulative Layout Shift) : bon ≤ 0,1, à améliorer ≤ 0,25. Ces seuils s'évaluent au 75e percentile des visites réelles (field data CrUX), pas en laboratoire.",
  ),
  ECRIRE(
    "Qu'est-ce que le LCP et comment l'améliorer ?",
    "Le LCP est le temps de peinture du PLUS GRAND élément de contenu (image héro, titre, bloc texte). Leviers : prioriser la ressource (fetchpriority=\"high\", preload), serveur/CDN rapides (TTFB), images optimisées (AVIF/WebP, dimensionnées), HTML streamé, fonts avec font-display: swap, pas de rendu bloqué par CSS/JS critiques.",
  ),
  ECRIRE(
    "Qu'est-ce que le CLS et comment éviter les sauts de mise en page ?",
    "Le CLS cumule les déplacements visuels imprévus. Causes : images/vidéos sans dimensions (réserver width/height ou aspect-ratio), pub/bannières injectées (réserver l'espace), fonts swap qui redessinent (fallback métrique), contenu injecté au-dessus du contenu existant. Un CLS ≤ 0,1 signifie « stable à l'œil ».",
  ),
  ECRIRE(
    "Qu'est-ce que l'INP et comment réduire la latence d'interaction ?",
    "INP mesure la pire (au 75e) latence d'INTERACTION : clic → réponse visuelle ≤ 200 ms. Leviers : handlers courts (différer le gros travail après le paint), découper les tâches longtes > 50 ms, éviter les re-rendus React massifs (mémoïsation, virtualisation des longues listes), réduire le JS principal (hydroulation lourde = mauvais INP).",
  ),
  ECRIRE(
    "Comment mesurer les Core Web Vitals en production ?",
    "Field data : CrUX (PageSpeed Insight, BigQuery), la librairie web-vitals (beacon vers votre analytics), RUM de votre APM. Lab : Lighthouse (diagnostic, pas jugement des seuils). Toujours regarder au 75e percentile par page/template et par type d'appareil — la moyenne cache les mauvaises expériences.",
  ),
  // ─── Techniques de performance ──────────────────────────────────────────
  ECRIRE(
    "Comment optimiser les images d'un site web ?",
    "Formats modernes (AVIF puis WebP, JPEG en repli), dimensionnement à la demande (srcset/sizes), compression adéquate, lazy loading hors viewport (loading=\"lazy\") mais PAS sur l'image LCP (fetchpriority=\"high\" + eager), width/height toujours (anti-CLS), CDN d'image (resize à la volée). Une image de 4 Mo est un bug, pas une norme.",
  ),
  ECRIRE(
    "Que fait loading=\"lazy\" et où ne PAS l'utiliser ?",
    "Diffère le chargement des images/iframes hors viewport (le navigateur décide du seuil). Ne PAS l'utiliser sur l'image LCP/au-dessus de la plonge — ça RETARDE le plus grand élément. Combiner avec decoding=\"async\" ; pour les iframes tiers, lazy est presque toujours voulu.",
  ),
  ECRIRE(
    "À quoi servent preload, preconnect et prefetch ?",
    "preload : charge MAINTENANT une ressource critique découverte tard (font CSS, script LCP) — avec as= et crossorigin corrects sinon double téléchargement. preconnect : ouvre DNS+TCP+TLS vers un tiers AVANT le besoin (CDN de font). prefetch : récupère la prochaine page probable (navigation). modulepreload pour les dépendances ESM.",
  ),
  ECRIRE(
    "Comment réduire le JavaScript livré au navigateur ?",
    "Code splitting (import() dynamique au besoin), tree shaking (exports nommés, pas de barrel qui tire tout), analyse du bundle (bundle analyzer), remplacer les grosses librairies par du natif (Intl, IntersectionObserver, dialog), server components (le JS ne part pas), budget de bundle en CI. Moins de JS = parse + exécution + hydroulation plus courts (INP).",
  ),
  ECRIRE(
    "Comment charger les polices sans pénaliser le rendu ?",
    "self-host + preload de la police critique (woff2 uniquement), font-display: swap (texte visible avec la police de repli), fallback métrique (size-adjust) pour minimiser le décalage (CLS), limiter les graisses (2–3), subsets. next/font fait tout ça automatiquement.",
  ),
  ECRIRE(
    "defer vs async sur un script : quelle différence ?",
    "defer : téléchargement parallèle, exécution APRÈS le parsing dans l'ORDRE — idéal pour l'app JS. async : exécution dès disponible, ordre non garanti — idéal pour les scripts indépendants (analytics). Script classique sans attribut : bloque le parsing — à proscrire en fin de <body> hors cas particulier.",
  ),
  ECRIRE(
    "Comment tirer parti du cache HTTP côté client ?",
    "Assets à empreinte (app.[hash].js) : Cache-Control: immutable, max-age=31536000. HTML : no-cache (revalidé par ETag/304). API : max-age court ou no-store selon données. stale-while-revalidate pour les JSON tolérants. Résultat : visites suivantes quasi sans réseau.",
  ),
  ECRIRE(
    "Qu'est-ce qu'un service worker et à quoi sert-il ?",
    "Un script qui s'intercale entre la page et le réseau : cache offline (app shell), stratégies (cache-first pour les assets, network-first pour l'HTML, stale-while-revalidate), background sync, notifications. Pièges : versionnage du cache (skipWaiting + delete des vieux), ne JAMAIS cacher les mutations, updated au besoin.",
  ),
  ECRIRE(
    "Comment garder le CSS performant ?",
    "CSS critique inline au-dessus de la plonge, le reste chargé non bloquant, éviter les sélecteurs très universels (coût de style), contenu induit (content-visibility: auto) pour le hors-écran, réduire les recalculs (ne pas animer layout — préférer transform/opacity, will-change ponctuel).",
  ),
  // ─── Accessibilité ──────────────────────────────────────────────────────
  ECRIRE(
    "Qu'est-ce que WCAG et comment s'organise-t-il ?",
    "WCAG 2.2 : recommandations d'accessibilité web structurées par 4 principes POUR — Perceptible, Utilisable (Operable), Compréhensible, Robuste — déclinés en critères de succès aux niveaux A/AA/AAA. Le AA est le standard légal (en France, le RGAA s'en inspire). Chaque critère est testable : c'est une norme d'ingénierie, pas d'opinion.",
  ),
  ECRIRE(
    "Quel contraste minimal pour le texte ?",
    "AA : 4,5:1 pour le texte normal, 3:1 pour le GROS texte (≥ 18pt ou 14pt gras) et les composants/bords d'interface ; AAA : 7:1 (normal). Le ratio se calcule avec la luminance relative (formule WCAG) — les couleurs « qui semblent ok » échouent souvent : mesurer, ne pas deviner.",
  ),
  ECRIRE(
    "Comment rendre un composant interactif accessible au clavier ?",
    "Éléments natifs d'abord (button/a/input/select ont TOUT gratuitement) ; sinon tabbable (tabindex=\"0\") + gestion Entrée/Espace/Flèches selon le pattern ARIA (onglets, menus), focus VISIBLE jamais supprimé, piège de focus dans les modales (Tab reste dedans) et retour au déclencheur à la fermeture, pas de tabindex positif.",
  ),
  ECRIRE(
    "Comment utiliser aria-live pour les contenus dynamiques ?",
    "Une région aria-live=\"polite\" (annoncée à la pause) ou \"assertive\" (interrompt) : résultats de recherche, messages d'état, compteurs. Alternative native : role=\"status\" (polite implicite) et role=\"alert\" (assertif). La région doit exister AVANT le contenu change (pas injectée au moment de l'annonce).",
  ),
  ECRIRE(
    "Quand utiliser un rôle ARIA plutôt que l'élément natif ?",
    "Presque JAMAIS si un natif existe : <button> > role=\"button\", <nav> > role=\"navigation\" (première règle d'ARIA). ARIA rattrape les div interactives : rôles + états (aria-expanded, aria-checked) + clavier À NOUVEAU implémentés à la main — c'est plus de code et un risque d'oubli. ARIA sans comportement clavier est pire que rien.",
  ),
  ECRIRE(
    "Comment tester l'accessibilité d'un site ?",
    "Automatique : axe-core (Lighthouse, intégration CI) attrape ~30 % des défauts. Manuel : navigation clavier complète (sans souris), lecteur d'écran (NVDA/VoiceOver), zoom 200 %, contraste mesuré, prefers-reduced-motion. Checklists RGAA/WCAG par page type. L'automatisable ne prouve pas l'UTILISABLE.",
  ),
  ECRIRE(
    "Qu'est-ce qu'un nom accessible et pourquoi est-ce critique ?",
    "Le nom accessible est ce que le lecteur d'écran annonce : contenu texte > aria-labelledby > aria-label > title/alt. Un bouton-icône sans aria-label est annoncé « bouton » et devient inutilisable. Toujours vérifier : chaque contrôle a un NOM, un RÔLE et une VALEUR/ÉTAT si applicable.",
  ),
  // ─── Node & npm ─────────────────────────────────────────────────────────
  ECRIRE(
    "Quelle différence entre npm install et npm ci ?",
    "npm install : résout semver, peut METTRE À JOUR le lockfile (dérive possible). npm ci : installe EXACTEMENT ce que décrit package-lock.json, supprime node_modules d'abord, échoue si incohérence — déterministe, plus rapide, le choix des pipelines CI.",
  ),
  ECRIRE(
    "Comment fonctionne le versionnage semver en npm ?",
    "MAJEURE.MINUEURE.CORRECTIF : majeure = rupture d'API, minueure = ajout rétrocompatible, correctif = correction. ^1.2.3 accepte 1.x.x (≥ 1.2.3 < 2.0.0), ~1.2.3 accepte 1.2.x, 1.2.3 exact. Le lockfile fige les choix ; les majors se testent explicitement.",
  ),
  ECRIRE(
    "dependencies vs devDependencies vs peerDependencies ?",
    "dependencies : nécessaires au runtime (installées en prod). devDependencies : build/tests/outils (omises par npm install --production). peerDependencies : le PAQUET HÔTE doit fournir (plugin qui exige react en peer) — npm ≥ 7 les installe automatiquement sauf conflit.",
  ),
  ECRIRE(
    "Pourquoi committer package-lock.json ?",
    "Il fige l'arbre EXACT (versions + integrité) : chaque installation est reproductible, les CI et vos collègues obtiennent les mêmes versions, les audits portent sur le même graphe. Le supprimer rend le build non déterministe (semver flottant) — la dérive des versions est une source classique de « ça marche sur ma machine ».",
  ),
  ECRIRE(
    "Que fait npx et quand l'utiliser ?",
    "npx <paquet> télécharge (ou réutilise le cache) et exécute un binaire SANS l'installer globalement : npx vitest run, npx create-next-app. Évite la pollution globale et garantit la version du projet (node_modules/.bin a priorité). Les scripts npm cherchent déjà dans node_modules/.bin.",
  ),
  ECRIRE(
    "Comment auditer et mettre à jour les dépendances npm ?",
    "npm audit (vulnérabilités connues, gravité), npm audit fix (correctifs non majeurs), npm outdated (retards), npm update (dans les plages), upgrades majeurs : outil dédié (ncu) + tests + changelog. En CI : audit bloquant à partir d'une gravité choisie, Dependabot/Renovate pour les PR de mise à jour.",
  ),
  ECRIRE(
    "Comment fonctionne l'event loop de Node.js ?",
    "Boucle par phases : timers (setTimeout/Interval), callbacks en attente, poll (I/O), check (setImmediate), close. Les MICROTASKS (promesses, process.nextTick) se vident ENTRE chaque phase. Un travail CPU lourd bloque TOUTE la boucle : le découper, utiliser les workers (worker_threads) ou les process pools.",
  ),
  ECRIRE(
    "Comment lire des fichiers en Node sans saturer la mémoire ?",
    "Streams : fs.createReadStream et pipe/consumption async — la mémoire reste O(1) quelle que soit la taille du fichier (pipeline, backpressure gérée). readFileSync ne convient qu'aux petits fichiers au démarrage. Les streams composent : readline pour le CSV ligne à ligne, transform pour filtrer.",
  ),
  ECRIRE(
    "Comment structurer les scripts npm d'un projet ?",
    "\"scripts\" : dev, build, start, test, lint, typecheck — et des composés (\"check\": \"npm run lint && npm run typecheck && npm run test\"). pré/post hooks s'exécutent automatiquement (pretest). Les binaires de node_modules/.bin sont appelables sans npx. CI = un seul npm run check.",
  ),
];

function versPaire(u: UniteDevWeb): PaireLangage {
  return { motif: u.motif, reponse: u.reponse, theme: u.theme };
}

const FAMILLES_PERF_A11Y = [
  "web-vitals",
  "verdict-vitals",
  "techniques-perf",
  "wcag-bases",
  "contraste-wcag",
  "npm-node",
  "semver-arith",
] as const;

function genereFamilles(): readonly PaireLangage[] {
  const sorties: PaireLangage[] = [];
  for (const fam of FAMILLES_PERF_A11Y) {
    for (const u of unitesFamilleDevWeb(fam, 10_000)) {
      sorties.push(versPaire(u));
    }
  }
  return sorties;
}

export const CORPUS_DEV_WEB_PERF_A11Y_GENERE: readonly PaireLangage[] =
  genereFamilles();

export const CORPUS_DEV_WEB_PERF_A11Y: readonly PaireLangage[] = [
  ...CORPUS_DEV_WEB_PERF_A11Y_ECRIT,
  ...CORPUS_DEV_WEB_PERF_A11Y_GENERE,
];

export const TAILLE_CORPUS_DEV_WEB_PERF_A11Y =
  CORPUS_DEV_WEB_PERF_A11Y.length;
