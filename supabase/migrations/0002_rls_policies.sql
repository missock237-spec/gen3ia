-- ============================================================================
-- Gen3ia — Row Level Security (Task 40, migration 0002)
-- ============================================================================
-- Transposition 1:1 des règles firestore.rules (Task 39 : 9 matrices
-- vérifiées par @firebase/rules-unit-testing). Modèle :
--
--   Phase 1 (ADR-006) : toute l'accès données est service-role côté serveur
--   (scoping utilisateur appliqué dans les repositories, comme firebase-
--   admin aujourd'hui). La RLS est ACTIVEE + DENY-ALL par défaut : la clé
--   anon ne voit RIEN tant que Supabase Auth n'est pas activé (phase 3).
--
--   Phase 3 : les JWT Supabase Auth porteront le claim firebase_uid ; les
--   politiques ci-dessous s'activent alors automatiquement — le modèle de
--   sécurité est déjà vérifiable en local dès maintenant :
--     select set_config('request.jwt.claims',
--       '{"firebase_uid":"uid-123","role":"authenticated"}', true);
--
-- Règles fidèles à firestore.rules :
--   users/{uid}        → lecture/écriture propriétaire seul
--   agents, projects   → propriétaire seul (lecture public pour projects)
--   skills             → public + propriétaire
--   walletLedger, usage, audits, idempotency, system → client : INTERDIT
--   userWallets        → lecture propriétaire, écriture serveur seul
--   organizations      → membres (rôles owner/admin/member/viewer)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper d'identité : firebase_uid porté par le JWT (claim standardisé).
-- En phase 1 : retourne NULL pour toute requête anon → deny-all effectif.
-- ---------------------------------------------------------------------------

create or replace function request_firebase_uid() returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'firebase_uid', ''),
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
  )
$$;

create or replace function request_is_platform_admin() returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'admin')::boolean,
    false
  )
$$;

-- ---------------------------------------------------------------------------
-- Activation RLS (defaut deny-all une fois activé sans politique)
-- ---------------------------------------------------------------------------

alter table profiles                    enable row level security;
alter table organizations               enable row level security;
alter table organization_members        enable row level security;
alter table projects                    enable row level security;
alter table agents                      enable row level security;
alter table conversations               enable row level security;
alter table messages                    enable row level security;
alter table agent_runs                  enable row level security;
alter table approvals                   enable row level security;
alter table artifacts                   enable row level security;
alter table skills                      enable row level security;
alter table memories                    enable row level security;
alter table knowledge_documents         enable row level security;
alter table knowledge_chunks            enable row level security;
alter table wallets                     enable row level security;
alter table wallet_entries              enable row level security;
alter table notifications               enable row level security;
alter table usage_counters              enable row level security;
alter table audit_events                enable row level security;
alter table extensions                  enable row level security;
alter table extension_versions          enable row level security;
alter table extension_installations     enable row level security;
alter table extension_reviews           enable row level security;
alter table extension_purchases         enable row level security;
alter table developer_api_keys          enable row level security;
alter table emergency_stops             enable row level security;
alter table agent_schedules             enable row level security;
alter table migration_mapping           enable row level security;

-- ---------------------------------------------------------------------------
-- profiles : lecture/écriture de SON profil uniquement (rules users/{uid})
-- ---------------------------------------------------------------------------

create policy profiles_select_own on profiles
  for select using (firebase_uid = request_firebase_uid());
create policy profiles_update_own on profiles
  for update using (firebase_uid = request_firebase_uid());
create policy profiles_insert_own on profiles
  for insert with check (firebase_uid = request_firebase_uid());
-- delete : interdit (rules : allow delete: if false) — aucune politique.

-- ---------------------------------------------------------------------------
-- Propriété directe : gabarit uniforme (owner_profile_id = profil courant)
-- ---------------------------------------------------------------------------

create or replace function owns_row(owner uuid) returns boolean
language sql stable as $$
  select owner = (select id from profiles where firebase_uid = request_firebase_uid())
$$;

-- agents : CRUD propriétaire (rules /agents)
create policy agents_select_own on agents for select using (owns_row(owner_profile_id));
create policy agents_insert_own on agents for insert with check (owns_row(owner_profile_id));
create policy agents_update_own on agents for update using (owns_row(owner_profile_id));
create policy agents_delete_own on agents for delete using (owns_row(owner_profile_id));

-- projects : lecture propriétaire OU public ; écritures propriétaire
create policy projects_select_owner_or_public on projects
  for select using (owns_row(owner_profile_id) or visibility = 'public');
create policy projects_insert_own on projects
  for insert with check (owns_row(owner_profile_id) and visibility in ('private','public'));
create policy projects_update_own on projects
  for update using (owns_row(owner_profile_id))
  with check (owns_row(owner_profile_id) and visibility in ('private','public'));
create policy projects_delete_own on projects for delete using (owns_row(owner_profile_id));

-- conversations / messages / runs / approbations / artefacts / mémoires /
-- connaissances / notifications / schedules : propriétaire seul (lecture+écriture),
-- aligné sur le modèle Firestore « server enforces + rules owner-only ».
create policy conversations_owner_all on conversations
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy agent_runs_owner_all on agent_runs
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy approvals_owner_all on approvals
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy artifacts_owner_read on artifacts
  for select using (owns_row(owner_profile_id)); -- écritures serveur seul
create policy memories_owner_all on memories
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy knowledge_documents_owner_all on knowledge_documents
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy knowledge_chunks_owner_all on knowledge_chunks
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy notifications_owner_read on notifications
  for select using (owns_row(owner_profile_id)); -- mutations serveur seul
create policy agent_schedules_owner_all on agent_schedules
  for all using (owns_row(owner_profile_id)) with check (owns_row(owner_profile_id));
create policy emergency_stops_owner_read on emergency_stops
  for select using (owns_row(owner_profile_id) or request_is_platform_admin());

-- messages : accès via la conversation parente (jointure propriétaire)
create policy messages_via_conversation on messages
  for all using (
    exists (select 1 from conversations c
            where c.id = messages.conversation_id
              and owns_row(c.owner_profile_id))
  );

-- skills : public en lecture + CRUD propriétaire (rules /skills)
create policy skills_select_public_or_own on skills
  for select using (visibility = 'public' or owns_row(owner_profile_id));
create policy skills_insert_own on skills
  for insert with check (owns_row(owner_profile_id));
create policy skills_update_own on skills
  for update using (owns_row(owner_profile_id));
create policy skills_delete_own on skills
  for delete using (owns_row(owner_profile_id));

-- ---------------------------------------------------------------------------
-- Wallet : lecture solde par propriétaire, écritures SERVEUR SEUL
-- (rules : userWallets read own / write false ; walletLedger admin)
-- ---------------------------------------------------------------------------

create policy wallets_select_own on wallets
  for select using (owns_row(profile_id));
create policy wallet_entries_admin_only on wallet_entries
  for select using (request_is_platform_admin());
-- Aucune politique insert/update/delete client → écritures service-role seul.

-- ---------------------------------------------------------------------------
-- Serveur-seul strict : usage_counters, audit_events, migration_mapping,
-- developer_api_keys → AUCUNE politique (deny-all total pour anon/auth).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Organisations : membres (rules /teams + /organizations)
-- ---------------------------------------------------------------------------

create or replace function is_org_member(org uuid) returns boolean
language sql stable as $$
  select exists (
    select 1
    from organization_members m
    join profiles p on p.id = m.profile_id
    where m.organization_id = org
      and p.firebase_uid = request_firebase_uid()
  )
$$;

create or replace function org_role(org uuid) returns text
language sql stable as $$
  select m.role
  from organization_members m
  join profiles p on p.id = m.profile_id
  where m.organization_id = org
    and p.firebase_uid = request_firebase_uid()
$$;

create policy organizations_select_member on organizations
  for select using (is_org_member(id));
create policy organizations_insert_owner on organizations
  for insert with check (owns_row(owner_profile_id));
create policy organizations_update_admin on organizations
  for update using (coalesce(org_role(id) in ('owner','admin'), false));
create policy organizations_delete_owner on organizations
  for delete using (coalesce(org_role(id) = 'owner', false));

create policy org_members_select_member on organization_members
  for select using (is_org_member(organization_id));
create policy org_members_insert_admin on organization_members
  for insert with check (
    coalesce(org_role(organization_id) in ('owner','admin'), false)
    or owns_row(profile_id) -- auto-inscription propriétaire à la création
  );
create policy org_members_update_admin_or_self on organization_members
  for update using (
    coalesce(org_role(organization_id) in ('owner','admin'), false)
    or owns_row(profile_id)
  );
create policy org_members_delete_admin_or_self on organization_members
  for delete using (
    coalesce(org_role(organization_id) in ('owner','admin'), false)
    or owns_row(profile_id)
  );

-- ---------------------------------------------------------------------------
-- Marketplace : lecture publique publiée, écritures serveur/dev
-- ---------------------------------------------------------------------------

create policy extensions_select_published on extensions
  for select using (status = 'published');
create policy extensions_select_dev_own on extensions
  for select using (
    developer_profile_id in (select id from profiles where firebase_uid = request_firebase_uid())
  );

create policy extension_versions_select_published on extension_versions
  for select using (
    exists (select 1 from extensions e where e.id = extension_id and e.status = 'published')
  );

create policy extension_installations_select_own on extension_installations
  for select using (owns_row(profile_id)); -- mutations serveur seul
create policy extension_reviews_select_public on extension_reviews
  for select using (true); -- avis publics ; insert serveur seul
create policy extension_purchases_select_own on extension_purchases
  for select using (owns_row(profile_id)); -- mutations serveur seul
