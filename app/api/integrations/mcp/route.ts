import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import {
  addUserServer,
  listUserServers,
  refreshUserServer,
  removeUserServer,
  toggleUserServer,
  McpServiceError,
  mcpServiceErrorStatus,
} from "@/lib/integrations/mcp/service";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * Gestion des serveurs MCP (Model Context Protocol) de l'utilisateur :
 *  - GET    : liste des serveurs (en-têtes masqués) + leurs outils découverts.
 *             ?id=<serverId> → DÉTAIL des outils du serveur (Task 143 : viewer
 *             UI avec descriptions et schémas d'entrée) ;
 *  - POST   : ajout d'un serveur — poignée de main MCP + découverte des outils ;
 *  - PATCH  : activer/désactiver ou rafraîchir (re-découverte des outils) ;
 *  - DELETE : suppression (?id=...).
 */

export const runtime = "nodejs";

const AddSchema = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().url().max(2_000),
  headers: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(2_000)).optional().default({}),
});

const PatchSchema = z.union([
  z.object({ id: z.string().trim().min(1).max(128), action: z.literal("toggle"), enabled: z.boolean() }),
  z.object({ id: z.string().trim().min(1).max(128), action: z.literal("refresh") }),
]);

function mcpErrorStatusOf(error: McpServiceError): number {
  return mcpServiceErrorStatus(error.code);
}

function toClient(server: Awaited<ReturnType<typeof listUserServers>>[number]) {
  return { ...server, toolCount: server.tools.length };
}

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "mcp", rateLimit: { limit: 120, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    // Task 143 — axe 4 : détail des outils d'UN serveur (viewer UI) — les
    // schémas d'entrée réels sont exposés au propriétaire (jamais les headers).
    const detailId = new URL(request.url).searchParams.get("id")?.trim();
    if (detailId) {
      const servers = await listUserServers(guard.context.userId);
      const server = servers.find((item) => item.id === detailId);
      if (!server) return NextResponse.json({ error: "Serveur MCP introuvable." }, { status: 404 });
      return NextResponse.json(
        { server: { ...server, toolCount: server.tools.length } },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const servers = await listUserServers(guard.context.userId);
    return NextResponse.json({ servers: servers.map(toClient) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Liste des serveurs MCP indisponible." }, { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "mcp", rateLimit: { limit: 30, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const input = AddSchema.parse(await request.json());
    const server = await addUserServer(guard.context.userId, input);
    return NextResponse.json({ server: toClient(server) }, { status: 201 });
  } catch (error) {
    if (error instanceof McpServiceError) return NextResponse.json({ error: error.message }, { status: mcpErrorStatusOf(error) });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Données de serveur invalides (nom, URL, en-têtes)." }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Ajout du serveur MCP impossible." }, { status: errorStatus(error, 500) });
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await protectRoute(request, { key: "mcp", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const input = PatchSchema.parse(await request.json());
    if (input.action === "toggle") {
      await toggleUserServer(guard.context.userId, input.id, input.enabled);
      return NextResponse.json({ ok: true });
    }
    const server = await refreshUserServer(guard.context.userId, input.id);
    return NextResponse.json({ server: toClient(server) });
  } catch (error) {
    if (error instanceof McpServiceError) return NextResponse.json({ error: error.message }, { status: mcpErrorStatusOf(error) });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Requête de mise à jour invalide." }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Mise à jour impossible." }, { status: errorStatus(error, 500) });
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request, { key: "mcp", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
  try {
    await removeUserServer(guard.context.userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof McpServiceError) return NextResponse.json({ error: error.message }, { status: mcpErrorStatusOf(error) });
    return NextResponse.json({ error: "Suppression impossible." }, { status: 500 });
  }
}
