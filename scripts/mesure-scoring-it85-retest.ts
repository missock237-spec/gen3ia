/**
 * Mesure locale du scoring du cortex langagier sur des questions
 * reformulées (non identiques aux paires du corpus).
 * Reproduit le nourrissage du runtime (CORPUS_GEN3 + vocation).
 */
import { CortexLangagierGen3 } from "../lib/neural/generation/language.js";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus.js";
import { CORPUS_QUESTIONS_VOCATION } from "../lib/gen3/corpus-questions.js";

const cortex = new CortexLangagierGen3();
const s1 = cortex.apprendre(CORPUS_GEN3);
const s2 = cortex.apprendre(
  CORPUS_QUESTIONS_VOCATION.map((p) => ({
    motif: p.question,
    reponse: p.reponse,
    theme: `vocation:${p.domaineId}`,
  })),
);
console.log(`corpus: ${s1.totalPaires} paires (+${s2.pairesAjoutees} vocation), vocab ${s1.vocabulaire}`);

const QUESTIONS = [
  ["deduction", "Tous les chats sont des félins. Mimo est un chat. Que peut-on conclure sur Mimo ? Et si je dis « tous les chats sont des félins, donc tous les félins sont des chats », est-ce valable ?"],
  ["theorie_esprit", "Léa range son jouet dans le tiroir bleu et sort jouer. Pendant son absence, sa mère le déplace dans le placard vert. Quand Léa rentre, où va-t-elle chercher son jouet, et pourquoi ?"],
  ["math_verbal", "Un vendeur achète 3 caisses de 24 oranges à 400 francs la caisse. Il vend chaque orange à 20 francs. Quel est son bénéfice ?"],
  ["spatial", "Je suis dans un couloir face au nord. Je tourne à droite, puis encore à droite, puis à gauche. Dans quelle direction est-ce que je regarde maintenant ?"],
  ["pragmatique", "Quelqu'un dit : « Bravo, tu as vraiment perfectionné ton talent pour arriver en retard. » Que veut dire cette personne réellement ?"],
  ["causalite", "Depuis qu'un nouveau barrage a été construit, les champs en aval sont plus verts mais les pêcheurs attrapent moins de poissons. Explique la chaîne de cause à effet."],
];

for (const [famille, q] of QUESTIONS) {
  const r = cortex.repondre(q);
  if (!r) {
    console.log(`[${famille}] → null (pont vocation prendra la main)`);
  } else {
    console.log(`[${famille}] score=${r.score} theme=${r.theme}`);
    console.log(`   → ${r.texte.slice(0, 140).replace(/\n/g, " ")}`);
  }
}

// Diagnostic : quels tokens d'une question tombent sur quels motifs ?
console.log("\n--- détection de familles (le relais après corpus null) ---");
import { detecterMethodeRaisonnement } from "../lib/gen3/familles-methodes.js";
for (const [famille, q] of QUESTIONS) {
  const d = detecterMethodeRaisonnement(q);
  console.log(`[${famille}] → ${d ? d.famille : "null"}`);
}
console.log("--- zéro faux positif attendu ---");
const BANALES = [
  "bonjour",
  "crée-moi une image de chat orange",
  "quel temps fait-il à Yaoundé ?",
  "que veux-tu dire ?",
  "pourquoi tu ne réponds pas ?",
  "génère une vidéo de kermesse scolaire",
  "combien de messages tu peux envoyer ?",
  "je vais apprendre le piano l'année prochaine",
  "raconte-moi une blague",
  "comment va la météo ce week-end ?",
];
for (const b of BANALES) {
  const d = detecterMethodeRaisonnement(b);
  console.log(`[${b.slice(0, 45)}] → ${d ? d.famille + " ✗ FAUX POSITIF" : "null ✓"}`);
}
console.log("--- familles détectées (questions types) ---");
const TYPES = [
  "Tous les chats sont des félins. Mimo est un chat. Que peut-on conclure ?",
  "Si je chauffe l'eau à 100 °C, alors elle bout. Or elle n'a pas bouilli. Qu'en déduis-tu ?",
  "On a observé trois fois le même phénomène. Peut-on généraliser ?",
  "Le chat gratte à la porte à 6 h. Quelle est la meilleure explication ?",
  "Son visage ressemble à celui de sa mère : quelle analogie ?",
  "Depuis le barrage, les champs sont verts mais les pêcheurs attrapent moins de poissons. Explique.",
  "Il neige rarement ici, tout le monde le sait : pourquoi ?",
  "Marie croit que son frère a pris le biscuit. Que pense-t-elle ?",
  "Comment organiser une kermesse en 5 étapes ?",
  "Un vendeur achète 3 caisses à 400 francs. Quel est son bénéfice ?",
  "Bravo, tu as encore oublié mes clés : que veut dire cette personne réellement ?",
  "Est-ce que je devrais mentir pour protéger un ami ?",
  "Je suis face au nord, je tourne à droite deux fois : quelle direction ?",
  "Mets ces événements dans l'ordre chronologique.",
  "Comment tu mémorises ce que je t'enseigne ?",
  "Je suis bloqué sur ce problème de maths, aide-moi à le résoudre.",
];
for (const t of TYPES) {
  const d = detecterMethodeRaisonnement(t);
  console.log(`[${t.slice(0, 50)}] → ${d ? d.famille : "null"}`);
}
