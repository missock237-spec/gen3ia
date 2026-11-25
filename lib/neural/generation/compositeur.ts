/**
 * COMPOSITEUR DE RÉPONSES NATIVES (LOT 3 — génération linguistique native,
 * mission « GEN3IA BRAIN COMPLETION »).
 *
 * Le cortex langagier existant répond par les paires APPRISES (verbatim du
 * corpus / paires personnalisées). Ce compositeur ajoute la capacité
 * MANQUANTE : générer des phrases NOUVELLES à partir des composants
 * connus — patrons grammaticaux français + faits de la mémoire — sans
 * AUCUNE API externe.
 *
 * Patrons par type de question (typage par l'analyseur sémantique, LOT 2) :
 * defini/explique → phrase de définition + développement ;
 * pourquoi → causalité honnête (« le fait X indique que... ») ;
 * comment → procédure séquencée (d'abord / ensuite / enfin) ;
 * liste → énumération numérotée ;
 * défaut → paragraphe assemblé avec connectives rotatives.
 *
 * HONNÊTETÉ : la provenance est explicite (genere: true, patron, faits
 * utilisés) — le consommateur sait si la réponse est verbatim (cortex) ou
 * composée (compositeur). Sans faits, le compositeur refuse (jamais
 * d'invention) : la génération native s'appuie UNIQUEMENT sur la mémoire.
 */

import { analyserSemantique } from "../semantique/analyseur-semantique";

/** Un fait exploitable (provenant de la mémoire vérifiée du cerveau). */
export interface FaitCompose {
  /** Clé du fait (propriété, concept source) — tracée dans le résultat. */
  cle: string;
  /** Valeur courte du fait (fragment à tisser — pas une phrase complète). */
  valeur: string;
}

/** Résultat d'une composition native. */
export interface ReponseComposee {
  texte: string;
  /** Le patron grammatical utilisé (traçabilité). */
  patron: "definition" | "causalite" | "procedure" | "enumeration" | "paragraphe";
  /** Les clés des faits réellement tissés dans la réponse. */
  faitsUtilises: string[];
  /** Toujours true ici — distingue du verbatim du cortex. */
  genere: true;
}

/** Nettoie un fragment de fait (ponctuation finale, longueur). */
function nettoyerFragment(f: string): string {
  return f.trim().replace(/[.!?]+$/u, "").slice(0, 220);
}

/** Majuscule initiale + ponctuation finale (grammaire minimale). */
function finaliserPhrase(s: string): string {
  const t = s.trim();
  const avecMaj = t.charAt(0).toUpperCase() + t.slice(1);
  return avecMaj.endsWith(".") || avecMaj.endsWith("?") || avecMaj.endsWith("!") ? avecMaj : `${avecMaj}.`;
}

/** Connectives rotatives (déterministes par index — pas d'aléatoire). */
const CONNECTIVES = ["De plus", "Par ailleurs", "En outre", "Également", "Ensuite"];

/** Compose une réponse NATIVE à partir des faits de la mémoire. */
export function composerReponseNative(entree: {
  question: string;
  concept: string;
  faits: readonly FaitCompose[];
  resume?: string;
}): ReponseComposee | null {
  const faits = entree.faits
    .map((f) => ({ ...f, valeur: nettoyerFragment(f.valeur) }))
    .filter((f) => f.valeur.length >= 3);
  if (faits.length === 0) return null; // sans faits : REFUS honnête (jamais inventer)

  const { question } = analyserSemantique(entree.question);
  const concept = entree.concept.trim() || "ce sujet";

  if ((question === "defini" || question === "explique") && entree.resume) {
    const resume = nettoyerFragment(entree.resume);
    const [f1, f2] = faits;
    let texte = finaliserPhrase(`« ${concept} » désigne ${resume.charAt(0).toLowerCase() + resume.slice(1)}`);
    if (f1) texte += ` ${finaliserPhrase(`Un point essentiel : ${f1.valeur}`)}`;
    if (f2) texte += ` ${finaliserPhrase(`À retenir également : ${f2.valeur}`)}`;
    return { texte, patron: "definition", faitsUtilises: faits.slice(0, 2).map((f) => f.cle), genere: true };
  }

  if (question === "pourquoi") {
    const [f1, f2] = faits;
    let texte = finaliserPhrase(`Concernant « ${concept} » : ${f1.valeur}`);
    texte += ` ${finaliserPhrase("C'est ce que les éléments en mémoire permettent d'établir")}`;
    if (f2) texte += ` ${finaliserPhrase(`Le fait suivant l'éclaire : ${f2.valeur}`)}`;
    return { texte, patron: "causalite", faitsUtilises: faits.slice(0, 2).map((f) => f.cle), genere: true };
  }

  if (question === "comment") {
    const etapes = faits.slice(0, 3);
    const marqueurs = ["d'abord", "ensuite", "enfin"];
    const corps = etapes
      .map((f, i) => `${marqueurs[Math.min(i, marqueurs.length - 1)]}, ${f.valeur}`)
      .join("; ");
    const texte = finaliserPhrase(`Voici la marche à suivre pour « ${concept} » : ${corps}`);
    return { texte, patron: "procedure", faitsUtilises: etapes.map((f) => f.cle), genere: true };
  }

  if (question === "liste") {
    const retenus = faits.slice(0, 5);
    const corps = retenus.map((f, i) => `${i + 1}) ${f.valeur}`).join(" ; ");
    const texte = finaliserPhrase(`Les éléments connus sur « ${concept} » : ${corps}`);
    return { texte, patron: "enumeration", faitsUtilises: retenus.map((f) => f.cle), genere: true };
  }

  // Défaut : paragraphe assemblé avec connectives rotatives.
  const retenus = faits.slice(0, 4);
  const corps = retenus
    .map((f, i) => (i === 0 ? f.valeur : `${CONNECTIVES[(i - 1) % CONNECTIVES.length]}, ${f.valeur}`))
    .join(". ");
  const texte = finaliserPhrase(`Sur « ${concept} », la mémoire du cerveau établit que ${corps}`);
  return { texte, patron: "paragraphe", faitsUtilises: retenus.map((f) => f.cle), genere: true };
}

/** Métrique du compositeur (pour le laboratoire, LOT 7). */
export function surfaceCompositeur(): { patrons: number; connectives: number } {
  return { patrons: 5, connectives: CONNECTIVES.length };
}
