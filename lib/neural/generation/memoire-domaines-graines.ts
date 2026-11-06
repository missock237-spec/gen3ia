/**
 * GRAINES SYNTHÉTIQUES DE LA MÉMOIRE DE DOMAINES (générées par
 * scripts/genere-memoire-domaines-it113.ts — 2026-11-06T16:48:15.509Z).
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

export const FAMILLES_SYNTHESE: Readonly<Record<string, readonly FamilleSynthetique[]>> = {
  // math — capacité texte : 5 familles calculées
  "math|texte": [
  {
    nom: "priorites-operatoires",
    generer: (rotation,param)=>{const r=PRNG(rotation*7919^param);const a=ENTRE(r,11,99),b=ENTRE(r,11,99),c=ENTRE(r,11,99),d=ENTRE(r,11,99);const res=a*b+c*d;return{question:`Calcule en respectant les priorit\xE9s op\xE9ratoires. ${a} \xD7 ${b} + ${c} \xD7 ${d}`,reponse:`${res} \u2014 on calcule dans l'ordre : ${a} \xD7 ${b} = ${a*b}, ${c} \xD7 ${d} = ${c*d}, puis la somme ${a*b} + ${c*d} = ${res}.`}},
  },
  {
    nom: "aire-triangle",
    generer: (rotation,param)=>{const r=PRNG(rotation*104729^param);const base=ENTRE(r,4,60)*2,haut=ENTRE(r,3,50)*2;const aire=base*haut/2;return{question:`Applique la formule et donne le r\xE9sultat avec son unit\xE9. Triangle : base ${base} cm, hauteur ${haut} cm. Aire ?`,reponse:`Aire = base \xD7 hauteur \xF7 2 = ${base} \xD7 ${haut} \xF7 2 = ${aire.toLocaleString("fr-FR")} cm\xB2.`}},
  },
  {
    nom: "pourcentage",
    generer: (rotation,param)=>{const r=PRNG(rotation*15485863^param);const p=[10,20,25,40,50,75][ENTRE(r,0,5)];const n=ENTRE(r,200,2e4);const res=p/100*n;return{question:`Solve and show the computation in one line. Compute ${p}% of ${n.toLocaleString("en-US")} francs.`,reponse:`${p}% of ${n.toLocaleString("en-US")} francs = ${p} \xF7 100 \xD7 ${n.toLocaleString("en-US")} = ${res.toLocaleString("en-US")} francs.`}},
  },
  {
    nom: "d-v-t",
    generer: (rotation,param)=>{const r=PRNG(rotation*2654435761^param);const v=[60,80,90,120][ENTRE(r,0,3)];const t=ENTRE(r,2,12);const d=v*t;return{question:`Applique la formule d = v \xD7 t avec les unit\xE9s. Un trajet de ${d.toLocaleString("fr-FR")} km \xE0 ${v} km/h. Dur\xE9e ?`,reponse:`t = d \xF7 v = ${d.toLocaleString("fr-FR")} \xF7 ${v} = ${t} h.`}},
  },
  {
    nom: "prix-unitaire",
    generer: (rotation,param)=>{const r=PRNG(rotation*40503^param);const q=2,unit=ENTRE(r,100,9999);const n=ENTRE(r,5,30);const total2=unit*q;return{question:`Go through the unit price then multiply. ${q} e-scooters cost ${total2.toLocaleString("en-US")} francs. Price for ${n}?`,reponse:`Unit price = ${total2} \xF7 ${q} = ${unit.toLocaleString("en-US")} francs; for ${n}: ${unit} \xD7 ${n} = ${(unit*n).toLocaleString("en-US")} francs.`}},
  },
  ],
  // problem_solving — capacité texte : 4 familles calculées
  "problem_solving|texte": [
  {
    nom: "conversion-longueur",
    generer: (rotation,param)=>{const r=PRNG(rotation*65537^param);const m=ENTRE(r,2,900);return{question:`Convertis en \xE9tapes claires. ${m.toLocaleString("fr-FR")} m\xE8tres en centim\xE8tres ?`,reponse:`1 m = 100 cm \u2192 ${m.toLocaleString("fr-FR")} m = ${m} \xD7 100 = ${(m*100).toLocaleString("fr-FR")} cm.`}},
  },
  {
    nom: "partage-equitable",
    generer: (rotation,param)=>{const r=PRNG(rotation*32452843^param);const k=ENTRE(r,2,9);const par=ENTRE(r,3,40);const n=k*par;return{question:`Partage \xE9quitable : ${n.toLocaleString("fr-FR")} objets r\xE9partis entre ${k} personnes. Combien chacun ?`,reponse:`${n.toLocaleString("fr-FR")} \xF7 ${k} = ${par} objets par personne (v\xE9rification : ${par} \xD7 ${k} = ${n.toLocaleString("fr-FR")}).`}},
  },
  {
    nom: "minutes-heures",
    generer: (rotation,param)=>{const r=PRNG(rotation*49979687^param);const h=ENTRE(r,1,9);const min=[15,30,45][ENTRE(r,0,2)];const total=h*60+min;return{question:`Conversion de dur\xE9e : ${total} minutes en heures et minutes ?`,reponse:`${total} min = ${h} h + ${min} min (car ${h} \xD7 60 = ${h*60}, reste ${min}).`}},
  },
  {
    nom: "litres-millilitres",
    generer: (rotation,param)=>{const r=PRNG(rotation*15484163^param);const l=ENTRE(r,1,25);return{question:`Convertis. ${l} litres en millilitres ?`,reponse:`1 L = 1 000 mL \u2192 ${l} L = ${l} \xD7 1 000 = ${(l*1e3).toLocaleString("fr-FR")} mL.`}},
  },
  ],
  // sciences — capacité texte : 4 familles calculées
  "sciences|texte": [
  {
    nom: "volume-cuboide",
    generer: (rotation,param)=>{const r=PRNG(rotation*2251^param);const L=ENTRE(r,2,40),l=ENTRE(r,2,40),h=ENTRE(r,2,40);return{question:`Formule de g\xE9om\xE9trie (sciences physiques) : volume d'un pav\xE9 droit de dimensions ${L} cm \xD7 ${l} cm \xD7 ${h} cm ?`,reponse:`V = L \xD7 l \xD7 h = ${L} \xD7 ${l} \xD7 ${h} = ${(L*l*h).toLocaleString("fr-FR")} cm\xB3.`}},
  },
  {
    nom: "vitesse-moyenne",
    generer: (rotation,param)=>{const r=PRNG(rotation*3301^param);const v=ENTRE(r,2,20);const t=ENTRE(r,2,12);const d=v*t;return{question:`Vitesse moyenne : un objet parcourt ${d} km en ${t} h. Sa vitesse ?`,reponse:`v = d \xF7 t = ${d} \xF7 ${t} = ${v} km/h (formule v = d/t).`}},
  },
  {
    nom: "masse-volumique",
    generer: (rotation,param)=>{const r=PRNG(rotation*4421^param);const v=ENTRE(r,2,25);const rho=ENTRE(r,2,19);const m=v*rho;return{question:`Masse volumique : un corps de volume ${v} cm\xB3 p\xE8se ${m} g. Sa masse volumique ?`,reponse:`\u03C1 = m \xF7 V = ${m} \xF7 ${v} = ${rho} g/cm\xB3 (formule \u03C1 = m/V).`}},
  },
  {
    nom: "energie-puissance",
    generer: (rotation,param)=>{const r=PRNG(rotation*5501^param);const p=ENTRE(r,10,200)*5;const t=ENTRE(r,1,10);return{question:`\xC9nergie \xE9lectrique : un appareil de ${p} W fonctionne pendant ${t} heures. \xC9nergie consomm\xE9e ?`,reponse:`E = P \xD7 t = ${p} \xD7 ${t} = ${(p*t).toLocaleString("fr-FR")} Wh = ${(p*t/1e3).toLocaleString("fr-FR")} kWh.`}},
  },
  ],
  // reasoning — capacité texte : 4 familles calculées
  "reasoning|texte": [
  {
    nom: "suite-arithmetique",
    generer: (rotation,param)=>{const r=PRNG(rotation*6047^param);const u0=ENTRE(r,1,30),pas=ENTRE(r,2,12);const termes=[u0,u0+pas,u0+2*pas,u0+3*pas];return{question:`Logique de suite : ${termes.join(", ")} \u2014 quel est le terme suivant ?`,reponse:`Raison +${pas} : ${termes[3]} + ${pas} = ${u0+4*pas} (chaque terme avance de ${pas}).`}},
  },
  {
    nom: "suite-geometrique",
    generer: (rotation,param)=>{const r=PRNG(rotation*7507^param);const u0=ENTRE(r,1,5),q=ENTRE(r,2,4);const t=[u0,u0*q,u0*q*q,u0*q*q*q];return{question:`Logique de suite : ${t.join(", ")} \u2014 quel est le terme suivant ?`,reponse:`Raison \xD7${q} : ${t[3]} \xD7 ${q} = ${u0*q**4} (chaque terme est multipli\xE9 par ${q}).`}},
  },
  {
    nom: "boeufs-boites",
    generer: (rotation,param)=>{const r=PRNG(rotation*8737^param);const n=ENTRE(r,6,24),b=ENTRE(r,2,9),o=ENTRE(r,0,5);return{question:`Si chaque bo\xEEte contient ${n} \u0153ufs, combien d'\u0153ufs dans ${b} bo\xEEtes pleines plus ${o} \u0153ufs \xE0 part ?`,reponse:`${n} \xD7 ${b} + ${o} = ${(n*b+o).toLocaleString("fr-FR")} \u0153ufs (on multiplie puis on ajoute).`}},
  },
  {
    nom: "comparaison",
    generer: (rotation,param)=>{const r=PRNG(rotation*9721^param);const a=ENTRE(r,100,9999),b=ENTRE(r,100,9999);const max=Math.max(a,b);return{question:`Lequel est le plus grand : ${a} ou ${b} ?`,reponse:`${max} est le plus grand (comparaison chiffre par chiffre : ${max} > ${Math.min(a,b)}).`}},
  },
  ],
  // code_v4 — capacité code : 4 familles calculées
  "code_v4|code": [
  {
    nom: "precedence-js",
    generer: (rotation,param)=>{const r=PRNG(rotation*10273^param);const a=ENTRE(r,2,40),b=ENTRE(r,2,20),c=ENTRE(r,2,15);return{question:`Que vaut l'expression JavaScript : ${a} + ${b} * ${c} ?`,reponse:`${a+b*c} \u2014 la multiplication est prioritaire : ${b} * ${c} = ${b*c}, puis ${a} + ${b*c} = ${a+b*c}.`}},
  },
  {
    nom: "modulo-js",
    generer: (rotation,param)=>{const r=PRNG(rotation*11807^param);const a=ENTRE(r,20,500),b=ENTRE(r,3,12);return{question:`Que renvoie l'expression JavaScript : ${a} % ${b} ?`,reponse:`${a%b} \u2014 le modulo est le reste de la division euclidienne ${a} \xF7 ${b} (quotient ${Math.floor(a/b)}, reste ${a%b}).`}},
  },
  {
    nom: "division-entiere-js",
    generer: (rotation,param)=>{const r=PRNG(rotation*12953^param);const b=ENTRE(r,3,15),q=ENTRE(r,2,40);const a=b*q+ENTRE(r,0,b-1);return{question:`Que vaut Math.floor(${a} / ${b}) en JavaScript ?`,reponse:`${Math.floor(a/b)} \u2014 Math.floor tronque \xE0 l'entier inf\xE9rieur : ${a} \xF7 ${b} = ${(a/b).toFixed(2)} \u2192 ${Math.floor(a/b)}.`}},
  },
  {
    nom: "egalite-js",
    generer: (rotation,param)=>{const r=PRNG(rotation*13997^param);const a=ENTRE(r,1,50);const egal=r()<.5;const b=egal?a:a+ENTRE(r,1,20);return{question:`Que vaut l'expression JavaScript : ${a} === ${b} ?`,reponse:`${String(a===b)} \u2014 l'op\xE9rateur === compare valeurs ET types ; ici ${a} et ${b} ${a===b?"sont":"ne sont pas"} \xE9gaux.`}},
  },
  ],
  // databases — capacité texte : 3 familles calculées
  "databases|texte": [
  {
    nom: "table-compte",
    generer: (rotation,param)=>{const r=PRNG(rotation*15307^param);const lignes=Array.from({length:8},()=>({q:ENTRE(r,1,50)}));const seuil=ENTRE(r,10,40);const n=lignes.filter(l=>l.q>seuil).length;return{question:`Table commandes : 8 lignes avec quantit\xE9s ${lignes.map(l=>l.q).join(", ")}. Requ\xEAte : SELECT COUNT(*) FROM commandes WHERE quantite > ${seuil} ?`,reponse:`${n} \u2014 les lignes de quantit\xE9 > ${seuil} sont : ${lignes.map(l=>l.q).filter(q=>q>seuil).join(", ")||"aucune"}.`}},
  },
  {
    nom: "table-somme",
    generer: (rotation,param)=>{const r=PRNG(rotation*16253^param);const lignes=Array.from({length:8},()=>({p:ENTRE(r,5,200)}));const somme=lignes.reduce((s,l)=>s+l.p,0);return{question:`Table produits : prix ${lignes.map(l=>l.p).join(", ")}. Requ\xEAte : SELECT SUM(prix) FROM produits ?`,reponse:`${somme.toLocaleString("fr-FR")} \u2014 somme des 8 prix : ${lignes.join(" + ")} = ${somme.toLocaleString("fr-FR")}.`}},
  },
  {
    nom: "table-max",
    generer: (rotation,param)=>{const r=PRNG(rotation*17389^param);const lignes=Array.from({length:8},()=>({q:ENTRE(r,1,99)}));const max=Math.max(...lignes.map(l=>l.q));return{question:`Table stock : quantit\xE9s ${lignes.map(l=>l.q).join(", ")}. Requ\xEAte : SELECT MAX(quantite) FROM stock ?`,reponse:`${max} \u2014 MAX parcourt la colonne et garde la plus grande valeur : ${lignes.map(l=>l.q).sort((x,y)=>y-x)[0]}.`}},
  },
  ],
};

export const NB_FAMILLES_SYNTHESE = Object.values(FAMILLES_SYNTHESE).reduce(
  (s, fams) => s + fams.length,
  0,
);
