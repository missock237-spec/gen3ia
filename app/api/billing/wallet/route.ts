import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { getWallet } from "@/lib/billing/wallet";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const wallet = await getWallet(token.uid);
    return Response.json({ success: true, wallet });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load wallet";
    const status = message.includes("authorization") || message.includes("token") ? 401 : 400;
    return Response.json({ error: message }, { status });
  }
}
