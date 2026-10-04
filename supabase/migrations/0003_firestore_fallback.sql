-- Gen3ia: secours Firestore -> Supabase pour les données documentaires.
-- Les payloads restent JSONB afin de permettre une migration progressive domaine par domaine.
create table if not exists public.firestore_fallback (
  collection text not null,
  document_id text not null,
  owner_id text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, document_id)
);

create index if not exists firestore_fallback_owner_idx
  on public.firestore_fallback (owner_id, collection);

create index if not exists firestore_fallback_collection_idx
  on public.firestore_fallback (collection);

alter table public.firestore_fallback enable row level security;

-- Le service-role serveur utilise cette table. Aucun accès direct navigateur.
-- La RLS reste deny-by-default pour les clés publiques.
