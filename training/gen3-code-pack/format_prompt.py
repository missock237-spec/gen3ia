#!/usr/bin/env python3
"""Format de prompt partagé du pack code gen3.

Source unique de vérité pour :
  * la liste des langages supportés,
  * la normalisation des alias (c++ -> cpp, c# -> csharp, js -> javascript...),
  * le gabarit de prompt « ### Instruction / ### Language / ### Task / ### Response ».

Le même gabarit est utilisé par train_gen3_code.py (entraînement),
infer_gen3_code.py (inférence) et bench_gen3_code.py (benchmark) : le modèle est
ainsi évalué dans le format exact avec lequel il a été entraîné.

Module 100 % Python standard : importable partout, y compris sans torch
(validations sandbox, tests CI, --dry-run).
"""

from __future__ import annotations

SUPPORTED_LANGUAGES = {
    "html", "css", "python", "java", "javascript", "rust", "cpp",
    "julia", "bash", "lua", "dart", "r", "sql", "ruby",
    "php", "go", "csharp", "swift", "typescript", "c",
    "objective-c", "objective_c", "kotlin", "scala",
}

ALIAS_LANGUES: dict[str, str] = {
    "c++": "cpp",
    "c#": "csharp",
    "c sharp": "csharp",
    "objective-c": "objective_c",
    "js": "javascript",
    "ts": "typescript",
    "node": "javascript",
    "nodejs": "javascript",
    "next.js": "typescript",
    "nextjs": "typescript",
    "react": "javascript",
    "reactjs": "javascript",
    "sh": "bash",
    "shell": "bash",
    "golang": "go",
    "py": "python",
    "htm": "html",
    "scss": "css",
    "sass": "css",
}


def normalize_language(lang: str | None) -> str:
    """Normalise un libellé de langage vers sa forme canonique.

    Retourne "unknown" si vide ; les alias connus sont ramenés à leur forme
    canonique ; les valeurs inconnues sont mises en minuscules et conservées
    (le validateur émet un avertissement, l'entraînement ne casse pas).
    """
    brut = str(lang or "").strip().lower()
    if not brut:
        return "unknown"
    return ALIAS_LANGUES.get(brut, brut)


def is_supported(lang: str | None) -> bool:
    return normalize_language(lang) in SUPPORTED_LANGUAGES


def build_prompt(instruction: str, language: str, task: str = "programming") -> str:
    """Construit le prompt d'entraînement / d'inférence.

    ⚠️ Historique : une version antérieure d'un pack voisin imprimait des
    « \\n » littéraux à la place de vrais sauts de ligne ; ce gabarit est testé
    par le validateur (les \\n de la source produisent de VRAIS sauts de ligne).
    """
    instruction = str(instruction or "").strip()
    language = normalize_language(language)
    task = str(task or "programming").strip() or "programming"
    return (
        "### Instruction\n" + instruction + "\n\n"
        "### Language\n" + language + "\n"
        "### Task\n" + task + "\n\n"
        "### Response\n"
    )


if __name__ == "__main__":
    demo = build_prompt("Crée une page HTML de contact", "HTML")
    assert "\n" in demo and "### Response" in demo
    print(demo)
    print("Langages supportés :", ", ".join(sorted(SUPPORTED_LANGUAGES)))
