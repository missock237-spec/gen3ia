import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getAgentForOwner } from "@/lib/agents/repository";
import {
  attachExistingTwilioNumber,
  listAgentPhoneNumbers,
  purchaseNumberForAgent,
  releaseAgentPhoneNumber,
  searchAvailableNumbers,
} from "@/lib/integrations/twilio/numbers";
import { searchAvailablePlivoNumbers, purchasePlivoNumberForAgent, releasePlivoNumber } from "@/lib/integrations/plivo/numbers";

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
    const provider = request.nextUrl.searchParams.get("provider") ?? "twilio";
    if (country) {
      const numbers = provider === "plivo"
        ? await searchAvailablePlivoNumbers(country, request.nextUrl.searchParams.get("areaCode") ?? undefined)
        : await searchAvailableNumbers(country, request.nextUrl.searchParams.get("areaCode") ?? undefined);
      const pricing = (numbers[0] as { pricing?: { providerPriceUsdMinor: number; sellPriceUsdMinor: number; markupBps: number; currency: string; source: string } } | undefined)?.pricing ?? null;
      return NextResponse.json({
        provider,
        numbers,
        // Tarification margée (fournisseur + 20 %) quand disponible ;
        // repli sur le prix configuré historique sinon.
        ...(pricing
          ? { pricing: { providerPriceUsdMinor: pricing.providerPriceUsdMinor, sellPriceUsdMinor: pricing.sellPriceUsdMinor, markupBps: pricing.markupBps, currency: pricing.currency, source: pricing.source } }
          : { monthlyPriceMinor: Number(process.env.GEN3IA_PHONE_NUMBER_PRICE_MINOR ?? 5000), currency: process.env.GEN3IA_WALLET_CURRENCY ?? "XAF" }),
      });
    }
    return NextResponse.json({ numbers: await listAgentPhoneNumbers(user.uid, agentId) });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Phone numbers unavailable.") },
      { status: errorStatus(error, 500) },
    );
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
    const record = body?.provider === "plivo"
      ? await purchasePlivoNumberForAgent({ ownerId: user.uid, agentId: parsed.data.agentId, phoneNumber: parsed.data.phoneNumber })
      : await purchaseNumberForAgent({ ownerId: user.uid, agentId: parsed.data.agentId, phoneNumber: parsed.data.phoneNumber });
    return NextResponse.json({ number: record });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Phone number operation failed." }, { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = ReleaseSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid number id." }, { status: 400 });
    const snap = await (await import("@/lib/firebase/admin")).adminDb.collection("agentPhoneNumbers").doc(parsed.data.id).get();
    const record = snap.exists ? snap.data() as { provider?: string } : null;
    if (record?.provider === "plivo") await releasePlivoNumber(user.uid, parsed.data.id);
    else await releaseAgentPhoneNumber(user.uid, parsed.data.id);
    return NextResponse.json({ released: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Release failed." }, { status: errorStatus(error, 400) });
  }
}
