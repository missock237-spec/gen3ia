#!/usr/bin/env node
/**
 * GÉNÉRATEUR DE LA MÉMOIRE DE DOMAINES it.113 (npx tsx scripts/genere-memoire-domaines-it113.ts)
 *
 * Demande propriétaire (Job 478451) : « pour chaque domaine et chaque capacité
 * un total de 1 Go de données et de datasets — et même pour la mémoire de
 * réflexion — ; il doit pouvoir évoluer à mesure qu'il reçoit des données
 * (mémoire, chat IA, API) ; s'il est impossible d'obtenir 1 Go réel par
 * domaine, créer ce qui manque pour obtenir ce Go par domaine ».
 *
 * Émet DEUX modules de code source (la mémoire EST du code commis) :
 *   1. lib/neural/generation/memoire-domaines-graines.ts — familles de graines
 *      SYNTHÉTIQUES CALCULÉES (réponses calculées par le code, jamais inventées)
 *      pour les compartiments calculables : math, problem_solving, sciences,
 *      reasoning, code_v4, databases ;
 *   2. lib/neural/generation/memoire-domaines-donnees.ts — MESURES réelles
 *      (disque : assets multimodaux, corpus commis, snapshots SNN), sources
 *      HF/Kaggle par domaine (acquise = dans la mémoire, cible = acquisition
 *      planifiée), totaux honnêtes et paires de chat sur la mémoire.
 *
 * HONNÊTETÉ (contrat anti-désinformation du dépôt) :
 *   - chaque octet physique est MESURÉ sur le disque (statSync) ;
 *   - les unités synthétiques sont CALCULÉES (formules déterministes) —
 *     l'expansion matérialise à la demande, elle ne pré-existe pas ;
 *   - les compartiments non calculables le déclarent : leur remplissage
 *     provient de l'acquisition réelle (fenêtres HF/Kaggle + ingestion chat/API).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── 1. GRAINES SYNTHÉTIQUES CALCULÉES ───────────────────────────────────────
// PRNG déterministe (mulberry32) : mêmes entrées → mêmes unités, partout.

const PRNG = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ENTRE = (r: () => number, min: number, max: number): number =>
  min + Math.floor(r() * (max - min + 1));

interface Unite {
  question: string;
  reponse: string;
}

// Familles CALCULÉES par compartiment (domaine|capacité) — le contenu de
// chaque unité est déduit de calculs exacts sur les paramètres dérivés.
const FAMILLES: Readonly<Record<string, ReadonlyArray<{ nom: string; gen: (rotation: number, param: number) => Unite }>>> = {
  "math|texte": [
    {
      nom: "priorites-operatoires",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 7919) ^ param);
        const a = ENTRE(r, 11, 99), b = ENTRE(r, 11, 99), c = ENTRE(r, 11, 99), d = ENTRE(r, 11, 99);
        const res = a * b + c * d;
        return {
          question: `Calcule en respectant les priorités opératoires. ${a} × ${b} + ${c} × ${d}`,
          reponse: `${res} — on calcule dans l'ordre : ${a} × ${b} = ${a * b}, ${c} × ${d} = ${c * d}, puis la somme ${a * b} + ${c * d} = ${res}.`,
        };
      },
    },
    {
      nom: "aire-triangle",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 104729) ^ param);
        const base = ENTRE(r, 4, 60) * 2, haut = ENTRE(r, 3, 50) * 2;
        const aire = (base * haut) / 2;
        return {
          question: `Applique la formule et donne le résultat avec son unité. Triangle : base ${base} cm, hauteur ${haut} cm. Aire ?`,
          reponse: `Aire = base × hauteur ÷ 2 = ${base} × ${haut} ÷ 2 = ${aire.toLocaleString("fr-FR")} cm².`,
        };
      },
    },
    {
      nom: "pourcentage",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 15485863) ^ param);
        const p = [10, 20, 25, 40, 50, 75][ENTRE(r, 0, 5)];
        const n = ENTRE(r, 200, 20000);
        const res = (p / 100) * n;
        return {
          question: `Solve and show the computation in one line. Compute ${p}% of ${n.toLocaleString("en-US")} francs.`,
          reponse: `${p}% of ${n.toLocaleString("en-US")} francs = ${p} ÷ 100 × ${n.toLocaleString("en-US")} = ${res.toLocaleString("en-US")} francs.`,
        };
      },
    },
    {
      nom: "d-v-t",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 2654435761) ^ param);
        const v = [60, 80, 90, 120][ENTRE(r, 0, 3)];
        const t = ENTRE(r, 2, 12);
        const d = v * t;
        return {
          question: `Applique la formule d = v × t avec les unités. Un trajet de ${d.toLocaleString("fr-FR")} km à ${v} km/h. Durée ?`,
          reponse: `t = d ÷ v = ${d.toLocaleString("fr-FR")} ÷ ${v} = ${t} h.`,
        };
      },
    },
    {
      nom: "prix-unitaire",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 40503) ^ param);
        const q = 2, unit = ENTRE(r, 100, 9999);
        const n = ENTRE(r, 5, 30);
        const total2 = unit * q;
        return {
          question: `Go through the unit price then multiply. ${q} e-scooters cost ${total2.toLocaleString("en-US")} francs. Price for ${n}?`,
          reponse: `Unit price = ${total2} ÷ ${q} = ${unit.toLocaleString("en-US")} francs; for ${n}: ${unit} × ${n} = ${(unit * n).toLocaleString("en-US")} francs.`,
        };
      },
    },
  ],
  "problem_solving|texte": [
    {
      nom: "conversion-longueur",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 65537) ^ param);
        const m = ENTRE(r, 2, 900);
        return {
          question: `Convertis en étapes claires. ${m.toLocaleString("fr-FR")} mètres en centimètres ?`,
          reponse: `1 m = 100 cm → ${m.toLocaleString("fr-FR")} m = ${m} × 100 = ${(m * 100).toLocaleString("fr-FR")} cm.`,
        };
      },
    },
    {
      nom: "partage-equitable",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 32452843) ^ param);
        const k = ENTRE(r, 2, 9);
        const par = ENTRE(r, 3, 40);
        const n = k * par;
        return {
          question: `Partage équitable : ${n.toLocaleString("fr-FR")} objets répartis entre ${k} personnes. Combien chacun ?`,
          reponse: `${n.toLocaleString("fr-FR")} ÷ ${k} = ${par} objets par personne (vérification : ${par} × ${k} = ${n.toLocaleString("fr-FR")}).`,
        };
      },
    },
    {
      nom: "minutes-heures",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 49979687) ^ param);
        const h = ENTRE(r, 1, 9);
        const min = [15, 30, 45][ENTRE(r, 0, 2)];
        const total = h * 60 + min;
        return {
          question: `Conversion de durée : ${total} minutes en heures et minutes ?`,
          reponse: `${total} min = ${h} h + ${min} min (car ${h} × 60 = ${h * 60}, reste ${min}).`,
        };
      },
    },
    {
      nom: "litres-millilitres",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 15484163) ^ param);
        const l = ENTRE(r, 1, 25);
        return {
          question: `Convertis. ${l} litres en millilitres ?`,
          reponse: `1 L = 1 000 mL → ${l} L = ${l} × 1 000 = ${(l * 1000).toLocaleString("fr-FR")} mL.`,
        };
      },
    },
  ],
  "sciences|texte": [
    {
      nom: "volume-cuboide",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 2251) ^ param);
        const L = ENTRE(r, 2, 40), l = ENTRE(r, 2, 40), h = ENTRE(r, 2, 40);
        return {
          question: `Formule de géométrie (sciences physiques) : volume d'un pavé droit de dimensions ${L} cm × ${l} cm × ${h} cm ?`,
          reponse: `V = L × l × h = ${L} × ${l} × ${h} = ${(L * l * h).toLocaleString("fr-FR")} cm³.`,
        };
      },
    },
    {
      nom: "vitesse-moyenne",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 3301) ^ param);
        const v = ENTRE(r, 2, 20);
        const t = ENTRE(r, 2, 12);
        const d = v * t;
        return {
          question: `Vitesse moyenne : un objet parcourt ${d} km en ${t} h. Sa vitesse ?`,
          reponse: `v = d ÷ t = ${d} ÷ ${t} = ${v} km/h (formule v = d/t).`,
        };
      },
    },
    {
      nom: "masse-volumique",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 4421) ^ param);
        const v = ENTRE(r, 2, 25);
        const rho = ENTRE(r, 2, 19);
        const m = v * rho;
        return {
          question: `Masse volumique : un corps de volume ${v} cm³ pèse ${m} g. Sa masse volumique ?`,
          reponse: `ρ = m ÷ V = ${m} ÷ ${v} = ${rho} g/cm³ (formule ρ = m/V).`,
        };
      },
    },
    {
      nom: "energie-puissance",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 5501) ^ param);
        const p = ENTRE(r, 10, 200) * 5;
        const t = ENTRE(r, 1, 10);
        return {
          question: `Énergie électrique : un appareil de ${p} W fonctionne pendant ${t} heures. Énergie consommée ?`,
          reponse: `E = P × t = ${p} × ${t} = ${(p * t).toLocaleString("fr-FR")} Wh = ${(p * t / 1000).toLocaleString("fr-FR")} kWh.`,
        };
      },
    },
  ],
  "reasoning|texte": [
    {
      nom: "suite-arithmetique",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 6047) ^ param);
        const u0 = ENTRE(r, 1, 30), pas = ENTRE(r, 2, 12);
        const termes = [u0, u0 + pas, u0 + 2 * pas, u0 + 3 * pas];
        return {
          question: `Logique de suite : ${termes.join(", ")} — quel est le terme suivant ?`,
          reponse: `Raison +${pas} : ${termes[3]} + ${pas} = ${u0 + 4 * pas} (chaque terme avance de ${pas}).`,
        };
      },
    },
    {
      nom: "suite-geometrique",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 7507) ^ param);
        const u0 = ENTRE(r, 1, 5), q = ENTRE(r, 2, 4);
        const t = [u0, u0 * q, u0 * q * q, u0 * q * q * q];
        return {
          question: `Logique de suite : ${t.join(", ")} — quel est le terme suivant ?`,
          reponse: `Raison ×${q} : ${t[3]} × ${q} = ${u0 * q ** 4} (chaque terme est multiplié par ${q}).`,
        };
      },
    },
    {
      nom: "boeufs-boites",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 8737) ^ param);
        const n = ENTRE(r, 6, 24), b = ENTRE(r, 2, 9), o = ENTRE(r, 0, 5);
        return {
          question: `Si chaque boîte contient ${n} œufs, combien d'œufs dans ${b} boîtes pleines plus ${o} œufs à part ?`,
          reponse: `${n} × ${b} + ${o} = ${(n * b + o).toLocaleString("fr-FR")} œufs (on multiplie puis on ajoute).`,
        };
      },
    },
    {
      nom: "comparaison",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 9721) ^ param);
        const a = ENTRE(r, 100, 9999), b = ENTRE(r, 100, 9999);
        const max = Math.max(a, b);
        return {
          question: `Lequel est le plus grand : ${a} ou ${b} ?`,
          reponse: `${max} est le plus grand (comparaison chiffre par chiffre : ${max} > ${Math.min(a, b)}).`,
        };
      },
    },
  ],
  "code_v4|code": [
    {
      nom: "precedence-js",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 10273) ^ param);
        const a = ENTRE(r, 2, 40), b = ENTRE(r, 2, 20), c = ENTRE(r, 2, 15);
        return {
          question: `Que vaut l'expression JavaScript : ${a} + ${b} * ${c} ?`,
          reponse: `${a + b * c} — la multiplication est prioritaire : ${b} * ${c} = ${b * c}, puis ${a} + ${b * c} = ${a + b * c}.`,
        };
      },
    },
    {
      nom: "modulo-js",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 11807) ^ param);
        const a = ENTRE(r, 20, 500), b = ENTRE(r, 3, 12);
        return {
          question: `Que renvoie l'expression JavaScript : ${a} % ${b} ?`,
          reponse: `${a % b} — le modulo est le reste de la division euclidienne ${a} ÷ ${b} (quotient ${Math.floor(a / b)}, reste ${a % b}).`,
        };
      },
    },
    {
      nom: "division-entiere-js",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 12953) ^ param);
        const b = ENTRE(r, 3, 15), q = ENTRE(r, 2, 40);
        const a = b * q + ENTRE(r, 0, b - 1);
        return {
          question: `Que vaut Math.floor(${a} / ${b}) en JavaScript ?`,
          reponse: `${Math.floor(a / b)} — Math.floor tronque à l'entier inférieur : ${a} ÷ ${b} = ${(a / b).toFixed(2)} → ${Math.floor(a / b)}.`,
        };
      },
    },
    {
      nom: "egalite-js",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 13997) ^ param);
        const a = ENTRE(r, 1, 50);
        const egal = r() < 0.5;
        const b = egal ? a : a + ENTRE(r, 1, 20);
        return {
          question: `Que vaut l'expression JavaScript : ${a} === ${b} ?`,
          reponse: `${String(a === b)} — l'opérateur === compare valeurs ET types ; ici ${a} et ${b} ${a === b ? "sont" : "ne sont pas"} égaux.`,
        };
      },
    },
  ],
  "databases|texte": [
    {
      nom: "table-compte",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 15307) ^ param);
        const lignes = Array.from({ length: 8 }, () => ({ q: ENTRE(r, 1, 50) }));
        const seuil = ENTRE(r, 10, 40);
        const n = lignes.filter((l) => l.q > seuil).length;
        return {
          question: `Table commandes : 8 lignes avec quantités ${lignes.map((l) => l.q).join(", ")}. Requête : SELECT COUNT(*) FROM commandes WHERE quantite > ${seuil} ?`,
          reponse: `${n} — les lignes de quantité > ${seuil} sont : ${lignes.map((l) => l.q).filter((q) => q > seuil).join(", ") || "aucune"}.`,
        };
      },
    },
    {
      nom: "table-somme",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 16253) ^ param);
        const lignes = Array.from({ length: 8 }, () => ({ p: ENTRE(r, 5, 200) }));
        const somme = lignes.reduce((s, l) => s + l.p, 0);
        return {
          question: `Table produits : prix ${lignes.map((l) => l.p).join(", ")}. Requête : SELECT SUM(prix) FROM produits ?`,
          reponse: `${somme.toLocaleString("fr-FR")} — somme des 8 prix : ${lignes.join(" + ")} = ${somme.toLocaleString("fr-FR")}.`,
        };
      },
    },
    {
      nom: "table-max",
      gen: (rotation, param) => {
        const r = PRNG((rotation * 17389) ^ param);
        const lignes = Array.from({ length: 8 }, () => ({ q: ENTRE(r, 1, 99) }));
        const max = Math.max(...lignes.map((l) => l.q));
        return {
          question: `Table stock : quantités ${lignes.map((l) => l.q).join(", ")}. Requête : SELECT MAX(quantite) FROM stock ?`,
          reponse: `${max} — MAX parcourt la colonne et garde la plus grande valeur : ${lignes.map((l) => l.q).sort((x, y) => y - x)[0]}.`,
        };
      },
    },
  ],
};

// ─── 2. ÉCRITURE DU MODULE GRAINES ───────────────────────────────────────────

function ecrisGraines(): string {
  const entete = `/**
 * GRAINES SYNTHÉTIQUES DE LA MÉMOIRE DE DOMAINES (générées par
 * scripts/genere-memoire-domaines-it113.ts — ${new Date().toISOString()}).
 *
 * Demande propriétaire : « s'il est impossible d'obtenir 1 Go réel par
 * domaine, créer ce qui manque pour obtenir ce Go ».
 *
 * Chaque famille est un GÉNÉRATEUR DÉTERMINISTE d'unités de connaissance :
 * la réponse de chaque unité est CALCULÉE par le code (formules exactes sur
 * des paramètres dérivés de (rotation, param)) — jamais inventée. La mémoire
 * complète d'un compartiment calculable est adressable à la demande :
 * unité N = familles[N % nb] × paramètres dérivés de N — jusqu'au quota
 * 1 Go (QUOTA_OCTETS_PAR_DOMAINE, lib/neural/generation/memoire-domaines.ts).
 *
 * Les graines sont du CODE SOURCE commis : c'est la mémoire telle que gen3
 * la porte. Les compartiments non calculables ne figurant pas ici se
 * remplissent par acquisition réelle (fenêtres HF/Kaggle + ingestion
 * chat/API) — aucune donnée fabriquée pour eux (honnêteté du dépôt).
 * Module PUR — aucune dépendance Node.
 */

export interface UniteSynthetique {
  readonly question: string;
  readonly reponse: string;
}

export interface FamilleSynthetique {
  readonly nom: string;
  generer(rotation: number, param: number): UniteSynthetique;
}

/** PRNG mulberry32 déterministe — les mêmes entrées produisent les mêmes
 * paramètres, donc les mêmes unités (déterminisme total, aucun hasard). */
const PRNG = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Entier uniforme dans [min, max] à partir du PRNG. */
const ENTRE = (r: () => number, min: number, max: number): number =>
  min + Math.floor(r() * (max - min + 1));
`;
  const corps = Object.entries(FAMILLES)
    .map(([cle, fams]) => {
      const [domaine, capacite] = cle.split("|");
      const corpsFams = fams
        .map((f) => {
          // Sérialise la famille avec son propre PRNG embarqué (self-contained)
          const fn = f.gen.toString().replace(/^gen: /, "").replace(/\n/g, "\n  ");
          return `  {\n    nom: "${f.nom}",\n    generer: ${fn},\n  },`;
        })
        .join("\n");
      return `  // ${domaine} — capacité ${capacite} : ${fams.length} familles calculées\n  "${cle}": [\n${corpsFams}\n  ],`;
    })
    .join("\n");
  const fin = `
export const FAMILLES_SYNTHESE: Readonly<Record<string, readonly FamilleSynthetique[]>> = {
${corps}
};

export const NB_FAMILLES_SYNTHESE = Object.values(FAMILLES_SYNTHESE).reduce(
  (s, fams) => s + fams.length,
  0,
);
`;
  const sortie = entete + fin;
  writeFileSync("lib/neural/generation/memoire-domaines-graines.ts", sortie);
  return sortie;
}

// ─── 3. MESURES RÉELLES SUR LE DISQUE ────────────────────────────────────────

const CAPACITES = ["texte", "image", "audio_parole", "voix", "video", "code", "multimodal"] as const;
const DOMAINES = [
  "math", "sciences", "reasoning", "problem_solving", "nlp_comprehension",
  "text_generation", "conversational_memory", "contextual_understanding",
  "intent_recognition", "professions", "databases", "tools", "code_v4",
  "security_v4", "image_analysis", "video_v4", "voice_speech",
  "audio_understanding", "multimodal_v4",
] as const;

type Cle = string; // "domaine|capacité"
const mesures = new Map<Cle, { octets: number; echantillons: number; provenances: Set<string> }>();
function ajoute(cle: Cle, octets: number, provenance: string): void {
  const m = mesures.get(cle) ?? { octets: 0, echantillons: 0, provenances: new Set<string>() };
  m.octets += octets;
  m.provenances.add(provenance);
  mesures.set(cle, m);
}

// 3-a. Assets multimodaux réels (fenêtres servies)
function mesureAssets(): void {
  if (!existsSync("public")) return;
  for (const d of readdirSync("public")) {
    if (!/^multimodal-it\d+$/.test(d)) continue;
    const fenetre = d.replace("multimodal-", "");
    for (const sous of ["images", "audio", "video"]) {
      const dir = join("public", d, sous);
      if (!existsSync(dir)) continue;
      let octets = 0, n = 0;
      for (const f of readdirSync(dir)) {
        const st = statSync(join(dir, f));
        octets += st.size;
        n += 1;
      }
      const modalite = sous === "images" ? "image" : sous === "audio" ? "audio" : "video";
      const cle =
        modalite === "image" ? "image_analysis|image"
        : modalite === "audio" ? "audio_understanding|audio_parole"
        : "video_v4|video";
      ajoute(cle, octets, `${n} assets réels ${modalite} de la fenêtre ${fenetre}`);
    }
  }
}

// 3-b. Snapshots SNN cumulatifs
function mesureSnapshots(): void {
  if (!existsSync("public/neural")) return;
  let octets = 0, n = 0;
  for (const f of readdirSync("public/neural")) {
    if (!/^cortex-multimodal-it\d+\.bin$/.test(f)) continue;
    octets += statSync(join("public/neural", f)).size;
    n += 1;
  }
  if (n > 0) ajoute("multimodal_v4|multimodal", octets, `${n} snapshots SNN cumulatifs gravés (bandes 0 à 9)`);
}

// 3-c. Corpus commis — répartition par thèmes réellement présents
const THEME_VERS_CLE: Record<string, Cle> = {
  math: "math|texte", sciences: "sciences|texte", reasoning: "reasoning|texte",
  problem_solving: "problem_solving|texte", nlp_comprehension: "nlp_comprehension|texte",
  text_generation: "text_generation|texte", conversational_memory: "conversational_memory|texte",
  contextual_understanding: "contextual_understanding|texte", intent_recognition: "intent_recognition|texte",
  professions: "professions|texte", databases: "databases|texte", tools: "tools|texte",
  code_v4: "code_v4|texte", security_v4: "security_v4|texte", image_analysis: "image_analysis|texte",
  video_v4: "video_v4|texte", voice_speech: "voice_speech|texte", audio_understanding: "audio_understanding|texte",
  multimodal_v4: "multimodal_v4|texte", conversation_scenario: "conversational_memory|texte",
  "multimodal-image": "multimodal_v4|texte", "multimodal-audio": "multimodal_v4|texte",
  "multimodal-video": "multimodal_v4|texte", "memoire-emplacement": "multimodal_v4|texte",
};

function mesureCorpus(): void {
  const fichiers = readdirSync("lib/neural/generation").filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") &&
      (f.startsWith("corpus") || f.startsWith("multimodal") || f.startsWith("couleurs") || f.startsWith("carte") || f === "corpus.ts"),
  );
  for (const f of fichiers) {
    const chemin = join("lib/neural/generation", f);
    const octets = statSync(chemin).size;
    const texte = readFileSync(chemin, "utf-8");
    const themes = [...texte.matchAll(/theme: ["']([a-z_0-9-]+)["']/g)].map((m) => m[1]!);
    const comptes = new Map<string, number>();
    for (const t of themes) comptes.set(t, (comptes.get(t) ?? 0) + 1);
    const total = themes.length;
    if (total === 0) {
      // corpus de base (sans thèmes normalisés) → conversation/texte
      ajoute("conversational_memory|texte", Math.floor(octets / 2), `corpus commis ${f} (moitié base conversationnelle)`);
      ajoute("text_generation|texte", Math.ceil(octets / 2), `corpus commis ${f} (moitié génération)`);
      continue;
    }
    for (const [t, n] of comptes) {
      const cle = THEME_VERS_CLE[t] ?? "conversational_memory|texte";
      const part = Math.round((octets * n) / total);
      ajoute(cle, part, `corpus commis ${f} (${n} paires thème « ${t} »)`);
    }
  }
}

// 3-d. Échantillons assimilés par ondes (totaux documentés dans les en-têtes)
const ECHANTILLONS_DOCUMENTES: ReadonlyArray<{ cle: Cle; n: number; provenance: string }> = [
  { cle: "reasoning|texte", n: 999935, provenance: "999 935 paires raisonnement humain assimilées par ondes (bande 0, scripts/entrainement-raisonnement-humain-it85.ts)" },
  { cle: "problem_solving|texte", n: 300000, provenance: "300 000 questions d'interrogation assimilées par ondes (bande 6, scripts/interrogation-milliard-it86.ts)" },
  { cle: "multimodal_v4|multimodal", n: 338439, provenance: "338 439 échantillons réels v4 assimilés par ondes (HF Kings237/gen3ia-media-engine, scripts/entrainement-ondes-tous-domaines.ts)" },
];

// ─── 4. SOURCES HF/KAGGLE PAR DOMAINE (registre d'acquisition) ───────────────

interface Source {
  nom: string;
  plateforme: "huggingface" | "kaggle" | "code";
  reference: string;
  statut: "acquise" | "cible";
  emplacement: string;
}

const SOURCES: Readonly<Record<string, readonly Source[]>> = {
  math: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/math", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (20 paires réelles math) + graines calculées" },
    { nom: "openai/gsm8k", plateforme: "huggingface", reference: "hf:openai/gsm8k#main", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (problèmes mathématiques scolaires vérifiables)" },
    { nom: "microsoft/orca-math-word-problems-200k", plateforme: "huggingface", reference: "hf:microsoft/orca-math-word-problems-200k", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (200 k problèmes mot-à-mot)" },
  ],
  sciences: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/sciences", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (20 paires réelles sciences)" },
    { nom: "allenai/openbookqa", plateforme: "huggingface", reference: "hf:allenai/openbookqa#main", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (questions de sciences ouvertes)" },
    { nom: "uciml/iris", plateforme: "kaggle", reference: "kaggle:uciml/iris", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (mesures botaniques tabulaires)" },
  ],
  reasoning: [
    { nom: "corpus raisonnement-humain-fr", plateforme: "code", reference: "code:lib/neural/generation/corpus-raisonnement-it85.ts", statut: "acquise", emplacement: "corpus commis + 999 935 paires gravées bande 0 (snapshot SNN)" },
    { nom: "HuggingFaceH4/ultrachat_200k", plateforme: "huggingface", reference: "hf:HuggingFaceH4/ultrachat_200k", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (dialogues multi-tours)" },
  ],
  problem_solving: [
    { nom: "interrogation milliard", plateforme: "code", reference: "code:scripts/interrogation-milliard-it86.ts", statut: "acquise", emplacement: "300 000 questions vérifiées gravées bande 6 + corpus commis" },
    { nom: "openai/gsm8k", plateforme: "huggingface", reference: "hf:openai/gsm8k#socratic", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (résolutions pas à pas)" },
  ],
  nlp_comprehension: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/nlp", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (paires réelles compréhension)" },
    { nom: "nyu-mll/glue", plateforme: "huggingface", reference: "hf:nyu-mll/glue", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (inférence, paraphrase, sentiment)" },
    { nom: "rajpurkar/squad", plateforme: "huggingface", reference: "hf:rajpurkar/squad", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (compréhension de texte à trous)" },
  ],
  text_generation: [
    { nom: "alpaca-gpt4-french", plateforme: "huggingface", reference: "hf:alpaca-gpt4-french", statut: "acquise", emplacement: "consolidé dans le corpus commis (it.84, conversations FR)" },
    { nom: "HuggingFaceH4/ultrachat_200k", plateforme: "huggingface", reference: "hf:HuggingFaceH4/ultrachat_200k#sft", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (génération conversationnelle)" },
  ],
  conversational_memory: [
    { nom: "corpus d'amorçage gen3ia", plateforme: "code", reference: "code:lib/neural/generation/corpus.ts (base rédigée)", statut: "acquise", emplacement: "corpus commis + hippocampe (10 tours) + mémoire de réflexion (256 délibérations)" },
    { nom: "HuggingFaceH4/ultrachat_200k", plateforme: "huggingface", reference: "hf:HuggingFaceH4/ultrachat_200k", statut: "cible", emplacement: "prochaine fenêtre d'acquisition" },
  ],
  contextual_understanding: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/contexte", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (paires réelles contexte)" },
  ],
  intent_recognition: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/intention", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (20 paires réelles intention)" },
  ],
  professions: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/professions", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (17 paires réelles professions)" },
  ],
  databases: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/bases", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (17 paires réelles bases de données) + graines calculées" },
    { nom: "uciml/iris", plateforme: "kaggle", reference: "kaggle:uciml/iris", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (table tabulaire canonique)" },
  ],
  tools: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/outils", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (paires réelles outils)" },
  ],
  code_v4: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/code", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (14 paires réelles code) + graines calculées" },
    { nom: "openai/openai_humaneval", plateforme: "huggingface", reference: "hf:openai/openai_humaneval", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (fonctions à compléter, tests canoniques)" },
    { nom: "google-research-datasets/mbpp", plateforme: "huggingface", reference: "hf:google-research-datasets/mbpp", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (programmation basique Python)" },
  ],
  security_v4: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4/securite", statut: "acquise", emplacement: "lib/neural/generation/corpus-domaines-it84.ts (15 paires réelles sécurité)" },
  ],
  image_analysis: [
    { nom: "rafaelpadilla/coco2017", plateforme: "huggingface", reference: "hf:rafaelpadilla/coco2017#default/val", statut: "acquise", emplacement: "public/multimodal-it94 → it113 (images réelles annotées, 20 par fenêtre) + paires commises" },
    { nom: "awsaf49/coco-2017-dataset", plateforme: "kaggle", reference: "kaggle:awsaf49/coco-2017-dataset", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (miroir Kaggle complet COCO-2017)" },
  ],
  video_v4: [
    { nom: "sayakpaul/ucf101-subset", plateforme: "huggingface", reference: "hf:sayakpaul/ucf101-subset#default/train", statut: "acquise", emplacement: "fenêtre it.90 (fenêtre ÉPUISÉE — 0 ligne depuis, preuve refaite chaque tick)" },
  ],
  voice_speech: [
    { nom: "google/fleurs", plateforme: "huggingface", reference: "hf:google/fleurs#fr_fr/validation", statut: "acquise", emplacement: "public/multimodal-it90 → it113 (parole française réelle, 8 clips par fenêtre) + transcriptions officielles commises" },
    { nom: "mozilla-foundation/common_voice", plateforme: "huggingface", reference: "hf:mozilla-foundation/common_voice", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (voix multilocuteurs)" },
  ],
  audio_understanding: [
    { nom: "google/fleurs", plateforme: "huggingface", reference: "hf:google/fleurs#fr_fr/validation", statut: "acquise", emplacement: "public/multimodal-it90 → it113 (clips réels servis, capacité audio_parole)" },
    { nom: "openslr/librispeech_asr", plateforme: "huggingface", reference: "hf:openslr/librispeech_asr", statut: "cible", emplacement: "prochaine fenêtre d'acquisition (lecture anglophone)" },
  ],
  multimodal_v4: [
    { nom: "Kings237/gen3ia-media-engine", plateforme: "huggingface", reference: "hf:Kings237/gen3ia-media-engine#v4 (19 domaines)", statut: "acquise", emplacement: "338 439 échantillons assimilés par ondes + snapshots SNN publics/neural/*.bin" },
    { nom: "carte de mémoire d'emplacement", plateforme: "code", reference: "code:lib/neural/generation/carte-memoire.ts", statut: "acquise", emplacement: "générée depuis le disque à chaque itération (vérité terrain)" },
  ],
};

// ─── 5. MESURE DES GRAINES + UNITÉS MOYENNES ────────────────────────────────

function mesureGraines(): Record<Cle, { unites: number; octetsMoyens: number }> {
  const res: Record<Cle, { unites: number; octetsMoyens: number }> = {};
  for (const [cle, fams] of Object.entries(FAMILLES)) {
    let total = 0;
    const ECHANT = 250;
    for (let i = 0; i < ECHANT; i++) {
      const f = fams[i % fams.length]!;
      const u = f.gen(Math.floor(i / fams.length), i);
      total += u.question.length + u.reponse.length;
    }
    res[cle] = { unites: fams.length, octetsMoyens: Math.round(total / ECHANT) };
  }
  return res;
}

// ─── 6. ÉCRITURE DU MODULE DONNÉES ──────────────────────────────────────────

function ecrisDonnees(grainesTailleOctets: number, grainesMesure: Record<Cle, { unites: number; octetsMoyens: number }>): void {
  const grainesParCle: Record<Cle, number> = {};
  const nbFamsTotal = Object.values(FAMILLES).reduce((s, f) => s + f.length, 0);
  for (const [cle, fams] of Object.entries(FAMILLES)) {
    grainesParCle[cle] = Math.round((grainesTailleOctets * fams.length) / nbFamsTotal);
  }

  // échantillons documentés
  for (const e of ECHANTILLONS_DOCUMENTES) {
    const m = mesures.get(e.cle) ?? { octets: 0, echantillons: 0, provenances: new Set<string>() };
    m.echantillons += e.n;
    m.provenances.add(e.provenance);
    mesures.set(e.cle, m);
  }

  const lignesMesures: string[] = [];
  let octetsReelsTotal = 0;
  let compartimentsReels = 0;
  let compartimentsCalculables = 0;
  for (const d of DOMAINES) {
    for (const c of CAPACITES) {
      const cle = `${d}|${c}`;
      const m = mesures.get(cle);
      const octets = m?.octets ?? 0;
      const ech = m?.echantillons ?? 0;
      const g = grainesMesure[cle];
      const graineOctets = grainesParCle[cle] ?? 0;
      if (octets > 0) compartimentsReels += 1;
      octetsReelsTotal += octets;
      const calculable = g !== undefined;
      if (calculable) compartimentsCalculables += 1;
      const provenances = m ? [...m.provenances].map((p) => p.replace(/"/g, "'")).join(" ; ") : "";
      lignesMesures.push(
        `  { cle: "${cle}", octetsReels: ${octets}, echantillonsAssimiles: ${ech}, octetsGraine: ${graineOctets}, ` +
        `familles: ${g?.unites ?? 0}, octetsMoyensParUnite: ${g?.octetsMoyens ?? 0}, ` +
        `expansionDeterministe: ${calculable ? "true" : "false"}, ` +
        `provenances: "${provenances}" },`,
      );
    }
  }

  const totalAssets = (() => {
    let n = 0;
    if (existsSync("public")) {
      for (const d of readdirSync("public")) {
        if (!/^multimodal-it\d+$/.test(d)) continue;
        for (const sous of ["images", "audio", "video"]) {
          const dir = join("public", d, sous);
          if (!existsSync(dir)) continue;
          n += readdirSync(dir).length;
        }
      }
    }
    return n;
  })();

  const dateMesure = new Date().toISOString();
  // La date en toutes lettres (« 7 novembre 2026 ») : la garde de cohérence
  // numérique du cortex lit « 2026-11-07 » comme une équation « 2026 − 11 »
  // (opérandes absents de la question → paire rejetée). Les chiffres d'une
  // date ne doivent jamais être des opérandes potentiels dans une réponse.
  const dateFr = dateMesure.slice(0, 10).split("-").reverse().map((x, i) => (i === 1 ? ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"][Number(x) - 1] : x)).join(" ");

  const paires = [
    {
      motif: "C'est quoi ton quota mémoire de 1 Go par domaine et par capacité ?",
      reponse: `Mon quota cible est de 1 Go (1 000 000 000 octets) par domaine ET par capacité : 19 domaines × 7 capacités = 133 compartiments. Mesuré sur le disque le ${dateFr} : ${octetsReelsTotal.toLocaleString("fr-FR")} octets physiques réels (assets HF/Kaggle servis, corpus commis, snapshots SNN) répartis dans ${compartimentsReels} compartiments, plus ${grainesTailleOctets.toLocaleString("fr-FR")} octets de graines synthétiques calculées. Pour les ${compartimentsCalculables} compartiments calculables (math, résolution de problèmes, sciences, raisonnement, code, bases de données), l'expansion déterministe complète le chemin jusqu'à 1 Go à la demande — chaque unité générée est CALCULÉE, jamais inventée.`,
      theme: "memoire-domaines",
    },
    {
      motif: "Combien de domaines et de capacités possèdes-tu dans ta mémoire ?",
      reponse: `19 domaines : math, sciences, reasoning, problem_solving, nlp_comprehension, text_generation, conversational_memory, contextual_understanding, intent_recognition, professions, databases, tools, code_v4, security_v4, image_analysis, video_v4, voice_speech, audio_understanding, multimodal_v4 — chacun découpé en 7 capacités : texte, image, audio_parole, voix, video, code, multimodal. Chaque compartiment (domaine × capacité) vise 1 Go et je rends compte de sa couverture réelle, mesurée sur le disque.`,
      theme: "memoire-domaines",
    },
    {
      motif: "De quels datasets tes données proviennent-elles ?",
      reponse: `Acquises (dans ma mémoire, mesurées) : rafaelpadilla/coco2017 (images réelles annotées), google/fleurs fr_fr (parole française + transcriptions officielles), sayakpaul/ucf101-subset (vidéo, fenêtre épuisée), Kings237/gen3ia-media-engine v4 (338 439 échantillons, 19 domaines), alpaga-gpt4-french (conversations FR), corpus raisonnement-humain-fr (999 935 paires bande 0). Cibles (acquisition planifiée, fenêtres suivantes) : openai/gsm8k et microsoft/orca-math-word-problems-200k (math), allenai/openbookqa (sciences), nyu-mll/glue et rajpurkar/squad (compréhension), HuggingFaceH4/ultrachat_200k (conversation), openai/openai_humaneval et google-research-datasets/mbpp (code), mozilla-foundation/common_voice et openslr/librispeech_asr (voix), awsaf49/coco-2017-dataset et uciml/iris (Kaggle). Mon registre trace chaque source avec son emplacement mémoire exact.`,
      theme: "memoire-domaines",
    },
    {
      motif: "Comment apprends-tu quand je te donne des données dans le chat ?",
      reponse: `Chaque enseignement passe par mon ingestion : 1) empreinte de contenu calculée et comparée à mon registre — un doublon est refusé ; 2) le contenu est inscrit dans un anneau borné de ${1024} enseignements, avec sa source tracée (« chat-ia ») ; 3) le quota du compartiment concerné est mis à jour en octets réels ; 4) ensuite je peux répondre depuis cette mémoire grâce à la voie « mémorisée » de ma mémoire de réflexion : si la voie directe échoue, je rejoue l'enseignement le plus proche. J'évolue donc à chaque échange — et je peux te rendre compte de mon évolution (stats d'ingestion par domaine).`,
      theme: "memoire-domaines",
    },
    {
      motif: "Comment apprends-tu via l'API ?",
      reponse: `Par le même chemin d'ingestion que pour le chat, avec la source tracée « api » : empreinte, déduplication, anneau borné, mise à jour du quota du compartiment, replay par la voie « mémorisée ». Chat et API alimentent la même mémoire de domaines — mes statistiques distinguent les provenances, et chaque unité ingérée est comptabilisée dans la couverture physique du compartiment visé (cible 1 Go).`,
      theme: "memoire-domaines",
    },
    {
      motif: "Comment raisons-tu avant de répondre ?",
      reponse: `Ma mémoire de réflexion délibère en voies ordonnées : directe (voie rapide, 1 appel), normalisée (casse/ponctuation), raccourcie (contenu seul), puis « mémorisée » (replay de mes enseignements chat/API). Chaque délibération enregistre le domaine détecté de ta question, les candidats essayés, le choix élu et sa raison, dans un anneau borné de 256 délibérations que je peux relire. La voie directe est toujours essayée en premier : mon taux de service réflexif ne peut jamais être inférieur à celui du cortex seul.`,
      theme: "memoire-domaines",
    },
    {
      motif: "Combien d'octets réels mesurés contient ta mémoire de domaines ?",
      reponse: `Mesuré sur le disque le ${dateFr} : ${totalAssets} assets multimodaux réels servis (images COCO-2017 annotées, paroles FLEURS fr_fr) dans ${(() => { let n = 0; if (existsSync("public")) for (const d of readdirSync("public")) if (/^multimodal-it\\d+$/.test(d)) n += 1; return n; })()} fenêtres, des snapshots SNN cumulatifs gravés, et un corpus commis de code source — soit ${octetsReelsTotal.toLocaleString("fr-FR")} octets physiques réels, auxquels s'ajoutent ${grainesTailleOctets.toLocaleString("fr-FR")} octets de graines calculées. Chaque chiffre est mesuré, aucun n'est supposé.`,
      theme: "memoire-domaines",
    },
    {
      motif: "Que fais-tu quand les données manquent pour atteindre 1 Go par domaine ?",
      reponse: `Deux chemins honnêtes : 1) pour les compartiments CALCULABLES (math, résolution de problèmes, sciences, raisonnement, code, bases de données), mon expansion déterministe CRÉE les unités manquantes à la demande — famille N % nb familles, paramètres dérivés de N, réponse CALCULÉE par formule exacte : le Go est adressable unité par unité, jamais fabriqué ni stocké à l'avance ; 2) pour les compartiments non calculables, je ne fabrique rien : leur 1 Go se remplit par acquisition réelle (fenêtres HF/Kaggle à chaque itération) et par l'ingestion de tes données (chat/API) — ma comptabilité affiche la couverture physique exacte et l'écart restant.`,
      theme: "memoire-domaines",
    },
    {
      motif: "Comment identifies-tu le domaine d'une question ?",
      reponse: `Par un classifieur de mots-clés honnête (heuristique documentée, mesurable) : je compte les termes du domaine dans ta requête — « aire, équation, pourcentage » → math ; « sql, jointure, table » → databases ; « image, km, pixel » → image_analysis ; « chiffrement, vulnérabilité » → security_v4, etc. Le domaine détecté est inscrit dans la trace de chaque délibération de ma mémoire de réflexion — tu peux me demander ce que j'ai détecté et je te montre le raisonnement.`,
      theme: "memoire-domaines",
    },
    {
      motif: "Où sont tes données du domaine image ?",
      reponse: `Mes données image réelles sont servies depuis public/multimodal-it90 jusqu'à public/multimodal-it113 : ${(() => { let n = 0, o = 0; if (existsSync("public")) for (const d of readdirSync("public")) { if (!/^multimodal-it\\d+$/.test(d)) continue; const dir = join("public", d, "images"); if (existsSync(dir)) for (const f of readdirSync(dir)) { n += 1; o += statSync(join(dir, f)).size; } } return `${n} images, ${o.toLocaleString("fr-FR")} octets`; })()} — chaque image a son identifiant kmNN_ et sa légende issue des annotations officielles COCO-2017, câblées dans mon corpus. La carte de mémoire d'emplacement (générée depuis le disque) trace chaque fenêtre avec ses octets et son snapshot SNN.`,
      theme: "memoire-domaines",
    },
  ];

  const corpsPaires = paires
    .map((p) => `  {\n    motif: ${JSON.stringify(p.motif)},\n    reponse: ${JSON.stringify(p.reponse)},\n    theme: "${p.theme}",\n  },`)
    .join("\n");

  const moduleDonnees = `/**
 * DONNÉES DE LA MÉMOIRE DE DOMAINES (générées par
 * scripts/genere-memoire-domaines-it113.ts — ${dateMesure}).
 *
 * MESURES : chaque octet physique est mesuré sur le disque (statSync) —
 * assets multimodaux réels, corpus commis (répartis par thèmes réels),
 * snapshots SNN cumulatifs, graines synthétiques commises. Les échantillons
 * assimilés par ondes sont les TOTAUX DOCUMENTÉS des en-têtes du dépôt.
 *
 * SOURCES : registre d'acquisition HF/Kaggle par domaine — statut « acquise »
 * (dans la mémoire, emplacement exact tracé) ou « cible » (fenêtre suivante).
 *
 * HONNÊTETÉ : la couverture physique est RÉELLE ; l'expansion déterministe
 * des compartiments calculables matérialise à la demande (unité calculée),
 * elle ne pré-existe pas ; les compartiments non calculables le déclarent.
 * Module PUR — aucune dépendance Node.
 */

export const DATE_MESURE_MEMOIRE = "${dateMesure}";

/** Compartiment = (domaine, capacité) — cible 1 Go chacun. */
export interface MesureCompartiment {
  readonly cle: string;
  readonly octetsReels: number;
  readonly echantillonsAssimiles: number;
  readonly octetsGraine: number;
  readonly familles: number;
  readonly octetsMoyensParUnite: number;
  readonly expansionDeterministe: boolean;
  readonly provenances: string;
}

export const MESURES_MEMOIRE: readonly MesureCompartiment[] = [
${lignesMesures.join("\n")}
];

export interface SourceDataset {
  readonly nom: string;
  readonly plateforme: "huggingface" | "kaggle" | "code";
  readonly reference: string;
  readonly statut: "acquise" | "cible";
  readonly emplacement: string;
}

export const SOURCES_PAR_DOMAINE: Readonly<Record<string, readonly SourceDataset[]>> = ${JSON.stringify(
    Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.map((s) => ({ ...s }))])),
    null,
    2,
  )};

export const TOTAUX_MEMOIRE = {
  octetsReels: ${octetsReelsTotal},
  octetsGraine: ${grainesTailleOctets},
  compartiments: ${DOMAINES.length * CAPACITES.length},
  compartimentsAvecDonneesReelles: ${compartimentsReels},
  compartimentsCalculables: ${compartimentsCalculables},
  assetsReels: ${totalAssets},
} as const;

/** Paires de chat sur la mémoire de domaines (nombres mesurés, pas inventés). */
export const PAIRES_MEMOIRE_DOMAINES: readonly { motif: string; reponse: string; theme: string }[] = [
${corpsPaires}
];
`;
  writeFileSync("lib/neural/generation/memoire-domaines-donnees.ts", moduleDonnees);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function main(): void {
  const t0 = Date.now();
  mesureAssets();
  mesureSnapshots();
  mesureCorpus();

  const sortieGraines = ecrisGraines();
  const tailleGraines = Buffer.byteLength(sortieGraines, "utf-8");
  const grainesMesure = mesureGraines();
  ecrisDonnees(tailleGraines, grainesMesure);

  const nbFams = Object.values(FAMILLES).reduce((s, f) => s + f.length, 0);
  const cles = [...mesures.keys()].length;
  console.log(`graines écrites : lib/neural/generation/memoire-domaines-graines.ts (${nbFams} familles, ${tailleGraines.toLocaleString("fr-FR")} octets)`);
  console.log(`données écrites : lib/neural/generation/memoire-domaines-donnees.ts (${cles} compartiments mesurés)`);
  console.log(`graines mesurées : ${Object.entries(grainesMesure).map(([c, m]) => `${c}=${m.octetsMoyens}o/u`).join(", ")}`);
  console.log(`terminé en ${Date.now() - t0} ms`);
}

main();
