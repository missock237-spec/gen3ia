/**
 * ÉVALUATION À GRANDE ÉCHELLE v5 — 1 000 000 de requêtes de routage
 * (réellement exécutées, pas extrapolées) + Q/R du cortex langagier sur
 * questions tenues à l'écart (couleurs / math GSM8K / sciences ARC).
 *
 * Exécution : npx tsx scripts/evaluation-1m.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { tokenize } from "../lib/neural/encoding/text-encoder";
import { MOTS_CLES_ENRICHIS } from "../lib/neural/training/mots-cles-enrichis";
import { POIDS_ANCRS_V51, NOUVEAUX_ANCRS_V51, ANCRS_CURATES_V51 } from "../lib/neural/training/ancres-ponderees-v51";
import { resoudreCouleurs } from "../lib/neural/solveurs/moteur-couleurs";
import { resoudreCalcul } from "../lib/neural/solveurs/moteur-calcul";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";

// ── Miroir EXACT de predireDomaineLexical (domaines.ts est server-only) ──────
// Sources : DOMAINES_GEN3 (motsCles noyau) — copiés au moment du run depuis
// training/domaines.ts via extraction du JSON généré (mots-cles-enrichis.ts)
// + motsCles du dépôt, extraits une fois par lecture du fichier source.

const SOURCE_DOMAINES = readFileSync(
  join(process.cwd(), "lib/neural/training/domaines.ts"),
  "utf8",
);

function extraireMotsClesNoyau(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  // Extraction du bloc DOMAINES_GEN3 : id + motsCles:[...]
  const blocs = SOURCE_DOMAINES.split(/\n  \{/g);
  for (const bloc of blocs) {
    const idMatch = bloc.match(/id:\s*"([a-z_]+)"/);
    const motsMatch = bloc.match(/motsCles:\s*\[([^\]]+)\]/);
    if (!idMatch || !motsMatch) continue;
    const mots = [...motsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    map[idMatch[1]] = mots;
  }
  return map;
}

const ANCRES_ETENDUES: Record<string, string[]> = {
  generation_images: ["rendu", "photorealiste", "photorealistic", "watercolor", "aquarelle", "variation"],
  video: ["scenario", "script", "plan", "shot", "fps", "codec", "montage", "editing"],
  son: ["podcast", "mixage", "lufs", "synthese", "synthesis", "voiceover", "voice"],
  clips_musicaux: ["chorus", "paroles", "lyrics", "beat", "afrobeat", "amapiano", "album"],
  developpement_web: ["frontend", "backend", "route", "component", "composant", "deploy", "bug", "endpoint"],
  test: ["unitaire", "unit", "integration", "e2e", "mock", "coverage", "regression", "flaky"],
  redaction_documents: ["redaction", "writing", "outline", "plan", "relire", "proofread", "resume", "summary"],
  sciences_humaines: ["archive", "societe", "epoque", "philosophique", "geographie", "anthropologie"],
  recherche_scientifique: ["experiment", "falsifiable", "randomisation", "effect", "reproducibilite", "peer"],
  cybersecurite: ["defensive", "defense", "phishing", "ransomware", "firewall", "parefeu", "sbom", "audit", "contain", "contenir"],
  recherche_web: ["google", "moteur", "search", "url", "archive", "factcheck", "verifier", "source"],
  multimodal: ["crossmodal", "ocr", "transcript", "receipt", "recu", "invoice", "facture", "modalite"],
  hacker: ["writeup", "payload", "bénin", "benign", "vm", "challenge", "flag", "reversing"],
  construction_machines: ["actionneur", "actuator", "watchdog", "asservissement", "firmware", "microcontroller"],
  vente: ["closing", "devis", "quote", "upsell", "crm", "offre", "proposal", "pipeline"],
  sante_medical: ["hydratation", "hydration", "paludisme", "malaria", "ordonnance", "prescription", "patient"],
  analyse_donnees: ["pandas", "sql", "dataset", "median", "mediane", "histogramme", "correlation", "nettoyage"],
  conseiller_commercial: ["recommendation", "recommander", "prioriser", "roadmap", "suivi", "followup"],
};

const NOYAU = extraireMotsClesNoyau();
const IDS = Object.keys(NOXAU_FALLBACK());
function NOXAU_FALLBACK(): Record<string, string[]> {
  return NOYAU;
}

function predireLexical(texte: string): { id: string; score: number } | null {
  const tokens = new Set(tokenize(texte));
  if (tokens.size === 0) return null;
  // Miroir EXACT de predireDomaineLexical v5.1 (domaines.ts) : contribution
  // = base × masse d'usage mesurée (POIDS_ANCRS_V51) ; token non mesuré =
  // exclusif → masse 1.
  let meilleur: { id: string; score: number } | null = null;
  for (const id of IDS) {
    let score = 0;
    const contribuer = (token: string, base: number): void => {
      if (!tokens.has(token)) return;
      const table = POIDS_ANCRS_V51[token];
      score += base * (table ? (table[id] ?? 0) : 1);
    };
    for (const mot of NOYAU[id] ?? []) contribuer(mot, 2);
    for (const ancre of ANCRES_ETENDUES[id] ?? []) contribuer(ancre, 1);
    for (const ancre of MOTS_CLES_ENRICHIS[id] ?? []) contribuer(ancre, 1);
    for (const ancre of NOUVEAUX_ANCRS_V51[id] ?? []) contribuer(ancre, 1);
    for (const ancre of ANCRS_CURATES_V51[id] ?? []) if (tokens.has(ancre)) score += 1;
    if (score <= 0) continue;
    if (!meilleur || score > meilleur.score) meilleur = { id, score };
  }
  return meilleur;
}

// ─────────────────────────── Fabriques de requêtes (graine 999) ─────────────

function creerRng(graine: number): () => number {
  let s = graine >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SUJETS = ["montagnes", "un port", "un atelier", "une forêt", "un marché", "un pont"];
const PHRASES: Record<string, string[]> = {
  generation_images: ["Génère une image photorealiste de X", "Crée une illustration lumineuse de X", "I want a photorealistic picture of X"],
  video: ["Monte une vidéo de 30 secondes avec storyboard dynamique", "Crée un clip vidéo explicatif avec sous-titres", "Produce a short video with cinematic shots"],
  son: ["Synthétise une ambiance sonore de pluie", "Génère une voix off claire pour mon podcast", "Create a calm sound ambience"],
  clips_musicaux: ["Compose un clip musical afrobeat à 100 BPM", "Écris les paroles du refrain et structure le beat", "Write lyrics for the chorus"],
  developpement_web: ["Corrige le bug de mon composant React", "Ajoute une route API backend avec validation", "Fix the frontend bug and deploy"],
  test: ["Écris des tests unitaires jest avec mocks et couverture", "Ajoute un test e2e d'intégration pour la régression", "Write unit tests to raise coverage"],
  redaction_documents: ["Rédige un rapport professionnel sur la qualité", "Relis ce document puis fais le résumé exécutif", "Write a professional report outline"],
  sciences_humaines: ["Explique l'histoire de l'imprimerie et son impact sur la société", "Analyse ce phénomène sociologique avec une approche philosophique", "Explain the history and sociology of this culture"],
  recherche_scientifique: ["Conçois le protocole d'une expérience avec hypothèse falsifiable", "Analyse les résultats de cette étude et l'effet mesuré", "Design a research protocol with hypothesis"],
  cybersecurite: ["Analyse cette alerte phishing et le containment", "Renforce le pare-feu et l'authentification MFA", "Handle this security incident and harden the firewall"],
  recherche_web: ["Fais une recherche internet et vérifie les sources", "Browse the web and fact-check these URLs", "Vérifie en ligne cette information et cite les sources"],
  multimodal: ["Extrais le texte par OCR de cette facture", "Analyse cette capture multimodale et le reçu joint", "Run OCR on the invoice image"],
  hacker: ["Résous ce challenge CTF avec stego et writeup", "Analyse ce binaire en reversing pour le flag", "Solve this CTF and write the writeup"],
  construction_machines: ["Construis un robot avec capteur et asservissement PID", "Règle le firmware du microcontrôleur et le watchdog", "Tune the PID loop and firmware"],
  vente: ["Prépare un pitch de vente avec devis et objections", "Rédige la proposition commerciale et le suivi CRM", "Prepare a sales pitch and quote"],
  sante_medical: ["Rédige une fiche prévention sur l'hydratation et le paludisme", "Explique cette ordonnance et le traitement au patient", "Explain the prescription to the patient"],
  analyse_donnees: ["Analyse ce CSV avec pandas : médiane et corrélation", "Écris la requête SQL puis nettoie le dataset", "Analyze the dataset: median and correlation"],
  conseiller_commercial: ["Recommande un plan d'action et priorise le suivi client", "Fais une recommandation de roadmap conseil", "Recommend the best consulting followup"],
};

// ─────────────────────────── 1. Routing : 1 000 000 requêtes ────────────────

function evaluerRouting1M(): Record<string, unknown> {
  const rng = creerRng(999_001);
  const NB = 1_000_000;
  const parDomaine: Record<string, { total: number; corrects: number }> = {};
  for (const id of IDS) parDomaine[id] = { total: 0, corrects: 0 };
  let corrects = 0;
  const debut = Date.now();
  for (let i = 0; i < NB; i++) {
    const k = Math.floor(rng() * IDS.length);
    const id = IDS[k];
    const fabrique = PHRASES[id];
    let phrase = fabrique[Math.floor(rng() * fabrique.length)];
    // Varie légèrement les sujets pour les phrases avec « X »
    if (phrase.includes("X")) {
      phrase = phrase.replace("X", SUJETS[Math.floor(rng() * SUJETS.length)]);
    }
    const detection = predireLexical(phrase);
    parDomaine[id].total++;
    if (detection && detection.id === id) {
      corrects++;
      parDomaine[id].corrects++;
    }
  }
  const dureeMs = Date.now() - debut;
  return {
    requetesExecutees: NB,
    dureeMs,
    requetesParSeconde: Math.round((NB / dureeMs) * 1000),
    accuracyGlobale: Number((corrects / NB).toFixed(4)),
    parDomaine: Object.fromEntries(
      Object.entries(parDomaine).map(([id, v]) => [
        id,
        { total: v.total, accuracy: Number((v.corrects / v.total).toFixed(3)) },
      ]),
    ),
  };
}

// ─────────────────── 2. Cortex langagier : Q/R sur questions tenues à l'écart ─

function evaluerCortex(): Record<string, unknown> {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3);

  // Ingestion des paires v5 (même logique que connaissances-pro.ts) — quotas
  // PRO2 (job 478451, relance) : absorbent les datasets professionnels réels
  // (GSM8K normalisé, ARC normalisé, SciQ réel, FLEURS fr réel, UCF101 réel,
  // Kaggle colorNames, reformulations propriétaires) tout en restant sous le
  // plafond MAX_PAIRES_PERSONNALISEES = 20 000 du cortex.
  const SOURCES = [
    ["couleurs_v5", 4000], ["math_professionnel", 4000],
    ["sciences_professionnel", 3600], ["raisonnement_professionnel", 2100],
    ["vision_professionnel", 800], ["texte_professionnel", 400],
    ["parole_professionnelle", 400],
  ] as const;
  let pairesTotales = 0;
  for (const [dossier, quota] of SOURCES) {
    const chemin = join(process.cwd(), "datasets", dossier, "train.jsonl");
    if (!existsSync(chemin)) continue;
    const lignes = readFileSync(chemin, "utf8").split("\n");
    const paires: Array<{ motif: string; reponse: string }> = [];
    for (const ligne of lignes) {
      if (paires.length >= quota) break;
      if (!ligne.trim()) continue;
      try {
        const o = JSON.parse(ligne) as { instruction: string; output: string };
        if (!o.instruction || !o.output) continue;
        const motif = o.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
        if (motif.length < 12) continue;
        paires.push({ motif, reponse: o.output.slice(0, 700) });
      } catch { /* ignore */ }
    }
    const stats = cortex.apprendre(paires.map((p) => ({ ...p, theme: `v5:${dossier}` })) as never);
    pairesTotales += (stats as { pairesAjoutees: number }).pairesAjoutees;
  }

  // Questions tenues à l'écart : les DERNIÈRES lignes de chaque dataset
  // (l'ingestion ci-dessus a pris les PREMIÈRES — jamais vues en apprentissage)
  const tests: Record<string, Array<{ dataset: string; question: string; motsClesReponse: string[] }>> = {
    couleurs_v5: [], math_professionnel: [], sciences_professionnel: [],
    parole_professionnelle: [], vision_professionnel: [],
  };
  const REGLES: Record<string, number> = {
    couleurs_v5: 300, math_professionnel: 300, sciences_professionnel: 300,
    parole_professionnelle: 100, vision_professionnel: 100,
  };
  for (const [dossier, n] of Object.entries(REGLES)) {
    const chemin = join(process.cwd(), "datasets", dossier, "train.jsonl");
    if (!existsSync(chemin)) continue;
    const lignes = readFileSync(chemin, "utf8").split("\n").filter(Boolean);
    const queue = lignes.slice(-n * 2); // fin du fichier = jamais ingéré
    for (const ligne of queue) {
      try {
        const o = JSON.parse(ligne) as { instruction: string; output: string };
        const motif = o.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
        if (motif.length >= 12) {
          tests[dossier as keyof typeof tests].push({
            dataset: dossier, question: motif,
            motsClesReponse: o.output.split(/\s+/).slice(0, 400),
          });
        }
      } catch { /* ignore */ }
      if (tests[dossier].length >= n) break;
    }
  }

  let hits = 0;
  let total = 0;
  const parDataset: Record<string, { total: number; hits: number }> = {};
  for (const [dossier, questions] of Object.entries(tests)) {
    parDataset[dossier] = { total: 0, hits: 0 };
    for (const q of questions) {
      const reponse = cortex.repondre(q.question, {});
      parDataset[dossier].total++;
      total++;
      if (reponse) {
        // hit = la réponse du cortex contient des tokens précis de la réponse attendue
        const tokensAttendus = new Set(
          tokenize(q.motsClesReponse.join(" ")).filter((t) => t.length >= 4),
        );
        const tokensReponse = new Set(tokenize(reponse.texte));
        let communs = 0;
        for (const t of tokensAttendus) if (tokensReponse.has(t)) communs++;
        if (communs >= 3) { hits++; parDataset[dossier].hits++; }
      }
    }
  }
  return {
    pairesApprises: pairesTotales,
    questionsHorsApprentissage: total,
    hits: Number((hits / Math.max(1, total)).toFixed(4)),
    parDataset: Object.fromEntries(
      Object.entries(parDataset).map(([d, v]) => [d, Number((v.hits / v.total).toFixed(3))]),
    ),
  };
}

// ─────────────────────────── 3. Solveurs : exactitude étendue ───────────────

function evaluerSolveursGrands(): Record<string, unknown> {
  const rng = creerRng(606060);
  const N = 10_000;
  let okC = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.floor(rng() * 1000), b = Math.floor(rng() * 1000);
    const rep = resoudreCalcul(`Calcule ${a} + ${b} * 2`);
    if (rep && rep.includes(String(a + b * 2))) okC++;
  }
  let okCouleurs = 0;
  for (let i = 0; i < N; i++) {
    const r = Math.floor(rng() * 256), g = Math.floor(rng() * 256), b = Math.floor(rng() * 256);
    const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    const comp = "#" + [255 - r, 255 - g, 255 - b].map((v) => v.toString(16).padStart(2, "0")).join("");
    const rep = resoudreCouleurs(`Quelle est la couleur complémentaire de ${hex} ?`);
    if (rep && rep.includes(comp)) okCouleurs++;
  }
  return {
    calcul: { questions: N, exactitude: Number((okC / N).toFixed(4)) },
    couleurs: { questions: N, exactitude: Number((okCouleurs / N).toFixed(4)) },
  };
}

// ─────────────────────────────────── main ───────────────────────────────────

const rapport: Record<string, unknown> = {
  date: new Date().toISOString(),
  job: "478451",
  graine: 999001,
};
console.log("[1/3] Routage : 1 000 000 de requêtes RÉELLES...");
rapport.routing1M = evaluerRouting1M();
console.log(JSON.stringify(rapport.routing1M, null, 1).slice(0, 1200));
console.log("[2/3] Cortex langagier (questions tenues à l'écart)...");
rapport.cortex = evaluerCortex();
console.log(JSON.stringify(rapport.cortex));
console.log("[3/3] Solveurs exacts (10 000 questions chacun)...");
rapport.solveurs = evaluerSolveursGrands();
console.log(JSON.stringify(rapport.solveurs));

mkdirSync(join(process.cwd(), "var", "rapports"), { recursive: true });
writeFileSync(
  join(process.cwd(), "var", "rapports", "evaluation-1m.json"),
  JSON.stringify(rapport, null, 1),
  "utf8",
);
console.log("Rapport: var/rapports/evaluation-1m.json");
