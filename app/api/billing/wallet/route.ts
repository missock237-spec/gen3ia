import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { getWallet } from "@/lib/billing/wallet";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const wallet = await getWallet(token.uid);
    return Response.json({ success: true, wallet });
  } catch (error) {
    return Response.json(errorBody(error, "Could not load wallet"), { status: errorStatus(error, 400) });
  }
}
