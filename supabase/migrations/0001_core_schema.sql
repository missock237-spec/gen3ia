-- ============================================================================
-- Gen3ia — Schéma core Supabase/PostgreSQL (Task 40, migration 0001)
-- ============================================================================
-- Transposition relationnelle du modèle Firestore (lib/firestore/types.ts,
-- firestore.rules, repositories). Principes :
--   1. UUID générés côté base (gen_random_uuid) ; la table migration_mapping
--      conserve la correspondance Firestore ID ⇄ Postgres UUID (cutover sûr).
--   2. JSONB pour les structures souples (manifests, plans, metadata) —
--      fidèle au modèle documentaire sans perdre le typage des colonnes
--      chaudes (statuts, montants, dates).
--   3. Toutes les dates en timestamptz ; updated_at par trigger.
--   4. Référentiel d'identité : profiles.firebase_uid — Firebase Auth reste
--      l'IdP en phase 1 (ADR-006).
--   5. Extensions requises : pgcrypto (gen_random_uuid), pgvector (mémoires).
-- ============================================================================

create extension if not exists pgcrypto;
-- pgvector : fourni par Supabase (vector). Décommenté automatiquement en
-- local si l'extension est disponible :
-- create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Identité
-- ---------------------------------------------------------------------------

create table profiles (
  id                uuid primary key default gen_random_uuid(),
  firebase_uid      text not null unique,
  email             text,
  display_name      text,
  photo_url         text,
  provider          text,
  is_platform_admin boolean not null default false,
  preferences       jsonb  not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index profiles_email_idx on profiles (lower(email));

-- ---------------------------------------------------------------------------
-- Organisations (multi-tenant) et membres
-- ---------------------------------------------------------------------------

create table organizations (
  id              uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  name            text not null,
  plan            text not null default 'free',
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  profile_id      uuid not null references profiles(id) on delete cascade,
  role            text not null check (role in ('owner','admin','member','viewer')),
  invited_by      uuid references profiles(id) on delete set null,
  joined_at       timestamptz not null default now(),
  primary key (organization_id, profile_id)
);

create index organization_members_profile_idx on organization_members (profile_id);

-- ---------------------------------------------------------------------------
-- Projets
-- ---------------------------------------------------------------------------

create table projects (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  name             text not null,
  description      text not null default '',
  visibility       text not null default 'private' check (visibility in ('private','unlisted','public')),
  status           text not null default 'active'  check (status in ('active','archived','deleted')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index projects_owner_idx on projects (owner_profile_id, status);

-- ---------------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------------

create table agents (
  id                            uuid primary key default gen_random_uuid(),
  owner_profile_id              uuid not null references profiles(id) on delete cascade,
  organization_id               uuid references organizations(id) on delete set null,
  project_id                    uuid references projects(id) on delete set null,
  name                          text not null,
  description                   text not null default '',
  system_prompt                 text not null default '',
  model_strategy                text not null default 'automatic' check (model_strategy in ('automatic','fixed')),
  preferred_provider            text,
  preferred_model               text,
  autonomous                    boolean not null default false,
  max_iterations                integer not null default 8,
  skills                        jsonb not null default '[]'::jsonb,
  tools                         jsonb not null default '[]'::jsonb,
  memory_enabled                boolean not null default true,
  web_research_enabled          boolean not null default true,
  document_generation_enabled   boolean not null default true,
  status                        text not null default 'draft' check (status in ('draft','active','paused','archived')),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create index agents_owner_idx on agents (owner_profile_id, status);
create index agents_org_idx on agents (organization_id);

-- ---------------------------------------------------------------------------
-- Conversations + messages (chat Gen)
-- ---------------------------------------------------------------------------

create table conversations (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  title            text not null default 'Nouvelle conversation',
  agent_id         uuid references agents(id) on delete set null,
  archived         boolean not null default false,
  message_count    integer not null default 0,
  last_message_at  timestamptz,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index conversations_owner_recent_idx on conversations (owner_profile_id, last_message_at desc nulls last);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system','tool')),
  content         text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Exécutions d'agents (runs) + approbations HITL
-- ---------------------------------------------------------------------------

create table agent_runs (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid references agents(id) on delete cascade,
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  conversation_id  uuid references conversations(id) on delete set null,
  task             text not null,
  status           text not null default 'queued'
                   check (status in ('queued','planning','running','evaluating','awaiting_approval',
                                     'paused','completed','failed','cancelled')),
  iteration        integer not null default 0,
  max_iterations   integer not null default 8,
  plan             jsonb,
  selected_skills  jsonb not null default '[]'::jsonb,
  selected_tools   jsonb not null default '[]'::jsonb,
  selected_provider text,
  selected_model   text,
  result           jsonb,
  error            text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index agent_runs_owner_idx on agent_runs (owner_profile_id, created_at desc);
create index agent_runs_status_idx on agent_runs (status) where status in ('running','queued','awaiting_approval');

create table approvals (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid references agent_runs(id) on delete cascade,
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  tool             text not null,
  arguments        jsonb,
  risk_level       text check (risk_level in ('low','medium','high','critical')),
  status           text not null default 'awaiting' check (status in ('awaiting','approved','rejected','expired')),
  decided_by       uuid references profiles(id) on delete set null,
  decided_at       timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index approvals_awaiting_idx on approvals (owner_profile_id, created_at desc) where status = 'awaiting';

-- ---------------------------------------------------------------------------
-- Artefacts
-- ---------------------------------------------------------------------------

create table artifacts (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  run_id           uuid references agent_runs(id) on delete set null,
  conversation_id  uuid references conversations(id) on delete set null,
  kind             text not null,
  name             text not null,
  mime_type        text,
  size_bytes       bigint,
  storage_path     text,
  content          jsonb,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index artifacts_owner_idx on artifacts (owner_profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Compétences (skills)
-- ---------------------------------------------------------------------------

create table skills (
  id                           uuid primary key default gen_random_uuid(),
  owner_profile_id             uuid references profiles(id) on delete cascade, -- null = système
  name                         text not null,
  description                  text not null default '',
  version                      text not null default '1.0.0',
  system_instructions          text,
  capabilities                 jsonb not null default '[]'::jsonb,
  triggers                     jsonb not null default '[]'::jsonb,
  required_tools               jsonb not null default '[]'::jsonb,
  input_schema                 jsonb not null default '{}'::jsonb,
  output_schema                jsonb not null default '{}'::jsonb,
  quality_criteria             jsonb not null default '[]'::jsonb,
  autonomous_creation_allowed  boolean not null default false,
  visibility                   text not null default 'private' check (visibility in ('system','private','public')),
  enabled                      boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index skills_owner_idx on skills (owner_profile_id, visibility);

-- ---------------------------------------------------------------------------
-- Mémoires (vectorielles) + connaissances
-- ---------------------------------------------------------------------------

create table memories (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  kind             text not null check (kind in ('episodic','semantic','keyvalue','souvenir','summary')),
  content          text,
  payload          jsonb not null default '{}'::jsonb,
  -- embedding vector(384) : activé avec l'extension pgvector (all-MiniLM-L6-v2)
  importance       real not null default 0.5 check (importance >= 0 and importance <= 1),
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index memories_owner_kind_idx on memories (owner_profile_id, kind, created_at desc);

create table knowledge_documents (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  title            text not null,
  mime_type        text,
  size_bytes       bigint,
  storage_path     text,
  chunk_count      integer not null default 0,
  status           text not null default 'ready' check (status in ('pending','ready','failed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index knowledge_documents_owner_idx on knowledge_documents (owner_profile_id, created_at desc);

create table knowledge_chunks (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references knowledge_documents(id) on delete cascade,
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  chunk_index      integer not null default 0,
  content          text not null,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index knowledge_chunks_doc_idx on knowledge_chunks (document_id, chunk_index);

-- ---------------------------------------------------------------------------
-- Portefeuille (wallet) — mêmes invariants que Firestore (ledger immuable)
-- ---------------------------------------------------------------------------

create table wallets (
  profile_id  uuid primary key references profiles(id) on delete cascade,
  balance     numeric(18,2) not null default 0 check (balance >= 0),
  currency    text not null default 'XAF',
  updated_at  timestamptz not null default now()
);

create table wallet_entries (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id) on delete cascade,
  kind          text not null check (kind in ('topup','reservation','settlement','release','refund','grant')),
  amount        numeric(18,2) not null,
  currency      text not null default 'XAF',
  reference     text unique, -- idempotence des recharges/écritures
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index wallet_entries_profile_idx on wallet_entries (profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

create table notifications (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  kind             text not null,
  title            text not null,
  body             text,
  link             text,
  read             boolean not null default false,
  read_at          timestamptz,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index notifications_owner_unread_idx on notifications (owner_profile_id, created_at desc) where read = false;
create index notifications_owner_recent_idx on notifications (owner_profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Usage (compteurs périodiques) — écritures serveur uniquement
-- ---------------------------------------------------------------------------

create table usage_counters (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  period_start     date not null,
  kind             text not null,
  counter          jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  unique (owner_profile_id, period_start, kind)
);

-- ---------------------------------------------------------------------------
-- Journal d'audit (security + tools) — append-only, lecture admin
-- ---------------------------------------------------------------------------

create table audit_events (
  id               uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references profiles(id) on delete set null,
  kind             text not null check (kind in ('security','tool','admin','billing')),
  event_type       text not null,
  severity         text not null default 'info' check (severity in ('info','warning','critical')),
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index audit_events_kind_idx on audit_events (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Marketplace d'extensions
-- ---------------------------------------------------------------------------

create table extensions (
  id                   uuid primary key default gen_random_uuid(),
  developer_profile_id uuid references profiles(id) on delete set null,
  slug                 text not null unique,
  name                 text not null,
  description          text not null default '',
  manifest             jsonb not null default '{}'::jsonb,
  status               text not null default 'draft'
                       check (status in ('draft','pending_review','published','suspended','rejected')),
  pricing              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table extension_versions (
  id           uuid primary key default gen_random_uuid(),
  extension_id uuid not null references extensions(id) on delete cascade,
  version      text not null,
  manifest     jsonb not null default '{}'::jsonb,
  changelog    text,
  created_at   timestamptz not null default now(),
  unique (extension_id, version)
);

create table extension_installations (
  id           uuid primary key default gen_random_uuid(),
  extension_id uuid not null references extensions(id) on delete cascade,
  profile_id   uuid not null references profiles(id) on delete cascade,
  version      text,
  status       text not null default 'active' check (status in ('active','disabled','uninstalled')),
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (extension_id, profile_id)
);

create table extension_reviews (
  id           uuid primary key default gen_random_uuid(),
  extension_id uuid not null references extensions(id) on delete cascade,
  profile_id   uuid not null references profiles(id) on delete cascade,
  rating       integer not null check (rating between 1 and 5),
  comment      text,
  created_at   timestamptz not null default now(),
  unique (extension_id, profile_id)
);

create table extension_purchases (
  id           uuid primary key default gen_random_uuid(),
  extension_id uuid not null references extensions(id) on delete cascade,
  profile_id   uuid not null references profiles(id) on delete cascade,
  amount       numeric(18,2) not null,
  currency     text not null default 'XAF',
  reference    text unique,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create table developer_api_keys (
  key_hash    text primary key,
  profile_id  uuid not null references profiles(id) on delete cascade,
  label       text not null default '',
  scopes      jsonb not null default '[]'::jsonb,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Arrêt d'urgence + schedules d'agents
-- ---------------------------------------------------------------------------

create table emergency_stops (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid references profiles(id) on delete cascade,
  scope            text not null default 'all',
  reason           text,
  created_at       timestamptz not null default now()
);

create table agent_schedules (
  id               uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references profiles(id) on delete cascade,
  agent_id         uuid references agents(id) on delete cascade,
  schedule         jsonb not null,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  status           text not null default 'active' check (status in ('active','paused','archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index agent_schedules_due_idx on agent_schedules (next_run_at) where status = 'active';

-- ---------------------------------------------------------------------------
-- Correspondance de migration Firestore ⇄ Postgres
-- ---------------------------------------------------------------------------

create table migration_mapping (
  collection  text not null,
  firestore_id text not null,
  postgres_id uuid not null,
  migrated_at timestamptz not null default now(),
  primary key (collection, firestore_id)
);

-- ---------------------------------------------------------------------------
-- Triggers updated_at (toutes les tables qui portent la colonne)
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles','organizations','projects','agents','conversations','agent_runs',
    'approvals','artifacts','skills','memories','knowledge_documents','wallets',
    'usage_counters','extensions','extension_installations','agent_schedules'
  ]
  loop
    execute format(
      'create trigger trg_%s_updated_at before update on %I for each row execute function set_updated_at()',
      table_name, table_name
    );
  end loop;
end;
$$;
