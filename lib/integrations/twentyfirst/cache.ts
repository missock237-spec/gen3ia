import { FieldValue, Timestamp } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";
import { getComponent, getTheme } from "@/lib/integrations/twentyfirst/client";

/**
 * Cache Firestore pour les reponses 21st.dev consommatrices de quota
 * (get_component / get_theme : 2 recuperations gratuites par jour).
 * Structure : collection `codeAgent21stCache`, doc `component-<id>` / `theme-<id>`.
 * Les reponses en cache ne consomment aucun appel API.
 */

const COLLECTION = "codeAgent21stCache";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

interface CacheDoc {
  payload: unknown;
  kind: string;
  createdAt?: Timestamp | FieldValue;
  refreshedAt?: Timestamp | FieldValue;
}

async function readCache<T>(docId: string, kind: string): Promise<T | null> {
  const snap = await adminDb.collection(COLLECTION).doc(docId).get();
  if (!snap.exists) return null;
  const data = snap.data() as CacheDoc | undefined;
  if (!data) return null;
  const created = data.createdAt instanceof Timestamp ? data.createdAt.toDate().getTime() : 0;
  if (Date.now() - created > TTL_MS) return null;
  const payload = data.payload as { code?: unknown } | null;
  // Auto-reparation : les anciennes entrees creees avant la detection du quota
  // peuvent contenir un composant sans code — on les traite comme un echec.
  if (kind === "component" && (!payload || typeof payload.code !== "string" || payload.code.length === 0)) return null;
  return data.payload as T;
}

async function writeCache(docId: string, kind: string, payload: unknown): Promise<void> {
  // On ne met jamais en cache une reponse sans contenu utile (echec quota,
  // composant vide) : la prochaine tentative doit reinterroger l'API.
  if (kind === "component") {
    const code = (payload as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || code.length === 0) return;
  }
  if (kind === "theme") {
    const css = (payload as { css?: unknown } | null)?.css;
    if (typeof css !== "string" || css.length === 0) return;
  }
  await adminDb.collection(COLLECTION).doc(docId).set(
    {
      kind,
      payload,
      createdAt: FieldValue.serverTimestamp(),
      refreshedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function getComponentCached(id: string): Promise<{ payload: Awaited<ReturnType<typeof getComponent>>; cached: boolean }> {
  const docId = `component-${id}`;
  const cached = await readCache<Awaited<ReturnType<typeof getComponent>>>(docId, "component");
  if (cached) return { payload: cached, cached: true };
  const payload = await getComponent(id);
  await writeCache(docId, "component", payload);
  return { payload, cached: false };
}

export async function getThemeCached(id: string): Promise<{ payload: Awaited<ReturnType<typeof getTheme>>; cached: boolean }> {
  const docId = `theme-${id}`;
  const cached = await readCache<Awaited<ReturnType<typeof getTheme>>>(docId, "theme");
  if (cached) return { payload: cached, cached: true };
  const payload = await getTheme(id);
  await writeCache(docId, "theme", payload);
  return { payload, cached: false };
}
