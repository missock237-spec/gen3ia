"""Moteur ``rag-index`` — indexation RAG (AUCUN entraînement des poids).

Construit un index vectoriel à partir des datasets :

1. lecture de tous les fichiers (txt/json/jsonl/csv) et découpage en chunks
   (``chunkSize`` caractères, recouvrement ``chunkOverlap``) ;
2. embedding des chunks via ``sentence-transformers/all-MiniLM-L6-v2`` ;
3. artefacts : ``index.npz`` (matrice des embeddings), ``chunks.json``
   (textes + métadonnées), ``rag-config.json`` (paramètres de l'index) ;
4. métriques ``{chunks, dimensions}``.

Le modèle de langage n'est PAS modifié — le RAG enrichit le contexte, il ne
change pas le comportement de base du modèle (limite documentée côté plateforme).
"""

from __future__ import annotations

import json

from ..schemas import SubmitJobPayload
from .base import BaseEngine, EngineContext, EngineError, JobCancelledError, require_number
from .dataset_io import chunk_text, load_records, record_to_text


class RagIndexEngine(BaseEngine):
    """Indexation RAG — méthode ``rag`` (utilitaire documentaire, sans inférence gen3)."""

    engine_id = "rag-index"
    methods = ("rag",)

    def run(self, payload: SubmitJobPayload, ctx: EngineContext) -> None:
        if payload.method not in self.methods:
            raise EngineError(
                f"La méthode « {payload.method} » n'est pas supportée par le moteur "
                f"rag-index (méthode : rag)."
            )

        chunk_size = require_number(payload.parameters, "chunkSize", 800, 128, 4096, integer=True)
        chunk_overlap = require_number(
            payload.parameters, "chunkOverlap", 80, 0, 512, integer=True
        )
        if chunk_overlap >= chunk_size:
            raise EngineError(
                f"Le chevauchement ({chunk_overlap}) doit rester strictement inférieur "
                f"à la taille de chunk ({chunk_size})."
            )
        if not payload.datasets:
            raise EngineError("Aucun dataset fourni : l'indexation RAG n'a rien à indexer.")

        ctx.report(
            2.0,
            current_step="Lecture des documents",
            log_message=(
                "Moteur rag-index — indexation RAG (aucun poids entraîné) : "
                f"chunks de {chunk_size} caractères, recouvrement {chunk_overlap}."
            ),
        )

        # ---- 1. Extraction du texte de chaque fichier -----------------------------
        chunks: list[dict[str, str]] = []
        total_files = len(payload.datasets)
        for position, ref in enumerate(payload.datasets, start=1):
            if ctx.is_cancelled():
                raise JobCancelledError("Annulé par la plateforme.")
            path = ctx.download(ref.storageKey)
            if ref.format == "txt":
                full_text = path.read_text(encoding="utf-8", errors="replace")
            else:
                records = load_records(path, ref.format)
                full_text = "\n\n".join(
                    text
                    for text in (record_to_text(record) for record in records)
                    if text.strip()
                )
            file_chunks = 0
            for chunk in chunk_text(full_text, chunk_size, chunk_overlap):
                chunks.append({"text": chunk, "source": ref.storageKey})
                file_chunks += 1
            ctx.report(
                5.0 + 20.0 * position / total_files,
                current_step=f"Extraction des documents ({position}/{total_files})",
                log_message=(
                    f"Document « {ref.storageKey} » : {file_chunks} chunk(s) extraits."
                ),
            )
        if not chunks:
            raise EngineError(
                "Aucun texte extrait des datasets : rien à indexer (fichiers vides ou "
                "enregistrements sans contenu)."
            )

        # ---- 2. Embeddings (sentence-transformers, import paresseux) --------------
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise EngineError(
                "sentence-transformers requis pour l'indexation RAG — installez-le "
                "sur le worker (pip install sentence-transformers)."
            ) from exc

        ctx.report(
            30.0,
            current_step="Chargement du modèle d'embedding (all-MiniLM-L6-v2)",
        )
        embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
        ctx.report(40.0, current_step=f"Embedding de {len(chunks)} chunks")
        raw_embeddings = embedder.encode(
            [chunk["text"] for chunk in chunks],
            batch_size=64,
            show_progress_bar=False,
        )

        # numpy est une dépendance de sentence-transformers — import sûr ici.
        import numpy as np

        embeddings = np.asarray(raw_embeddings, dtype=np.float32)
        if embeddings.ndim != 2 or embeddings.shape[0] == 0:
            raise EngineError(
                f"Embeddings inattendus (forme {embeddings.shape}) : indexation impossible."
            )
        dimensions = int(embeddings.shape[1])

        # ---- 3. Écriture des artefacts -------------------------------------------
        ctx.report(80.0, current_step="Écriture des artefacts d'index")
        index_path = ctx.workdir / "index.npz"
        np.savez_compressed(index_path, embeddings=embeddings)

        chunks_path = ctx.workdir / "chunks.json"
        chunks_path.write_text(
            json.dumps(chunks, ensure_ascii=False), encoding="utf-8"
        )

        rag_config_path = ctx.workdir / "rag-config.json"
        rag_config_path.write_text(
            json.dumps(
                {
                    "engine": self.engine_id,
                    "embeddingModel": "sentence-transformers/all-MiniLM-L6-v2",
                    "chunkSize": chunk_size,
                    "chunkOverlap": chunk_overlap,
                    "chunks": len(chunks),
                    "dimensions": dimensions,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        ctx.report(85.0, current_step="Téléversement des artefacts")
        ctx.upload_artifact("index.npz", index_path)
        ctx.upload_artifact("chunks.json", chunks_path)
        ctx.upload_artifact("rag-config.json", rag_config_path)

        ctx.report(
            100.0,
            current_step="Indexation terminée",
            metrics={"chunks": float(len(chunks)), "dimensions": float(dimensions)},
            log_message=(
                f"Indexation RAG terminée : {len(chunks)} chunks de dimension "
                f"{dimensions} indexés (aucun poids de modèle modifié)."
            ),
        )
