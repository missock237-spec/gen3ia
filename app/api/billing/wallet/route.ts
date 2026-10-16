import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { BILLING_ENABLED } from "@/lib/billing/billing-mode";
import { getWallet } from "@/lib/billing/wallet";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const wallet = await getWallet(token.uid);
    return Response.json({ success: true, wallet, billingEnabled: BILLING_ENABLED });
  } catch (error) {
    return Response.json(errorBody(error, "Could not load wallet"), { status: errorStatus(error, 400) });
  }
}
