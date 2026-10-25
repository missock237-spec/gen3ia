#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum v4 — Phase 1 : langage et compréhension (135 000 lignes).

  nlp_comprehension        40 000 — compréhension de textes (réponses vérifiables par construction)
  text_generation          30 000 — génération de texte (articles, emails, histoires, annonces)
  contextual_understanding 25 000 — compréhension contextuelle (références, implicites)
  conversational_memory    20 000 — mémoire conversationnelle (rappel et combinaison de faits)
  intent_recognition       20 000 — reconnaissance d'intention (36 intentions FR/EN)
"""

from __future__ import annotations

import random

from cv4_pools import (CITIES_EN, LIEUX_FR, MOIS_FR, MONTHS_EN, NAMES_EN, NOMS_FR,
                       OBJETS_FR, OBJECTS_EN, PLACES_EN, PRODUITS_EN, PRODUITS_FR,
                       SUJETS_FR, TOPICS_EN, VILLES_FR, MONTANTS, POURCENTAGES)

JOURS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
DAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

ACTIONS_FR = [("a acheté", "bought"), ("a réservé", "booked"), ("a réparé", "repaired"),
              ("a trouvé", "found"), ("a déposé", "dropped off"), ("a récupéré", "picked up"),
              ("a perdu", "lost"), ("a livré", "delivered"), ("a planté", "planted"),
              ("a vendu", "sold"), ("a peint", "painted"), ("a visité", "visited")]

# ═══════════════════ nlp_comprehension (40 000) ═══════════════════

def fab_comprehension(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom = rng.choice(NOMS_FR) if fr else rng.choice(NAMES_EN)
    lieu = rng.choice(LIEUX_FR) if fr else rng.choice(PLACES_EN)
    ville = rng.choice(VILLES_FR) if fr else rng.choice(CITIES_EN)
    objet = rng.choice(OBJETS_FR) if fr else rng.choice(OBJECTS_EN)
    action_fr, action_en = rng.choice(ACTIONS_FR)
    n1, n2 = rng.randint(2, 9), rng.randint(10, 99)
    montant = rng.choice(MONTANTS)
    jour = rng.choice(JOURS_FR) if fr else rng.choice(DAYS_EN)
    mois = rng.choice(MOIS_FR) if fr else rng.choice(MONTHS_EN)
    if fr:
        passage = (f"{nom} s'est rendu(e) à {lieu} à {ville} le {jour} {rng.randint(1,28)} {mois}. "
                   f"Là-bas, il/elle {action_fr} {n1} {objet}s, puis un second lot de {n2} autres. "
                   f"Le total de la facture s'élevait à {montant} francs, payés en deux fois : "
                   f"une moitié comptant, l'autre à 30 jours. "
                   f"Avant de partir, {nom} a laissé son {objet} au comptoir pour une gravure.")
        qtypes = [
            ("combien d'objets au total", f"{n1 + n2}"),
            ("où s'est rendue cette personne", f"à {lieu} à {ville}"),
            ("quel jour", f"le {jour} {rng.randint(1,28)} {mois}"),
            ("combien a coûté le total", f"{montant} francs"),
            ("quel objet a été laissé au comptoir", f"le {objet}"),
            ("combien d'objets dans le premier lot", f"{n1}"),
        ]
    else:
        passage = (f"{nom} went to {lieu} in {ville} on {jour} the {rng.randint(1,28)} of {mois}. "
                   f"There, he/she {action_en} {n1} {objet}s, then a second batch of {n2} more. "
                   f"The total bill was {montant} francs, paid in two parts: half upfront, "
                   f"the rest within 30 days. Before leaving, {nom} left the {objet} at the "
                   f"counter for engraving.")
        qtypes = [
            ("how many items in total", f"{n1 + n2}"),
            ("where did this person go", f"to {lieu} in {ville}"),
            ("on which day", f"on {jour} the {rng.randint(1,28)} of {mois}"),
            ("how much was the total", f"{montant} francs"),
            ("which item was left at the counter", f"the {objet}"),
            ("how many items in the first batch", f"{n1}"),
        ]
    question, reponse = rng.choice(qtypes)
    return {
        "task_type": "comprehension_qa",
        "language": "fr" if fr else "en",
        "instruction": ("Lis le texte puis réponds à la question UNIQUEMENT à partir de ce "
                        "qui est écrit. Si une information manque, dis-le.") if fr else
                       ("Read the text then answer the question ONLY from what is written. "
                        "If information is missing, say so."),
        "input": f"Texte :\n{passage}\n\nQuestion : {question} ?",
        "output": reponse,
        "difficulty": "facile",
    }

def fab_idee_principale(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet = rng.choice(SUJETS_FR) if fr else rng.choice(TOPICS_EN)
    ville = rng.choice(VILLES_FR) if fr else rng.choice(CITIES_EN)
    pct = rng.choice(POURCENTAGES)
    n = rng.choice(MONTANTS)
    if fr:
        passage = (f"À {ville}, une initiative consacrée à {sujet} a mobilisé {n} participants "
                   f"cette année. Les organisateurs constatent que {pct} % des projets lancés "
                   f"poursuivent leurs activités après six mois, un taux jugé encourageant. "
                   f"Trois leviers expliquent ce résultat : un accompagnement rapproché, un "
                   f"accès simplifié au financement et une formation continue aux outils "
                   f"numériques. Les prochains ateliers s'ouvriront aux lycées de la ville.")
        question = "Quelle est l'idée principale du texte ?"
        reponse = (f"Une initiative locale sur {sujet} à {ville} obtient des résultats durables "
                   f"({pct} % de projets poursuivis) grâce à l'accompagnement, au financement "
                   f"et à la formation — et va s'étendre aux lycées.")
    else:
        passage = (f"In {ville}, an initiative dedicated to {sujet} mobilized {n} participants "
                   f"this year. Organizers report that {pct}% of launched projects keep running "
                   f"after six months, a rate deemed encouraging. Three levers explain this "
                   f"result: close coaching, simplified access to funding and continuous "
                   f"training in digital tools. Upcoming workshops will open to city high schools.")
        question = "What is the main idea of the text?"
        reponse = (f"A local {sujet} initiative in {ville} achieves lasting results ({pct}% of "
                   f"projects continuing) thanks to coaching, funding and training — and will "
                   f"expand to high schools.")
    return {
        "task_type": "main_idea",
        "language": "fr" if fr else "en",
        "instruction": "Identifie l'idée principale en une phrase, sans inventer de détails." if fr
                       else "State the main idea in one sentence, without inventing details.",
        "input": passage,
        "output": reponse,
        "difficulty": "intermédiaire",
    }

def fab_ordre_evenements(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom = rng.choice(NOMS_FR) if fr else rng.choice(NAMES_EN)
    objet = rng.choice(OBJETS_FR) if fr else rng.choice(OBJECTS_EN)
    lieu = rng.choice(LIEUX_FR) if fr else rng.choice(PLACES_EN)
    etapes_fr = [("a commandé", "ordered"), ("a payé", "paid"), ("a reçu", "received"),
                 ("a installé", "installed"), ("a recommandé", "reviewed")]
    etapes = rng.sample(etapes_fr, k=3)
    perm = list(range(3)); rng.shuffle(perm)
    phrases = []
    for pos in perm:
        ef, ee = etapes[pos]
        phrases.append(f"{nom} {ef} le {objet}" if fr else f"{nom} {ee} the {objet}")
    texte = (". D'abord, " if fr else ". First, ").join([""] + phrases)[2:] + (
        f". Tout s'est passé à {lieu}." if fr else f". Everything happened at {lieu}.")
    if fr:
        question = f"Quel événement est arrivé en PREMIER ? Réponds par le verbe exact."
        reponse = phrases[0].split(" le ")[0] + " le " + objet
    else:
        question = "Which event happened FIRST? Answer with the exact verb phrase."
        reponse = phrases[0]
    return {
        "task_type": "event_ordering",
        "language": "fr" if fr else "en",
        "instruction": "Reconstitue l'ordre des événements d'après les marqueurs temporels." if fr
                       else "Reconstruct the event order from the time markers.",
        "input": texte + ("\n\nQuestion : " + question if fr else "\n\nQuestion: " + question),
        "output": reponse,
        "difficulty": "intermédiaire",
    }

# ═══════════════════ text_generation (30 000) ═══════════════════

GENRES_FR = [("article de blog", "informel et documenté"), ("email professionnel", "concis et courtois"),
             ("histoire courte", "évocateur et rythmé"), ("annonce de service", "clair et rassurant"),
             ("lettre de motivation", "sérieux et motivé"), ("fiche produit", "précis et vendeur"),
             ("note de synthèse", "neutre et structuré"), ("scénario pédagogique", "ludique et clair")]
GENRES_EN = [("blog post", "informal yet documented"), ("professional email", "concise and courteous"),
             ("short story", "evocative and rhythmic"), ("service announcement", "clear and reassuring"),
             ("cover letter", "serious and motivated"), ("product sheet", "precise and selling"),
             ("summary note", "neutral and structured"), ("teaching script", "playful and clear")]

def fab_generation_texte(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    genre_fr, ton = rng.choice(GENRES_FR) if fr else rng.choice(GENRES_EN)
    sujet = rng.choice(SUJETS_FR) if fr else rng.choice(TOPICS_EN)
    public = rng.choice(["débutants", "professionnels", "étudiants", "familles", "dirigeants"]) if fr else \
             rng.choice(["beginners", "professionals", "students", "families", "executives"])
    n_points = rng.randint(3, 5)
    ville = rng.choice(VILLES_FR) if fr else rng.choice(CITIES_EN)
    if fr:
        plan = "\n".join(f"{i+1}. {['Constat de départ', 'Exemple concret à ' + ville, 'Bénéfices clés', 'Limites à connaître', 'Premier pas actionable'][i]}"
                         for i in range(min(n_points, 5)))
        sortie = (f"Plan ({n_points} points) :\n{plan}\n\n"
                  f"Amorce : « {sujet.capitalize()} change concrètement la vie de nombreuses personnes à {ville}. "
                  f"Pour {public}, comprendre les bases suffit déjà pour faire de meilleurs choix. »")
    else:
        plan = "\n".join(f"{i+1}. {['Opening fact', 'Concrete example', 'Key benefits', 'Limits to know', 'Actionable first step'][i]}"
                         for i in range(min(n_points, 5)))
        sortie = (f"Outline ({n_points} points):\n{plan}\n\n"
                  f"Opening: \"{sujet.capitalize()} is concretely changing many people's lives. "
                  f"For {public}, understanding the basics is already enough to make better choices.\"")
    return {
        "task_type": "text_generation",
        "language": "fr" if fr else "en",
        "instruction": (f"Rédige un {genre_fr} sur {sujet} pour {public} — ton {ton}. "
                        f"Donne d'abord un plan de {n_points} points, puis une amorce de 2 phrases.") if fr else
                       (f"Write a {genre_fr} about {sujet} for {public} — {ton} tone. "
                        f"First give a {n_points}-point outline, then a 2-sentence opening."),
        "input": f"sujet: {sujet} | public: {public} | ton: {ton} | points: {n_points}",
        "output": sortie,
        "difficulty": "intermédiaire",
    }

def fab_reecriture_style(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom = rng.choice(NOMS_FR) if fr else rng.choice(NAMES_EN)
    objet = rng.choice(OBJETS_FR) if fr else rng.choice(OBJECTS_EN)
    montant = rng.choice(MONTANTS)
    if fr:
        source = f"Bonjour, je veux savoir où est mon {objet}, commandé il y a 10 jours, j'ai payé {montant} francs et ça commence à faire long. Merci de répondre vite."
        cible = (f"Objet : Suivi de commande — livraison en attente\n\n"
                 f"Bonjour,\n\nJ'ai commandé un {objet} il y a dix jours (paiement : {montant} francs) et je n'ai "
                 f"pas encore de suivi de livraison. Pourriez-vous m'indiquer le statut et le délai prévu ?\n\n"
                 f"Cordialement,\n{nom}")
        styles = ["formelle", "plus courte", "plus empathique"]
    else:
        source = f"Hi, I want to know where my {objet} is, ordered 10 days ago, I paid {montant} francs and it's getting long. Please answer fast."
        cible = (f"Subject: Order follow-up — delivery pending\n\n"
                 f"Hello,\n\nI ordered a {objet} ten days ago (payment: {montant} francs) and I still have "
                 f"no shipping update. Could you tell me the status and the expected delivery time?\n\n"
                 f"Best regards,\n{nom}")
        styles = ["formal", "shorter", "more empathetic"]
    return {
        "task_type": "rewrite_style",
        "language": "fr" if fr else "en",
        "instruction": (f"Réécris ce message en version {rng.choice(styles)}, sans perdre l'information clé "
                        f"(objet, délai, montant).") if fr else
                       (f"Rewrite this message in a {rng.choice(styles)} version, keeping the key facts "
                        f"(item, delay, amount)."),
        "input": source,
        "output": cible,
        "difficulty": "facile",
    }

# ═══════════════════ contextual_understanding (25 000) ═══════════════════

def fab_reference_dialogue(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    n1 = rng.choice(NOMS_FR) if fr else rng.choice(NAMES_EN)
    n2 = rng.choice([x for x in (NOMS_FR if fr else NAMES_EN) if x != n1])
    objet = rng.choice(OBJETS_FR) if fr else rng.choice(OBJECTS_EN)
    produit = rng.choice(PRODUITS_FR) if fr else rng.choice(PRODUITS_EN)
    montant = rng.choice(MONTANTS)
    if fr:
        dial = (f"Utilisateur : {n1} a réservé le {produit} pour {montant} francs.\n"
                f"Assistant : Noté — la réservation de {n1} est enregistrée.\n"
                f"Utilisateur : Peux-tu l'annuler ? Il ne veut plus le prendre.")
        question = "À qui ou à quoi renvoie « l' » dans la dernière demande ?"
        reponse = f"« l' » renvoie au {produit} réservé par {n1} pour {montant} francs — il faut annuler cette réservation précise."
    else:
        dial = (f"User: {n1} booked the {produit} for {montant} francs.\n"
                f"Assistant: Noted — {n1}'s booking is saved.\n"
                f"User: Can you cancel it? He no longer wants it.")
        question = "What does \"it\" refer to in the last request?"
        reponse = f"\"it\" refers to the {produit} booked by {n1} for {montant} francs — that exact booking must be cancelled."
    return {
        "task_type": "reference_resolution",
        "language": "fr" if fr else "en",
        "instruction": "Résous la référence en t'appuyant sur le contexte, cite l'antécédent exact." if fr
                       else "Resolve the reference from context, quote the exact antecedent.",
        "input": f"{dial}\n\nQuestion : {question}" if fr else f"{dial}\n\nQuestion: {question}",
        "output": reponse,
        "difficulty": "intermédiaire",
    }

def fab_implicite(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    nom = rng.choice(NOMS_FR) if fr else rng.choice(NAMES_EN)
    lieu = rng.choice(LIEUX_FR) if fr else rng.choice(PLACES_EN)
    objet = rng.choice(OBJETS_FR) if fr else rng.choice(OBJECTS_EN)
    jour = rng.choice(JOURS_FR) if fr else rng.choice(DAYS_EN)
    if fr:
        texte = (f"{nom} : « Si je passe à {lieu} ce {jour} après 18 h, tu penses que je peux "
                 f"encore récupérer mon {objet} ? Le comptoir ferme normalement plus tôt le week-end. »")
        reponse = (f"Question implicite : {nom} demande si le comptoir de {lieu} est ouvert après 18 h "
                   f"ce {jour}-là. À répondre : les horaires exacts du comptoir (fermeture anticipée le "
                   f"week-end) et une alternative si c'est fermé (retrait le lendemain ou consigne).")
    else:
        texte = (f"{nom}: \"If I stop by {lieu} this {jour} after 6 pm, do you think I can still "
                 f"pick up my {objet}? The counter usually closes earlier on weekends.\"")
        reponse = (f"Implicit question: {nom} is asking whether the {lieu} counter is open after 6 pm "
                   f"that {jour}. To answer: the counter's exact hours (earlier weekend closing) and a "
                   f"fallback if closed (next-day pickup or hold service).")
    return {
        "task_type": "implicit_question",
        "language": "fr" if fr else "en",
        "instruction": "Formule la question implicite et liste ce qu'il faut vérifier pour répondre." if fr
                       else "State the implicit question and list what must be checked to answer.",
        "input": texte,
        "output": reponse,
        "difficulty": "avancé",
    }

# ═══════════════════ conversational_memory (20 000) ═══════════════════

def fab_memoire_faits(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    noms = rng.sample(NOMS_FR if fr else NAMES_EN, k=rng.randint(2, 4))
    villes = rng.sample(VILLES_FR if fr else CITIES_EN, k=rng.randint(2, 4))
    faits = []
    for i, nom in enumerate(noms):
        v = villes[i % len(villes)]
        m = rng.choice(MONTANTS)
        faits.append((nom, v, m))
    if fr:
        echanges = "\n".join(f"Tour {i+1} — Utilisateur : « {n} a déménagé à {v} et y dépense environ {m} francs par mois. »"
                             for i, (n, v, m) in enumerate(faits))
        cible = rng.choice(noms)
        fait = next(f for f in faits if f[0] == cible)
        question = f"Question finale : où {cible} a-t-il/elle déménagé et quel est son budget mensuel indiqué ?"
        reponse = f"{cible} a déménagé à {fait[1]} ; budget mensuel indiqué : {fait[2]} francs."
    else:
        echanges = "\n".join(f"Turn {i+1} — User: \"{n} moved to {v} and spends about {m} francs a month there.\""
                             for i, (n, v, m) in enumerate(faits))
        cible = rng.choice(noms)
        fait = next(f for f in faits if f[0] == cible)
        question = f"Final question: where did {cible} move, and what monthly budget was mentioned?"
        reponse = f"{cible} moved to {fait[1]}; mentioned monthly budget: {fait[2]} francs."
    return {
        "task_type": "memory_recall",
        "language": "fr" if fr else "en",
        "instruction": "Mémorise les faits donnés tour par tour, puis réponds exactement à la question finale." if fr
                       else "Memorize the facts turn by turn, then answer the final question exactly.",
        "input": f"{echanges}\n{question}" if fr else f"{echanges}\n{question}",
        "output": reponse,
        "difficulty": "intermédiaire",
    }

def fab_memoire_combinaison(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    noms = rng.sample(NOMS_FR if fr else NAMES_EN, k=3)
    objets = rng.sample(OBJETS_FR if fr else OBJECTS_EN, k=3)
    if fr:
        echanges = (f"Tour 1 — « {noms[0]} préfère les couleurs froides et déteste le {objets[0]}. »\n"
                    f"Tour 2 — « {noms[1]} collectionne les {objets[1]}s anciens. »\n"
                    f"Tour 3 — « {noms[2]} offre toujours un {objets[2]} à ses équipes. »")
        question = "Quelle idée de cadeau éviter pour " + noms[0] + " ?"
        reponse = f"Éviter le {objets[0]} : {noms[0]} le déteste ; préférer une couleur froide comme indice de goût."
    else:
        echanges = (f"Turn 1 — \"{noms[0]} prefers cool colors and hates the {objets[0]}.\"\n"
                    f"Turn 2 — \"{noms[1]} collects old {objets[1]}s.\"\n"
                    f"Turn 3 — \"{noms[2]} always gifts a {objets[2]} to their teams.\"")
        question = "Which gift idea should be avoided for " + noms[0] + "?"
        reponse = f"Avoid the {objets[0]}: {noms[0]} hates it; cool colors are the stated taste cue."
    return {
        "task_type": "memory_combine",
        "language": "fr" if fr else "en",
        "instruction": "Combine plusieurs faits des tours précédents pour répondre, sans rien inventer." if fr
                       else "Combine several facts from previous turns to answer, inventing nothing.",
        "input": f"{echanges}\n{question}" if fr else f"{echanges}\n{question}",
        "output": reponse,
        "difficulty": "avancé",
    }

# ═══════════════════ intent_recognition (20 000) ═══════════════════

INTENTS_FR = [
    ("reserver", "réservation", "réserver|book", "appeler l'outil de réservation avec date et créneau"),
    ("annuler", "annulation", "annuler|cancel", "vérifier l'identifiant puis annuler avec confirmation"),
    ("suivi_commande", "suivi de commande", "où est ma commande|order status", "demander le numéro de commande puis interroger le suivi"),
    ("remboursement", "remboursement", "rembours|refund", "vérifier l'éligibilité puis lancer le remboursement"),
    ("rendez_vous", "prise de rendez-vous", "rendez-vous|appointment", "proposer deux créneaux et confirmer"),
    ("question_facture", "question de facturation", "facture|invoice", "récupérer la facture et expliquer les lignes"),
    ("reclamation", "réclamation", "inacceptable|complaint", "s'excuser, collecter les faits, escalader si besoin"),
    ("mot_de_passe", "réinitialisation", "mot de passe|password", "envoyer le lien de réinitialisation sécurisé"),
    ("adresse_livraison", "changement d'adresse", "nouvelle adresse|change address", "vérifier l'identité puis mettre à jour"),
    ("conseil_produit", "conseil produit", "quel.*choisir|which one", "poser 2 questions d'usage puis recommander"),
    ("devis", "demande de devis", "combien pour|quote", "collecter volume et délai puis chiffrer"),
    ("horaires", "horaires d'ouverture", "ouvert|opening hours", "donner les horaires du point demandé"),
    ("itineraire", "itinéraire", "comment aller|directions", "proposer l'itinéraire avec durée estimée"),
    ("traduction", "traduction", "traduis|translate", "identifier la paire de langues puis traduire"),
    ("resume", "résumé", "résume|summarize", "demander la pièce puis résumer en 5 points"),
    ("appel_humain", "parler à un humain", "un conseiller|human agent", "proposer un rappel et donner le délai"),
    ("données_personnelles", "données personnelles", "mes données|my data", "expliquer les droits et le lien d'export"),
    ("paiement_echoue", "paiement refusé", "paiement refus|payment failed", "vérifier le moyen de paiement et proposer une alternative"),
    ("retour_produit", "retour produit", "renvoyer|return", "vérifier le délai de retour puis générer l'étiquette"),
    ("disponibilite", "disponibilité", "en stock|in stock", "vérifier le stock du magasin le plus proche"),
]
INTENTS_EN = [
    ("book", "booking", "book|reserve", "call the booking tool with date and slot"),
    ("cancel", "cancellation", "cancel", "check the reference then cancel with confirmation"),
    ("order_status", "order tracking", "where is my order|order status", "ask for the order number then query tracking"),
    ("refund", "refund", "refund", "check eligibility then trigger the refund"),
    ("appointment", "appointment", "appointment", "offer two slots then confirm"),
    ("billing", "billing question", "invoice|charged", "fetch the invoice and explain the lines"),
    ("complaint", "complaint", "unacceptable|complaint", "apologize, collect facts, escalate if needed"),
    ("password", "password reset", "password", "send the secure reset link"),
    ("address_change", "address change", "new address", "verify identity then update"),
    ("product_advice", "product advice", "which one should", "ask 2 usage questions then recommend"),
    ("quote", "quote request", "how much for|quote", "collect volume and deadline then price it"),
    ("hours", "opening hours", "open|hours", "give the requested location's hours"),
    ("directions", "directions", "how do i get|directions", "provide the route with estimated time"),
    ("translate", "translation", "translate", "identify the language pair then translate"),
    ("summarize", "summarization", "summarize", "ask for the document then summarize in 5 points"),
    ("human_agent", "human agent", "a real person|human agent", "offer a callback and give the delay"),
    ("personal_data", "personal data", "my data", "explain rights and the export link"),
    ("payment_failed", "payment failed", "payment failed|declined", "check the payment method and offer an alternative"),
    ("product_return", "product return", "send it back|return", "check the return window then generate the label"),
    ("stock", "availability", "in stock", "check stock at the nearest store"),
]

def fab_intention(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    cle, label, motif, action = rng.choice(INTENTS_FR if fr else INTENTS_EN)
    nom = rng.choice(NOMS_FR) if fr else rng.choice(NAMES_EN)
    produit = rng.choice(PRODUITS_FR) if fr else rng.choice(PRODUITS_EN)
    montant = rng.choice(MONTANTS)
    ville = rng.choice(VILLES_FR) if fr else rng.choice(CITIES_EN)
    gabarits_fr = [
        f"Bonjour, je voudrais {label} pour le {produit} de {nom}, s'il vous plaît.",
        f"C'est encore au sujet du {produit} — je demande un {label} (montant : {montant} francs).",
        f"Bonjour, {nom} ici. Pouvez-vous m'aider pour un {label} à {ville} ?",
        f"Le {produit} que j'ai payé {montant} francs me pose problème : je souhaite un {label}.",
    ]
    gabarits_en = [
        f"Hi, I would like to {label} for the {produit} of {nom}, please.",
        f"It's about the {produit} again — I'm requesting a {label} (amount: {montant} francs).",
        f"Hello, {nom} here. Can you help me with a {label} in {ville}?",
        f"The {produit} I paid {montant} francs for is an issue: I want a {label}.",
    ]
    utterance = rng.choice(gabarits_fr if fr else gabarits_en)
    if fr:
        sortie = (f"Intention : {cle} ({label})\nAction : {action}\n"
                  f"Entités détectées : produit={produit}, montant={montant} francs, client={nom}, lieu={ville}\n"
                  f"Confiance : {round(rng.uniform(0.82, 0.97), 2)}")
    else:
        sortie = (f"Intent: {cle} ({label})\nAction: {action}\n"
                  f"Entities: product={produit}, amount={montant} francs, customer={nom}, location={ville}\n"
                  f"Confidence: {round(rng.uniform(0.82, 0.97), 2)}")
    return {
        "task_type": "intent_classification",
        "language": "fr" if fr else "en",
        "instruction": "Classifie l'intention de l'utilisateur, propose l'action suivante et liste les entités." if fr
                       else "Classify the user's intent, propose the next action and list entities.",
        "input": utterance,
        "output": sortie,
        "difficulty": "facile",
    }

FABRIQUES_NLP = [fab_comprehension, fab_idee_principale, fab_ordre_evenements]
FABRIQUES_GEN = [fab_generation_texte, fab_reecriture_style]
FABRIQUES_CTX = [fab_reference_dialogue, fab_implicite]
FABRIQUES_MEM = [fab_memoire_faits, fab_memoire_combinaison]
FABRIQUES_INT = [fab_intention]
