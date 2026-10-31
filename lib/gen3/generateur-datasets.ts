/**
 * LE GÉNÉRATEUR DE DATASETS DE GEN3 (it.65) — LA FABRIQUE INTERNE.
 *
 * Demande propriétaire : « crée un système qui va permettre à gen3
 * d'apprendre du générateur de dataset, pour qu'il puisse toujours
 * continuer à s'améliorer en continu » — puis « crée 5 millions de
 * données et de dataset qui va permettre à entraîner gen3 ».
 *
 * CE MODULE EST CE SYSTÈME : une fabrique déterministe (graine fixe) de
 * textes d'entraînement bilingues FR/EN dont CHAQUE token de vocabulaire
 * de domaine provient de la CHARTE DE VOCATION RÉELLE (lib/gen3/vocation :
 * taches, motsCles, outils, label). Une BIJECTION mixte-radix index→texte
 * garantit l'unicité (zéro doublon, zéro déduplication en mémoire) et un
 * ESPACE COMBINATOIRE vérifié — les données sont infinies au sens pratique
 * : la boucle d'auto-apprentissage (lib/entrainement-auto) peut générer
 * des lots TOUJOURS NOUVEAUX à chaque cycle, indéfiniment.
 *
 * HONNÊTETÉ : le corpus est SYNTHÉTIQUE et étiqueté comme tel (licence
 * CC-BY-4.0-synthetic-gen3ia, même approche que le générateur officiel du
 * dépôt training/gen3-domain-datasets). Le générateur inscrit la
 * FRÉQUENCE PORTEUSE de chaque domaine dans le substrat — il ne remplace
 * pas des données réelles massives (cf. « Limites honnêtes » it.61/63).
 * Zéro service d'IA externe : tout est local et reproductible.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DOMAINES_VOCATION } from "./vocation";

/* ------------------------------------------------------------------ */
/* Lexiques génériques (charnières de langue) — le vocabulaire DE      */
/* DOMAINE vient exclusivement de la charte réelle.                    */
/* ------------------------------------------------------------------ */

const FORMATS_FR = ["synthèse", "rapport", "tableau", "note", "plan d'action", "audit", "fiche", "comparatif", "résumé", "protocole", "liste de contrôle", "dossier"] as const;
const FORMATS_EN = ["summary", "report", "table", "note", "action plan", "audit", "sheet", "comparison", "digest", "protocol", "checklist", "file"] as const;
const CADRES_FR = ["2024", "2025", "2026", "T1 2026", "T2 2026", "T3 2026", "T4 2026", "trimestre en cours", "cette semaine", "ce mois-ci", "cette année", "prochaine échéance", "dernier cycle", "budget annuel"] as const;
const CADRES_EN = ["2024", "2025", "2026", "Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026", "current quarter", "this week", "this month", "this year", "next deadline", "last cycle", "annual budget"] as const;
const QUALIFICATIFS_FR = ["précis", "sourcé", "vérifié", "chiffré", "complet", "honnête", "mesurable", "priorisé", "structuré", "à jour", "fiable", "exploitable", "clair", "documenté", "traçable", "reproductible"] as const;
const QUALIFICATIFS_EN = ["precise", "sourced", "verified", "quantified", "complete", "honest", "measurable", "prioritized", "structured", "up to date", "reliable", "usable", "clear", "documented", "traceable", "reproducible"] as const;
const CHIFFRES = [12, 24, 36, 48, 60, 120, 240, 500, 1000, 5000] as const;
const CONNECTEURS_FR = ["pour un", "visant un", "avec un"] as const;
const CONNECTEURS_EN = ["for a", "aiming at a", "with a"] as const;

/** Lexique par domaine : [taches, motsCles, outils] — TOUT de la charte. */
export interface LexiqueDomaine {
  id: string;
  label: string;
  taches: readonly string[];
  motsCles: readonly string[];
  outils: readonly string[];
}

/** Lexique réel du domaine (charte de vocation — erreur si id inconnu). */
export function lexiqueDuDomaine(id: string): LexiqueDomaine {
  const d = DOMAINES_VOCATION.find((x) => x.id === id);
  if (!d) throw new Error(`Domaine de vocation inconnu : ${id}`);
  return { id: d.id, label: d.label, taches: d.taches, motsCles: d.motsCles, outils: d.outils };
}

/* ------------------------------------------------------------------ */
/* Bijection mixte-radix index → texte (unicité garantie)              */
/* ------------------------------------------------------------------ */

/** Les radices du domaine (le produit = l'espace combinatoire unique). */
export function radicesDuDomaine(l: LexiqueDomaine): number[] {
  return [
    CONNECTEURS_FR.length, // 3
    CHIFFRES.length, // 10
    QUALIFICATIFS_FR.length, // 16
    CADRES_FR.length, // 14
    FORMATS_FR.length, // 12
    Math.max(1, l.outils.length),
    Math.max(1, l.motsCles.length),
    Math.max(1, l.taches.length),
    4, // gabarits
    2, // langue
  ];
}

/** Espace combinatoire du domaine (produit des radices). */
export function espaceCombinatoire(l: LexiqueDomaine): number {
  let p = 1;
  for (const r of radicesDuDomaine(l)) p *= r;
  return p;
}

/** Texte procédural n° `i` du domaine (bilingue, ≥ 20 caractères). */
export function texteGenere(id: string, i: number): string {
  const l = lexiqueDuDomaine(id);
  let reste = i;
  const radices = radicesDuDomaine(l);
  const d: number[] = [];
  for (const r of radices) {
    const digit = reste % r;
    d.push(digit);
    reste = (reste - digit) / r;
  }
  const fr = d[9] === 0;
  const gabarit = d[8];
  const tache = l.taches[d[7] % l.taches.length] ?? "tâche de vocation";
  const motcle = l.motsCles[d[6] % l.motsCles.length] ?? "vocation";
  const outil = l.outils[d[5] % l.outils.length] ?? "registre gen3";
  const format = fr ? (FORMATS_FR[d[4]] ?? "synthèse") : (FORMATS_EN[d[4]] ?? "summary");
  const cadre = fr ? (CADRES_FR[d[3]] ?? "2026") : (CADRES_EN[d[3]] ?? "2026");
  const qualif = fr ? (QUALIFICATIFS_FR[d[2]] ?? "précis") : (QUALIFICATIFS_EN[d[2]] ?? "precise");
  const chiffre = CHIFFRES[d[1]] ?? 12;
  const connecteur = fr ? (CONNECTEURS_FR[d[0]] ?? "pour un") : (CONNECTEURS_EN[d[0]] ?? "for a");
  if (fr) {
    if (gabarit === 0) return `gen3 — ${tache} : ${motcle} (${outil}) ; ${format} ${cadre} ${connecteur} résultat ${qualif} sur ${chiffre} éléments (${l.label}).`;
    if (gabarit === 1) return `${l.label} : ${tache} — ${motcle}, ${format} ${cadre} ${connecteur} livrable ${qualif} (${chiffre} données, outil ${outil}).`;
    if (gabarit === 2) return `mission gen3 : ${tache} avec ${outil} sur ${motcle} ; ${format} ${cadre} ${qualif} ${connecteur} résultat couvrant ${chiffre} enregistrements (${l.label}).`;
    return `${l.label} — ${tache} : traiter ${motcle} avec ${outil}, produire un ${format} ${cadre}, ${qualif}, ${chiffre} éléments (${connecteur} livrable unique).`;
  }
  if (gabarit === 0) return `gen3 — ${tache}: ${motcle} (${outil}); ${format} ${cadre} ${connecteur} ${qualif} result over ${chiffre} items (${l.label}).`;
  if (gabarit === 1) return `${l.label}: ${tache} — ${motcle}, ${format} ${cadre} ${connecteur} ${qualif} deliverable (${chiffre} records, tool ${outil}).`;
  if (gabarit === 2) return `gen3 mission: ${tache} with ${outil} on ${motcle}; ${format} ${cadre} ${qualif} ${connecteur} result covering ${chiffre} verified records (${l.label}).`;
  return `${l.label} — ${tache}: process ${motcle} with ${outil}, produce a ${format} ${cadre}, ${qualif}, ${chiffre} items (single ${connecteur} deliverable).`;
}

/** Un LOT de textes consécutifs (déterministe, mémoire O(taille)). */
export function genererLot(id: string, debut: number, taille: number): string[] {
  const out: string[] = [];
  for (let i = debut; i < debut + taille; i++) out.push(texteGenere(id, i));
  return out;
}

/** Échantillon généré au format du trainer supervisé (label = id charte). */
export interface EchantillonGenere {
  text: string;
  label: string;
  index: number;
}

/** Paire conversationnelle générée (motif = demande, réponse = charte). */
export function paireGenere(id: string, i: number): { motif: string; reponse: string; theme: string } {
  const l = lexiqueDuDomaine(id);
  const texte = texteGenere(id, i);
  // Le MOTIF varie lui aussi sur plusieurs digits de la bijection (i mod 4
  // pour le gabarit, puis tâche, puis mot-clé sur les digits suivants) —
  // sa période (4 × taches × motsCles) dépasse très largement le lot par
  // cycle : un même motif ne revient pas au sein d'une session de cycles.
  const gabarit = i % 4;
  const tache =
    l.taches[Math.floor(i / 4) % l.taches.length] ?? l.taches[0] ?? "tâche de vocation";
  const motcle =
    l.motsCles[
      Math.floor(i / (4 * Math.max(1, l.taches.length))) % Math.max(1, l.motsCles.length)
    ] ?? "vocation";
  const motif =
    gabarit === 0
      ? `gen3, ${tache} (${motcle}) pour ${l.label.toLowerCase()} — que me proposes-tu ?`
      : gabarit === 1
        ? `J'ai besoin d'un accompagnement en ${l.label.toLowerCase()} : ${tache}, axe ${motcle}.`
        : gabarit === 2
          ? `Peux-tu t'occuper de ${tache.toLowerCase()} sur ${motcle} (${l.label}) ?`
          : `${l.label} : je veux ${tache.toLowerCase()} sur ${motcle} avec un résultat mesuré.`;
  return { motif, reponse: texte, theme: l.label };
}

/* ------------------------------------------------------------------ */
/* Écriture d'un dataset réel sur disque (JSONL.gz + manifeste)        */
/* ------------------------------------------------------------------ */

export interface PlanGeneration {
  /** Nombre TOTAL d'échantillons demandés (ex. 5 000 000). */
  total: number;
  /** Graine (reproductibilité — chaque fichier est re-générable à l'identique). */
  graine: number;
  /** Taille d'un lot-fichier (échantillons). */
  tailleLot: number;
}

export interface ManifesteGeneration {
  date: string;
  demande: string;
  methode: string;
  licence: string;
  graine: number;
  totalDemande: number;
  totalEcrit: number;
  tailleLot: number;
  domaines: Array<{
    id: string;
    label: string;
    echantillons: number;
    lots: number;
    espaceCombinatoire: number;
    /** Empreinte composite : chaîne sha256 des lots (audit honnête). */
    sha256: string;
    octets: number;
  }>;
  noteHonnete: string;
}

/** Écrit le texte comme UNE ligne JSON (échappement JSON natif). */
function ligneJson(texte: string, id: string, index: number): string {
  return JSON.stringify({ text: texte, label: id, index });
}

/**
 * Génère et écrit un dataset COMPLET sur disque : un fichier JSONL.gz par
 * lot (lecture directe par la campagne d'entraînement), un manifeste avec
 * les empreintes SHA-256 (audit honnête — rien n'est déclaré sans fichier).
 * Retourne le manifeste. (gzip via CompressionStream natif — zéro dépendance.)
 */
export async function ecrireDatasetGen3(
  repertoire: string,
  plan: PlanGeneration,
  ids: readonly string[],
): Promise<ManifesteGeneration> {
  mkdirSync(repertoire, { recursive: true });
  const parDomaine = Math.floor(plan.total / ids.length);
  const reste = plan.total - parDomaine * ids.length;
  let totalEcrit = 0;
  const domaines: ManifesteGeneration["domaines"] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k] ?? "";
    const l = lexiqueDuDomaine(id);
    const nb = parDomaine + (k < reste ? 1 : 0);
    const espace = espaceCombinatoire(l);
    if (espace < nb) {
      throw new Error(`Espace combinatoire insuffisant pour ${id} : ${espace} < ${nb}`);
    }
    const lots = Math.ceil(nb / plan.tailleLot);
    const dirDomaine = join(repertoire, id);
    mkdirSync(dirDomaine, { recursive: true });
    let sha = "";
    let octets = 0;
    let ecrits = 0;
    for (let lot = 0; lot < lots; lot++) {
      const debut = lot * plan.tailleLot;
      const taille = Math.min(plan.tailleLot, nb - debut);
      const lignes = genererLot(id, debut, taille).map((t, j) => ligneJson(t, id, debut + j));
      const brut = Buffer.from(lignes.join("\n") + "\n", "utf8");
      const gz = await gzipBrut(brut);
      const chemin = join(dirDomaine, `lot-${String(lot).padStart(4, "0")}.jsonl.gz`);
      writeFileSync(chemin, gz);
      ecrits += taille;
      octets += statSync(chemin).size;
      // Empreinte composite : chaîne sha256 des lots du domaine (audit).
      sha = createHash("sha256").update(sha).update(gz).digest("hex");
    }
    domaines.push({
      id,
      label: l.label,
      echantillons: ecrits,
      lots,
      espaceCombinatoire: espace,
      sha256: sha,
      octets,
    });
    totalEcrit += ecrits;
  }
  const manifeste: ManifesteGeneration = {
    date: new Date().toISOString(),
    demande: `génération de ${plan.total.toLocaleString("fr-FR")} données par le générateur interne (demande propriétaire it.65 : « 5 millions de données et de dataset »)`,
    methode: "bijection mixte-radix index→texte, vocabulaire exclusivement issu de la charte de vocation réelle (taches/motsCles/outils), gabarits FR/EN génériques, graine déterministe",
    licence: "CC-BY-4.0-synthetic-gen3ia",
    graine: plan.graine,
    totalDemande: plan.total,
    totalEcrit,
    tailleLot: plan.tailleLot,
    domaines,
    noteHonnete:
      "Corpus SYNTHÉTIQUE étiqueté comme tel : il inscrit la fréquence porteuse de chaque domaine dans le substrat, il ne remplace pas des données réelles massives (cf. Limites honnêtes it.61/63). Reproductible à l'identique depuis la graine.",
  };
  writeFileSync(join(repertoire, "manifeste.json"), JSON.stringify(manifeste, null, 2));
  return manifeste;
}

/** gzip natif (CompressionStream) — zéro dépendance externe. */
async function gzipBrut(brut: Buffer): Promise<Buffer> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  await writer.write(new Uint8Array(brut));
  await writer.close();
  const morceaux: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) morceaux.push(value);
  }
  return Buffer.concat(morceaux.map((m) => Buffer.from(m)));
}

/** Lit un manifeste de génération (null si absent/corrompu). */
export function lireManifesteGeneration(repertoire: string): ManifesteGeneration | null {
  const chemin = join(repertoire, "manifeste.json");
  try {
    if (!existsSync(chemin)) return null;
    const v: unknown = JSON.parse(readFileSync(chemin, "utf8"));
    if (
      typeof v === "object" &&
      v !== null &&
      "totalEcrit" in v &&
      "domaines" in v &&
      Array.isArray((v as ManifesteGeneration).domaines)
    ) {
      return v as ManifesteGeneration;
    }
    return null;
  } catch {
    return null;
  }
}
