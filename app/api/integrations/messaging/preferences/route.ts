import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { getMessagingPreferences, setMessagingPreferences } from "@/lib/integrations/messaging/preferences";
import { getMessagingChannelStatus } from "@/lib/integrations/messaging";

const PutSchema = z.object({
  channel: z.enum(["whatsapp", "telegram", "slack"]),
  recipient: z.string().trim().min(3).max(128).regex(/^[\w@+.:|#\-\[\]]+$/, "Destinataire invalide."),
  approvalsEnabled: z.boolean().default(true),
});

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const preferences = await getMessagingPreferences(guard.context.userId);
    return NextResponse.json({ preferences, channelStatus: getMessagingChannelStatus() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read messaging preferences." }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = PutSchema.parse(await request.json());
    const preferences = await setMessagingPreferences(guard.context.userId, body);
    return NextResponse.json({ preferences });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save messaging preferences." }, { status: 400 });
  }
}
