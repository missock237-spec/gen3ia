import { createHmac, timingSafeEqual } from "node:crypto";

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is not configured.");
  return value;
}

export function verifyPlivoSignature(request: Request, params: Record<string, string>) {
  const token = process.env.PLIVO_AUTH_TOKEN?.trim();
  const signature = request.headers.get("X-Plivo-Signature-V3")?.trim();
  const nonce = request.headers.get("X-Plivo-Signature-V3-Nonce")?.trim();
  if (!token || !signature || !nonce) return false;
  const url = request.url;
  const assembled = url + Object.keys(params).sort().map((key) => key + params[key]).join("") + nonce;
  const expected = createHmac("sha256", token).update(assembled).digest("base64");
  const signatures = signature.split(",").map((value) => value.trim()).filter(Boolean);
  return signatures.some((candidate) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export function buildPlivoXML(body: string) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response>' + body + "</Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function escapePlivoXML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function plivoConfig() {
  return { appUrl: requiredEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, "") };
}
