/**
 * CORPUS MULTI-DOMAINES it.84 — dérivé des datasets réels v4 (HF Kings237/gen3ia-media-engine)
 * + conversations FR (alpaca-gpt4-french), assimilés par ONDES (EOD) au cortex 1M
 * (scripts/entrainement-ondes-tous-domaines.ts — 338 439 échantillons réels, seed 42).
 *
 * Ces paires sont des EXEMPLES RÉELS des 19 domaines sélectionnés (math, sciences,
 * reasoning, nlp_comprehension, professions, code, sécurité, images, vidéo, voix,
 * audio, multimodal…) — sélectionnées parmi les questions de VÉRIFICATION (jamais
 * entraînées dans le cortex EOD : zéro fuite éval/entraînement), réponses propres
 * ≤ 350 caractères. Intégrées au corpus langagier du chat (code source commis).
 * Module PUR — aucune dépendance Node.
 */

import type { PaireLangage } from "./corpus";

export const CORPUS_DOMAINES_IT84: readonly PaireLangage[] = [
  {
    motif: 'Applique la formule d = v × t avec les unités. Un trajet de 720 km à 90 km/h. Durée ?',
    reponse: 't = d ÷ v = 720 ÷ 90 = 8 h.',
    theme: 'math',
  },
  {
    motif: 'Apply the formula and give the result with its unit. Rectangle: length 9 m, width 72 m. Area and perimeter?',
    reponse: 'Area = 9 × 72 = 648 m²; perimeter = 2 × (9 + 72) = 162 m.',
    theme: 'math',
  },
  {
    motif: 'Applique la formule et donne le résultat avec son unité. Triangle : base 26 cm, hauteur 68 cm. Aire ?',
    reponse: 'Aire = base × hauteur ÷ 2 = 26 × 68 ÷ 2 = 884 cm².',
    theme: 'math',
  },
  {
    motif: 'Solve and show the computation in one line. Compute 40% of 13,705 francs.',
    reponse: '40% of 13,705 francs = 40 ÷ 100 × 13,705 = 5482 francs.',
    theme: 'math',
  },
  {
    motif: 'Go through the unit price then multiply. 2 e-scooters cost 6733 francs. Price for 14?',
    reponse: 'Unit price = 6733 ÷ 2 = 3366 francs; for 14: 3366 × 14 = 47124 francs.',
    theme: 'math',
  },
  {
    motif: 'Compute respecting operator precedence. 67 × 424 + 669 × 178',
    reponse: '147490 — compute in order: both multiplications first, then addition.',
    theme: 'math',
  },
  {
    motif: 'Calcule en respectant les priorités opératoires. (543 + 757) × 43 − 235',
    reponse: '55665 — on calcule dans l\'ordre : parenthèses, puis multiplication, puis soustraction.',
    theme: 'math',
  },
  {
    motif: 'Compute respecting operator precedence. 939 × 727 + 897 × 646',
    reponse: '1262115 — compute in order: both multiplications first, then addition.',
    theme: 'math',
  },
  {
    motif: 'Applique la formule et donne le résultat avec son unité. Triangle : base 81 cm, hauteur 99 cm. Aire ?',
    reponse: 'Aire = base × hauteur ÷ 2 = 81 × 99 ÷ 2 = 4009.5 cm².',
    theme: 'math',
  },
  {
    motif: 'Solve the equation and explain the step in one sentence. Solve: 8x + 118 = 734',
    reponse: 'x = 77 — subtract 118 then divide by 8: (734 − 118) ÷ 8 = 77.',
    theme: 'math',
  },
  {
    motif: 'Compute respecting operator precedence. 825 × 817 + 805 × 53',
    reponse: '716690 — compute in order: both multiplications first, then addition.',
    theme: 'math',
  },
  {
    motif: 'Solve the equation and explain the step in one sentence. Solve: 7x + 47 = 362',
    reponse: 'x = 45 — subtract 47 then divide by 7: (362 − 47) ÷ 7 = 45.',
    theme: 'math',
  },
  {
    motif: 'Calcule en respectant les priorités opératoires. (317 + 655) × 37 − 903',
    reponse: '35061 — on calcule dans l\'ordre : parenthèses, puis multiplication, puis soustraction.',
    theme: 'math',
  },
  {
    motif: 'Résous et montre le calcul en une ligne. Calculer 20 % de 5,238 francs.',
    reponse: '20 % de 5,238 francs = 20 ÷ 100 × 5,238 = 1047.6 francs.',
    theme: 'math',
  },
  {
    motif: 'Apply d = v × t with units. 296 km covered in 4 h. Average speed?',
    reponse: 'v = d ÷ t = 296 ÷ 4 = 74 km/h.',
    theme: 'math',
  },
  {
    motif: 'Résous et montre le calcul en une ligne. Un prix de 41,144 francs baisse de 70 %. Nouveau prix ?',
    reponse: '41,144 × (1 − 70/100) = 12343.2 francs.',
    theme: 'math',
  },
  {
    motif: 'Solve the equation and explain the step in one sentence. Solve: 3x + 80 = 89',
    reponse: 'x = 3 — subtract 80 then divide by 3: (89 − 80) ÷ 3 = 3.',
    theme: 'math',
  },
  {
    motif: 'Résous et montre le calcul en une ligne. Calculer 12 % de 42,160 francs.',
    reponse: '12 % de 42,160 francs = 12 ÷ 100 × 42,160 = 5059.2 francs.',
    theme: 'math',
  },
  {
    motif: 'Passe par le prix unitaire puis multiplie. 6 trottinette électriques coûtent 660 francs. Quel prix pour 24 ?',
    reponse: 'Prix unitaire = 660 ÷ 6 = 110 francs ; pour 24 : 110 × 24 = 2640 francs.',
    theme: 'math',
  },
  {
    motif: 'Solve and show the computation in one line. A price of 38,442 francs drops by 18%. New price?',
    reponse: '38,442 × (1 − 18/100) = 31522.44 francs.',
    theme: 'math',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Linda grades a quiz: give the established answer about DNA.',
    reponse: 'Carries the hereditary information of living beings.',
    theme: 'sciences',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Linda asks: the Sun, what exactly is it?',
    reponse: 'A star, the closest one to earth.',
    theme: 'sciences',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Daniel grades a quiz: give the established answer about the formula of water.',
    reponse: 'H₂o: two hydrogen atoms for one oxygen atom.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Maëlys demande : que sait-on sur la température corporelle humaine normale ?',
    reponse: 'D\'environ 37 °c.',
    theme: 'sciences',
  },
  {
    motif: 'Applique le principe établi à la situation, sans sur-généraliser. Mise en situation à Dakar : pendant un documentaire local, quelqu\'un applique les insectes. Quel principe s\'applique et pourquoi ?',
    reponse: 'Principe : six pattes et trois segments de corps (tête, thorax, abdomen).\nApplication : on s\'appuie sur ce principe établi pour expliquer le phénomène observé pendant un documentaire local, en restant dans son périmètre — au-delà, gen3 dit explicitement qu\'il ne sait pas.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Maëlys interroge : la révolution de la Lune, c\'est quoi exactement ?',
    reponse: 'Environ 27 jours autour de la terre.',
    theme: 'sciences',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Revision card requested by Paul: the lever principle.',
    reponse: 'A small force on a long arm balances a large force on a short arm — to be memorized as is.',
    theme: 'sciences',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Esther is revising: recall the key fact about the blood\'s oxygen carrier.',
    reponse: 'Hemoglobin in red blood cells (reference fact).',
    theme: 'sciences',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Frank is revising: recall the key fact about Ohm\'s law.',
    reponse: 'U = r × i (voltage = resistance × current) (reference fact).',
    theme: 'sciences',
  },
  {
    motif: 'Applique le principe établi à la situation, sans sur-généraliser. Mise en situation à Kinshasa : pendant une visite guidée, quelqu\'un applique la fonte de la glace. Quel principe s\'applique et pourquoi ?',
    reponse: 'Principe : un changement d\'état solide → liquide à 0 °C (pression normale).\nApplication : on s\'appuie sur ce principe établi pour expliquer le phénomène observé pendant une visite guidée, en restant dans son périmètre — au-delà, gen3 dit explicitement qu\'il ne sait pas.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Pierre interroge : l\'ADN, c\'est quoi exactement ?',
    reponse: 'Porte l\'information héréditaire des êtres vivants.',
    theme: 'sciences',
  },
  {
    motif: 'Apply the established principle to the situation, without over-generalizing. Field case in Niamey: during a community workshop, someone applies the formula of water. Which principle applies and why?',
    reponse: 'Principle: H₂O: two hydrogen atoms for one oxygen atom.\nApplication: rely on this established principle to explain the phenomenon observed during a community workshop, staying within its scope — beyond that, gen3 explicitly says it does not know.',
    theme: 'sciences',
  },
  {
    motif: 'Apply the established principle to the situation, without over-generalizing. Field case in Algiers: during a class debate, someone applies recycling. Which principle applies and why?',
    reponse: 'Principle: reduces raw-material extraction and waste.\nApplication: rely on this established principle to explain the phenomenon observed during a class debate, staying within its scope — beyond that, gen3 explicitly says it does not know.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Élodie interroge : l\'énergie des aliments, c\'est quoi exactement ?',
    reponse: 'Mesurée en kilocalories ou kilojoules.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Marc prépare un exposé : explique les volcans en une phrase.',
    reponse: 'Des ouvertures de la croûte laissant remonter du magma — phrase unique, sans extrapolation.',
    theme: 'sciences',
  },
  {
    motif: 'Apply the established principle to the situation, without over-generalizing. Field case in Johannesburg: during a technical training, someone applies a light-year. Which principle applies and why?',
    reponse: 'Principle: the distance light travels in one year.\nApplication: rely on this established principle to explain the phenomenon observed during a technical training, staying within its scope — beyond that, gen3 explicitly says it does not know.',
    theme: 'sciences',
  },
  {
    motif: 'Answer with the established fact, no extrapolation. Bella grades a quiz: give the established answer about coral bleaching.',
    reponse: 'Caused notably by water warming.',
    theme: 'sciences',
  },
  {
    motif: 'Apply the established principle to the situation, without over-generalizing. Field case in Johannesburg: during a hands-on demo, someone applies static electricity. Which principle applies and why?',
    reponse: 'Principle: an accumulation of electric charges on an object\'s surface.\nApplication: rely on this established principle to explain the phenomenon observed during a hands-on demo, staying within its scope — beyond that, gen3 explicitly says it does not know.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Fiche de révision demandée par Théo : l\'équateur.',
    reponse: 'Traverse l\'afrique centrale — à retenir tel quel.',
    theme: 'sciences',
  },
  {
    motif: 'Réponds par le fait établi, sans extrapoler. Bakary interroge : l\'ébullition de l\'eau au niveau de la mer, c\'est quoi exactement ?',
    reponse: 'À environ 100 °c.',
    theme: 'sciences',
  },
  {
    motif: 'Deduce only what is certain; explicitly state what cannot be concluded. All items sold in Abidjan that carry a green tag are cameras.\n5 medicinal plants from this market carry a green tag.\nWhat can be CERTAINLY deduced?',
    reponse: 'Those 5 medicinal plants are cameras (by syllogism: green tag → cameras, and they have green tags).',
    theme: 'reasoning',
  },
  {
    motif: 'Deduce only what is certain; explicitly state what cannot be concluded. All items sold in Accra that carry a green tag are roses.\n12 medicinal plants from this market carry a green tag.\nWhat can be CERTAINLY deduced?',
    reponse: 'Those 12 medicinal plants are roses (by syllogism: green tag → roses, and they have green tags).',
    theme: 'reasoning',
  },
  {
    motif: 'Deduce only what is certain; explicitly state what cannot be concluded. All items sold in Algiers that carry a green tag are city bikes.\n9 garden tools from this market carry a green tag.\nWhat can be CERTAINLY deduced?',
    reponse: 'Those 9 garden tools are city bikes (by syllogism: green tag → city bikes, and they have green tags).',
    theme: 'reasoning',
  },
  {
    motif: 'Deduce only what is certain; explicitly state what cannot be concluded. All items sold in Douala that carry a green tag are farm cheeses.\n7 garden tools from this market carry a green tag.\nWhat can be CERTAINLY deduced?',
    reponse: 'Those 7 garden tools are farm cheeses (by syllogism: green tag → farm cheeses, and they have green tags).',
    theme: 'reasoning',
  },
  {
    motif: 'Classe les informations puis réponds exactement. Adama mesure 163 cm.\nDidier mesure 157 cm.\nRokia mesure 194 cm.\nAwa mesure 164 cm.\nAminata mesure 187 cm.\nQui est le plus grand ? Et qui est le plus petit ?',
    reponse: 'Le plus grand : Rokia (194 cm) ; le plus petit : Didier (157 cm).',
    theme: 'reasoning',
  },
  {
    motif: 'Sort the facts then answer exactly. Helen is 155 cm tall.\nFaith is 166 cm tall.\nMaria is 186 cm tall.\nPaul is 168 cm tall.\nWho is the tallest? And who is the shortest?',
    reponse: 'Tallest: Maria (186 cm); shortest: Helen (155 cm).',
    theme: 'reasoning',
  },
  {
    motif: 'Deduce only what is certain; explicitly state what cannot be concluded. All items sold in Algiers that carry a green tag are city bikes.\n12 cameras from this market carry a green tag.\nWhat can be CERTAINLY deduced?',
    reponse: 'Those 12 cameras are city bikes (by syllogism: green tag → city bikes, and they have green tags).',
    theme: 'reasoning',
  },
  {
    motif: 'Rewrite this message in a formal version, keeping the key facts (item, delay, amount). Hi, I want to know where my book is, ordered 10 days ago, I paid 400 francs and it\'s getting long. Please answer fast.',
    reponse: 'Subject: Order follow-up — delivery pending\n\nHello,\n\nI ordered a book ten days ago (payment: 400 francs) and I still have no shipping update. Could you tell me the status and the expected delivery time?\n\nBest regards,\nDiana',
    theme: 'text_generation',
  },
  {
    motif: 'Rewrite this message in a more empathetic version, keeping the key facts (item, delay, amount). Hi, I want to know where my book is, ordered 10 days ago, I paid 40 francs and it\'s getting long. Please answer fast.',
    reponse: 'Subject: Order follow-up — delivery pending\n\nHello,\n\nI ordered a book ten days ago (payment: 40 francs) and I still have no shipping update. Could you tell me the status and the expected delivery time?\n\nBest regards,\nJudith',
    theme: 'text_generation',
  },
  {
    motif: 'Rewrite this message in a shorter version, keeping the key facts (item, delay, amount). Hi, I want to know where my radio is, ordered 10 days ago, I paid 300 francs and it\'s getting long. Please answer fast.',
    reponse: 'Subject: Order follow-up — delivery pending\n\nHello,\n\nI ordered a radio ten days ago (payment: 300 francs) and I still have no shipping update. Could you tell me the status and the expected delivery time?\n\nBest regards,\nTom',
    theme: 'text_generation',
  },
  {
    motif: 'Rewrite this message in a shorter version, keeping the key facts (item, delay, amount). Hi, I want to know where my key is, ordered 10 days ago, I paid 750 francs and it\'s getting long. Please answer fast.',
    reponse: 'Subject: Order follow-up — delivery pending\n\nHello,\n\nI ordered a key ten days ago (payment: 750 francs) and I still have no shipping update. Could you tell me the status and the expected delivery time?\n\nBest regards,\nBrian',
    theme: 'text_generation',
  },
  {
    motif: 'Rewrite this message in a formal version, keeping the key facts (item, delay, amount). Hi, I want to know where my backpack is, ordered 10 days ago, I paid 25 francs and it\'s getting long. Please answer fast.',
    reponse: 'Subject: Order follow-up — delivery pending\n\nHello,\n\nI ordered a backpack ten days ago (payment: 25 francs) and I still have no shipping update. Could you tell me the status and the expected delivery time?\n\nBest regards,\nLinda',
    theme: 'text_generation',
  },
  {
    motif: 'Rewrite this message in a more empathetic version, keeping the key facts (item, delay, amount). Hi, I want to know where my flashlight is, ordered 10 days ago, I paid 200 francs and it\'s getting long. Please answer fast.',
    reponse: 'Subject: Order follow-up — delivery pending\n\nHello,\n\nI ordered a flashlight ten days ago (payment: 200 francs) and I still have no shipping update. Could you tell me the status and the expected delivery time?\n\nBest regards,\nEsther',
    theme: 'text_generation',
  },
  {
    motif: 'State the implicit question and list what must be checked to answer. Simon: "If I stop by the river bank this Monday after 6 pm, do you think I can still pick up my book? The counter usually closes earlier on weekends."',
    reponse: 'Implicit question: Simon is asking whether the the river bank counter is open after 6 pm that Monday. To answer: the counter\'s exact hours (earlier weekend closing) and a fallback if closed (next-day pickup or hold service).',
    theme: 'contextual_understanding',
  },
  {
    motif: 'State the implicit question and list what must be checked to answer. David: "If I stop by the town hall this Tuesday after 6 pm, do you think I can still pick up my fan? The counter usually closes earlier on weekends."',
    reponse: 'Implicit question: David is asking whether the the town hall counter is open after 6 pm that Tuesday. To answer: the counter\'s exact hours (earlier weekend closing) and a fallback if closed (next-day pickup or hold service).',
    theme: 'contextual_understanding',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hello, Alice here. Can you help me with a translation in Kampala?',
    reponse: 'Intent: translate (translation)\nAction: identify the language pair then translate\nEntities: product=gardening kit, amount=300 francs, customer=Alice, location=Kampala\nConfidence: 0.9',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classifie l\'intention de l\'utilisateur, propose l\'action suivante et liste les entités. Bonjour, je voudrais question de facturation pour le kit jardinage de Théo, s\'il vous plaît.',
    reponse: 'Intention : question_facture (question de facturation)\nAction : récupérer la facture et expliquer les lignes\nEntités détectées : produit=kit jardinage, montant=1000 francs, client=Théo, lieu=Alger\nConfiance : 0.93',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. It\'s about the multi-cooker again — I\'m requesting a complaint (amount: 120 francs).',
    reponse: 'Intent: complaint (complaint)\nAction: apologize, collect facts, escalate if needed\nEntities: product=multi-cooker, amount=120 francs, customer=Joy, location=Cotonou\nConfidence: 0.91',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hi, I would like to billing question for the water purifier of Peter, please.',
    reponse: 'Intent: billing (billing question)\nAction: fetch the invoice and explain the lines\nEntities: product=water purifier, amount=1500 francs, customer=Peter, location=Lagos\nConfidence: 0.94',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classifie l\'intention de l\'utilisateur, propose l\'action suivante et liste les entités. Bonjour, Nora ici. Pouvez-vous m\'aider pour un question de facturation à Yaoundé ?',
    reponse: 'Intention : question_facture (question de facturation)\nAction : récupérer la facture et expliquer les lignes\nEntités détectées : produit=formation bureautique, montant=120 francs, client=Nora, lieu=Yaoundé\nConfiance : 0.93',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hello, Ruth here. Can you help me with a directions in Lagos?',
    reponse: 'Intent: directions (directions)\nAction: provide the route with estimated time\nEntities: product=gardening kit, amount=3000 francs, customer=Ruth, location=Lagos\nConfidence: 0.97',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hi, I would like to billing question for the office training of Grace, please.',
    reponse: 'Intent: billing (billing question)\nAction: fetch the invoice and explain the lines\nEntities: product=office training, amount=500 francs, customer=Grace, location=Bamako\nConfidence: 0.92',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hello, James here. Can you help me with a complaint in Yaounde?',
    reponse: 'Intent: complaint (complaint)\nAction: apologize, collect facts, escalate if needed\nEntities: product=multi-cooker, amount=500 francs, customer=James, location=Yaounde\nConfidence: 0.92',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. The orthopedic mattress I paid 1000 francs for is an issue: I want a complaint.',
    reponse: 'Intent: complaint (complaint)\nAction: apologize, collect facts, escalate if needed\nEntities: product=orthopedic mattress, amount=1000 francs, customer=Grace, location=Lagos\nConfidence: 0.95',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hello, Eric here. Can you help me with a cancellation in Abidjan?',
    reponse: 'Intent: cancel (cancellation)\nAction: check the reference then cancel with confirmation\nEntities: product=27-inch monitor, amount=1250 francs, customer=Eric, location=Abidjan\nConfidence: 0.87',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classifie l\'intention de l\'utilisateur, propose l\'action suivante et liste les entités. Bonjour, Céline ici. Pouvez-vous m\'aider pour un parler à un humain à Libreville ?',
    reponse: 'Intention : appel_humain (parler à un humain)\nAction : proposer un rappel et donner le délai\nEntités détectées : produit= machine à coudre, montant=1500 francs, client=Céline, lieu=Libreville\nConfiance : 0.95',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classifie l\'intention de l\'utilisateur, propose l\'action suivante et liste les entités. Le bureau ergonomique que j\'ai payé 2000 francs me pose problème : je souhaite un prise de rendez-vous.',
    reponse: 'Intention : rendez_vous (prise de rendez-vous)\nAction : proposer deux créneaux et confirmer\nEntités détectées : produit=bureau ergonomique, montant=2000 francs, client=Sarah, lieu=Kinshasa\nConfiance : 0.9',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hello, Alice here. Can you help me with a payment failed in Libreville?',
    reponse: 'Intent: payment_failed (payment failed)\nAction: check the payment method and offer an alternative\nEntities: product=orthopedic mattress, amount=25 francs, customer=Alice, location=Libreville\nConfidence: 0.92',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. The kitchen mixer I paid 7500 francs for is an issue: I want a refund.',
    reponse: 'Intent: refund (refund)\nAction: check eligibility then trigger the refund\nEntities: product=kitchen mixer, amount=7500 francs, customer=Victor, location=Lagos\nConfidence: 0.87',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classifie l\'intention de l\'utilisateur, propose l\'action suivante et liste les entités. Bonjour, Hugo ici. Pouvez-vous m\'aider pour un suivi de commande à Casablanca ?',
    reponse: 'Intention : suivi_commande (suivi de commande)\nAction : demander le numéro de commande puis interroger le suivi\nEntités détectées : produit=bureau ergonomique, montant=20000 francs, client=Hugo, lieu=Casablanca\nConfiance : 0.95',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. The e-scooter I paid 300 francs for is an issue: I want a human agent.',
    reponse: 'Intent: human_agent (human agent)\nAction: offer a callback and give the delay\nEntities: product=e-scooter, amount=300 francs, customer=Frank, location=Libreville\nConfidence: 0.82',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. It\'s about the 27-inch monitor again — I\'m requesting a payment failed (amount: 200 francs).',
    reponse: 'Intent: payment_failed (payment failed)\nAction: check the payment method and offer an alternative\nEntities: product=27-inch monitor, amount=200 francs, customer=Eric, location=Kigali\nConfidence: 0.93',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classifie l\'intention de l\'utilisateur, propose l\'action suivante et liste les entités. Bonjour, je voudrais parler à un humain pour le batteur de cuisine de Tania, s\'il vous plaît.',
    reponse: 'Intention : appel_humain (parler à un humain)\nAction : proposer un rappel et donner le délai\nEntités détectées : produit=batteur de cuisine, montant=150 francs, client=Tania, lieu=Tunis\nConfiance : 0.89',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. Hi, I would like to human agent for the organic basket of Diana, please.',
    reponse: 'Intent: human_agent (human agent)\nAction: offer a callback and give the delay\nEntities: product=organic basket, amount=7500 francs, customer=Diana, location=Cairo\nConfidence: 0.97',
    theme: 'intent_recognition',
  },
  {
    motif: 'Classify the user\'s intent, propose the next action and list entities. It\'s about the organic basket again — I\'m requesting a appointment (amount: 7500 francs).',
    reponse: 'Intent: appointment (appointment)\nAction: offer two slots then confirm\nEntities: product=organic basket, amount=7500 francs, customer=Maria, location=Casablanca\nConfidence: 0.87',
    theme: 'intent_recognition',
  },
  {
    motif: 'Réponds à la réclamation en 4 étapes, avec action datée et escalade. Réclamation de Camille : trottinette électrique payé 15,000 francs, problème non résolu depuis 8 jours.',
    reponse: 'Réponse structurée : 1) accuser le désagrément sans excuser ; 2) reformuler le fait (trottinette électrique, 15,000 francs) ; 3) donner l\'action concrète et son délai ; 4) offrir une escalade si le délai saute. Ton courtois, zéro jargon, aucune promesse non tenable.',
    theme: 'professions',
  },
  {
    motif: 'Structure the market study and unit economics, no wishful thinking. Naomi\'s venture in Cape Town, 250 francs capital.',
    reponse: 'Quick market study: 1) 10 target-customer interviews in Cape Town; 2) direct/indirect competition listed with prices; 3) unit economics (cost, price, margin, break-even volume); 4) capital 250 francs split (product 40%, acquisition 30%, reserve 30%). Honesty: an idea without positive unit economics is not a business, it is a bet.',
    theme: 'professions',
  },
  {
    motif: 'Rédige l\'annonce honnête et 3 compromis budgétaires. 3 pièces à Dakar, budget 15,000 francs.',
    reponse: 'Annonce : 3 pièces à Dakar, points forts mesurables (surface, exposition, proximités vérifiées), photos honnêtes sans grand-angle trompeur, loyer/prix cohérents avec le marché local. Cadrage budget : 15,000 francs — lister 3 compromis possibles (surface vs quartier vs étage).',
    theme: 'professions',
  },
  {
    motif: 'Structure the market study and unit economics, no wishful thinking. Simon\'s venture in Ouagadougou, 150 francs capital.',
    reponse: 'Quick market study: 1) 10 target-customer interviews in Ouagadougou; 2) direct/indirect competition listed with prices; 3) unit economics (cost, price, margin, break-even volume); 4) capital 150 francs split (product 40%, acquisition 30%, reserve 30%). Honesty: an idea without positive unit economics is not a business, it is a bet.',
    theme: 'professions',
  },
  {
    motif: 'Construis un plan de campagne chiffré avec CPA et critère d\'arrêt. Promouvoir le enceinte bluetooth à Le Caire, budget 25 francs, taux de conversion attendu 12 %.',
    reponse: 'Plan de campagne (budget 25 francs) :\n1. Cible : acheteurs de enceinte bluetooth à Le Caire ;\n2. Message : bénéfice unique + preuve sociale ;\n3. Canaux : réseaux sociaux + recherche locale ;\n4. Mesure : 1,628 clics visés → 195 conversions (12 %), CPA ≈ 0 francs.\nDécision : si CPA > valeur client, réduire la cible.',
    theme: 'professions',
  },
  {
    motif: 'Calcule les tournées et l\'organisation de preuve de livraison. 330 colis de Lagos vers Alger.',
    reponse: 'Tournées : 330 colis Lagos → Alger regroupés en 6 tournée(s) (≈ 50 colis/tournée).\nOptimisation : regrouper par zone de livraison, fenêtres horaires confirmées la veille, preuve de livraison numérique. Alerte : si un colis dépasse le délai promis, prévenir AVANT l\'échéance.',
    theme: 'professions',
  },
  {
    motif: 'Calcule les tournées et l\'organisation de preuve de livraison. 340 colis de Dakar vers Accra.',
    reponse: 'Tournées : 340 colis Dakar → Accra regroupés en 6 tournée(s) (≈ 50 colis/tournée).\nOptimisation : regrouper par zone de livraison, fenêtres horaires confirmées la veille, preuve de livraison numérique. Alerte : si un colis dépasse le délai promis, prévenir AVANT l\'échéance.',
    theme: 'professions',
  },
  {
    motif: 'Compute the runs and the proof-of-delivery organization. 219 parcels from Cotonou to Kinshasa.',
    reponse: 'Routes: 219 parcels Cotonou → Kinshasa grouped into 4 run(s) (≈ 50 parcels/run).\nOptimization: group by delivery zone, confirm time windows the day before, digital proof of delivery. Alert: if a parcel will miss the promised deadline, warn BEFORE the deadline.',
    theme: 'professions',
  },
  {
    motif: 'Structure the market study and unit economics, no wishful thinking. Maria\'s venture in Conakry, 2,500 francs capital.',
    reponse: 'Quick market study: 1) 10 target-customer interviews in Conakry; 2) direct/indirect competition listed with prices; 3) unit economics (cost, price, margin, break-even volume); 4) capital 2,500 francs split (product 40%, acquisition 30%, reserve 30%). Honesty: an idea without positive unit economics is not a business, it is a bet.',
    theme: 'professions',
  },
  {
    motif: 'Write the honest listing and 3 budget trade-offs. 3-room in Lagos, 400 francs budget.',
    reponse: 'Listing: 3-room place in Lagos, measurable highlights (area, exposure, verified nearby amenities), honest photos without misleading wide-angle, rent/price consistent with the local market. Budget framing: 400 francs — list 3 possible trade-offs (size vs area vs floor).',
    theme: 'professions',
  },
  {
    motif: 'Structure the market study and unit economics, no wishful thinking. Bella\'s venture in Ouagadougou, 40 francs capital.',
    reponse: 'Quick market study: 1) 10 target-customer interviews in Ouagadougou; 2) direct/indirect competition listed with prices; 3) unit economics (cost, price, margin, break-even volume); 4) capital 40 francs split (product 40%, acquisition 30%, reserve 30%). Honesty: an idea without positive unit economics is not a business, it is a bet.',
    theme: 'professions',
  },
  {
    motif: 'Build a quantified campaign plan with CPA and a stop criterion. Promote the bluetooth speaker in Cotonou, budget 1,250 francs, expected conversion 25%.',
    reponse: 'Campaign plan (budget 1,250 francs):\n1. Target: bluetooth speaker buyers in Cotonou;\n2. Message: single benefit + social proof;\n3. Channels: social + local search;\n4. Measure: 2,795 clicks → 698 conversions (25%), CPA ≈ 2 francs.\nDecision: if CPA > customer value, narrow the target.',
    theme: 'professions',
  },
  {
    motif: 'Write the honest listing and 3 budget trade-offs. 3-room in Cotonou, 60 francs budget.',
    reponse: 'Listing: 3-room place in Cotonou, measurable highlights (area, exposure, verified nearby amenities), honest photos without misleading wide-angle, rent/price consistent with the local market. Budget framing: 60 francs — list 3 possible trade-offs (size vs area vs floor).',
    theme: 'professions',
  },
  {
    motif: 'Construis un plan de campagne chiffré avec CPA et critère d\'arrêt. Promouvoir le drone photo à Ouagadougou, budget 1,250 francs, taux de conversion attendu 30 %.',
    reponse: 'Plan de campagne (budget 1,250 francs) :\n1. Cible : acheteurs de drone photo à Ouagadougou ;\n2. Message : bénéfice unique + preuve sociale ;\n3. Canaux : réseaux sociaux + recherche locale ;\n4. Mesure : 922 clics visés → 276 conversions (30 %), CPA ≈ 5 francs.\nDécision : si CPA > valeur client, réduire la cible.',
    theme: 'professions',
  },
  {
    motif: 'Reply to the complaint in 4 steps, with a dated action and escalation. Complaint from David: gardening kit paid 60 francs, unresolved for 8 days.',
    reponse: 'Structured reply: 1) acknowledge the inconvenience without excuses; 2) restate the fact (gardening kit, 60 francs); 3) give the concrete action and its deadline; 4) offer escalation if the deadline slips. Courteous tone, zero jargon, no unkeepable promises.',
    theme: 'professions',
  },
  {
    motif: 'Compute the runs and the proof-of-delivery organization. 79 parcels from Johannesburg to Bamako.',
    reponse: 'Routes: 79 parcels Johannesburg → Bamako grouped into 1 run(s) (≈ 50 parcels/run).\nOptimization: group by delivery zone, confirm time windows the day before, digital proof of delivery. Alert: if a parcel will miss the promised deadline, warn BEFORE the deadline.',
    theme: 'professions',
  },
  {
    motif: 'Write the product sheet and the offer economics (margin, threshold). Product: projector — cost 120 francs, target price 620 francs.',
    reponse: 'Product sheet: clear title (projector), 3 concrete benefits, size/weight, warranty.\nEconomics: cost 120 → price 620 francs, margin 80.6%.\nBreak-even: cover CPA before any discount — never discount below a 15% margin.',
    theme: 'professions',
  },
  {
    motif: 'Filtered sorted query + suggested index. Table "products": list rows where prix > 500, sorted by prix ASC, limit 1000.',
    reponse: 'SELECT * FROM products\nWHERE prix > 500\nORDER BY prix ASC LIMIT 1000;\nSuggested index: (prix) — check the EXPLAIN plan on a sample.',
    theme: 'databases',
  },
  {
    motif: 'Requête filtrée triée + index conseillé. Table « stocks » : lister les lignes où quantite < 500, triées par quantite DESC, limite 500.',
    reponse: 'SELECT * FROM stocks\nWHERE quantite < 500\nORDER BY quantite DESC LIMIT 500;\nIndex conseillé : (quantite) — vérifier le plan EXPLAIN sur un échantillon.',
    theme: 'databases',
  },
  {
    motif: 'Requête filtrée triée + index conseillé. Table « reservations » : lister les lignes où participants <= 250, triées par participants DESC, limite 5.',
    reponse: 'SELECT * FROM reservations\nWHERE participants <= 250\nORDER BY participants DESC LIMIT 5;\nIndex conseillé : (participants) — vérifier le plan EXPLAIN sur un échantillon.',
    theme: 'databases',
  },
  {
    motif: 'Agrégation lisible + index conseillé. Table « notes » : MIN(valeur) par matière, toutes valeurs confondues, top 500, tri DESC.',
    reponse: 'SELECT matière, MIN(valeur) AS resultat\nFROM notes\nGROUP BY matière ORDER BY resultat DESC LIMIT 500;\nIndex conseillé : (matière, valeur) si la table grossit.',
    theme: 'databases',
  },
  {
    motif: 'Readable aggregation + suggested index. Table "loans" (columns: id, secteur, duree_jours, retour): MAX(duree_jours) for secteur = \'youth\', limit 100.',
    reponse: 'SELECT secteur, MAX(duree_jours) AS resultat\nFROM loans\nWHERE secteur = \'youth\'\nGROUP BY secteur LIMIT 100;\nSuggested index: (secteur, duree_jours).',
    theme: 'databases',
  },
  {
    motif: 'Readable aggregation + suggested index. Table "customers": MAX(points_fidelite) per ville, all values, top 50, ASC sort.',
    reponse: 'SELECT ville, MAX(points_fidelite) AS resultat\nFROM customers\nGROUP BY ville ORDER BY resultat ASC LIMIT 50;\nSuggested index: (ville, points_fidelite) as the table grows.',
    theme: 'databases',
  },
  {
    motif: 'Readable aggregation + suggested index. Table "products": AVG(prix) per categorie, all values, top 500, ASC sort.',
    reponse: 'SELECT categorie, AVG(prix) AS resultat\nFROM products\nGROUP BY categorie ORDER BY resultat ASC LIMIT 500;\nSuggested index: (categorie, prix) as the table grows.',
    theme: 'databases',
  },
  {
    motif: 'Requête filtrée triée + index conseillé. Table « factures » : lister les lignes où montant > 500, triées par montant ASC, limite 50.',
    reponse: 'SELECT * FROM factures\nWHERE montant > 500\nORDER BY montant ASC LIMIT 50;\nIndex conseillé : (montant) — vérifier le plan EXPLAIN sur un échantillon.',
    theme: 'databases',
  },
  {
    motif: 'Filtered sorted query + suggested index. Table "loans": list rows where duree_jours < 500, sorted by duree_jours DESC, limit 5.',
    reponse: 'SELECT * FROM loans\nWHERE duree_jours < 500\nORDER BY duree_jours DESC LIMIT 5;\nSuggested index: (duree_jours) — check the EXPLAIN plan on a sample.',
    theme: 'databases',
  },
  {
    motif: 'Readable aggregation + suggested index. Table "invoices": AVG(montant) per statut, all values, top 500, DESC sort.',
    reponse: 'SELECT statut, AVG(montant) AS resultat\nFROM invoices\nGROUP BY statut ORDER BY resultat DESC LIMIT 500;\nSuggested index: (statut, montant) as the table grows.',
    theme: 'databases',
  },
  {
    motif: 'Agrégation lisible + index conseillé. Table « factures » (colonnes : id, statut, montant, emission) : SUM(montant) pour statut = \'en_attente\', limite 200.',
    reponse: 'SELECT statut, SUM(montant) AS resultat\nFROM factures\nWHERE statut = \'en_attente\'\nGROUP BY statut LIMIT 200;\nIndex conseillé : (statut, montant).',
    theme: 'databases',
  },
  {
    motif: 'Readable aggregation + suggested index. Table "customers" (columns: id, ville, points_fidelite, inscription): SUM(points_fidelite) for ville = \'Cape Town\', limit 5.',
    reponse: 'SELECT ville, SUM(points_fidelite) AS resultat\nFROM customers\nWHERE ville = \'Cape Town\'\nGROUP BY ville LIMIT 5;\nSuggested index: (ville, points_fidelite).',
    theme: 'databases',
  },
  {
    motif: 'Filtered sorted query + suggested index. Table "products": list rows where prix < 10, sorted by prix DESC, limit 5.',
    reponse: 'SELECT * FROM products\nWHERE prix < 10\nORDER BY prix DESC LIMIT 5;\nSuggested index: (prix) — check the EXPLAIN plan on a sample.',
    theme: 'databases',
  },
  {
    motif: 'Requête filtrée triée + index conseillé. Table « reservations » : lister les lignes où participants >= 500, triées par participants ASC, limite 200.',
    reponse: 'SELECT * FROM reservations\nWHERE participants >= 500\nORDER BY participants ASC LIMIT 200;\nIndex conseillé : (participants) — vérifier le plan EXPLAIN sur un échantillon.',
    theme: 'databases',
  },
  {
    motif: 'Requête filtrée triée + index conseillé. Table « produits » : lister les lignes où prix <= 10,000, triées par prix DESC, limite 100.',
    reponse: 'SELECT * FROM produits\nWHERE prix <= 10,000\nORDER BY prix DESC LIMIT 100;\nIndex conseillé : (prix) — vérifier le plan EXPLAIN sur un échantillon.',
    theme: 'databases',
  },
  {
    motif: 'Filtered sorted query + suggested index. Table "visits": list rows where duree_min <= 10, sorted by duree_min ASC, limit 50.',
    reponse: 'SELECT * FROM visits\nWHERE duree_min <= 10\nORDER BY duree_min ASC LIMIT 50;\nSuggested index: (duree_min) — check the EXPLAIN plan on a sample.',
    theme: 'databases',
  },
  {
    motif: 'Readable aggregation + suggested index. Table "bookings": MAX(participants) per salle, all values, top 50, DESC sort.',
    reponse: 'SELECT salle, MAX(participants) AS resultat\nFROM bookings\nGROUP BY salle ORDER BY resultat DESC LIMIT 50;\nSuggested index: (salle, participants) as the table grows.',
    theme: 'databases',
  },
  {
    motif: 'Émets UNIQUEMENT l\'appel d\'outil JSON attendu. Transforme en appel d\'outil JSON : « reserver salle — salle, creneau ».',
    reponse: '```json\n{"outil": "reserver_salle", "arguments": {"salle": "Sahel", "creneau": "9h-10h"}}\n```\nAucun champ inventé : toute donnée manquante doit être demandée à l\'utilisateur.',
    theme: 'tools',
  },
  {
    motif: 'Émets UNIQUEMENT l\'appel d\'outil JSON attendu. Transforme en appel d\'outil JSON : « passer commande — produit_id, quantite ».',
    reponse: '```json\n{"outil": "passer_commande", "arguments": {"produit_id": "SKU-8233", "quantite": "1"}}\n```\nAucun champ inventé : toute donnée manquante doit être demandée à l\'utilisateur.',
    theme: 'tools',
  },
  {
    motif: 'Emit ONLY the expected JSON tool call. Turn into a JSON tool call: "search product — term, max_price".',
    reponse: '```json\n{"tool": "search_product", "arguments": {"term": "27-inch monitor", "max_price": "300"}}\n```\nNo invented fields: any missing data must be asked to the user.',
    theme: 'tools',
  },
  {
    motif: 'Root cause, minimal fix, regression test. In panier.ts (line ~149), symptom: string-concatenated SQL (variable "chargementEnCours"). Diagnosis and fix?',
    reponse: 'Diagnosis: classic root cause — parameterized query (%s / ?) + least-privilege account.\nMinimal fix on "chargementEnCours" + a regression test reproducing the line-149 case.',
    theme: 'code_v4',
  },
  {
    motif: 'Contrat (statuts, erreurs, garde-fous) en 5 lignes maximum. Concevoir : GET /api/livraisons?statut=…&page=2&limit=10 (ressource : livraisons, action : detail).',
    reponse: 'Contrat : GET /api/livraisons?statut=…&page=2&limit=10 → 200 avec l\'entité ; 404 si absente\nErreurs : 400 validation par champ, 401 sans session, 403 hors périmètre, 429 (Retry-After).\nGarde-fous : logs sans PII, Idempotency-Key sur POST, pagination bornée à 10.',
    theme: 'code_v4',
  },
  {
    motif: 'Écris la fonction typée et validée, puis ses tests essentiels. Fonction Python : prix ttc — paramètres d\'exemple : 235, 350, 40 %, 2.',
    reponse: 'def prix_ttc(ht: float, taux: float) -> float:\n    return round(ht * (1 + taux / 100), 2)\n\nVérification ; prix_ttc(235, 40) = 329.0\nTests : cas nominal, bornes (0, négatif), entrée invalide → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Write the typed, validated function, then its key tests. Python function: discount — sample parameters: 586, 653, 25%, 3.',
    reponse: 'def remise(prix: float, pourcent: float) -> float:\n    if prix < 0 or not 0 <= pourcent <= 100:\n        raise ValueError(\'parametres invalides\')\n    return round(prix * (1 - pourcent / 100), 2)\n\nCheck ; remise(586, 25) = 439.5\nTests: happy path, boundaries (0, negative), invalid input → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Root cause, minimal fix, regression test. In tasks.py (line ~28), symptom: Date built in local time instead of UTC (variable "compteur"). Diagnosis and fix?',
    reponse: 'Diagnosis: classic root cause — build in UTC and convert at display time.\nMinimal fix on "compteur" + a regression test reproducing the line-28 case.',
    theme: 'code_v4',
  },
  {
    motif: 'Requête lisible + considération d\'index. SQL : dans « livraisons », lister les 12 % lignes au plus montant plus grands, en excluant les montants sous 2000 francs.',
    reponse: 'SELECT * FROM livraisons\nWHERE montant >= 2000\nORDER BY montant DESC\nLIMIT (SELECT CEIL(COUNT(*) * 12 / 100.0) FROM livraisons WHERE montant >= 2000);\nIndex conseillé : (montant) — vérifier le plan EXPLAIN sur un échantillon.',
    theme: 'code_v4',
  },
  {
    motif: 'Écris la fonction typée et validée, puis ses tests essentiels. Fonction Python : moyenne ponderee — paramètres d\'exemple : 902, 50, 50 %, 4.',
    reponse: 'def moyenne_ponderee(notes: list[float], poids: list[float]) -> float:\n    if not notes or sum(poids) == 0:\n        raise ValueError(\'entrees invalides\')\n    return sum(n * w for n, w in zip(notes, poids)) / sum(poids)\n\nVérification ; cas vide → ValueError\nTests : cas nominal, bornes (0, négatif), entrée invalide → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Écris la fonction typée et validée, puis ses tests essentiels. Fonction Python : arrondi bancaire — paramètres d\'exemple : 729, 315, 20 %, 4.',
    reponse: 'from decimal import Decimal, ROUND_HALF_EVEN\ndef arrondi_bancaire(x: float, nd: int = 2) -> float:\n    return float(Decimal(str(x)).quantize(Decimal(\'0.01\'), ROUND_HALF_EVEN))\n\nVérification ; evite la dérive binaire des floats\nTests : cas nominal, bornes (0, négatif), entrée invalide → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Root cause, minimal fix, regression test. In paiement.py (line ~189), symptom: missing await on a coroutine (variable "resultats"). Diagnosis and fix?',
    reponse: 'Diagnosis: classic root cause — explicit await or supervised create_task.\nMinimal fix on "resultats" + a regression test reproducing the line-189 case.',
    theme: 'code_v4',
  },
  {
    motif: 'Cause racine, correctif minimal, test de non-régression. Dans api.py (ligne ~395), symptôme : await manquant sur une coroutine (variable « donnees »). Diagnostic et correctif ?',
    reponse: 'Diagnostic : cause racine classique — await explicite ou create_task supervisé.\nCorrectif minimal sur « donnees » + test de non-régression reproduisant le cas ligne 395.',
    theme: 'code_v4',
  },
  {
    motif: 'Write the typed, validated function, then its key tests. Python function: weighted average — sample parameters: 516, 592, 25%, 2.',
    reponse: 'def moyenne_ponderee(notes: list[float], poids: list[float]) -> float:\n    if not notes or sum(poids) == 0:\n        raise ValueError(\'entrees invalides\')\n    return sum(n * w for n, w in zip(notes, poids)) / sum(poids)\n\nCheck ; empty case → ValueError\nTests: happy path, boundaries (0, negative), invalid input → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Contrat (statuts, erreurs, garde-fous) en 5 lignes maximum. Concevoir : GET /api/factures?montant_min=…&page=2&limit=50 (ressource : factures, action : detail).',
    reponse: 'Contrat : GET /api/factures?montant_min=…&page=2&limit=50 → 200 avec l\'entité ; 404 si absente\nErreurs : 400 validation par champ, 401 sans session, 403 hors périmètre, 429 (Retry-After).\nGarde-fous : logs sans PII, Idempotency-Key sur POST, pagination bornée à 50.',
    theme: 'code_v4',
  },
  {
    motif: 'Write the typed, validated function, then its key tests. Python function: margin percent — sample parameters: 285, 124, 3%, 3.',
    reponse: 'def marge_pourcent(cout: float, prix: float) -> float:\n    if prix <= 0:\n        raise ValueError(\'prix doit etre positif\')\n    return round((prix - cout) / prix * 100, 1)\n\nCheck ; marge_pourcent(285, 124) = -129.8%\nTests: happy path, boundaries (0, negative), invalid input → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Write the typed, validated function, then its key tests. Python function: multi-key sort — sample parameters: 407, 648, 35%, 4.',
    reponse: 'def tri_multi_cles(lignes: list[dict]) -> list[dict]:\n    return sorted(lignes, key=lambda r: (r.get(\'priorite\', 0), r.get(\'nom\', \'\')))\n\nCheck ; stability guaranteed by sorted (Timsort)\nTests: happy path, boundaries (0, negative), invalid input → ValueError.',
    theme: 'code_v4',
  },
  {
    motif: 'Invention rate + measurable corrective actions. Hallucination eval: 225 trick technique questions (answer absent from sources), 10% invented. Action?',
    reponse: '10% rate — unacceptable for a sensitive domain.\nActions: grounded mode with mandatory citations; explicit refusal when the source lacks the answer; re-test on a FRESH 225-case set before release.',
    theme: 'security_v4',
  },
  {
    motif: 'Defense in depth (never offense) + safe logging. Defense — assistant de support: attempt T-5727 (3e tentative en 24 h) tries injection via a filename containing instructions. Expected system response?',
    reponse: 'T-5727 | Defense in depth: sanitize metadata; filenames are data, not instructions.\nLogging: record the attempt type + timestamp (3e tentative en 24 h), never echoing the payload into accessible logs.',
    theme: 'security_v4',
  },
  {
    motif: 'Catégorie + correctif défensif UNIQUEMENT. Revue défensive SEC-2026-6348 — api.py ligne ~99 (module file upload) : reflet de saisie dans du HTML. Sévérité estimée : haute. Catégorie et correction ?',
    reponse: 'SEC-2026-6348 | Catégorie : XSS | Sévérité : haute.\nCorrection défensive : échapper à la sortie + CSP sans unsafe-inline.\nTest : cas d\'attaque reproductible en environnement de TEST ; jamais contre un système réel sans autorisation écrite.',
    theme: 'security_v4',
  },
  {
    motif: 'Taux d\'invention + actions correctives mesurables. Évaluation d\'hallucination : 225 questions financiers piégées (réponse absente des sources), 14 % d\'inventions. Action ?',
    reponse: 'Taux 14 % — inacceptable pour un domaine sensible.\nActions : mode « réponse ancrée » avec citations obligatoires ; refus explicite si la source ne contient pas la réponse ; re-test sur un jeu NEUF de 225 cas avant publication.',
    theme: 'security_v4',
  },
  {
    motif: 'Invention rate + measurable corrective actions. Hallucination eval: 275 trick juridique questions (answer absent from sources), 3% invented. Action?',
    reponse: '3% rate — acceptable for a sensitive domain.\nActions: grounded mode with mandatory citations; explicit refusal when the source lacks the answer; re-test on a FRESH 275-case set before release.',
    theme: 'security_v4',
  },
  {
    motif: 'Catégorie + correctif défensif UNIQUEMENT. Revue défensive SEC-2024-6838 — payment.ts ligne ~447 (module export de données) : appel réseau vers une URL fournie. Sévérité estimée : moyenne. Catégorie et correction ?',
    reponse: 'SEC-2024-6838 | Catégorie : SSRF | Sévérité : moyenne.\nCorrection défensive : liste blanche d\'hôtes + interdire les IP privées.\nTest : cas d\'attaque reproductible en environnement de TEST ; jamais contre un système réel sans autorisation écrite.',
    theme: 'security_v4',
  },
  {
    motif: 'Défense en profondeur (jamais d\'offense) + journalisation sûre. Défense — chatbot e-commerce : tentative T-7821 (3e tentative en 24 h) tente balises factices pour changer de rôle. Réponse attendue du système ?',
    reponse: 'T-7821 | Défense en profondeur : neutraliser les balises à l\'ingestion, séparer canaux système/contenu.\nJournalisation : enregistrer type + horodatage (3e tentative en 24 h), sans jamais répéter la charge utile dans des logs accessibles.',
    theme: 'security_v4',
  },
  {
    motif: 'Defense in depth (never offense) + safe logging. Defense — assistant de support: attempt T-6442 (2e tentative en 24 h) tries fake tags to switch roles. Expected system response?',
    reponse: 'T-6442 | Defense in depth: sanitize tags at ingestion, separate system/content channels.\nLogging: record the attempt type + timestamp (2e tentative en 24 h), never echoing the payload into accessible logs.',
    theme: 'security_v4',
  },
  {
    motif: 'Category + defensive fix ONLY. Defensive review SEC-2025-2128 — route.ts line ~278 (administration module): data encrypted with a hardcoded key. Estimated severity: moyenne. Category and fix?',
    reponse: 'SEC-2025-2128 | Category: cryptographie cassée / broken crypto | Severity: moyenne.\nDefensive fix: key management via vault + rotation.\nTest: reproducible attack case in a TEST environment; never against a real system without written authorization.',
    theme: 'security_v4',
  },
  {
    motif: 'Invention rate + measurable corrective actions. Hallucination eval: 250 trick financier questions (answer absent from sources), 11% invented. Action?',
    reponse: '11% rate — unacceptable for a sensitive domain.\nActions: grounded mode with mandatory citations; explicit refusal when the source lacks the answer; re-test on a FRESH 250-case set before release.',
    theme: 'security_v4',
  },
  {
    motif: 'Invention rate + measurable corrective actions. Hallucination eval: 250 trick financier questions (answer absent from sources), 7% invented. Action?',
    reponse: '7% rate — unacceptable for a sensitive domain.\nActions: grounded mode with mandatory citations; explicit refusal when the source lacks the answer; re-test on a FRESH 250-case set before release.',
    theme: 'security_v4',
  },
  {
    motif: 'Category + defensive fix ONLY. Defensive review SEC-2025-7424 — auth.py line ~728 (administration module): network call to a user-supplied URL. Estimated severity: high. Category and fix?',
    reponse: 'SEC-2025-7424 | Category: SSRF | Severity: high.\nDefensive fix: host allowlist + deny private IPs.\nTest: reproducible attack case in a TEST environment; never against a real system without written authorization.',
    theme: 'security_v4',
  },
  {
    motif: 'Catégorie + correctif défensif UNIQUEMENT. Revue défensive SEC-2024-1552 — upload.ts ligne ~319 (module profil utilisateur) : formulaire sans jeton anti-CSRF. Sévérité estimée : moyenne. Catégorie et correction ?',
    reponse: 'SEC-2024-1552 | Catégorie : CSRF | Sévérité : moyenne.\nCorrection défensive : jeton de session + SameSite=Strict.\nTest : cas d\'attaque reproductible en environnement de TEST ; jamais contre un système réel sans autorisation écrite.',
    theme: 'security_v4',
  },
  {
    motif: 'Invention rate + measurable corrective actions. Hallucination eval: 100 trick historical questions (answer absent from sources), 4% invented. Action?',
    reponse: '4% rate — acceptable for a sensitive domain.\nActions: grounded mode with mandatory citations; explicit refusal when the source lacks the answer; re-test on a FRESH 100-case set before release.',
    theme: 'security_v4',
  },
  {
    motif: 'Category + defensive fix ONLY. Defensive review SEC-2025-7239 — payment.ts line ~594 (administration module): SQL query built by concatenation. Estimated severity: high. Category and fix?',
    reponse: 'SEC-2025-7239 | Category: injection SQL / SQL injection | Severity: high.\nDefensive fix: parameterized queries + least-privilege account.\nTest: reproducible attack case in a TEST environment; never against a real system without written authorization.',
    theme: 'security_v4',
  },
  {
    motif: 'Compte par zone et compare — ne compte que ce qui est spécifié. Spécification : 1 moulin à cafés à gauche du cadre, 4 à droite.',
    reponse: 'Total : 5 moulin à cafés. Côté le plus fourni : droite (1 contre 4).',
    theme: 'image_analysis',
  },
  {
    motif: 'Read the series, name the trend and compute the percentage change. Monthly series "sales": March=200, April=180, May=195 (units).\nQuestion: trend and overall change in %?',
    reponse: 'Trend: down over March–May. Change: -2.5% (200 → 195 units).',
    theme: 'image_analysis',
  },
  {
    motif: 'Count per zone and compare — only what is specified. Spec: 2 phones on the left of the frame, 3 on the right.',
    reponse: 'Total: 5 phones. Busier side: right (2 vs 3).',
    theme: 'image_analysis',
  },
  {
    motif: 'Transcris fidèlement le texte du document, champ par champ, avec la langue détectée. Zanbara Tech\nFacture N° CMD-105747\nTOTAL : 1250 FCFA\nMerci de votre visite',
    reponse: 'Transcription OCR : marque=Zanbara Tech, référence=CMD-105747, total=1250 FCFA.\nLangue : français. Champ ambigu : aucun. Les totaux sont repris tels qu\'imprimés.',
    theme: 'image_analysis',
  },
  {
    motif: 'Transcris fidèlement le texte du document, champ par champ, avec la langue détectée. Zanbara Tech\nFacture N° ORD-447656\nTOTAL : 1500 FCFA\nMerci de votre visite',
    reponse: 'Transcription OCR : marque=Zanbara Tech, référence=ORD-447656, total=1500 FCFA.\nLangue : français. Champ ambigu : aucun. Les totaux sont repris tels qu\'imprimés.',
    theme: 'image_analysis',
  },
  {
    motif: 'Read the series, name the trend and compute the percentage change. Monthly series "sales": January=180, February=140, March=110 (units).\nQuestion: trend and overall change in %?',
    reponse: 'Trend: down over January–March. Change: -38.9% (180 → 110 units).',
    theme: 'image_analysis',
  },
  {
    motif: 'Lis la série, nomme la tendance et calcule la variation en pourcentage. Série mensuelle « ventes » : avril=300, mai=260, juin=310 (unités).\nQuestion : tendance et variation globale en % ?',
    reponse: 'Tendance : hausse sur la période avril–juin. Variation : +3.3 % (300 → 310 unités).',
    theme: 'image_analysis',
  },
  {
    motif: 'Lis la série, nomme la tendance et calcule la variation en pourcentage. Série mensuelle « ventes » : avril=180, mai=160, juin=175 (unités).\nQuestion : tendance et variation globale en % ?',
    reponse: 'Tendance : baisse sur la période avril–juin. Variation : -2.8 % (180 → 175 unités).',
    theme: 'image_analysis',
  },
  {
    motif: 'Describe the scene from the spec, without inventing absent elements. Scene spec: a sewing workshop in Cotonou. Elements: a sewing machine, fabric rolls, a measuring tape, office lighting. Visible people: 2.',
    reponse: 'Expected description: a sewing workshop in Cotonou, showing a sewing machine, fabric rolls, a measuring tape, office lighting. About 2 people are visible, placed in the lower third of the frame. I describe only the listed elements — nothing else is claimed.',
    theme: 'image_analysis',
  },
  {
    motif: 'Compte par zone et compare — ne compte que ce qui est spécifié. Spécification : 4 éventails à gauche du cadre, 4 à droite.',
    reponse: 'Total : 8 éventails. Côté le plus fourni : égalité (4 de chaque côté).',
    theme: 'image_analysis',
  },
  {
    motif: 'Transcris fidèlement le texte du document, champ par champ, avec la langue détectée. Kanouma Distribution\nFacture N° CMD-757296\nTOTAL : 750 FCFA\nMerci de votre visite',
    reponse: 'Transcription OCR : marque=Kanouma Distribution, référence=CMD-757296, total=750 FCFA.\nLangue : français. Champ ambigu : aucun. Les totaux sont repris tels qu\'imprimés.',
    theme: 'image_analysis',
  },
  {
    motif: 'Read the series, name the trend and compute the percentage change. Monthly series "sales": April=200, May=160, June=175 (units).\nQuestion: trend and overall change in %?',
    reponse: 'Trend: down over April–June. Change: -12.5% (200 → 175 units).',
    theme: 'image_analysis',
  },
  {
    motif: 'Faithfully transcribe the document text, field by field, with the detected language. Sahel Express\nInvoice N° ORD-312056\nTOTAL: 500 FCFA\nThank you for your visit',
    reponse: 'OCR transcription: brand=Sahel Express, reference=ORD-312056, total=500 FCFA.\nLanguage: English. Ambiguous field: none. Totals copied as printed.',
    theme: 'image_analysis',
  },
  {
    motif: 'Transcris fidèlement le texte du document, champ par champ, avec la langue détectée. Zanbara Tech\nFacture N° CMD-866377\nTOTAL : 40 FCFA\nMerci de votre visite',
    reponse: 'Transcription OCR : marque=Zanbara Tech, référence=CMD-866377, total=40 FCFA.\nLangue : français. Champ ambigu : aucun. Les totaux sont repris tels qu\'imprimés.',
    theme: 'image_analysis',
  },
  {
    motif: 'Transcris fidèlement le texte du document, champ par champ, avec la langue détectée. Kora Retail\nFacture N° CMD-221713\nTOTAL : 15 FCFA\nMerci de votre visite',
    reponse: 'Transcription OCR : marque=Kora Retail, référence=CMD-221713, total=15 FCFA.\nLangue : français. Champ ambigu : aucun. Les totaux sont repris tels qu\'imprimés.',
    theme: 'image_analysis',
  },
  {
    motif: 'Faithfully transcribe the document text, field by field, with the detected language. Kanouma\nInvoice N° ORD-705217\nTOTAL: 1000 FCFA\nThank you for your visit',
    reponse: 'OCR transcription: brand=Kanouma, reference=ORD-705217, total=1000 FCFA.\nLanguage: English. Ambiguous field: none. Totals copied as printed.',
    theme: 'image_analysis',
  },
  {
    motif: 'Transcris fidèlement le texte du document, champ par champ, avec la langue détectée. Kanouma Distribution\nFacture N° ORD-450029\nTOTAL : 1250 FCFA\nMerci de votre visite',
    reponse: 'Transcription OCR : marque=Kanouma Distribution, référence=ORD-450029, total=1250 FCFA.\nLangue : français. Champ ambigu : aucun. Les totaux sont repris tels qu\'imprimés.',
    theme: 'image_analysis',
  },
  {
    motif: 'Faithfully transcribe the document text, field by field, with the detected language. Zanbara Tech\nInvoice N° ORD-839122\nTOTAL: 200 FCFA\nThank you for your visit',
    reponse: 'OCR transcription: brand=Zanbara Tech, reference=ORD-839122, total=200 FCFA.\nLanguage: English. Ambiguous field: none. Totals copied as printed.',
    theme: 'image_analysis',
  },
  {
    motif: 'Faithfully transcribe the document text, field by field, with the detected language. Zanbara Tech\nInvoice N° CMD-284179\nTOTAL: 150 FCFA\nThank you for your visit',
    reponse: 'OCR transcription: brand=Zanbara Tech, reference=CMD-284179, total=150 FCFA.\nLanguage: English. Ambiguous field: none. Totals copied as printed.',
    theme: 'image_analysis',
  },
  {
    motif: 'Compute the exact duration and describe the filter chain. Edit: 5 keyframes of 2 s each, 1.0 s crossfade between them. Final duration?',
    reponse: 'Final duration = 5 × 2 − (5 − 1) × 1.0 = 6.0 s.\nTypical filter: chained xfade=transition=fade:duration=1.0 between segments; audio with an output afade 2 s before the end.',
    theme: 'video_v4',
  },
  {
    motif: 'Produis un SRT bien formé avec timings cohérents et la règle de longueur. Génère les sous-titres SRT d\'une voix-off de 4 phrases (~12 s).',
    reponse: 'SRT :\n1\n00:00:00,000 --> 00:00:03,000\nBonjour et bienvenue.\n\n2\n00:00:03,000 --> 00:00:06,000\nVoici le sujet du jour.\n\n3\n00:00:06,000 --> 00:00:09,000\nRegardons ensemble.\n\n4\n00:00:09,000 --> 00:00:12,000\nUn exemple concret.\n\nRègle : jamais plus de 42 caractères par ligne ; ajuster les temps si la voix déborde.',
    theme: 'video_v4',
  },
  {
    motif: 'Calcule la durée exacte et décris la chaîne de filtres. Montage : 3 keyframes de 2 s chacune, fondu enchaîné de 0.5 s entre elles. Durée finale ?',
    reponse: 'Durée finale = 3 × 2 − (3 − 1) × 0.5 = 5.0 s.\nFiltre type : xfade=transition=fade:duration=0.5 chaîné entre segments ; audio en fondu de sortie (afade) 2 s avant la fin.',
    theme: 'video_v4',
  },
  {
    motif: 'Produis un SRT bien formé avec timings cohérents et la règle de longueur. Génère les sous-titres SRT d\'une voix-off de 3 phrases (~6 s).',
    reponse: 'SRT :\n1\n00:00:00,000 --> 00:00:02,000\nBonjour et bienvenue.\n\n2\n00:00:02,000 --> 00:00:04,000\nVoici le sujet du jour.\n\n3\n00:00:04,000 --> 00:00:06,000\nRegardons ensemble.\n\nRègle : jamais plus de 42 caractères par ligne ; ajuster les temps si la voix déborde.',
    theme: 'video_v4',
  },
  {
    motif: 'Calcule la durée exacte et décris la chaîne de filtres. Montage : 3 keyframes de 3 s chacune, fondu enchaîné de 0.5 s entre elles. Durée finale ?',
    reponse: 'Durée finale = 3 × 3 − (3 − 1) × 0.5 = 8.0 s.\nFiltre type : xfade=transition=fade:duration=0.5 chaîné entre segments ; audio en fondu de sortie (afade) 2 s avant la fin.',
    theme: 'video_v4',
  },
  {
    motif: 'Compute the exact duration and describe the filter chain. Edit: 4 keyframes of 2 s each, 0.5 s crossfade between them. Final duration?',
    reponse: 'Final duration = 4 × 2 − (4 − 1) × 0.5 = 6.5 s.\nTypical filter: chained xfade=transition=fade:duration=0.5 between segments; audio with an output afade 2 s before the end.',
    theme: 'video_v4',
  },
  {
    motif: 'Calcule la durée exacte et décris la chaîne de filtres. Montage : 5 keyframes de 2 s chacune, fondu enchaîné de 1.0 s entre elles. Durée finale ?',
    reponse: 'Durée finale = 5 × 2 − (5 − 1) × 1.0 = 6.0 s.\nFiltre type : xfade=transition=fade:duration=1.0 chaîné entre segments ; audio en fondu de sortie (afade) 2 s avant la fin.',
    theme: 'video_v4',
  },
  {
    motif: 'Calcule la durée exacte et décris la chaîne de filtres. Montage : 4 keyframes de 3 s chacune, fondu enchaîné de 0.5 s entre elles. Durée finale ?',
    reponse: 'Durée finale = 4 × 3 − (4 − 1) × 0.5 = 10.5 s.\nFiltre type : xfade=transition=fade:duration=0.5 chaîné entre segments ; audio en fondu de sortie (afade) 2 s avant la fin.',
    theme: 'video_v4',
  },
  {
    motif: 'Calcule la durée exacte et décris la chaîne de filtres. Montage : 5 keyframes de 2 s chacune, fondu enchaîné de 0.5 s entre elles. Durée finale ?',
    reponse: 'Durée finale = 5 × 2 − (5 − 1) × 0.5 = 8.0 s.\nFiltre type : xfade=transition=fade:duration=0.5 chaîné entre segments ; audio en fondu de sortie (afade) 2 s avant la fin.',
    theme: 'video_v4',
  },
  {
    motif: 'Compute the exact duration and describe the filter chain. Edit: 4 keyframes of 3 s each, 1.0 s crossfade between them. Final duration?',
    reponse: 'Final duration = 4 × 3 − (4 − 1) × 1.0 = 9.0 s.\nTypical filter: chained xfade=transition=fade:duration=1.0 between segments; audio with an output afade 2 s before the end.',
    theme: 'video_v4',
  },
  {
    motif: 'Prepare the TTS brief: segmented text, tone, rate, pauses. Message to synthesize about the bluetooth speaker, neutral and professional tone, 2 sentences.',
    reponse: 'TTS brief: neutral and professional tone, ×0.8 rate, marquées pauses at commas and between sentences.\nText (2 sentences): "Thank you for your trust. Any question? We remain available."\nVoice: ff_siwis (French) or default English tier. Honest limit: 2,000 characters per segment; beyond that, split into segments and concatenate.',
    theme: 'voice_speech',
  },
  {
    motif: 'Prepare the TTS brief: segmented text, tone, rate, pauses. Message to synthesize about the organic basket, energetic and motivating tone, 2 sentences.',
    reponse: 'TTS brief: energetic and motivating tone, ×0.95 rate, courtes pauses at commas and between sentences.\nText (2 sentences): "Thank you for your trust. Our advisors answer within 24 hours."\nVoice: ff_siwis (French) or default English tier. Honest limit: 2,000 characters per segment; beyond that, split into segments and concatenate.',
    theme: 'voice_speech',
  },
  {
    motif: 'Segmented transcription method and inaudible handling. 90s audio to transcribe (language: French (regional accent), modéré noise, 1 speaker(s)).',
    reponse: 'Plan: split into ≤ 30 s segments; transcribe segment by segment; punctuate and normalize numbers; mark inaudible parts as [inaudible mm:ss] instead of inventing; distinguish speakers (1); deliver raw text then the readable version.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 90 s à transcrire (langue : anglais, bruit faible, 3 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (3) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Classe l\'environnement sonore à partir des indices, avec un niveau de confiance honnête. Indices audio (de nuit) : cloches de vélos, roulements de caisses. Où sommes-nous probablement ?',
    reponse: 'Milieu probable : un marché. Indices concordants : cloches de vélos, roulements de caisses ; cohérents avec l\'heure (de nuit). Confiance cautious — exprimée qualitativement, jamais surestimée.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Classe l\'environnement sonore à partir des indices, avec un niveau de confiance honnête. Indices audio (de midi) : moteurs de barques, vagues, câbles sur les pontons. Où sommes-nous probablement ?',
    reponse: 'Milieu probable : un port de pêche. Indices concordants : moteurs de barques, vagues, câbles sur les pontons ; cohérents avec l\'heure (de midi). Confiance prudente — exprimée qualitativement, jamais surestimée.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Classe l\'environnement sonore à partir des indices, avec un niveau de confiance honnête. Indices audio (du matin) : vent dans les échafaudages, marteau-piqueur par intermittence. Où sommes-nous probablement ?',
    reponse: 'Milieu probable : un chantier. Indices concordants : vent dans les échafaudages, marteau-piqueur par intermittence ; cohérents avec l\'heure (du matin). Confiance high — exprimée qualitativement, jamais surestimée.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 15 s à transcrire (langue : français, bruit modéré, 1 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (1) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 240 s à transcrire (langue : anglais, bruit low, 2 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (2) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 90 s à transcrire (langue : français (accent régional), bruit modéré, 2 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (2) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 120 s à transcrire (langue : anglais, bruit faible, 1 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (1) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Classify the sound environment from cues, with honest confidence. Audio cues (morning): bicycle bells, crate rolling, crowd murmur. Where are we most likely?',
    reponse: 'Likely setting: a market. Matching cues: bicycle bells, crate rolling, crowd murmur ; consistent with the time (morning). Modérée confidence — qualitative, never overstated.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Segmented transcription method and inaudible handling. 30s audio to transcribe (language: français (accent régional), fort par moments noise, 2 speaker(s)).',
    reponse: 'Plan: split into ≤ 30 s segments; transcribe segment by segment; punctuate and normalize numbers; mark inaudible parts as [inaudible mm:ss] instead of inventing; distinguish speakers (2); deliver raw text then the readable version.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Classe l\'environnement sonore à partir des indices, avec un niveau de confiance honnête. Indices audio (de nuit) : chaises déplacées, craie sur tableau, chœurs d\'enfants, cloche. Où sommes-nous probablement ?',
    reponse: 'Milieu probable : une école. Indices concordants : chaises déplacées, craie sur tableau, chœurs d\'enfants, cloche ; cohérents avec l\'heure (de nuit). Confiance high — exprimée qualitativement, jamais surestimée.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Segmented transcription method and inaudible handling. 240s audio to transcribe (language: français (accent régional), faible noise, 2 speaker(s)).',
    reponse: 'Plan: split into ≤ 30 s segments; transcribe segment by segment; punctuate and normalize numbers; mark inaudible parts as [inaudible mm:ss] instead of inventing; distinguish speakers (2); deliver raw text then the readable version.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 120 s à transcrire (langue : anglais, bruit modéré, 2 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (2) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Segmented transcription method and inaudible handling. 120s audio to transcribe (language: French (regional accent), moderate noise, 2 speaker(s)).',
    reponse: 'Plan: split into ≤ 30 s segments; transcribe segment by segment; punctuate and normalize numbers; mark inaudible parts as [inaudible mm:ss] instead of inventing; distinguish speakers (2); deliver raw text then the readable version.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Classify the sound environment from cues, with honest confidence. Audio cues (at night): boat engines, cables on the docks, seagulls, waves. Where are we most likely?',
    reponse: 'Likely setting: a fishing port. Matching cues: boat engines, cables on the docks, seagulls, waves ; consistent with the time (at night). Élevée confidence — qualitative, never overstated.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Segmented transcription method and inaudible handling. 60s audio to transcribe (language: French (regional accent), moderate noise, 3 speaker(s)).',
    reponse: 'Plan: split into ≤ 30 s segments; transcribe segment by segment; punctuate and normalize numbers; mark inaudible parts as [inaudible mm:ss] instead of inventing; distinguish speakers (3); deliver raw text then the readable version.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 30 s à transcrire (langue : français (accent régional), bruit fort par moments, 3 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (3) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Méthode de transcription segmentée et traitement des inaudibles. Audio de 240 s à transcrire (langue : English, bruit low, 2 locuteur(s)).',
    reponse: 'Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] au lieu d\'inventer ; distinguer les locuteurs (2) ; livrer le texte brut puis la version lisible.',
    theme: 'audio_understanding',
  },
  {
    motif: 'Proposez un slogan pour une campagne de recyclage.',
    reponse: '1. "Réduire, réutiliser, recycler : Ensemble pour un avenir plus vert."\n2. "Recycler aujourd\'hui, pour un lendemain meilleur."\n3. "Transformez vos déchets en trésors - Recyclez!"\n4. "Recyclez pour le cycle de la vie."\n5. "Économisez des ressources, recyclez davantage."',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Trouvez un moyen unique et humoristique pour décrire le président de votre pays.',
    reponse: 'En tant qu\'IA, je n\'appartiens à aucun pays et n\'ai donc pas de président particulier à décrire. Cependant, je peux vous aider à trouver une description unique et humoristique du président de votre pays si vous me fournissez plus d\'informations !',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Étant donné une description d\'un événement personnel, écrivez un vers en style haïku.\nNageant dans la mer un jour ensoleillé',
    reponse: 'Océan bleu miroitant\nLe soleil brille sur l\'eau ondoyante\nLa sérénité nage.',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Classifiez ces cinq objets dans une catégorie unique et significative.\nCrayon, papier, gomme, règle, livre.',
    reponse: 'La seule catégorie significative pour ces objets serait "Articles de papeterie" ou "Fournitures scolaires".',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Sélectionnez les adjectifs appropriés pour décrire le nom donné.\nVacances',
    reponse: 'relaxantes, aventureuses, amusantes, revigorantes, excitantes, paisibles, mémorables, agréables, luxueuses, panoramiques.',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Générer un titre créatif pour un article sur les implications éthiques de l\'utilisation de l\'intelligence artificielle pour la justice pénale.',
    reponse: 'Justice ou biais : Le dilemme éthique de l\'IA dans le système de justice pénale.',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Quels sont les cinq goûts différents que les humains peuvent détecter ?',
    reponse: 'Les cinq goûts de base que les humains peuvent détecter sont le sucré, l\'acide, le salé, l\'amer et l\'umami (savoureux). Ces goûts sont détectés par des récepteurs de goût sur la langue et dans la bouche, et sont souvent combinés dans différents aliments pour créer une variété de saveurs.',
    theme: 'conversation_scenario',
  },
  {
    motif: 'S\'il vous plaît séparez les phrases complètes ci-dessous en mots.\nLe soleil se lève à l\'est.',
    reponse: '[\'Le\', \'soleil\', \'se\', \'lève\', \'à\', \'l\\\\\'est\']',
    theme: 'conversation_scenario',
  },
  {
    motif: 'Analysez la phrase suivante pour les Parties du discours (POS).\nElle est allée au magasin.',
    reponse: 'Les parties du discours dans la phrase "Elle est allée au magasin" sont:\n\n1. Elle - pronom (sujet de la phrase)\n2. est allée - verbe (action, passé composé de aller)\n3. au - préposition (indiquant la direction ou l\'emplacement)\n4. le - article (utilisé avant le nom)\n5. magasin - nom (objet de la préposition "au")',
    theme: 'conversation_scenario',
  },
];

/** Nombre de paires multi-domaines ajoutées par it.84. */
export const TAILLE_CORPUS_DOMAINES_IT84 = CORPUS_DOMAINES_IT84.length; // 200
