import "server-only";

/**
 * CLIENT HTTP JULES (Google, jules.google) — Task 121.
 *
 * Wrapper fetch RÉUTILISABLE (pas un tool) : les fonctions service du dépôt
 * (moteur conversationnel, file de suivi) partagent la même authentification
 * X-Goog-Api-Key et la même base v1alpha que les tools jules.* du registre.
 *
 * API réelle : https://jules.googleapis.com/v1alpha
 *  - POST /sessions  { sourceContext: { source: "repos/owner/repo",
 *    githubRepo: { owner, repo } }, prompt, startingBranch? } → { name, state }
 *  - GET /sessions/{name} → { state, outputs: [{ url, type }], errorMessage }
 *
 * Jules est un agent de code ASYNCHRONE : une session clone le dépôt, travaille
 * sur le prompt, puis produit des sorties (patchs / pull requests). Le
 * lancement est fire-and-track — le suivi passe par julesGetSession.
 */

const DEFAULT_JULES_API_BASE = "https://jules.googleapis.com/v1alpha";

/** Base de l'API Jules (surcharge possible via JULES_API_BASE_URL). */
export function julesApiBaseUrl(): string {
  return process.env.JULES_API_BASE_URL?.trim() || DEFAULT_JULES_API_BASE;
}

/** La clé JULES est-elle configurée dans cet environnement ? (lecture dynamique) */
export function isJulesConfigured(): boolean {
  return Boolean(process.env.JULES_API_KEY?.trim());
}

function apiKey(): string {
  const value = process.env.JULES_API_KEY?.trim();
  if (!value) throw new Error("JULES_API_KEY is not configured.");
  return value;
}

async function julesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${julesApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jules API ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<T>;
}

/** Dépôt GitHub au format owner/repo, validé. */
export interface JulesRepo {
  owner: string;
  repo: string;
}

/** Paramètres de création d'une session Jules. */
export interface JulesCreateSessionInput {
  /** Dépôt cible au format « owner/repo ». */
  githubRepo: string;
  /** Consigne de développement transmise à Jules (bornée par l'appelant). */
  prompt: string;
  /** Branche de départ optionnelle (sinon branche par défaut du dépôt). */
  startingBranch?: string;
}

/** Snapshot d'une session Jules renvoyé par GET /sessions/{name}. */
export interface JulesSessionSnapshot {
  /** Nom complet de la session (ex. « sessions/<id> »). */
  name?: string;
  state?: string;
  outputs?: Array<{ url?: string; type?: string; description?: string }>;
  errorMessage?: string;
}

/** Résultat de la création d'une session. */
export interface JulesSessionCreated {
  /** Nom de session à suivre (GET /sessions/{name}). */
  session: string;
  state?: string;
}

/** Découpe « owner/repo » en parties valides (identiques au tool jules.create_task). */
export function parseGithubRepo(githubRepo: string): JulesRepo {
  const [owner, ...rest] = githubRepo.split("/");
  const repo = rest.join("/");
  if (!owner || !repo) throw new Error("githubRepo must use the 'owner/repo' format.");
  return { owner, repo };
}

/**
 * Crée une session Jules (POST /sessions) — le clone, le travail et les
 * sorties (patch/PR) sont asynchrones côté Google.
 */
export async function julesCreateSession(input: JulesCreateSessionInput): Promise<JulesSessionCreated> {
  const { owner, repo } = parseGithubRepo(input.githubRepo);
  const data = await julesFetch<{ name?: string; id?: string; state?: string }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      sourceContext: { source: `repos/${owner}/${repo}`, githubRepo: { owner, repo } },
      prompt: input.prompt,
      ...(input.startingBranch ? { startingBranch: input.startingBranch } : {}),
    }),
  });
  return { session: data.name ?? data.id ?? "", state: data.state };
}

/**
 * Lit l'état courant d'une session Jules (GET /sessions/{name}).
 * Le nom peut être nu (« <id> ») ou complet (« sessions/<id> »).
 */
export async function julesGetSession(session: string): Promise<JulesSessionSnapshot> {
  const name = session.replace(/^\/+/, "").replace(/^sessions\/?/, "");
  return julesFetch<JulesSessionSnapshot>(`/sessions/${encodeURIComponent(name)}`);
}
