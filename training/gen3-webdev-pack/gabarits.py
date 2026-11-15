# -*- coding: utf-8 -*-
"""
GABARITS DE RÉPONSES WEB-DEV — blocs de code RÉELS paramétrés par la stack.

Chaque famille de stack expose : le schéma de données, la route API, le
composant d'interface, le test et le déploiement — tous paramétrés par
l'entité métier de la niche (modèle, champs). Les gabarits de tâches
(creation_saas, api_backend, auth_securite…) assemblent ces blocs en une
réponse structurée, exploitable telle quelle par un développeur.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

# ---------------------------------------------------------------------------
# Familles de stacks → comportement des blocs de code.
# ---------------------------------------------------------------------------

FAMILLE_PAR_STACK: Dict[str, str] = {
    "next-prisma": "next",
    "next-r2": "next",
    "remix-prisma": "next",
    "react-express": "node",
    "angular-nestjs": "node",
    "go-react": "node",
    "node-vanilla": "node",
    "vue-laravel": "laravel",
    "php-symfony": "laravel",
    "rails-postgres": "laravel",
    "svelte-fastapi": "python",
    "flask-sqlalchemy": "python",
    "django-htmx": "django",
    "astro-tailwind": "statique",
}


def _champs_prisma(champs: List[Tuple[str, str, str, str]]) -> str:
    lignes = []
    for nom, typ, _fr, _en in champs:
        lignes.append(f"  {nom.replace(' ', '')} {typ}")
    return "\n".join(lignes)


def bloc_schema(famille: str, entite: str, champs: List[Tuple[str, str, str, str]]) -> str:
    """Schéma de données réel pour la famille de stack."""
    if famille == "next":
        return (
            "```prisma\n"
            "// schema.prisma — modèle métier principal\n"
            f"model {entite} {{\n"
            "  id        String   @id @default(cuid())\n"
            "  createdAt DateTime @default(now())\n"
            "  updatedAt DateTime @updatedAt\n"
            + _champs_prisma(champs) + "\n"
            "}\n"
            "```"
        )
    if famille in ("node", "laravel"):
        colonnes = ",\n  ".join(
            f"{nom.lower()} {'VARCHAR(255)' if typ.startswith('String') else ('BIGINT' if typ in ('Int', 'Float') else ('TIMESTAMPTZ' if 'DateTime' in typ else 'BOOLEAN'))}"
            + (" NULL" if typ.endswith("?") else " NOT NULL")
            for nom, typ, _fr, _en in champs
        )
        return (
            "```sql\n"
            f"-- migration : création de la table {entite.lower()}\n"
            f"CREATE TABLE {entite.lower()} (\n"
            "  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n"
            "  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n"
            "  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n"
            f"  {colonnes}\n"
            ");\n"
            "CREATE INDEX ON " + entite.lower() + " (created_at DESC);\n"
            "```"
        )
    if famille == "python":
        colonnes = "\n".join(
            f"    {nom.lower()} = Column({type_sqlalchemy})"
            + ("" if not typ.endswith("?") else ", nullable=True") + ")"
            for nom, typ, _fr, _en, type_sqlalchemy in [
                (nom, typ, fr, en,
                 "String" if typ.startswith("String")
                 else ("Integer" if typ in ("Int", "Float")
                       else ("DateTime" if "DateTime" in typ else "Boolean")))
                for nom, typ, fr, en in champs
            ]
        )
        return (
            "```python\n"
            "# models.py — modèle métier principal\n"
            f"class {entite}(Base):\n"
            "    __tablename__ = \"" + entite.lower() + "\"\n"
            "    id = Column(UUID, primary_key=True, default=uuid4)\n"
            "    created_at = Column(DateTime, default=datetime.utcnow)\n"
            + colonnes + "\n"
            "```"
        )
    if famille == "django":
        colonnes = "\n".join(
            f"    {nom.lower()} = models.{champ_django}"
            for nom, typ, _fr, _en, champ_django in [
                (nom, typ, fr, en,
                 ("CharField(max_length=255)" if typ.startswith("String")
                  else ("IntegerField()" if typ in ("Int", "Float")
                        else ("DateTimeField()" if "DateTime" in typ else "BooleanField()")))
                 + ("null=True, blank=True" if typ.endswith("?") else ""))
                for nom, typ, fr, en in champs
            ]
        )
        return (
            "```python\n"
            "# models.py — modèle métier principal\n"
            f"class {entite}(models.Model):\n"
            "    created_at = models.DateTimeField(auto_now_add=True)\n"
            "    updated_at = models.DateTimeField(auto_now=True)\n"
            + colonnes + "\n"
            "```"
        )
    # statique : JSON de structure
    exemple = ", ".join(f'"{nom.lower()}": "…"' for nom, _t, _fr, _en in champs)
    return (
        "```json\n"
        f"// data/{entite.lower()}.json — structure d'un enregistrement\n"
        "{ \"id\": \"…\", " + exemple + " }\n"
        "```"
    )


def bloc_api(famille: str, entite: str, langue: str) -> str:
    """Route API réelle (liste + création) pour la famille de stack."""
    route = "api/" + entite.lower()
    if langue == "fr":
        titre = f"Route API CRUD de {entite} (liste paginée + création validée)"
    else:
        titre = f"CRUD API route for {entite} (paginated list + validated creation)"
    if famille == "next":
        return (
            f"{titre} — `app/{route}/route.ts` :\n"
            "```ts\n"
            "import { NextRequest, NextResponse } from \"next/server\";\n"
            "import { z } from \"zod\";\n"
            "import { prisma } from \"@/lib/prisma\";\n"
            "import { requireUser } from \"@/lib/security/authenticated-request\";\n"
            "\n"
            "const SchemaCreation = z.object({ /* champs métier */ });\n"
            "\n"
            "export async function GET(request: NextRequest) {\n"
            "  await requireUser(request);\n"
            "  const page = Number(new URL(request.url).searchParams.get(\"page\") ?? 1);\n"
            f"  const items = await prisma.{entite.lower()}.findMany({{ orderBy: {{ createdAt: \"desc\" }}, take: 20, skip: (page - 1) * 20 }});\n"
            "  return NextResponse.json({ items });\n"
            "}\n"
            "\n"
            "export async function POST(request: NextRequest) {\n"
            "  const utilisateur = await requireUser(request);\n"
            "  const body = SchemaCreation.parse(await request.json());\n"
            f"  const cree = await prisma.{entite.lower()}.create({{ data: {{ ...body, ownerId: utilisateur.uid }} }});\n"
            "  return NextResponse.json(cree, { status: 201 });\n"
            "}\n"
            "```"
        )
    if famille == "node":
        return (
            f"{titre} — `server/routes/{entite.lower()}.ts` :\n"
            "```ts\n"
            "import { Router } from \"express\";\n"
            "import { z } from \"zod\";\n"
            "import { requireAuth } from \"../middleware/auth.js\";\n"
            "\n"
            "export const router" + entite + " = Router();\n"
            "const SchemaCreation = z.object({ /* champs métier */ });\n"
            "\n"
            f"router.get(\"/" + entite.lower() + "\", requireAuth, async (req, res) => {\n"
            "  const page = Number(req.query.page ?? 1);\n"
            f"  const items = await repo.{entite.lower()}.lister({{ page, parPage: 20 }});\n"
            "  res.json({ items });\n"
            "});\n"
            "\n"
            f"router.post(\"/" + entite.lower() + "\", requireAuth, async (req, res) => {\n"
            "  const body = SchemaCreation.parse(req.body);\n"
            f"  const cree = await repo.{entite.lower()}.creer({{ ...body, ownerId: req.user.uid }});\n"
            "  res.status(201).json(cree);\n"
            "});\n"
            "```"
        )
    if famille == "laravel":
        return (
            f"{titre} — `app/Http/Controllers/{entite}Controller.php` :\n"
            "```php\n"
            "public function index(Request $request)\n"
            "{\n"
            f"    return response()->json({entite}::latest()->paginate(20));\n"
            "}\n"
            "\n"
            "public function store(Request $request)\n"
            "{\n"
            f"    $donnees = $request->validate([/* règles métier */]);\n"
            f"    $cree = $request->user()->{entite.lower()}()->create($donnees);\n"
            "    return response()->json($cree, 201);\n"
            "}\n"
            "```"
        )
    if famille == "python":
        return (
            f"{titre} — `routers/{entite.lower()}.py` :\n"
            "```python\n"
            "from fastapi import APIRouter, Depends, HTTPException\n"
            "from pydantic import BaseModel\n"
            "\n"
            "router = APIRouter(prefix=\"/" + entite.lower() + "\")\n"
            "\n"
            "@router.get(\"/\")\n"
            "async def lister(page: int = 1, utilisateur=Depends(utilisateur_courant)):\n"
            f"    return await repo.{entite.lower()}.lister(page=page, par_page=20)\n"
            "\n"
            "@router.post(\"/\", status_code=201)\n"
            "async def creer(donnees: SchemaCreation, utilisateur=Depends(utilisateur_courant)):\n"
            f"    return await repo.{entite.lower()}.creer(donnees, proprietaire=utilisateur.uid)\n"
            "```"
        )
    if famille == "django":
        return (
            f"{titre} — `views.py` + `urls.py` :\n"
            "```python\n"
            "from django.http import JsonResponse\n"
            "from django.views.decorators.http import require_http_methods\n"
            "\n"
            "@require_http_methods([\"GET\"])\n"
            "def lister(request):\n"
            f"    page = int(request.GET.get(\"page\", 1))\n"
            f"    items = list({entite}.objects.order_by(\"-created_at\")[((page-1)*20):page*20])\n"
            "    return JsonResponse({\"items\": [serialiser(i) for i in items]})\n"
            "```"
        )
    return (
        f"{titre} — point d'entrée statique :\n"
        "```js\n"
        "// serveur léger de lecture (Node sans framework)\n"
        "import { readFile } from \"node:fs/promises\";\n"
        "export async function GET(req) {\n"
        f"  const items = JSON.parse(await readFile(\"data/{entite.lower()}.json\", \"utf8\"));\n"
        "  return new Response(JSON.stringify({ items }), { headers: { \"content-type\": \"application/json\" } });\n"
        "}\n"
        "```"
    )


def bloc_ui(famille: str, entite: str, langue: str) -> str:
    """Composant d'interface avec les 4 états (chargement, vide, erreur, données)."""
    titre = "Composant liste avec les quatre états d'interface" if langue == "fr" \
        else "List component with the four UI states"
    if famille in ("next", "node"):
        return (
            f"{titre} — `components/{entite}Liste.tsx` :\n"
            "```tsx\n"
            "\"use client\";\n"
            "import { useEffect, useState } from \"react\";\n"
            "\n"
            "type Etat = { statut: \"chargement\" } | { statut: \"vide\" } | { statut: \"erreur\"; message: string } | { statut: \"donnees\"; items: { id: string }[] };\n"
            "\n"
            f"export function {entite}Liste() {{\n"
            "  const [etat, setEtat] = useState<Etat>({ statut: \"chargement\" });\n"
            "  useEffect(() => {\n"
            f"    fetch(\"/api/{entite.lower()}\")\n"
            "      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))\n"
            "      .then((body) => setEtat(body.items.length ? { statut: \"donnees\", items: body.items } : { statut: \"vide\" }))\n"
            "      .catch((err) => setEtat({ statut: \"erreur\", message: err.message }));\n"
            "  }, []);\n"
            "\n"
            "  if (etat.statut === \"chargement\") return <p role=\"status\">Chargement…</p>;\n"
            "  if (etat.statut === \"erreur\") return <p role=\"alert\">Erreur : {etat.message}</p>;\n"
            "  if (etat.statut === \"vide\") return <p>Aucun élément pour le moment.</p>;\n"
            "  return (\n"
            "    <ul>\n"
            "      {etat.items.map((item) => <li key={item.id}>{/* rendu de la fiche */}</li>)}\n"
            "    </ul>\n"
            "  );\n"
            "}\n"
            "```"
        )
    if famille == "laravel":
        return (
            f"{titre} — `resources/js/components/{entite}Liste.vue` :\n"
            "```vue\n"
            "<template>\n"
            "  <p v-if=\"chargement\" role=\"status\">Chargement…</p>\n"
            "  <p v-else-if=\"erreur\" role=\"alert\">Erreur : {{ erreur }}</p>\n"
            "  <p v-else-if=\"!items.length\">Aucun élément pour le moment.</p>\n"
            "  <ul v-else><li v-for=\"item in items\" :key=\"item.id\">{{ item }}</li></ul>\n"
            "</template>\n"
            "```"
        )
    if famille in ("python", "django"):
        return (
            f"{titre} — gabarit Jinja/Django :\n"
            "```html\n"
            "{% if erreur %}<p role=\"alert\">{{ erreur }}</p>\n"
            "{% elif not items %}<p>Aucun élément pour le moment.</p>\n"
            "{% else %}<ul>{% for item in items %}<li>{{ item }}</li>{% endfor %}</ul>{% endif %}\n"
            "```"
        )
    return (
        f"{titre} — HTML + fetch (vanilla) :\n"
        "```html\n"
        "<ul id=\"liste\" aria-live=\"polite\"></ul>\n"
        "<script type=\"module\">\n"
        "  const liste = document.getElementById(\"liste\");\n"
        f"  const reponse = await fetch(\"/api/{entite.lower()}\");\n"
        "  const { items } = await reponse.json();\n"
        "  liste.innerHTML = items.length\n"
        "    ? items.map((i) => `<li>${i.id}</li>`).join(\"\")\n"
        "    : \"<li>Aucun élément pour le moment.</li>\";\n"
        "</script>\n"
        "```"
    )


def bloc_test(famille: str, entite: str, langue: str) -> str:
    nom = "Test de la route API (cas nominal + non authentifié)" if langue == "fr" \
        else "API route test (happy path + unauthenticated)"
    if famille in ("next", "node"):
        return (
            f"{nom} — `tests/{entite.lower()}.route.test.ts` :\n"
            "```ts\n"
            "import { describe, expect, it, vi } from \"vitest\";\n"
            "\n"
            "describe(\"GET /api/" + entite.lower() + "\", () => {\n"
            "  it(\"renvoie 401 sans session\", async () => {\n"
            "    const reponse = await GET(new Request(\"http://local/api/" + entite.lower() + "\"));\n"
            "    expect(reponse.status).toBe(401);\n"
            "  });\n"
            "\n"
            "  it(\"renvoie la liste paginée avec une session valide\", async () => {\n"
            "    const reponse = await GET(requeteAuthentifiee());\n"
            "    const body = await reponse.json();\n"
            "    expect(Array.isArray(body.items)).toBe(true);\n"
            "  });\n"
            "});\n"
            "```"
        )
    if famille in ("python", "django"):
        return (
            f"{nom} — `tests/test_{entite.lower()}.py` :\n"
            "```python\n"
            "def test_liste_sans_session(client):\n"
            f"    reponse = client.get(\"/" + entite.lower() + "/\")\n"
            "    assert reponse.status_code == 401\n"
            "\n"
            "def test_liste_avec_session(client, utilisateur_authentifie):\n"
            f"    reponse = client.get(\"/" + entite.lower() + "/\")\n"
            "    assert reponse.status_code == 200\n"
            "    assert \"items\" in reponse.json()\n"
            "```"
        )
    return (
        f"{nom} — `tests/{entite.lower()}.test.mjs` :\n"
        "```js\n"
        "import { describe, expect, it } from \"vitest\";\n"
        "\n"
        "describe(\"GET /api/" + entite.lower() + "\", () => {\n"
        "  it(\"renvoie 401 sans session\", async () => {\n"
        "    const reponse = await fetch(\"http://local/api/" + entite.lower() + "\");\n"
        "    expect(reponse.status).toBe(401);\n"
        "  });\n"
        "});\n"
        "```"
    )


def bloc_deploy(famille: str, langue: str) -> str:
    cible = "Déploiement reproductible" if langue == "fr" else "Reproducible deployment"
    if famille == "next":
        return (
            f"{cible} — `docker-compose.yml` + plateforme :\n"
            "```yaml\n"
            "services:\n"
            "  db:\n"
            "    image: postgres:16\n"
            "    environment: { POSTGRES_PASSWORD: dev }\n"
            "  app:\n"
            "    build: .\n"
            "    environment: [ DATABASE_URL, SESSION_SECRET ]\n"
            "    ports: [ \"3000:3000\" ]\n"
            "    depends_on: [ db ]\n"
            "```\n"
            "Alternatif : déploiement Vercel avec migrations `prisma migrate deploy` en étape de build."
        )
    if famille in ("python", "django"):
        return (
            f"{cible} — `Dockerfile` + `docker-compose.yml` :\n"
            "```yaml\n"
            "services:\n"
            "  db:\n"
            "    image: postgres:16\n"
            "  api:\n"
            "    build: .\n"
            "    command: sh -c \"migrate && uvicorn app.main:app --host 0.0.0.0 --port 8000\"\n"
            "    ports: [ \"8000:8000\" ]\n"
            "    depends_on: [ db ]\n"
            "```"
        )
    return (
        f"{cible} — `docker-compose.yml` :\n"
        "```yaml\n"
        "services:\n"
        "  db:\n"
        "    image: postgres:16\n"
        "  app:\n"
        "    build: .\n"
        "    environment: [ DATABASE_URL, SESSION_SECRET ]\n"
        "    ports: [ \"8080:8080\" ]\n"
        "```\n"
        "Healthcheck `/api/sante` requis avant le basculement du trafic."
    )


def bloc_auth(famille: str, langue: str) -> str:
    titre = "Authentification par session signée (hachage scrypt)" if langue == "fr" \
        else "Signed-session authentication (scrypt hashing)"
    if famille in ("next", "node"):
        return (
            f"{titre} — `lib/auth.ts` :\n"
            "```ts\n"
            "import { scrypt, randomBytes, timingSafeEqual } from \"node:crypto\";\n"
            "\n"
            "export function hasherMotDePasse(motDePasse: string): string {\n"
            "  const sel = randomBytes(16).toString(\"base64\");\n"
            "  const hash = scryptSync(motDePasse, sel, 64, { N: 16384, r: 8, p: 1 }).toString(\"base64\");\n"
            "  return `scrypt$16384$8$1$${sel}$${hash}`;\n"
            "}\n"
            "\n"
            "export function verifierMotDePasse(motDePasse: string, stocke: string): boolean {\n"
            "  const [, n, r, p, sel, hash] = stocke.split(\"$\");\n"
            "  const calcule = scryptSync(motDePasse, sel, 64, { N: Number(n), r: Number(r), p: Number(p) });\n"
            "  return timingSafeEqual(calcule, Buffer.from(hash, \"base64\"));\n"
            "}\n"
            "```\n"
            "Le cookie de session est signé HMAC-SHA256, HttpOnly, SameSite=Lax — jamais de token d'API côté navigateur."
        )
    if famille in ("python", "django"):
        return (
            f"{titre} — `auth.py` :\n"
            "```python\n"
            "import hashlib, hmac, os\n"
            "\n"
            "def hasher_mot_de_passe(mot_de_passe: str) -> str:\n"
            "    sel = os.urandom(16)\n"
            "    empreinte = hashlib.scrypt(mot_de_passe.encode(), salt=sel, n=16384, r=8, p=1, dklen=64)\n"
            "    return f\"scrypt${sel.hex()}${empreinte.hex()}\"\n"
            "\n"
            "def verifier_mot_de_passe(mot_de_passe: str, stocke: str) -> bool:\n"
            "    _, sel_hex, empreinte_hex = stocke.split(\"$\")\n"
            "    empreinte = hashlib.scrypt(mot_de_passe.encode(), salt=bytes.fromhex(sel_hex), n=16384, r=8, p=1, dklen=64)\n"
            "    return hmac.compare_digest(empreinte, bytes.fromhex(empreinte_hex))\n"
            "```"
        )
    return (
        f"{titre} — règle générale :\n"
        "Hachage scrypt ou argon2id côté serveur, sel unique par compte, comparaison à temps constant ; session par cookie HttpOnly signé ; jamais de mot de passe dans les journaux ni dans les réponses d'erreur."
    )


def bloc_arborescence(famille: str, entite: str, langue: str) -> str:
    intro = "Arborescence cible" if langue == "fr" else "Target file layout"
    if famille == "next":
        return (
            f"{intro} (Next.js App Router) :\n"
            "```\n"
            "app/\n"
            "  (public)/page.tsx          # accueil\n"
            f"  {entite.lower()}/page.tsx      # liste métier\n"
            f"  api/{entite.lower()}/route.ts  # CRUD validé\n"
            "components/\n"
            f"  {entite}Liste.tsx\n"
            "lib/  prisma.ts · auth.ts · validation.ts\n"
            "tests/  integration/\n"
            "```"
        )
    if famille in ("python", "django"):
        return (
            f"{intro} (Python) :\n"
            "```\n"
            "app/\n"
            "  main.py  · routers/  · models.py  · schemas.py\n"
            "templates/  base.html  · " + entite.lower() + ".html\n"
            "tests/  test_" + entite.lower() + ".py\n"
            "alembic/ (ou migrations Django)\n"
            "```"
        )
    if famille == "laravel":
        return (
            f"{intro} (Laravel) :\n"
            "```\n"
            "app/Http/Controllers/" + entite + "Controller.php\n"
            "app/Models/" + entite + ".php\n"
            "database/migrations/…_create_" + entite.lower() + "s_table.php\n"
            "resources/js/components/" + entite + "Liste.vue\n"
            "routes/api.php\n"
            "```"
        )
    return (
        f"{intro} :\n"
        "```\n"
        "server/  index.js · routes/ · middleware/ · repo/\n"
        "web/  index.html · assets/ · modules/\n"
        "data/  migrations/\n"
        "tests/\n"
        "```"
    )
