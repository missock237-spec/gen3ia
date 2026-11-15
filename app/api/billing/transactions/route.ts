import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { adminDb } from "@/lib/firebase/admin";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const snapshot = await adminDb.collection("walletLedger").where("userId", "==", token.uid).orderBy("createdAt", "desc").limit(limit).get();
    const transactions = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        type: String(data.type ?? "unknown"),
        amountMinor: Number(data.amountMinor ?? 0),
        currency: String(data.currency ?? "EUR"),
        provider: data.provider ? String(data.provider) : undefined,
        providerReference: data.providerReference ? String(data.providerReference).slice(0, 128) : undefined,
        reference: data.reference ? String(data.reference).slice(0, 128) : undefined,
        metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {},
        createdAt: typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : Date.now(),
      };
    });
    return Response.json({ success: true, transactions });
  } catch (error) {
    return Response.json(errorBody(error, "Could not load wallet transactions"), { status: errorStatus(error, 400) });
  }
}
