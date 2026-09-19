import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { getAgentForOwner } from "@/lib/agents/repository";
import {
  attachExistingTwilioNumber,
  listAgentPhoneNumbers,
  purchaseNumberForAgent,
  releaseAgentPhoneNumber,
  searchAvailableNumbers,
} from "@/lib/integrations/twilio/numbers";

export const runtime = "nodejs";

const PurchaseSchema = z.object({
  agentId: z.string().min(1),
  phoneNumber: z.string().min(8),
});

const AttachSchema = PurchaseSchema.extend({ source: z.literal("own") });
const ReleaseSchema = z.object({ id: z.string().min(1) });

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const agentId = request.nextUrl.searchParams.get("agentId") ?? undefined;
    const country = request.nextUrl.searchParams.get("country");
    if (country) {
      const numbers = await searchAvailableNumbers(country, request.nextUrl.searchParams.get("areaCode") ?? undefined);
      return NextResponse.json({ numbers, monthlyPriceMinor: Number(process.env.GEN3IA_PHONE_NUMBER_PRICE_MINOR ?? 5000), currency: process.env.GEN3IA_WALLET_CURRENCY ?? "XAF" });
    }
    return NextResponse.json({ numbers: await listAgentPhoneNumbers(user.uid, agentId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Phone numbers unavailable." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = await request.json();
    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    if (!agentId || !(await getAgentForOwner(user.uid, agentId))) return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
    if (body?.source === "own") {
      const parsed = AttachSchema.safeParse(body);
      if (!parsed.success) return NextResponse.json({ error: "Invalid phone number data." }, { status: 400 });
      const record = await attachExistingTwilioNumber({ ownerId: user.uid, agentId: parsed.data.agentId, phoneNumber: parsed.data.phoneNumber });
      return NextResponse.json({ number: record });
    }

    const parsed = PurchaseSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid phone number data." }, { status: 400 });
    const record = await purchaseNumberForAgent({ ownerId: user.uid, agentId: parsed.data.agentId, phoneNumber: parsed.data.phoneNumber });
    return NextResponse.json({ number: record });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Phone number operation failed." }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = ReleaseSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid number id." }, { status: 400 });
    await releaseAgentPhoneNumber(user.uid, parsed.data.id);
    return NextResponse.json({ released: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Release failed." }, { status: 400 });
  }
}
