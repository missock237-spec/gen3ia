/**
 * CORPUS DÉVELOPPEMENT WEB — SOUS-THÈMES REACT + NEXT.JS (it.150).
 *
 * React (hooks, composition, memoisation, erreurs), Next.js App Router
 * (layouts, segments dynamiques, error/loading boundaries), Server
 * Components vs client, data fetching (fetch cache/ISR/tags), Server
 * Actions, métadonnées, middleware.
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

const THEME = "developpement-web:react-next";

const ECRIRE = (motif: string, reponse: string): PaireLangage => ({
  motif,
  reponse,
  theme: THEME,
});

export const CORPUS_DEV_WEB_REACT_NEXT_ECRIT: readonly PaireLangage[] = [
  // ─── React ──────────────────────────────────────────────────────────────
  ECRIRE(
    "Quand mettre \"use client\" dans un composant React/Next ?",
    "Dès qu'il faut de l'INTERACTIVITÉ : hooks d'état (useState/useReducer), effets (useEffect), événements (onClick, onChange), APIs navigateur (window, localStorage). Sans besoin, rester server component : zéro JS livré au client. La directive déplace la frontière du bundle — la descendre au plus loin.",
  ),
  ECRIRE(
    "Comment fonctionne le flux de données avec useState ?",
    "const [valeur, setValeur] = useState(départ) ; le setter remplace la valeur et déclenche un RE-RENDU du composant (et de ses enfants). Mise à jour fonctionnelle quand la nouvelle valeur dépend de l'ancienne : setCompteur(c => c + 1). React BATCHES les mises à jour — lire l'état juste après le setter donne l'ancien.",
  ),
  ECRIRE(
    "Comment bien utiliser useEffect (dépendances et nettoyage) ?",
    "useEffect(() => { … return () => nettoyage(); }, [dep1, dep2]) : s'exécute après le rendu où une dépendance a CHANGÉ ; le retour désabonne (listeners, timers, AbortController). Tableau vide = une fois au montage (très rarement ce qu'on veut côté données). Oublier une dépendance = fermeture obsolète — suivre le linter, pas le contournement.",
  ),
  ECRIRE(
    "Pourquoi les clés (key) sont-elles importantes dans les listes React ?",
    "La clé identifie un élément ENTRE les rendus : React réordonne au lieu de tout recréer et préserve l'état local. Id = identifiant stable du DOMAINE (jamais l'index quand la liste est réordonnée/filtrée — l'index déplace les clés et corrompt l'état : focus, inputs, animations).",
  ),
  ECRIRE(
    "Quand utiliser useMemo et useCallback (et quand s'en passer) ?",
    "useMemo mémoïse un CALCUL coûteux ; useCallback une IDENTITÉ de fonction — utile quand l'enfant est memo() ou quand la fonction est dépendance d'un effet. Sinon le coût du mécanisme dépasse le gain : mesurer d'abord. Les deux n'empêchent PAS un re-rendu du composant lui-même.",
  ),
  ECRIRE(
    "Comment remonter l'état (lifting state up) ?",
    "Quand deux composants partagent une donnée, l'état vit au plus proche ANCÊTRE commun et descend en props ; les enfants remontent leurs changements par callbacks. Si l'arbre devient trop long : contexte (thème, session) ou store externe — mais pas de contexte pour tout : il re-rend tous les consommateurs.",
  ),
  ECRIRE(
    "Comment créer un hook personnalisé ?",
    "Fonction useXxx qui compose les hooks natifs et renvoie ce qu'il faut : const useDebouncedValue = (v, delai) => { … useEffect … return vDebounce }. Règles des hooks s'appliquent (même ordre, au sommet du composant). C'est la réutilisation d'ÉTAT + logique — un composant rend, un hook calcule.",
  ),
  ECRIRE(
    "Comment gérer un formulaire contrôlé en React ?",
    "Chaque champ : value={etat} onChange={e => setEtat(e.target.value)} — la source de vérité est l'ÉTAT React. Validation au submit (ou onBlur), erreurs en état, disabled selon validité. Pour de gros formulaires : react-hook-form garde les champs non contrôlés (moins de re-rendus) avec une validation déclarative.",
  ),
  ECRIRE(
    "Comment gérer une erreur de rendu en React ?",
    "Error boundary : composant de CLASSE avec static getDerivedStateFromError + componentDidCatch (ou react-error-boundary) qui attrape les erreurs de rendu de ses ENFANTS et affiche un repli. Dans l'App Router Next : error.tsx par segment fait le travail (et doit être un client component). Les erreurs d'EVENTS/async ne sont pas attrapées — try/catch local.",
  ),
  ECRIRE(
    "Comment éviter les requêtes en double dans les effets React ?",
    "Mode strict/développement monte deux fois : nettoyer avec un AbortController (signal fetch, abort au cleanup) ou un flag ignore dans le closure. La vraie solution au double fetch : déduire les données du rendu serveur (RSC/Suspense) ou une couche cache (React Query/SWR) qui déduplique.",
  ),
  ECRIRE(
    "useReducer : quand plutôt que plusieurs useState ?",
    "Quand l'état a des TRANSITIONS liées (formulaires multi-étapes, machine à états) : dispatch({ type: \"sauve\", payload }) traité par un reducer PUR (état + action → nouvel état). Testable sans React, logique centralisée, invariant garantis au seul endroit.",
  ),
  ECRIRE(
    "Comment partager un contexte sans re-rendre toute l'arborescence ?",
    "Séparer les contextes (état vs dispatch), mémoïser la valeur (useMemo du provider value), et surtout n'y mettre que ce qui CHANGE vraiment rarement (thème, session) — pas les données de requête. Pour les données changeantes, préférer les props ou un store sélectif (zustand, jotai).",
  ),
  // ─── Next.js App Router ─────────────────────────────────────────────────
  ECRIRE(
    "Comment fonctionne la hiérarchie layouts/pages de l'App Router Next ?",
    "Chaque dossier = un segment d'URL ; page.tsx rend la route ; layout.tsx enveloppe ses segments enfants et PERSISTE entre navigations (pas de re-montage) ; loading.tsx fournit le Suspense de secours, error.tsx la boundary d'erreur, not-found.tsx le 404 du segment. Le layout racine porte <html> et <body>.",
  ),
  ECRIRE(
    "Comment créer un segment dynamique [id] dans l'App Router ?",
    "dossier app/blog/[id]/page.tsx : params.id contient le segment (async dans les versions récentes — await params). Variantes : [...slug] catch-all, [[...slug]] optionnel qui matche aussi le parent. generateStaticParams pré-rend les ids connus (SSG) ; les autres tombent en rendu dynamique.",
  ),
  ECRIRE(
    "Comment fetch des données dans un Server Component ?",
    "Le composant peut être async : const donnees = await fetch(url, { next: { revalidate: 60 } }) — rendu sur le serveur, le JS de fetch ne part JAMAIS au client. Options de cache : force-cache, no-store, next.revalidate (ISR) ; next.tags + revalidateTag pour l'invalidation ciblée après une mutation.",
  ),
  ECRIRE(
    "Server Actions : comment muter des données dans l'App Router ?",
    "\"use server\" sur une fonction async appelable depuis un client component (form action={action} ou appel direct) : validation d'entrée, mutation, puis revalidateTag/revalidatePath pour rafraîchir le rendu. Les actions s'exécutent côté serveur avec les secrets — jamais de logique sensible côté client.",
  ),
  ECRIRE(
    "Comment gérer les métadonnées SEO dans l'App Router ?",
    "export const metadata = { title, description, openGraph… } (statique) ou generateMetadata({ params }) pour le dynamique — hiérarchie : les segments enfants COMPLETENT le parent. Fichiers spéciaux : favicon.ico, opengraph-image, sitemap.ts, robots.ts à la racine app/.",
  ),
  ECRIRE(
    "Que fait middleware.ts dans Next.js ?",
    "Fichier à la racine (app ou projet) : fonction middleware(request) qui s'exécute AVANT le routage sur chaque requête — réécritures, redirections, gardes de session (cookie présent ?), en-têtes globaux. matcher dans config pour borner les chemins. Restez léger : ça court sur le edge de chaque requête.",
  ),
  ECRIRE(
    "Route Handlers : quand utiliser route.ts ?",
    "app/api/…/route.ts exporte GET/POST/PATCH/DELETE (Request → Response/NextResponse) : webhook, OAuth callback, endpoints pour des tiers. Pour les mutations INTERNES de l'application, préférer les Server Actions (typage, revalidation intégrée). params dynamiques fonctionnent comme les pages.",
  ),
  ECRIRE(
    "Comment gérer les variables d'environnement côté Next ?",
    "NEXT_PUBLIC_* est INLINÉE dans le bundle client (visible par tous) ; sans préfixe, la variable ne vit que côté serveur (BDD, secrets). .env.local hors git ; les variables serveur se lisent dans les RSC/actions/route handlers — jamais dans un composant client.",
  ),
  ECRIRE(
    "Comment optimiser les images dans Next.js ?",
    "<Image> (next/image) : redimensionnement/format automatique (AVIF/WebP), lazy par défaut, srcset généré, anti-CLS par dimensions. priority sur l'image LCP au-dessus de la plonge ; fill + sizes pour le fluide ; loader personnalise le CDN. Les images distantes exigent remotePatterns dans next.config.",
  ),
  ECRIRE(
    "Comment charger une police performante dans Next.js ?",
    "next/font (Google/local) : téléchargement au build, self-hosted, preload, fallback métrique ajusté (zéro CLS, zéro requête runtime). font-display et subsets configurés une fois dans le layout racine — plus de <link> Google Fonts bloquant.",
  ),
  ECRIRE(
    "Comment faire du streaming de rendu dans l'App Router ?",
    "Envelopper un composant async lent dans <Suspense fallback={…}> : la coquille part immédiatement, le segment coule quand prêt — loading.tsx fait pareil au niveau segment. Streaming = TTFB perçu rapide sans bloquer toute la page sur la requête la plus lente.",
  ),
  ECRIRE(
    "Comment structurer un projet App Router proprement ?",
    "Groupes de routes (groupe) pour des layouts sans URL ; segments privés _dossier (hors routage) pour les composants serveur internes ; co-localisation : composants/data du segment avec le segment ; composants UI partagés dans un dossier racine (components/ ou _ui). app/ décrit les URL, pas toute l'appli.",
  ),
];

function versPaire(u: UniteDevWeb): PaireLangage {
  return { motif: u.motif, reponse: u.reponse, theme: u.theme };
}

const FAMILLES_REACT_NEXT = [
  "hooks-react",
  "app-router",
  "fetch-next",
  "rsc-vs-client",
] as const;

function genereFamilles(): readonly PaireLangage[] {
  const sorties: PaireLangage[] = [];
  for (const fam of FAMILLES_REACT_NEXT) {
    for (const u of unitesFamilleDevWeb(fam, 10_000)) {
      sorties.push(versPaire(u));
    }
  }
  return sorties;
}

export const CORPUS_DEV_WEB_REACT_NEXT_GENERE: readonly PaireLangage[] =
  genereFamilles();

export const CORPUS_DEV_WEB_REACT_NEXT: readonly PaireLangage[] = [
  ...CORPUS_DEV_WEB_REACT_NEXT_ECRIT,
  ...CORPUS_DEV_WEB_REACT_NEXT_GENERE,
];

export const TAILLE_CORPUS_DEV_WEB_REACT_NEXT =
  CORPUS_DEV_WEB_REACT_NEXT.length;
