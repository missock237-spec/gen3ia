"""
DOMAINE INGÉNIERIE — développement web, test, construction de machines,
cybersécurité (défensive) et hacking éthique (CTF éducatif).

Variation riche par slots (stack, besoin, contrainte, environnement,
paramètres numériques). Sécurité : « hacker » = CTF éducatif et analyse
défensive uniquement, safety_label explicite sur chaque ligne.
"""

from __future__ import annotations

import random

from .base import SpecDomaine, choisir

from .variations import Lex, joindre, nombre, pourcentage

# ─────────────────────────────────────────────────────────────────────────────
# 5. DÉVELOPPEMENT WEB
# ─────────────────────────────────────────────────────────────────────────────

DW = Lex(
    besoin={
        "fr": ["une page de contact avec validation", "un tableau de bord avec graphique",
               "une liste de tâches persistante", "un formulaire multi-étapes",
               "une galerie photo filtrable", "un blog avec pagination",
               "une recherche instantanée côté client", "un panier minimal",
               "un planning de réservation simple", "une page de statut de service"],
        "en": ["a contact page with validation", "a dashboard with a chart",
               "a persistent todo list", "a multi-step form",
               "a filterable photo gallery", "a blog with pagination",
               "instant client-side search", "a minimal cart",
               "a simple booking planner", "a service status page"],
    },
    stack={
        "fr": ["HTML/CSS/JS vanilla", "React + Next.js", "Vue 3", "Python Flask + templates",
               "Svelte + Vite", "PHP + MySQL classiques"],
        "en": ["vanilla HTML/CSS/JS", "React + Next.js", "Vue 3", "Python Flask + templates",
               "Svelte + Vite", "plain PHP + MySQL"],
    },
    contrainte={
        "fr": ["mobile-first sur connexion lente", "accessibilité clavier complète",
               "fonctionne hors-ligne après premier chargement", "contraste AA obligatoire",
               "sans framework CSS", "temps de chargement < 2 s en 3G"],
        "en": ["mobile-first on a slow connection", "full keyboard accessibility",
               "offline-capable after first load", "AA contrast mandatory",
               "no CSS framework", "load time < 2s on 3G"],
    },
    etats={
        "fr": ["chargement, vide, erreur, succès", "vide, partiel, erreur réseau, succès",
               "initial, en cours, échec, retry réussi"],
        "en": ["loading, empty, error, success", "empty, partial, network error, success",
               "initial, in-progress, failed, successful retry"],
    },
)

DW_INSTR = {
    "fr": ["Développe {besoin} en {stack}, avec la contrainte : {contrainte}.",
           "Code {besoin} avec {stack} — contrainte : {contrainte}.",
           "Crée {besoin} en {stack} ({contrainte})."],
    "en": ["Develop {besoin} in {stack}, with the constraint: {contrainte}.",
           "Build {besoin} with {stack} — constraint: {contrainte}.",
           "Create {besoin} in {stack} ({contrainte})."],
}

DW_ETAPES = {
    "fr": ["structure sémantique (balises section/form/label, un seul h1)",
           "styles à variables CSS, mobile d'abord",
           "états UI explicites : {etats}",
           "validation côté client ET côté serveur",
           "focus visible, aria-live sur les messages, navigation clavier",
           "tests : 3 cas nominatifs + 2 cas d'erreur avant livraison",
           "mesure du poids total (objectif < {poids} Ko gzip)"],
    "en": ["semantic structure (section/form/label tags, single h1)",
           "CSS-variable styles, mobile first",
           "explicit UI states: {etats}",
           "client AND server validation",
           "visible focus, aria-live on messages, keyboard navigation",
           "tests: 3 happy paths + 2 error cases before shipping",
           "total payload check (target < {poids} KB gzip)"],
}

DW_BUGS = {
    "fr": [
        ("page blanche après déploiement", "chemins d'import cassés par le build — vérifier imports relatifs et base path"),
        ("le formulaire soumet deux fois", "double écoute du submit — désactiver le bouton pendant l'envoi + idempotence serveur"),
        ("les styles manquent en production", "ordre de chargement CSS et hash de cache — forcer l'ordre d'import"),
        ("l'état ne se met pas à jour", "mutation directe de l'état — passer par la mise à jour immuable"),
        ("le champ date rejette une saisie valide", "format locale vs ISO — normaliser à la frontière du composant"),
    ],
    "en": [
        ("blank page after deploy", "import paths broken by the build — check relative imports and base path"),
        ("the form submits twice", "double submit listener — disable the button while sending + server idempotency"),
        ("styles missing in production", "CSS load order and cache hash — enforce import order"),
        ("state does not update", "direct state mutation — use the immutable update path"),
        ("date field rejects valid input", "locale format vs ISO — normalize at the component boundary"),
    ],
}


def dw_fonctionnalite(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = DW.tirer(rng, lang)
    instruction = choisir(rng, DW_INSTR[lang]).format(**s)
    poids = nombre(rng, 150, 500, 50)
    etapes = rng.sample(DW_ETAPES[lang], k=5)
    etapes = [e.format(etats=s["etats"], poids=poids) for e in etapes]
    if lang == "fr":
        output = (
            f"Plan d'implémentation ({s['stack']}) :\n" +
            "\n".join(f"{i+1}) {e}." for i, e in enumerate(etapes)) +
            f"\nRecette finale : parcourir le parcours complet sur mobile et clavier seul — "
            f"si un blocage apparaît, il rentre dans la liste avant la livraison."
        )
    else:
        output = (
            f"Implementation plan ({s['stack']}):\n" +
            "\n".join(f"{i+1}) {e}." for i, e in enumerate(etapes)) +
            "\nFinal acceptance: walk the full journey on mobile and keyboard only — "
            "any blocker joins the list before shipping."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "implementation_web",
        "safety_label": "sans_objet",
        "stack": s["stack"],
        "contrainte": s["contrainte"],
        "poids_cible_ko": poids,
    }


def dw_debug(rng: random.Random, lang: str, ctx: dict) -> dict:
    b, cause = choisir(rng, DW_BUGS[lang])
    temps = nombre(rng, 10, 60, 5)
    if lang == "fr":
        instruction = f"Débogue : {b} (symptôme intermittent depuis {temps} min)."
        output = (
            f"Cause probable : {cause}.\n"
            f"Méthode : reproduire (étapes notées), isoler (point d'arrêt ou log minimal), "
            f"corriger la CAUSE RACINE, puis un test de non-régression qui échouait avant le correctif.\n"
            f"Si intermittent : chercher la course (double événement, réseau lent, cache) — "
            f"et journaliser pour confirmer l'hypothèse sur les prochaines occurrences."
        )
    else:
        instruction = f"Debug: {b} (intermittent symptom for {temps} min)."
        output = (
            f"Likely cause: {cause}.\n"
            f"Method: reproduce (note the steps), isolate (breakpoint or minimal log), "
            f"fix the ROOT CAUSE, then a regression test that failed before the fix.\n"
            f"If intermittent: hunt the race (double event, slow network, cache) — "
            f"and log data to confirm the hypothesis on next occurrences."
        )
    return {
        "instruction": instruction,
        "input": b,
        "output": output,
        "task_type": "debug_web",
        "safety_label": "sans_objet",
        "bug": b,
    }


def dw_api(rng: random.Random, lang: str, ctx: dict) -> dict:
    ressource = choisir(rng, {
        "fr": ["notes", "événements", "commandes", "signalements", "cotisations"],
        "en": ["notes", "events", "orders", "reports", "dues"],
    }[lang])
    limite = nombre(rng, 20, 100, 20)
    if lang == "fr":
        instruction = f"Conçois l'API REST d'un service de {ressource} avec pagination et validation."
        output = (
            f"Endpoints : GET /{ressource}?page=1&limit={limite}, GET /{ressource}/{{id}}, "
            f"POST /{ressource}, PATCH /{ressource}/{{id}}, DELETE /{ressource}/{{id}}.\n"
            f"Contrats : 200/201/204/400/404/409, erreurs {{ \"error\": {{ \"code\", \"message\" }} }}, "
            f"limit borné à {limite}.\n"
            f"Robustesse : idempotence POST (clé client), rate-limit doux, journal 4xx/5xx avec request-id.\n"
            f"Versionnement : préfixe /v1 dès le premier jour — changer un contrat sans version coûte dix fois plus cher."
        )
    else:
        instruction = f"Design the REST API of a {ressource} service with pagination and validation."
        output = (
            f"Endpoints: GET /{ressource}?page=1&limit={limite}, GET /{ressource}/{{id}}, "
            f"POST /{ressource}, PATCH /{ressource}/{{id}}, DELETE /{ressource}/{{id}}.\n"
            f"Contracts: 200/201/204/400/404/409, errors {{ \"error\": {{ \"code\", \"message\" }} }}, "
            f"limit capped at {limite}.\n"
            f"Robustness: POST idempotency (client key), soft rate-limit, 4xx/5xx logging with request-id.\n"
            f"Versioning: /v1 prefix from day one — changing a contract without a version costs ten times more."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "conception_api",
        "safety_label": "sans_objet",
        "api": {"ressource": ressource, "limit": limite},
    }


# ─────────────────────────────────────────────────────────────────────────────
# 6. TEST
# ─────────────────────────────────────────────────────────────────────────────

TE = Lex(
    cible={
        "fr": ["une fonction de facturation", "un formulaire d'inscription",
               "un moteur de recherche interne", "une API de paiements",
               "un importateur de fichiers CSV", "un planificateur de rappels",
               "un calcul de frais de livraison"],
        "en": ["an invoicing function", "a signup form",
               "an internal search engine", "a payments API",
               "a CSV importer", "a reminder scheduler",
               "a shipping-fee calculator"],
    },
    casse={
        "fr": ["chaîne vide", "entrée nulle", "nombre négatif", "date du 29 février",
               "texte unicode émoji", "valeur maximale", "double soumission", "fichier vide"],
        "en": ["empty string", "null input", "negative number", "February 29 date",
               "unicode emoji text", "max value", "double submission", "empty file"],
    },
)

TE_INSTR = {
    "fr": ["Établis un plan de test pour {cible}, priorité aux cas {casse}.",
           "Plan de test demandé pour {cible} — inclure {casse}."],
    "en": ["Set up a test plan for {cible}, priority on {casse} cases.",
           "Test plan requested for {cible} — include {casse}."],
}


def te_plan(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = TE.tirer(rng, lang)
    lignes_cible = choisir(rng, [70, 80, 90])
    rapide = nombre(rng, 1, 3)
    if lang == "fr":
        instruction = choisir(rng, TE_INSTR["fr"]).format(**s)
        output = (
            f"Pyramide pour {s['cible']} :\n"
            f"1) Unitaires — cas limites ({s['casse']}), rapides (< {rapide} min) ;\n"
            f"2) Intégration — contrats testés sur double fidèle des dépendances ;\n"
            f"3) Bout-en-bout — 3 parcours critiques seulement.\n"
            f"Couverture : {lignes_cible} % de lignes, 100 % des branches d'erreur.\n"
            f"Règle d'or : chaque bug corrigé devient un test qui échouait avant."
        )
    else:
        instruction = choisir(rng, TE_INSTR["en"]).format(**s)
        output = (
            f"Pyramid for {s['cible']}:\n"
            f"1) Unit — edge cases ({s['casse']}), fast (< {rapide} min) ;\n"
            f"2) Integration — contracts against faithful fakes ;\n"
            f"3" f") End-to-end — 3 critical journeys only.\n"
            f"Coverage: {lignes_cible}% lines, 100% error branches.\n"
            f"Golden rule: every fixed bug becomes a test that failed before."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "plan_test",
        "safety_label": "sans_objet",
        "cible": s["cible"],
        "couverture": {"lignes": lignes_cible / 100, "branches_erreur": 1.0, "suite_rapide_min": rapide},
    }


def te_cas_limite(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = TE.tirer(rng, lang)
    reprise = choisir(rng, {
        "fr": ["rejet propre avec message actionnable", "traitement correct documenté", "rejet + journalisation"],
        "en": ["clean rejection with actionable message", "documented correct handling", "rejection + logging"],
    }[lang])
    executions = nombre(rng, 5, 20, 5)
    if lang == "fr":
        instruction = f"Rédige le cas de test « {s['casse']} » pour {s['cible']}."
        output = (
            f"Triplet donné/quand/alors :\n"
            f"  Étant donné {s['cible']} en état nominal, quand on fournit {s['casse']}, "
            f"alors {reprise} (décidé AVANT d'écrire le test).\n"
            f"Vérifications : aucun crash, message clair, pas de fuite de ressource, "
            f"même résultat sur {executions} exécutions (déterminisme)."
        )
    else:
        instruction = f"Write the \"{s['casse']}\" test case for {s['cible']}."
        output = (
            f"Given/when/then triplet:\n"
            f"  Given {s['cible']} in nominal state, when fed {s['casse']}, "
            f"then {reprise} (decided BEFORE writing the test).\n"
            f"Checks: no crash, clear message, no resource leak, "
            f"same result across {executions} runs (determinism)."
        )
    return {
        "instruction": instruction,
        "input": s["casse"],
        "output": output,
        "task_type": "cas_limite",
        "safety_label": "sans_objet",
        "entree": s["casse"],
    }


def te_automatisation(rng: random.Random, lang: str, ctx: dict) -> dict:
    seuil = nombre(rng, 1, 5)
    if lang == "fr":
        instruction = f"Intégrer les tests dans la CI avec une suite rapide de {seuil} min maximum."
        output = (
            f"CI : 1) suite rapide (< {seuil} min) obligatoire à chaque push — unitaires + contrats ; "
            f"2) suite complète nocturne — intégration + bout-en-bout ; "
            f"3) flaky-quarantine — test instable sorti de la voie bloquante avec ticket daté.\n"
            f"Mesures : durée médiane, taux d'échec non-lié-au-code, délai de détection d'une régression.\n"
            f"La CI est un espion honnête : si elle ment (tests instables tolérés), l'équipe arrête de la croire."
        )
    else:
        instruction = f"Integrate tests into CI with a fast suite of {seuil} min max."
        output = (
            f"CI: 1) fast suite (< {seuil} min) mandatory on every push — unit + contracts ; "
            f"2) full nightly suite — integration + end-to-end ; "
            f"3) flaky-quarantine — unstable test leaves the blocking lane with a dated ticket.\n"
            f"Metrics: median duration, non-code failure rate, regression detection delay.\n"
            f"CI is an honest witness: if it lies (tolerated flakes), the team stops trusting it."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "ci_tests",
        "safety_label": "sans_objet",
        "ci": {"suite_rapide_min": seuil, "quarantaine": True},
    }


# ─────────────────────────────────────────────────────────────────────────────
# 7. CONSTRUCTION DE MACHINES
# ─────────────────────────────────────────────────────────────────────────────

CM = Lex(
    machine={
        "fr": ["un bras robotisé à 3 axes", "une imprimante 3D FDM", "un système d'irrigation automatisé",
               "un convoyeur à tri couleur", "une station météo connectée", "un incubateur à température stable",
               "un trieuse de graines à vibrations", "une pompe solaire à niveau automatique"],
        "en": ["a 3-axis robotic arm", "an FDM 3D printer", "an automated irrigation system",
               "a color-sorting conveyor", "a connected weather station", "a stable-temperature incubator",
               "a vibration seed sorter", "an auto-level solar pump"],
    },
    capteur={
        "fr": ["capteur de température", "accéléromètre", "capteur d'humidité du sol", "capteur de courant",
               "fin de course", "capteur de niveau", "photodiode"],
        "en": ["temperature sensor", "accelerometer", "soil moisture sensor", "current sensor",
               "limit switch", "level sensor", "photodiode"],
    },
    environnement={
        "fr": ["poussière et chaleur", "humidité élevée", "tension réseau instable", "champ extérieur sans ombre",
               "atelier avec vibrations"],
        "en": ["dust and heat", "high humidity", "unstable mains voltage", "open field without shade",
               "vibrating workshop"],
    },
)

CM_SYMPTOMES = {
    "fr": [
        ("le moteur vibre et chauffe", "déséquilibre ou couple excessif — vérifier alignement, roulements, courant absorbé"),
        ("les lectures du capteur dérivent", "dérive thermique ou câblage long non blindé — moyenne glissante + câble blindé court"),
        ("la machine redémarre seule", "chute de tension à l'accrochage — condensateur de découplage et alimentation dimensionnée"),
        ("l'actionneur bat en butée", "consigne non bornée — limites logicielles + fin de course mécanique"),
    ],
    "en": [
        ("the motor vibrates and overheats", "imbalance or excessive torque — check alignment, bearings, drawn current"),
        ("sensor readings drift", "thermal drift or long unshielded wiring — moving average + short shielded cable"),
        ("the machine reboots by itself", "voltage sag at engagement — decoupling capacitor and sized supply"),
        ("the actuator slams into its stop", "unbounded command — software limits + mechanical limit switch"),
    ],
}


def cm_conception(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = CM.tirer(rng, lang)
    endurance = choisir(rng, [24, 48, 72])
    charge = choisir(rng, [100, 110, 120])
    if lang == "fr":
        instruction = f"Conçois {s['machine']} avec {s['capteur']}, pour un environnement : {s['environnement']}."
        output = (
            f"1) Spécifications : charge utile, vitesse, précision cible, environnement ({s['environnement']}) ;\n"
            f"2) Architecture : {s['capteur']} → conditionneur → microcontrôleur → actionneurs, watchdog matériel ;\n"
            f"3) Sécurité : arrêt d'urgence accessible, limites logicielles ET mécaniques, démarrage en état sûr ;\n"
            f"4) Essais : à vide, à charge nominale, brève à {charge} %, puis {endurance} h d'endurance avec journal des dérives.\n"
            f"Un prototype qui survit à l'environnement réel vaut dix démos sur le bureau."
        )
    else:
        instruction = f"Design {s['machine']} with a {s['capteur']}, for this environment: {s['environnement']}."
        output = (
            f"1) Specifications: payload, speed, target accuracy, environment ({s['environnement']}) ;\n"
            f"2) Architecture: {s['capteur']} → conditioner → microcontroller → actuators, hardware watchdog ;\n"
            f"3" f") Safety: reachable emergency stop, software AND mechanical limits, power-on in safe state ;\n"
            f"4" f") Tests: no-load, rated load, brief {charge}% load, then {endurance}h endurance with drift journal.\n"
            f"A prototype that survives the real environment beats ten desk demos."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "conception_machine",
        "safety_label": "sans_objet",
        "machine": s["machine"],
        "capteur": s["capteur"],
        "essais": {"charge_pct": charge, "endurance_h": endurance},
    }


def cm_depannage(rng: random.Random, lang: str, ctx: dict) -> dict:
    smp, cause = choisir(rng, CM_SYMPTOMES[lang])
    mesures = nombre(rng, 2, 5)
    if lang == "fr":
        instruction = f"Dépannage : {smp}."
        output = (
            f"Cause probable : {cause}.\n"
            f"Protocole : mesurer AVANT de remplacer (multimètre/oscillo), une variable à la fois, "
            f"{mesures} essais consignés ; quand le symptôme disparaît, le provoquer volontairement une fois "
            f"pour valider la cause racine — sinon ce n'était pas la bonne."
        )
    else:
        instruction = f"Troubleshooting: {smp}."
        output = (
            f"Likely cause: {cause}.\n"
            f"Protocol: measure BEFORE replacing (multimeter/scope), one variable at a time, "
            f"{mesures} logged trials; when the symptom disappears, trigger it deliberately once "
            f"to validate the root cause — otherwise that wasn't it."
        )
    return {
        "instruction": instruction,
        "input": smp,
        "output": output,
        "task_type": "depannage_machine",
        "safety_label": "sans_objet",
        "symptome": smp,
    }


def cm_programmation(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = CM.tirer(rng, lang)
    periode = choisir(rng, [50, 100, 200])
    kp = choisir(rng, [0.4, 0.5, 0.6])
    if lang == "fr":
        instruction = f"Logique de contrôle stable pour {s['machine']} (boucle {periode} ms)."
        output = (
            f"PID discrétisé (T={periode} ms) : Kp≈{kp} de la consigne sans dépassement, Ki anti-windup borné, "
            f"Kd filtré (moyenne 3 échantillons).\n"
            f"Garde-fous : consigne max matérielle, coupure si le {s['capteur']} lit hors plage 3 cycles, "
            f"mode dégradé tout-ou-rien si divergence.\n"
            f"Journal : consigne, mesure, sortie PID toutes les secondes."
        )
    else:
        instruction = f"Stable control logic for {s['machine']} ({periode} ms loop)."
        output = (
            f"Discretized PID (T={periode} ms): Kp≈{kp} of setpoint without overshoot, clamped anti-windup Ki, "
            f"filtered Kd (3-sample average).\n"
            f"Safeguards: hardware max setpoint, shutdown if the {s['capteur']} reads out of range 3 cycles, "
            f"bang-bang degraded mode on divergence.\n"
            f"Log: setpoint, measurement, PID output every second."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "programmation_controle",
        "safety_label": "sans_objet",
        "controle": {"type": "PID", "periode_ms": periode, "kp": kp},
    }


# ─────────────────────────────────────────────────────────────────────────────
# 8. CYBERSÉCURITÉ (défensive)
# ─────────────────────────────────────────────────────────────────────────────

CS = Lex(
    scenario={
        "fr": ["tentative de connexion par force brute détectée", "pièce jointe suspecte signalée",
               "pic de trafic sortant anormal", "vulnérabilité critique publiée sur un composant utilisé",
               "compte administrateur connecté à une heure inhabituelle"],
        "en": ["brute-force login attempt detected", "suspicious attachment reported",
               "abnormal outbound traffic spike", "critical CVE published for a component in use",
               "admin account signed in at an unusual hour"],
    },
    actif={
        "fr": ["le serveur de fichiers", "le poste comptable", "le portail client", "la sauvegarde locale"],
        "en": ["the file server", "the accounting workstation", "the customer portal", "the local backup"],
    },
    ressource={
        "fr": ["le pare-feu", "le VPN", "les boîtes mail", "le Wi-Fi invités",
               "les sauvegardes", "les mots de passe partagés"],
        "en": ["the firewall", "the VPN", "mailboxes", "the guest Wi-Fi",
               "backups", "shared passwords"],
    },
    equipe={
        "fr": ["sans équipe IT dédiée", "avec un stagiaire IT", "avec un prestataire externe",
               "avec une petite équipe interne"],
        "en": ["with no dedicated IT team", "with one IT intern", "with an external provider",
               "with a small internal team"],
    },
)

CS_DELAI = {
    "fr": ["dans l'heure", "sous 24 h", "dans la semaine"],
    "en": ["within the hour", "under 24h", "within the week"],
}


def cs_incident(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = CS.tirer(rng, lang)
    delai = choisir(rng, CS_DELAI[lang])
    if lang == "fr":
        instruction = (
            f"Réaction défensive : {s['scenario']} (périmètre : {s['actif']}, "
            f"à protéger via {s['ressource']}) — structure {s['equipe']}. Que faire {delai} ?"
        )
        output = (
            f"Phases (priorité : préserver les preuves) :\n"
            f"1) CONTENIR — isoler {s['actif']} sans détruire les traces ;\n"
            f"2) OBSERVER — logs, horodatages, indicateurs dans un journal horodaté ;\n"
            f"3) ÉRADIQUER — couper l'accès, révoquer les secrets exposés, patcher ({delai}) ;\n"
            f"4) RECONSTRUIRE depuis des sauvegardes vérifiées si nécessaire ;\n"
            f"5) RETOUR D'EXPÉRIENCE sous 7 jours : chronologie + les 2 mesures qui réduiraient d'abord le risque.\n"
            f"Éthique : défense de son propre système ou d'un système autorisé — jamais au-delà."
        )
    else:
        instruction = (
            f"Defensive response: {s['scenario']} (scope: {s['actif']}, "
            f"protect via {s['ressource']}) — {s['equipe']}. What to do {delai}?"
        )
        output = (
            f"Phases (priority: preserve evidence):\n"
            f"1) CONTAIN — isolate {s['actif']} without destroying traces ;\n"
            f"2) OBSERVE — logs, timestamps, indicators into a timestamped journal ;\n"
            f"3" f") ERADICATE — cut access, revoke exposed secrets, patch ({delai}) ;\n"
            f"4" f") REBUILD from verified backups if needed ;\n"
            f"5" f") LESSONS LEARNED under 7 days: timeline + the 2 measures cutting risk first.\n"
            f"Ethics: defense of your own or an authorized system — never beyond."
        )
    return {
        "instruction": instruction,
        "input": s["scenario"],
        "output": output,
        "task_type": "reponse_incident",
        "safety_label": "recherche_defensive",
        "scenario": s["scenario"],
        "delai": delai,
        "phases": ["contenir", "observer", "eradiquer", "reconstruire", "rex"],
    }


def cs_hygiene(rng: random.Random, lang: str, ctx: dict) -> dict:
    theme, conseil = choisir(rng, {
        "fr": [
            ("mots de passe et MFA", "MFA partout sur les comptes à risque, gestionnaire de mots de passe, secrets jamais en clair"),
            ("sauvegardes résilientes", "règle 3-2-1, une copie hors ligne, test de restauration mensuel CHRONOMÉTRÉ"),
            ("mises à jour des dépendances", "inventaire exact (SBOM), veille CVE, délai de patch par criticité"),
            ("accès au réseau", "segments séparés, principe du moindre privilège, journal des accès administrateurs"),
        ],
        "en": [
            ("passwords and MFA", "MFA on all risky accounts, password manager, secrets never in plain code"),
            ("resilient backups", "3-2-1 rule, one offline copy, monthly TIMED restore test"),
            ("dependency updates", "exact inventory (SBOM), CVE watch, patch delay by severity"),
            ("network access", "separated segments, least privilege, admin access journal"),
        ],
    }[lang])
    s = CS.tirer(rng, lang)
    perimetre = nombre(rng, 20, 100, 10)
    if lang == "fr":
        instruction = (
            f"Règle d'hygiène numérique sur « {theme} » ({s['ressource']} concerné, "
            f"{s['equipe']}) — {perimetre} % du parc en premier."
        )
        output = (
            f"Règle « {theme} » : {conseil}.\n"
            f"Mise en œuvre : mesurer l'état actuel, appliquer d'abord aux {perimetre} % les plus à risque, "
            f"puis automatiser le contrôle (audit hebdomadaire) pour que la règle tienne sans héroïsme."
        )
    else:
        instruction = (
            f"Digital hygiene rule on \"{theme}\" ({s['ressource']} involved, "
            f"{s['equipe']}) — riskiest {perimetre}% first."
        )
        output = (
            f"Rule \"{theme}\": {conseil}.\n"
            f"Rollout: measure current state, apply to the riskiest {perimetre}% first, "
            f"then automate the check (weekly audit) so the rule holds without heroics."
        )
    return {
        "instruction": instruction,
        "input": theme,
        "output": output,
        "task_type": "hygiene_numerique",
        "safety_label": "recherche_defensive",
        "theme": theme,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 9. HACKER (CTF éducatif / analyse défensive)
# ─────────────────────────────────────────────────────────────────────────────

HK = Lex(
    categorie={
        "fr": ["web", "crypto", "forensique", "stéganographie", "réseaux", "reverse basique"],
        "en": ["web", "crypto", "forensics", "steganography", "network", "basic reversing"],
    },
    niveau={"fr": ["facile", "moyen", "difficile"], "en": ["easy", "medium", "hard"]},
    env={
        "fr": ["une VM de challenge locale", "une plateforme CTF hors-ligne",
               "un fichier fourni par l'organisateur", "un serveur d'exercice isolé",
               "une image disque d'entraînement", "un conteneur jetable"],
        "en": ["a local challenge VM", "an offline CTF platform",
               "an organizer-provided file", "an isolated practice server",
               "a training disk image", "a disposable container"],
    },
    objectif={
        "fr": ["comprendre la faille", "documenter la correction", "entraîner un collègue",
               "automatiser la détection"],
        "en": ["understand the flaw", "document the fix", "train a colleague",
               "automate detection"],
    },
)

HK_LECONS = {
    "fr": [
        "un défaut de validation d'entrée ferme toujours plus de portes qu'un pare-feu",
        "un secret codé en dur est un secret donné",
        "l'obscurité n'est pas la sécurité : ce qui est caché doit aussi être correct",
        "les logs qu'on n'a jamais relus ne protègent de rien",
    ],
    "en": [
        "an input-validation flaw closes more doors than any firewall",
        "a hard-coded secret is a given-away secret",
        "obscurity is not security: what is hidden must also be correct",
        "logs nobody ever reads protect nothing",
    ],
}


def hk_ctf(rng: random.Random, lang: str, ctx: dict) -> dict:
    s = HK.tirer(rng, lang)
    lecon = choisir(rng, HK_LECONS[lang])
    if lang == "fr":
        instruction = (
            f"Méthode de résolution pédagogique d'un CTF {s['categorie']} (niveau {s['niveau']}), "
            f"sur {s['env']}, objectif : {s['objectif']} — environnement d'exercice isolé uniquement."
        )
        output = (
            f"Démarche ({s['categorie']}, {s['niveau']}) :\n"
            f"1) COMPRENDRE l'énoncé, inventorier ce qui est fourni ;\n"
            f"2) OBSERVER — outils passifs d'abord, notes systématiques ;\n"
            f"3) FORMULER une hypothèse didactique (chiffrement faible, fuite d'information, validation manquante) "
            f"et la tester DANS LE CHALLENGE uniquement ;\n"
            f"4) VALIDER le flag puis rédiger la leçon défensive : quel défaut de conception réel ce challenge "
            f"illustre-t-il, quel correctif de production le referme.\n"
            f"Leçon retenue : {lecon}.\n"
            f"Éthique : aucune cible réelle, write-ups partagés avec la leçon."
        )
    else:
        instruction = (
            f"Pedagogical walkthrough of a {s['categorie']} CTF ({s['niveau']} level), "
            f"on {s['env']}, goal: {s['objectif']} — isolated practice environment only."
        )
        output = (
            f"Walkthrough ({s['categorie']}, {s['niveau']}):\n"
            f"1) UNDERSTAND the brief, inventory what is provided ;\n"
            f"2) OBSERVE — passive tools first, systematic notes ;\n"
            f"3" f") FORM one didactic hypothesis (weak crypto, info leak, missing validation) and test it "
            f"INSIDE THE CHALLENGE only ;\n"
            f"4" f") VALIDATE the flag then write the defensive lesson: which real design flaw, which production fix.\n"
            f"Lesson: {lecon}.\n"
            f"Ethics: no real target, write-ups shared with the lesson."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "ctf_educatif",
        "safety_label": "ctf_educatif",
        "categorie": s["categorie"],
        "niveau": s["niveau"],
    }


def hk_analyse_defensive(rng: random.Random, lang: str, ctx: dict) -> dict:
    motif = choisir(rng, {
        "fr": ["injection SQL", "XSS réfléchi", "chemin de fichier non contrôlé", "secret en dur", "désérialisation non vérifiée"],
        "en": ["SQL injection", "reflected XSS", "unvalidated file path", "hard-coded secret", "unchecked deserialization"],
    }[lang])
    cas = nombre(rng, 5, 30, 5)
    if lang == "fr":
        instruction = (
            f"Analyse défensive de MON code : traque les motifs de {motif} "
            f"(code autorisé, propriétaire ; objectif : {HK.slots['objectif'][lang][0]})."
        )
        output = (
            f"Chasse au {motif} dans son propre code :\n"
            f"1) Inventorier les points d'entrée (grep sur les constructions suspectes) — {cas} candidats à vérifier ;\n"
            f"2) Pour chaque point : requêtes préparées / échappement systématique / typage des paramètres ;\n"
            f"3) Test automatisé avec charge BÉNIGNE sur chaque entrée exposée, rejet propre exigé ;\n"
            f"4) Contrôle CI pour que le défaut ne revienne pas.\n"
            f"Cadre : uniquement son propre code ou un système autorisé — l'objectif est de FERMER la faille."
        )
    else:
        instruction = (
            f"Defensive analysis of MY code: hunt {motif} patterns "
            f"(authorized, owned code; goal: {HK.slots['objectif'][lang][1]})."
        )
        output = (
            f"Hunting {motif} in your own code:\n"
            f"1) Inventory entry points (grep suspicious constructions) — {cas} candidates to check ;\n"
            f"2) Per point: prepared statements / systematic escaping / typed parameters ;\n"
            f"3" f") Automated test with BENIGN payload on every exposed input, clean rejection required ;\n"
            f"4" f") CI check so the flaw never returns.\n"
            f"Scope: your own or authorized code only — the goal is to CLOSE the flaw."
        )
    return {
        "instruction": instruction,
        "input": "",
        "output": output,
        "task_type": "analyse_defensive",
        "safety_label": "recherche_defensive",
        "motif": motif,
    }


DOMAINES_INGENIERIE = [
    SpecDomaine(
        id="developpement_web",
        nom_fr="développement web",
        nom_en="web development",
        description_fr=(
            "Implémentations, débogage et conception d'API — plans concrets "
            "(structure, états UI, validation double, accessibilité, poids cible, "
            "tests) sous contraintes réalistes (mobile-first, 3G, clavier seul)."
        ),
        description_en=(
            "Implementations, debugging and API design — concrete plans "
            "(structure, UI states, dual validation, accessibility, payload "
            "target, tests) under realistic constraints (mobile-first, 3G, "
            "keyboard only)."
        ),
        mots_cles=["web", "html", "css", "javascript", "react", "api", "site"],
        taches=[
            ("implementation_web", 0.40, dw_fonctionnalite, dw_fonctionnalite),
            ("debug_web", 0.30, dw_debug, dw_debug),
            ("conception_api", 0.30, dw_api, dw_api),
        ],
    ),
    SpecDomaine(
        id="test",
        nom_fr="test",
        nom_en="testing",
        description_fr=(
            "Plans de test, cas limites donnée/quand/alors et stratégies CI — "
            "pyramide, couvertures cibles explicites, flaky-quarantine, règle "
            "« chaque bug devient un test »."
        ),
        description_en=(
            "Test plans, given/when/then edge cases and CI strategies — "
            "pyramid, explicit coverage targets, flaky-quarantine, the \"every "
            "bug becomes a test\" rule."
        ),
        mots_cles=["test", "tests", "qualite", "couverture", "ci", "qa"],
        taches=[
            ("plan_test", 0.35, te_plan, te_plan),
            ("cas_limite", 0.35, te_cas_limite, te_cas_limite),
            ("ci_tests", 0.30, te_automatisation, te_automatisation),
        ],
    ),
    SpecDomaine(
        id="construction_machines",
        nom_fr="construction des machines",
        nom_en="machine building",
        description_fr=(
            "Conception, dépannage et contrôle de machines réelles — specs, "
            "architecture capteur→contrôleur→actionneur, sécurité redondante, "
            "essais mesurés (charge %, endurance h)."
        ),
        description_en=(
            "Design, troubleshooting and control of real machines — specs, "
            "sensor→controller→actuator architecture, redundant safety, "
            "measured tests (load %, endurance h)."
        ),
        mots_cles=["machine", "robot", "moteur", "capteur", "arduino", "pid"],
        taches=[
            ("conception_machine", 0.35, cm_conception, cm_conception),
            ("depannage_machine", 0.30, cm_depannage, cm_depannage),
            ("programmation_controle", 0.35, cm_programmation, cm_programmation),
        ],
    ),
    SpecDomaine(
        id="cybersecurite",
        nom_fr="cybersécurité",
        nom_en="cybersecurity",
        description_fr=(
            "Réponse aux incidents (contenir/observer/éradiquer/reconstruire/REX) "
            "et hygiène numérique progressive — strictement défensif, preuves "
            "préservées, délais explicites."
        ),
        description_en=(
            "Incident response (contain/observe/eradicate/rebuild/lessons) and "
            "progressive digital hygiene — strictly defensive, evidence "
            "preserved, explicit deadlines."
        ),
        mots_cles=["securite", "cyber", "incident", "vulnerabilite", "patch"],
        safety_label="recherche_defensive",
        taches=[
            ("reponse_incident", 0.55, cs_incident, cs_incident),
            ("hygiene_numerique", 0.45, cs_hygiene, cs_hygiene),
        ],
    ),
    SpecDomaine(
        id="hacker",
        nom_fr="hacker (éthique / CTF)",
        nom_en="hacker (ethical / CTF)",
        description_fr=(
            "CTF éducatifs et analyse défensive de son propre code — "
            "strictement pédagogique, environnement isolé, leçon défensive "
            "systématique, aucune cible réelle."
        ),
        description_en=(
            "Educational CTFs and defensive analysis of one's own code — "
            "strictly pedagogical, isolated environment, systematic defensive "
            "lesson, no real target."
        ),
        mots_cles=["ctf", "hacker", "flag", "challenge", "pentest"],
        safety_label="ctf_educatif",
        taches=[
            ("ctf_educatif", 0.50, hk_ctf, hk_ctf),
            ("analyse_defensive", 0.50, hk_analyse_defensive, hk_analyse_defensive),
        ],
    ),
]
