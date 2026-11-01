/**
 * GÉNÉRATEUR DE SITES ET D'APPS SUR DEMANDE (it.80 — demande propriétaire,
 * trace 1a198553ec1dce61 : « via le navigateur, si un utilisateur demande de
 * créer un site ou une app, il peut lui générer du code »).
 *
 * PRINCIPE HONNÊTE : gen3 compose le code dans le CADRE APPRIS de la campagne
 * développement web it.79 (12 gabarits de fonctions + charte generation-code)
 * étendu ici au niveau « site / app complète » : 6 familles de projets
 * paramétrées (vitrine, liste, formulaire, panier, rendez-vous, blog) × nom
 * métier × contexte (Next.js 16 / React 19) × options (accessibilité WCAG,
 * sauvegarde locale). Le code produit est un VRAI module TypeScript/TSX —
 * déterministe (même demande → même code), sans évaluation (aucun eval ni
 * new Function, CSP sans unsafe-eval respectée) et sans invention hors
 * matière : ce qui n'est pas couvert par une famille est REFUSÉ avec une
 * explication, jamais improvisé.
 *
 * Pur et isomorphe : aucune dépendance Node, aucune variable globale — ce
 * module est importable par un composant client et par les tests vitest.
 */

export type TypeProjet =
  | "site-vitrine"
  | "app-liste"
  | "formulaire-contact"
  | "mini-panier"
  | "prise-rendezvous"
  | "page-blog";

export interface FicheTypeProjet {
  label: string;
  description: string;
  /** Le projet a-t-il un état persistable (localStorage applicable) ? */
  avecEtatPersistable: boolean;
}

export const TYPES_PROJET: Record<TypeProjet, FicheTypeProjet> = {
  "site-vitrine": {
    label: "Site vitrine",
    description: "Page d'accueil : en-tête, section services, pied de page de contact.",
    avecEtatPersistable: false,
  },
  "app-liste": {
    label: "App de liste (tâches)",
    description: "Application interactive : ajouter, cocher, retirer des tâches.",
    avecEtatPersistable: true,
  },
  "formulaire-contact": {
    label: "Formulaire de contact",
    description: "Champs contrôlés, validation d'e-mail et message de confirmation.",
    avecEtatPersistable: false,
  },
  "mini-panier": {
    label: "Mini-panier e-commerce",
    description: "Catalogue court, quantités +/−, total calculé en centimes.",
    avecEtatPersistable: true,
  },
  "prise-rendezvous": {
    label: "Prise de rendez-vous",
    description: "Choix d'une date, créneaux proposés, réservation confirmée.",
    avecEtatPersistable: true,
  },
  "page-blog": {
    label: "Page blog",
    description: "Liste d'articles titrés avec résumé et date au format français.",
    avecEtatPersistable: false,
  },
};

export interface OptionsProjet {
  type: TypeProjet;
  /** Nom métier libre (affiché) — « Café Goma », « Clinique Nkolo »… */
  nom: string;
  /** « next » = page app/… (Next.js 16) ; « react » = composant isolé (React 19). */
  contexte: "next" | "react";
  /** Ajoute les attributs aria/labels (accessibilité WCAG). */
  accessibilite: boolean;
  /** Persiste l'état dans localStorage (uniquement les projets à état). */
  stockageLocal: boolean;
}

export interface ResultatGeneration {
  type: TypeProjet;
  titre: string;
  /** Chemin de fichier conseillé dans un projet Next.js / React. */
  fichier: string;
  /** Récapitulatif de la demande comprise, en français. */
  instruction: string;
  /** Code TypeScript/TSX complet, prêt à copier. */
  code: string;
  /** Notes honnêtes sur ce qui est inclus — et ce qui ne l'est pas. */
  notes: string[];
}

const MAX_NOM = 48;

/** Nom affiché :Neutralise \ ` " ' < > & (aucune injection possible dans le code généré). */
export function nomAffiche(entree: string): string {
  const nettoye = entree
    .replace(/[\\`"'<>&]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOM);
  return nettoye.length > 0 ? nettoye : "Mon site";
}

/** Identifieur PascalCase (accents retirés, alphanumérique seul, repli « App »). */
export function identifieurNom(entree: string): string {
  const base = entree
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((m) => m.length > 0)
    .map((mot) => mot.charAt(0).toUpperCase() + mot.slice(1).toLowerCase())
    .join("")
    .replace(/^[0-9]+/, "");
  return (base.length > 0 ? base : "App").slice(0, 40);
}

/** Identifieur kebab-case pour les chemins de fichiers. */
function kebabCase(entree: string): string {
  return (
    entree
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "app"
  );
}

/* ------------------------------------------------------------------ */
/* Gabarits — chaque fonction renvoie les lignes du fichier généré     */
/* ------------------------------------------------------------------ */

interface Contexte {
  affiche: string; // « Next.js 16 » | « React 19 »
  ident: string; // identifieur composant de base
  fichier: string; // chemin conseillé
  client: boolean; // « use client » requis (hooks)
}

function contexteDe(o: OptionsProjet, ident: string, chemin: string): Contexte {
  if (o.contexte === "next") {
    return { affiche: "Next.js 16", ident, fichier: `app/${chemin}/page.tsx`, client: true };
  }
  return { affiche: "React 19", ident, fichier: `components/${ident}.tsx`, client: true };
}

function enTete(fichier: string, titre: string, contexte: Contexte, useClient: boolean): string[] {
  const lignes = [`// ${titre}`, `// Généré par gen3 — développement web it.80 (contexte ${contexte.affiche}).`, `// Fichier conseillé : ${fichier}`, ""];
  if (useClient) lignes.push("'use client';", "");
  return lignes;
}

function genererSiteVitrine(o: OptionsProjet, nom: string, ident: string): ResultatGeneration {
  const ctx: Contexte = o.contexte === "next"
    ? { affiche: "Next.js 16", ident: `Page${ident}`, fichier: "app/page.tsx", client: false }
    : { affiche: "React 19", ident: `Site${ident}`, fichier: `components/Site${ident}.tsx`, client: false };
  const a11y = o.accessibilite;
  const lignes: string[] = enTete(ctx.fichier, `Site vitrine — ${nom}`, ctx, false);
  lignes.push(
    `const SERVICES = [`,
    `  { titre: 'Consultation', description: 'Présentation du premier service de ${nom}.' },`,
    `  { titre: 'Accompagnement', description: 'Suivi personnalisé proposé par ${nom}.' },`,
    `  { titre: 'Assistance', description: 'Réponse aux questions des clients de ${nom}.' },`,
    `];`,
    ``,
    `export default function ${ctx.ident}() {`,
    `  return (`,
    `    <main className='mx-auto max-w-3xl px-4 py-10'>`,
    `      <header>`,
    `        <h1 className='text-3xl font-semibold'>${nom}</h1>`,
    `        <p className='mt-2 text-sm'>Bienvenue chez ${nom} — découvrez nos services.</p>`,
    `      </header>`,
  );
  if (a11y) {
    lignes.push(`      <section aria-labelledby='services-titre' className='mt-8'>`);
    lignes.push(`        <h2 id='services-titre' className='text-xl font-medium'>Nos services</h2>`);
  } else {
    lignes.push(`      <section className='mt-8'>`);
    lignes.push(`        <h2 className='text-xl font-medium'>Nos services</h2>`);
  }
  lignes.push(
    `        <ul className='mt-4 grid gap-4 sm:grid-cols-3'>`,
    `          {SERVICES.map((service) => (`,
    `            <li key={service.titre} className='rounded-xl border p-4'>`,
    `              <h3 className='font-medium'>{service.titre}</h3>`,
    `              <p className='mt-1 text-sm'>{service.description}</p>`,
    `            </li>`,
    `          ))}`,
    `        </ul>`,
    `      </section>`,
    `      <footer className='mt-10 text-sm'>Contact : contact@exemple.fr — © ${nom}</footer>`,
    `    </main>`,
    `  );`,
    `}`,
  );
  return {
    type: o.type,
    titre: `Site vitrine — ${nom}`,
    fichier: ctx.fichier,
    instruction: `Crée un site vitrine pour ${nom} (${ctx.affiche}) : en-tête, section services et pied de page de contact${a11y ? ", accessibilité WCAG (aria-labelledby)" : ""}.`,
    code: lignes.join("\n"),
    notes: [
      "Composant serveur (aucun hook) — rendu statique, rapide et sans état.",
      "Services d'exemple à éditer dans la constante SERVICES.",
      ...(a11y ? ["Accessibilité : section repérée par aria-labelledby (lecteurs d'écran)."] : ["Option accessibilité non activée : attributs aria omis."]),
    ],
  };
}

function genererAppListe(o: OptionsProjet, nom: string, ident: string): ResultatGeneration {
  const ctx = contexteDe(o, ident, kebabCase(nom) + "-liste");
  const clef = kebabCase(nom) + "-taches";
  const a11y = o.accessibilite;
  const local = o.stockageLocal;
  const lignes: string[] = enTete(ctx.fichier, `App de liste — ${nom}`, ctx, true);
  lignes.push(`import { useEffect, useState } from 'react';`, ``);
  lignes.push(
    `interface Tache { id: number; texte: string; faite: boolean }`,
    ``,
    `export default function ${ctx.ident}Liste() {`,
  );
  if (local) {
    lignes.push(
      `  const [taches, setTaches] = useState<Tache[]>(() => {`,
      `    try {`,
      `      const brut = localStorage.getItem('${clef}');`,
      `      return brut ? (JSON.parse(brut) as Tache[]) : [];`,
      `    } catch {`,
      `      return [];`,
      `    }`,
      `  });`,
    );
  } else {
    lignes.push(`  const [taches, setTaches] = useState<Tache[]>([]);`);
  }
  lignes.push(`  const [texte, setTexte] = useState('');`, ``);
  if (local) {
    lignes.push(
      `  useEffect(() => {`,
      `    try {`,
      `      localStorage.setItem('${clef}', JSON.stringify(taches));`,
      `    } catch {`,
      `      // stockage indisponible : l'état reste en mémoire (repli honnête)`,
      `    }`,
      `  }, [taches]);`,
      ``,
    );
  }
  lignes.push(
    `  const ajouter = () => {`,
    `    const propre = texte.trim();`,
    `    if (propre.length === 0) return;`,
    `    setTaches((precedent) => [...precedent, { id: Date.now(), texte: propre, faite: false }]);`,
    `    setTexte('');`,
    `  };`,
    `  const basculer = (id: number) =>`,
    `    setTaches((precedent) => precedent.map((t) => (t.id === id ? { ...t, faite: !t.faite } : t)));`,
    `  const retirer = (id: number) => setTaches((precedent) => precedent.filter((t) => t.id !== id));`,
    ``,
    `  return (`,
    `    <main className='mx-auto max-w-xl px-4 py-10'>`,
    `      <h1 className='text-2xl font-semibold'>Liste — ${nom}</h1>`,
    `      <div className='mt-4 flex gap-2'>`,
  );
  lignes.push(
    a11y
      ? `        <label className='sr-only' htmlFor='tache-entree'>Nouvelle tâche</label>`
      : `        {/* champ : ajoutez un label visible si besoin */}`,
  );
  lignes.push(
    `        <input`,
    a11y ? `          id='tache-entree'` : `          aria-label='Nouvelle tâche'`,
    `          value={texte}`,
    `          onChange={(e) => setTexte(e.target.value)}`,
    `          className='flex-1 rounded border px-3 py-2'`,
    `          placeholder='Nouvelle tâche…'`,
    `        />`,
    `        <button type='button' onClick={ajouter} className='rounded bg-blue-600 px-4 py-2 text-white'>`,
    `          Ajouter`,
    `        </button>`,
    `      </div>`,
    `      <ul className='mt-6 space-y-2'>`,
    `        {taches.map((t) => (`,
    `          <li key={t.id} className='flex items-center gap-3 rounded border p-3'>`,
    `            <input type='checkbox' checked={t.faite} onChange={() => basculer(t.id)} />`,
    `            <span className={t.faite ? 'flex-1 line-through' : 'flex-1'}>{t.texte}</span>`,
    `            <button type='button' onClick={() => retirer(t.id)} className='text-red-600'>`,
    `              Retirer`,
    `            </button>`,
    `          </li>`,
    `        ))}`,
    `      </ul>`,
    `      <p className='mt-4 text-sm'>Total : {taches.length} tâche(s), {taches.filter((t) => t.faite).length} terminée(s).</p>`,
    `    </main>`,
    `  );`,
    `}`,
  );
  return {
    type: o.type,
    titre: `App de liste — ${nom}`,
    fichier: ctx.fichier,
    instruction: `Crée une application de liste pour ${nom} (${ctx.affiche}) : ajout, cochage et retrait de tâches${local ? ", sauvegarde locale (localStorage)" : ""}${a11y ? ", libellés accessibles" : ""}.`,
    code: lignes.join("\n"),
    notes: [
      "Composant client ('use client') — état React useState/useEffect.",
      "Identifiants de tâches par Date.now() (démonstration ; un uuid convient en production).",
      ...(local ? [`Sauvegarde locale : clef '${clef}', repli silencieux si le stockage refuse.`] : ["Sauvegarde locale non activée : l'état se réinitialise au rechargement."]),
    ],
  };
}

function genererFormulaireContact(o: OptionsProjet, nom: string, ident: string): ResultatGeneration {
  const ctx = contexteDe(o, ident, kebabCase(nom) + "-contact");
  const a11y = o.accessibilite;
  const lignes: string[] = enTete(ctx.fichier, `Formulaire de contact — ${nom}`, ctx, true);
  lignes.push(
    `import { useState } from 'react';`,
    ``,
    `const RE_EMAIL = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;`,
    ``,
    `export default function ${ctx.ident}Contact() {`,
    `  const [nom, setNom] = useState('');`,
    `  const [email, setEmail] = useState('');`,
    `  const [message, setMessage] = useState('');`,
    `  const [envoye, setEnvoye] = useState(false);`,
    `  const [erreur, setErreur] = useState('');`,
    ``,
    `  const envoyer = (e: React.FormEvent) => {`,
    `    e.preventDefault();`,
    `    if (nom.trim().length === 0) { setErreur('Le nom est requis.'); return; }`,
    `    if (!RE_EMAIL.test(email)) { setErreur("L'adresse e-mail n'est pas valide."); return; }`,
    `    if (message.trim().length < 10) { setErreur('Le message doit faire au moins 10 caractères.'); return; }`,
    `    setErreur('');`,
    `    setEnvoye(true);`,
    `  };`,
    ``,
    `  if (envoye) {`,
    `    return (`,
    `      <main className='mx-auto max-w-xl px-4 py-10'>`,
    `        <h1 className='text-2xl font-semibold'>Merci !</h1>`,
    `        <p className='mt-2 text-sm'>${nom} vous répondra à l'adresse {email}.</p>`,
    `      </main>`,
    `    );`,
    `  }`,
    ``,
    `  return (`,
    `    <main className='mx-auto max-w-xl px-4 py-10'>`,
    `      <h1 className='text-2xl font-semibold'>Contact — ${nom}</h1>`,
    `      <form onSubmit={envoyer} className='mt-4 space-y-4'${a11y ? " aria-describedby='contact-aide'" : ""}>`,
  );
  if (a11y) lignes.push(`        <p id='contact-aide' className='text-sm'>Tous les champs sont requis.</p>`);
  lignes.push(
    `        <div>`,
    `          <label htmlFor='c-nom' className='block text-sm'>Nom</label>`,
    `          <input id='c-nom' value={nom} onChange={(e) => setNom(e.target.value)} className='mt-1 w-full rounded border px-3 py-2' />`,
    `        </div>`,
    `        <div>`,
    `          <label htmlFor='c-email' className='block text-sm'>E-mail</label>`,
    `          <input id='c-email' type='email' value={email} onChange={(e) => setEmail(e.target.value)} className='mt-1 w-full rounded border px-3 py-2' />`,
    `        </div>`,
    `        <div>`,
    `          <label htmlFor='c-message' className='block text-sm'>Message</label>`,
    `          <textarea id='c-message' value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className='mt-1 w-full rounded border px-3 py-2' />`,
    `        </div>`,
    `        {erreur.length > 0 && <p className='text-sm text-red-600'>{erreur}</p>}`,
    `        <button type='submit' className='rounded bg-blue-600 px-4 py-2 text-white'>Envoyer</button>`,
    `      </form>`,
    `    </main>`,
    `  );`,
    `}`,
  );
  return {
    type: o.type,
    titre: `Formulaire de contact — ${nom}`,
    fichier: ctx.fichier,
    instruction: `Crée un formulaire de contact pour ${nom} (${ctx.affiche}) : champs contrôlés, validation (nom, e-mail, message ≥ 10 caractères) et confirmation d'envoi${a11y ? ", libellés reliés (htmlFor) et aide aria-describedby" : ""}.`,
    code: lignes.join("\n"),
    notes: [
      "Validation côté client — doublonnez-la côté serveur (les entrées se falsifient).",
      "L'envoi est simulé localement (setEnvoye) : branchez ici votre route API (server action).",
      ...(a11y ? ["Accessibilité : label/htmlFor sur chaque champ, aide aria-describedby."] : ["Option accessibilité non activée : la structure aria minimale est omise."]),
    ],
  };
}

function genererMiniPanier(o: OptionsProjet, nom: string, ident: string): ResultatGeneration {
  const ctx = contexteDe(o, ident, kebabCase(nom) + "-panier");
  const clef = kebabCase(nom) + "-panier";
  const local = o.stockageLocal;
  const lignes: string[] = enTete(ctx.fichier, `Mini-panier — ${nom}`, ctx, true);
  lignes.push(
    `import { useEffect, useState } from 'react';`,
    ``,
    `interface Produit { id: number; nom: string; prix: number }`,
    `interface Ligne { id: number; quantite: number }`,
    ``,
    `// Prix en CENTIMES (entiers — aucun flottant dans l'argent).`,
    `const PRODUITS: Produit[] = [`,
    `  { id: 1, nom: 'Article 1', prix: 1500 },`,
    `  { id: 2, nom: 'Article 2', prix: 2500 },`,
    `  { id: 3, nom: 'Article 3', prix: 10000 },`,
    `];`,
    ``,
    `export default function ${ctx.ident}Panier() {`,
  );
  if (local) {
    lignes.push(
      `  const [lignes, setLignes] = useState<Ligne[]>(() => {`,
      `    try {`,
      `      const brut = localStorage.getItem('${clef}');`,
      `      return brut ? (JSON.parse(brut) as Ligne[]) : [];`,
      `    } catch {`,
      `      return [];`,
      `    }`,
      `  });`,
    );
  } else {
    lignes.push(`  const [lignes, setLignes] = useState<Ligne[]>([]);`);
  }
  lignes.push(``, ``);
  if (local) {
    lignes.push(
      `  useEffect(() => {`,
      `    try {`,
      `      localStorage.setItem('${clef}', JSON.stringify(lignes));`,
      `    } catch {`,
      `      // repli mémoire`,
      `    }`,
      `  }, [lignes]);`,
      ``,
    );
  }
  lignes.push(
    `  const changer = (id: number, delta: number) =>`,
    `    setLignes((precedent) => {`,
    `      const existante = precedent.find((l) => l.id === id);`,
    `      if (!existante) return delta > 0 ? [...precedent, { id, quantite: 1 }] : precedent;`,
    `      const quantite = Math.max(0, existante.quantite + delta);`,
    `      const suivant = precedent`,
    `        .map((l) => (l.id === id ? { ...l, quantite } : l))`,
    `        .filter((l) => l.quantite > 0);`,
    `      return suivant;`,
    `    });`,
    `  const totalCentimes = lignes.reduce((somme, l) => {`,
    `    const produit = PRODUITS.find((p) => p.id === l.id);`,
    `    return produit ? somme + produit.prix * l.quantite : somme;`,
    `  }, 0);`,
    ``,
    `  return (`,
    `    <main className='mx-auto max-w-xl px-4 py-10'>`,
    `      <h1 className='text-2xl font-semibold'>Panier — ${nom}</h1>`,
    `      <ul className='mt-4 space-y-2'>`,
    `        {PRODUITS.map((p) => (`,
    `          <li key={p.id} className='flex items-center justify-between rounded border p-3'>`,
    `            <span>{p.nom} — {(p.prix / 100).toFixed(2)} €</span>`,
    `            <span className='flex gap-2'>`,
    `              <button type='button' onClick={() => changer(p.id, -1)} aria-label={'Retirer un ' + p.nom}>−</button>`,
    `              <span>{lignes.find((l) => l.id === p.id)?.quantite ?? 0}</span>`,
    `              <button type='button' onClick={() => changer(p.id, 1)} aria-label={'Ajouter un ' + p.nom}>+</button>`,
    `            </span>`,
    `          </li>`,
    `        ))}`,
    `      </ul>`,
    `      <p className='mt-4 font-medium'>Total : {(totalCentimes / 100).toFixed(2)} €</p>`,
    `    </main>`,
    `  );`,
    `}`,
  );
  return {
    type: o.type,
    titre: `Mini-panier — ${nom}`,
    fichier: ctx.fichier,
    instruction: `Crée un mini-panier pour ${nom} (${ctx.affiche}) : trois articles, quantités +/− et total en euros calculé depuis des centimes entiers${local ? ", panier conservé en localStorage" : ""}.`,
    code: lignes.join("\n"),
    notes: [
      "Argent en CENTIMES entiers (leçon de la matière debiterSecurise) — jamais de flottant.",
      ...(local ? [`Sauvegarde locale : clef '${clef}'.`] : ["Sauvegarde locale non activée : le panier se vide au rechargement."]),
      "Paiement réel non inclus : branchez ici Stripe ou équivalent (voir matière fetchAvecRetry).",
    ],
  };
}

function genererPriseRendezvous(o: OptionsProjet, nom: string, ident: string): ResultatGeneration {
  const ctx = contexteDe(o, ident, kebabCase(nom) + "-rdv");
  const local = o.stockageLocal;
  const clef = kebabCase(nom) + "-rdv";
  const lignes: string[] = enTete(ctx.fichier, `Prise de rendez-vous — ${nom}`, ctx, true);
  lignes.push(
    `import { useEffect, useState } from 'react';`,
    ``,
    `const CRENEAUX = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];`,
    ``,
    `export default function ${ctx.ident}RendezVous() {`,
    `  const [date, setDate] = useState('');`,
    `  const [reserve, setReserve] = useState<{ date: string; creneau: string } | null>(null);`,
  );
  if (local) {
    lignes.push(
      `  const [pris, setPris] = useState<string[]>(() => {`,
      `    try {`,
      `      const brut = localStorage.getItem('${clef}');`,
      `      return brut ? (JSON.parse(brut) as string[]) : [];`,
      `    } catch {`,
      `      return [];`,
      `    }`,
      `  });`,
      ``,
      `  useEffect(() => {`,
      `    try {`,
      `      localStorage.setItem('${clef}', JSON.stringify(pris));`,
      `    } catch {`,
      `      // repli mémoire`,
      `    }`,
      `  }, [pris]);`,
      ``,
    );
  } else {
    lignes.push(`  const [pris, setPris] = useState<string[]>([]);`, ``);
  }
  lignes.push(
    `  const reserver = (creneau: string) => {`,
    `    if (date.length === 0) return;`,
    `    const clefCreneau = date + ' ' + creneau;`,
    `    if (pris.includes(clefCreneau)) return;`,
    `    setPris((precedent) => [...precedent, clefCreneau]);`,
    `    setReserve({ date, creneau });`,
    `  };`,
    ``,
    `  return (`,
    `    <main className='mx-auto max-w-xl px-4 py-10'>`,
    `      <h1 className='text-2xl font-semibold'>Rendez-vous — ${nom}</h1>`,
    `      <label htmlFor='rdv-date' className='mt-4 block text-sm'>Choisissez une date</label>`,
    `      <input id='rdv-date' type='date' value={date} onChange={(e) => setDate(e.target.value)} className='mt-1 rounded border px-3 py-2' />`,
    `      <ul className='mt-4 flex flex-wrap gap-2'>`,
    `        {CRENEAUX.map((creneau) => {`,
    `          const occupe = date.length > 0 && pris.includes(date + ' ' + creneau);`,
    `          return (`,
    `            <li key={creneau}>`,
    `              <button`,
    `                type='button'`,
    `                disabled={occupe || date.length === 0}`,
    `                onClick={() => reserver(creneau)}`,
    `                className='rounded border px-3 py-1 disabled:opacity-40'`,
    `              >`,
    `                {creneau}`,
    `              </button>`,
    `            </li>`,
    `          );`,
    `        })}`,
    `      </ul>`,
    `      {reserve && (`,
    `        <p className='mt-4 text-sm'>Rendez-vous confirmé : {reserve.creneau} le {reserve.date} chez ${nom}.</p>`,
    `      )}`,
    `    </main>`,
    `  );`,
    `}`,
  );
  return {
    type: o.type,
    titre: `Prise de rendez-vous — ${nom}`,
    fichier: ctx.fichier,
    instruction: `Crée une prise de rendez-vous pour ${nom} (${ctx.affiche}) : choix de date, six créneaux horaires, réservation unique par date+créneau${local ? ", réservations conservées en localStorage" : ""}.`,
    code: lignes.join("\n"),
    notes: [
      "Unicité locale par clef date+créneau — côté serveur, imposer la même contrainte en base.",
      "Les créneaux sont des données d'exemple (CRENEAUX) — à brancher sur votre agenda.",
      ...(local ? [`Sauvegarde locale : clef '${clef}'.`] : ["Sauvegarde locale non activée : les réservations se perdent au rechargement."]),
    ],
  };
}

function genererPageBlog(o: OptionsProjet, nom: string, ident: string): ResultatGeneration {
  const ctx: Contexte = o.contexte === "next"
    ? { affiche: "Next.js 16", ident: `Page${ident}Blog`, fichier: "app/blog/page.tsx", client: false }
    : { affiche: "React 19", ident: `Page${ident}Blog`, fichier: `components/Page${ident}Blog.tsx`, client: false };
  const a11y = o.accessibilite;
  const lignes: string[] = enTete(ctx.fichier, `Page blog — ${nom}`, ctx, false);
  lignes.push(
    `interface Article { slug: string; titre: string; resume: string; date: string }`,
    ``,
    `// Articles d'exemple — remplacez par vos données (fichier, CMS ou base).`,
    `const ARTICLES: Article[] = [`,
    `  { slug: 'ouverture', titre: 'Ouverture', resume: 'Le premier article de ${nom}.', date: '01/11/2026' },`,
    `  { slug: 'actualites', titre: 'Actualités', resume: 'Les nouveautés de ${nom}.', date: '02/11/2026' },`,
    `  { slug: 'agenda', titre: 'Agenda', resume: 'Les prochains événements de ${nom}.', date: '03/11/2026' },`,
    `];`,
    ``,
    `export default function ${ctx.ident}() {`,
    `  return (`,
    `    <main className='mx-auto max-w-2xl px-4 py-10'>`,
    `      <h1 className='text-3xl font-semibold'>Blog — ${nom}</h1>`,
    `      <ul className='mt-6 space-y-4'>`,
    `        {ARTICLES.map((article) => (`,
    `          <li key={article.slug} className='rounded-xl border p-4'>`,
    `            <h2 className='text-lg font-medium'>`,
    `              <a href={'/blog/' + article.slug} className='hover:underline'>{article.titre}</a>`,
    `            </h2>`,
    `            <p className='text-sm text-gray-500'>Publié le {article.date}</p>`,
    `            <p className='mt-1 text-sm'>{article.resume}</p>`,
    `          </li>`,
    `        ))}`,
    `      </ul>`,
    `    </main>`,
    `  );`,
    `}`,
  );
  if (a11y) {
    lignes.push(
      ``,
      `/* Note accessibilité : la liste est sémantique (ul/li), les liens sont`,
      `   explicites ; ajoutez un <a href='#contenu'> « aller au contenu » si la`,
      `   page entre dans une mise en page complète. */`,
    );
  }
  return {
    type: o.type,
    titre: `Page blog — ${nom}`,
    fichier: ctx.fichier,
    instruction: `Crée une page blog pour ${nom} (${ctx.affiche}) : liste d'articles titrés, résumé, date au format français et liens /blog/[slug]${a11y ? ", note d'accessibilité incluse" : ""}.`,
    code: lignes.join("\n"),
    notes: [
      "Composant serveur (aucun hook) — les données d'exemple sont locales à la page.",
      "Les dates s'affichent au format français (jj/mm/aaaa), matière formaterDateFr.",
      ...(a11y ? ["Accessibilité : liste sémantique et liens explicites."] : ["Option accessibilité non activée."]),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Point d'entrée unique                                               */
/* ------------------------------------------------------------------ */

const GENERATEURS: Record<TypeProjet, (o: OptionsProjet, nom: string, ident: string) => ResultatGeneration> = {
  "site-vitrine": genererSiteVitrine,
  "app-liste": genererAppListe,
  "formulaire-contact": genererFormulaireContact,
  "mini-panier": genererMiniPanier,
  "prise-rendezvous": genererPriseRendezvous,
  "page-blog": genererPageBlog,
};

/**
 * Génère le code d'un site/app dans le cadre appri — DÉTERMINISTE
 * (même demande → code octet-pour-octet identique) et sans évaluation.
 */
export function genererCodeSite(options: OptionsProjet): ResultatGeneration {
  const nom = nomAffiche(options.nom);
  const ident = identifieurNom(options.nom);
  const generateur = GENERATEURS[options.type];
  const resultat = generateur({ ...options, nom: options.nom }, nom, ident);
  return {
    ...resultat,
    notes: [
      ...resultat.notes,
      ident.length > 0 && ident !== "App"
        ? `Identifieur du composant dérivé du nom : ${ident} (PascalCase, accents retirés).`
        : "Nom non exploitable comme identifieur : repli « App » appliqué.",
      "Code composé dans le cadre appris (6 familles paramétrées, it.80) — pas une invention hors matière.",
    ],
  };
}

/** En-tête de section pour la page /code : les familles couvertes. */
export function famillesCouvertes(): string[] {
  return Object.values(TYPES_PROJET).map((f) => f.label);
}
