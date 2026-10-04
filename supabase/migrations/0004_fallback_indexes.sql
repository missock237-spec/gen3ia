-- ============================================================
-- Task 95-b — Index d'expressions pour le repli Firestore→Supabase
--
-- La couche résiliente (lib/db/firestore-fallback.ts) interroge le miroir
-- `firestore_fallback` par champs du payload JSONB :
--   .filter("payload->>status", "eq", "queued")
--   .order("payload->>nextAttemptAt")
-- Sans index d'expression, Postgres parcourt toute la table à chaque tick
-- de reprise. Ces index rendent ces filtres/tris des index scans réels.
-- Les noms de champs couverts sont ceux utilisés par les files vidéo
-- (status, userId, projectId, renderJobId, nextAttemptAt) et la
-- réconciliation (updated_at).
-- ============================================================

create index if not exists firestore_fallback_payload_status_idx
  on firestore_fallback ((payload->>'status'));

create index if not exists firestore_fallback_payload_user_id_idx
  on firestore_fallback ((payload->>'userId'));

create index if not exists firestore_fallback_payload_project_id_idx
  on firestore_fallback ((payload->>'projectId'));

create index if not exists firestore_fallback_payload_render_job_id_idx
  on firestore_fallback ((payload->>'renderJobId'));

create index if not exists firestore_fallback_payload_next_attempt_at_idx
  on firestore_fallback ((payload->>'nextAttemptAt'));

create index if not exists firestore_fallback_updated_at_idx
  on firestore_fallback (updated_at);
