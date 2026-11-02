/** Debug : pourquoi la paire « 20 % de 5,238 francs » répond-elle à « Calcule 47 + 38 » ? */
import { tokenize } from "../lib/neural/encoding/text-encoder.js";
import { racineLegere } from "../lib/neural/generation/language.js";
import { CortexLangagierGen3 } from "../lib/neural/generation/language.js";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus.js";

const requete = "Calcule 47 + 38 en montrant chaque étape du calcul.";
const tokens = [...new Set(tokenize(requete))];
console.log("tokens bruts:", tokens);
console.log("racinisés:", tokens.map(racineLegere));

// retrouver la paire
const paire = CORPUS_GEN3.find((p) => p.reponse.includes("1047.6") || p.motif.includes("5,238"));
if (paire) {
  console.log("\nMOTIF:", paire.motif);
  const pTokens = [...new Set(tokenize(paire.motif).map(racineLegere))];
  console.log("tokens paire racinisés:", pTokens);
  const stop = new Set(["le","la","les","un","une","des","de","du","et","ou","au","aux","ce","cet","cette","ces","ne","pas","plus","pour","par","avec","dans","sur","en","y","a","se","sa","son","ses","leur","leurs","nous","vous","je","me","te","ils","elles","on","mais","comme","tout","tous","toute","toutes","bien","peut","veux","vais","va","fait","fais","est","sont"]);
  const pInf = pTokens.filter((t) => !stop.has(t) && !/^\d+([.,]\d+)?$/.test(t));
  console.log("tokens paire informatifs non num:", pInf);
  const rInf = [...new Set(tokens.map(racineLegere))].filter((t) => !stop.has(t));
  console.log("actifs non num:", rInf.filter((t) => !/^\d+([.,]\d+)?$/.test(t)));
  const partages = pInf.filter((t) => rInf.includes(t));
  console.log("PARTAGÉS:", partages);
}

const cortex = new CortexLangagierGen3();
cortex.apprendre(CORPUS_GEN3);
const r = cortex.repondre(requete);
console.log("\nréponse:", r ? `${r.score} ${r.cle}` : "null");
