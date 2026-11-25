/**
 * LEXIQUE DE RELATIONS SÉMANTIQUES FRANÇAIS (LOT 2 — compréhension
 * sémantique générale, mission « GEN3IA BRAIN COMPLETION »).
 *
 * Connaissances linguistiques de base CURÉES À LA MAIN — standards du
 * français (synonymies canoniques, antonymies, hyperonymies, méronymies).
 * Aucune API externe, aucun corpus massif : un réseau borné, auditable,
 * chargeable instantanément (RAM 2 cœurs).
 *
 * HONNÊTETÉ (reprise de la convention du dépôt, cf. encodeur lexical) :
 * ce lexique capture des RELATIONS entre mots — il n'apprend pas le sens
 * profond par immersion statistique. La compréhension sémantique du
 * cerveau = encodage lexical (existant) + CE réseau de relations +
 * détection de négation/questions (analyseur-semantique.ts).
 */

/** Groupe de synonymes (les membres partagent un sens central). */
export const GROUPES_SYNONYMES: readonly (readonly string[])[] = [
  ["acheter", "acquerir", "obtenir", "procurer"],
  ["voiture", "automobile", "vehicule", "auto"],
  ["chat", "felis", "matou", "minet"],
  ["chien", "canide", "cabot"],
  ["dormir", "sommeiller", "reposer", "hiberner"],
  ["manger", "consommer", "alimenter", "nourrir"],
  ["rapide", "vite", "veloce", "prompt"],
  ["lent", "lentement", "traînant", "trainant"],
  ["grand", "immense", "vaste", "colossal"],
  ["petit", "minuscule", "reduit", "modeste"],
  ["beau", "joli", "elegante", "magnifique"],
  ["laid", "moche", "disgracieux"],
  ["content", "heureux", "ravi", "joyeux", "satisfait"],
  ["triste", "chagrin", "melancolique", "abattu"],
  ["peur", "crainte", "angoisse", "effroi", "terrifié", "terrifie"],
  ["colere", "fureur", "rage", "irritation", "enerve"],
  ["travail", "emploi", "metier", "profession", "ouvrage", "tache"],
  ["maison", "logis", "demeure", "habitation", "residence"],
  ["medecin", "docteur", "praticien", "generaliste"],
  ["malade", "maladie", "pathologie", "affection"],
  ["medicament", "remede", "traitement", "therapie"],
  ["ordinateur", "calculateur", "machine", "pc"],
  ["programme", "application", "logiciel", "appli"],
  ["internet", "web", "reseau", "toile"],
  ["donnee", "information", "renseignement", "info"],
  ["apprendre", "etudier", "instruire", "assimiler"],
  ["enseigner", "former", "instruire", "educquer", "eduquer"],
  ["ecole", "etablissement", "institution", "college", "lycee"],
  ["professeur", "enseignant", "formateur", "instituteur"],
  ["livre", "ouvrage", "volume", "ouvrage-litteraire"],
  ["ecrire", "rediger", "composer", "plumer"],
  ["lire", "consulte", "feuilleter", "parcourir"],
  ["commencer", "demarrer", "initier", "entamer", "debuter"],
  ["finir", "terminer", "achever", "conclure", "completer"],
  ["changer", "modifier", "transformer", "alterer", "adapter"],
  ["construire", "batir", "edifier", "eriger"],
  ["detruire", "demolir", "abattre", "ruiner"],
  ["voyager", "deplacer", "trajet", "se-deplacer", "periple"],
  ["guerre", "conflit", "hostilites", "combat"],
  ["paix", "armistice", "tranquillite", "quietude"],
  ["soleil", "etoile-solaire", "astre-solaire"],
  ["lune", "satellite-naturel", "astre-lunaire"],
  ["eau", "h2o", "liquide-vital", "liquide"],
  ["feu", "incendie", "flamme", "combustion"],
  ["air", "atmosphere", "vent", "souffle"],
  ["terre", "planete", "globe", "monde"],
  ["arbre", "vegetal", "essence-forestiere"],
  ["fleur", "corolle", "floraison", "blossom-fleur"],
  ["animal", "creature", "bestiole", "etre-vivant"],
  ["plante", "vegetal-plante", "flora"],
  ["energie", "puissance", "force", "courant"],
  ["science", "connaissance", "discipline", "savoir"],
  ["musique", "melodie", "son-musical", "chanson"],
  ["film", "movie", "cinema", "long-metrage"],
  ["jeu", "divertissement", "loisir", "occupation"],
  ["ami", "camarade", "compagnon", "pote"],
  ["famille", "parente", "famille-proche", "parents"],
  ["argent", "monnaie", "devise", "finance"],
  ["prix", "cout", "tarif", "montant"],
  ["ville", "cite", "agglomeration", "municipalite"],
  ["pays", "nation", "etat", "territoire"],
  ["route", "voie", "chemin", "axiome-routier", "artere"],
  ["manger-rapide", "grignoter", "nourrir-vite"],
  ["boire", "s'hydrater", "hydrater", "absorber-liquide"],
  ["couleur", "teinte", "nuance", "ton"],
  ["rouge", "carmin", "ecarlate", "vermillon"],
  ["bleu", "azur", "ceruleen", "cyan"],
  ["vert", "emeraude", "chlorophyle", "olive"],
  ["temps", "duree", "periode", "moment"],
  ["maladie-contagieuse", "epidemie", "pandemie", "infection"],
  ["ordinateur-portable", "laptop", "portable", "notebook"],
  ["intelligent", "malin", "subtil", "doue", "vif"],
  ["bete", "stupide", "idiot", "niais", "naif"],
  ["facile", "simple", "aise", "elementaire"],
  ["difficile", "complexe", "ardue", "laborieux"],
  ["important", "crucial", "capital", "essentiel", "majeur"],
  ["urgent", "prioritaire", "imperieux", "pressant"],
];

/** Paires d'antonymes (opposition de sens). */
export const PAIRES_ANTONYMES: readonly (readonly [string, string])[] = [
  ["grand", "petit"], ["rapide", "lent"], ["beau", "laid"],
  ["content", "triste"], ["chaud", "froid"], ["clair", "sombre"],
  ["jour", "nuit"], ["haut", "bas"], ["fort", "faible"],
  ["facile", "difficile"], ["plein", "vide"], ["debut", "fin"],
  ["guerre", "paix"], ["amour", "haine"],
  ["vie", "mort"], ["riche", "pauvre"], ["avant", "apres"],
  ["ouvrir", "fermer"], ["monter", "descendre"], ["gagner", "perdre"],
  ["acheter", "vendre"], ["accepter", "refuser"], ["vrai", "faux"],
  ["present", "absent"], ["proche", "loin"], ["epais", "fin"],
  ["sec", "mouille"], ["dur", "mou"], ["propre", "sale"],
  ["intelligent", "bete"], ["important", "negligeable"], ["urgent", "differable"],
];

/** Paires d'hyperonymie : [instance, catégorie] — « X est un Y ». */
export const PAIRES_HYPERONYMES: readonly (readonly [string, string])[] = [
  ["chat", "animal"], ["chien", "animal"], ["oiseau", "animal"],
  ["poisson", "animal"], ["lion", "animal"], ["chat", "felide"],
  ["felide", "animal"], ["canide", "animal"],
  ["rose", "fleur"], ["tulipe", "fleur"], ["chene", "arbre"],
  ["sapin", "arbre"], ["voiture", "vehicule"], ["camion", "vehicule"],
  ["velo", "vehicule"], ["avion", "vehicule"], ["bateau", "vehicule"],
  ["maison", "batiment"], ["ecole", "batiment"], ["hopital", "batiment"],
  ["ordinateur", "machine"], ["robot", "machine"],
  ["rouge", "couleur"], ["bleu", "couleur"], ["vert", "couleur"],
  ["jaune", "couleur"], ["amour", "emotion"], ["peur", "emotion"],
  ["joie", "emotion"], ["colere", "emotion"],
  ["france", "pays"], ["italie", "pays"], ["japon", "pays"],
  ["paris", "ville"], ["lyon", "ville"], ["tokyo", "ville"],
  ["mathematiques", "science"], ["physique", "science"], ["chimie", "science"],
  ["biologie", "science"], ["informatique", "science"],
  ["medecin", "profession"], ["professeur", "profession"], ["avocat", "profession"],
  ["eau", "liquide"], ["lait", "liquide"], ["huile", "liquide"],
];

/** Paires de méronymie : [partie, tout] — « X fait partie de Y ». */
export const PAIRES_MERONYMES: readonly (readonly [string, string])[] = [
  ["roue", "voiture"], ["moteur", "voiture"], ["porte", "maison"],
  ["toit", "maison"], ["fenetre", "maison"], ["piston", "moteur"],
  ["clavier", "ordinateur"], ["ecran", "ordinateur"], ["processeur", "ordinateur"],
  ["memoire", "ordinateur"], ["disque", "ordinateur"],
  ["petales", "fleur"], ["tige", "fleur"], ["racine", "arbre"],
  ["branche", "arbre"], ["feuille", "arbre"], ["tronc", "arbre"],
  ["aile", "oiseau"], ["bec", "oiseau"], ["plume", "oiseau"],
  ["main", "corps"], ["pied", "corps"], ["tete", "corps"], ["coeur", "corps"],
  ["chapitre", "livre"], ["page", "livre"], ["couverture", "livre"],
  ["pied", "meuble"], ["planche", "meuble"],
];

/** Index de recherche construit une fois (RAM bornée). */
export interface IndexSemantique {
  /** mot racine → indices de groupes de synonymes. */
  synonymesParMot: Map<string, number[]>;
  /** mot racine → mot racine antonyme (un ou plusieurs). */
  antonymes: Map<string, Set<string>>;
  /** mot racine → catégorie (hyperonymes). */
  categories: Map<string, Set<string>>;
  /** catégorie → instances (inverse des hyperonymes). */
  instances: Map<string, Set<string>>;
  /** partie → tout (méronymes). */
  parties: Map<string, Set<string>>;
  /** tout → parties. */
  toutDe: Map<string, Set<string>>;
}

/** Construit l'index (racines via racineLegere — cohérence avec le cortex). */
export function construireIndexSemantique(racine: (m: string) => string): IndexSemantique {
  const synonymesParMot = new Map<string, number[]>();
  GROUPES_SYNONYMES.forEach((groupe, i) => {
    for (const mot of groupe) {
      const r = racine(mot);
      const liste = synonymesParMot.get(r) ?? [];
      liste.push(i);
      synonymesParMot.set(r, liste);
    }
  });
  const antonymes = new Map<string, Set<string>>();
  for (const [a, b] of PAIRES_ANTONYMES) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const rx = racine(x);
      const ens = antonymes.get(rx) ?? new Set<string>();
      ens.add(racine(y));
      antonymes.set(rx, ens);
    }
  }
  const categories = new Map<string, Set<string>>();
  const instances = new Map<string, Set<string>>();
  for (const [inst, cat] of PAIRES_HYPERONYMES) {
    const ri = racine(inst);
    const rc = racine(cat);
    (categories.get(ri) ?? categories.set(ri, new Set()).get(ri)!).add(rc);
    (instances.get(rc) ?? instances.set(rc, new Set()).get(rc)!).add(ri);
  }
  const parties = new Map<string, Set<string>>();
  const toutDe = new Map<string, Set<string>>();
  for (const [partie, tout] of PAIRES_MERONYMES) {
    const rp = racine(partie);
    const rt = racine(tout);
    (parties.get(rp) ?? parties.set(rp, new Set()).get(rp)!).add(rt);
    (toutDe.get(rt) ?? toutDe.set(rt, new Set()).get(rt)!).add(rp);
  }
  return { synonymesParMot, antonymes, categories, instances, parties, toutDe };
}

/** Taille du lexique (métrique honnête pour le laboratoire). */
export function tailleLexique(): { synonymes: number; antonymes: number; hyperonymes: number; meronymes: number } {
  return {
    synonymes: GROUPES_SYNONYMES.length,
    antonymes: PAIRES_ANTONYMES.length,
    hyperonymes: PAIRES_HYPERONYMES.length,
    meronymes: PAIRES_MERONYMES.length,
  };
}
