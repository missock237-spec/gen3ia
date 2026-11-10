#!/usr/bin/env python3
"""Mise à jour du secret GitHub ZAI_CONFIG_JSON_B64 — canal chiffré officiel
(libsodium sealed box avec la clé publique du dépôt). La config vient de
/etc/.z-ai-config (plateforme) + hfToken fourni par la mission. AUCUN secret
n'est imprimé ni journalisé ; le corps transmis est chiffré côté client.

Usage: python3 scripts/maj-secret-zai.py <hf_token>
"""
import base64
import json
import re
import subprocess
import sys
import urllib.request

from nacl import encoding, public

REPO_URL = subprocess.run(["git", "config", "--get", "remote.origin.url"],
                          capture_output=True, text=True).stdout.strip()
m = re.search(r"https://([^@/]+)@", REPO_URL)
TOKEN = m.group(1).split(":")[-1]
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}
BASE = "https://api.github.com/repos/missock237-spec/gen3ia"

def api(url: str, data: dict | None = None) -> urllib.request.Request:
    req = urllib.request.Request(url, headers=H,
                                 data=json.dumps(data).encode() if data else None,
                                 method="PUT" if data else "GET")
    return req

# 1. clé publique du dépôt
with urllib.request.urlopen(api(f"{BASE}/actions/secrets/public-key"), timeout=60) as r:
    pk = json.load(r)

# 2. config = plateforme (/etc/.z-ai-config) + hfToken (mission)
config = json.loads(open("/etc/.z-ai-config").read())
hf_token = sys.argv[1] if len(sys.argv) > 1 else ""
if hf_token:
    config["hfToken"] = hf_token
config_b64 = base64.b64encode(json.dumps(config, separators=(",", ":")).encode()).decode()

# 3. chiffrement sealed box
cle_pub = public.PublicKey(pk["key"].encode(), encoding.Base64Encoder())
scellee = public.SealedBox(cle_pub).encrypt(config_b64.encode())
chiffre_b64 = base64.b64encode(scellee).decode()

# 4. PUT du secret
req = api(f"{BASE}/actions/secrets/ZAI_CONFIG_JSON_B64",
          {"encrypted_value": chiffre_b64, "key_id": pk["key_id"]})
with urllib.request.urlopen(req, timeout=60) as r:
    print(f"secret ZAI_CONFIG_JSON_B64 mis à jour (HTTP {r.status}) — "
          f"hfToken={'présent' if hf_token else 'absent'}, "
          f"champs config: {sorted(k for k in config if k != 'apiKey' and k != 'token')}")
