import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import {
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  listOutgoingWebhooks,
  OUTGOING_WEBHOOK_EVENTS,
  WebhookEventsSchema,
  setOutgoingWebhookDisabled,
} from "@/lib/integrations/webhooks/store";

const CreateSchema = z.object({
  url: z.string().min(8).max(2048),
  events: WebhookEventsSchema,
  description: z.string().max(200).optional(),
});

const UpdateSchema = z.object({
  webhookId: z.string().min(1).max(128),
  disabled: z.boolean().optional(),
});

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const webhooks = await listOutgoingWebhooks(guard.context.userId);
    return NextResponse.json({ webhooks, availableEvents: OUTGOING_WEBHOOK_EVENTS }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to list webhooks." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = CreateSchema.parse(await request.json());
    const webhook = await createOutgoingWebhook({
      ownerId: guard.context.userId,
      url: body.url,
      events: body.events,
      description: body.description,
    });
    // Le secret n'est retourné qu'une seule fois, à la création.
    return NextResponse.json({ webhook: { ...webhook, secret: webhook.secret } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create the webhook." }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = UpdateSchema.parse(await request.json());
    if (body.disabled !== undefined) {
      await setOutgoingWebhookDisabled(guard.context.userId, body.webhookId, body.disabled);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update the webhook." }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  try {
    const body = UpdateSchema.parse(await request.json());
    await deleteOutgoingWebhook(guard.context.userId, body.webhookId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to delete the webhook." }, { status: 400 });
  }
}
