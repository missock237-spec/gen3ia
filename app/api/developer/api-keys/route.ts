import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { hashDeveloperApiKey, issueDeveloperApiKey } from "@/lib/extensions/developer-keys";
import { listDeveloperApiKeys, revokeDeveloperApiKey, revokeDeveloperApiKeyByPrefix } from "@/lib/extensions/repository";

/**
 * Developer SDK/API keys (Developer Studio only — Firebase session required).
 * GET    — list keys (prefix + metadata only, never the plaintext).
 * POST   — issue a key; the plaintext is returned exactly once. Body: { name }
 * DELETE — revoke a key. Body: { key } (the full plaintext key to revoke).
 */
export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const keys = await listDeveloperApiKeys(token.uid);
    return NextResponse.json({ keys });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 100) : "clé SDK";
    const issued = await issueDeveloperApiKey(token.uid, name);
    return NextResponse.json({
      key: issued.key,
      prefix: issued.prefix,
      name: issued.name,
      warning: "Conservez cette clé maintenant : elle ne sera plus jamais affichée.",
    }, { status: 201 });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const body = (await request.json().catch(() => ({}))) as { key?: unknown; prefix?: unknown };
    // Preferred: revoke by visible prefix (UI flow). Fallback: full plaintext key.
    if (typeof body.prefix === "string" && body.prefix.trim()) {
      await revokeDeveloperApiKeyByPrefix(body.prefix.trim(), token.uid);
      return NextResponse.json({ ok: true });
    }
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key.startsWith("g3x_")) {
      return NextResponse.json({ error: "Clé SDK invalide." }, { status: 400 });
    }
    await revokeDeveloperApiKey(hashDeveloperApiKey(key), token.uid);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return extensionApiError(error);
  }
}
