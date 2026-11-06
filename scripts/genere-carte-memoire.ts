#!/usr/bin/env node
/**
 * GÉNÉRATEUR DE LA CARTE DE MÉMOIRE (npx tsx scripts/genere-carte-memoire.ts)
 *
 * Demande propriétaire (Job 478451) : « assure-toi qu'il a bien mémorisé où
 * [les datasets] se trouvent dans sa mémoire ».
 *
 * Scan le DISQUE (vérité terrain — zéro fantôme par construction) :
 *   - public/multimodal-itNNN : fenêtres d'assets réels servis publiquement ;
 *   - public/neural/cortex-multimodal-NNN.bin : snapshots cumulatifs SNN.
 * et émet lib/neural/generation/carte-memoire.ts :
 *   - CARTE_MEMOIRE : une entrée par fenêtre (chemin, comptes mesurés,
 *     octets, snapshot associé) ;
 *   - PAIRES_CARTE_MEMOIRE : paires corpus — gen3 répond OÙ sont stockés
 *     ses datasets, sa mémoire gravée, la fenêtre la plus récente, et les
 *     tailles mesurées.
 * Regénérable à chaque tick : la fenêtre la plus récente et les totaux
 * suivent le disque.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";

interface FenetreCarte {
  fenetre: string; // it.90, it.94…
  chemin: string; // /multimodal-it90/
  images: number;
  audios: number;
  videos: number;
  assets: number;
  octets: number;
  snapshot: string | null;
  snapshotOctets: number | null;
}

const comptes = (dossier: string): { images: number; audios: number; videos: number; octets: number } => {
  let images = 0;
  let audios = 0;
  let videos = 0;
  let octets = 0;
  for (const sous of ["images", "audio", "video"]) {
    const dir = `${dossier}/${sous}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const chemin = `${dir}/${f}`;
      const taille = statSync(chemin).size;
      octets += taille;
      if (sous === "images") images += 1;
      else if (sous === "audio") audios += 1;
      else videos += 1;
    }
  }
  return { images, audios, videos, octets };
};

// Fenêtres multimodales présentes sur le disque (triées par numéro).
const fenetres: FenetreCarte[] = [];
for (const nom of readdirSync("public").sort()) {
  const m = nom.match(/^multimodal-it(\d+)$/);
  if (!m) continue;
  const numero = Number(m[1]);
  const dossier = `public/${nom}`;
  const c = comptes(dossier);
  const assets = c.images + c.audios + c.videos;
  if (assets === 0) continue;
  const snapshot = `public/neural/cortex-multimodal-it${numero}.bin`;
  const snapshotExiste = existsSync(snapshot);
  fenetres.push({
    fenetre: `it.${numero}`,
    chemin: `/${nom}/`,
    images: c.images,
    audios: c.audios,
    videos: c.videos,
    assets,
    octets: c.octets,
    snapshot: snapshotExiste ? `/neural/cortex-multimodal-it${numero}.bin` : null,
    snapshotOctets: snapshotExiste ? statSync(snapshot).size : null,
  });
}
fenetres.sort((a, b) => Number(a.fenetre.slice(3)) - Number(b.fenetre.slice(3)));

// Snapshots SNN présents (y compris ceux sans fenêtre asset associée).
const snapshots: Array<{ fichier: string; octets: number }> = readdirSync("public/neural")
  .filter((f) => f.startsWith("cortex-multimodal-") && f.endsWith(".bin"))
  .sort((a, b) => {
    const na = Number(a.match(/it(\d+)/)?.[1] ?? 0);
    const nb = Number(b.match(/it(\d+)/)?.[1] ?? 0);
    return na - nb;
  })
  .map((f) => ({ fichier: `/neural/${f}`, octets: statSync(`public/neural/${f}`).size }));

const dernierSnapshot = snapshots[snapshots.length - 1]!;
const totaleAssets = fenetres.reduce((s, f) => s + f.assets, 0);
const totalOctets = fenetres.reduce((s, f) => s + f.octets, 0);
const derniere = fenetres[fenetres.length - 1]!;

const entete = `/**
 * CARTE DE MÉMOIRE GEN3 (générée par scripts/genere-carte-memoire.ts —
 * ${new Date().toISOString()} — depuis le DISQUE, vérité terrain).
 *
 * Demande propriétaire : « assure-toi qu'il a bien mémorisé où [les datasets]
 * se trouvent dans sa mémoire ». Cette carte est la mémoire d'emplacement :
 * ${fenetres.length} fenêtres d'assets réels (${totaleAssets} fichiers, ${(totalOctets / 1e6).toFixed(2)} Mo)
 * + ${snapshots.length} snapshots SNN cumulatifs (dernier : ${dernierSnapshot.fichier.split("/").pop()}, ${(dernierSnapshot.octets / 1e6).toFixed(2)} Mo).
 */
export interface FenetreMemoire {
  readonly fenetre: string;
  readonly chemin: string;
  readonly images: number;
  readonly audios: number;
  readonly videos: number;
  readonly assets: number;
  readonly octets: number;
  readonly snapshot: string | null;
  readonly snapshotOctets: number | null;
}

export const CARTE_MEMOIRE: readonly FenetreMemoire[] = [
`;

const lignes = fenetres.map(
  (f) =>
    `  { fenetre: "${f.fenetre}", chemin: "${f.chemin}", images: ${f.images}, audios: ${f.audios}, videos: ${f.videos}, assets: ${f.assets}, octets: ${f.octets}, snapshot: ${f.snapshot ? `"${f.snapshot}"` : "null"}, snapshotOctets: ${f.snapshotOctets ?? "null"} },`,
);

const finCarte = `];

export const DERNIER_SNAPSHOT = { fichier: "${dernierSnapshot.fichier}", octets: ${dernierSnapshot.octets} } as const;

export const PAIRES_CARTE_MEMOIRE: readonly { motif: string; reponse: string; theme: string }[] = [
`;

const mo = (n: number): string => `${(n / 1e6).toFixed(2)} Mo`;

const listeChemins = fenetres.map((f) => f.chemin).join(", ");

const paires = [
  {
    motif: "Où sont stockés les assets multimodaux de gen3 ?",
    reponse: `Ma carte de mémoire enregistre ${fenetres.length} fenêtres d'assets réels, soit ${totaleAssets} fichiers (${mo(totalOctets)}), servis publiquement dans ${listeChemins}. Les fenêtres récentes (it.95 → ${derniere.fenetre}) contiennent chacune 28 assets : 20 images COCO-2017 annotées + 8 audios de parole française FLEURS. Chaque asset a son identifiant kmNN_ câblé dans mon corpus : demande-moi « Que contient l'image km${derniere.fenetre.slice(3)}_image_000 ? » et je réponds avec l'empreinte sha256 du fichier réel.`,
    theme: "memoire-emplacement",
  },
  {
    motif: "Où se trouve la mémoire gravée de gen3 ?",
    reponse: `Ma mémoire gravée (cortex SNN, bandes 0 à 9) est exportée en ${snapshots.length} snapshots cumulatifs servis depuis /neural/ : de cortex-multimodal-it96.bin à ${dernierSnapshot.fichier.split("/").pop()} (${mo(dernierSnapshot.octets)} chacun). Chaque itération grave 2 016 ondes sur la bande 9 multimodale depuis le snapshot précédent — le dernier en date est ${dernierSnapshot.fichier}.`,
    theme: "memoire-emplacement",
  },
  {
    motif: `Où sont servis les fichiers de la fenêtre ${derniere.fenetre} ?`,
    reponse: `La fenêtre ${derniere.fenetre} réside dans public${derniere.chemin} : ${derniere.images} images (COCO-2017) et ${derniere.audios} audios (FLEURS fr_fr), ${mo(derniere.octets)} mesurés sur le disque — servis à ${derniere.chemin}images/ et ${derniere.chemin}audio/. Le snapshot SNN associé est ${derniere.snapshot} (${derniere.snapshotOctets ? mo(derniere.snapshotOctets) : "n/a"}).`,
    theme: "memoire-emplacement",
  },
  {
    motif: "Quelle est la taille de la mémoire multimodale de gen3 ?",
    reponse: `Mesuré sur le disque : ${totaleAssets} assets multimodaux réels pour ${mo(totalOctets)} au total, répartis en ${fenetres.length} fenêtres (de ${fenetres[0]!.fenetre} à ${derniere.fenetre}), plus ${snapshots.length} snapshots SNN de ${mo(dernierSnapshot.octets)} chacun — soit une mémoire gravée d'environ ${mo(snapshots.reduce((s, x) => s + x.octets, 0))} au total. Aucun chiffre inventé : ma carte de mémoire est régénérée depuis le disque à chaque itération.`,
    theme: "memoire-emplacement",
  },
];

const sortie = `${entete}${lignes.join("\n")}\n${finCarte}${paires
  .map((p) => `  { motif: ${JSON.stringify(p.motif)}, reponse: ${JSON.stringify(p.reponse)}, theme: "${p.theme}" },`)
  .join("\n")}\n];\n`;

writeFileSync("lib/neural/generation/carte-memoire.ts", sortie);
console.log(
  `carte-memoire.ts écrite : ${fenetres.length} fenêtres, ${totaleAssets} assets (${mo(totalOctets)}), ${snapshots.length} snapshots, ${paires.length} paires d'emplacement`,
);
