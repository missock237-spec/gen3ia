"""API de l'orchestrateur 24/7 gen3ia — file de tâches longues (Redis Streams).

Améliorations v2 par rapport au kit d'origine :
- **Priorité réelle** : `priority <= FAST_LANE_MAX_PRIORITY` (défaut 3) publie
  la tâche dans la voie rapide `gen3ia:queue:<modality>:fast`, lue en premier
  par les workers — le champ n'est plus décoratif.
- **Comparaison à temps constant** de la clé API (secrets.compare_digest).
- **`GET /stats`** : profondeur des files par modalité (voies rapide + normale),
  quarantaines (`dead:*`) et file de revue — supervision 24/7 en un appel.
- **Lifespan FastAPI** (remplace les hooks `on_event` dépréciés).

La clé `Idempotency-Key` reste acceptée : une même clé renvoie la même tâche
au lieu d'en créer une copie (protection contre les doubles soumissions).
"""

import json
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

import redis.asyncio as redis
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, ConfigDict

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
QUEUE_API_KEY = os.getenv("QUEUE_API_KEY", "")
FAST_LANE_MAX_PRIORITY = int(os.getenv("FAST_LANE_MAX_PRIORITY", "3"))
STREAMS = {
    "image": "gen3ia:queue:image",
    "audio": "gen3ia:queue:audio",
    "video": "gen3ia:queue:video",
    "data": "gen3ia:queue:data",
}
MODALITIES = Literal["image", "audio", "video", "data"]


def stream_for(modality: str, priority: int) -> str:
    """Voie rapide pour les priorités hautes, voie normale sinon."""
    return f"{STREAMS[modality]}:fast" if priority <= FAST_LANE_MAX_PRIORITY else STREAMS[modality]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global rdb
    rdb = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=5)
    await rdb.ping()
    yield
    if rdb is not None:
        await rdb.aclose()
        rdb = None


app = FastAPI(title="Gen3ia 24/7 Task Orchestrator", version="2.0.0", lifespan=lifespan)
rdb: redis.Redis | None = None


class JobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    modality: MODALITIES
    payload: dict[str, Any] = Field(..., description="Requête à transmettre au worker Gen3ia")
    priority: int = Field(
        default=5, ge=1, le=10,
        description=(f"1..10 — priorité <= {FAST_LANE_MAX_PRIORITY} passe en voie rapide "
                     "(traitée en premier par le worker)."),
    )
    metadata: dict[str, Any] = Field(default_factory=dict)


async def require_api_key(x_api_key: str | None = Header(default=None, alias="X-API-Key")):
    if not QUEUE_API_KEY:
        raise HTTPException(status_code=503, detail="QUEUE_API_KEY absent de la configuration serveur")
    # Comparaison à temps constant : ne divulgue pas la clé par mesure du temps.
    if not x_api_key or not secrets.compare_digest(x_api_key, QUEUE_API_KEY):
        raise HTTPException(status_code=401, detail="Clé API invalide")


@app.get("/health")
async def health():
    try:
        assert rdb is not None
        await rdb.ping()
        return {"status": "ok", "redis": "ok", "service": "gen3ia-orchestrator"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Redis indisponible: {type(exc).__name__}") from exc


@app.get("/stats", dependencies=[Depends(require_api_key)])
async def stats():
    """Profondeur des files et quarantaines — supervision 24/7."""
    assert rdb is not None
    out: dict[str, Any] = {"queues": {}, "dead_letters": {}, "fast_lane_max_priority": FAST_LANE_MAX_PRIORITY}
    for modality, stream in STREAMS.items():
        try:
            normal_len = await rdb.xlen(stream)
            fast_len = await rdb.xlen(f"{stream}:fast")
            out["queues"][modality] = {"normal": normal_len, "fast": fast_len, "total": normal_len + fast_len}
        except Exception as exc:
            out["queues"][modality] = {"error": f"{type(exc).__name__}"}
        try:
            out["dead_letters"][modality] = await rdb.xlen(f"gen3ia:dead:{modality}")
        except Exception:
            out["dead_letters"][modality] = 0
    try:
        out["review"] = await rdb.xlen("gen3ia:review")
    except Exception:
        out["review"] = 0
    return out


@app.post("/jobs", dependencies=[Depends(require_api_key)])
async def create_job(request: JobRequest, idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    assert rdb is not None
    raw = json.dumps(request.payload, ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode("utf-8")) > 1_000_000:
        raise HTTPException(status_code=413, detail="Payload trop volumineux (limite 1 Mo). Utilise une URL de fichier stocké.")
    if not request.payload:
        raise HTTPException(status_code=422, detail="Le payload ne peut pas être vide")
    idem_redis_key = None
    if idempotency_key:
        if len(idempotency_key) > 200:
            raise HTTPException(status_code=422, detail="Idempotency-Key trop long")
        idem_redis_key = f"gen3ia:idem:{idempotency_key}"
        existing = await rdb.get(idem_redis_key)
        if existing and existing != "PENDING":
            return {"job_id": existing, "status": "already_submitted", "status_url": f"/jobs/{existing}"}
        if existing == "PENDING":
            raise HTTPException(status_code=409, detail="Cette Idempotency-Key est déjà en cours de soumission")
        reserved = await rdb.set(idem_redis_key, "PENDING", ex=86400, nx=True)
        if not reserved:
            existing = await rdb.get(idem_redis_key)
            if existing and existing != "PENDING":
                return {"job_id": existing, "status": "already_submitted", "status_url": f"/jobs/{existing}"}
            raise HTTPException(status_code=409, detail="Cette Idempotency-Key est déjà en cours de soumission")

    job_id = str(uuid.uuid4())
    now = str(time.time())
    lane = "fast" if request.priority <= FAST_LANE_MAX_PRIORITY else "normal"
    job = {
        "job_id": job_id,
        "modality": request.modality,
        "payload": request.payload,
        "metadata": request.metadata,
        "priority": request.priority,
        "created_at": now,
    }
    stream = stream_for(request.modality, request.priority)
    # Enregistrement d'abord ; l'entrée n'est acquittée qu'après le résultat.
    async with rdb.pipeline(transaction=True) as pipe:
        pipe.hset(f"gen3ia:job:{job_id}", mapping={
            "job_id": job_id,
            "modality": request.modality,
            "status": "queued",
            "created_at": now,
            "updated_at": now,
            "priority": str(request.priority),
            "lane": lane,
            "metadata_json": json.dumps(request.metadata, ensure_ascii=False),
        })
        pipe.xadd(stream, {"job_json": json.dumps(job, ensure_ascii=False)})
        if idem_redis_key:
            pipe.set(idem_redis_key, job_id, ex=86400)
        await pipe.execute()
    return {"job_id": job_id, "status": "queued", "modality": request.modality, "lane": lane, "status_url": f"/jobs/{job_id}"}


@app.get("/jobs/{job_id}", dependencies=[Depends(require_api_key)])
async def get_job(job_id: str):
    assert rdb is not None
    record = await rdb.hgetall(f"gen3ia:job:{job_id}")
    if not record:
        raise HTTPException(status_code=404, detail="Tâche introuvable")
    out: dict[str, Any] = dict(record)
    for key in ("result_json", "metadata_json"):
        if key in out:
            try:
                out[key.removesuffix("_json")] = json.loads(out[key])
            except json.JSONDecodeError:
                pass
            del out[key]
    return out
