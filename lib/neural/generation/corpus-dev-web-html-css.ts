/**
 * CORPUS DÉVELOPPEMENT WEB — SOUS-THÈMES HTML SÉMANTIQUE + CSS (it.150).
 *
 * HTML sémantique (landmarks, formes, médias), CSS flexbox, Grid,
 * responsive (media queries, clamp), custom properties, unités.
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

const THEME = "developpement-web:html-css";

const ECRIRE = (motif: string, reponse: string): PaireLangage => ({
  motif,
  reponse,
  theme: THEME,
});

export const CORPUS_DEV_WEB_HTML_CSS_ECRIT: readonly PaireLangage[] = [
  // ─── HTML sémantique ────────────────────────────────────────────────────
  ECRIRE(
    "Pourquoi utiliser du HTML sémantique au lieu de div partout ?",
    "Les balises sémantiques (<header>, <nav>, <main>, <article>, <section>, <aside>, <footer>) portent une SIGNIFICATION : les lecteurs d'écran en font des points de navigation (landmarks), les moteurs comprennent la structure, le CSS est plus lisible. Un div ne dit rien — ni au navigateur, ni à la personne qui maintient le code.",
  ),
  ECRIRE(
    "Quels éléments HTML pour la structure principale d'une page ?",
    "Un <header> (logo/titre), un <nav> pour les liens principaux, un SEUL <main> pour le contenu principal, des <article> pour les contenus autonomes et des <section> pour les regroupements thématiques, un <aside> pour le contenu tangentiel, un <footer> pour les mentions. Repères de navigation gratuits pour l'accessibilité.",
  ),
  ECRIRE(
    "Quelle différence entre <article> et <section> ?",
    "<article> = contenu AUTONOME, distribuable seul (post, fiche produit, commentaire) ; <section> = regroupement THÉMATIQUE dans une page, généralement avec un titre. En cas de doute : si ça se lit seul dans un flux RSS, c'est un article ; si ça découpe la page, c'est une section.",
  ),
  ECRIRE(
    "Combien de <h1> par page et comment organiser les titres ?",
    "Un seul <h1> par page (le titre principal), puis des niveaux <h2>…<h6> sans SALT de niveau (pas de h3 sous h1 sans h2). Les titres forment le plan que les lecteurs d'écran naviguent — sauter des niveaux casse le plan.",
  ),
  ECRIRE(
    "Quand utiliser <button> et quand utiliser <a> ?",
    "<button> pour déclencher une ACTION (ouvrir une modale, soumettre, trier) — focus + Entrée/Espace natifs. <a href> pour NAVIGUER vers une URL (le clic-milieu, Ctrl+clic et le SEO en dépendent). Un div onclick est les deux pires : ni action native, ni navigation.",
  ),
  ECRIRE(
    "Comment rendre un formulaire accessible en HTML ?",
    "Chaque champ a un <label for> relié (ou aria-labelledby) ; les champs liés vont dans un <fieldset> avec <legend> ; les erreurs sont annoncées (aria-invalid + message lié par aria-describedby) ; l'ordre de tabulation suit l'ordre visuel. Le placeholder n'est PAS un label (disparaît à la saisie).",
  ),
  ECRIRE(
    "Comment écrire un bon alt pour une image ?",
    "L'alt décrit la FONCTION/le contenu utile : texte informatif pour une image de contenu ; alt=\"\" pour une image purement décorative (le lecteur l'ignore) ; jamais « image de » (redondant). Pour une image-lien, l'alt décrit la destination.",
  ),
  ECRIRE(
    "À quoi servent <figure> et <figcaption> ?",
    "Ils lient une illustration (image, code, graphique) à sa légende de façon sémantique : le lecteur d'écran annonce « figure » et la légende reste attachée même si visuellement déplacée. Mieux qu'un div + p sans relation.",
  ),
  ECRIRE(
    "Comment représenter une date en HTML ?",
    "<time datetime=\"2026-11-15\">15 novembre 2026</time> : affichage humain libre, valeur machine normalisée (datetime) exploitable par les moteurs, calendriers et scripts.",
  ),
  ECRIRE(
    "Qu'est-ce que <details> et <summary> apportent sans JavaScript ?",
    "Un bloc repliable NATIF : <details><summary>Question ?</summary>Réponse…</details>. Focus, clavier et état (open) gérés par le navigateur — parfait pour les FAQ simples ; styler via ::marker et l'attribut open.",
  ),
  ECRIRE(
    "Quand utiliser <dialog> plutôt qu'une div modale ?",
    "<dialog> est le natif : show()/showModal() gèrent le focus (piège inclus), la couche top-layer et la fermeture Échap (cancel). Une div modale réinvente tout le piège de focus à la main. Pour le reste, combiner avec aria-labelledby et un bouton de fermeture visible.",
  ),
  ECRIRE(
    "Comment structurer un tableau de données accessible ?",
    "<table> avec <caption> (nom du tableau), les en-têtes en <th scope=\"col|row\">, corps en <td>. La liaison th/td permet au lecteur d'écran d'annoncer « colonne X, ligne Y ». Un tableau de mise en page est un abus — utiliser CSS Grid.",
  ),
  // ─── CSS : flexbox ──────────────────────────────────────────────────────
  ECRIRE(
    "Comment fonctionne flexbox : axe principal et axe secondaire ?",
    "display: flex crée un contexte où les enfants s'alignent sur un AXE PRINCIPAL (flex-direction : row par défaut) et un AXE SECONDAIRE (perpendiculaire). justify-content gère la répartition le long du principal, align-items sur le secondaire. Changer flex-direction échange les rôles — source de la moitié des surprises flex.",
  ),
  ECRIRE(
    "Comment centrer un élément parfaitement avec flex ?",
    "Conteneur : display: flex ; justify-content: center (axe principal) ; align-items: center (axe secondaire). Une ligne chacun, aucune magie de marges négatives — fonctionne pour les deux directions selon flex-direction.",
  ),
  ECRIRE(
    "Quelle différence entre justify-content: space-between, space-around et space-evenly ?",
    "space-between : espaces ENTRE les éléments seulement (premier collé au début, dernier à la fin). space-around : espace AUTOUR (demi-espace aux extrémités). space-evenly : espaces STRICTEMENT égaux partout, extrémités incluses. Trois répartitions, trois rendus de bord.",
  ),
  ECRIRE(
    "Que font flex-grow, flex-shrink et flex-basis ?",
    "Ils règlent la répartition de l'espace : basis = taille de départ (auto = selon contenu) ; grow = part de l'espace LIBRE absorbée (proportionnelle) ; shrink = part du RÉTRÉCISSEMENT en manque de place. flex: 1 = grow 1, shrink 1, basis 0% — colonnes égales qui remplissent.",
  ),
  ECRIRE(
    "Pourquoi mon flex item ne rétrécit-il pas ? (min-width: auto)",
    "Un flex item refuse de descendre sous son contenu : min-width/min-height auto (défaut) empêche le shrink de compresser le texte. Fix : min-width: 0 sur l'item (ou overflow: hidden) — le classique des tableaux/textes longs qui débordent d'un layout flex.",
  ),
  ECRIRE(
    "Que fait align-content dans un conteneur flex ?",
    "Elle ne s'applique QUE si les items WRAPPENT (flex-wrap: wrap) : elle répartit les LIGNES flex entre elles (stretch, center, space-between…) sur l'axe secondaire. align-items, elle, aligne chaque item DANS sa ligne — confondre les deux donne des CSS qui « ne marchent pas ».",
  ),
  ECRIRE(
    "Comment espacer proprement des éléments flex/grid ?",
    "gap : row-gap et column-gap (ou gap raccourci) entre les éléments — sans marges de bord qui doublent aux extrémités ni sélecteurs :not(:last-child). Accepté dans flex et grid ; les marges restent pour des cas asymétriques.",
  ),
  // ─── CSS : grid ─────────────────────────────────────────────────────────
  ECRIRE(
    "Comment faire une grille responsive sans media query ?",
    "grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)) : autant de colonnes ≥ 220px que le conteneur en permet. auto-fill réserve les pistes vides (alignements stables), auto-fit les écrase (les items s'étalent). Une ligne de CSS pour toute la responsive.",
  ),
  ECRIRE(
    "Comment placer un élément sur plusieurs colonnes en grid ?",
    "grid-column: 1 / 3 (de la ligne 1 à la ligne 3), grid-column: span 2 (s'étend de 2 pistes), grid-row pour les lignes. Placement par numéros de lignes (pas de colonnes) : une grille à n colonnes a n+1 lignes de bord.",
  ),
  ECRIRE(
    "Comment maquetter une page avec grid-template-areas ?",
    "grid-template-areas : \"header header\" \"sidebar main\" \"footer footer\" puis grid-area: main sur les enfants — la maquette visuelle en noms, réorganisable en une media query (renommer les areas). Les guillemets délimitent chaque LIGNE.",
  ),
  ECRIRE(
    "Quelle différence entre justify-items et justify-content en grid ?",
    "justify-items aligne chaque élément DANS sa cellule (start/end/stretch) ; justify-content répartit les PISTES elles-mêmes dans le conteneur (l'espace restant de la grille). Même logique verticale avec align-items/align-content. place-items combine les deux.",
  ),
  ECRIRE(
    "Que fait minmax(min, max) dans une piste grid ?",
    "Elle borne la piste : jamais sous min, jamais au-dessus de max. minmax(200px, 1fr) = au moins 200px, sinon partage du reste. minmax(0, 1fr) force le partage strict (contourne le min-content) — l'outil des layouts qui ne débordent pas.",
  ),
  ECRIRE(
    "Qu'est-ce que subgrid apporte ?",
    "subgrid : un enfant grid hérite les pistes de son PARENT — les lignes de cartes d'une liste s'alignent (titre, prix, bouton sur les mêmes rangées) sans JS ni tallies de hauteur. Support récent mais réel ; repli : align-items: stretch + min-height.",
  ),
  // ─── Responsive & custom properties ────────────────────────────────────
  ECRIRE(
    "Mobile-first : comment organiser ses media queries ?",
    "Styles de base pour mobile PUIS @media (min-width: 480px), (min-width: 768px), (min-width: 1024px)… en ordre croissant — chaque requête AJOUTE au-dessus de la précédente. Minimise les surcharges cascade et reflète le trafic réel (majorité mobile).",
  ),
  ECRIRE(
    "Comment rendre la typographie fluide sans sauts de breakpoint ?",
    "clamp(min, preferred, max) : font-size: clamp(1rem, 0.9rem + 1vw, 1.5rem) — grandit avec le viewport entre deux bornes. Plus fluide que des sauts media query ; conserve le zoom utilisateur tant que min est en rem.",
  ),
  ECRIRE(
    "Comment déclarer et utiliser une variable CSS ?",
    "Déclaration : :root { --couleur-marque: #336699; } ; usage : color: var(--couleur-marque). Valeur de repli : var(--x, #999). Les variables se HÉRITENT : une déclaration locale redéfinit la valeur pour son sous-arbre — c'est la base du theming et du dark mode.",
  ),
  ECRIRE(
    "Comment implémenter un dark mode avec les custom properties ?",
    "Toutes les couleurs en variables sur :root ; puis @media (prefers-color-scheme: dark) { :root { --fond: #111; --texte: #eee; } } — tout le thème bascule sans dupliquer le CSS. Un data-theme=\"dark\" côté JS (bouton) peut surcharger le choix du système.",
  ),
  ECRIRE(
    "Quelle différence entre em et rem ?",
    "em est relatif à la taille de police du PARENT (composition exponentielle dans les niveaux imbriqués) ; rem est relatif à la racine html — prévisible et SENSIBLE au zoom/préférence utilisateur. Règle pratique : font-size en rem, marges/paddings en rem, tailles ponctuelles locales en em.",
  ),
  ECRIRE(
    "Comment la spécificité CSS se calcule-t-elle ?",
    "Comptage (a, b, c) : identifiants, classes/attributs/pseudo-classes, éléments/pseudo-éléments. 1-0-0 bat 0-99-99. styles inline > tout ; !important inverse l'ordre (anti-pattern sauf utilitaires). Modernes : @layer pour déclarer l'ordre des couches et éviter la course aux sélecteurs.",
  ),
  ECRIRE(
    "Comment éviter les débordements horizontaux sur mobile ?",
    "Couper les causes : largeurs fixes en px → max-width: 100% ; images sans contrainte → width/height + max-width ; longues chaînes → overflow-wrap: anywhere ; conteneurs larges (tableaux/code) → overflow-x: auto dans un wrapper. Détection : document.documentElement.scrollWidth > innerWidth.",
  ),
  ECRIRE(
    "À quoi sert aspect-ratio en CSS ?",
    "aspect-ratio: 16 / 9 fixe la proportion d'une boîte dès qu'une dimension est connue — réserve la place AVANT chargement de l'image/média (anti-CLS) et simplifie les cartes responsive. Coexiste avec width/height natifs des img.",
  ),
  ECRIRE(
    "Que fait position: sticky et quand l'utiliser ?",
    "L'élément reste dans le flux puis se COLLE à l'offset (top: 0) quand le scroll dépasse — bandeaux d'en-tête, tableaux (thead sticky). Pièges : aucun ancêtre avec overflow: hidden, et un parent plus haut que la zone collée.",
  ),
  ECRIRE(
    "Quand choisir flex plutôt que grid (et inversement) ?",
    "FLEX pour une dimension : barres de navigation, groupes de boutons, rangées d'outils — répartition sur un axe. GRID pour deux dimensions : mise en page de page, galeries, formulaires alignés. Ils cohabitent : grid pour le squelette, flex DANS les cellules.",
  ),
];

function versPaire(u: UniteDevWeb): PaireLangage {
  return { motif: u.motif, reponse: u.reponse, theme: u.theme };
}

const FAMILLES_HTML_CSS = [
  "elements-html",
  "roles-aria",
  "attrs-aria",
  "flex-props",
  "grid-props",
  "media-queries",
  "custom-props",
  "unites-css",
] as const;

function genereFamilles(): readonly PaireLangage[] {
  const sorties: PaireLangage[] = [];
  for (const fam of FAMILLES_HTML_CSS) {
    for (const u of unitesFamilleDevWeb(fam, 10_000)) {
      sorties.push(versPaire(u));
    }
  }
  return sorties;
}

export const CORPUS_DEV_WEB_HTML_CSS_GENERE: readonly PaireLangage[] =
  genereFamilles();

export const CORPUS_DEV_WEB_HTML_CSS: readonly PaireLangage[] = [
  ...CORPUS_DEV_WEB_HTML_CSS_ECRIT,
  ...CORPUS_DEV_WEB_HTML_CSS_GENERE,
];

export const TAILLE_CORPUS_DEV_WEB_HTML_CSS = CORPUS_DEV_WEB_HTML_CSS.length;
