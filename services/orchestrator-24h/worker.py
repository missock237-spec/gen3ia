"""Worker gen3ia — exécution 24/7 des tâches longues par modalité (Redis Streams).

Améliorations v2 par rapport au kit d'origine :
- **Priorité réelle** : les tâches `priority <= FAST_LANE_MAX_PRIORITY` (défaut 3)
  sont publiées dans une voie rapide dédiée (`gen3ia:queue:<modality>:fast`)
  lue en premier par le worker — le champ `priority` n'est plus décoratif.
- **Arrêt gracieux** : SIGTERM/SIGINT terminent la tâche en cours avant de
  quitter ; au-delà de `stop_grace_period` (compose), la reprise se fait par
  re-claim des entrées pending (mechanisme xautoclaim inchangé).
- **TTL des jobs terminés** : `JOB_TTL_SECONDS` (défaut 7 jours) expire les
  états terminaux — évite la croissance illimitée de Redis sur un VPS 2 Go.
- **Traçabilité** : `started_at`, `attempts`, voie (fast/normal) consignés.
- **Garde-fou données** : lot vide refusé explicitement (erreur permanente).

La philosophie qualité d'origine est conservée : aucun résultat distant sans
score/indicateur n'est déclaré « de haute qualité » — il part en review.
"""

import json
import os
import signal
import socket
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import redis
from redis.exceptions import ResponseError

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
MODALITY = os.getenv("MODALITY", "image").lower()
STREAMS = {
    "image": "gen3ia:queue:image",
    "audio": "gen3ia:queue:audio",
    "video": "gen3ia:queue:video",
    "data": "gen3ia:queue:data",
}
#: Seuil de priorité (1..10) au-delà duquel une tâche reste en voie normale.
FAST_LANE_MAX_PRIORITY = int(os.getenv("FAST_LANE_MAX_PRIORITY", "3"))
#: Durée (s) de conservation des états terminaux des jobs (0 = jamais expirer).
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", str(7 * 24 * 3600)))
GROUP_SUFFIX = "-v1"
FAST_GROUP_SUFFIX = "-fast-v1"
CONSUMER = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "5"))
RETRY_BASE_SECONDS = float(os.getenv("RETRY_BASE_SECONDS", "2"))
PROVIDER_TIMEOUT_SECONDS = int(os.getenv("PROVIDER_TIMEOUT_SECONDS", "1800"))
#: Doit rester supérieur au temps maximal attendu d'une tâche distante.
CLAIM_IDLE_MS = int(os.getenv("CLAIM_IDLE_MS", str(6 * 60 * 60 * 1000)))
MIN_QUALITY_SCORE = float(os.getenv("MIN_QUALITY_SCORE", "0.75"))
PROVIDER_BEARER_TOKEN = os.getenv("PROVIDER_BEARER_TOKEN", "")
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
ENDPOINTS = {
    "image": os.getenv("GEN3IA_IMAGE_ENDPOINT", ""),
    "audio": os.getenv("GEN3IA_AUDIO_ENDPOINT", ""),
    "video": os.getenv("GEN3IA_VIDEO_ENDPOINT", ""),
}

rdb = redis.Redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=5, health_check_interval=30)

#: Flag d'arrêt gracieux (SIGTERM/SIGINT) — la tâche en cours se termine d'abord.
shutdown_requested = False


class PermanentJobError(Exception):
    pass


def normal_stream(modality: str) -> str:
    return STREAMS[modality]


def fast_stream(modality: str) -> str:
    """Voie rapide : priorité haute (<= FAST_LANE_MAX_PRIORITY), lue en premier."""
    return f"{STREAMS[modality]}:fast"


def stream_for(modality: str, priority: int) -> str:
    """Routage utilisé par l'API et réutilisable côté outillage."""
    return fast_stream(modality) if priority <= FAST_LANE_MAX_PRIORITY else normal_stream(modality)


def log_event(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False, default=str), flush=True)


def now() -> str:
    return str(time.time())


def update_job(job_id: str, status: str, expire: bool = False, **fields: Any) -> None:
    mapping: dict[str, str] = {"status": status, "updated_at": now()}
    for key, value in fields.items():
        mapping[key] = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    key = f"gen3ia:job:{job_id}"
    rdb.hset(key, mapping=mapping)
    if expire and JOB_TTL_SECONDS > 0:
        rdb.expire(key, JOB_TTL_SECONDS)


def safe_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def run_data_quality(payload: dict[str, Any], job_id: str) -> dict[str, Any]:
    """Contrôle structurel de base. Aucune suppression silencieuse : les lignes
    rejetées sont conservées séparément pour correction."""
    records = payload.get("records")
    if not isinstance(records, list):
        raise PermanentJobError("Pour modality=data, payload.records doit être une liste de lignes")
    if not records:
        raise PermanentJobError("Lot de données vide : payload.records ne doit pas être vide")
    if len(records) > 10000:
        raise PermanentJobError("Maximum 10 000 lignes par tâche data; découpe les lots")
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen: set[str] = set()
    duplicate_count = 0
    for index, row in enumerate(records):
        if not isinstance(row, dict):
            rejected.append({"index": index, "reason": "row_not_object", "row": row})
            continue
        text = next((row.get(k) for k in ("caption", "text", "prompt", "description", "transcript") if isinstance(row.get(k), str)), "")
        text_norm = " ".join(text.strip().split())
        asset = next((row.get(k) for k in ("asset_url", "image_url", "audio_url", "video_url", "file_url", "source_url") if row.get(k)), None)
        reasons = []
        if not text_norm:
            reasons.append("missing_text_or_caption")
        if text_norm and len(text_norm) > 20000:
            reasons.append("text_over_20000_chars")
        if asset is not None and not safe_url(asset):
            reasons.append("asset_url_must_be_http_or_https")
        # Clé de doublon = texte normalisé exact + asset ; aucun dédoublonnage
        # flou/sémantique n'est prétendu ici.
        key = text_norm.casefold() + "|" + str(asset or "")
        if key in seen:
            duplicate_count += 1
            reasons.append("duplicate_exact_key")
        if reasons:
            rejected.append({"index": index, "reason": reasons, "row": row})
            continue
        seen.add(key)
        normalized = dict(row)
        if text_norm:
            for k in ("caption", "text", "prompt", "description", "transcript"):
                if isinstance(normalized.get(k), str):
                    normalized[k] = text_norm
                    break
        accepted.append(normalized)

    out_dir = DATA_DIR / "cleaned"
    reject_dir = DATA_DIR / "rejected"
    out_dir.mkdir(parents=True, exist_ok=True)
    reject_dir.mkdir(parents=True, exist_ok=True)
    clean_path = out_dir / f"{job_id}.jsonl"
    reject_path = reject_dir / f"{job_id}.jsonl"
    with clean_path.open("w", encoding="utf-8") as fp:
        for row in accepted:
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")
    with reject_path.open("w", encoding="utf-8") as fp:
        for row in rejected:
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {
        "status": "completed",
        "quality": {"structural_checks_passed": True, "score": round(len(accepted) / max(1, len(records)), 4), "score_type": "acceptance_ratio_not_semantic_quality"},
        "counts": {"received": len(records), "accepted": len(accepted), "rejected": len(rejected), "duplicates_detected": duplicate_count},
        "cleaned_file": str(clean_path),
        "rejected_file": str(reject_path),
        "warning": "Contrôle structurel uniquement. La qualité sémantique, la propriété intellectuelle, les droits et la sécurité nécessitent des contrôles supplémentaires.",
    }


def provider_request(job: dict[str, Any]) -> dict[str, Any]:
    modality = job["modality"]
    endpoint = ENDPOINTS.get(modality, "")
    if not endpoint:
        raise PermanentJobError(f"GEN3IA_{modality.upper()}_ENDPOINT n'est pas configuré")
    headers = {"Idempotency-Key": job["job_id"]}
    if PROVIDER_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {PROVIDER_BEARER_TOKEN}"
    headers["X-Gen3ia-Job-ID"] = job["job_id"]
    with httpx.Client(timeout=httpx.Timeout(PROVIDER_TIMEOUT_SECONDS, connect=15)) as client:
        response = client.post(endpoint, json=job["payload"], headers=headers)
        if response.status_code in {408, 425, 429} or response.status_code >= 500:
            response.raise_for_status()
        if response.status_code >= 400:
            raise PermanentJobError(f"Endpoint {modality} a renvoyé HTTP {response.status_code}: {response.text[:500]}")
        try:
            result = response.json()
        except ValueError as exc:
            raise PermanentJobError(f"Endpoint {modality} ne renvoie pas un JSON exploitable") from exc
    if not isinstance(result, dict):
        raise PermanentJobError("La réponse du fournisseur doit être un objet JSON")
    # Formes de réponse courantes acceptées ; une réponse vide n'est jamais
    # déclarée comme une génération réussie.
    output_keys = {"output_url", "image_url", "audio_url", "video_url", "outputs", "artifacts", "files", "result", "data"}
    if not any(k in result and result[k] not in (None, "", [], {}) for k in output_keys):
        raise PermanentJobError("Réponse fournisseur sans résultat exploitable (URL ou fichier de sortie attendu)")
    return result


def assess_result(result: dict[str, Any]) -> tuple[str, float | None, str | None]:
    quality = result.get("quality") if isinstance(result.get("quality"), dict) else {}
    score = result.get("quality_score", quality.get("score"))
    passed = result.get("quality_passed", quality.get("passed"))
    if score is not None:
        try:
            score = float(score)
        except (TypeError, ValueError):
            return "review_required", None, "score de qualité non numérique"
        if score < MIN_QUALITY_SCORE:
            return "review_required", score, f"score inférieur au seuil {MIN_QUALITY_SCORE}"
        if passed is False:
            return "review_required", score, "le fournisseur indique quality_passed=false"
        return "completed", score, None
    if passed is True:
        return "completed", None, None
    # Un résultat sans signal de qualité n'est pas certifié automatiquement.
    return "review_required", None, "aucun score/indicateur de qualité fourni; validation humaine ou évaluateur à brancher"


def dead_letter(entry_id: str, job: dict[str, Any], error: str, attempts: int) -> None:
    rdb.xadd(f"gen3ia:dead:{MODALITY}", {
        "source_stream_id": entry_id,
        "job_id": str(job.get("job_id", "unknown")),
        "attempts": str(attempts),
        "error": error[:3000],
        "job_json": json.dumps(job, ensure_ascii=False),
        "failed_at": now(),
    }, maxlen=20000, approximate=True)


def process(entry_id: str, fields: dict[str, str], lane: str = "normal") -> None:
    try:
        job = json.loads(fields["job_json"])
        job_id = job["job_id"]
        if job.get("modality") != MODALITY:
            raise PermanentJobError(f"Worker {MODALITY} a reçu une tâche {job.get('modality')}")
        update_job(job_id, "processing", worker=CONSUMER, stream_id=entry_id, lane=lane, started_at=now())
        last_error = ""
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                if MODALITY == "data":
                    result = run_data_quality(job["payload"], job_id)
                    status, score, note = "completed", result["quality"]["score"], None
                else:
                    result = provider_request(job)
                    status, score, note = assess_result(result)
                update_job(job_id, status, expire=True,
                           result_json=json.dumps(result, ensure_ascii=False),
                           quality_score="" if score is None else str(score),
                           quality_note=note or "", attempts=str(attempt))
                if status == "review_required":
                    rdb.xadd("gen3ia:review", {"job_id": job_id, "modality": MODALITY, "reason": note or "review", "result_json": json.dumps(result, ensure_ascii=False), "created_at": now()}, maxlen=20000, approximate=True)
                _ack_and_delete(entry_id, lane)
                log_event("job_finished", job_id=job_id, status=status, modality=MODALITY, lane=lane)
                return
            except PermanentJobError:
                raise
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError, redis.RedisError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code not in {408, 425, 429} and exc.response.status_code < 500:
                    raise PermanentJobError(last_error) from exc
                if attempt < MAX_RETRIES:
                    wait = min(60.0, RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
                    update_job(job_id, "retrying", retry_attempt=str(attempt), error=last_error)
                    time.sleep(wait)
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt < MAX_RETRIES:
                    time.sleep(min(60.0, RETRY_BASE_SECONDS * (2 ** (attempt - 1))))
        raise RuntimeError(f"Échec après {MAX_RETRIES} tentatives: {last_error}")
    except PermanentJobError as exc:
        job_id = job.get("job_id", "unknown") if "job" in locals() and isinstance(job, dict) else "unknown"
        dead_letter(entry_id, job if "job" in locals() and isinstance(job, dict) else {"job_json": fields.get("job_json", "")}, str(exc), 1)
        update_job(job_id, "failed", expire=True, error=str(exc))
        _ack_and_delete(entry_id, lane)
        print(f"Permanent job error {job_id}: {exc}", file=sys.stderr, flush=True)
    except Exception as exc:
        job_id = job.get("job_id", "unknown") if "job" in locals() and isinstance(job, dict) else "unknown"
        msg = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        dead_letter(entry_id, job if "job" in locals() and isinstance(job, dict) else {"job_json": fields.get("job_json", "")}, msg, MAX_RETRIES)
        update_job(job_id, "failed", expire=True, error=msg[:3000])
        _ack_and_delete(entry_id, lane)
        print(f"Job failed {job_id}: {msg[:1000]}", file=sys.stderr, flush=True)


def _ack_and_delete(entry_id: str, lane: str) -> None:
    """Ack + suppression sur la bonne voie — le flux de base reste la référence
    (les entrées de la voie rapide vivent dans le flux « :fast »)."""
    group = GROUP_SUFFIX if lane == "normal" else FAST_GROUP_SUFFIX
    stream = fast_stream(MODALITY) if lane == "fast" else normal_stream(MODALITY)
    rdb.xack(stream, f"gen3ia-{MODALITY}{group}", entry_id)
    rdb.xdel(stream, entry_id)


def ensure_group(stream: str, group: str) -> None:
    try:
        rdb.xgroup_create(stream, group, id="0-0", mkstream=True)
    except ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def _handle_signal(signum: int, _frame: Any) -> None:
    global shutdown_requested
    shutdown_requested = True
    log_event("shutdown_requested", signal=signal.Signals(signum).name, modality=MODALITY)


def read_one_job() -> list[tuple[str, dict[str, str], str]] | None:
    """Lit une tâche : voie rapide d'abord (priorité réelle), puis voie normale.

    Retourne une liste de triplets ``(entry_id, fields, lane)`` — la voie est
    propagée pour l'ack/suppression sur le bon flux et le bon groupe.
    """
    group_fast = f"gen3ia-{MODALITY}{FAST_GROUP_SUFFIX}"
    group_normal = f"gen3ia-{MODALITY}{GROUP_SUFFIX}"
    batches = rdb.xreadgroup(group_fast, CONSUMER, {fast_stream(MODALITY): ">"}, count=1, block=100)
    if batches:
        return [(entry_id, fields, "fast") for _, messages in batches for entry_id, fields in messages]
    batches = rdb.xreadgroup(group_normal, CONSUMER, {normal_stream(MODALITY): ">"}, count=1, block=5000)
    if batches:
        return [(entry_id, fields, "normal") for _, messages in batches for entry_id, fields in messages]
    return None


def reclaim_stale_jobs() -> None:
    """Récupère les entrées pending d'un worker disparu, sur les deux voies."""
    group_fast = f"gen3ia-{MODALITY}{FAST_GROUP_SUFFIX}"
    group_normal = f"gen3ia-{MODALITY}{GROUP_SUFFIX}"
    for stream, group, lane in (
        (fast_stream(MODALITY), group_fast, "fast"),
        (normal_stream(MODALITY), group_normal, "normal"),
    ):
        try:
            response = rdb.xautoclaim(stream, group, CONSUMER, min_idle_time=CLAIM_IDLE_MS, start_id="0-0", count=1)
            if len(response) >= 2:
                for entry_id, fields in response[1]:
                    process(entry_id, fields, lane=lane)
        except Exception as exc:
            print(f"Pending recovery warning ({lane}): {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)


def main() -> None:
    global shutdown_requested
    if MODALITY not in STREAMS:
        raise SystemExit(f"MODALITY invalide: {MODALITY}")
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    ensure_group(fast_stream(MODALITY), f"gen3ia-{MODALITY}{FAST_GROUP_SUFFIX}")
    ensure_group(normal_stream(MODALITY), f"gen3ia-{MODALITY}{GROUP_SUFFIX}")
    log_event("worker_started", modality=MODALITY, consumer=CONSUMER,
              fast_lane=fast_stream(MODALITY), normal_lane=normal_stream(MODALITY),
              fast_lane_max_priority=FAST_LANE_MAX_PRIORITY)
    last_claim = 0.0
    while not shutdown_requested:
        try:
            # Reprise des tâches d'un worker disparu — CLAIM_IDLE_MS doit rester
            # supérieur à la plus longue tâche distante attendue (ou l'idempotence
            # côté fournisseur protège contre les doublons).
            if time.time() - last_claim > 30:
                reclaim_stale_jobs()
                last_claim = time.time()
                if shutdown_requested:
                    break
            job = read_one_job()
            if job is None:
                continue
            for entry_id, fields, lane in job:
                process(entry_id, fields, lane=lane)
        except (redis.RedisError, OSError) as exc:
            print(f"Redis unavailable, reconnecting: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            time.sleep(5)
    log_event("worker_stopped", modality=MODALITY, consumer=CONSUMER)


if __name__ == "__main__":
    main()
