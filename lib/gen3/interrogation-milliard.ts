/**
 * GÉNÉRATEUR D'INTERROGATION MILLIARD (it.86 — demande propriétaire) :
 * « poser au total 1 milliard de questions pour tous les domaines sur
 * lesquels gen3 a été entraîné ; vérifier si gen3 répond juste ; en cas
 * de mauvaise réponse, corriger dans sa mémoire ».
 *
 * Ce module est la SOURCE DES QUESTIONS : une énumération DÉTERMINISTE
 * d'au moins 1 000 000 000 questions distinctes, chacune avec une réponse
 * VÉRIFIABLE AUTOMATIQUEMENT (calculée par construction). L'index global
 * n ∈ [0, CAPACITE_TOTALE) décode un couple (famille, paramètres) par
 * divisions euclidiennes strictes : l'injectivité est garantie par
 * construction, et une garde vérifie zéro collision sur des dizaines de
 * milliers d'indices dispersés.
 *
 * HONNÊTETÉ D'ÉCHELLE : générer et poser 10⁹ questions via le chat web
 * (HTTP) prendrait des années ; ce générateur fournit la capacité, le
 * script d'interrogation (scripts/interrogation-milliard-it86.ts) pose
 * réellement les questions au moteur local du chat (le même chemin que
 * la production : cortex langagier + méthode de famille), vérifie chaque
 * réponse, corrige la mémoire (paires exactes apprises + ondes SNN) et
 * re-teste. Chaque tick cron accumule le compteur réel via le checkpoint
 * — zéro chiffre fantôme : seul ce qui a été réellement interrogé est
 * compté.
 *
 * Module PUR : aucune dépendance Node, déterministe, sans état global.
 */

// ─── Familles interrogées (toutes tirées des domaines d'entraînement) ───────

/** Familles interrogées — chacune correspond à une famille PP apprise en
 * it.85 et détectable par la méthode générique (lib/gen3/familles-methodes). */
export const FAMILLES_MILLIARD = [
  "math_verbal",
  "deduction",
  "conditionnel",
  "spatial",
  "temporel",
  "analogie",
  "causalite",
  "planification",
] as const;

export type FamilleMilliard = (typeof FAMILLES_MILLIARD)[number];

/** Capacité minimale exigée par la demande propriétaire. */
export const CAPACITE_MIN_MILLIARD = 1_000_000_000;

/** L'ordre total du balayage de la demande : 1 milliard de questions.
 * La stratification s'appuie sur cet ordre (reprise entre ticks : chaque
 * question de rang j est UNIQUE, où que le balayage s'arrête). */
export const N_TOTAL_MILLIARD = 1_000_000_000;

/** Nombre maximal de corrections retenues en mémoire vive par run (les
 * corrections au-delà sont COMPTEES mais non retenues — RAM bornée). */
export const MAX_CORRECTIONS_MEMOIRE = 120_000;

// ─── Vocabulaires compacts (réels, français) ─────────────────────────────────

const NOMS = [
  "Léa", "Théo", "Amine", "Sofia", "Karim", "Nina", "Marc", "Ida",
  "Youssef", "Lina", "Paul", "Rania", "Hugo", "Fatou", "Adam", "Mia",
  "Noé", "Sarah", "Luc", "Aïcha", "Bruno", "Yasmine", "Victor", "Clara",
] as const;

/** Registres de syllogismes : [membre, catégorie englobante]. */
const REGISTRES_DEDUCTION: ReadonlyArray<readonly [string, string]> = [
  ["oiseaux", "animaux"],
  ["chats", "félins"],
  ["dauphins", "mammifères"],
  ["requins", "poissons"],
  ["mangues", "fruits"],
  ["citrons", "agrumes"],
  ["tabourets", "sièges"],
  ["stylos", "outils d'écriture"],
  ["marteaux", "outils"],
  ["cuillères", "ustensiles"],
  ["violonistes", "musiciens"],
  ["chirurgiens", "médecins"],
  ["peintres", "artistes"],
  ["boulangers", "artisans"],
  ["vélos", "véhicules légers"],
  ["camions", "véhicules utilitaires"],
  ["hélicoptères", "aéronefs"],
  ["canots", "bateaux"],
  ["tulipes", "fleurs"],
  ["chênes", "arbres"],
  ["salades", "légumes-feuilles"],
  ["cactus", "plantes grasses"],
  ["saxophones", "instruments à vent"],
  ["flûtes", "instruments à vent"],
];

/** Règles conditionnelles : [si, alors, sansSi, sansAlors]. */
const REGLES_CONDITIONNELLES: ReadonlyArray<{
  si: string;
  alors: string;
  sansSi: string;
  sansAlors: string;
}> = [
  { si: "il pleut", alors: "les rues sont mouillées", sansSi: "les rues sont sèches", sansAlors: "il ne pleut pas" },
  { si: "la porte est fermée à clé", alors: "on ne peut pas entrer sans la clé", sansSi: "on est entré sans la clé", sansAlors: "la porte n'était pas fermée à clé" },
  { si: "le réservoir est vide", alors: "la voiture s'arrête", sansSi: "la voiture continue de rouler", sansAlors: "le réservoir n'est pas vide" },
  { si: "le fruit est mûr", alors: "il est sucré", sansSi: "il n'est pas sucré", sansAlors: "le fruit n'est pas mûr" },
  { si: "le réveil ne sonne pas", alors: "on se lève tard", sansSi: "on s'est levé tôt", sansAlors: "le réveil a sonné" },
  { si: "il gèle la nuit", alors: "les flaques deviennent de la glace", sansSi: "les flaques sont restées liquides", sansAlors: "il n'a pas gelé" },
  { si: "on arrose les plantes", alors: "elles poussent mieux", sansSi: "elles n'ont pas poussé", sansAlors: "on ne les a pas arrosées" },
  { si: "l'électricité est coupée", alors: "les lampes s'éteignent", sansSi: "les lampes éclairent", sansAlors: "l'électricité n'est pas coupée" },
  { si: "l'orage éclate", alors: "les pêcheurs rentrent au port", sansSi: "les pêcheurs restent en mer", sansAlors: "l'orage n'a pas éclaté" },
  { si: "la pâte repose une nuit", alors: "elle lève mieux", sansSi: "elle n'a pas levé", sansAlors: "la pâte n'a pas reposé" },
  { si: "le miroir est cassé", alors: "il reflète mal", sansSi: "il reflète bien", sansAlors: "le miroir n'est pas cassé" },
  { si: "le sac dépasse le poids autorisé", alors: "la compagnie facture un supplément", sansSi: "aucun supplément a été facturé", sansAlors: "le sac n'a pas dépassé le poids" },
];

const DIRECTIONS = ["nord", "est", "sud", "ouest"] as const;
const MOUVEMENTS = ["gauche", "droite", "demi-tour"] as const;

/** Modèles d'analogie : [A, B, C, D] — « A est à B ce que C est à D ». */
const ANALOGIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["le chat", "le chaton", "la chienne", "le chiot"],
  ["la vache", "le veau", "la jument", "le poulain"],
  ["la poule", "le poussin", "l'ours", "l'ourson"],
  ["le chien", "l'aboiement", "le chat", "le miaulement"],
  ["le poisson", "la nageoire", "l'oiseau", "l'aile"],
  ["la fleur", "le parfum", "la cloche", "le son"],
  ["le boulanger", "le pain", "le menuisier", "la table"],
  ["le peintre", "la toile", "l'écrivain", "le roman"],
  ["la plume", "l'écriture", "le pinceau", "la peinture"],
  ["l'eau", "la rivière", "la neige", "le flocon"],
  ["le soleil", "le jour", "la lune", "la nuit"],
  ["la graine", "l'arbre", "l'œuf", "la poule"],
  ["le médecin", "le stéthoscope", "le menuisier", "le marteau"],
  ["la clef", "la serrure", "la carte", "la porte d'hôtel"],
  ["le capitaine", "le navire", "le pilote", "l'avion"],
  ["le livre", "la page", "la chaîne", "le maillon"],
  ["la racine", "la plante", "la fondation", "la maison"],
  ["le four", "la cuisson", "le congélateur", "la conservation"],
  ["l'ombrelle", "le soleil", "l'imperméable", "la pluie"],
  ["le galop", "le cheval", "le vol", "l'oiseau"],
  ["le nid", "l'oiseau", "la ruche", "l'abeille"],
  ["la larve", "le papillon", "le têtard", "la grenouille"],
  ["le sommet", "la montagne", "la rive", "le lac"],
  ["le fil", "l'aiguille", "la manivelle", "le moulin"],
  ["l'épice", "le plat", "la teinte", "la peinture"],
  ["le train", "les rails", "le bateau", "les flots"],
  ["la neige", "le flocon", "le sable", "le grain"],
  ["le sourire", "la joie", "la larme", "le chagrin"],
  ["l'olivier", "l'huile", "la canne", "le sucre"],
  ["l'abeille", "la ruche", "la fourmi", "la fourmilière"],
  ["l'étoile", "la constellation", "le mot", "la phrase"],
  ["le tambour", "le rythme", "la lyre", "la mélodie"],
  ["le vent", "la voile", "le moteur", "l'hélice"],
  ["la courge", "le potiron", "le chien", "le chiot"],
  ["l'île", "l'archipel", "la perle", "le collier"],
  ["le brouillard", "la visibilité", "le silence", "l'ouïe"],
  ["la pluie", "l'arc-en-ciel", "l'épreuve", "l'espoir"],
  ["la besace", "l'épaule", "la couronne", "la tête"],
  ["le lierre", "le mur", "la barbe", "le menton"],
  ["la boussole", "le navigateur", "la recette", "le cuisinier"],
];

/** Chaînes causales : [cause, intermédiaire, effet final]. */
const CHAINES_CAUSALES: ReadonlyArray<readonly [string, string, string]> = [
  ["un nouveau barrage a été construit", "les sédiments se sont accumulés en amont", "les champs en aval sont plus verts mais les pêcheurs attrapent moins de poissons"],
  ["une gelée précoce est tombée en avril", "les fleurs des vergers ont gelé", "la récolte de pommes sera bien plus petite"],
  ["une nouvelle ligne de bus a ouvert", "les commerces du quartier sont mieux desservis", "le marché du samedi attire deux fois plus de monde"],
  ["l'usine a réduit ses rejets dans le fleuve", "l'eau est redevenue plus claire", "les hérons sont revenus piquer du poisson au bord"],
  ["un prix du carburant plus élevé", "les trajets en voiture coûtent plus cher", "de plus en plus de familles prennent le train"],
  ["un été très sec a duré trois mois", "les nappes phréatiques se sont vidées", "les puits de campagne sont presque à sec"],
  ["une épidémie a touché les élevages de volailles", "les fermes ont été mises en quarantaine", "les œufs sont devenus plus chers au marché"],
  ["la ville a planté des arbres sur l'avenue", "l'asphalte est moins exposé au soleil", "les passants viennent s'asseoir sous l'ombre fraîche"],
  ["une plateforme de livraison a ouvert dans le quartier", "les restaurants ont élargi leur clientèle", "les cours de cuisine de midi se sont vides"],
  ["les parents ont baissé le temps d'écran", "les enfants ont cherché d'autres activités", "la bibliothèque du quartier a vu plus de jeunes lecteurs"],
  ["un coursier a arrosé les jardins chaque soir", "la terre a gardé son humidité", "les tomates ont grossi sans se fendre"],
  ["l'école a décalé la rentrée d'une heure", "les enfants dorment plus le matin", "les professeurs notent moins de bâillements en classe"],
  ["une tornade a traversé la vallée", "les toits des granges ont soufflé", "les assureurs ont ouvert des centaines de dossiers"],
  ["la marine a limité la pêche au large", "les bancs de poissons se sont reconstitués", "les prises des pêcheurs côtiers ont remonté"],
  ["un four à pain s'est installé sur la place", "une odeur de pain flotte le matin", "les passants s'arrêtent avant même d'ouvrir la boulangerie"],
  ["le syndicat a négocié une prime de transport", "venir à l'usine coûte moins cher", "le parking du site est plein dès 7 heures"],
  ["une tempête de sable a recouvert les pistes", "les avions ont été cloués au sol", "les touristes ont visité le musée plutôt que les dunes"],
  ["les voisins ont nourri les chats errants", "les rongeurs se sont faits plus discrets", "les potagers du quartier ont mieux survécu"],
  ["un cours de natation gratuit a ouvert", "les enfants savent mieux nager", "les sauveteurs de la plage signalent moins de paniques"],
  ["la mairie a remplacé les ampoules par des LED", "les lampadaires consomment moins", "la facture d'éclairage public a baissé d'un tiers"],
  ["un verger a perdu ses abeilles", "les fleurs n'ont pas été fécondées", "les pommiers n'ont presque rien donné"],
  ["le fleuve a débordé après les fortes pluies", "les champs bas se sont couverts d'eau", "les fermiers ont semé plus tard que d'habitude"],
  ["la scierie a fermé pour trois mois", "le bois local manque de transformation", "les charpentiers commandent leur bois plus loin"],
  ["une piste cyclable relie les villages", "les trajets courts ne se font plus en voiture", "le brouillard du matin est moins épais d'échappements"],
  ["la sécheresse a fissuré l'argile du barrage", "l'eau filtre par les fissures", "le niveau du réservoir baisse même sans irrigation"],
  ["une école de musique a ouvert ses portes", "les enfants louent des instruments", "la maison de quartier résonne de gammes le mercredi"],
  ["l'autoroute a été déviée à l'extérieur de la ville", "les camions ne traversent plus le centre", "les terrasses du boulevard sont plus calmes"],
  ["les agriculteurs ont semé des haies", "le vent balaie moins les terres", "les oiseaux nicheurs sont revenus entre les parcelles"],
  ["une fuite de gaz a été réparée dans l'immeuble", "l'odeur a disparu des cages d'escalier", "les locataires ne dorment plus fenêtre ouverte"],
  ["le musée est devenu gratuit le dimanche", "les familles s'y pressent en fin de semaine", "les guides demandent des renforts pour les visites"],
  ["un cratère s'est formé sur la route forestière", "les camionnettes font un grand détour", "les braconniers évitent la zone par prudence"],
  ["les techniques de goutte-à-goutte ont été adoptées", "chaque plante reçoit juste ce qu'il faut d'eau", "la facture d'eau des fermes a chuté"],
  ["une usine de vélos a embauché dans la ville minière", "les anciens mineurs ont été formés", "le chômage du bassin a nettement baissé"],
  ["les marées ont charrié beaucoup de sable", "l'embouchure s'est ensablée", "les barques de pêche accostent plus loin du village"],
  ["un atelier d'écriture a démarré à la maison de retraite", "les résidents racontent leur jeunesse", "les petits-enfants reçoivent des cahiers d'histoires"],
  ["la pergola a été couverte de vignes", "la terrasse est restée à l'ombre", "les clients du café restent bien après midi"],
  ["les forages ont puisé l'eau du lac salé", "la nappe douce s'est mélangée au sel", "les puits du village donnent une eau imbuvable"],
  ["une procession a bloqué le vieux pont", "les voitures ont fait demi-tour", "les échoppes du marché ont vendu plus tôt"],
  ["le professeur a introduit les jeux de logique", "les élèves s'affrontent en défis", "les notes de mathématiques de la classe ont grimpé"],
];

/** Objectifs de planification : [objectif, étapes numérotées]. */
const PLANIFICATIONS: ReadonlyArray<readonly [string, string]> = [
  ["organiser un pique-nique", "1) Choisir le lieu et la date. 2) Lister les provisions. 3) Faire les courses la veille. 4) Préparer la glacière le matin. Donc : le pique-nique est prêt sans course de dernière minute."],
  ["apprendre un morceau de piano", "1) Découper le morceau en phrases musicales. 2) Travailler main droite puis main gauche. 3) Assembler à vitesse réduite. 4) Monter le tempo jour après jour. Donc : le morceau arrive propre au bon tempo."],
  ["préparer un examen de deux semaines", "1) Lister les chapitres. 2) Planifier deux chapitres par jour. 3) Réviser les fiches chaque soir. 4) S'entraîner sur les anciens sujets le dernier week-end. Donc : l'examen se prépare sans surcharge."],
  ["monter une étagère", "1) Déballer et compter les pièces. 2) Lire la notice de bout en bout. 3) Fixer les côtés avant le fond. 4) Visser sans serrer puis serrer en croix. Donc : l'étagère est droite et solide."],
  ["repeindre un couloir", "1) Protéger le sol. 2) Reboucher les trous et poncer. 3) Poser une sous-couche. 4) Peindre en deux couches croisées. Donc : la finition est régulière."],
  ["planter un potager", "1) Choisir l'endroit le plus ensoleillé. 2) Aérer la terre et retirer les cailloux. 3) Planter selon les distances de la notice. 4) Arroser le soir les premières semaines. Donc : les plants prennent."],
  ["organiser un anniversaire d'enfant", "1) Fixer la date et le nombre d'invités. 2) Préparer les jeux et le gâteau. 3) Décorer avant l'arrivée. 4) Garder un temps calme avant le départ. Donc : la fête reste joyeuse du début à la fin."],
  ["partir en randonnée d'une journée", "1) Vérifier la météo et l'itinéraire. 2) Préparer eau, casse-croûte et carte. 3) Partir tôt. 4) Prévenir quelqu'un de l'heure de retour. Donc : la marche se fait en sécurité."],
  ["économiser pour un vélo", "1) Fixer le prix à atteindre. 2) Choisir une mise de côté par semaine. 3) Suivre le total sur une fiche. 4) Acheter quand la cible est atteinte. Donc : l'achat ne met pas le budget en désordre."],
  ["installer une nouvelle application", "1) Vérifier l'espace disponible. 2) Télécharger depuis la source officielle. 3) Lire les permissions demandées. 4) Créer le compte et tester. Donc : l'installation est sûre et fonctionnelle."],
  ["préparer une valise de cabine", "1) Vérifier les dimensions autorisées. 2) Rouler les vêtements pour gagner de la place. 3) Mettre les liquides dans un sac transparent. 4) Garder les documents en poche extérieure. Donc : l'embarquement se fait sans stress."],
  ["nettoyer un aquarium", "1) Débrancher le chauffage. 2) Prélever un tiers de l'eau. 3) Rincer la mousse du filtre à l'eau retirée. 4) Reconstituer l'eau à température. Donc : les poissons gardent leur équilibre."],
  ["organiser un déménagement", "1) Réserver le véhicule un mois avant. 2) Empaqueter pièce par pièce avec des étiquettes. 3) Prévenir les organismes du changement d'adresse. 4) Prévoir le chargement des meubles lourds en premier. Donc : l'emménagement se déroule sans chaos."],
  ["apprendre vingt mots d'une langue", "1) Choisir dix mots du matin et dix du soir. 2) Les écrire en phrases. 3) Se les réciter en marchant. 4) Revoir les oubliés le lendemain. Donc : les mots restent en mémoire."],
  ["fabriquer une cabane d'oiseaux", "1) Récupérer des planches propres. 2) Découper selon le plan. 3) Assembler sans clous saillants. 4) Fixer à hauteur, hors portée des chats. Donc : les oiseaux s'y installent."],
  ["préparer un itinéraire de ville en trois jours", "1) Regrouper les visites par quartier. 2) Réserver les sites à créneaux. 3) Prévoir une marge de pluie. 4) Laisser une demi-journée libre. Donc : le séjour respire."],
  ["recycler le verre de la maison", "1) Installer trois bacs distincts. 2) Rincer les bocaux. 3) Retirer les bouchons. 4) Déposer les bacs le jour de collecte. Donc : le verre part bien au recyclage."],
  ["organiser un match de quartier", "1) Trouver le terrain et l'horaire. 2) Constituer deux équipes équilibrées. 3) Prévoir ballon et gilets. 4) Nommer un arbitre. Donc : le match se joue dans la bonne humeur."],
  ["réparer une bicyclette qui grince", "1) Identifier la source du bruit en pédalant. 2) Nettoyer et graisser la chaîne. 3) Resserrer les pédales. 4) Tester à vide. Donc : le grincement disparaît."],
  ["créer un pot de fleurs suspendu", "1) Choisir un pot léger. 2) Attacher trois cordes égales. 3) Nouer au-dessus du centre de gravité. 4) Accrocher à un crochet solide. Donc : le pot tient droit."],
  ["préparer le goûter de dix enfants", "1) Compter une part et demie par enfant. 2) Préparer la veille. 3) Prévoir une alternative sans allergène. 4) Dresser la table avant l'arrivée. Donc : personne ne reste sans part."],
  ["traverser une ville inconnue à pied", "1) Repérer la direction générale avec la carte. 2) Suivre les grands axes. 3) Confirmer à chaque carrefour. 4) Garder la batterie du téléphone. Donc : on arrive sans se perdre."],
  ["monter un film de vacances", "1) Choisir les meilleures prises. 2) Ranger les scènes par lieu et jour. 3) Couper les longueurs. 4) Ajouter une musique discrète. Donc : le montage est agréable à regarder."],
  ["organiser un vide-grenier familial", "1) Trier en trois piles : vendre, donner, jeter. 2) Étiqueter les prix la veille. 3) Réserver l'emplacement. 4) Prévoir monnaie et sacs. Donc : la journée se passe sans énervement."],
  ["planter un citronnier en pot", "1) Choisir un pot percé. 2) Poser une couche de billes d'argile. 3) Utiliser un terreau agrumes. 4) Arroser modérément et exposer au soleil. Donc : l'arbre s'installe bien."],
  ["rechercher un ancien camarade", "1) Lister les indices connus. 2) Contacter les amis communs. 3) Vérifier les réseaux professionnels. 4) Écrire un message courtois. Donc : la recherche reste organisée et respectueuse."],
  ["préparer un exposé sur les volcans", "1) Choisir trois idées principales. 2) Rassembler une image par idée. 3) Écrire une phrase par diapositive. 4) S'entraîner à voix haute une fois. Donc : l'exposé tient dans le temps imparti."],
  ["surveiller la consommation d'électricité", "1) Relever le compteur le même jour chaque semaine. 2) Noter les écarts. 3) Comparer aux usages du foyer. 4) Repérer l'appareil inhabituel. Donc : la consommation redevient maîtrisée."],
  ["restaurer un vieux banc de jardin", "1) Brosser la mousse. 2) Poncer le bois. 3) Appliquer un traitement. 4) Vernir par temps sec. Donc : le banc retrouve une seconde vie."],
  ["apprendre à jongler à trois balles", "1) Commencer avec une balle en cascade. 2) Passer à deux balles en main droite. 3) Lancer la troisième sous la précédente. 4) Répéter lentement sans avancer. Donc : les trois balles s'enchaînent."],
];

// ─── Capacités exactes (calculées, sans nombre magique) ─────────────────────

function espacesMathVerbal(): Record<string, number> {
  const addition = 3 * 5999 * 5999; // A ∈ [2..6000], B ∈ [2..6000], 3 formulations
  const soustraction = 2 * (() => {
    let s = 0;
    for (let a = 101; a <= 9999; a++) s += a - 10; // B ∈ [10..a-1]
    return s;
  })();
  const multiplication = 3 * 399 * 799; // N ∈ [2..400], prix ∈ [2..800]
  const partage = 2 * 95 * 95; // d ∈ [2..96], q ∈ [2..96]
  const benefice = 2 * 499 * 900 * 200; // a ∈ [2..500], coût ∈ [1..900], marge ∈ [1..200]
  const chaine = 2 * 2500 * 2500 * 120; // 2 formes, a,b ∈ [1..2500], c ∈ [1..120]
  return { addition, soustraction, multiplication, partage, benefice, chaine };
}

const ESPACES_MATH = espacesMathVerbal();
const CAP_MATH_VERBAL = Object.values(ESPACES_MATH).reduce((a, b) => a + b, 0);

const CAP_DEDUCTION = REGISTRES_DEDUCTION.length * NOMS.length * 2;
const CAP_CONDITIONNEL = REGLES_CONDITIONNELLES.length * NOMS.length * 2;
const CAP_SPATIAL = DIRECTIONS.length * 243 * NOMS.length; // 3^5 séquences
const CAP_TEMPOREL = 24 * 12 * 36;
const CAP_ANALOGIE = ANALOGIES.length * 2;
const CAP_CAUSALITE = CHAINES_CAUSALES.length * 2;
const CAP_PLANIFICATION = PLANIFICATIONS.length * 2;

/** Capacité exacte par famille (mesurable, aucune constante magique). */
export function capaciteParFamille(): Record<FamilleMilliard, number> {
  return {
    math_verbal: CAP_MATH_VERBAL,
    deduction: CAP_DEDUCTION,
    conditionnel: CAP_CONDITIONNEL,
    spatial: CAP_SPATIAL,
    temporel: CAP_TEMPOREL,
    analogie: CAP_ANALOGIE,
    causalite: CAP_CAUSALITE,
    planification: CAP_PLANIFICATION,
  };
}

/** Capacité totale de l'espace d'interrogation (≥ 1 milliard exigé). */
export function capaciteTotale(): number {
  return Object.values(capaciteParFamille()).reduce((a, b) => a + b, 0);
}

/** Bornes cumulées [début, fin) de chaque famille dans l'espace d'index. */
export function bornesParFamille(): Record<FamilleMilliard, readonly [number, number]> {
  const caps = capaciteParFamille();
  const bornes = {} as Record<FamilleMilliard, readonly [number, number]>;
  let acc = 0;
  for (const f of FAMILLES_MILLIARD) {
    bornes[f] = [acc, acc + caps[f]];
    acc += caps[f];
  }
  return bornes;
}

// ─── Décodage par famille (divisions euclidiennes strictes) ─────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Cumuls précalculés (paresseux) pour le décodage O(log n) de la
 * soustraction : cumuls[i] = Σ largeurs pour a ∈ [101..100+i], largeur(a) = a−10. */
let CUMULS_SOUSTRACTION: number[] | null = null;
function cumulsSoustraction(): number[] {
  if (CUMULS_SOUSTRACTION) return CUMULS_SOUSTRACTION;
  const cumuls: number[] = [];
  let s = 0;
  for (let a = 101; a <= 9999; a++) {
    s += a - 10;
    cumuls.push(s);
  }
  CUMULS_SOUSTRACTION = cumuls;
  return cumuls;
}

interface Decodage {
  prompt: string;
  extraits: string[];
  pensee: string;
  reponse: string;
}

function decoderMathVerbal(k: number): Decodage {
  const { addition, soustraction, multiplication, partage, benefice } = ESPACES_MATH;
  if (k < addition) {
    const gab = k % 3;
    const reste = Math.floor(k / 3);
    const a = 2 + (reste % 5999);
    const b = 2 + Math.floor(reste / 5999) % 5999;
    const total = a + b;
    const prompts = [
      `${a} touristes arrivent le matin et ${b} autres l'après-midi. Combien de touristes en tout ?`,
      `Un entrepôt reçoit ${a} paquets le lundi et ${b} paquets le mardi. Combien de paquets au total ?`,
      `${a} enfants mangent à la cantine le midi et ${b} le soir. Combien de repas sont servis en tout ?`,
    ];
    return {
      prompt: prompts[gab],
      extraits: [String(total)],
      pensee: `1) On repère l'opération : deux quantités s'additionnent. 2) Première quantité : ${a}. Seconde : ${b}. 3) Somme : ${a} + ${b} = ${total}.`,
      reponse: `Donc : il y a ${total} en tout.`,
    };
  }
  if (k < addition + soustraction) {
    const gab = k % 2;
    const reste = Math.floor(k / 2);
    // décodage du triangle (a, b) : a ∈ [101..9999], b ∈ [10..a-1] —
    // cumuls précalculés + dichotomie : O(log n) par question.
    let r = reste;
    const cumuls = cumulsSoustraction();
    let lo = 0;
    let hi = cumuls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumuls[mid] <= r) lo = mid + 1;
      else hi = mid;
    }
    const a = 101 + lo;
    const avant = lo === 0 ? 0 : cumuls[lo - 1];
    r = r - avant;
    const b = 10 + r;
    const reste2 = a - b;
    const prompts = [
      `Un artisan avait ${a} francs dans sa caisse. Il dépense ${b} francs en outillage. Combien lui reste-t-il ?`,
      `Léa avait économisé ${a} francs. Elle achète un livre à ${b} francs. Combien d'argent lui reste-t-il ?`,
    ];
    return {
      prompt: prompts[gab],
      extraits: [String(reste2)],
      pensee: `1) On repère l'opération : une dépense se soustrait. 2) Avant : ${a} francs. Dépense : ${b} francs. 3) Reste : ${a} − ${b} = ${reste2}.`,
      reponse: `Donc : il reste ${reste2} francs.`,
    };
  }
  if (k < addition + soustraction + multiplication) {
    const gab = k % 3;
    const reste = Math.floor(k / 3);
    const n = 2 + (reste % 399);
    const prix = 2 + Math.floor(reste / 399) % 799;
    const total = n * prix;
    const prompts = [
      `Un vendeur expédie ${n} colis à ${prix} francs l'expédition. Quel est le montant total ?`,
      `Une classe commande ${n} cahiers à ${prix} francs le cahier. Combien paiera-t-elle en tout ?`,
      `Une cantine prépare ${n} plateaux à ${prix} francs le plateau. Quel est le coût total ?`,
    ];
    return {
      prompt: prompts[gab],
      extraits: [String(total)],
      pensee: `1) On repère l'opération : un prix unitaire se multiplie par la quantité. 2) Quantité : ${n}. Prix unitaire : ${prix} francs. 3) Total : ${n} × ${prix} = ${total}.`,
      reponse: `Donc : le montant total est de ${total} francs.`,
    };
  }
  const cumulPartage = addition + soustraction + multiplication + partage;
  if (k < cumulPartage) {
    const gab = k % 2;
    const reste = Math.floor(k / 2);
    const d = 2 + (reste % 95);
    const q = 2 + Math.floor(reste / 95) % 95;
    const total = d * q;
    const prompts = [
      `${total} bonbons sont partagés également entre ${d} enfants. Combien de bonbons pour chaque enfant ?`,
      `${total} graines sont semées dans ${d} carrés identiques, pareil partout. Combien de graines par carré ?`,
    ];
    return {
      prompt: prompts[gab],
      extraits: [String(q)],
      pensee: `1) On repère l'opération : un partage équitable se divise. 2) Total : ${total}. Nombre de parts : ${d}. 3) Division : ${total} ÷ ${d} = ${q}.`,
      reponse: `Donc : chaque part compte ${q}.`,
    };
  }
  const cumulBenefice = cumulPartage + benefice;
  if (k < cumulBenefice) {
    const gab = k % 2;
    const reste = Math.floor(k / 2);
    const a = 2 + (reste % 499);
    const b = 1 + Math.floor(reste / 499) % 900;
    const marge = 1 + Math.floor(reste / (499 * 900)) % 200;
    const coutTotal = a * b;
    const recette = a * (b + marge);
    const benef = recette - coutTotal;
    const prompts = [
      `Un commerçant achète ${a} cartons à ${b} francs le carton et revend chaque carton ${b + marge} francs. Quel est son bénéfice ?`,
      `Une vendeuse paie ${a} paniers ${b} francs l'un et les revend ${b + marge} francs chacun. Quel bénéfice fait-elle ?`,
    ];
    return {
      prompt: prompts[gab],
      extraits: [String(benef)],
      pensee: `1) Données : ${a} unités, achat ${b} francs, revente ${b + marge} francs. 2) Coût total : ${a} × ${b} = ${coutTotal}. 3) Recette : ${a} × ${b + marge} = ${recette}. 4) Bénéfice : ${recette} − ${coutTotal} = ${benef}.`,
      reponse: `Donc : le bénéfice est de ${benef} francs.`,
    };
  }
  const gab = k % 2;
  const reste = Math.floor(k / 2);
  const a = 1 + (reste % 2500);
  const b = 1 + Math.floor(reste / 2500) % 2500;
  const c = 1 + Math.floor(reste / (2500 * 2500)) % 120;
  if (gab === 0) {
    const total = a * b + c;
    return {
      prompt: `Une école commande ${a} manuels à ${b} francs l'unité, plus ${c} francs de livraison. Quel est le montant total de la commande ?`,
      extraits: [String(total)],
      pensee: `1) Coût des manuels : ${a} × ${b} = ${a * b}. 2) Livraison : ${c} francs. 3) Total : ${a * b} + ${c} = ${total}.`,
      reponse: `Donc : la commande coûte ${total} francs en tout.`,
    };
  }
  const total = (a + b) * c;
  return {
    prompt: `Un atelier assemble ${a} boîtes le matin et ${b} l'après-midi, chaque boîte valant ${c} francs. Quelle est la valeur totale produite dans la journée ?`,
    extraits: [String(total)],
    pensee: `1) Production du jour : ${a} + ${b} = ${a + b}. 2) Valeur : (${a} + ${b}) × ${c} = ${total}.`,
    reponse: `Donc : la journée produit pour ${total} francs.`,
  };
}

const PRONOMS_MASCULINS = new Set([
  "Théo", "Amine", "Karim", "Marc", "Youssef", "Paul", "Hugo", "Adam",
  "Noé", "Luc", "Bruno", "Victor",
]);

function decoderDeduction(k: number): Decodage {
  const gab = k % 2;
  const reste = Math.floor(k / 2);
  const nom = NOMS[reste % NOMS.length];
  const reg = REGISTRES_DEDUCTION[Math.floor(reste / NOMS.length) % REGISTRES_DEDUCTION.length];
  const [membre, categorie] = reg;
  if (gab === 0) {
    return {
      prompt: `Tous les ${membre} sont des ${categorie}. ${nom} fait partie des ${membre}. Qu'est-ce qu'on peut en déduire sur ${nom} ?`,
      extraits: [`appartient aussi aux ${categorie}`, `est un ${categorie}`, `fait partie des ${categorie}`],
      pensee: `1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les ${membre} sont des ${categorie}. 3) Deuxième prémisse : ${nom} fait partie des ${membre}. 4) Ce qui vaut pour tous les ${membre} vaut donc aussi pour ${nom}.`,
      reponse: `Donc : ${nom}, comme tous les ${membre}, appartient aussi aux ${categorie}.`,
    };
  }
  return {
    prompt: `Tous les ${membre} sont des ${categorie}. ${nom} fait partie des ${categorie}. Peut-on conclure que ${nom} fait partie des ${membre} ?`,
    extraits: ["n'est pas valide", "on ne peut pas conclure", "pas nécessairement"],
    pensee: `1) Attention au piège de la converse : de « tous les ${membre} sont des ${categorie} », on ne peut PAS déduire que tous les ${categorie} sont des ${membre}. 2) ${nom} appartient aux ${categorie}, mais peut faire partie d'autres groupes de ${categorie} sans être un ${membre.slice(0, -1)}.`,
    reponse: `Donc : la conclusion n'est pas valide — on ne peut pas conclure que ${nom} fait partie des ${membre}.`,
  };
}

function decoderConditionnel(k: number): Decodage {
  const gab = k % 2;
  const reste = Math.floor(k / 2);
  const nom = NOMS[reste % NOMS.length];
  const regle = REGLES_CONDITIONNELLES[Math.floor(reste / NOMS.length) % REGLES_CONDITIONNELLES.length];
  if (gab === 0) {
    return {
      prompt: `On sait que si ${regle.si}, alors ${regle.alors}. Or pour ${nom}, ${regle.si}. Que peut-on conclure ?`,
      extraits: [regle.alors],
      pensee: `1) On raisonne par modus ponens : règle vraie + antécédent vrai → conséquent vrai. 2) Règle : si ${regle.si}, alors ${regle.alors}. 3) Cas de ${nom} : ${regle.si}.`,
      reponse: `Donc : ${regle.alors}.`,
    };
  }
  return {
    prompt: `On sait que si ${regle.si}, alors ${regle.alors}. Or pour ${nom}, ${regle.sansSi}. Que peut-on conclure sur « ${regle.si} » ?`,
    extraits: [regle.sansAlors],
    pensee: `1) On raisonne par modus tollens : conséquent faux → antécédent faux. 2) Règle : si ${regle.si}, alors ${regle.alors}. 3) On observe : ${regle.sansSi}.`,
    reponse: `Donc : ${regle.sansAlors}.`,
  };
}

function decoderSpatial(k: number): Decodage {
  const nom = NOMS[k % NOMS.length];
  const reste = Math.floor(k / NOMS.length);
  const initiale = reste % 4;
  const seqReste = Math.floor(reste / 4);
  const mouvements: string[] = [];
  let r = seqReste;
  for (let i = 0; i < 5; i++) {
    mouvements.push(MOUVEMENTS[r % 3]);
    r = Math.floor(r / 3);
  }
  let cap = initiale;
  for (const m of mouvements) {
    if (m === "droite") cap = (cap + 1) % 4;
    else if (m === "gauche") cap = (cap + 3) % 4;
    else cap = (cap + 2) % 4;
  }
  const initialeTxt = DIRECTIONS[initiale];
  const seqTxt = mouvements.join(", puis ");
  const pronom = PRONOMS_MASCULINS.has(nom) ? "il" : "elle";
  const Pronom = PRONOMS_MASCULINS.has(nom) ? "Il" : "Elle";
  return {
    prompt: `${nom} fait face au ${initialeTxt}. ${Pronom} tourne à ${seqTxt}. Vers quelle direction fait ${pronom} face maintenant ?`,
    extraits: [DIRECTIONS[cap].toUpperCase(), DIRECTIONS[cap]],
    pensee: `1) On suit la boussole : nord, est, sud, ouest dans le sens des aiguilles d'une montre. 2) Départ : ${initialeTxt}. 3) On applique chaque mouvement : ${mouvements.join(" → ")}. 4) Cap final calculé : ${DIRECTIONS[cap]}.`,
    reponse: `Donc : ${nom} fait face au ${DIRECTIONS[cap]}.`,
  };
}

function decoderTemporel(k: number): Decodage {
  const h = k % 24;
  const m5 = Math.floor(k / 24) % 12;
  const d5 = Math.floor(k / (24 * 12)) % 36;
  const m = m5 * 5;
  const d = (d5 + 1) * 5;
  const total = h * 60 + m + d;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return {
    prompt: `Il est ${h} h ${pad2(m)}. Une tâche dure ${d} minutes. À quelle heure sera-t-elle terminée ?`,
    extraits: [`${hh} h ${pad2(mm)}`, `${hh}:${pad2(mm)}`, `${hh}h${pad2(mm)}`],
    pensee: `1) Départ : ${h} h ${pad2(m)} = ${h * 60 + m} minutes. 2) Durée : ${d} minutes. 3) Fin : ${h * 60 + m} + ${d} = ${total} minutes = ${hh} h ${pad2(mm)}.`,
    reponse: `Donc : la tâche se termine à ${hh} h ${pad2(mm)}.`,
  };
}

function decoderAnalogie(k: number): Decodage {
  const gab = k % 2;
  const [a, b, c, d] = ANALOGIES[Math.floor(k / 2) % ANALOGIES.length];
  if (gab === 0) {
    return {
      prompt: `Complète l'analogie : ${a} est à ${b} ce que ${c} est à quoi ?`,
      extraits: [d],
      pensee: `1) On identifie la relation entre ${a} et ${b}. 2) On applique la MÊME relation entre ${c} et la réponse cherchée.`,
      reponse: `Donc : ${a} est à ${b} ce que ${c} est à ${d}.`,
    };
  }
  return {
    prompt: `Si ${a} correspond à ${b}, à quoi correspond ${c} ?`,
    extraits: [d],
    pensee: `1) La relation ${a} → ${b} est repérée. 2) Transposition : ${c} → même type de lien.`,
    reponse: `Donc : ${c} correspond à ${d}.`,
  };
}

function decoderCausalite(k: number): Decodage {
  const gab = k % 2;
  const [cause, milieu, effet] = CHAINES_CAUSALES[Math.floor(k / 2) % CHAINES_CAUSALES.length];
  if (gab === 0) {
    return {
      prompt: `Explique la chaîne de cause à effet : ${cause}. Que s'est-il passé ensuite ?`,
      extraits: [milieu.split(" ").slice(0, 4).join(" ")],
      pensee: `1) Cause initiale : ${cause}. 2) Premier effet : ${milieu}. 3) Effet final : ${effet}.`,
      reponse: `Donc : ${milieu}, puis ${effet}.`,
    };
  }
  return {
    prompt: `${cause.charAt(0).toUpperCase()}${cause.slice(1)}. Quelle est la conséquence finale de cet événement ?`,
    extraits: [effet.split(" ").slice(0, 4).join(" ")],
    pensee: `1) Événement déclencheur : ${cause}. 2) Mécanisme intermédiaire : ${milieu}. 3) Conséquence : ${effet}.`,
    reponse: `Donc : au bout de la chaîne, ${effet}.`,
  };
}

function decoderPlanification(k: number): Decodage {
  const gab = k % 2;
  const [objectif, plan] = PLANIFICATIONS[Math.floor(k / 2) % PLANIFICATIONS.length];
  if (gab === 0) {
    return {
      prompt: `Comment faire pour ${objectif} ? Donne les étapes dans l'ordre.`,
      extraits: [plan.split(". ")[0]],
      pensee: `1) On décompose l'objectif « ${objectif} » en étapes ordonnées. 2) Chaque étape prépare la suivante.`,
      reponse: plan,
    };
  }
  return {
    prompt: `${objectif.charAt(0).toUpperCase()}${objectif.slice(1)} : quel plan d'action propose-t-on, étape par étape ?`,
    extraits: [plan.split(". ")[0]],
    pensee: `1) Objectif : ${objectif}. 2) Plan ordonné du plus préparatoire au plus final.`,
    reponse: plan,
  };
}

// ─── Question interrogée (avec sa réponse vérifiable) ───────────────────────

export interface QuestionMilliard {
  famille: FamilleMilliard;
  prompt: string;
  pensee: string;
  reponse: string;
  /** Extraits dont la présence dans la réponse prouve un résultat EXACT. */
  extraitsVerifiables: readonly string[];
}

/** Décode un index global n ∈ [0, capaciteTotale()) en question vérifiable. */
export function genererQuestionMilliard(n: number): QuestionMilliard {
  if (!Number.isInteger(n) || n < 0 || n >= capaciteTotale()) {
    throw new Error(`Index hors capacité : ${n}`);
  }
  const bornes = bornesParFamille();
  if (n < bornes.math_verbal[1]) {
    return enQ("math_verbal", decoderMathVerbal(n - bornes.math_verbal[0]));
  }
  if (n < bornes.deduction[1]) return enQ("deduction", decoderDeduction(n - bornes.deduction[0]));
  if (n < bornes.conditionnel[1]) return enQ("conditionnel", decoderConditionnel(n - bornes.conditionnel[0]));
  if (n < bornes.spatial[1]) return enQ("spatial", decoderSpatial(n - bornes.spatial[0]));
  if (n < bornes.temporel[1]) return enQ("temporel", decoderTemporel(n - bornes.temporel[0]));
  if (n < bornes.analogie[1]) return enQ("analogie", decoderAnalogie(n - bornes.analogie[0]));
  if (n < bornes.causalite[1]) return enQ("causalite", decoderCausalite(n - bornes.causalite[0]));
  return enQ("planification", decoderPlanification(n - bornes.planification[0]));
}

function enQ(famille: FamilleMilliard, d: Decodage): QuestionMilliard {
  return {
    famille,
    prompt: d.prompt,
    pensee: d.pensee,
    reponse: d.reponse,
    extraitsVerifiables: d.extraits,
  };
}

// ─── Balayages (systématique et stratifié) ──────────────────────────────────

/** Échantillonnage SYSTÉMATIQUE : la question d'ordre j d'un balayage de
 * N questions est l'index floor(j × capacité / N) — répartition EXACTE sur
 * tout l'espace [0, capacité), déterministe, sans doublon (indices
 * strictement croissants dès que capacité > N). */
export function indexDuBalayage(j: number, N: number): number {
  const cap = capaciteTotale();
  if (j < 0 || j >= N) throw new Error(`Ordre hors balayage : ${j}/${N}`);
  return Math.floor((j * cap) / N);
}

export function questionDuBalayage(j: number, N: number): QuestionMilliard {
  return genererQuestionMilliard(indexDuBalayage(j, N));
}

// ─── Stratification par famille (tous les domaines, pas seulement les gros) ─

/** Plancher de quota par famille non numérique : chacune des 7 familles de
 * « diversité humaine » reçoit au moins ce partage du balayage, sinon les 7
 * seraient noyées par math_verbal (35 644 / 1,89 Md = 0,002 % de l'espace). */
const PLANCHER_QUOTA_FAMILLE = 0.02;

export type PlanBalayage = Record<FamilleMilliard, number>;

/** Plan de stratification : nombre de questions par famille pour un balayage
 * de N questions. math_verbal reçoit la part dominante du reste ; chaque
 * autre famille reçoit au moins le plancher, plafonné à sa capacité réelle
 * (impossible d'échantillonner plus de questions distinctes qu'il n'y a
 * d'indices). */
export function planifierBalayage(N: number): PlanBalayage {
  const caps = capaciteParFamille();
  const plan = {} as PlanBalayage;
  let alloue = 0;
  for (const f of FAMILLES_MILLIARD) {
    if (f === "math_verbal") continue;
    plan[f] = Math.min(caps[f], Math.max(1, Math.floor(N * PLANCHER_QUOTA_FAMILLE)));
    alloue += plan[f];
  }
  const reste = Math.max(0, N - alloue);
  plan.math_verbal = Math.min(caps.math_verbal, reste);
  let nonDistribue = reste - plan.math_verbal;
  if (nonDistribue > 0) {
    const ordre = [...FAMILLES_MILLIARD]
      .filter((f) => f !== "math_verbal")
      .sort((a, b) => caps[b] - caps[a]);
    for (const f of ordre) {
      const ajout = Math.min(nonDistribue, caps[f] - plan[f]);
      plan[f] += ajout;
      nonDistribue -= ajout;
    }
  }
  return plan;
}

/** Question d'ordre j d'un balayage STRATIFIÉ de N questions : la famille est
 * choisie par quotas cumulés, l'index local balaye uniformément l'espace de
 * la famille. Déterministe, sans doublon (indices locaux strictement
 * croissants, espaces disjoints). */
export function questionStratifiee(j: number, N: number): QuestionMilliard {
  if (j < 0 || j >= N) throw new Error(`Ordre hors balayage : ${j}/${N}`);
  const plan = planifierBalayage(N);
  const caps = capaciteParFamille();
  const bornes = bornesParFamille();
  let acc = 0;
  // itération DANS L'ORDRE DU PLAN (les familles de diversité y sont
  // insérées d'abord, math_verbal en dernier — voir planifierBalayage) :
  // les familles épuisables (35 644 questions au total) sont ainsi posées
  // dès le premier segment du balayage du milliard.
  for (const [f, nf] of Object.entries(plan) as Array<[FamilleMilliard, number]>) {
    if (j < acc + nf) {
      const jLocal = j - acc;
      const indexLocal = Math.min(
        Math.floor((jLocal * caps[f]) / nf),
        caps[f] - 1,
      );
      return genererQuestionMilliard(bornes[f][0] + indexLocal);
    }
    acc += nf;
  }
  throw new Error("Balayage stratifié incohérent");
}

// ─── Vérification de la réponse de gen3 ─────────────────────────────────────

export type Verdict = "exact" | "methode" | "echec";

/** Réponse gen3 « exacte » si l'un des extraits vérifiables apparaît dans
 * une réponse courte (garde anti-générique) ; « methode » si la méthode
 * générique de la bonne famille répond ; « echec » sinon. */
export function verifierReponseGen3(
  q: QuestionMilliard,
  reponseGen3: string | null,
  familleDetectee: string | null,
): Verdict {
  const rep = (reponseGen3 ?? "").trim();
  if (rep.length > 0 && rep.length <= 900) {
    const bas = rep.toLowerCase();
    for (const ex of q.extraitsVerifiables) {
      if (bas.includes(ex.toLowerCase())) return "exact";
    }
  }
  if (familleDetectee === q.famille) return "methode";
  return "echec";
}

/** Paire corrective à apprendre en mémoire (cortex langagier) : le motif est
 * la question, la réponse est la pensée pas à pas + la conclusion. */
export function paireCorrective(q: QuestionMilliard): { motif: string; reponse: string; theme: string } {
  return {
    motif: q.prompt,
    reponse: `${q.pensee} ${q.reponse}`,
    theme: `correction-it86:${q.famille}`,
  };
}
