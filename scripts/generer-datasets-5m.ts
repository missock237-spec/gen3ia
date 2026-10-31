/**
 * GÉNÉRATION DU DATASET 5 MILLIONS (it.65) — demande propriétaire :
 * « crée 5 millions de données et de dataset qui va permettre à
 * entraîner gen3 ».
 *
 * La FABRIQUE (lib/gen3/generateur-datasets) écrit ici un dataset RÉEL
 * sur disque : 5 000 000 d'échantillons répartis sur les 19 domaines de
 * vocation, un fichier JSONL.gz par lot de 2 000 (lecture directe par la
 * campagne d'entraînement), manifeste avec empreintes SHA-256. Le corpus
 * est déterministe (graine) : reproductible à l'identique, audit honnête
 * (chaque échantillon déclaré est réellement écrit et recompté).
 *
 * Usage : npx tsx scripts/generer-datasets-5m.ts [--verifier]
 *   (sans option : génère ; --verifier : recompte chaque fichier gz)
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ecrireDatasetGen3,
  lireManifesteGeneration,
  type ManifesteGeneration,
} from "../lib/gen3/generateur-datasets";
import { IDS_VOCATION, NB_DOMAINES_VOCATION } from "../lib/gen3/vocation";

/** LA DEMANDE : 5 millions de données. */
const TOTAL = 5_000_000;
/** Taille d'un lot-fichier (= cap garde-fou du trainer EOD). */
const TAILLE_LOT = 2000;
/** Graine de reproductibilité (génération it.65). */
const GRAINE = 65_103_100;

const REPERTOIRE = join(process.cwd(), "var", "datasets-generateur");

async function decompteLot(chemin: string): Promise<number> {
  const cs = new DecompressionStream("gzip");
  const { writable, readable } = cs;
  const w = writable.getWriter();
  const tache = (async () => {
    await w.write(new Uint8Array(readFileSync(chemin)));
    await w.close();
  })();
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let texte = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) texte += dec.decode(value, { stream: true });
  }
  await tache;
  texte += dec.decode();
  const lignes = texte.split("\n").filter((l) => l.trim().length > 0);
  for (const l of lignes) {
    const v = JSON.parse(l) as { text?: string; label?: string };
    if (typeof v.text !== "string" || v.text.length < 20 || v.label !== v.label) {
      throw new Error(`Ligne invalide dans ${chemin}`);
    }
  }
  return lignes.length;
}

async function verifier(manifeste: ManifesteGeneration): Promise<number> {
  let total = 0;
  for (const d of manifeste.domaines) {
    const dirDomaine = join(REPERTOIRE, d.id);
    let compteDomaine = 0;
    let sha = "";
    for (let lot = 0; lot < d.lots; lot++) {
      const chemin = join(dirDomaine, `lot-${String(lot).padStart(4, "0")}.jsonl.gz`);
      compteDomaine += await decompteLot(chemin);
      sha = createHash("sha256").update(sha).update(readFileSync(chemin)).digest("hex");
    }
    if (compteDomaine !== d.echantillons) {
      throw new Error(`${d.id} : recompte ${compteDomaine} ≠ manifeste ${d.echantillons}`);
    }
    if (sha !== d.sha256) {
      throw new Error(`${d.id} : empreinte SHA-256 différente du manifeste`);
    }
    total += compteDomaine;
    console.log(`  ${d.label} : ${compteDomaine.toLocaleString("fr-FR")} ✓`);
  }
  return total;
}

async function principal() {
  const modeVerifier = process.argv.includes("--verifier");
  if (modeVerifier) {
    const m = lireManifesteGeneration(REPERTOIRE);
    if (!m) {
      console.error("Aucun manifeste — génération absente.");
      process.exit(1);
    }
    const total = await verifier(m);
    console.log(
      `VÉRIFICATION OK : ${total.toLocaleString("fr-FR")} échantillons recomptés = manifeste (${m.totalEcrit.toLocaleString("fr-FR")}).`,
    );
    return;
  }

  const t0 = Date.now();
  const manifeste = await ecrireDatasetGen3(
    REPERTOIRE,
    { total: TOTAL, graine: GRAINE, tailleLot: TAILLE_LOT },
    IDS_VOCATION,
  );
  const dureeS = Math.round((Date.now() - t0) / 1000);
  const octets = manifeste.domaines.reduce((a, d) => a + d.octets, 0);
  console.log(`GÉNÉRATION TERMINÉE en ${dureeS} s :`);
  console.log(`  total écrit : ${manifeste.totalEcrit.toLocaleString("fr-FR")} / demandé ${TOTAL.toLocaleString("fr-FR")}`);
  console.log(`  domaines : ${manifeste.domaines.length} / ${NB_DOMAINES_VOCATION}`);
  console.log(`  fichiers : ${manifeste.domaines.reduce((a, d) => a + d.lots, 0)} lots (JSONL.gz) — ${(octets / 1e6).toFixed(1)} Mo compressés`);
  const espaces = manifeste.domaines.map((d) => d.espaceCombinatoire);
  console.log(`  espace combinatoire min/domaine : ${Math.min(...espaces).toLocaleString("fr-FR")}`);
  // Audit immédiat : recompte intégral + empreintes.
  const total = await verifier(manifeste);
  if (total !== manifeste.totalEcrit) {
    console.error("INCOHÉRENCE : recompte ≠ manifeste.");
    process.exit(1);
  }
  console.log(`AUDIT : ${total.toLocaleString("fr-FR")} échantillons réellement écrits et recomptés.`);
}

void principal();
