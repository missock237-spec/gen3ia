"""
DOMAINE MÉDIAS — génération d'images, vidéo, son, clips musicaux.

Variation riche : chaque builder tire 5-8 dimensions (sujet, style, lumière,
composition, usage, contrainte, paramètres numériques, contrôle qualité) —
l'espace combinatoire dépasse 10⁵ combinaisons par type de tâche.
"""

from __future__ import annotations

import random

from .base import SpecDomaine, choisir
from .variations import Lex, joindre, nombre, pourcentage

# ─────────────────────────────────────────────────────────────────────────────
# 1. GÉNÉRATION D'IMAGES
# ─────────────────────────────────────────────────────────────────────────────

IM = Lex(
    sujet={
        "fr": [
            "un marché africain au lever du soleil", "une potière façonnant un vase",
            "une forêt tropicale après la pluie", "un port de pêche sous l'orage",
            "une bibliothèque ancienne aux rayons de bois", "des dunes rouges à l'aube",
            "une ruelle de médina aux murs ocre", "un atelier de mécanique rustique",
            "un village de montagne sous la neige", "une savane au crépuscule",
            "un grenier envahi par la lumière du jour", "une école de campagne en plein air",
            "un puits communal à midi", "un champ de coton mûr",
            "une récolte de mangues dans des paniers", "un atelier de tissage coloré",
            "une pépinière de jeunes plants", "un caravansérail au fond du désert",
            "un atelier de menuiserie à la fin du jour", "un pont de bois sur une rivière lente",
        ],
        "en": [
            "an African market at sunrise", "a potter shaping a vase",
            "a tropical forest after the rain", "a fishing harbor under a storm",
            "an old library with wooden shelves", "red dunes at dawn",
            "a medina alley with ochre walls", "a rustic mechanic workshop",
            "a mountain village under the snow", "a savanna at dusk",
            "an attic flooded with daylight", "an open-air rural school",
            "a communal well at noon", "a ripe cotton field",
            "a mango harvest in baskets", "a colorful weaving workshop",
            "a nursery of young seedlings", "a caravanserai deep in the desert",
            "a carpentry workshop at day's end", "a wooden bridge over a slow river",
        ],
    },
    style={
        "fr": ["photoréaliste", "aquarelle", "cinématographique", "illustration éditoriale",
               "au trait encré", "néo-impressionniste", "grain documentaire", "double exposition douce",
               "réalisme magique", "minimaliste à grands aplats", "rétro affiche années 60", "gouache texturée"],
        "en": ["photorealistic", "watercolor", "cinematic", "editorial illustration",
               "inked line art", "neo-impressionist", "documentary grain", "soft double exposure",
               "magical realism", "flat minimal", "60s retro poster", "textured gouache"],
    },
    lumiere={
        "fr": ["heure dorée", "contre-jour brumeux", "lumière diffuse de fenêtre", "studio à trois sources",
               "clair de lune bleuté", "mi-ombre d'après-midi", "aube froide et nette", "lampadaire isolé sous la pluie"],
        "en": ["golden hour", "misty backlight", "diffused window light", "three-point studio",
               "bluish moonlight", "mid-afternoon shade", "crisp cold dawn", "a lone streetlamp in the rain"],
    },
    composition={
        "fr": ["règle des tiers avec espace de respiration", "sujet central symétrique",
               "premier plan encadrant", "ligne d'horizon basse", "profondeur en trois plans",
               "cadrage serré sur les mains", "perspective en fuyante", "hauteur en plongée douce"],
        "en": ["rule of thirds with breathing room", "symmetrical centered subject",
               "framing foreground", "low horizon line", "three-plane depth",
               "tight crop on hands", "receding perspective", "gentle high angle"],
    },
    usage={
        "fr": ["une affiche d'événement culturel", "la couverture d'un rapport annuel",
               "un visuel de réseaux sociaux", "une illustration d'article de fond",
               "une affiche scolaire", "le panneau d'accueil d'une boutique",
               "une carte de vœux", "la bannière d'un site web"],
        "en": ["a cultural event poster", "an annual report cover",
               "a social media visual", "a feature-article illustration",
               "a school poster", "a shop welcome board",
               "a greeting card", "a website banner"],
    },
    contrainte={
        "fr": ["sans texte incrusté", "avec une zone libre en bas pour le titre",
               "palette limitée à trois couleurs", "sans visages reconnaissables",
               "en format vertical", "avec un fort contraste première/fond"],
        "en": ["no embedded text", "with a free lower zone for the title",
               "palette capped at three colors", "no recognizable faces",
               "vertical format", "strong figure-ground contrast"],
    },
    grain={
        "fr": ["grain argentique léger", "rendu net sans grain", "profondeur de champ marquée",
               "halo doux autour des hautes lumières", "vignettage discret"],
        "en": ["subtle film grain", "crisp grain-free render", "strong depth of field",
               "soft highlight bloom", "discreet vignetting"],
    },
)

IM_INSTR = {
    "fr": [
        "Génère une image de {sujet}, en style {style}, {lumiere}, {composition}, pour {usage} ({contrainte}).",
        "Crée un visuel de {sujet} — style {style}, {lumiere}, {composition}, destiné à {usage} ({contrainte}).",
        "Je veux une image de {sujet} en {style}, {lumiere}, {composition} — c'est pour {usage} ({contrainte}).",
    ],
    "en": [
        "Generate an image of {sujet}, in {style} style, {lumiere}, {composition}, for {usage} ({contrainte}).",
        "Create a visual of {sujet} — {style} style, {lumiere}, {composition}, for {usage} ({contrainte}).",
        "I want a picture of {sujet} in {style}, {lumiere}, {composition} — it's for {usage} ({contrainte}).",
    ],
}

IM_QC = {
    "fr": ["lisibilité du sujet principal en moins d'une seconde", "cohérence de la source de lumière sur toute l'image",
           "absence d'artefacts de mains, d'yeux ou de texte", "palette conforme à la contrainte",
           "détail suffisant au premier plan", "pas de symétrie mécanique involontaire",
           "bords propres sans éléments coupés gênants", "hiérarchie visuelle claire (un seul point focal)"],
    "en": ["main subject readable in under a second", "consistent light source across the frame",
           "no hand, eye or text artifacts", "palette honoring the constraint",
           "enough first-plane detail", "no unintended mechanical symmetry",
           "clean edges without awkward cut-offs", "clear visual hierarchy (one focal point)"],
}

IM_TIPS = {
    "fr": ["figer le seed pour comparer deux variantes à paramètres égaux",
           "commencer par 30 pas d'inférence, monter seulement si les détails fondent",
           "garder le prompt sous 75 mots : le modèle dilue au-delà",
           "générer d'abord en petite résolution pour choisir la composition",
           "noter chaque essai (prompt, seed, paramètres) dans un journal d'atelier"],
    "en": ["freeze the seed to compare two variants at equal settings",
           "start at 30 inference steps, raise only when details melt",
           "keep the prompt under 75 words: models dilute beyond that",
           "render small first to pick the composition",
           "log every attempt (prompt, seed, settings) in a workshop journal"],
}


def im_text_to_prompt(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = IM.tirer(rng, lang)
    instruction = choisir(rng, IM_INSTR[lang]).format(**s)
    ratio = choisir(rng, ["1:1", "4:5", "3:2", "16:9", "9:16", "2:3"])
    res = choisir(rng, ["1024x1024", "1344x768", "1536x640", "768x1344", "1216x832"])
    guidance = choisir(rng, [7.0, 7.5, 8.0, 8.5])
    pas = choisir(rng, [30, 35, 40, 50])
    negatif = (
        joindre(choisir(rng, [
            ["texte illisible", "membres déformés", "artefacts de compression"],
            ["visages déformés", "perspective incohérente", "couleurs saturées à l'excès"],
            ["filigrane", "bordure indésirable", "flou global"],
        ]), lang)
        if lang == "fr"
        else joindre(choisir(rng, [
            ["illegible text", "deformed limbs", "compression artifacts"],
            ["warped faces", "inconsistent perspective", "over-saturated colors"],
            ["watermark", "unwanted border", "overall blur"],
        ]), lang)
    )
    qc = joindre(rng.sample(IM_QC[lang], k=3), lang)
    tip = choisir(rng, IM_TIPS[lang])
    prompt_final = f"{s['sujet']}, {s['style']}, {s['lumiere']}, {s['composition']}, {s['grain']}"
    if lang == "fr":
        output = (
            f"Prompt final : « {prompt_final} ».\n"
            f"Paramètres : ratio {ratio}, résolution {res}, guidance {guidance}, {pas} pas d'inférence.\n"
            f"Prompt négatif : {negatif}.\n"
            f"Contrôle qualité avant validation : {qc}.\n"
            f"Astuce d'atelier : {tip}."
        )
    else:
        output = (
            f"Final prompt: \"{prompt_final}\".\n"
            f"Settings: {ratio} ratio, {res} resolution, guidance {guidance}, {pas} inference steps.\n"
            f"Negative prompt: {negatif}.\n"
            f"QC checklist before shipping: {qc}.\n"
            f"Workshop tip: {tip}."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "text_to_prompt",
        "safety_label": "sans_objet",
        "prompt_principal": prompt_final,
        "style": s["style"],
        "params": {
            "aspect_ratio": ratio, "resolution": res,
            "guidance": guidance, "steps": pas, "negative_prompt": negatif,
        },
    }


def im_style_guide(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = IM.tirer(rng, lang)
    couleurs = nombre(rng, 3, 5)
    contraste = choisir(rng, ["4.5:1", "5:1", "7:1"])
    series = nombre(rng, 6, 24, 2)
    regles = joindre(rng.sample({
        "fr": ["même température colorimétrique sur toute la série", "échelle des sujets constante à ±10 %",
               "même profondeur d'arrière-plan", "grain identique d'une image à l'autre",
               "un seul point focal par image", "espaces de respiration réservés au texte"],
        "en": ["same color temperature across the series", "subject scale constant within ±10%",
               "same background depth", "identical grain from one image to the next",
               "one focal point per image", "breathing space reserved for text"],
    }[lang], k=3), lang)
    if lang == "fr":
        instruction = (
            f"Rédige un guide de style {s['style']} pour une série de {series} images "
            f"destinée à {s['usage']} ({s['contrainte']})."
        )
        output = (
            f"Guide de style {s['style']} :\n"
            f"1) Palette : {couleurs} couleurs dominantes maximum + 1 accent, contraste cible {contraste} ;\n"
            f"2) Lumière et cadre : {s['lumiere']}, {s['composition']} ;\n"
            f"3) Cohérence de série ({series} images) : {regles} ;\n"
            f"4) Prompt système partagé + prompt négatif partagé, seuls {s['sujet']} et l'usage varient ;\n"
            f"5) Grille de validation : 5 critères notés de 0 à 2 — une image passe à ≥ 7/10, sinon régénération ciblée."
        )
    else:
        instruction = (
            f"Write a {s['style']} style guide for a {series}-image series "
            f"for {s['usage']} ({s['contrainte']})."
        )
        output = (
            f"{s['style']} style guide:\n"
            f"1) Palette: {couleurs} dominant colors max + 1 accent, target contrast {contraste} ;\n"
            f"2) Light and frame: {s['lumiere']}, {s['composition']} ;\n"
            f"3) Series consistency ({series} images): {regles} ;\n"
            f"4) Shared system prompt + shared negative prompt, only {s['sujet']} and usage vary ;\n"
            f"5" f") Validation grid: 5 criteria scored 0-2 — an image passes at ≥ 7/10, else targeted re-render."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "style_guide",
        "safety_label": "sans_objet",
        "style": s["style"],
        "serie": {"nb_images": series, "palette": couleurs, "contraste": contraste},
    }


def im_critique(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = IM.tirer(rng, lang)
    critere = choisir(rng, IM_QC[lang])
    correctif = choisir(rng, {
        "fr": ["décaler la lumière de ±10 % et re-générer avec le même seed",
               "avancer le sujet de deux mètres vers l'appareil pour séparer le fond",
               "resserrer le cadrage de 15 % sur le point focal",
               "brider la saturation d'un canal qui écrase les autres",
               "passer en format plus vertical pour libérer la zone de titre"],
        "en": ["shift the light by ±10% and re-render with the same seed",
               "move the subject two steps closer to separate the background",
               "tighten the crop by 15% on the focal point",
               "clip one color channel that drowns the others",
               "go more vertical to free the title zone"],
    }[lang])
    if lang == "fr":
        instruction = f"Critique mon rendu « {s['sujet']} » ({s['style']}) sur un critère : {critere}."
        output = (
            f"Diagnostic — {critere} :\n"
            f"1) Ce que le prompt contrôle déjà : {s['lumiere']}, {s['composition']} ;\n"
            f"2) Ce qui dérive souvent à la génération : les détails secondaires qui volent l'attention ;\n"
            f"3) Correctif ciblé : {correctif} ;\n"
            f"4) Validation : comparer deux rendus côte à côte (même seed), décider en 10 s — sinon le critère est mal posé."
        )
    else:
        instruction = f"Critique my render \"{s['sujet']}\" ({s['style']}) on one criterion: {critere}."
        output = (
            f"Diagnosis — {critere}:\n"
            f"1) What the prompt already controls: {s['lumiere']}, {s['composition']} ;\n"
            f"2) What usually drifts at render time: secondary details stealing attention ;\n"
            f"3" f") Targeted fix: {correctif} ;\n"
            f"4" f") Validation: compare two renders side by side (same seed), decide in 10s — else the criterion is ill-posed."
        )
    return {
        "instruction": instruction,
        "input": f"{s['sujet']}, {s['style']}",
        "output": output,
        "task_type": "critique_image",
        "safety_label": "sans_objet",
        "critere": critere,
        "prompt_principal": f"{s['sujet']}, {s['style']}, {s['lumiere']}",
    }


def im_variations(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = IM.tirer(rng, lang)
    axes = rng.sample({
        "fr": ["cadrage", "heure du jour", "palette", "focale implicite", "météo", "angle de caméra"],
        "en": ["framing", "time of day", "palette", "implied focal length", "weather", "camera angle"],
    }[lang], k=3)
    n = nombre(rng, 3, 5)
    if lang == "fr":
        instruction = (
            f"Propose {n} variations exploitables de « {s['sujet']} » ({s['style']}) "
            f"sur les axes : {joindre(axes, 'fr')}."
        )
        output = (
            f"{n} variations (une par axe, reste du prompt figé, seed conservé) :\n" +
            "\n".join(f"  {i+1}. {axe} — ne changer QUE cet attribut." for i, axe in enumerate(axes)) +
            f"\nProtocole A/B : même résolution, même guidance, comparaison à l'aveugle par deux relecteurs, "
            f"la gagnante devient la nouvelle base — et le journal des essais garde tout."
        )
    else:
        instruction = (
            f"Propose {n} usable variations of \"{s['sujet']}\" ({s['style']}) "
            f"along these axes: {joindre(axes, 'en')}."
        )
        output = (
            f"{n} variations (one per axis, rest frozen, seed kept):\n" +
            "\n".join(f"  {i+1}. {axe} — change ONLY that attribute." for i, axe in enumerate(axes)) +
            "\nA/B protocol: same resolution, same guidance, blind comparison by two reviewers, "
            "the winner becomes the new base — and the attempt log keeps everything."
        )
    return {
        "instruction": instruction,
        "input": f"{s['sujet']}, {s['style']}",
        "output": output,
        "task_type": "variations_prompt",
        "safety_label": "sans_objet",
        "variations": {"nombre": n, "axes": axes},
        "prompt_principal": f"{s['sujet']}, {s['style']}, {s['lumiere']}",
    }


# ─────────────────────────────────────────────────────────────────────────────
# 2. VIDÉO
# ─────────────────────────────────────────────────────────────────────────────

VI = Lex(
    sujet={
        "fr": ["la collecte de lait dans un village", "la réparation d'un vélo de chargement",
               "une journée à l'école de campagne", "le montage d'un forage solaire",
               "un atelier de couture qui grandit", "la vie d'une ruche urbaine",
               "un chantier de Briques comprimées", "le marché du poisson à l'aube",
               "une troupe de théâtre en répétition", "la transformation locale de céréales"],
        "en": ["milk collection in a village", "fixing a cargo bike",
               "a day at a rural school", "installing a solar borehole",
               "a growing sewing workshop", "the life of an urban beehive",
               "a compressed-brick building site", "the dawn fish market",
               "a theater troupe rehearsing", "local grain processing"],
    },
    ton={
        "fr": ["documentaire calme", "publicité dynamique", "tutoriel pas-à-pas",
               "reportage immersif", "portrait chaleureux"],
        "en": ["calm documentary", "dynamic advertising", "step-by-step tutorial",
               "immersive report", "warm portrait"],
    },
    duree={"fr": ["15", "20", "30", "45", "60", "90"], "en": ["15", "20", "30", "45", "60", "90"]},
    cible={
        "fr": ["des réseaux sociaux (format vertical)", "une page d'accueil web", "une salle d'attente (silencieux sous-titré)",
               "un écran de formation interne", "un kiosque d'exposition"],
        "en": ["social feeds (vertical format)", "a web homepage", "a waiting room (subtitled, silent)",
               "an internal training screen", "an exhibition kiosk"],
    },
    rythme={
        "fr": ["plans longs et posés (6-8 s)", "rythme vif (2-3 s par plan)", "alternance lent/vif toutes les 20 s"],
        "en": ["long settled shots (6-8s)", "brisk pace (2-3s per shot)", "slow/fast alternation every 20s"],
    },
)

VI_INSTR = {
    "fr": [
        "Prépare un storyboard de {duree} s sur « {sujet} », ton {ton}, pour {cible} — rythme : {rythme}.",
        "Storyboard {duree} s demandé : « {sujet} », {ton}, {cible}, {rythme}.",
    ],
    "en": [
        "Prepare a {duree}s storyboard about \"{sujet}\", {ton} tone, for {cible} — pacing: {rythme}.",
        "{duree}s storyboard requested: \"{sujet}\", {ton}, {cible}, {rythme}.",
    ],
}

VI_QC = {
    "fr": ["synchro audio vérifiée à ±40 ms", "sous-titres relus à voix haute", "poids final dans le budget cible",
           "première seconde accrocheuse même sans son", "droits musicaux clairs", "exposition stable entre plans"],
    "en": ["audio sync checked at ±40 ms", "subtitles proofread aloud", "final size within budget",
           "first second hooks even muted", "clear music rights", "stable exposure across shots"],
}


def vi_storyboard(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = VI.tirer(rng, lang)
    duree = int(s["duree"])
    nb = max(3, min(9, duree // max(2, 30 // rng.choice([3, 4, 5]))))
    plans = {
        "fr": ["plan large d'établissement", "plan moyen d'action", "gros plan détail",
               "traveling latéral", "contre-plongée", "plan final de conclusion"],
        "en": ["wide establishing shot", "medium action shot", "close-up detail",
               "lateral tracking shot", "low angle", "closing shot"],
    }[lang]
    duree_shot = round(duree / nb, 1)
    qc = joindre(rng.sample(VI_QC[lang], k=3), lang)
    if lang == "fr":
        instruction = choisir(rng, VI_INSTR["fr"]).format(**s)
        output = (
            f"Storyboard {duree} s — {nb} plans, ton {s['ton']}, rythme : {s['rythme']} :\n" +
            "\n".join(
                f"  Plan {i+1} ({duree_shot} s) : {plans[i % len(plans)]} — point d'intérêt unique, mouvement justifié."
                for i in range(nb)
            ) +
            f"\nVoix off : une phrase par plan (≤ 18 mots), transitions fondu 0,5 s.\n"
            f"Contrôles finaux : {qc}."
        )
    else:
        instruction = choisir(rng, VI_INSTR["en"]).format(**s)
        output = (
            f"{duree}s storyboard — {nb} shots, {s['ton']} tone, pacing: {s['rythme']}:\n" +
            "\n".join(
                f"  Shot {i+1} ({duree_shot}s): {plans[i % len(plans)]} — single point of interest, justified move."
                for i in range(nb)
            ) +
            f"\nVoice-over: one line per shot (≤ 18 words), 0.5s crossfades.\n"
            f"Final checks: {qc}."
        )
    shots = [{"numero": i + 1, "plan": plans[i % len(plans)], "duree_s": duree_shot} for i in range(nb)]
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "storyboard",
        "safety_label": "sans_objet",
        "scene": {"sujet": s["sujet"], "duree_s": duree, "ton": s["ton"], "shots": shots},
    }


def vi_scenario(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = VI.tirer(rng, lang)
    cta = choisir(rng, {
        "fr": ["visiter la page et réserver une visite", "appeler le numéro affiché", "s'abonner à la lettre d'information", "passer à l'atelier pour essayer"],
        "en": ["visit the page and book a tour", "call the number on screen", "subscribe to the newsletter", "drop by the workshop to try it"],
    }[lang])
    if lang == "fr":
        instruction = f"Écris le scénario d'une vidéo de {s['duree']} s sur « {s['sujet']} » pour {s['cible']}."
        output = (
            f"Accroche (0-5 s) : une image forte de {s['sujet']} + une question directe.\n"
            f"Développement : trois idées clés, une par plan, chacune portée par un détail concret.\n"
            f"Conclusion : bénéfice principal reformulé + un seul appel à l'action ({cta}).\n"
            f"Règles : phrases courtes à l'oral, sous-titres incrustés, musique à -18 LUFS, "
            f"et {s['rythme']} pour tenir l'attention jusqu'au bout."
        )
    else:
        instruction = f"Write the script of a {s['duree']}s video about \"{s['sujet']}\" for {s['cible']}."
        output = (
            f"Hook (0-5s): one strong image of {s['sujet']} + a direct question.\n"
            f"Body: three key ideas, one per shot, each carried by a concrete detail.\n"
            f"Closing: restate the main benefit + a single call to action ({cta}).\n"
            f"Rules: short spoken sentences, burned-in subtitles, music at -18 LUFS, "
            f"and {s['rythme']} to hold attention to the end."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "scenario_video",
        "safety_label": "sans_objet",
        "scene": {"sujet": s["sujet"], "duree_s": int(s["duree"]), "cible": s["cible"]},
    }


def vi_params(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = VI.tirer(rng, lang)
    duree = int(s["duree"])
    fps = choisir(rng, [24, 25, 30])
    res = choisir(rng, ["960x540", "1280x720", "1920x1080"])
    crf = choisir(rng, [23, 24, 26, 27])
    poids_min = round(duree * 0.3, 1)
    poids_max = round(duree * 0.65, 1)
    if lang == "fr":
        instruction = f"Paramètres de rendu pour une vidéo de {duree} s destinée à {s['cible']} ?"
        output = (
            f"Rendu : {res} à {fps} fps, H.264 crf {crf} (preset veryfast), AAC 96-128 kbps, faststart.\n"
            f"Images clés toutes les 2 s, débit plafonné à 4 Mbps — poids attendu {poids_min}-{poids_max} Mo.\n"
            f"Exports : master + version 540p pour connexions lentes.\n"
            f"Contrôles : {joindre(rng.sample(VI_QC['fr'], k=2), 'fr')}."
        )
    else:
        instruction = f"Render settings for a {duree}s video targeted at {s['cible']}?"
        output = (
            f"Render: {res} at {fps} fps, H.264 crf {crf} (veryfast preset), AAC 96-128 kbps, faststart.\n"
            f"Keyframes every 2s, bitrate capped at 4 Mbps — expected size {poids_min}-{poids_max} MB.\n"
            f"Exports: master + a 540p version for slow connections.\n"
            f"Checks: {joindre(rng.sample(VI_QC['en'], k=2), 'en')}."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "parametres_rendu",
        "safety_label": "sans_objet",
        "render": {"duree_s": duree, "fps": fps, "resolution": res, "crf": crf},
    }


def vi_montage(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = VI.tirer(rng, lang)
    coupes = pourcentage(rng, 5, 20)
    if lang == "fr":
        instruction = f"Feuille de montage pour ma vidéo « {s['sujet']} » ({s['ton']})."
        output = (
            f"1) Trier les rushes, marquer les meilleures prises (tableau à 3 colonnes : gardé / doute / jeté) ;\n"
            f"2) Monter l'audio d'abord (voix + musique), images calées ensuite ;\n"
            f"3) Resserrer chaque plan de {coupes} pour le rythme ({s['rythme']}) ;\n"
            f"4) Étalonnage en deux passes : exposition globale, puis couleur par scène ;\n"
            f"5) Sous-titres + relecture à voix haute ;\n"
            f"6) Exports : master qualité + version web pour {s['cible']}.\n"
            f"Contrôles : {joindre(rng.sample(VI_QC['fr'], k=3), 'fr')}."
        )
    else:
        instruction = f"Edit sheet for my video \"{s['sujet']}\" ({s['ton']})."
        output = (
            f"1) Triage rushes, flag best takes (3-column board: keep / doubt / drop) ;\n"
            f"2) Cut audio first (voice + music), pictures laid after ;\n"
            f"3) Tighten every shot by {coupes} for pace ({s['rythme']}) ;\n"
            f"4) Two-pass grade: global exposure, then per-scene color ;\n"
            f"5" f") Subtitles + read-aloud proofing ;\n"
            f"6" f") Exports: quality master + web version for {s['cible']}.\n"
            f"Checks: {joindre(rng.sample(VI_QC['en'], k=3), 'en')}."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "feuille_montage",
        "safety_label": "sans_objet",
        "scene": {"sujet": s["sujet"], "resserrement": coupes},
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3. SON
# ─────────────────────────────────────────────────────────────────────────────

SO = Lex(
    type={
        "fr": ["ambiance de forêt après la pluie", "pluie sur un toit de tôle", "ambiance de café du matin",
               "nappe de concentration sans mélodie", "voix off narrative douce", "effet sonore d'interface",
               "marché animé au loin", "vent dans les feuilles", "grillons de nuit", "foule discrète d'intérieur"],
        "en": ["forest ambience after rain", "rain on a tin roof", "morning cafe ambience",
               "melody-free focus bed", "gentle narrative voice-over", "interface sound effect",
               "busy market in the distance", "wind in the leaves", "night crickets", "soft indoor crowd"],
    },
    duree={"fr": ["10", "30", "60", "120", "300"], "en": ["10", "30", "60", "120", "300"]},
    usage={
        "fr": ["un podcast", "une vidéo tutorielle", "un espace de méditation", "un jeu mobile",
               "une installation d'exposition", "des boucles de sommeil"],
        "en": ["a podcast", "a tutorial video", "a meditation space", "a mobile game",
               "an exhibition installation", "sleep loops"],
    },
    niveau={
        "fr": ["-16 LUFS (streaming)", "-23 LUFS (broadcast)", "-20 dBFS de fond continu"],
        "en": ["-16 LUFS (streaming)", "-23 LUFS (broadcast)", "-20 dBFS continuous bed"],
    },
)

SO_EVENT = {
    "fr": ["deux-trois événements ponctuels espacés", "une seule surprise au milieu", "des micro-événements réguliers toutes les 20-30 s"],
    "en": ["two or three sparse one-off events", "a single mid-way surprise", "regular micro-events every 20-30s"],
}


def son_synthese(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = SO.tirer(rng, lang)
    duree = int(s["duree"])
    sr = choisir(rng, [22050, 44100, 48000])
    events = choisir(rng, SO_EVENT[lang])
    fondu_in = nombre(rng, 1, 3)
    fondu_out = fondu_in + nombre(rng, 1, 3)
    if lang == "fr":
        instruction = f"Génère un son de {s['type']} pendant {duree} s pour {s['usage']}."
        output = (
            f"Plan de synthèse : {s['type']}, {duree} s, {sr} Hz, 16 bits.\n"
            f"Couches : fond continu + {events} (attaque douce, décroissance naturelle).\n"
            f"Finitions : fondu d'entrée {fondu_in} s, sortie {fondu_out} s, normalisation {s['niveau']}.\n"
            f"Boucle : vérifiée sans clic si réutilisée en continu."
        )
    else:
        instruction = f"Generate a {s['type']} sound lasting {duree}s for {s['usage']}."
        output = (
            f"Synthesis plan: {s['type']}, {duree}s, {sr} Hz, 16-bit.\n"
            f"Layers: continuous bed + {events} (soft attack, natural decay).\n"
            f"Finishing: {fondu_in}s fade-in, {fondu_out}s fade-out, normalization {s['niveau']}.\n"
            f"Loop: click-free verified if reused continuously."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "synthese_sonore",
        "safety_label": "sans_objet",
        "sound": {"type": s["type"], "duree_s": duree, "sample_rate": sr, "fondus": [fondu_in, fondu_out]},
    }


def son_voix_off(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = SO.tirer(rng, lang)
    debit = choisir(rng, ["0.9", "0.95", "1.0"])
    mots = choisir(rng, [60, 75, 90, 110])
    pauses = nombre(rng, 200, 400, 50)
    if lang == "fr":
        instruction = f"Rédige et règle une voix off claire ({mots} mots) pour {s['usage']}."
        output = (
            f"Script ({mots} mots, 150 mots/min) : une idée par phrase, mots concrets, acronymes développés.\n"
            f"Réglages : débit {debit}, ton neutre-chaleureux, pauses {pauses} ms entre paragraphes.\n"
            f"Contrôles : lecture à voix haute, couper tout mot qui bute, aligner chaque phrase sur un plan."
        )
    else:
        instruction = f"Write and tune a clear voice-over ({mots} words) for {s['usage']}."
        output = (
            f"Script ({mots} words, 150 wpm): one idea per sentence, concrete words, acronyms expanded.\n"
            f"Settings: speed {debit}, neutral-warm tone, {pauses} ms paragraph pauses.\n"
            f"Checks: read aloud, cut tripping words, align every line with a shot."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "voix_off",
        "safety_label": "sans_objet",
        "sound": {"type": "voix_off", "mots": mots, "debit": debit, "pauses_ms": pauses},
    }


def son_chaine(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = SO.tirer(rng, lang)
    comp = choisir(rng, ["2:1", "3:1", "4:1"])
    attaque = choisir(rng, ["5", "10", "20"])
    relache = choisir(rng, ["80", "100", "150"])
    if lang == "fr":
        instruction = f"Chaîne de traitement audio pour {s['usage']} (source : {s['type']})."
        output = (
            f"Ordre : 1) nettoyage (coupe < 80 Hz, réducteur doux) ; 2) EQ (creuser 200-400 Hz si bouché, "
            f"raviver 3-5 kHz pour l'intelligibilité) ; 3) compression {comp}, attaque {attaque} ms, relâche {relache} ms ; "
            f"4) limiteur à -1 dBTP.\n"
            f"Cible de loudness : {s['niveau']}.\n"
            f"Méthode : traiter dans cet ordre, comparer A/B à niveau égal avec le brut."
        )
    else:
        instruction = f"Audio processing chain for {s['usage']} (source: {s['type']})."
        output = (
            f"Order: 1) cleanup (cut < 80 Hz, gentle reducer) ; 2) EQ (dip 200-400 Hz if boxy, "
            f"lift 3-5 kHz for intelligibility) ; 3) compression {comp}, {attaque} ms attack, {relache} ms release ; "
            f"4" f") limiter at -1 dBTP.\n"
            f"Loudness target: {s['niveau']}.\n"
            f"Method: process in this order, A/B at equal level against the raw take."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "chaine_audio",
        "safety_label": "sans_objet",
        "sound": {"compression": comp, "attaque_ms": attaque, "relache_ms": relache},
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. CLIPS MUSICAUX
# ─────────────────────────────────────────────────────────────────────────────

MU = Lex(
    genre={
        "fr": ["afrobeat", "amapiano", "rnb doux", "hip-hop conscient", "afro-house", "folk acoustique",
               "zouk moderne", "highlife revisité"],
        "en": ["afrobeat", "amapiano", "smooth rnb", "conscious hip-hop", "afro-house", "acoustic folk",
               "modern zouk", "revisited highlife"],
    },
    theme={
        "fr": ["la persévérance au quotidien", "une déclaration d'amour honnête", "la fierté de ses origines",
               "la ville qui s'éveille", "l'amitié qui traverse les années", "le retour au village",
               "les mains qui construisent", "l'attente d'une bonne nouvelle"],
        "en": ["everyday perseverance", "an honest love statement", "pride in one's roots",
               "the city waking up", "friendship across the years", "the return to the village",
               "the hands that build", "waiting for good news"],
    },
    bpm={"fr": ["96", "100", "104", "110", "114", "120"], "en": ["96", "100", "104", "110", "114", "120"]},
    tonalite={"fr": ["A mineur", "C majeur", "D mineur", "F# mineur", "G majeur"],
              "en": ["A minor", "C major", "D minor", "F# minor", "G major"]},
)

MU_LIEUX = {
    "fr": ["intime (chambre ou cour)", "collectif (groupe d'amis)", "symbolique (paysage ouvert au crépuscule)",
           "atelier (le travail en gros plan)", "rue (la ville qui bouge)"],
    "en": ["intimate (room or yard)", "collective (group of friends)", "symbolic (open landscape at dusk)",
           "workshop (work in close-up)", "street (the moving city)"],
}


def mu_concept_clip(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = MU.tirer(rng, lang)
    bpm = int(s["bpm"])
    duree = choisir(rng, [150, 180, 210, 240])
    lieux = rng.sample(MU_LIEUX[lang], k=3)
    if lang == "fr":
        instruction = (
            f"Conçois le concept d'un clip {s['genre']} de {duree} s sur « {s['theme']} » "
            f"({bpm} BPM, {s['tonalite']})."
        )
        output = (
            f"Concept : le clip traverse trois lieux — {joindre(lieux, 'fr')}.\n"
            f"Musique : {s['genre']} à {bpm} BPM en {s['tonalite']}, structure intro-couplet-refrain ×2-pont-final ; "
            f"le lieu {lieux[0]} revient à chaque refrain, lumière différente à chaque retour.\n"
            f"Production : plans signatures réutilisables, étalonnage chaud désaturé, sous-titres stylisés."
        )
    else:
        instruction = (
            f"Design the concept of a {duree}s {s['genre']} video about \"{s['theme']}\" "
            f"({bpm} BPM, {s['tonalite']})."
        )
        output = (
            f"Concept: the video crosses three places — {joindre(lieux, 'en')}.\n"
            f"Music: {s['genre']} at {bpm} BPM in {s['tonalite']}, intro-verse-chorus ×2-bridge-out; "
            f"the {lieux[0]} place returns at each chorus, different light each time.\n"
            f"Production: reusable signature shots, warm desaturated grade, stylized subtitles."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "concept_clip",
        "safety_label": "sans_objet",
        "music": {"genre": s["genre"], "bpm": bpm, "theme": s["theme"], "tonalite": s["tonalite"], "duree_s": duree},
    }


def mu_structure(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = MU.tirer(rng, lang)
    mes_intro = choisir(rng, [4, 8])
    mes_couplet = choisir(rng, [8, 12])
    filtre_hz = choisir(rng, [150, 200, 250])
    if lang == "fr":
        instruction = f"Structure d'un morceau {s['genre']} en {s['tonalite']} à {s['bpm']} BPM."
        output = (
            f"Intro ({mes_intro} mesures, nappe + percussions filtrées) → Couplet 1 ({mes_couplet} mesures, basse au premier plan) → "
            f"Refrain ({mes_couplet} mesures, énergie max, voix doublée) → Couplet 2 → Refrain ×2 → Pont (4 mesures, silence maîtrisé) → Final.\n"
            f"Énergie par section : 0.3 / 0.55 / 0.95 / 0.6 / 0.95 / 0.4 / 0.8.\n"
            f"Mix : passe-haut automatisé sur l'intro ({filtre_hz} Hz → ouverture progressive)."
        )
    else:
        instruction = f"Structure of a {s['genre']} track in {s['tonalite']} at {s['bpm']} BPM."
        output = (
            f"Intro ({mes_intro} bars, pad + filtered percussion) → Verse 1 ({mes_couplet} bars, bass forward) → "
            f"Chorus ({mes_couplet} bars, max energy, doubled vocals) → Verse 2 → Chorus ×2 → Bridge (4 bars, controlled silence) → Outro.\n"
            f"Per-section energy: 0.3 / 0.55 / 0.95 / 0.6 / 0.95 / 0.4 / 0.8.\n"
            f"Mix: automated high-pass on the intro ({filtre_hz} Hz → progressive opening)."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "structure_musicale",
        "safety_label": "sans_objet",
        "music": {"genre": s["genre"], "tonalite": s["tonalite"], "bpm": int(s["bpm"]), "intro_mesures": mes_intro},
    }


def mu_paroles(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = MU.tirer(rng, lang)
    rime = choisir(rng, ["ABAB", "AABB"])
    syllabes = choisir(rng, [10, 11, 12])
    if lang == "fr":
        instruction = f"Écris un refrain mémorable (4 vers, rimes {rime}) sur « {s['theme']} » pour un morceau {s['genre']}."
        output = (
            f"Méthode du refrain :\n"
            f"  Vers 1 : l'image forte ({s['theme']}) ; vers 2 : la promesse ; vers 3 : l'élan ; vers 4 : le hook qui se retient.\n"
            f"Contraintes : {syllabes} syllabes par vers, rimes {rime}, le dernier mot des vers 2 et 4 identique (repeatable à l'oreille).\n"
            f"Test : chanter a cappella deux fois — si on bute, resserrer."
        )
    else:
        instruction = f"Write a memorable 4-line chorus ({rime} rhymes) about \"{s['theme']}\" for a {s['genre']} track."
        output = (
            f"Chorus method:\n"
            f"  Line 1: the strong image ({s['theme']}) ; line 2: the promise ; line 3: the lift ; line 4: the sticky hook.\n"
            f"Constraints: {syllabes} syllables per line, {rime} rhymes, same end word on lines 2 and 4 (ear-sticky).\n"
            f"Test: sing it a cappella twice — if you trip, tighten."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "ecriture_paroles",
        "safety_label": "sans_objet",
        "music": {"theme": s["theme"], "genre": s["genre"], "rimes": rime, "syllabes": syllabes},
    }


DOMAINES_MEDIAS = [
    SpecDomaine(
        id="generation_images",
        nom_fr="génération d'images",
        nom_en="image generation",
        description_fr=(
            "Ingénierie de prompts visuels, guides de style, variations A/B et "
            "critique — prompts structurés (sujet, style, lumière, composition, "
            "usage, contrainte), paramètres explicites et critères de contrôle "
            "objectifs."
        ),
        description_en=(
            "Visual prompt engineering, style guides, A/B variations and "
            "critique — structured prompts (subject, style, light, composition, "
            "usage, constraint), explicit settings and objective QC criteria."
        ),
        mots_cles=["image", "visuel", "prompt", "style", "photo", "illustration"],
        taches=[
            ("text_to_prompt", 0.40, im_text_to_prompt, im_text_to_prompt),
            ("style_guide", 0.20, im_style_guide, im_style_guide),
            ("critique_image", 0.20, im_critique, im_critique),
            ("variations_prompt", 0.20, im_variations, im_variations),
        ],
    ),
    SpecDomaine(
        id="video",
        nom_fr="vidéo",
        nom_en="video",
        description_fr=(
            "Storyboards, scénarios, paramètres de rendu et feuilles de montage "
            "— durée, plans, ton, cible de diffusion et contraintes techniques "
            "réelles (codecs, crf, LUFS, poids cible)."
        ),
        description_en=(
            "Storyboards, scripts, render settings and edit sheets — duration, "
            "shots, tone, delivery target and real technical constraints "
            "(codecs, crf, LUFS, target size)."
        ),
        mots_cles=["video", "clip", "film", "storyboard", "montage", "rendu"],
        taches=[
            ("storyboard", 0.35, vi_storyboard, vi_storyboard),
            ("scenario_video", 0.25, vi_scenario, vi_scenario),
            ("parametres_rendu", 0.20, vi_params, vi_params),
            ("feuille_montage", 0.20, vi_montage, vi_montage),
        ],
    ),
    SpecDomaine(
        id="son",
        nom_fr="son",
        nom_en="sound",
        description_fr=(
            "Synthèse sonore, voix off et chaînes de traitement audio — repères "
            "professionnels réels (dBFS, LUFS, fréquences d'EQ, compression)."
        ),
        description_en=(
            "Sound synthesis, voice-over and audio chains — real professional "
            "references (dBFS, LUFS, EQ frequencies, compression settings)."
        ),
        mots_cles=["son", "audio", "voix", "ambiance", "sonore", "sound"],
        taches=[
            ("synthese_sonore", 0.40, son_synthese, son_synthese),
            ("voix_off", 0.30, son_voix_off, son_voix_off),
            ("chaine_audio", 0.30, son_chaine, son_chaine),
        ],
    ),
    SpecDomaine(
        id="clips_musicaux",
        nom_fr="clips musicaux",
        nom_en="music clips",
        description_fr=(
            "Concepts de clips, structures musicales (mesures, tonalité, "
            "énergie par section) et écriture de refrains — genres réels "
            "(afrobeat, amapiano, rnb...)."
        ),
        description_en=(
            "Video concepts, musical structures (bars, key, per-section "
            "energy) and chorus writing — real genres (afrobeat, amapiano, "
            "rnb...)."
        ),
        mots_cles=["musique", "clip", "refrain", "bpm", "genre", "music"],
        taches=[
            ("concept_clip", 0.40, mu_concept_clip, mu_concept_clip),
            ("structure_musicale", 0.30, mu_structure, mu_structure),
            ("ecriture_paroles", 0.30, mu_paroles, mu_paroles),
        ],
    ),
]
