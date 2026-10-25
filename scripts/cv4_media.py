#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum v4 — Phases 6-10 : vision, audio, vidéo, orchestration multimodale (215 000).

  image_analysis    35 000 — lecture de scènes, OCR, graphiques, relations spatiales
  image_generation  40 000 — prompts photoréalistes, retouche, styles
  voice_speech      30 000 — briefs TTS avec prosodie, design de voix de marque
  audio_understanding 20 000 — transcription, classification de sons, émotions vocales
  music_v4          15 000 — briefs de composition et plans de production
  video_v4          45 000 — storyboards keyframes, transitions, sous-titres
  multimodal_v4     30 000 — orchestration de pipelines média avec replis honnêtes
"""

from __future__ import annotations

import random

from cv4_pools import (CITIES_EN, LIEUX_FR, MONTANTS, MOIS_FR, MONTHS_EN, NOMS_FR, NAMES_EN,
                       OBJETS_FR, OBJECTS_EN, PLACES_EN, PRODUITS_EN, PRODUITS_FR,
                       SUJETS_FR, TOPICS_EN, VILLES_FR)

# ═══════════════════ image_analysis (35 000) ═══════════════════

SCENES_FR = [("un marché de quartier", "des étals colorés, des acheteurs en mouvement, une lumière dorée de fin d'après-midi"),
             ("une classe rurale", "des tables en bois, un tableau noir, des cahiers ouverts, lumière latérale par la fenêtre"),
             ("un atelier de couture", "une machine à coudre, des coupons de tissu, un mètre-ruban, lumière de bureau"),
             ("un chantier de toiture", "des échafaudages, des tôles empilées, deux ouvriers casqués, ciel voilé"),
             ("une terrasse de café", "des tables rondes, des parasols, une carafe d'eau, ombres nettes de midi"),
             ("un péage routier", "des files de véhicules, une barrière levée, des panneaux, lumière grise du matin")]
SCENES_EN = [("a neighborhood market", "colorful stalls, moving shoppers, golden late-afternoon light"),
             ("a rural classroom", "wooden desks, a blackboard, open notebooks, side light from the window"),
             ("a sewing workshop", "a sewing machine, fabric rolls, a measuring tape, office lighting"),
             ("a roofing site", "scaffolding, stacked metal sheets, two helmeted workers, overcast sky"),
             ("a café terrace", "round tables, parasols, a water jug, sharp noon shadows"),
             ("a highway toll", "vehicle queues, a raised barrier, road signs, gray morning light")]

def fab_description_scene(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    scene, details = rng.choice(SCENES_FR if fr else SCENES_EN)
    ville = rng.choice(VILLES_FR if fr else CITIES_EN)
    n = rng.randint(2, 9)
    if fr:
        inp = f"Spécification de scène : {scene} à {ville}. Éléments : {details}. Personnes visibles : {n}."
        out = (f"Description attendue : une {scene} à {ville}, où l'on distingue {details}. "
               f"Environ {n} personnes sont visibles, placées dans le tiers inférieur du cadre. "
               f"Je décris uniquement les éléments listés — rien d'autre n'est affirmé.")
    else:
        inp = f"Scene spec: {scene} in {ville}. Elements: {details}. Visible people: {n}."
        out = (f"Expected description: {scene} in {ville}, showing {details}. "
               f"About {n} people are visible, placed in the lower third of the frame. "
               f"I describe only the listed elements — nothing else is claimed.")
    return {
        "task_type": "scene_description",
        "language": "fr" if fr else "en",
        "instruction": "Décris la scène à partir de la spécification, sans inventer d'éléments absents." if fr
                       else "Describe the scene from the spec, without inventing absent elements.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_ocr(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    marque = rng.choice(ENTREPRISES_FR) if fr else rng.choice(["Zanbara Tech", "Kanouma", "Sahel Express"])
    ref = f"{rng.choice(['CMD', 'ORD'])}-{rng.randint(100000, 999999)}"
    total = rng.choice(MONTANTS)
    if fr:
        bloc = f"{marque}\nFacture N° {ref}\nTOTAL : {total} FCFA\nMerci de votre visite"
        out = (f"Transcription OCR : marque={marque}, référence={ref}, total={total} FCFA.\n"
               f"Langue : français. Champ ambigu : aucun. Les totaux sont repris tels qu'imprimés.")
    else:
        bloc = f"{marque}\nInvoice N° {ref}\nTOTAL: {total} FCFA\nThank you for your visit"
        out = (f"OCR transcription: brand={marque}, reference={ref}, total={total} FCFA.\n"
               f"Language: English. Ambiguous field: none. Totals copied as printed.")
    return {
        "task_type": "ocr_transcription",
        "language": "fr" if fr else "en",
        "instruction": "Transcris fidèlement le texte du document, champ par champ, avec la langue détectée." if fr
                       else "Faithfully transcribe the document text, field by field, with the detected language.",
        "input": bloc,
        "output": out,
        "difficulty": "facile",
    }

def fab_graphique(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    m = MOIS_FR if fr else MONTHS_EN
    i = rng.randint(0, 7)
    v1 = rng.choice([120, 150, 180, 200, 240, 300])
    v2 = v1 + rng.choice([-60, -40, -20, 20, 40, 60, 90])
    v3 = v2 + rng.choice([-30, -10, 15, 30, 50, 80])
    serie = [v1, v2, v3]
    delta = round((v3 - v1) / v1 * 100, 1)
    if fr:
        inp = (f"Série mensuelle « ventes » : {m[i]}={v1}, {m[i+1]}={v2}, {m[i+2]}={v3} (unités).\n"
               f"Question : tendance et variation globale en % ?")
        sens = "hausse" if v3 > v1 else ("baisse" if v3 < v1 else "stabilité")
        out = f"Tendance : {sens} sur la période {m[i]}–{m[i+2]}. Variation : {delta:+.1f} % ({v1} → {v3} unités)."
    else:
        inp = (f"Monthly series \"sales\": {m[i]}={v1}, {m[i+1]}={v2}, {m[i+2]}={v3} (units).\n"
               f"Question: trend and overall change in %?")
        sens = "up" if v3 > v1 else ("down" if v3 < v1 else "flat")
        out = f"Trend: {sens} over {m[i]}–{m[i+2]}. Change: {delta:+.1f}% ({v1} → {v3} units)."
    return {
        "task_type": "chart_reading",
        "language": "fr" if fr else "en",
        "instruction": "Lis la série, nomme la tendance et calcule la variation en pourcentage." if fr
                       else "Read the series, name the trend and compute the percentage change.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

ENTREPRISES_FR = ["Zanbara Tech", "Kanouma Distribution", "Baobab Finance", "Kora Retail"]

def fab_comptage_spatial(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    objet = rng.choice(OBJETS_FR if fr else OBJECTS_EN)
    gauche, droite = rng.randint(1, 6), rng.randint(1, 6)
    if fr:
        inp = f"Spécification : {gauche} {objet}s à gauche du cadre, {droite} à droite."
        total = gauche + droite
        cote_max = "gauche" if gauche > droite else ("droite" if droite > gauche else "égalité")
        out = (f"Total : {total} {objet}s. Côté le plus fourni : {cote_max}"
               + (f" ({gauche} contre {droite})." if cote_max != "égalité" else f" ({gauche} de chaque côté)."))
    else:
        inp = f"Spec: {gauche} {objet}s on the left of the frame, {droite} on the right."
        total = gauche + droite
        side = "left" if gauche > droite else ("right" if droite > gauche else "tie")
        out = (f"Total: {total} {objet}s. Busier side: {side}"
               + (f" ({gauche} vs {droite})." if side != "tie" else f" ({gauche} each side)."))
    return {
        "task_type": "counting_spatial",
        "language": "fr" if fr else "en",
        "instruction": "Compte par zone et compare — ne compte que ce qui est spécifié." if fr
                       else "Count per zone and compare — only what is specified.",
        "input": inp,
        "output": out,
        "difficulty": "facile",
    }

# ═══════════════════ image_generation (40 000) ═══════════════════

SUJETS_PHOTO_FR = ["une vendeuse de fruits souriante", "un artisan menuisier au travail",
                   "une enfant lisant sous un manguier", "un pêcheur réparant son filet",
                   "une couturière mesurant un tissu", "un cycliste transportant des paniers",
                   "une cérémonie de mariage traditionnelle", "un joueur de kora en concert",
                   "une marchande étalant ses épices", "un jeune développeur en coworking"]
SUJETS_PHOTO_EN = ["a smiling fruit vendor", "a carpenter at work",
                   "a child reading under a mango tree", "a fisherman mending his net",
                   "a seamstress measuring fabric", "a cyclist carrying baskets",
                   "a traditional wedding ceremony", "a kora player in concert",
                   "a market woman displaying spices", "a young developer in a coworking space"]
LUMIERES_FR = ["golden hour latérale", "lumière douce de fenêtre", "contre-jour à l'aube",
               "lumière nuageuse uniforme", "tungstène chaleureux d'intérieur", "néon urbain nocturne"]
LIGHTS_EN = ["lateral golden hour", "soft window light", "dawn backlight",
             "even overcast light", "warm indoor tungsten", "urban neon night light"]
OPTIQUES = [("50 mm f/1.8", "portrait naturel, arrière-plan fondu"),
            ("35 mm f/2", "contexte visible, perspective honnête"),
            ("85 mm f/1.4", "portrait serré, bokeh prononcé"),
            ("24 mm f/4", "plan d'ensemble, peu de distorsion"),
            ("105 mm macro", "textures rapprochées")]
CADRAGES = [("règle des tiers", "rule of thirds"), ("centré symétrique", "centered symmetry"),
            ("plan large environnemental", "wide environmental shot"), ("gros plan sur les mains", "close-up on hands"),
            ("contre-plongée légère", "slight low angle")]
FILMS = [("grain argentique fin ISO 200", "fine film grain ISO 200"),
         ("rendu numérique propre ISO 100", "clean digital ISO 100"),
         ("grain documentaire ISO 800", "documentary grain ISO 800"),
         ("pellicule diapositive saturée", "saturated slide film"),
         ("noir et blanc contrasté", "contrasty black and white")]
AMBIANCES = [("marché animé", "busy market"), ("calme matinal", "quiet morning"),
             ("fin de journée chaleureuse", "warm late afternoon"), ("saison des pluies fraîche", "fresh rainy season"),
             ("fête locale vibrante", "vibrant local festival"), ("atelier concentré", "focused workshop"),
             ("bureau moderne lumineux", "bright modern office"), ("paysage ouvert", "open landscape")]

def fab_prompt_photoreal(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet = rng.choice(SUJETS_PHOTO_FR if fr else SUJETS_PHOTO_EN)
    lieu = rng.choice(LIEUX_FR if fr else PLACES_EN)
    lum = rng.choice(LUMIERES_FR if fr else LIGHTS_EN)
    optique, effet = rng.choice(OPTIQUES)
    cadr_fr, cadr_en = rng.choice(CADRAGES)
    film_fr, film_en = rng.choice(FILMS)
    amb_fr, amb_en = rng.choice(AMBIANCES)
    if fr:
        inp = (f"Brief : photo photoréaliste de {sujet}, à {lieu}, ambiance {amb_fr}, "
               f"lumière {lum}, {optique}, cadrage : {cadr_fr}, rendu : {film_fr}.")
        out = (f"Prompt photoréaliste : « {sujet}, {lieu}, ambiance {amb_fr}, {lum}, objectif {optique} ({effet}), "
               f"{cadr_fr}, {film_fr}, tons de peau naturels — pas d'aspect CG, pas de texte incrusté, "
               f"pas de mains déformées, pas de filigrane. »\n"
               f"Paramètres : 26 pas, CFG 4,5, 768 px — rendu SD 2.1 côté navigateur.")
    else:
        inp = (f"Brief: photorealistic photo of {sujet}, at {lieu}, {amb_en} mood, "
               f"{lum} light, {optique}, framing: {cadr_en}, render: {film_en}.")
        out = (f"Photoreal prompt: \"{sujet}, {lieu}, {amb_en} mood, {lum}, {optique} lens ({effet}), "
               f"{cadr_en}, {film_en}, natural skin tones — no CG look, no embedded text, "
               f"no deformed hands, no watermark.\"\n"
               f"Parameters: 26 steps, CFG 4.5, 768 px — SD 2.1 in-browser rendering.")
    return {
        "task_type": "prompt_to_photoreal_brief",
        "language": "fr" if fr else "en",
        "instruction": "Construis le prompt photoréaliste complet (sujet, lieu, ambiance, lumière, optique, cadrage, film, négatifs)." if fr
                       else "Build the full photoreal prompt (subject, place, mood, light, lens, framing, film, negatives).",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_retouche(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    action_fr, action_en = rng.choice([
        ("supprimer l'arrière-plan et livrer un PNG transparent", "remove the background and deliver a transparent PNG"),
        ("coloriser une photo noir et blanc en conservant les tons de peau", "colorize a black-and-white photo keeping skin tones"),
        ("augmenter la netteté sans halo visible", "sharpen without visible halos"),
        ("redresser l'horizon et recadrer en 4:5", "straighten the horizon and crop to 4:5"),
        ("réduire le bruit des ombres sans plastifier la peau", "reduce shadow noise without plastic skin"),
        ("corriger la balance des blancs sous tungstène", "fix the white balance under tungsten light"),
        ("agrandir 2× sans perte visible", "upscale 2× without visible loss"),
        ("retirer un objet parasite en arrière-plan", "remove a stray object in the background")])
    type_photo = rng.choice(["portrait", "paysage", "photo produit", "photo événement",
                             "portrait", "landscape", "product photo", "event photo"])
    format_sortie = rng.choice(["JPEG qualité 90", "PNG 8 bits", "WebP qualité 85",
                                "JPEG quality 90", "PNG 8-bit", "WebP quality 85"])
    if fr:
        inp = f"Demande client : {action_fr} sur une {type_photo}. Livraison : {format_sortie}."
        out = (f"Plan de retouche : 1) préserver l'original (export non destructif) ; 2) {action_fr} ; "
               f"3) contrôle côte à côte avant/après ; 4) livraison {format_sortie}.\n"
               f"Limite honnête : si l'opération dépasse le moteur WebGPU local (colorisation complexe, "
               f"upscale > 2×), le dire clairement et proposer la voie serveur ou manuelle — pas de faux succès.")
    else:
        inp = f"Client request: {action_en} on a {type_photo}. Delivery: {format_sortie}."
        out = (f"Editing plan: 1) keep the original (non-destructive export); 2) {action_en} ; "
               f"3) side-by-side before/after check; 4) deliver as {format_sortie}.\n"
               f"Honest limit: if the operation exceeds the local WebGPU engine (complex colorization, "
               f"> 2× upscale), say so clearly and offer the server or manual route — no fake success.")
    return {
        "task_type": "image_editing_plan",
        "language": "fr" if fr else "en",
        "instruction": "Plan de retouche non destructif avec limites du moteur local." if fr
                       else "Non-destructive editing plan with local engine limits.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

# ═══════════════════ voice_speech (30 000) ═══════════════════

EMOTIONS_FR = ["chaleureux et rassurant", "neutre et professionnel", "énergique et motivant",
               "calme et posé", "solennel et respectueux"]
EMOTIONS_EN = ["warm and reassuring", "neutral and professional", "energetic and motivating",
               "calm and composed", "solemn and respectful"]

def fab_brief_tts(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    produit = rng.choice(PRODUITS_FR if fr else PRODUITS_EN)
    emo = rng.choice(EMOTIONS_FR if fr else EMOTIONS_EN)
    debit = rng.choice([0.8, 0.85, 0.9, 0.95, 1.0, 1.05])
    n_phrases = rng.randint(2, 4)
    entreprise = rng.choice(ENTREPRISES_FR if fr else ["Zanbara Tech", "Kora Retail", "Baobab Finance", "Sahel Express"])
    pause = rng.choice(["courtes", "standard", "marquées"])
    if fr:
        phrases = " ".join(rng.sample([
            f"Bonjour, bienvenue chez {entreprise}.",
            f"Votre {produit} est prêt : vous pouvez le récupérer dès aujourd'hui.",
            "Une question ? Nous restons disponibles.",
            "Merci de votre confiance.",
            f"Nos conseillers vous répondent sous 24 heures."], k=n_phrases))
        out = (f"Brief TTS : ton {emo}, débit ×{debit}, pauses {pause} aux virgules et entre phrases.\n"
               f"Texte ({n_phrases} phrases) : « {phrases} »\n"
               f"Voix : ff_siwis (français). Limite honnête : 2 000 caractères par segment ; "
               f"au-delà, découper en segments et concaténer.")
    else:
        phrases = " ".join(rng.sample([
            f"Hello, welcome to {entreprise}.",
            f"Your {produit} is ready: you can pick it up today.",
            "Any question? We remain available.",
            "Thank you for your trust.",
            "Our advisors answer within 24 hours."], k=n_phrases))
        out = (f"TTS brief: {emo} tone, ×{debit} rate, {pause} pauses at commas and between sentences.\n"
               f"Text ({n_phrases} sentences): \"{phrases}\"\n"
               f"Voice: ff_siwis (French) or default English tier. Honest limit: 2,000 characters per segment; "
               f"beyond that, split into segments and concatenate.")
    return {
        "task_type": "tts_brief",
        "language": "fr" if fr else "en",
        "instruction": "Prépare le brief de synthèse vocale : texte segmenté, ton, débit, pauses." if fr
                       else "Prepare the TTS brief: segmented text, tone, rate, pauses.",
        "input": f"Message à synthétiser sur le {produit}, ton {emo}, {n_phrases} phrases." if fr else f"Message to synthesize about the {produit}, {emo} tone, {n_phrases} sentences.",
        "output": out,
        "difficulty": "facile",
    }

def fab_voix_marque(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    entreprise = rng.choice(ENTREPRISES_FR if fr else ["Zanbara Tech", "Kora Retail", "Baobab Finance"])
    if fr:
        inp = f"Design de voix de marque pour {entreprise} : assistante vocale grand public."
        out = (f"Spécification : registre médium, débit 0,9×, timbre chaleureux sans sur-jeu, "
               f"salutation fixe (« Bienvenue chez {entreprise} »), refus polis des demandes hors périmètre, "
               f"pas d'imitation de personnes réelles sans consentement écrit (éthique voix).")
    else:
        inp = f"Brand voice design for {entreprise}: consumer voice assistant."
        out = (f"Specification: medium register, 0.9× rate, warm timbre without overacting, "
               f"fixed greeting (\"Welcome to {entreprise}\"), polite refusals for out-of-scope requests, "
               f"no imitation of real people without written consent (voice ethics).")
    return {
        "task_type": "brand_voice_design",
        "language": "fr" if fr else "en",
        "instruction": "Spécifie la voix (registre, débit, timbre) et les garde-fous éthiques." if fr
                       else "Specify the voice (register, rate, timbre) and ethical guardrails.",
        "input": inp,
        "output": out,
        "difficulty": "avancé",
    }

# ═══════════════════ audio_understanding (20 000) ═══════════════════

SONS_FR = [("un marché", "brouhaha, appels de vendeurs, roulements de caisses, cloches de vélos"),
           ("une gare routière", "annonces sonores, talons sur le béton, freins de bus, klaxons lointains"),
           ("une école", "cloche, chœurs d'enfants, chaises déplacées, craie sur tableau"),
           ("un chantier", "marteau-piqueur par intermittence, chariot, alertes de recul, vent dans les échafaudages"),
           ("une rizière", "grenouilles, vent dans les tiges, oiseaux, eau qui ruisselle"),
           ("un port de pêche", "moteurs de barques, mouettes, câbles sur les pontons, vagues")]
SONS_EN = [("a market", "crowd murmur, vendor calls, crate rolling, bicycle bells"),
           ("a bus terminal", "audio announcements, heels on concrete, bus brakes, distant horns"),
           ("a school", "bell, children's chatter, chairs moving, chalk on board"),
           ("a construction site", "intermittent jackhammer, cart, backup alarms, wind in scaffolding"),
           ("a rice paddy", "frogs, wind in stalks, birds, flowing water"),
           ("a fishing port", "boat engines, seagulls, cables on the docks, waves")]
HEURES = [("du matin", "morning"), ("de midi", "midday"), ("du soir", "evening"), ("de nuit", "at night")]

def fab_classification_son(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    lieu, indices = rng.choice(SONS_FR if fr else SONS_EN)
    liste = [i.strip() for i in indices.split(",")]
    retenus = rng.sample(liste, k=rng.randint(2, len(liste)))
    heure_fr, heure_en = rng.choice(HEURES)
    conf = rng.choice(["modérée", "élevée", "prudente", "moderate", "high", "cautious"])
    if fr:
        inp = f"Indices audio ({heure_fr}) : {', '.join(retenus)}. Où sommes-nous probablement ?"
        out = (f"Milieu probable : {lieu}. Indices concordants : {', '.join(retenus)} ; "
               f"cohérents avec l'heure ({heure_fr}). Confiance {conf} — exprimée qualitativement, jamais surestimée.")
    else:
        inp = f"Audio cues ({heure_en}): {', '.join(retenus)}. Where are we most likely?"
        out = (f"Likely setting: {lieu}. Matching cues: {', '.join(retenus)} ; "
               f"consistent with the time ({heure_en}). {conf.capitalize()} confidence — qualitative, never overstated.")
    return {
        "task_type": "sound_classification",
        "language": "fr" if fr else "en",
        "instruction": "Classe l'environnement sonore à partir des indices, avec un niveau de confiance honnête." if fr
                       else "Classify the sound environment from cues, with honest confidence.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_transcription_plan(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    duree = rng.choice([15, 30, 45, 60, 90, 120, 180, 240])
    langue = rng.choice(["français", "anglais", "français (accent régional)", "English", "French (regional accent)"])
    bruit = rng.choice(["faible", "modéré", "fort par moments", "low", "moderate", "strong at times"])
    locuteurs = rng.choice([1, 2, 3])
    if fr:
        inp = (f"Audio de {duree} s à transcrire (langue : {langue}, bruit {bruit}, "
               f"{locuteurs} locuteur(s)).")
        out = (f"Plan : découper en segments ≤ 30 s ; transcrire segment par segment ; "
               f"ponctuer et normaliser les nombres ; marquer les passages inaudibles par [inaudible mm:ss] "
               f"au lieu d'inventer ; distinguer les locuteurs ({locuteurs}) ; "
               f"livrer le texte brut puis la version lisible.")
    else:
        inp = (f"{duree}s audio to transcribe (language: {langue}, {bruit} noise, "
               f"{locuteurs} speaker(s)).")
        out = (f"Plan: split into ≤ 30 s segments; transcribe segment by segment; "
               f"punctuate and normalize numbers; mark inaudible parts as [inaudible mm:ss] "
               f"instead of inventing; distinguish speakers ({locuteurs}); "
               f"deliver raw text then the readable version.")
    return {
        "task_type": "transcription_plan",
        "language": "fr" if fr else "en",
        "instruction": "Méthode de transcription segmentée et traitement des inaudibles." if fr
                       else "Segmented transcription method and inaudible handling.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

# ═══════════════════ music_v4 (15 000) ═══════════════════

GENRES_MUS = [("afrobeat", 100, 110), ("jazz manouche", 140, 170), ("lo-fi", 70, 85),
              ("mbalax", 115, 130), ("gospel", 75, 95), ("électro douce", 110, 125)]
GENRES_EN_MUS = [("afrobeat", 100, 110), ("gypsy jazz", 140, 170), ("lo-fi", 70, 85),
                 ("mbalax", 115, 130), ("gospel", 75, 95), ("soft electronic", 110, 125)]

def fab_brief_musique(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    genre, bpm_min, bpm_max = rng.choice(GENRES_MUS if fr else GENRES_EN_MUS)
    bpm = rng.randint(bpm_min, bpm_max)
    tonalite = rng.choice(["do majeur", "la mineur", "sol majeur", "mi mineur"]) if fr else \
               rng.choice(["C major", "A minor", "G major", "E minor"])
    instru = rng.sample(["kora", "guitare", "basse", "sabar", "piano", "synthé"], k=rng.randint(2, 4)) if fr else \
             rng.sample(["kora", "guitar", "bass", "sabar", "piano", "synth"], k=rng.randint(2, 4))
    duree = rng.choice([30, 45, 60, 90])
    if fr:
        inp = f"Brief : boucle musicale {genre}, {bpm} BPM, tonalité de {tonalite}, {duree} s, instruments : {', '.join(instru)}."
        out = (f"Plan de production : intro 4 mesures ({instru[0]} seul), thème en 8 mesures, "
               f"variation 8 mesures, sortie en fondu 2 s. Rythmique posée à {bpm} BPM en {tonalite}. "
               f"Livraison : WAV 44,1 kHz mono 96 kbps — format honnête pour le web.")
    else:
        inp = f"Brief: {genre} music loop, {bpm} BPM, key of {tonalite}, {duree}s, instruments: {', '.join(instru)}."
        out = (f"Production plan: 4-bar intro ({instru[0]} alone), 8-bar theme, "
               f"8-bar variation, 2 s fade-out exit. Groove set at {bpm} BPM in {tonalite}. "
               f"Delivery: 44.1 kHz mono WAV 96 kbps — honest web-ready format.")
    return {
        "task_type": "music_composition_brief",
        "language": "fr" if fr else "en",
        "instruction": "Traduis le brief en plan de production mesuré (structure, tempo, sortie)." if fr
                       else "Turn the brief into a measured production plan (structure, tempo, delivery).",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

# ═══════════════════ video_v4 (45 000) ═══════════════════

def fab_storyboard(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    sujet = rng.choice(SUJETS_FR if fr else TOPICS_EN)
    n = rng.choice([4, 5, 6])
    duree = n * rng.choice([2, 3])
    base_seed = rng.randint(1000, 9999)
    if fr:
        plan = "\n".join(f"Keyframe {i+1} : {sujet}, plan {'large' if i == 0 else ('moyen' if i < n - 1 else 'serré')}, graine {base_seed + i * 17}"
                         for i in range(n))
        out = (f"Storyboard ({n} keyframes, ~{duree} s à 24 fps) :\n{plan}\n"
               f"Transitions : xfade 1 s (fondu simple) entre keyframes successives. "
               f"Chaque graine est dérivée de la base (+17) pour la variabilité contrôlée.")
    else:
        plan = "\n".join(f"Keyframe {i+1}: {sujet}, {'wide' if i == 0 else ('medium' if i < n - 1 else 'close')} shot, seed {base_seed + i * 17}"
                         for i in range(n))
        out = (f"Storyboard ({n} keyframes, ~{duree} s at 24 fps):\n{plan}\n"
               f"Transitions: 1 s xfade (simple dissolve) between consecutive keyframes. "
               f"Each seed derives from the base (+17) for controlled variability.")
    return {
        "task_type": "video_storyboard",
        "language": "fr" if fr else "en",
        "instruction": "Construis le storyboard keyframes avec graines dérivées et transitions précises." if fr
                       else "Build the keyframe storyboard with derived seeds and precise transitions.",
        "input": f"Sujet : {sujet} — {n} keyframes, graines dérivées." if fr else f"Subject: {sujet} — {n} keyframes, derived seeds.",
        "output": out,
        "difficulty": "intermédiaire",
    }

def fab_sous_titres(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    n = rng.randint(3, 6)
    duree_seq = rng.choice([2, 3, 4])
    lignes = []
    for i in range(n):
        debut = i * duree_seq
        fin = debut + duree_seq
        texte = f"{['Bonjour et bienvenue.', 'Voici le sujet du jour.', 'Regardons ensemble.', 'Un exemple concret.', 'Récapitulons.', 'À bientôt.'][i % 6]}"
        lignes.append(f"{i+1}\n00:00:{debut:02d},000 --> 00:00:{fin:02d},000\n{texte}")
    if fr:
        inp = f"Génère les sous-titres SRT d'une voix-off de {n} phrases (~{n * duree_seq} s)."
        out = "SRT :\n" + "\n\n".join(lignes) + "\n\nRègle : jamais plus de 42 caractères par ligne ; ajuster les temps si la voix déborde."
    else:
        inp = f"Generate SRT subtitles for a {n}-sentence voice-over (~{n * duree_seq} s)."
        out = "SRT:\n" + "\n\n".join(lignes) + "\n\nRule: never more than 42 characters per line; adjust timings if the voice overruns."
    return {
        "task_type": "subtitle_generation",
        "language": "fr" if fr else "en",
        "instruction": "Produis un SRT bien formé avec timings cohérents et la règle de longueur." if fr
                       else "Produce a well-formed SRT with coherent timings and the length rule.",
        "input": inp,
        "output": out,
        "difficulty": "facile",
    }

def fab_montage(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    n = rng.choice([3, 4, 5])
    d = rng.choice([2, 3])
    fondu = rng.choice([0.5, 1.0])
    total = round(n * d - (n - 1) * fondu, 1)
    if fr:
        inp = f"Montage : {n} keyframes de {d} s chacune, fondu enchaîné de {fondu} s entre elles. Durée finale ?"
        out = (f"Durée finale = {n} × {d} − ({n} − 1) × {fondu} = {total} s.\n"
               f"Filtre type : xfade=transition=fade:duration={fondu} chaîné entre segments ; "
               f"audio en fondu de sortie (afade) 2 s avant la fin.")
    else:
        inp = f"Edit: {n} keyframes of {d} s each, {fondu} s crossfade between them. Final duration?"
        out = (f"Final duration = {n} × {d} − ({n} − 1) × {fondu} = {total} s.\n"
               f"Typical filter: chained xfade=transition=fade:duration={fondu} between segments; "
               f"audio with an output afade 2 s before the end.")
    return {
        "task_type": "video_editing_math",
        "language": "fr" if fr else "en",
        "instruction": "Calcule la durée exacte et décris la chaîne de filtres." if fr
                       else "Compute the exact duration and describe the filter chain.",
        "input": inp,
        "output": out,
        "difficulty": "intermédiaire",
    }

# ═══════════════════ multimodal_v4 (30 000) ═══════════════════

def fab_pipeline_media(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    produit = rng.choice(PRODUITS_FR if fr else PRODUITS_EN)
    n_keyframes = rng.choice([3, 4, 5, 6, 7, 8])
    n_segments = rng.randint(2, 5)
    resolution = rng.choice([512, 640, 768])
    fps = rng.choice([24, 25, 30])
    fondu = rng.choice([0.5, 1.0])
    graine = rng.randint(1000, 9999)
    tier = rng.choice(["ff_siwis", "af_heart", "voice_par_defaut"])
    if fr:
        inp = (f"Campagne : présenter le {produit} en vidéo courte avec voix-off française "
               f"({n_keyframes} keyframes, {resolution} px, {fps} fps, graine de base {graine}, voix {tier}).")
        out = (f"Pipeline :\n1. Texte → brief scénarisé (1 phrase par keyframe) ;\n"
               f"2. Image → {n_keyframes} keyframes photoréalistes (graines {graine}+17·i, {resolution} px) ;\n"
               f"3. Voix → {n_segments} segments TTS ≤ 2 000 caractères (voix {tier}) ;\n"
               f"4. Vidéo → xfade {fondu} s + piste audio + afade sortie, {fps} fps ;\n"
               f"Replis honnêtes : keyframe seule si ffmpeg indisponible ; message clair si TTS hors quota ; "
               f"statut « partiel » si un morceau d'essaim manque — jamais de résultat fabriqué.")
    else:
        inp = (f"Campaign: present the {produit} in a short video with a French voice-over "
               f"({n_keyframes} keyframes, {resolution} px, {fps} fps, base seed {graine}, voice {tier}).")
        out = (f"Pipeline:\n1. Text → scripted brief (one sentence per keyframe);\n"
               f"2. Image → {n_keyframes} photoreal keyframes (seeds {graine}+17·i, {resolution} px);\n"
               f"3. Voice → {n_segments} TTS segments ≤ 2,000 characters (voice {tier});\n"
               f"4. Video → {fondu} s xfade + audio track + output afade, {fps} fps;\n"
               f"Honest fallbacks: single keyframe if ffmpeg unavailable; clear message if TTS over quota; "
               f"\"partial\" status if a swarm chunk is missing — never a fabricated result.")
    return {
        "task_type": "multimodal_orchestration",
        "language": "fr" if fr else "en",
        "instruction": "Orchestre le pipeline complet avec étapes, bornes et replis explicites." if fr
                       else "Orchestrate the full pipeline with steps, bounds and explicit fallbacks.",
        "input": inp,
        "output": out,
        "difficulty": "avancé",
    }

def fab_choix_moteur(rng: random.Random) -> dict:
    fr = rng.random() < 0.55
    besoin = rng.choice([
        ("une image photoréaliste 768 px", "image", "SD 2.1 + LoRA photoréaliste, 26-30 pas, WebGPU local"),
        ("une voix-off française de 40 s", "voice", "Kokoro-82M (ff_siwis), segmentation si > 2 000 caractères"),
        ("une vidéo de 12 s à partir d'un texte", "video", "4-6 keyframes SD + xfade ffmpeg ; gen3 n'est pas Sora — le dire"),
        ("un résumé d'un long document", "text", "résumé extractif local puis raffinement — pas d'appel externe sans consentement"),
    ])
    demande, moteur, reponse = besoin
    if fr:
        inp = f"Besoin : {demande}. Quel moteur gen3 et quels paramètres ?"
        out = f"Moteur : {moteur} → {reponse}."
    else:
        inp = f"Need: {demande}. Which gen3 engine and parameters?"
        out = f"Engine: {moteur} → {reponse}."
    return {
        "task_type": "engine_selection",
        "language": "fr" if fr else "en",
        "instruction": "Sélectionne le moteur gen3 adapté et ses paramètres clés, avec les limites honnêtes." if fr
                       else "Select the right gen3 engine and key parameters, with honest limits.",
        "input": inp,
        "output": out,
        "difficulty": "facile",
    }

FABRIQUES_IMG_ANALYSIS = [fab_description_scene, fab_ocr, fab_graphique, fab_comptage_spatial]
FABRIQUES_IMG_GEN = [fab_prompt_photoreal, fab_retouche]
FABRIQUES_VOICE = [fab_brief_tts, fab_voix_marque]
FABRIQUES_AUDIO = [fab_classification_son, fab_transcription_plan]
FABRIQUES_MUSIC = [fab_brief_musique]
FABRIQUES_VIDEO = [fab_storyboard, fab_sous_titres, fab_montage]
FABRIQUES_MULTIMODAL = [fab_pipeline_media, fab_choix_moteur]
