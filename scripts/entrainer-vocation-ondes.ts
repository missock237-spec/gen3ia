/**
 * ENTRAÎNEMENT DE GEN3 DANS LES 19 DOMAINES DE VOCATION — PAR ONDES (EOD).
 *
 * it.59 — demande propriétaire : « entraîne gen3 dans tous les domaines » +
 * « il doit savoir qu'il a été créé pour exécuter des tâches dans chaque
 * domaine ». Ce script exécute une session d'entraînement RÉELLE par la
 * méthode des ondes de domaine (it.57, lib/neural/training/entrainement-ondes)
 * sur les 19 identifiants de la charte de vocation (lib/gen3/vocation) —
 * compatibilité garantie et verrouillée par le garde 27ᵉ (chaque id de
 * vocation est un label `domainesOndes` valide).
 *
 * Usage (environnement d'entraînement, JAMAIS le serveur de production) :
 *   npx tsx scripts/entrainer-vocation-ondes.ts
 *
 * Les exemples sont DÉRIVÉS DE LA CHARTE elle-même (mission « créé pour »,
 * tâches types, mots-clés normalisés) : aucun texte inventé, un vocabulaire
 * de domaine RÉEL et reproductible (déterministe à l'exécution égale).
 *
 * Le rapport (JSON honnête : bande-porteuse, résonance mesurée, paquets,
 * renforts/annulations du bus, métabolisme cumulé pas à pas) est écrit dans
 * assets/neural-pretrained/vocation-ondes-report.json.
 *
 * HONNÊTÉ : la session entraîne le substrat LOCAL de cet environnement. En
 * production, le même entraînement est disponible via POST /api/neural/train
 * { source: "ondes", domainesOndes: IDS_VOCATION } (porte admin) — le cortex
 * de production consolide ses ondes à chaque session et persiste
 * automatiquement (var/neural/cortex-v2.bin).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CortexColumnnaire, CORTEX_CONFIG_DEFAUTS } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import { entrainerDomainesParOndes, type ExempleOnde } from "../lib/neural/training/entrainement-ondes";
import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";

/** Construit les exemples réels d'un domaine depuis sa charte. */
function exemplesDuDomaine(domaine: (typeof DOMAINES_VOCATION)[number]): ExempleOnde[] {
  const exemples: ExempleOnde[] = [
    // La mission, reformulée à la troisième personne (texte de charte réel).
    { texte: `${domaine.label} : gen3 est créé pour exécuter des tâches — ${domaine.mission.replace("tu as été créé pour", "il est créé pour")}`, domaine: domaine.id },
    // Chaque tâche type, ancrée sur le libellé du domaine.
    ...domaine.taches.map((tache) => ({
      texte: `${domaine.label} — tâche à exécuter : ${tache}.`,
      domaine: domaine.id,
    })),
    // Les mots-clés du domaine (vocabulaire réel du lexique de détection).
    { texte: `${domaine.label} : vocabulaire du domaine — ${domaine.motsCles.join(", ")}.`, domaine: domaine.id },
  ];
  return exemples;
}

function main() {
  console.log("=== ENTRAÎNEMENT GEN3 PAR ONDES — LES 19 DOMAINES DE VOCATION (it.59) ===");
  console.log(`Domaines de vocation : ${IDS_VOCATION.length}`);
  console.log(
    `Cortex : ${CORTEX_CONFIG_DEFAUTS.colonnes.toLocaleString("fr-FR")} colonnes ` +
      `(${CORTEX_CONFIG_DEFAUTS.voisins} voisins, ${CORTEX_CONFIG_DEFAUTS.bandes} bandes)`,
  );

  // Exemples réels dérivés de la charte (aucun texte inventé).
  const exemples: ExempleOnde[] = DOMAINES_VOCATION.flatMap(exemplesDuDomaine);
  const parDomaine = new Map<string, number>();
  for (const e of exemples) parDomaine.set(e.domaine, (parDomaine.get(e.domaine) ?? 0) + 1);
  console.log(`Exemples : ${exemples.length} (par domaine : ${[...parDomaine.values()].join(", ")})`);

  // Substrat production : cortex v1M + champ cortical 1000 régions.
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const champ = new ChampCorticalGen3();

  const t0 = Date.now();
  const rapport = entrainerDomainesParOndes(cortex, champ, exemples, {
    cyclesParEchantillon: 3,
    lrBoost: 0.15,
    maxParDomaine: 200,
  });
  const dureeS = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\nSession terminée en ${dureeS} s — ${rapport.totalEchantillons} échantillons traités.\n`);
  console.log("Domaine                                   bande  porteur   éch.  réson.  paquets  renforts  annul.");
  for (const r of rapport.domaines) {
    console.log(
      r.domaine.padEnd(42) +
        String(r.bande).padStart(3) +
        String(r.porteurFrequence.toFixed(2)).padStart(9) +
        String(r.echantillons).padStart(6) +
        (r.resonanceMoyenne.toFixed(4)).padStart(9) +
        String(r.paquetsEmis).padStart(9) +
        String(r.renforts).padStart(9) +
        String(r.annulations).padStart(8),
    );
  }

  const meta = rapport.metabolisme;
  console.log("\nMétabolisme cumulé (mesuré pas à pas) :");
  console.log(
    `  neurones évalués : ${meta.evaluees.toLocaleString("fr-FR")} — au repos : ${meta.reposes.toLocaleString("fr-FR")} (coût zéro)`,
  );
  console.log(
    `  transmissions : ${meta.transmissions.toLocaleString("fr-FR")} — ${meta.ms.toFixed(1)} ms mesurés`,
  );
  const partEvaluees = (meta.evaluees / (meta.evaluees + meta.reposes)) * 100;
  console.log(`  Part du substrat réellement évaluée : ${partEvaluees.toFixed(4)} % (le repos est gratuit).`);

  // Vérification honnête : les 19 domaines ont été traités.
  const traites = new Set(rapport.domaines.map((r) => r.domaine));
  const manquants = IDS_VOCATION.filter((id) => !traites.has(id));
  if (manquants.length > 0) {
    console.error(`\nÉCHEC : domaines non traités : ${manquants.join(", ")}`);
    process.exit(1);
  }

  const artefact = {
    date: new Date().toISOString(),
    methode: "EOD — Entraînement par Ondes de Domaine (it.57)",
    contexte: "it.59 — vocation de gen3 : entraînement réel sur les 19 domaines de la charte",
    cortex: {
      colonnes: cortex.config.colonnes,
      voisins: cortex.config.voisins,
      bandes: cortex.config.bandes,
    },
    options: { cyclesParEchantillon: 3, lrBoost: 0.15, maxParDomaine: 200 },
    totalEchantillons: rapport.totalEchantillons,
    domaines: rapport.domaines,
    metabolisme: rapport.metabolisme,
    dureeMs: Date.now() - t0,
  };
  const sortie = join(process.cwd(), "assets", "neural-pretrained", "vocation-ondes-report.json");
  mkdirSync(dirname(sortie), { recursive: true });
  writeFileSync(sortie, JSON.stringify(artefact, null, 2) + "\n");
  console.log(`\nRapport écrit : assets/neural-pretrained/vocation-ondes-report.json`);
}

main();
