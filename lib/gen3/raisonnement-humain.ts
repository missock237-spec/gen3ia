/**
 * GÉNÉRATEUR DE RAISONNEMENT HUMAIN (it.85 — demande propriétaire :
 * « apprendre à gen3 à raisonner comme un humain, 1 million de datasets
 * PP, mis comme code source, script d'entraînement dans le sandbox,
 * mémorisation vérifiée, test depuis le navigateur »).
 *
 * PP = PAIRE PROMPT-PENSÉE : chaque exemple porte
 *   - un PROMPT (la question ou la situation, telle qu'un humain la pose) ;
 *   - une PENSÉE (le raisonnement pas à pas, explicite — ce qu'un humain
 *     se dit intérieurement : prémisse, vérification, doute, contrôle) ;
 *   - une RÉPONSE (la conclusion, formulée simplement).
 *
 * Seize familles de raisonnement couvrent la cognition humaine courante :
 * déduction, conditionnel (modus ponens / tollens), induction, abduction,
 * analogie, causalité, sens commun, théorie de l'esprit, planification,
 * mathématique verbale, pragmatique (implicite, ironie), éthique pratique,
 * spatial, temporel, métacognition et résolution de problème.
 *
 * Génération DÉTERMINISTE et INJECTIVE : chaque index produit exactement
 * une paire (décodage en radix mixte, aucune répétition possible par
 * construction), le même index produit toujours la même paire —
 * l'entraînement est reproductible et le volume est réel, mesuré, sans
 * chiffre fantôme.
 *
 * Module PUR — aucune dépendance Node, aucune I/O.
 */

/** Les seize familles de raisonnement humain. */
export type FamilleRaisonnement =
  | "deduction"
  | "conditionnel"
  | "induction"
  | "abduction"
  | "analogie"
  | "causalite"
  | "sens_commun"
  | "theorie_esprit"
  | "planification"
  | "math_verbal"
  | "pragmatique"
  | "ethique_pratique"
  | "spatial"
  | "temporel"
  | "metacognition"
  | "resolution_probleme";

export const FAMILLES_RAISONNEMENT: readonly FamilleRaisonnement[] = [
  "deduction",
  "conditionnel",
  "induction",
  "abduction",
  "analogie",
  "causalite",
  "sens_commun",
  "theorie_esprit",
  "planification",
  "math_verbal",
  "pragmatique",
  "ethique_pratique",
  "spatial",
  "temporel",
  "metacognition",
  "resolution_probleme",
];

/** Une paire Prompt-Pensée (le « dataset PP » demandé). */
export interface PairePP {
  famille: FamilleRaisonnement;
  /** La question / situation posée (le Prompt). */
  prompt: string;
  /** Les étapes de raisonnement explicites (la Pensée humaine). */
  pensee: string[];
  /** La conclusion (la Réponse). */
  reponse: string;
}

// ─── Vocabulaires partagés ──────────────────────────────────────────────────

/** Prénoms courants (72) — serveurs des puzzles sociaux. */
export const NOMS: readonly string[] = [
  "Alice", "Bernard", "Camille", "David", "Élise", "Farid", "Grace", "Hugo",
  "Inès", "Jonas", "Karim", "Laura", "Malik", "Nina", "Oscar", "Pauline",
  "Quentin", "Rosa", "Samuel", "Tara", "Ugo", "Valérie", "William", "Xenia",
  "Yasmine", "Zoé", "Adrien", "Brigitte", "Cédric", "Delphine", "Émile",
  "Fatou", "Gaspard", "Hélène", "Ibrahim", "Juliette", "Kevin", "Lucie",
  "Marco", "Nadia", "Olivier", "Patricia", "Rémi", "Sofia", "Thomas",
  "Ursule", "Vincent", "Wendy", "Xavier", "Yann", "Amélie", "Bruno",
  "Chloé", "Damien", "Elsa", "Félix", "Géraldine", "Hakim", "Irène",
  "Jules", "Léa", "Mathieu", "Noémie", "Pierre", "Rania", "Simon", "Théo",
  "Véronique", "Yanis", "Zara", "Anouk", "Bastien",
];

/** Paires de catégories réellement vraies (catA ⊂ catB) pour les
 *  syllogismes — 48, vérifiées une à une. */
const CATEGORIES: readonly [string, string][] = [
  ["oiseaux", "animaux"], ["roses", "fleurs"], ["saumons", "poissons"],
  ["chênes", "arbres"], ["violons", "instruments de musique"],
  ["romans", "livres"], ["carrés", "quadrilatères"], ["baleines", "mammifères"],
  ["mangues", "fruits"], ["carottes", "légumes"], ["pianistes", "musiciens"],
  ["chirurgiens", "médecins"], ["romanciers", "écrivains"],
  ["moineaux", "oiseaux"], ["bicyclettes", "véhicules"],
  ["fourmis", "insectes"], ["dauphins", "mammifères"],
  ["ordinateurs portables", "ordinateurs"], ["sonnets", "poèmes"],
  ["tornades", "tempêtes"], ["cuivres", "instruments de musique"],
  ["pyramides", "monuments"], ["fromages", "produits laitiers"],
  ["cactus", "plantes"], ["pingouins", "oiseaux"],
  ["tragédies", "pièces de théâtre"], ["chaises", "meubles"],
  ["médecins", "professionnels de santé"], ["chiens", "animaux domestiques"],
  ["voiliers", "bateaux"], ["coléoptères", "insectes"],
  ["satellites", "objets en orbite"], ["glaciers", "masses de glace"],
  ["percussionnistes", "musiciens"], ["moustiques", "insectes"],
  ["serments", "promesses"], ["bouleaux", "arbres"],
  ["maladresses", "erreurs"], ["éclairs", "phénomènes électriques"],
  ["coccinelles", "insectes"], ["épinards", "légumes"],
  ["avocats", "juristes"], ["marteaux", "outils"],
  ["naissances", "événements"], ["ouragans", "tempêtes"],
  ["lutins", "créatures imaginaires"], ["harpes", "instruments de musique"],
  ["diplômes", "certificats"],
];

/** Règles « si … alors … » réelles de la vie quotidienne (48). */
const REGLES: readonly [string, string][] = [
  ["on chauffe de l'eau à 100 °C", "elle se met à bouillir"],
  ["une plante reste des semaines sans eau", "elle fane"],
  ["on laisse une bougie allumée dans un courant d'air", "elle vacille"],
  ["le ciel se couvre de nuages noirs", "un orage menace"],
  ["on ne retient pas un ballon gonflé", "il siffle en se dégonflant"],
  ["un courant d'air traverse la pièce", "les papiers s'envolent"],
  ["on sale généreusement un chemin verglacé", "la glace fond plus vite"],
  ["une ampoule grille", "la pièce s'assombrit"],
  ["on appuie sur l'interrupteur", "la lampe s'allume"],
  ["le réveil n'a pas été armé", "personne ne se lève à l'heure"],
  ["on congèle des fraises", "elles deviennent molles en dégelant"],
  ["un pneu est sous-gonflé", "la voiture consomme plus"],
  ["on oublie le pain dans le grille-pain", "il brûle"],
  ["l'ascenseur est en panne", "il faut prendre l'escalier"],
  ["on arrose une plante le soir en été", "l'eau s'évapore moins vite"],
  ["un moteur manque d'huile", "il s'use prématurément"],
  ["on ne chiffre pas un mot de passe", "il peut être lu par d'autres"],
  ["une facture n'est pas payée à l'échéance", "des pénalités s'appliquent"],
  ["on mélange du bleu et du jaune", "on obtient du vert"],
  ["le fil est coupé", "la lampe ne peut plus s'allumer"],
  ["on pose une casserole froide sur une plaque chaude", "un choc thermique est possible"],
  ["un contrat est signé par les deux parties", "il les engage"],
  ["on laisse la fenêtre ouverte sous la pluie", "le sol se mouille"],
  ["une pièce de théâtre plaît au public", "les applaudissements fusent"],
  ["on retire la glace du congélateur un après-midi d'été", "elle fond"],
  ["un élève révise régulièrement", "il progresse plus sûrement"],
  ["on sème au bon moment", "la récolte est meilleure"],
  ["le moteur n'a plus de carburant", "il s'arrête"],
  ["l'air est pur en forêt", "les balades en forêt ressourcent"],
  ["une clôture a une brèche", "les animaux peuvent s'échapper"],
  ["on tape sur un clavier sale", "les touches peuvent coincer"],
  ["une lettre n'a pas de timbre", "elle n'est pas acheminée"],
  ["on range ses outils après usage", "on les retrouve plus vite"],
  ["la marée descend beaucoup", "des bancs de sable apparaissent"],
  ["on débranche l'appareil", "il cesse de consommer de l'électricité"],
  ["un fichier n'est pas sauvegardé", "il peut être perdu en cas de panne"],
  ["on laisse du lait au soleil", "il tourne plus vite"],
  ["un billet de train n'est pas validé", "il peut être considéré comme absent"],
  ["on double la quantité de sel d'une recette", "le plat devient trop salé"],
  ["un pont est fermé pour travaux", "les automobilistes doivent détourner"],
  ["on ne protège pas ses oreilles au concert", "elles sifflent temporairement"],
  ["la batterie est vide", "le téléphone s'éteint"],
  ["on mouille une allumette", "elle ne s'allume plus"],
  ["un store est baissé", "la lumière du jour est atténuée"],
  ["on appuie trop fort sur un crayon", "la mine casse"],
  ["une étagère est surchargée", "elle peut se fissurer"],
  ["on tient un livre ouvert sans le tenir par la couverture", "les pages peuvent se refermer"],
  ["le brouillard tombe sur la route", "la visibilité diminue"],
];

/** Séries d'observations pour l'induction (36) : [observé, généralisation
 *  prudente, domaine]. */
const INDUCTIONS: readonly [string, string, string][] = [
  ["le soleil s'est levé à l'est chaque matin de la semaine", "demain encore, il se lèvera à l'est", "astronomie quotidienne"],
  ["chaque fois qu'elle a mangé des fraises, Laura a eu des boutons", "les fraises pourraient ne pas lui convenir", "santé courante"],
  ["toutes les fois qu'on a appuyé sur ce bouton, la lumière s'est allumée", "le bouton commande la lumière", "technique"],
  ["les trois derniers hivers, le lac a gelé en janvier", "cette année encore, il gèlera vers janvier", "climat local"],
  ["chaque livre lu de cet auteur m'a passionné", "le prochain livre de cet auteur me plaira probablement", "goûts personnels"],
  ["à chaque match, quand l'équipe marque tôt, elle gagne", "marquer tôt augmente ses chances de victoire", "sport"],
  ["toutes les pommes cueillies dans ce verger étaient sucrées", "les pommes de ce verger sont sucrées", "agriculture"],
  ["chaque fois que j'ai prêté mon vélo à Marco, il l'a rendu propre", "Marco prend soin du matériel prêté", "confiance"],
  ["les trains de cette ligne sont arrivés à l'heure cinq jours de suite", "le train de demain arrivera probablement à l'heure", "transports"],
  ["chaque fois qu'on chauffe ce verre au four, il éclate", "ce verre ne supporte pas la chaleur du four", "matériaux"],
  ["toutes les questions de ce chapitre portaient sur les fractions", "le contrôle portera sûrement sur les fractions", "études"],
  ["chaque été, le marché du village déménage place de l'église", "cet été encore, il sera place de l'église", "traditions locales"],
  ["toutes les fois qu'il a oublié son parapluie, il a plu", "les jours sans parapluie semblent attirer la pluie", "coïncidences"],
  ["les cinq plantes du salon poussent mieux près de la fenêtre", "ces plantes aiment la lumière", "jardinage"],
  ["chaque appel de ce numéro m'a proposé un abonnement", "ce numéro propose probablement encore un abonnement", "téléphone"],
  ["toutes les chansons de cet album sont rapides", "l'album entier a un tempo élevé", "musique"],
  ["chaque fois que la serre est fermée au soleil, la température monte", "une serre fermée au soleil devient très chaude", "physique"],
  ["tous les clients de ce quartier paient à la fin du mois", "le prochain client du quartier paiera sans doute à ce moment", "commerce"],
  ["chaque fois que je note mes courses, je dépense moins", "tenir une liste limite les dépenses", "vie pratique"],
  ["tous les voisins qui ont taillé leur haie en automne ont eu une belle repousse", "tailler en automne favorise la repousse", "jardinage"],
  ["chaque fois que j'éteins les écrans une heure avant le coucher, je m'endors plus vite", "les écrans tardifs retardent mon endormissement", "sommeil"],
  ["toutes les pizzas de ce restaurant étaient généreuses", "les portions y sont généreuses", "restauration"],
  ["les trois dernières commandes sont arrivées en deux jours", "la prochaine arrivera sans doute en deux jours", "livraison"],
  ["chaque fois qu'on laisse la porte du poulailler ouverte, un renard passe", "la porte ouverte attire les prédateurs", "élevage"],
  ["toutes les réunions qui commençaient sans ordre du jour ont dépassé l'heure", "un ordre du jour aide à finir à l'heure", "travail"],
  ["chaque automne, les feuilles du tilleul jaunissent avant les autres", "le tilleul jaunit tôt", "botanique"],
  ["tous les exercices réussis suivaient la même méthode", "cette méthode marche pour ce type d'exercice", "apprentissage"],
  ["chaque fois que le chat entend le tiroir, il vient manger", "le bruit du tiroir lui signale le repas", "animaux"],
  ["toutes les fois que l'usine tourne la nuit, le jour suivant est plus calme", "le travail de nuit régule la charge du jour", "organisation"],
  ["chaque fois que je bois du café après 17 h, je dors mal", "le café tardif perturbe mon sommeil", "santé"],
  ["tous les points chauds de la maison étaient des fenêtres mal isolées", "les fenêtres sont la source principale de déperdition", "habitat"],
  ["chaque fois que la fuite a été colmatée, la facture d'eau a baissé", "la fuite augmentait la consommation", "maison"],
  ["toutes les recettes réussies respectaient les temps de repos", "respecter le repos est clé dans ces recettes", "cuisine"],
  ["chaque sortie sans carte, on s'est perdus", "partir sans carte augmente le risque de se perdre", "randonnée"],
  ["tous les instruments mal rangés se désaccordaient", "le rangement protège l'accord", "musique"],
  ["chaque fois que l'équipe se parle clairement, le projet avance", "la communication claire accélère le projet", "travail d'équipe"],
];

/** Observations à expliquer (abduction, 40) : [observation, explications
 *  possibles, meilleure, vérification]. */
const ABDUCTIONS: readonly [string, string[], string, string][] = [
  ["le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo", ["l'arroseur automatique a tourné pendant la nuit", "une fuite du tuyau d'arrosage", "de la rosée abondante"], "l'arroseur automatique a tourné pendant la nuit", "regarder la programmation de l'arroseur"],
  ["la voiture ne démarre plus ce matin", ["la batterie est à plat", "il n'y a plus de carburant", "le démarreur est cassé"], "la batterie est à plat", "allumer les phares : s'ils sont faibles, c'est la batterie"],
  ["le chat gratte à la porte à 6 h", ["il a faim", "il veut sortir", "il cherche de la chaleur"], "il a faim", "le nourrir et voir s'il retourne dormir"],
  ["la facture d'eau a doublé ce mois-ci", ["une fuite quelque part", "des invités à la maison", "l'arrosage d'été"], "une fuite quelque part", "relever le compteur robinets fermés : s'il tourne, il y a fuite"],
  ["les plantes du bureau jaunissent", ["trop d'eau", "manque de lumière", "pot trop petit"], "manque de lumière", "les rapprocher de la fenêtre une semaine"],
  ["le wifi coupe toutes les soirées", ["saturation du réseau du voisinage", "box vieillissante", "trop d'appareils connectés"], "trop d'appareils connectés", "compter les appareils actifs et tester débranchés"],
  ["le pain ne lève plus", ["la levure est périmée", "l'eau était trop chaude", "la pièce est trop froide"], "la levure est périmée", "tester la levure dans de l'eau tiède sucrée"],
  ["un grincement au troisième escalier", ["le bois a travaillé avec l'humidité", "une vis a lâché", "la latte est fendue"], "une vis a lâché", "resserrer et voir si le bruit disparaît"],
  ["le réfrigérateur tourne sans arrêt", ["joint de porte fatigué", "température extérieure élevée", "thermostat déréglé"], "joint de porte fatigué", "tester le joint avec une feuille de papier"],
  ["les plantations du potager ont été creusées la nuit", ["un héron ou un mulot", "un chat du voisinage", "une poule échappée"], "un héron ou un mulot", "chercher des empreintes au petit matin"],
  ["le portail ne se ferme plus à fond", ["un caillou dans le rail", "un axe usé", "le sol s'est affaissé"], "un caillou dans le rail", "balayer le rail et retester"],
  ["l'ordi chauffe et ralentit", ["ventilateur encrassé", "trop d'onglets ouverts", "logiciel malveillant"], "ventilateur encrassé", "dépoussiérer les grilles et surveiller la température"],
  ["les voisins ont déménagé en pleine nuit", ["mutation professionnelle", "désaccord avec le propriétaire", "ils voulaient éviter la foule"], "mutation professionnelle", "demander poliment à leur connaissance commune"],
  ["le réfrigérateur gèle les aliments", ["thermostat trop bas", "sonde défectueuse", "placement contre le mur"], "thermostat trop bas", "remonter d'un cran et mesurer"],
  ["la boîte aux lettres est souvent vide alors que des colis sont annoncés", ["le livreur dépose chez un voisin", "les colis partent en point relais", "un retard global des livraisons"], "le livreur dépose chez un voisin", "interroger le suivi et les voisins"],
  ["les cheveux du chien tombent beaucoup", ["mue saisonnière", "alimentation inadaptée", "parasites"], "mue saisonnière", "vérifier la saison et brosser davantage"],
  ["une odeur de brûlé dans la cuisine sans rien sur le feu", ["des résidus dans le four", "un câble qui chauffe", "la hotte encrassée"], "des résidus dans le four", "inspecter le four et débrancher les appareils suspects"],
  ["la ruche est moins active", ["reine affaiblie", "période de miellée pauvre", "maladie"], "période de miellée pauvre", "observer les entrées par temps clair et comparer"],
  ["les ampoules du salon grillent souvent", ["surcharge du circuit", "mauvaise qualité d'ampoules", "tension instable"], "mauvaise qualité d'ampoules", "passer à une marque fiable et compter les pannes"],
  ["le lave-linge ne vide plus", ["pompe obstruée", "programmateur défaillant", "tuyau plié"], "pompe obstruée", "nettoyer le filtre de la pompe"],
  ["les enfants sont plus fatigués depuis la rentrée", ["rythme plus chargé", "moins de sommeil", "début de rhume qui circule"], "rythme plus chargé", "avancer l'heure du coucher une semaine et observer"],
  ["les tomates du balcon s'enracinent mal", ["pot trop petit", "terre pauvre", "trop de vent"], "pot trop petit", "rempoter dans un pot plus grand"],
  ["le téléphone se décharge vite", ["batterie vieillissante", "application gourmande", "réseau faible qui force l'antenne"], "batterie vieillissante", "consulter la santé de la batterie dans les réglages"],
  ["les réservations du gîte ont chuté en mai", ["calendrier de concours local", "prix revus à la hausse", "photos obsolètes en ligne"], "prix revus à la hausse", "comparer avec les gîtes voisins"],
  ["un grésillement dans l'enceinte gauche", ["câble mal enfoncé", "haut-parleur fatigué", "interférence"], "câble mal enfoncé", "réenfoncer et changer de câble pour tester"],
  ["les oiseaux ne viennent plus à la mangeoire", ["graines périmées", "présence d'un épervier", "mangeoire sale"], "graines périmées", "renouveler les graines et nettoyer"],
  ["la porte de garage grince et résiste", ["rails à graisser", "ressort fatigué", "porte voilée"], "rails à graisser", "graisser les rails et retester"],
  ["l'écran flashe par moments", ["câble vidéo usé", "pilote graphique à jour manquant", "écran défaillant"], "câble vidéo usé", "remplacer le câble pour voir"],
  ["des taches d'humidité au plafond", ["toiture qui fuit", "condensation", "canalisation au-dessus"], "toiture qui fuit", "inspecter les combles après une averse"],
  ["le lave-vaisselle laisse des traces blanches", ["sel régénérant vide", "eau très calcaire", "pastilles inadaptées"], "sel régénérant vide", "recharger le sel et relancer"],
  ["les clés de la voiture ne répondent plus de loin", ["pile faible", "antenne de la clé fatiguée", "brouillage près du parking"], "pile faible", "remplacer la pile"],
  ["mes messages atterrissent en spam", ["domaine sans SPF configuré", "contenu suspect", "volume d'envoi soudain"], "domaine sans SPF configuré", "vérifier les enregistrements DNS"],
  ["les fraises du marché sont moins sucrées ce mois-ci", ["récolte sous la pluie", "variété hors saison", "cueillette trop précoce"], "cueillette trop précoce", "demander la provenance et goûter d'autres stands"],
  ["le ballon d'eau chaude refroidit vite", ["thermostat déréglé", "déperdition du ballon", "un robinet qui fuit"], "thermostat déréglé", "contrôler la consigne et isoler le ballon"],
  ["les chaises de la salle grincennent toutes en même temps", ["humidité qui a gonflé le bois", "vis desserrées par l'usage", "sol inégal"], "vis desserrées par l'usage", "resserrer un échantillon et comparer"],
  ["l'imprimante imprime des bandes", ["tête d'impression encrassée", "cartouche presque vide", "papier inadapté"], "tête d'impression encrassée", "lancer le nettoyage de tête"],
  ["les relevés de la sonnette ne détectent plus les passages", ["angle décalé après le vent", "objectif sale", "sensibilité réduite"], "angle décalé après le vent", "réaligner et tester"],
  ["les courgettes du potager pourrissent au contact du sol", ["paillage manquant", "arrosage sur les feuilles", "sol trop argileux"], "arrosage sur les feuilles", "pailler et arroser au pied"],
  ["le micro-ondes chauffe moins qu'avant", ["magnétron vieillissant", "puissance mal réglée", "plat inadapté"], "puissance mal réglée", "vérifier le réglage de puissance"],
  ["les livraisons des dimanches sont systématiquement en retard", ["moins de chauffeurs le dimanche", "tri concentré en début de semaine", "tournées longues"], "moins de chauffeurs le dimanche", "demander au transporteur ses créneaux de tournée"],
];

/** Analogies réelles (60) : [a, b, c, d, relation]. */
const ANALOGIES: readonly [string, string, string, string, string][] = [
  ["un doigt", "la main", "une branche", "l'arbre", "partie → tout"],
  ["une page", "le livre", "une brique", "la maison", "élément → édifice"],
  ["une goutte", "la mer", "un grain de sable", "la plage", "minuscule → immense"],
  ["la roue", "la voiture", "l'aile", "l'oiseau", "moyen de déplacement"],
  ["le pilote", "l'avion", "le capitaine", "le navire", "conducteur → machine"],
  ["les plumes", "l'oiseau", "la fourrure", "le renard", "revêtement → animal"],
  ["les racines", "l'arbre", "les fondations", "la maison", "ancrage invisible"],
  ["l'écorce", "le tronc", "la peau", "le corps", "enveloppe protectrice"],
  ["les étoiles", "le ciel", "les poissons", "l'océan", "points vivants dans un espace"],
  ["le couteau", "couper", "le balai", "balayer", "outil → action"],
  ["la lampe", "éclairer", "le parapluie", "protéger", "objet → fonction"],
  ["l'eau", "boire", "le pain", "manger", "substance → usage"],
  ["le frisson", "le froid", "la sueur", "la chaleur", "signe → cause"],
  ["le sourire", "la joie", "les larmes", "la tristesse", "expression → émotion"],
  ["le miel", "l'abeille", "la soie", "le ver à soie", "production → producteur"],
  ["le lait", "la vache", "la laine", "le mouton", "production animale"],
  ["le maître", "l'élève", "l'entraîneur", "l'athlète", "guide → apprenant"],
  ["le remède", "la maladie", "la clef", "la serrure", "ce qui résout"],
  ["le bruit", "le silence", "le jour", "la nuit", "antonymes concrets"],
  ["lent", "rapide", "tiède", "bouillant", "graduation opposée"],
  ["naître", "mourir", "le début", "la fin", "les deux extrémités"],
  ["monter", "descendre", "emballer", "déballer", "actions inverses"],
  ["l'abondance", "la pénurie", "la popularité", "l'oubli", "états opposés"],
  ["l'oiseau", "le nid", "l'abeille", "la ruche", "habitant → habitat"],
  ["le cheval", "l'écurie", "la voiture", "le garage", "abri du moyen de transport"],
  ["le livre", "la bibliothèque", "le tableau", "le musée", "œuvre → lieu de collection"],
  ["le patient", "l'hôpital", "l'élève", "l'école", "personne → lieu d'accueil"],
  ["le pain", "la boulangerie", "le médicament", "la pharmacie", "bien → lieu d'achat"],
  ["les fleurs", "le bouquet", "les perles", "le collier", "pièces → assemblage"],
  ["le mouton", "le troupeau", "le poisson", "le banc", "individu → groupe"],
  ["l'aile", "le papillon", "la voile", "le bateau", "ce qui porte au vent"],
  ["la voiture", "la route", "le bateau", "la rivière", "moyen → voie"],
  ["l'aiguille", "la boussole", "l'antenne", "la radio", "organe de réception"],
  ["le thermostat", "la température", "le baromètre", "la pression", "mesureur → grandeur"],
  ["le mètre", "la longueur", "la balance", "la masse", "instrument → grandeur mesurée"],
  ["l'horloge", "le temps", "le thermomètre", "la chaleur", "instrument → grandeur"],
  ["la carte", "le territoire", "la recette", "le plat", "représentation → réel"],
  ["la notation", "la musique", "l'alphabet", "la langue", "code → langage"],
  ["la graine", "la plante", "l'œuf", "l'oiseau", "origine → être vivant"],
  ["la chenille", "le papillon", "le têtard", "la grenouille", "métamorphose"],
  ["le poulain", "le cheval", "le chaton", "le chat", "jeune → adulte"],
  ["le sifflet", "l'arbitre", "le métronome", "le musicien", "outil rythmique du métier"],
  ["le casque", "le motard", "le tablier", "le boulanger", "protection du métier"],
  ["le gant", "la main", "la chaussette", "le pied", "vêtement → membre"],
  ["le chapeau", "la tête", "le couvercle", "la casserole", "ce qui couvre"],
  ["la fenêtre", "la maison", "le hublot", "le bateau", "ouverture dans la paroi"],
  ["le balcon", "la façade", "l'auvent", "la devanture", "saillie du bâtiment"],
  ["l'avenue", "la ville", "le couloir", "l'hôtel", "passage d'un grand espace"],
  ["le phare", "le bateau", "la balise", "le randonneur", "guide lumineux"],
  ["l'ancre", "le navire", "le frein", "le vélo", "ce qui arrête"],
  ["le gouvernail", "le bateau", "le guidon", "le vélo", "organe de direction"],
  ["le carburant", "le moteur", "la nourriture", "le corps", "source d'énergie"],
  ["la mémoire", "l'ordinateur", "les archives", "le bureau", "stockage de l'information"],
  ["le clavier", "l'ordinateur", "la pédale", "le piano", "interface d'entrée"],
  ["l'écran", "l'ordinateur", "le tableau", "la classe", "surface d'affichage"],
  ["la note", "la mélodie", "l'arbre", "la forêt", "élément → ensemble vivant"],
  ["la lettre", "l'alphabet", "le chiffre", "le nombre", "unité symbolique"],
  ["la seconde", "la minute", "le centime", "l'euro", "sous-unité"],
  ["l'écho", "le son", "le reflet", "la lumière", "retour du signal"],
  ["l'empreinte", "le pas", "la fumée", "le feu", "trace → cause"],
];

/** Chaînes causales (50) : [cause, effet, mécanisme]. */
const CAUSALITES: readonly [string, string, string][] = [
  ["on n'arrose pas une plante pendant des semaines", "elle se dessèche puis meurt", "l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide"],
  ["on laisse une fenêtre ouverte sous l'orage", "le sol et les meubles proches se mouillent", "la pluie portée par le vent entre dans la pièce"],
  ["on oublie de sortir la glace du congélateur avant les invités", "elle est trop dure à servir", "la température du congélateur maintient l'eau sous son point de fusion"],
  ["un pneu roule sous-gonflé pendant des mois", "il s'use de façon irrégulière et la consommation augmente", "la surface de contact change et le frottement croît"],
  ["on tasse trop la terre autour d'un semis", "la pousse est difficile", "les racines ont besoin d'air et d'eau qui circulent"],
  ["le joint de douche est fissuré", "de l'eau s'infiltre dans le mur", "l'eau suit le chemin de moindre résistance à travers la fissure"],
  ["on empile des livres au bord d'une étagère", "elle s'affaisse", "le poids dépasse la résistance du bois au-delà des appuis"],
  ["une batterie reste déchargée tout l'hiver", "elle perd de sa capacité", "la sulfatation s'installe quand la tension descend trop bas"],
  ["on saute le petit-déjeuner avant l'examen", "la concentration faiblit en milieu de matinée", "le cerveau manque de glucose après la nuit"],
  ["les volets restent fermés toute la journée sur des plantes d'intérieur", "elles s'étiolent", "la photosynthèse s'arrête sans lumière suffisante"],
  ["on n'a jamais graissé les charnières", "la porte grince", "le frottement métal sur métal sec produit la vibration"],
  ["le filtre de la hotte est saturé de graisse", "l'aspiration faiblit", "l'air peine à traverser la couche de graisse"],
  ["on lève trop vite une charge lourde", "on se fait mal au dos", "les disques intervertébraux subissent une pression mal répartie"],
  ["le courrier s'accumule dans la boîte pleine", "le facteur ne peut plus déposer", "l'espace disponible est épuisé"],
  ["on lave une laine à 60 °C", "elle rétrécit", "les écailles des fibres se resserrent sous la chaleur et l'agitation"],
  ["un ruisseau reçoit des déchets en amont", "l'eau devient trouble en aval", "les particules se transportent avec le courant"],
  ["la bougie manque d'oxygène sous un verre", "elle s'éteint", "la flamme consomme l'oxygène disponible et s'arrête"],
  ["on roule trop longtemps sans pause sur l'autoroute", "la vigilance baisse", "l'attention se fatigue sans récupération"],
  ["les lampadaires restent allumés la nuit près du verger", "les oiseaux nocturnes désertent la zone", "la lumière artificielle perturbe leurs rythmes"],
  ["on laisse le savon dans une coupelle pleine d'eau", "il se ramollit", "l'eau s'infiltre et dissout la surface en continu"],
  ["un appel téléphonique passe pendant la sauvegarde", "elle est interrompue", "la connexion partage sa bande passante"],
  ["on saute une marche en descendant trop vite", "on perd l'équilibre", "le corps anticipe la hauteur de chaque marche"],
  ["la tonte est trop courte en plein été", "le gazon brûle", "le sol s'assèche et les brins perdent leur protection"],
  ["on oublie de mettre du sel dans l'eau des pâtes", "elles sont fades", "le sel relève le goût pendant la cuisson"],
  ["l'antenne est mal orientée", "l'image se fige", "le signal reçu est trop faible"],
  ["on range du bois humide contre le mur du salon", "des taches apparaissent", "l'humidité migre du bois vers la peinture"],
  ["un arbre est planté trop profondément", "il pousse mal", "le collet a besoin d'air pour respirer"],
  ["les rideaux restent tirés en permanence", "la facture d'électricité augmente le jour", "on allume les lampes plus tôt"],
  ["on ne vide jamais le bac à linge", "les vêtements propres manquent", "le cycle lavage/séchage n'est plus alimenté"],
  ["les semences sont semées trop serrées", "les plants se gênent", "chacun se dispute lumière, eau et nutriments"],
  ["le vélo a une chaîne rouillée", "le pédalage devient dur", "le frottement augmente sans lubrification"],
  ["on ouvre le four à mi-cuisson", "le gâteau retombe", "la chute de température stoppe la levée"],
  ["les clés restent sur la porte la nuit", "la sécurité est affaiblie", "n'importe qui de l'extérieur peut tourner"],
  ["on coupe la conversation à chaque phrase", "l'autre se démotive", "il ne se sent plus écouté"],
  ["l'eau s'accumule au pied des tomates", "les racines pourrissent", "l'asphyxie du sol empêche les échanges gazeux"],
  ["un mur est exposé plein nord", "il reste humide plus longtemps", "le soleil ne l'assèche jamais directement"],
  ["on empile des assiettes chaudes au plastique", "le plastique se déforme", "la chaleur ramollit le matériau"],
  ["les notifications sonnent toute la nuit", "le sommeil est haché", "les micro-réveils interrompent les cycles profonds"],
  ["on tire brusquement sur un zip bloqué", "il se casse", "la force appliquée dépasse la résistance du curseur"],
  ["les fenêtres restent fermées dans une pièce occupée", "l'air devient lourd", "le CO2 expiré s'accumule sans renouvellement"],
  ["on utilise un couteau non aiguisé", "les découpes sont écrasées", "la lame déchire au lieu de trancher"],
  ["un carton est posé directement au sol de la cave", "il s'humidifie par le bas", "l'humidité remonte par capillarité"],
  ["on multiplie les couches de peinture sans séchage", "la surface cloque", "les solvants restent piégés sous la couche sèche"],
  ["le lave-linge surcharge", "le linge ressort mal rincé", "l'eau ne circule pas entre les vêtements tassés"],
  ["on nourrit les canards avec du pain tous les jours", "l'étang se dégrade", "les excès polluent l'eau et appauvrissent leur alimentation"],
  ["une clé est tournée dans le mauvais sens avec force", "la serrure se bloque", "les pênes se dérèglent"],
  ["on oublie le vélo dehors tout l'hiver", "la chaîne et les câbles rouillent", "l'humidité oxyde le métal non protégé"],
  ["les messages restent sans réponse plusieurs jours", "la relation se refroidit", "le silence prolongé est vécu comme du désintérêt"],
  ["on plante un citronnier dehors en montagne", "il gèle", "l'espèce méditerranéenne ne supporte pas les fortes gelées"],
  ["on frappe une vis déjà tournée à fond", "l'emplacement se détériore", "l'énergie se dissipe dans le matériau plutôt que dans le serrage"],
];

/** Situations de sens commun (60) : [situation, ce qui arrive, pourquoi]. */
const SENS_COMMUN: readonly [string, string, string][] = [
  ["on laisse une boule de glace dix minutes au soleil", "elle fond progressivement", "la chaleur fait passer l'eau de l'état solide à l'état liquide"],
  ["on sort d'un bâtiment frais un jour d'été humide", "les lunettes se couvrent de buée", "la vapeur d'eau de l'air chaud se condense sur la surface froide"],
  ["on secoue un soda avant de l'ouvrir", "il gicle", "le gaz dissous se libère brutalement quand la pression chute"],
  ["on marche sur un sol fraîchement ciré", "on risque de glisser", "la cire réduit le frottement entre la semelle et le sol"],
  ["on met du métal dans un micro-ondes", "des étincelles apparaissent", "le métal réfléchit les ondes et provoque des décharges"],
  ["on place un miroir derrière une bougie", "la pièce semble plus lumineuse", "la lumière se réfléchit et se diffuse une seconde fois"],
  ["on tire une table lourde au lieu de la soulever", "elle traîne et grince", "le frottement au sol dépasse l'effort d'un léger soulèvement"],
  ["on ouvre la fenêtre la nuit d'été", "la pièce se rafraîchit", "l'air plus frais du dehors remplace l'air chaud accumulé"],
  ["on pose un livre sur une étagère penchée", "il glisse", "la gravité l'attire vers le bas le long de la pente"],
  ["on joue au ballon par grand vent", "le ballon dévie", "l'air en mouvement pousse les objets légers"],
  ["on traverse une flaque gelée en courant", "on risque une chute", "la glace est glissante car le frottement y est très faible"],
  ["on approche les mains d'un feu de cheminée", "elles se réchauffent", "le rayonnement thermique transporte la chaleur sans contact"],
  ["on oublie des chaussures mouillées dans un sac", "elles sentent mauvais le lendemain", "l'humidité confinée favorise les bactéries"],
  ["on empile des assiettes mouillées", "elles collent entre elles", "l'eau de surface crée une adhérence en séchant"],
  ["on laisse le portail ouvert et le chien dehors", "le chien s'en va explorer", "un animal curieux suit les odeurs dès qu'un passage s'offre"],
  ["on lance une balle contre un mur", "elle revient", "le choc la renvoie dans la direction opposée"],
  ["on parle plus fort au bord d'une route passante", "l'interlocuteur entend enfin", "la voix doit dépasser le bruit ambiant pour être isolée"],
  ["on saute dans une flaque en baskets", "les chaussettes se mouillent", "le tissu laisse passer l'eau par pression"],
  ["on souffle sur la soupe", "elle refroidit", "l'air qui passe évacue la chaleur de surface"],
  ["on place une couverture sur une glace", "elle fond moins vite", "la couverture ralentit les échanges de chaleur"],
  ["on oublie son téléphone au soleil sur la plage", "il surchauffe et ralentit", "l'électronique se protège en coupant ses performances"],
  ["on laisse traîner des câbles dans un couloir", "on risque de trébucher", "le pied accroche ce qui dépasse du sol"],
  ["on met une casserole trop grande sur une petite plaque", "la cuisson est lente et inégale", "la surface de chauffe est plus petite que le fond"],
  ["on verse de l'huile dans l'eau", "les deux se séparent", "l'huile est moins dense et ne se mélange pas à l'eau"],
  ["on ferme la porte d'une pièce climatisée", "le frais se conserve mieux", "l'échange d'air avec le reste du logement est coupé"],
  ["on marche sur du sable mouillé", "le sable tient sous les pieds", "l'eau comble les interstices et solidifie la surface"],
  ["on secoue un ketchup fermé puis on l'ouvre", "il sort plus facilement", "le mélange devient homogène et moins visqueux"],
  ["on laisse une fenêtre entrebâillée sous la neige", "un petit tas se forme au rebord", "le vent pousse les flocons à travers l'ouverture"],
  ["on range les couteaux pointe vers le bas", "le rangement devient plus sûr", "la lame exposée ne blesse personne qui fouille"],
  ["on fait sécher du linge dehors par grand vent", "il sèche vite", "l'air en mouvement emporte l'humidité évaporée"],
  ["on oublie d'arroser les fleurs coupées", "elles fanent en deux jours", "sans eau, la tige ne peut plus alimenter la fleur"],
  ["on roule avec de la boue sur les phares", "la visibilité de nuit chute", "la lumière est bloquée par la couche de boue"],
  ["on pose un torchon sous un saladier qui déborde", "le plan de travail reste propre", "le tissu absorbe le liquide avant qu'il ne coule"],
  ["on ouvre deux fenêtres opposées", "un courant d'air traverse la pièce", "l'air circule de la zone de pression haute vers la basse"],
  ["on plante une écharpe dans les rayons du vélo", "elle bloque la roue", "les rayons happent tout ce qui pend"],
  ["on marche avec des chaussettes sur un parquet ciré", "on dérape", "le tissu lisse réduit encore l'adhérence"],
  ["on met du chocolat dans la poche d'un manteau près du radiateur", "il fond", "la température de fusion du cacao est dépassée"],
  ["on ouvre une porte de four chaud face à soi", "la vapeur brûle le visage", "l'air chaud et humide monte directement vers la figure"],
  ["on laisse des fruits mûrs à côté de fruits fermes", "les fermes mûrissent plus vite", "les fruits mûrs dégagent de l'éthylène qui accélère le mûrissement"],
  ["on remplit un verre à ras bord avec des glaçons", "il déborde en fondant", "les glaçons déplacent plus de volume que l'eau rendue"],
  ["on taille un crayon trop court", "la tenue devient inconfortable", "la prise des doigts manque de matière"],
  ["on laisse une bougie allumée sans surveillance", "le risque d'incendie apparaît", "une flamme libre peut rencontrer un objet inflammable"],
  ["on traverse la forêt après la pluie avec des sandales", "les pieds glissent sur les racines", "le bois mouillé est très glissant"],
  ["on suspend un tableau avec un seul clou sur mur friable", "il penche puis tombe", "le plâtre s'effrite sous un point de charge unique"],
  ["on mélange du javel et du vinaigre", "des vapeurs toxiques se dégagent", "la réaction chimique libère du chlore gazeux — à ne jamais faire"],
  ["on range un thermos fermé rempli de boisson chaude couché", "il peut fuir par le bouchon", "la pression et l'orientation mettent le joint en contrainte"],
  ["on lance une pierre dans l'eau profonde", "elle coule", "sa densité dépasse celle de l'eau"],
  ["on tire un tapis pendant qu'un vase est dessus", "le vase glisse et peut tomber", "le vase reste inertiellement immobile pendant que le tapis bouge"],
  ["on ouvre un livre au vent sur la table", "les pages se tournent toutes seules", "le vent soulève chaque page libre"],
  ["on marche dans le brouillard épais", "les distances sont trompeuses", "la visibilité réduite fausse l'estimation des profondeurs"],
  ["on pose du verre près du bord du plan de travail", "il peut tomber et éclater", "le centre de gravité dépasse le support"],
  ["on roule sans freiner sur une côte mouillée", "la distance d'arrêt s'allonge", "l'adhérence réduite allonge le freinage"],
  ["on appuie sur un tube de dentifrice par le milieu", "la pâte sort des deux côtés", "la pression se répartit vers les extrémités ouvertes"],
  ["on laisse le charbon ardent dans un seau fermé", "le plastique fond", "la chaleur confinée dépasse le point de ramollissement"],
  ["on monte une échelle sur un sol meuble", "elle s'enfonce et bascule", "les pieds manquent d'appui stable"],
  ["on chauffe un plat en verre sorti du congélateur", "il peut éclater", "le choc thermique fissure le verre"],
  ["on soulève une valise par une seule poignée latérale", "elle penche fortement", "le centre de gravité n'est pas sous le point de levage"],
  ["on écrit sur un papier posé sur un mur sans support", "l'écriture est abîmée", "la feuille manque de rigidité sans surface dure"],
  ["on ferme un sac plastique sans le nouer", "les fourmis y entrent", "une simple superposition laisse des passages"],
  ["on laisse une pelure d'orange sur la table plusieurs jours", "elle sèche puis moisit", "l'humidité du fruit s'évapore puis favorise les moisissures à l'air libre"],
];

/** Objectifs de planification (40) : [objectif, étapes]. */
const PLANIFICATIONS: readonly [string, string[]][] = [
  ["organiser un pique-nique", ["choisir la date et vérifier la météo", "fixer le lieu et prévenir les participants", "répartir les plats et les boissons", "préparer la glacière, les nappes et les jeux", "prévoir un plan B en cas de pluie"]],
  ["préparer une randonnée d'une journée", ["choisir le parcours selon le niveau du groupe", "vérifier la météo et les horaires de lever/coucher du soleil", "préparer eau, nourriture, chaussures et trousse", "charger la carte et la batterie du téléphone", "prévenir une personne qui reste et fixer l'heure de retour"]],
  ["apprendre à faire du vélo à un enfant", ["choisir un lieu plat et sans circulation", "vérifier la hauteur de selle et les freins", "équiper l'enfant (casque, coudes, genoux)", "soutenir la selle puis lâcher par courtes distances", "féliciter chaque progrès et augmenter les distances"]],
  ["monter une étagère murale", ["repérer le mur et les fixations adaptées", "tracer le niveau au crayon", "percer les trous aux repères", "poser les chevilles et les supports", "fixer l'étagère et vérifier l'horizontalité"]],
  ["préparer un entretien d'embauche", ["relire l'offre et ses propres expériences", "préparer des exemples concrets de réussites", "se renseigner sur l'entreprise", "répéter les questions classiques à voix haute", "préparer deux questions à poser au recruteur"]],
  ["organiser un anniversaire surprise", ["fixer la date sans éveiller les soupçons", "choisir le lieu et créer la liste d'invités discrets", "préparer le gâteau et la décoration", "coordonner l'arrivée du principal intéressé", "répartir les rôles le jour J (éclairage, gâteau, photos)"]],
  ["planter un potager en carrés", ["choisir l'emplacement le plus ensoleillé", "construire ou installer les carrés", "préparer un mélange terre/compost", "planifier les cultures par saison", "semer, arroser et pailler régulièrement"]],
  ["changer une roue de voiture", ["s'arrêter sur un sol plat et allumer les feux", "serrer le frein à main et bloquer les roues", "desserrer les boulons avant de lever", "lever avec le cric et retirer la roue", "poser la roue de secours, serrer en étoile, abaisser"]],
  ["préparer un déménagement", ["faire le tri et donner ce qui ne sert plus", "réserver le camion ou les déménageurs", "acheter les cartons et emballer pièce par pièce", "étiqueter chaque carton par pièce et fragilité", "prévenir les organismes et faire suivre le courrier"]],
  ["organiser un vide-grenier", ["vérifier la réglementation locale", "réserver l'emplacement à la mairie", "trier et étiqueter les objets", "prévoir tables, monnaie et ombre", "prévoir la reprise des invendus (don, déchetterie)"]],
  ["se préparer à courir un 10 km", ["faire un bilan de forme et des chaussures", "bâtir un plan sur 8 à 10 semaines", "alterner courses courtes, longues et repos", "s'entraîner avec un partenaire pour tenir", "tester l'équipement de course avant le jour J"]],
  ["lancer une newsletter", ["choisir le thème et le public", "trouver l'outil d'envoi et la charte", "écrire le premier numéro simple et utile", "collecter les premiers abonnés de confiance", "fixer un rythme tenable et mesurer l'intérêt"]],
  ["apprendre une langue en trois mois", ["fixer un objectif concret (commander, se présenter)", "apprendre 15 minutes chaque jour", "écouter la langue quotidiennement (podcast, musique)", "pratiquer à voix haute et avec un partenaire", "réviser ses erreurs chaque semaine"]],
  ["organiser une sortie scolaire", ["obtenir l'accord de l'établissement", "visiter ou contacter le lieu", "préparer les autorisations parentales", "organiser les groupes et l'encadrement", "préparer la trousse de secours et les contacts"]],
  ["préparer un gâteau à étages", ["lire la recette entière avant de commencer", "sortir le beurre et les œufs à température", "préparer les pâtes et les cuire à l'avance", "laisser refroidir avant de garnir", "glaçage, assemblage, puis repos au frais"]],
  ["installer une bibliothèque murale", ["mesurer les livres à ranger", "choisir l'emplacement et la profondeur", "chercher les montants dans le mur", "fixer les équerres aux bons points", "tester la charge avant de ranger"]],
  ["vider un garage encombré", ["tout sortir et créer trois zones (garder, donner, jeter)", "commencer par la zone la plus encombrée", "démonter ce qui est encombrant", "planifier la déchetterie et les enlèvements", "réorganiser avec étagères et étiquettes"]],
  ["organiser un tournoi de quartier", ["sonder les familles pour le format", "réserver le terrain et les créneaux", "créer les poules et le tableau", "prévoir arbitres, ballons et buvette", "communiquer les résultats et remercier"]],
  ["préparer la rentrée scolaire", ["relire la liste des fournitures", "acheter avant la ruée et étiqueter", "réviser les horaires et les trajets", "réajuster les rythmes de sommeil une semaine avant", "préparer la tenue et le sac la veille"]],
  ["planifier un voyage en train", ["comparer les horaires et les tarifs", "acheter les billets aller-retour", "réserver l'hébergement proche de la gare", "préparer un sac de cabine léger", "vérifier les quais et prévoir une marge"]],
  ["monter une tente pour la première fois", ["s'entraîner à la maison avant le départ", "choisir un sol plat et dégagé", "déplier et identifier les piquets et sangles", "monter les arceaux puis tendre la toile", "planter les piquets en biais et vérifier l'étanchéité"]],
  ["organiser une kermesse d'école", ["constituer une équipe de parents", "réserver la cour et les autorisations", "choisir dix jeux simples et sûrs", "planifier les postes et les jetons", "prévoir la remise des lots et le nettoyage"]],
  ["préparer un exposé devant la classe", ["comprendre le sujet et choisir trois idées clés", "chercher des exemples concrets et une image forte", "rédiger un plan simple (début, milieu, fin)", "s'entraîner à voix haute et chronométrer", "préparer les réponses aux questions probables"]],
  ["repeindre une chambre", ["protéger le sol et les prises", "lessiver et poncer les murs", "appliquer une sous-couche", "peindre les angles au pinceau puis au rouleau", "laisser sécher et refaire une seconde couche"]],
  ["organiser un carnaval de quartier", ["créer un comité et un budget", "choisir le parcours avec la mairie", "préparer ateliers de masques et de costumes", "recruter des bénévoles pour la sécurité", "prévoir musique, sécurité et ramassage des déchets"]],
  ["créer un potager partagé", ["repérer une parcelle ensoleillée et accessible", "obtenir l'accord de la commune ou du syndic", "tracer les carrés et les chemins", "organiser les tours d'arrosage", "planter ensemble et partager la récolte"]],
  ["préparer une sortie en kayak", ["vérifier la météo, le vent et le courant", "contrôler gilets, pagaies et caisses étanches", "prévenir les secours du plan d'eau", "partir avec un binôme expérimenté", "prévoir l'itinéraire de repli et l'heure de sortie"]],
  ["monter une exposition photo", ["choisir un fil narratif", "sélectionner et numériser les clichés", "imprimer et encadrer en série", "accrocher à hauteur des yeux avec légendes", "préparer le vernissage et le livret"]],
  ["organiser une collecte solidaire", ["choisir l'association partenaire", "définir les besoins précis (aliments, chaud, livres)", "créer les points de collecte", "planifier la communication locale", "trier, compter et remettre avec un reçu"]],
  ["préparer une soirée jeux", ["choisir trois jeux variés (rapide, stratégie, ambiance)", "vérifier les règles à l'avance", "prévoir collations et boissons", "installer une table spacieuse et claire", "expliquer les règles en cinq minutes max par jeu"]],
  ["créer une chronique hebdomadaire", ["choisir un angle précis et tenu", "rédiger la première chronique", "fixer un jour de publication fixe", "préparer deux sujets d'avance pour tenir le rythme", "relire, illustrer, publier, mesurer les retours"]],
  ["planifier les semailles du printemps", ["lister les cultures souhaitées", "vérifier les dernières gelées locales", "préparer les sillons et le compost", "semer par vagues espacées de deux semaines", "pailler et étiqueter chaque rangée"]],
  ["organiser la garde d'un animal pendant l'absence", ["choisir entre pension et proche de confiance", "rédiger la fiche (aliments, soins, vétérinaire)", "préparer le nécessaire en un seul endroit", "organiser une rencontre préalable avec l'animal", "laisser les contacts d'urgence accessibles"]],
  ["préparer une vente aux enchères caritative", ["collecter les lots et les estimer", "créer le catalogue numéroté", "choisir le commissaire-priseur ou l'animateur", "ouvrir les enchères avec des règles claires", "encaisser, remercier, publier les montants"]],
  ["monter une pièce de théâtre", ["choisir le texte et distribuer les rôles", "installer un rythme de répétitions", "travailler d'abord le fil puis les détails", "régler les entrées, sorties et accessoires", "répéter en costume avant la première"]],
  ["organiser un atelier d'écriture", ["choisir un thème fédérateur", "préparer des amorces courtes", "installer un cadre bienveillant et silencieux", "faire lire volontairement puis commenter positivement", "proposer un défi pour la séance suivante"]],
  ["préparer un concours", ["lire le règlement en entier", "collecter les annales et sujets types", "bâtir un planning de révisions", "s'entraîner en conditions réelles chronométrées", "préparer le dossier et le matériel la veille"]],
  ["planifier une semaine de repos", ["débrancher les sollicitations professionnelles", "choisir deux vraies envies (nature, lecture...)", "réserver les hébergements tôt", "laisser des plages vides dans le planning", "préparer les affaires deux jours avant"]],
  ["créer un club de lecture", ["trouver trois lecteurs motivés", "choisir un premier livre court", "fixer une date mensuelle fixe", "préparer trois questions de discussion", "alterner les choix de chacun à chaque tour"]],
  ["organiser une fête de fin d'année", ["sonder les disponibilités tôt", "choisir le lieu et le thème", "répartir mets et décorations", "préparer musique et activités", "prévoir les remerciements et le rangement"]],
];

/** Énoncés implicites (pragmatique, 36) : [énoncé, ce qui est dit vraiment,
 *  indice]. */
const PRAGMATIQUES: readonly [string, string, string][] = [
  ["« Bravo, tu as encore oublié mes clés… »", "c'est un reproche déguisé : la personne est contrariée", "le ton piqué et le mot « encore » qui pointe une habitude"],
  ["« Il fait un peu frais ici, non ? »", "c'est une demande indirecte de fermer la fenêtre", "on commente l'ambiance pour susciter une action"],
  ["« Quelle surprise, tu es à l'heure ! »", "c'est de l'ironie : la personne est d'habitude en retard", "l'exagération et le contexte d'habitude"],
  ["« Je ne suis pas fâchée, mais… »", "elle est fâchée, et une critique suit", "le « mais » qui annule la première partie"],
  ["« Si tu veux, on peut faire autrement… »", "la personne préfère nettement autrement", "la forme atténuée d'une vraie préférence"],
  ["« Pas mal du tout ! »", "c'est un compliment sincère mais mesuré", "l'atténuation française qui dit « bien »"],
  ["« Tu peux y aller doucement avec le sel ? »", "il y a trop de sel, on demande d'en mettre moins", "la question polie qui vise une correction"],
  ["« C'est gentil de penser à moi… quand tu y penses. »", "c'est un reproche d'égocentrisme", "la chute qui contredit le début"],
  ["« On verra. »", "c'est une réponse évasive, souvent un refus doux", "l'absence d'engagement concret"],
  ["« Je te fais confiance… » après une erreur", "la confiance est fragilisée, la vigilance monte", "les points de suspension qui pèsent"],
  ["« Comme tu veux. »", "souvent un désaccord poli, un retrait", "l'abandon de la discussion"],
  ["« Il ne va pas tarder, celui-là… »", "il est déjà en retard", "l'antiphrase sur « tard »"],
  ["« Tu es libre ce soir ? »", "une demande arrive probablement juste après", "on vérifie la disponibilité avant de solliciter"],
  ["« Ce n'est rien, vraiment. »", "c'est parfois quelque chose, la politesse minimise", "le « vraiment » qui cherche à convaincre"],
  ["« Tu as du temps, toi ! »", "soit un compliment sur la disponibilité, soit une pique sur la lenteur", "le contexte et le ton décident"],
  ["« On devrait se voir plus souvent ! »", "souvent un regret, parfois une vraie invitation", "le « devrait » qui pointe un manque"],
  ["« J'ai lu ton message. »", "sans autre mot, la réponse est reportée", "l'information minimale qui n'avance rien"],
  ["« Fais comme chez toi. »", "invitation à se sentir à l'aise, pas une permission illimitée", "la formule d'accueil rituelle"],
  ["« Tu connais la réponse, non ? »", "la personne veut que tu la trouves toi-même", "le « non ? » qui guide plutôt qu'il n'informe"],
  ["« Ce sera long, hein… »", "avertissement bienveillant avant une tâche", "le « hein » qui invite à s'y préparer"],
  ["« De rien. » dit sèchement", "l'aide est passée mais l'humeur est là", "la brièveté sèche"],
  ["« Pas tout de suite. »", "refus différé, pas d'agenda précis", "l'absence de date"],
  ["« J'adore ce que tu as fait… si tu dis tout. »", "pression douce pour obtenir une confidence", "la condition finale"],
  ["« Ne te lève pas, je me débrouille. »", "peut être un vrai refus d'aide ou une politesse à contrer", "offrir une deuxième fois précise la règle"],
  ["« Tu m'avais promis. »", "rappel d'un engagement non tenu", "la formule qui réactive un accord"],
  ["« Je pensais que tu étais occupé. »", "excuse ou reproche déguisé selon le ton", "le passé composé qui juge en douce"],
  ["« Le repas est prêt quand tu veux. »", "invitation polie à venir sans pression", "la liberté accordée reste une attente"],
  ["« On a dit 19 h, non ? »", "rappel d'un retard en cours", "la question qui affirme"],
  ["« Si tu insistes… »", "acceptation après une résistance rituelle", "l'abandon apparent qui cède"],
  ["« Dis-moi si c'est trop. »", "demande de feedback honnête sur une limite", "l'invitation explicite à la franchise"],
  ["« Je vais réfléchir. »", "souvent un non poli en attente", "l'absence de « oui » immédiat"],
  ["« Toi, au moins, tu sais ! »", "compliment contrasté avec d'autres", "le contraste implicite"],
  ["« C'était mieux avant, non ? »", "nostalgie critique, l'actuel déçoit", "la question rhétorique"],
  ["« Tu es sûr ? »", "vérification : la personne doute de la réponse", "on re-sollicite pour confirmer"],
  ["« Bonne chance pour la suite… »", "peut clore poliment une discussion", "la formule de sortie"],
  ["« J'ai juste une petite question. »", "une vraie demande arrive, la modestie adoucit", "le « juste » qui minimise avant l'effort"],
];

/** Dilemmes éthiques pratiques (24) : [situation, valeurs en tension,
 *  conduite retenue]. */
const ETHIQUES: readonly [string, string, string][] = [
  ["vous trouvez un portefeuille avec de l'argent et une carte d'identité", "l'appât du gain contre l'honnêteté et l'empathie", "essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur"],
  ["vous retrouvez la monnaie en trop après un achat", "le petit profit facile contre l'équité", "signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces"],
  ["un ami vous confie un secret que d'autres s'apprêtent à croire faux", "la loyauté contre l'honnêteté envers les tiers", "garder le secret mais aider l'ami à corriger l'information lui-même"],
  ["on vous promet une sortie, un imprévu plus important survient", "tenir sa parole contre une nécessité réelle", "prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi"],
  ["un collègue fait une erreur qui sera imputée à l'équipe", "la solidarité contre la vérité", "en parler avec le collègue d'abord, puis aider à corriger : le but est de réparer, pas de punir"],
  ["un enfant gagne en trichant à un jeu familial", "la joie de l'enfant contre la règle partagée", "le faire jouer à nouveau en expliquant doucement : la confiance dans les règles est le vrai cadeau"],
  ["un proche vous demande un avis sur un travail moyen", "la franchise contre la bienveillance", "dire ce qui marche d'abord, puis ce qui améliorera — la critique utile, jamais brutale"],
  ["un objet emprunté est rendu abîmé", "la gêne contre la responsabilité", "annoncer l'incident soi-même et proposer une réparation : l'initiative répare la confiance"],
  ["le vendeur rend un billet de trop", "le gain silencieux contre l'équité", "rendre le billet : l'erreur pourrait être imputée au vendeur"],
  ["un collègue vous passe un appel d'urgence pendant votre repos", "la disponibilité contre le droit au repos", "répondre brièvement, trier l'urgence réelle du reste, et renégocier les canaux ensuite"],
  ["vous découvrez que la file d'attente est coupée par quelqu'un de pressé", "l'équité collective contre la compassion individuelle", "proposer de le laisser passer seulement s'il y a une vraie urgence et avec l'accord de la file"],
  ["un ami vous propose un prix trop bas pour un service rendu", "le gain contre l'équité pour lui", "payer le prix juste ou compenser autrement : l'amitié ne se nourrit pas d'avantage"],
  ["vous cassez quelque chose chez quelqu'un sans témoin", "la discrétion facile contre l'honnêteté", "l'annoncer spontanément et proposer de remplacer : c'est ce qu'on attendrait pour nos propres affaires"],
  ["on vous demande de recommander quelqu'un de moyen", "la gentillesse sociale contre l'exactitude", "recommander ce qui est vrai et précis : « solide sur X, en progrès sur Y »"],
  ["vous recevez un cadeau que vous n'aimez pas", "la vérité contre le soin de la relation", "remercier l'intention sincèrement, ne pas mentir sur le goût si la question est posée"],
  ["un bug est découvert juste avant la livraison", "la pression du délai contre la qualité et la sécurité", "signaler immédiatement et proposer un correctif ou un report assumé : cacher un défaut coûte plus tard"],
  ["on vous répète un ragot sur un collègue absent", "la curiosité contre la justice", "ne pas le relayer et le recadrer doucement : la réputation d'autrui n'est pas un divertissement"],
  ["un travail collectif est primé individuellement", "la modestie contre la reconnaissance des autres", "citer explicitement les contributions de chacun"],
  ["on vous promet une faveur en échange d'un silence", "l'avantage contre la transparence", "refuser : les arrangements qui exigent le silence sont généralement une mauvaise nouvelle"],
  ["un enfant demande si le père Noël existe", "la vérité contre la magie et la confiance", "répondre avec douceur à la hauteur de sa question, sans mentir frontalement ni casser le jeu collectif"],
  ["vous voyez quelqu'un jeter ses déchets par la fenêtre", "l'ordre public contre le risque d'altercation", "recadrer poliment si c'est sûr, sinon signaler : l'objectif est l'espace propre, pas l'humiliation"],
  ["un voisin vous demande d'abriter son colis fragile longtemps", "l'entraide contre votre propre contrainte", "accepter si possible avec une date butoir, sinon proposer une alternative honnête"],
  ["vous vous rendez compte d'avoir fait un calcul erroné favorable à votre équipe", "l'avantage acquis contre la justesse", "corriger et annoncer la rectification : la crédibilité est un actif à long terme"],
  ["un ami demande votre avis sur un choix de vie que vous jugeriez risqué", "le respect de son autonomie contre le souci de sa sécurité", "poser les faits et les risques sans décider pour lui : son chemin lui appartient"],
];

/** Questions métacognitives (30) : [question, éléments de réponse]. */
const METACOGNITIONS: readonly [string, string][] = [
  ["comment sait-on qu'on connaît le chemin vers l'école ?", "on peut le parcourir mentalement, anticiper les tournants et retrouver le bon chemin même en variant le départ — c'est la capacité de simulation qui prouve la connaissance, pas la sensation de familiarité"],
  ["qu'est-ce qui distingue savoir et croire ?", "savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore"],
  ["quand un mot est « sur le bout de la langue », que se passe-t-il ?", "la mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu"],
  ["comment reconnaît-on qu'on s'est trompé ?", "un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal"],
  ["comment planifie-t-on mentalement une tâche ?", "on décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action"],
  ["comment sait-on qu'on a compris un texte ?", "on peut le reformuler avec ses mots, répondre à des questions nouvelles dessus et en prédire la suite — la reformulation est le vrai test"],
  ["pourquoi estime-t-on souvent mal la durée d'une tâche ?", "on juge par le meilleur cas et on oublie les imprévus ; l'astuce humaine est de comparer avec des tâches semblables déjà faites"],
  ["pourquoi réviser d'abord ce qu'on maîtrise mal ?", "revoir ce qu'on sait fait plaisir mais n'apprend rien ; l'effort utile porte là où l'erreur est probable"],
  ["comment distingue-t-on un souvenir d'un rêve ?", "les souvenirs réels s'alignent sur des indices externes (dates, témoins, objets) ; les rêves résistent à ces vérifications et se dégradent vite"],
  ["comment change-t-on d'avis proprement ?", "on nomme ce qui a changé : une information nouvelle ou une faille dans l'ancien raisonnement — changer d'avis pour une raison n'est pas une faiblesse"],
  ["à quoi sert l'intuition, et quand la vérifier ?", "l'intuition est un raccourci construit par l'expérience ; elle oriente vite, mais sur les sujets importants elle doit être vérifiée par les faits"],
  ["comment explique-t-on sa méthode à quelqu'un ?", "on la décompose en étapes nommées, avec pour chacune son « pourquoi » — si une étape n'a pas de pourquoi, c'est elle qu'il faut réexaminer"],
  ["comment repère-t-on ce qu'on ignore ?", "en essayant de l'expliquer : là où les phrases s'arrêtent ou deviennent vagues se trouve la frontière du connu"],
  ["pourquoi les erreurs font-elles progresser ?", "une erreur corrigée réécrit la règle fautive ; sans correction, elle se répète — l'important n'est pas l'erreur mais son traitement"],
  ["comment trancher entre deux avis opposés ?", "chercher ce sur quoi ils sont d'accord, isoler le point exact du désaccord, puis vérifier ce point avec des faits plutôt qu'avec l'autorité des personnes"],
  ["comment retenir une liste de courses ?", "on regroupe par catégories (frais, sec, fraisier), on les imagine en un parcours familier — l'esprit retient mieux les scènes que les listes"],
  ["pourquoi comprend-on certaines blagues et pas d'autres ?", "la blague repose sur un écart attendu/cassé ; sans connaître la norme cassée (culture, mot double), l'écart reste invisible"],
  ["comment sentir qu'un conseil est bon ?", "il se vérifie par des exemples concrets, il explique ce qui n'allait pas et reste applicable demain — un bon conseil se teste, il ne se décrète pas"],
  ["comment vérifier un calcul de tête ?", "on refait l'opération par un chemin différent (ordre des termes, arrondis) et on compare : deux chemins d'accord valent mieux qu'un seul"],
  ["quand faut-il demander de l'aide ?", "quand le coût d'essayer seul (temps, risque) dépasse le coût de la question — savoir demander est une compétence, pas un aveu"],
  ["comment garder son calme avant une échéance ?", "nommer ce qui dépend de soi et ce qui n'en dépend pas, agir sur le premier, accepter le second, et respirer lentement pour baisser la tension"],
  ["pourquoi se souvient-on mieux d'un visage que d'un nom ?", "le cerveau traite les visages comme des ensembles d'images ; les noms sont des étiquettes abstraites — les lier à une scène renforce la trace"],
  ["comment suit-on une conversation dans un lieu bruyant ?", "le cerveau isole la voix par son timbre et son rythme, complète les syllabes manquantes par le contexte — d'où la fatigue après"],
  ["comment imagine-t-on le point de vue de quelqu'un d'autre ?", "on simule : « si j'étais à sa place, avec son information et ses contraintes » — la limite est de ne pas projeter nos propres envies"],
  ["comment doser son effort sur une tâche longue ?", "par cycles courts avec des pauses, en mesurant le progrès visible — la persévérance se nourrit des jalons, pas de la volonté seule"],
  ["comment anticiper les obstacles d'un projet ?", "se demander « qu'est-ce qui ferait échouer ? » et préparer une réponse pour les deux ou trois causes les plus probables"],
  ["pourquoi résumer un texte avec ses mots ?", "le résumé force à choisir l'essentiel et révèle ce qui n'est pas compris — copier ne prouve rien, reformuler prouve tout"],
  ["comment prendre des notes vraiment utiles ?", "noter les liens et les exemples plutôt que tout : une note est un outil de rappel, pas une transcription"],
  ["comment se préparer à parler en public ?", "répéter à voix haute, préparer les trois premières phrases par cœur, et anticiper la première minute — le trac décroît après le démarrage"],
  ["comment accepter une correction sans se braquer ?", "séparer la personne du geste : la correction porte sur un travail, pas sur une valeur ; la question utile est « qu'est-ce que ça m'apprend ? »"],
];

/** Problèmes pratiques (30) : [problème, méthode appliquée]. */
const RESOLUTIONS: readonly [string, string][] = [
  ["le vélo fait un bruit de frottement à chaque tour de roue", "isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois"],
  ["le robinet goutte même fermé", "comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit"],
  ["l'imprimante sort une page à l'envers ou dans le mauvais sens", "comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine"],
  ["le programme ne compile pas après une modification", "lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner"],
  ["la sauce est trop salée", "comprendre le mécanisme (le sel est dissous partout) puis diluer ou équilibrer : ajouter de l'eau, du volume sans sel, ou un contre-goût — on ne retire pas le sel, on le déploie"],
  ["la plante d'intérieur jaunit malgré l'arrosage", "lister les besoins (lumière, eau, drainage, nutriments), tester une variable à la fois : trop d'eau est aussi fréquent que pas assez"],
  ["la montre prend du retard chaque jour", "mesurer le retard par jour pour quantifier, puis chercher la cause (pile, aimantation, usure) chez un horloger : mesurer d'abord, réparer ensuite"],
  ["l'escalier grince depuis l'hiver", "l'hiver a asséché le bois et desserré les assemblages ; repérer la marche précise, renforcer ou lubrifier : un problème saisonnier a souvent une cause matérielle simple"],
  ["la douille est coincée dans son logement", "ne pas forcer dans l'axe qui raye : faire tourner, chauffer légèrement, utiliser un outil adapté — changer de méthode quand la force ne marche pas"],
  ["les chaussettes disparaissent une par une", "c'est un problème de flux, pas de mystère : fixer un point unique de lavage/séchage et un bac de paires — l'organisation remplace la recherche"],
  ["le sac d'école est trop lourd", "peser le sac, lister le contenu par poids, retirer le superflu et répartir : mesurer avant de décider"],
  ["il faut faire passer une remarque difficile à un proche", "choisir le moment calme, dire le fait sans jugement, exprimer son ressenti avec « je », proposer ensemble une solution — l'ordre des phrases est la moitié du travail"],
  ["la note est tombée et elle est mauvaise", "séparer l'émotion de l'analyse : repérer les points perdus par catégorie, refaire les exercices fautifs, planifier la révision ciblée — la mauvaise note est une carte des lacunes"],
  ["la table basse vacille", "identifier la cause (pied inégal, sol, assemblage) en appuyant sur chaque coin, puis compenser au point exact : une cale de 2 mm vaut mieux qu'un marteau"],
  ["une odeur inexpliquée dans la cuisine", "suivre l'intensité pièce par pièce, vérifier les classiques (poubelle, siphon, frigo, placard humide) dans l'ordre de probabilité : l'odeur est un indice qui se suit"],
  ["un bruit nouveau en roulant", "noter quand il apparaît (vitesse, freinage, virage) : le moment d'apparition désigne presque toujours l'organe fautif"],
  ["le budget mensuel dérape", "comparer prévu et réalisé ligne par ligne, repérer la ou les lignes dérivantes, ajuster la règle (plafond, virement automatique) : corriger la règle, pas seulement le montant"],
  ["le wifi est faible à l'étage", "comprendre le signal (murs, distance, interférences) : déplacer la box en hauteur et au centre, ou ajouter un répéteur — on améliore le chemin du signal"],
  ["les tomates ont le pied pourri mais les feuilles jaunissent", "deux signaux contradictoires → mesurer le sol (humide ?), vérifier le drainage : le symptôme visible n'est pas toujours la cause"],
  ["la feuille de calcul donne un total faux", "vérifier la formule, la plage couverte, et les lignes cachées ou filtrées : le total reflète exactement ce qu'on lui a donné à voir"],
  ["le train est manqué de trois minutes", "analyser la chaîne (réveil, trajet, quai, marge) et trouver le maillon le plus fragile, puis y ajouter la marge : on ne rattrape pas le temps, on sécurise le prochain"],
  ["le café est trop amer", "l'amertume vient d'une extraction trop longue ou trop chaude : moudre plus grossièrement, baisser la température ou raccourcir — un paramètre à la fois"],
  ["la pendule du salon avance de dix minutes", "la remettre à l'heure de référence (radio, téléphone), mesurer si elle dérive, et régler sa cause : une horloge qui dérive a un rythme déréglé"],
  ["le colis est arrivé abîmé", "documenter avant tout (photos, emballage), signaler au vendeur dans le délai, garder les preuves : l'ordre des gestes protège le droit"],
  ["il faut démonter un meuble sans la notice", "photographier avant chaque étape, retirer les vis en gardant leurs emplacements tracés : la documentation est la moitié du remontage"],
  ["la connexion est lente en soirée", "vérifier si c'est local (test sur câble) ou réseau (test à d'autres heures) : distinguer le local du global évite de changer le mauvais équipement"],
  ["le joint de la fenêtre laisse passer l'air", "localiser la fuite avec une feuille de papier, nettoyer, remplacer le joint à la bonne épaisseur : mesurer avant d'acheter"],
  ["le hamster s'est échappé de sa cage", "penser comme lui : il cherchera l'obscurité, la nourriture et le silence — placer un seau-appât au sol et des graines en ligne, vérifier la nuit"],
  ["une tache sur le tapis", "identifier la nature de la tache (graisse, eau, encre) car chaque tache a son solvant, tamponner sans frotter : le mauvais produit fixe la tache"],
  ["la porte frotte en bas depuis l'installation du nouveau sol", "le sol a monté le niveau : mesurer l'espace frottant et raboter ou régler les charnières — le changement de contexte crée le problème"],
];

// ─── Capacités (combinaisons uniques réelles par famille) ───────────────────

/** Capacité injective de chaque famille : l'index de famille parcourt
 *  [0, capacité) et produit exactement une paire distincte. */
export const CAPACITES: Record<FamilleRaisonnement, number> = {
  deduction: 30_000, // 2 polarités × 6 formulations × 48 catégories × 72 noms = 41 472 → plafonné
  conditionnel: 576, // 48 règles × 2 modes × 6 formulations
  induction: 432, // 36 séries × 3 volumes d'observation × 4 formulations
  abduction: 160, // 40 observations × 4 formulations
  analogie: 480, // 60 analogies × 4 formulations × 2 sens
  causalite: 200, // 50 chaînes × 4 formulations
  sens_commun: 240, // 60 situations × 4 formulations
  theorie_esprit: 200_000, // 72×71×24×14×3×3 = 3 084 480 → plafonné
  planification: 240, // 40 objectifs × 3 formulations × 2 contraintes
  math_verbal: 580_990, // 10 contextes × (14 641 + 14 878 + 14 878 + 14 702) grilles
  pragmatique: 108, // 36 énoncés × 3 formulations
  ethique_pratique: 72, // 24 dilemmes × 3 formulations
  spatial: 250_000, // 3 types × 72×71×70 arrangements × 4 formulations → plafonné
  temporel: 26_496, // 24 h × 12 min × 23 durées × 4 formulations
  metacognition: 90, // 30 sujets × 3 formulations
  resolution_probleme: 90, // 30 problèmes × 3 formulations
};

/** Volume cible de la campagne (demande propriétaire : 1 million). */
export const TOTAL_CIBLE = 1_000_000;

// ─── Décodage injectif index → paire ────────────────────────────────────────

/** Décode r en un indice disponible (non déjà utilisé) — injectif. */
function niemeDisponible(utilises: Set<number>, taille: number, r: number): number {
  const libres = taille - utilises.size;
  let cible = r % libres;
  for (let i = 0; i < taille; i++) {
    if (utilises.has(i)) continue;
    if (cible === 0) return i;
    cible -= 1;
  }
  return 0;
}

/** Décode m en trois indices DISTINCTS parmi taille (injectif). */
function tripleSansRepetition(
  m: number,
  taille: number,
): [number, number, number] {
  const i1 = m % taille;
  const r1 = Math.floor(m / taille) % (taille - 1);
  const r2 = Math.floor(m / (taille * (taille - 1))) % (taille - 2);
  const utilises = new Set<number>([i1]);
  const i2 = niemeDisponible(utilises, taille, r1);
  utilises.add(i2);
  const i3 = niemeDisponible(utilises, taille, r2);
  return [i1, i2, i3];
}

const FORM_DEDUC: readonly string[] = [
  "Tous les {a} sont des {b}. {n} fait partie des {a}. Qu'est-ce qu'on peut en déduire ?",
  "On sait que tous les {a} sont des {b}, et que {n} fait partie des {a}. Que concluez-vous ?",
  "Si quelque chose fait partie des {a}, alors elle fait partie des {b}. {n} fait partie des {a}. Qu'en déduit-on ?",
  "Voici deux affirmations : « tous les {a} sont des {b} » et « {n} fait partie des {a} ». Qu'en suit-il ?",
  "Exercice de logique : tous les {a} sont des {b} ; {n} est du nombre des {a}. Quelle est la conclusion ?",
  "Raisonnons : toute chose du groupe des {a} appartient au groupe des {b}. {n} appartient au groupe des {a}. Conclusion ?",
];

const INTRO_COND: readonly string[] = [
  "Exercice de logique :", "Raisonnons :", "Petit test de logique :",
  "Voici une règle :", "Vérifions ce qu'on peut conclure :", "",
];

function paireDeduction(i: number): PairePP {
  const pol = i % 2;
  const form = Math.floor(i / 2) % FORM_DEDUC.length;
  const cat = Math.floor(i / (2 * FORM_DEDUC.length)) % CATEGORIES.length;
  const nom = Math.floor(i / (2 * FORM_DEDUC.length * CATEGORIES.length)) % NOMS.length;
  const [a, b] = CATEGORIES[cat];
  const n = NOMS[nom];
  const entete = INTRO_COND[form] ?? "";
  const gabarit = FORM_DEDUC[form].replaceAll("{a}", a).replaceAll("{b}", b).replaceAll("{n}", n);
  if (pol === 0) {
    return {
      famille: "deduction",
      prompt: gabarit,
      pensee: [
        "On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine.",
        `Première prémisse : tous les ${a} sont des ${b}.`,
        `Deuxième prémisse : ${n} fait partie des ${a}.`,
        `Ce qui vaut pour tous les ${a} vaut donc aussi pour ${n}.`,
      ],
      reponse: `On peut en déduire que ${n}, comme tous les ${a}, appartient aussi aux ${b}.`,
    };
  }
  return {
    famille: "deduction",
    prompt: `${entete ? entete + " " : ""}Attention, question piège : tous les ${a} sont des ${b}. On annonce que ${n} fait partie des ${b}. Peut-on conclure que ${n} fait partie des ${a} ?`,
    pensee: [
      "On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ?",
      `La règle dit : tous les ${a} sont des ${b} — le sens ${a} → ${b}.`,
      `La question demande le chemin inverse : ${b} → ${a}. Ce n'est pas la même chose.`,
      "Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A.",
      `Rien ne dit que ${n} soit un ${a} : il peut appartenir à une autre partie des ${b}.`,
    ],
    reponse: `Non : on ne peut pas conclure que ${n} fait partie des ${a}. C'est l'erreur classique d'inverser un syllogisme.`,
  };
}

function paireConditionnel(i: number): PairePP {
  const intro = i % INTRO_COND.length;
  const mode = Math.floor(i / INTRO_COND.length) % 2;
  const regle = Math.floor(i / (INTRO_COND.length * 2)) % REGLES.length;
  const [ant, cons] = REGLES[regle];
  const entete = INTRO_COND[intro] ? `${INTRO_COND[intro]} ` : "";
  if (mode === 0) {
    return {
      famille: "conditionnel",
      prompt: `${entete}Si ${ant}, alors ${cons}. Or, on observe que ${ant}. Qu'en déduit-on ?`,
      pensee: [
        "On raisonne par modus ponens : la condition est remplie, la conséquence suit.",
        `Règle : si ${ant}, alors ${cons}.`,
        `Observation : ${ant} — la condition est remplie.`,
        "On applique la règle telle quelle.",
      ],
      reponse: `On en déduit que ${cons}.`,
    };
  }
  return {
    famille: "conditionnel",
    prompt: `${entete}Si ${ant}, alors ${cons}. Or, on constate que ${cons} n'a pas eu lieu. Que peut-on conclure ?`,
    pensee: [
      "On raisonne par modus tollens : nier la conséquence permet de nier la cause.",
      `Règle : si ${ant}, alors ${cons}.`,
      `Observation : ${cons} n'a pas eu lieu.`,
      `Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là.`,
      "Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence.",
    ],
    reponse: `On conclut que ${ant} n'a pas eu lieu.`,
  };
}

const NB_OBS: readonly string[] = ["trois fois", "cinq fois", "dix fois de suite"];

function paireInduction(i: number): PairePP {
  const form = i % 4;
  const nObs = Math.floor(i / 4) % NB_OBS.length;
  const serie = Math.floor(i / (4 * NB_OBS.length)) % INDUCTIONS.length;
  const [obs, gen, domaine] = INDUCTIONS[serie];
  const n = NB_OBS[nObs];
  const entrees = [
    `On a observé ${n} : ${obs}.`,
    `Peut-on en conclure que ${gen} ?`,
    `Indice de domaine : ${domaine}.`,
  ];
  const gabarits = [
    `${entrees[0]} ${entrees[1]} Avec quelle prudence ?`,
    `Induction : ${entrees[0]} ${entrees[1]}`,
    `${entrees[0]} Que peut-on raisonnablement conclure ?`,
    `Série d'observations (${domaine}), ${n} : ${obs}. ${entrees[1]}`,
  ];
  return {
    famille: "induction",
    prompt: gabarits[form],
    pensee: [
      "On raisonne par induction : on généralise à partir d'observations répétées.",
      entrees[0],
      "Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi.",
      "La prudence humaine : conclure « probablement », jamais « certainement ».",
    ],
    reponse: `Il est raisonnable de conclure que ${gen} — c'est une induction probable, pas une certitude.`,
  };
}

function paireAbduction(i: number): PairePP {
  const form = i % 4;
  const obs = Math.floor(i / 4) % ABDUCTIONS.length;
  const [fait, hypotheses, meilleure, verif] = ABDUCTIONS[obs];
  const gabarits = [
    `Voici un fait étrange : ${fait}. Quelle est l'explication la plus plausible ?`,
    `D'où cela peut-il bien venir ? ${fait} — donnez la meilleure hypothèse.`,
    `Enquête : ${fait}. Quelle est l'hypothèse la plus probable, et comment la vérifier ?`,
    `On constate que ${fait}. Raisonnez comme un détective : quelle est l'explication la plus simple ?`,
  ];
  return {
    famille: "abduction",
    prompt: gabarits[form],
    pensee: [
      "On raisonne par abduction : chercher la meilleure explication d'un fait surprenant.",
      `Fait : ${fait}.`,
      `Hypothèses possibles : ${hypotheses[0]} ; ${hypotheses[1]} ; ${hypotheses[2]}.`,
      `La plus plausible : ${meilleure} — elle explique le fait avec le moins de suppositions.`,
      `Comment la vérifier : ${verif}.`,
    ],
    reponse: `L'explication la plus probable est que ${meilleure} ; pour en être sûr : ${verif}.`,
  };
}

function paireAnalogie(i: number): PairePP {
  const sens = i % 2;
  const form = Math.floor(i / 2) % 4;
  const an = Math.floor(i / (2 * 4)) % ANALOGIES.length;
  const [a, b, c, d, rel] = ANALOGIES[an];
  const inverse = sens === 1;
  const x1 = inverse ? c : a;
  const y1 = inverse ? d : b;
  const x2 = inverse ? a : c;
  const y2 = inverse ? b : d;
  const gabarits = [
    `Complétez l'analogie : ${x1} est à ${y1} ce que ${x2} est à quoi ?`,
    `« ${x1} est à ${y1} comme ${x2} est à … » — trouvez le mot manquant.`,
    `Analogie à compléter : ${x1} : ${y1} :: ${x2} : ?`,
    `Trouvez la relation puis la réponse : ${x1} est à ${y1} ce que ${x2} est à quoi ?`,
  ];
  return {
    famille: "analogie",
    prompt: gabarits[form],
    pensee: [
      "On raisonne par analogie : d'abord identifier la relation, ensuite la transférer.",
      `Relation entre ${x1} et ${y1} : ${rel}.`,
      `On cherche la contrepartie de ${x2} qui honore la même relation.`,
      `Vérification : ${x2} se rapporte bien à la réponse comme ${x1} se rapporte à ${y1}.`,
    ],
    reponse: `La réponse est « ${y2} » : la relation (${rel}) est la même.`,
  };
}

const FORM_CAUSE: readonly ((c: string) => string)[] = [
  (c) => `Que se passe-t-il si ${c}, et pourquoi ?`,
  (c) => `Cause à effet : ${c}. Décrivez la conséquence et son mécanisme.`,
  (c) => `Expliquez la chaîne causale quand ${c}.`,
  (c) => `Un enfant demande : « Pourquoi, quand ${c}, quelque chose change ? » Répondez simplement.`,
];

function paireCausalite(i: number): PairePP {
  const form = i % FORM_CAUSE.length;
  const c = Math.floor(i / FORM_CAUSE.length) % CAUSALITES.length;
  const [cause, effet, mecanisme] = CAUSALITES[c];
  return {
    famille: "causalite",
    prompt: FORM_CAUSE[form](cause),
    pensee: [
      "On suit la chaîne cause → effet → mécanisme.",
      `Cause : ${cause}.`,
      `Effet observé : ${effet}.`,
      `Mécanisme : ${mecanisme}.`,
    ],
    reponse: `${effet.charAt(0).toUpperCase()}${effet.slice(1)} — parce que ${mecanisme}.`,
  };
}

function paireSensCommun(i: number): PairePP {
  const form = i % 4;
  const s = Math.floor(i / 4) % SENS_COMMUN.length;
  const [sit, effet, pourquoi] = SENS_COMMUN[s];
  const gabarits = [
    `Que va-t-il se passer si ${sit}, et pourquoi ?`,
    `Bon sens : ${sit}. Prévoyez l'issue et expliquez-la.`,
    `${sit.charAt(0).toUpperCase()}${sit.slice(1)}. Qu'arrive-t-il, et quel en est le principe ?`,
    `Un enfant vous demande ce qui se passe quand ${sit}. Répondez en une explication claire.`,
  ];
  return {
    famille: "sens_commun",
    prompt: gabarits[form],
    pensee: [
      "Le bon sens s'appuie sur l'expérience partagée du monde.",
      `Situation : ${sit}.`,
      `Issue attendue : ${effet}.`,
      `Pourquoi : ${pourquoi}.`,
    ],
    reponse: `${effet.charAt(0).toUpperCase()}${effet.slice(1)} — ${pourquoi}.`,
  };
}

const OBJETS_PRECIEUX: readonly string[] = [
  "un colis", "un cadeau d'anniversaire", "un album photo", "une boîte de chocolats",
  "une lettre importante", "une carte au trésor", "un jouet préféré", "les clés de la voiture",
  "un gâteau maison", "une médaille", "du courrier important", "un livre adoré",
  "un pull tricoté main", "une pièce de collection", "des billets de concert", "un sablier",
  "un carnet de croquis", "un doudou", "un porte-monnaie", "un thermos",
  "un panier de pique-nique", "une petite guitare", "une paire de rollers", "un gobelet magique",
];

const CACHETTES: readonly string[] = [
  "dans l'armoire du couloir", "sous le lit", "dans le tiroir de la commode",
  "au fond du placard de la cuisine", "dans le grenier", "sous l'escalier",
  "derrière le canapé", "dans le coffre de la voiture", "dans la boîte à outils",
  "sous le tapis du salon", "dans la cave", "dans une boîte de biscuits vidée",
  "derrière les livres de la bibliothèque", "dans la poche du manteau",
];

const FORM_ESPRIT: readonly string[] = [
  "Petite histoire : {h}. Que fera {b} ?",
  "{h} — que peut-on prédire sur {b} ?",
  "Théorie de l'esprit : {h} Que va faire {b}, et pourquoi ?",
];

function paireTheorieEsprit(i: number): PairePP {
  const form = i % 3;
  const role = Math.floor(i / 3) % 3;
  const m = Math.floor(i / (3 * 3));
  const cachette = m % CACHETTES.length;
  const objet = Math.floor(m / CACHETTES.length) % OBJETS_PRECIEUX.length;
  const [a, b] = (() => {
    const t = tripleSansRepetition(Math.floor(m / (CACHETTES.length * OBJETS_PRECIEUX.length)), NOMS.length);
    return [NOMS[t[0]], NOMS[t[1]]];
  })();
  const objetNom = OBJETS_PRECIEUX[objet];
  const cachetteNom = CACHETTES[cachette];
  const histoire0 = `${a} cache ${objetNom} ${cachetteNom}. ${b} est dans la pièce et voit tout`;
  const histoire1 = `${a} cache ${objetNom} ${cachetteNom}. ${b} n'était pas dans la pièce au moment du cachage`;
  const histoire2 = `${a} cache ${objetNom} ${cachetteNom}, puis va le raconter à ${b}`;
  const roles = [
    {
      h: `${histoire0}.`,
      p: [
        `${a} cache ${objetNom} ${cachetteNom}.`,
        `${b} est présent et voit tout.`,
        `${b} a donc l'information : il sait où est ${objetNom}.`,
        "On agit d'après ce qu'on sait, pas d'après la réalité seule.",
      ],
      r: `Oui : ${b} cherchera ${objetNom} ${cachetteNom}, car il l'a vu — il sait.`,
    },
    {
      h: `${histoire1}.`,
      p: [
        `${a} cache ${objetNom} ${cachetteNom}, mais ${b} n'a rien vu.`,
        "La croyance de " + b + " est restée à l'ancien état du monde.",
        "Il ne peut pas savoir ce qu'il ignore — c'est la fausse croyance.",
        "Prédire correctement exige de distinguer le monde réel et ce que " + b + " croit.",
      ],
      r: `Non : ${b} ne cherchera pas ${objetNom} ${cachetteNom}, car il n'a pas vu le cachage — il ne sait pas.`,
    },
    {
      h: `${histoire2}.`,
      p: [
        `${b} n'a pas vu le cachage… mais ${a} lui a raconté.`,
        "L'information transmise par le langage met à jour la croyance.",
        "Voir n'est pas la seule source : se faire raconter suffit.",
      ],
      r: `Oui : ${b} cherchera ${objetNom} ${cachetteNom}, car ${a} le lui a raconté — il est informé.`,
    },
  ];
  const r = roles[role];
  const gabarit = FORM_ESPRIT[form].replaceAll("{h}", r.h).replaceAll("{b}", b);
  return { famille: "theorie_esprit", prompt: gabarit, pensee: r.p, reponse: r.r };
}

const FORM_PLAN: readonly string[] = [
  "Comment s'y prendre pour {o} ? Donnez les étapes.",
  "Objectif : {o}. Décomposez le chemin en étapes claires.",
  "Je voudrais {o} — aide-moi à planifier, étape par étape.",
];

function pairePlanification(i: number): PairePP {
  const contrainte = i % 2;
  const form = Math.floor(i / 2) % FORM_PLAN.length;
  const o = Math.floor(i / (2 * FORM_PLAN.length)) % PLANIFICATIONS.length;
  const [objectif, etapes] = PLANIFICATIONS[o];
  const suffixe = contrainte === 1 ? " (avec un petit budget et beaucoup de temps)" : "";
  const prompt = FORM_PLAN[form].replaceAll("{o}", objectif) + suffixe;
  const pensee = [
    "On planifie : objectif → sous-étapes ordonnées, chacune vérifiable.",
    `Objectif : ${objectif}${suffixe}.`,
    ...etapes.map((e, k) => `Étape ${k + 1} : ${e}.`),
    "On garde une marge pour les imprévus : une planification sans réserve est fragile.",
  ];
  const reponse = `Le chemin : ${etapes.join(" → ")}.`;
  return { famille: "planification", prompt, pensee, reponse };
}

const CONTEXTES_MATH: readonly string[] = [
  "Au marché", "À la boulangerie", "Pendant la kermesse", "Au club de lecture",
  "À la ferme", "À la bibliothèque", "Au stand de limonade", "Lors de la vente solidaire",
  "Au tournoi de cartes", "En classe de mathématiques",
];

/** Grilles injectives des nombres (somme, différence, partage, double/moitié). */
const TAILLE_GRILLE = 122; // somme : a,b ∈ [2..123] → 121×121 = 14 641
function grilleSomme(n: number): [number, number] {
  const a = 2 + (n % (TAILLE_GRILLE - 1));
  const b = 2 + Math.floor(n / (TAILLE_GRILLE - 1));
  return [a, b];
}
// différence/partage : paires (a, b) avec 2 ≤ b < a ≤ 174 → 172×173/2 = 14 878
const LIMITE_TRI = 174;
function grilleTriangulaire(n: number): [number, number] {
  let reste = n;
  for (let a = 3; a <= LIMITE_TRI; a++) {
    const nb = a - 2; // b ∈ [2..a-1]
    if (reste < nb) return [a, 2 + reste];
    reste -= nb;
  }
  return [LIMITE_TRI, 2];
}
// double/moitié : mode(2) × k ∈ [1..7 351] → 14 702
const LIMITE_DOUBLE = 7_351;

function paireMathVerbal(i: number): PairePP {
  const type = i % 4;
  const m = Math.floor(i / 4);
  const contexte = m % CONTEXTES_MATH.length;
  const n = Math.floor(m / CONTEXTES_MATH.length);
  const ctx = CONTEXTES_MATH[contexte];
  if (type === 0) {
    const [a, b] = grilleSomme(n);
    return {
      famille: "math_verbal",
      prompt: `${ctx} : quelqu'un dépense ${a} € puis encore ${b} €. Combien a-t-il dépensé en tout ?`,
      pensee: [
        "On repère l'opération : deux dépenses successives s'additionnent.",
        `Première dépense : ${a} €. Seconde : ${b} €.`,
        `Somme : ${a} + ${b} = ${a + b}.`,
      ],
      reponse: `Il a dépensé ${a + b} € au total.`,
    };
  }
  if (type === 1) {
    const [a, b] = grilleTriangulaire(n);
    return {
      famille: "math_verbal",
      prompt: `${ctx} : il avait ${a} € et il en dépense ${b}. Combien lui reste-t-il ?`,
      pensee: [
        "On repère l'opération : dépenser, c'est soustraire de l'argent disponible.",
        `Disponible : ${a} €. Dépensé : ${b} €.`,
        `Reste : ${a} − ${b} = ${a - b}.`,
      ],
      reponse: `Il lui reste ${a - b} €.`,
    };
  }
  if (type === 2) {
    const [a, b] = grilleTriangulaire(n);
    const q = Math.floor(a / b);
    const r = a % b;
    return {
      famille: "math_verbal",
      prompt: `${ctx} : on partage ${a} jetons entre ${b} joueurs équitablement. Combien chacun reçoit-il, et combien reste-t-il ?`,
      pensee: [
        "Un partage équitable, c'est une division euclidienne.",
        `Jetons : ${a}. Joueurs : ${b}.`,
        `Quotient : ${a} ÷ ${b} = ${q}, reste ${r}.`,
      ],
      reponse: r === 0
        ? `Chacun reçoit ${q} jetons, et il ne reste rien.`
        : `Chacun reçoit ${q} jetons, et il reste ${r} jeton${r > 1 ? "s" : ""} de côté.`,
    };
  }
  const mode = n % 2;
  const k = 1 + (Math.floor(n / 2) % LIMITE_DOUBLE);
  return mode === 0
    ? {
        famille: "math_verbal",
        prompt: `${ctx} : on double une quantité de ${k} objets. Combien obtient-on ?`,
        pensee: [
          "Doubler, c'est multiplier par deux.",
          `Quantité : ${k}.`,
          `Double : ${k} × 2 = ${k * 2}.`,
        ],
        reponse: `On obtient ${k * 2} objets.`,
      }
    : {
        famille: "math_verbal",
        prompt: `${ctx} : on répartit ${2 * k} objets en deux tas égaux. Combien par tas ?`,
        pensee: [
          "Prendre la moitié, c'est diviser par deux.",
          `Quantité : ${2 * k}.`,
          `Moitié : ${2 * k} ÷ 2 = ${k}.`,
        ],
        reponse: `Chaque tas contient ${k} objet${k > 1 ? "s" : ""}.`,
      };
}

function pairePragmatique(i: number): PairePP {
  const form = i % 3;
  const e = Math.floor(i / 3) % PRAGMATIQUES.length;
  const [enonce, sens, indice] = PRAGMATIQUES[e];
  const gabarits = [
    `Quelqu'un dit : ${enonce} Qu'a-t-il vraiment voulu dire ?`,
    `On vous lance : ${enonce} Quel est le sens caché ?`,
    `Décodage social : ${enonce} — que faut-il comprendre ?`,
  ];
  return {
    famille: "pragmatique",
    prompt: gabarits[form],
    pensee: [
      "On lit entre les lignes : l'implicite pèse autant que le dit.",
      `Énoncé : ${enonce}`,
      `Sens réel : ${sens}.`,
      `L'indice qui donne le ton : ${indice}.`,
    ],
    reponse: `Le message réel : ${sens} (l'indice : ${indice}).`,
  };
}

function paireEthique(i: number): PairePP {
  const form = i % 3;
  const d = Math.floor(i / 3) % ETHIQUES.length;
  const [situation, tension, conduite] = ETHIQUES[d];
  const gabarits = [
    `Situation : ${situation}. Que faut-il faire, et pourquoi ?`,
    `Dilemme : ${situation}. Quelles valeurs s'affrontent et quelle conduite retenir ?`,
    `Aide-moi à réfléchir : ${situation}. Quelle est la bonne conduite ?`,
  ];
  return {
    famille: "ethique_pratique",
    prompt: gabarits[form],
    pensee: [
      "On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule.",
      `Situation : ${situation}.`,
      `Valeurs en tension : ${tension}.`,
      `Conduite retenue : ${conduite}.`,
    ],
    reponse: `${conduite.charAt(0).toUpperCase()}${conduite.slice(1)}.`,
  };
}

const TYPES_SPATIAUX: readonly ((a: string, b: string, c: string) => { p: string; pensee: string[]; r: string })[] = [
  (a, b, c) => ({
    p: `${a} est assis à gauche de ${b}, qui est assis à gauche de ${c}. Qui est au milieu ?`,
    pensee: [
      "On reconstruit mentalement la chaîne de gauche à droite.",
      `Ordre : ${a}, puis ${b}, puis ${c}.`,
      "Le milieu de la chaîne de trois est le deuxième.",
    ],
    r: `${b} est au milieu.`,
  }),
  (a, b, c) => ({
    p: `Dans une file, ${b} se tient juste devant ${a}, et ${c} se tient juste devant ${b}. Qui est en tête de file ?`,
    pensee: [
      "On reconstruit la file depuis la queue.",
      `Au fond : ${a}. Juste devant lui : ${b}. Devant ${b} : ${c}.`,
      "Le premier est celui devant qui personne ne se trouve.",
    ],
    r: `${c} est en tête de file.`,
  }),
  (a, b, c) => ({
    p: `${a} est à droite de ${b}, et ${c} est à droite de ${a}. Qui est le plus à droite ?`,
    pensee: [
      "On aligne de gauche à droite en suivant les indications.",
      `Ordre de gauche à droite : ${b}, ${a}, ${c}.`,
      "Le plus à droite est le dernier de la chaîne.",
    ],
    r: `${c} est le plus à droite.`,
  }),
];

function paireSpatial(i: number): PairePP {
  const form = i % 4;
  const type = Math.floor(i / 4) % TYPES_SPATIAUX.length;
  const m = Math.floor(i / (4 * TYPES_SPATIAUX.length));
  const [p1, p2, p3] = tripleSansRepetition(m, NOMS.length);
  const [a, b, c] = [NOMS[p1], NOMS[p2], NOMS[p3]];
  const r = TYPES_SPATIAUX[type](a, b, c);
  const gabarits = [
    r.p,
    `Petit casse-tête : ${r.p}`,
    `${r.p} Raisonnez étape par étape.`,
    `Exercice de position : ${r.p}`,
  ];
  return { famille: "spatial", prompt: gabarits[form], pensee: r.pensee, reponse: r.r };
}

function paireTemporel(i: number): PairePP {
  const form = i % 4;
  const m = Math.floor(i / 4);
  const minute = m % 12;
  const heure = Math.floor(m / 12) % 24;
  const dIdx = Math.floor(m / (12 * 24)) % 23;
  // durées : h ∈ [0..5], min ∈ {0,15,30,45}, (0,0) exclu → 23
  const durees: Array<[number, number]> = [];
  for (let h = 0; h <= 5; h++) for (const mm of [0, 15, 30, 45]) if (!(h === 0 && mm === 0)) durees.push([h, mm]);
  const [dh, dm] = durees[dIdx];
  const mm = minute * 5;
  const total = heure * 60 + mm + dh * 60 + dm;
  const ah = Math.floor(total / 60) % 24;
  const am = total % 60;
  const jourSuivant = Math.floor(total / 60) >= 24;
  const gabarits = [
    `Le train part à ${heure} h ${String(mm).padStart(2, "0")} et le trajet dure ${dh} h ${String(dm).padStart(2, "0")}. À quelle heure arrive-t-il ?`,
    `Départ : ${heure} h ${String(mm).padStart(2, "0")}. Durée : ${dh} h ${String(dm).padStart(2, "0")}. Calculez l'heure d'arrivée.`,
    `On part à ${heure} h ${String(mm).padStart(2, "0")} pour un trajet de ${dh} h ${String(dm).padStart(2, "0")}. Heure d'arrivée ?`,
    `Question d'horloge : départ ${heure} h ${String(mm).padStart(2, "0")}, plus ${dh} h ${String(dm).padStart(2, "0")} de route. Quand arrive-t-on ?`,
  ];
  return {
    famille: "temporel",
    prompt: gabarits[form],
    pensee: [
      "On additionne l'heure de départ et la durée, minute par minute.",
      `Départ : ${heure} h ${String(mm).padStart(2, "0")}. Durée : ${dh} h ${String(dm).padStart(2, "0")}.`,
      `Total depuis minuit : ${total} minutes.`,
      `Converti : ${ah} h ${String(am).padStart(2, "0")}${jourSuivant ? " — on a franchi minuit, c'est le jour suivant" : ""}.`,
    ],
    reponse: `Arrivée à ${ah} h ${String(am).padStart(2, "0")}${jourSuivant ? " le jour suivant" : ""}.`,
  };
}

function paireMetacognition(i: number): PairePP {
  const form = i % 3;
  const s = Math.floor(i / 3) % METACOGNITIONS.length;
  const [q, r] = METACOGNITIONS[s];
  const gabarits = [
    `Question de réflexion : ${q}`,
    `${q.charAt(0).toUpperCase()}${q.slice(1)} — peux-tu expliquer comment l'esprit procède ?`,
    `On m'a demandé : ${q} — quelle est la réponse d'un esprit humain réfléchi ?`,
  ];
  return {
    famille: "metacognition",
    prompt: gabarits[form],
    pensee: [
      "On observe l'esprit lui-même : c'est la métacognition.",
      `Question : ${q}`,
      `Réponse : ${r}.`,
    ],
    reponse: `${r.charAt(0).toUpperCase()}${r.slice(1)}.`,
  };
}

function paireResolution(i: number): PairePP {
  const form = i % 3;
  const p = Math.floor(i / 3) % RESOLUTIONS.length;
  const [probleme, methode] = RESOLUTIONS[p];
  const gabarits = [
    `Un souci du quotidien : ${probleme}. Comment s'y prendre ?`,
    `${probleme.charAt(0).toUpperCase()}${probleme.slice(1)}. Quelle méthode de résolution appliquer ?`,
    `Aide-moi : ${probleme}. Quelle démarche ?`,
  ];
  return {
    famille: "resolution_probleme",
    prompt: gabarits[form],
    pensee: [
      "On résout par méthode, pas par hasard : comprendre, isoler, tester.",
      `Problème : ${probleme}.`,
      `Démarche : ${methode}.`,
    ],
    reponse: `${methode.charAt(0).toUpperCase()}${methode.slice(1)}.`,
  };
}

const GENERATEURS: Record<FamilleRaisonnement, (i: number) => PairePP> = {
  deduction: paireDeduction,
  conditionnel: paireConditionnel,
  induction: paireInduction,
  abduction: paireAbduction,
  analogie: paireAnalogie,
  causalite: paireCausalite,
  sens_commun: paireSensCommun,
  theorie_esprit: paireTheorieEsprit,
  planification: pairePlanification,
  math_verbal: paireMathVerbal,
  pragmatique: pairePragmatique,
  ethique_pratique: paireEthique,
  spatial: paireSpatial,
  temporel: paireTemporel,
  metacognition: paireMetacognition,
  resolution_probleme: paireResolution,
};

/** Génère la paire PP d'index `index` (0 ≤ index < capacité) — injectif
 *  et déterministe : le même index produit toujours la même paire. */
export function genererPairePP(
  famille: FamilleRaisonnement,
  index: number,
): PairePP {
  if (index < 0 || index >= CAPACITES[famille]) {
    throw new Error(`Index ${index} hors capacité (${CAPACITES[famille]}) pour ${famille}.`);
  }
  return GENERATEURS[famille](index);
}

// ─── Plan de génération (allocation déterministe du volume cible) ───────────

/** Une famille dans le plan : volume réellement généré + offset global. */
export interface PlanFamille {
  famille: FamilleRaisonnement;
  retenus: number;
  offset: number;
}

export interface PlanGeneration {
  total: number;
  familles: PlanFamille[];
  /** familles placées sous la capacité ; jamais > CAPACITES[f]. */
  verification: { sousCapacite: boolean; somme: number };
}

/**
 * Alloue `total` paires de façon déterministe, sous plafond de capacité.
 * Trois cas :
 *   - total ≥ somme des capacités : chaque famille est utilisée en entier ;
 *   - total ≥ somme des petites capacités (≤ 30 000) : les petites familles
 *     (la diversité humaine du corpus) sont utilisées ENTIÈREMENT, le reste
 *     se répartit proportionnellement entre les grandes familles (théorie
 *     de l'esprit, mathématique verbale, spatial) — c'est le cas du plan à
 *     1 000 000 ;
 *   - sinon (volumes de calibration) : répartition proportionnelle
 *     progressive sous plafond, arrondi redistribué dans l'ordre fixe.
 */
export function planifierGeneration(total: number): PlanGeneration {
  const sommeCaps = FAMILLES_RAISONNEMENT.reduce((s, f) => s + CAPACITES[f], 0);
  const petites = FAMILLES_RAISONNEMENT.filter((f) => CAPACITES[f] <= 30_000);
  const grosses = FAMILLES_RAISONNEMENT.filter((f) => CAPACITES[f] > 30_000);
  const sommePetites = petites.reduce((s, f) => s + CAPACITES[f], 0);
  const quotas = new Map<FamilleRaisonnement, number>();
  if (total >= sommeCaps) {
    for (const f of FAMILLES_RAISONNEMENT) quotas.set(f, CAPACITES[f]);
  } else if (total >= sommePetites) {
    const reste = total - sommePetites;
    for (const f of petites) quotas.set(f, CAPACITES[f]);
    const sommeGrosses = grosses.reduce((s, f) => s + CAPACITES[f], 0);
    const alloue = new Map<FamilleRaisonnement, number>();
    let distribue = 0;
    for (const f of grosses) {
      const q = Math.min(CAPACITES[f], Math.floor((reste * CAPACITES[f]) / sommeGrosses));
      alloue.set(f, q);
      distribue += q;
    }
    // l'arrondi restant va aux grosses familles non saturées, dans l'ordre fixe
    let manque = reste - distribue;
    for (const f of grosses) {
      if (manque === 0) break;
      const libre = CAPACITES[f] - (alloue.get(f) ?? 0);
      const ajoute = Math.min(libre, manque);
      alloue.set(f, (alloue.get(f) ?? 0) + ajoute);
      manque -= ajoute;
    }
    for (const f of grosses) quotas.set(f, alloue.get(f) ?? 0);
  } else {
    let restant = total;
    let actives = [...FAMILLES_RAISONNEMENT];
    while (restant > 0 && actives.length > 0) {
      const lotAvant = restant;
      const somme = actives.reduce((s, f) => s + CAPACITES[f], 0);
      for (const f of actives) {
        const q = Math.min(CAPACITES[f], Math.floor((restant * CAPACITES[f]) / somme));
        quotas.set(f, (quotas.get(f) ?? 0) + q);
        restant -= q;
      }
      for (const f of FAMILLES_RAISONNEMENT) {
        if (restant === 0) break;
        if (!actives.includes(f)) continue;
        const libre = CAPACITES[f] - (quotas.get(f) ?? 0);
        const ajoute = Math.min(libre, restant);
        quotas.set(f, (quotas.get(f) ?? 0) + ajoute);
        restant -= ajoute;
      }
      actives = actives.filter((f) => (quotas.get(f) ?? 0) < CAPACITES[f]);
      if (restant === lotAvant) break; // sécurité (ne devrait jamais survenir)
    }
  }
  const familles: PlanFamille[] = [];
  let offset = 0;
  let sousCapacite = true;
  for (const f of FAMILLES_RAISONNEMENT) {
    const retenus = quotas.get(f) ?? 0;
    if (retenus > CAPACITES[f]) sousCapacite = false;
    familles.push({ famille: f, retenus, offset });
    offset += retenus;
  }
  return { total, familles, verification: { sousCapacite, somme: offset } };
}

/** Génère le lot [debut, fin) du plan — déterministe, appelable par tranches
 *  (génération en flux pour tenir la mémoire du sandbox). */
export function genererLotPP(
  plan: PlanGeneration,
  debut: number,
  fin: number,
): PairePP[] {
  const lot: PairePP[] = [];
  for (let g = Math.max(0, debut); g < Math.min(fin, plan.total); g++) {
    const pf = plan.familles.find((f) => g >= f.offset && g < f.offset + f.retenus);
    if (!pf) continue;
    lot.push(genererPairePP(pf.famille, g - pf.offset));
  }
  return lot;
}

/** Format d'entraînement : pensée numérotée + conclusion. */
export function formaterPensee(p: PairePP): string {
  const etapes = p.pensee.map((e, i) => `${i + 1}) ${e}`).join(" ");
  return `${etapes} Donc : ${p.reponse}`;
}

// ─── Questions de VÉRIFICATION réservées (jamais entraînées) ────────────────

/** Règle de réservation : 3 indices régulièrement espacés par famille
 *  (+1 pour les deux familles les plus grosses) → 50 questions au total
 *  pour le plan à 1 000 000. Aucun indice réservé n'est en début de série. */
export const NOMBRE_EVAL_TOTAL = 50;

export function indicesEvaluation(retenus: number, extra: boolean): number[] {
  if (retenus < 12) return [];
  const base = [
    Math.floor(retenus / 6),
    Math.floor(retenus / 2),
    Math.floor((retenus * 5) / 6),
  ];
  if (extra) base.push(Math.floor((retenus * 7) / 8));
  return Array.from(new Set(base)).sort((a, b) => a - b);
}

/** La famille a-t-elle une question d'éval supplémentaire (règle du plan) ? */
export function evalExtraPour(famille: FamilleRaisonnement): boolean {
  return famille === "theorie_esprit" || famille === "math_verbal";
}
