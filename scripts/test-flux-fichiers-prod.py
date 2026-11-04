#!/usr/bin/env python3
"""HARNAIS DE TEST PRODUCTION — flux complet des pièces jointes (Job 478451).

Reproduit EXACTEMENT le canal du client nova-chat :
  A. POST /api/storage/permanent/session  → partUrls presignées
  B. PUT du fichier directement chez R2 (1 partie)
  C. POST /api/storage/permanent/commit   → { file: { path, … } }
  D. POST /api/files/import               → { file: { id (fileId), kind, … } }
  E. POST /api/workspace/conversations/<id>/messages/stream
     { message, attachments: [{filename, path, contentType, sizeBytes, fileId, …}] }
     → le moteur Gen3 doit charger le contenu et citer le marqueur secret.

Le marqueur secret (PONG-<rand>) est écrit DANS le fichier : si la réponse
de Gen3 ne le contient pas, le contenu n'a pas atteint le prompt.

Usage : python3 scripts/test-flux-fichiers-prod.py [--base https://gen3ia.online]
"""

import argparse
import json
import re
import secrets
import sys
import time
import urllib.request

BASE = "https://gen3ia.online"
TIMEOUT = 240


def http(method, url, payload=None, cookie=None, headers=None, raw_body=None):
    data = raw_body if raw_body is not None else (
        json.dumps(payload).encode("utf-8") if payload is not None else None
    )
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "flux-fichiers-prod/1.0")
    if payload is not None or raw_body is not None:
        if not (headers or {}).get("Content-Type"):
            req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    resp = urllib.request.urlopen(req, timeout=TIMEOUT)
    set_cookie = resp.headers.get("Set-Cookie", "")
    body = resp.read().decode("utf-8", errors="replace")
    return resp, body, set_cookie


def extraire_cookie(set_cookie):
    m = re.search(r"([A-Za-z0-9._-]+=[^;]+)", set_cookie)
    return m.group(1) if m else ""


def lire_stream(resp):
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
            elif ev.get("type") == "final" and isinstance(ev.get("texte") or ev.get("content"), str):
                texte = texte or ev["texte"] or ev["content"]
    return texte


def poser_question_stream(cookie, conv_id, corps):
    url = f"{BASE}/api/workspace/conversations/{conv_id}/messages/stream"
    req = urllib.request.Request(url, data=json.dumps(corps).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "flux-fichiers-prod/1.0")
    req.add_header("Cookie", cookie)
    resp = urllib.request.urlopen(req, timeout=TIMEOUT)
    return lire_stream(resp)


def main():
    global BASE
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    args = ap.parse_args()
    BASE = args.base.rstrip("/")

    suffixe = secrets.token_hex(4)
    email = f"flux-file-{suffixe}@example.com"
    username = f"fluxfile_{suffixe}"
    mot_de_passe = "Px9!flux" + secrets.token_hex(6)

    marqueur = f"PONG-{secrets.token_hex(4).upper()}"
    contenu = (
        "Rapport de test interne — ligne 1 : le mot de passe du trésor est "
        f"{marqueur} — ligne 2 : quatre-vingt-douze pommes — ligne 3 : fin."
    )

    etapes = []

    def etape(nom, ok, detail=""):
        etapes.append((nom, ok, detail))
        print(f"{'✅' if ok else '❌'} {nom}{(' — ' + detail) if detail else ''}")
        return ok

    # 1) signup
    try:
        _r, _b, sc = http("POST", f"{BASE}/api/auth/r2/signup", {
            "email": email, "password": mot_de_passe, "username": username,
            "firstName": "Flux", "lastName": "Test",
        })
        cookie = extraire_cookie(sc)
        ok = bool(cookie)
        etape("A0 signup + cookie session", ok, "cookie reçu" if ok else f"set-cookie={sc[:120]}")
        if not ok:
            return 1
    except Exception as exc:  # noqa: BLE001
        etape("A0 signup", False, repr(exc))
        return 1

    # 2) conversation
    try:
        _r, body, _ = http("POST", f"{BASE}/api/workspace/conversations",
                           {"title": "Test flux fichiers"}, cookie=cookie)
        conv_id = json.loads(body).get("conversation", {}).get("id")
        etape("A1 création conversation", bool(conv_id), conv_id or body[:120])
        if not conv_id:
            return 1
    except Exception as exc:  # noqa: BLE001
        etape("A1 création conversation", False, repr(exc))
        return 1

    filename = f"rapport-test-{suffixe}.txt"
    data = contenu.encode("utf-8")

    # A. session presignée
    try:
        _r, body, _ = http("POST", f"{BASE}/api/storage/permanent/session", {
            "files": [{"filename": filename, "contentType": "text/plain",
                       "sizeBytes": len(data)}],
        }, cookie=cookie)
        sessions = json.loads(body).get("sessions", [])
        session = sessions[0] if sessions else None
        etape("B1 session presignée", bool(session and session.get("partUrls")),
              "1 partUrl" if session else body[:160])
        if not session:
            return 1
    except Exception as exc:  # noqa: BLE001
        etape("B1 session presignée", False, repr(exc))
        return 1

    # B. PUT chez R2
    try:
        part_url = session["partUrls"][0]["url"]
        resp = urllib.request.urlopen(
            urllib.request.Request(part_url, data=data, method="PUT",
                                   headers={"Content-Type": "text/plain"}),
            timeout=120,
        )
        etag = resp.headers.get("ETag") or resp.headers.get("etag")
        etag = (etag or "").replace('"', "")
        etape("B2 dépôt R2 (PUT part)", bool(etag), f"etag={etag[:24]}" if etag else "SANS ETag (CORS ExposeHeaders ?)")
        if not etag:
            return 1
    except Exception as exc:  # noqa: BLE001
        etape("B2 dépôt R2 (PUT part)", False, repr(exc))
        return 1

    # C. commit
    upload_id = session["uploadId"]
    try:
        _r, body, _ = http("POST", f"{BASE}/api/storage/permanent/commit", {
            "uploadId": upload_id,
            "parts": [{"partNumber": 1, "etag": etag}],
        }, cookie=cookie)
        fichier = json.loads(body).get("file", {})
        path = fichier.get("path", "")
        etape("C commit multipart", bool(path),
              f"path={path}" if path else f"réponse sans file.path : {body[:200]}")
        if not path:
            return 1
    except Exception as exc:  # noqa: BLE001
        etape("C commit multipart", False, repr(exc))
        return 1

    # D. import (conversion + persistance importedFiles)
    try:
        _r, body, _ = http("POST", f"{BASE}/api/files/import", {
            "path": path, "filename": filename,
            "contentType": "text/plain", "sizeBytes": len(data),
        }, cookie=cookie)
        fichier_importe = json.loads(body).get("file", {})
        file_id = fichier_importe.get("id", "")
        kind = fichier_importe.get("kind", "?")
        char_count = fichier_importe.get("charCount", "?")
        etape("D import converti (fileId)", bool(file_id),
              f"fileId={file_id} kind={kind} charCount={char_count}" if file_id else body[:200])
    except Exception as exc:  # noqa: BLE001
        etape("D import converti (fileId)", False, repr(exc))
        file_id = ""

    # E. tour de conversation avec attachment complet
    attachment = {
        "filename": filename,
        "path": path,
        "contentType": "text/plain",
        "sizeBytes": len(data),
    }
    if file_id:
        attachment["fileId"] = file_id
        if fichier_importe.get("kind"):
            attachment["fileKind"] = fichier_importe["kind"]
        if fichier_importe.get("charCount") is not None:
            attachment["charCount"] = fichier_importe["charCount"]
        if fichier_importe.get("rowCount") is not None:
            attachment["rowCount"] = fichier_importe["rowCount"]

    question = (
        "Lis le fichier joint et réponds UNIQUEMENT avec la phrase exacte qui "
        "commence par « le mot de passe du trésor est » (copie-la mot pour mot)."
    )
    corps = {
        "message": question,
        "attachments": [attachment],
        "timezone": "Europe/Paris",
    }
    reponse = ""
    try:
        t0 = time.time()
        reponse = poser_question_stream(cookie, conv_id, corps)
        duree = time.time() - t0
        etape("E tour de conversation (stream)", True, f"{duree:.1f}s, {len(reponse)} car.")
    except Exception as exc:  # noqa: BLE001
        etape("E tour de conversation (stream)", False, repr(exc))

    trouve = marqueur in reponse
    etape("F GEN3 a reçu et analysé le contenu du fichier", trouve,
          f"marqueur {marqueur} " + ("PRÉSENT dans la réponse" if trouve else "ABSENT de la réponse"))

    print("\n--- réponse Gen3 (tronquée à 600 car.) ---")
    print(reponse[:600] if reponse else "(vide)")

    # diagnostic en cas d'échec F : tour SANS attachment comme témoin
    if not trouve:
        try:
            corps2 = {"message": "Réponds en une ligne : vois-tu une pièce jointe dans ce message ? (oui/non)",
                      "timezone": "Europe/Paris"}
            reponse2 = poser_question_stream(cookie, conv_id, corps2)
            print("\n--- témoin sans attachment ---")
            print(reponse2[:300])
        except Exception:  # noqa: BLE001
            pass

    score = sum(1 for _, ok, _ in etapes if ok)
    print(f"\nSCORE : {score}/{len(etapes)}")
    return 0 if trouve else 1


if __name__ == "__main__":
    sys.exit(main())
