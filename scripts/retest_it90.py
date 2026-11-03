#!/usr/bin/env python3
"""Harnais de re-test CONNECTÉ en production (it.90, Job 478451).

Reconstruit le harnais it.88 (jamais committé) et l'étend :
  - compte jetable créé via /api/auth/r2/signup (schéma réel : email +
    username distincts), login par email, cookie de session ;
  - conversation créée via /api/workspace/conversations ;
  - questions envoyées sur /api/.../messages/stream (NDJSON, concat delta) ;
  - question 1-5 : couleurs it.89 (Kaggle exact, repli palette, propriétés,
    mélange additif, complémentaire) ;
  - question 6+ : multimodal it.90 (assets réels committés — activé si
    QUESTIONS env contient "mm").

Identifiants écrits dans /tmp uniquement (éphémères), jamais affichés.
Usage : python3 scripts/retest_it90.py [--base https://gen3ia.online]
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import uuid

BASE = "https://gen3ia.online"
TIMEOUT = 120

# ─── Questions calibrées sur les modules locaux (source de vérité) ────────
QUESTIONS_COULEURS = [
    {
        "id": "Q1-kaggle-exact",
        "q": "Quelle couleur porte le code hexa #0048BA ?",
        "attendus": ["Absolute zero"],
    },
    {
        "id": "Q2-repli-palette",
        "q": "Quelle couleur porte le code hexa #7FFF00 ?",
        "attendus": ["vert anis"],
    },
    {
        "id": "Q3-propriete",
        "q": "La couleur #0000FF est-elle chaude ou froide, et claire, sombre ou moyenne ?",
        "attendus": ["froide", "sombre"],
    },
    {
        "id": "Q4-melange-lumiere",
        "q": "On mélange de la lumière rouge (#FF0000) et de la lumière verte (#00FF00). Quelle couleur obtient-on ?",
        "attendus": ["#FFFF00", "jaune"],
    },
    {
        "id": "Q5-complementaire",
        "q": "Quelle est la couleur complémentaire de #FF0000 ?",
        "attendus": ["#00FFFF", "cyan"],
    },
]

QUESTIONS_MM = [
    {
        "id": "M1-image-analyse",
        # id RÉEL du module multimodal-it90 (kext90_image_014 → image_013.jpg
        # : chien + lit + livres — vérifié visuellement au téléchargement)
        "q": "Que contient l'image kext90_image_014 ? Décris-la.",
        "attendus": ["chien", "lit"],
    },
    {
        "id": "M2-audio-voix",
        # id RÉEL : kext90_audio_002 → audio_001.wav — transcription FLEURS
        # officielle attendue (vérifiée dans var-copie/assets.json)
        "q": "Que contient l'enregistrement audio kext90_audio_002 ?",
        "attendus": ["déroger aux lois fiscales"],
    },
]


def http(method: str, url: str, payload: dict | None = None, cookie: str | None = None,
         headers: dict | None = None, stream_reader=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "retest-it90/1.0")
    if cookie:
        req.add_header("Cookie", cookie)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    resp = urllib.request.urlopen(req, timeout=TIMEOUT)
    set_cookie = resp.headers.get("Set-Cookie", "")
    if stream_reader is not None:
        return resp, stream_reader(resp), set_cookie
    body = resp.read().decode("utf-8", errors="replace")
    return resp, body, set_cookie


def extraire_cookie_session(set_cookie: str) -> str:
    """Récupère le cookie de session (première paire nom=valeur)."""
    m = re.search(r"([A-Za-z0-9._-]+=[^;]+)", set_cookie)
    return m.group(1) if m else ""


def lire_stream(resp) -> str:
    """Concatène les fragments delta du flux NDJSON."""
    texte = ""
    for brut in resp:
        ligne = brut.decode("utf-8", errors="replace").strip()
        if not ligne:
            continue
        try:
            ev = json.loads(ligne)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict):
            if isinstance(ev.get("delta"), str):
                texte += ev["delta"]
            elif ev.get("type") == "final" and isinstance(ev.get("texte"), str):
                texte = texte or ev["texte"]
            elif isinstance(ev.get("content"), str) and ev.get("type") == "final":
                texte = texte or ev["content"]
    return texte


def poser_question(cookie: str, conv_id: str, question: str) -> str:
    url = f"{BASE}/api/workspace/conversations/{conv_id}/messages/stream"
    _resp, texte, _sc = http("POST", url, {"message": question}, cookie=cookie,
                             stream_reader=lire_stream)
    return texte.strip()


def main() -> int:
    global BASE
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--avec-mm", action="store_true", help="ajoute les questions multimodales it.90")
    args = ap.parse_args()
    BASE = args.base.rstrip("/")

    suffixe = uuid.uuid4().hex[:10]
    email = f"retest-it90-{suffixe}@example.com"
    username = f"rt90_{suffixe[:8]}"
    mot_de_passe = f"Rt90!{uuid.uuid4().hex[:16]}"

    with open("/tmp/creds_it90.txt", "w") as f:
        f.write(f"{email}\n{username}\n{mot_de_passe}\n")

    # 1. inscription
    _r, body, sc = http("POST", f"{BASE}/api/auth/r2/signup", {
        "email": email, "password": mot_de_passe,
        "firstName": "Retest", "lastName": "It90", "username": username,
    })
    cookie = extraire_cookie_session(sc)
    if not cookie:
        print(f"ÉCHEC signup : aucun cookie de session ({body[:200]})")
        return 2
    print(f"signup ok (compte jetable {username})")

    # 2. conversation
    _r, body, _sc = http("POST", f"{BASE}/api/workspace/conversations",
                         {"title": "Re-test it.90 couleurs + multimodal"}, cookie=cookie)
    conv_id = json.loads(body).get("conversation", {}).get("id", "")
    if not conv_id:
        print(f"ÉCHEC création conversation : {body[:200]}")
        return 2
    print(f"conversation {conv_id} créée")

    questions = list(QUESTIONS_COULEURS)
    if args.avec_mm:
        questions += QUESTIONS_MM

    # 3. questions
    score, total = 0, len(questions)
    resultats = []
    for item in questions:
        t0 = time.time()
        try:
            reponse = poser_question(cookie, conv_id, item["q"])
        except Exception as exc:  # noqa: BLE001
            reponse = f"<erreur: {exc}>"
        duree = time.time() - t0
        manquants = [a for a in item["attendus"] if a.lower() not in reponse.lower()]
        ok = not manquants and len(reponse) > 0
        score += int(ok)
        extrait = reponse[:220].replace("\n", " ")
        print(f"{'✅' if ok else '❌'} {item['id']} ({duree:.1f}s) — manquants: {manquants or 'aucun'}")
        print(f"   ↳ {extrait}")
        resultats.append({"id": item["id"], "ok": ok, "manquants": manquants,
                          "dureeS": round(duree, 1), "reponse": reponse[:600]})
        with open("/tmp/cookies_it90.txt", "w") as f:
            f.write(cookie)
        time.sleep(1.0)

    print(f"\nSCORE : {score}/{total}")
    with open("/tmp/retest_it90_resultat.json", "w") as f:
        json.dump({"base": BASE, "score": score, "total": total, "resultats": resultats}, f,
                  ensure_ascii=False, indent=2)
    return 0 if score == total else 1


if __name__ == "__main__":
    sys.exit(main())
