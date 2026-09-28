import { NextRequest, NextResponse } from "next/server";

/**
 * Tunnel Sentry — /monitoring (Task 40, Rec 4).
 *
 * Les bloqueurs de publicités (uBlock et al.) jettent les requêtes sortantes
 * vers *.ingest.sentry.io : une fraction des erreurs réelles disparaissait
 * de la supervision. Ce tunnel relaie les enveloppes Sentry depuis NOTRE
 * propre origin, en neutre — `/monitoring` ne ressemble à aucune ressource
 * connue des listes de blocage.
 *
 * SÉCURITÉ (anti-proxy-ouvert) : la destination est verrouillée sur la
 * liste blanche des hôtes d'ingestion Sentry du projet. Tout autre hôte
 * est refusé 403. Le corps n'est ni lu ni transformé (opaque, content-type
 * applicatif Sentry), aucune donnée n'est loggée ici.
 *
 * Convention Sentry : enveloppe = ligne 1 JSON {dsn, ...} puis payload.
 * Le project_id est déduit du chemin du DSN, comme l'exige l'endpoint
 * /api/<projectId>/envelope/.
 */

const INGEST_HOST_SUFFIXES = [
  "ingest.de.sentry.io", // région EU du projet (DSN actuel)
  "ingest.sentry.io", // région US (repli si changement de région)
  "ingest.us.sentry.io",
];

const FORWARDED_HEADERS = [
  "x-sentry-auth",
  "x-forwarded-for",
  "content-type",
];

/** Vérifie qu'un hôte appartient à la liste blanche (suffixe exact). */
function isAllowedIngestHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return INGEST_HOST_SUFFIXES.some(
    (suffix) => lower === suffix || lower.endsWith(`.${suffix}`),
  );
}

interface EnvelopeHeader {
  dsn?: string;
}

function extractDsn(envelope: string): URL | null {
  const firstLine = envelope.slice(0, envelope.indexOf("\n") === -1 ? envelope.length : envelope.indexOf("\n"));
  if (!firstLine.trim()) return null;
  try {
    const header = JSON.parse(firstLine) as EnvelopeHeader;
    if (!header.dsn) return null;
    const url = new URL(header.dsn);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function relay(request: NextRequest): Promise<NextResponse> {
  let envelope: string;
  try {
    envelope = await request.text();
  } catch {
    return NextResponse.json({ error: "corps illisible" }, { status: 400 });
  }

  const dsn = extractDsn(envelope);
  if (!dsn) {
    return NextResponse.json({ error: "enveloppe invalide" }, { status: 400 });
  }

  if (!isAllowedIngestHost(dsn.hostname)) {
    return NextResponse.json({ error: "hôte d'ingestion non autorisé" }, { status: 403 });
  }

  const projectId = dsn.pathname.replace(/\//g, "");
  if (!/^[0-9]+$/.test(projectId)) {
    return NextResponse.json({ error: "project id invalide" }, { status: 400 });
  }

  const headers = new Headers({ "Content-Type": "application/x-sentry-envelope" });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(`${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/`, {
    method: "POST",
    headers,
    body: envelope,
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: { "x-gen3ia-sentry-relay": "1" },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    return await relay(request);
  } catch {
    // Le tunnel ne doit JAMAIS devenir une source d'erreurs visible :
    // on répond 502 silencieux, le SDK retentera de son côté.
    return new NextResponse(null, { status: 502 });
  }
}

/** Sondes de santé (supervision uptime sans générer d'erreurs). */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, tunnel: "sentry" });
}
