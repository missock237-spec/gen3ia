import { NextResponse } from "next/server";

import { HttpError } from "@/lib/security/http-errors";

export function extensionApiError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "Invalid request.";

  // Erreurs typées d'abord : leur statut est autoritaire (403 CSRF,
  // 401 auth, 503 infra) et ne doit jamais être ré-interprété par les
  // heuristiques de message ci-dessous.
  if (error instanceof HttpError) {
    return NextResponse.json({ error: message }, { status: error.status });
  }

  if (/authorization|token|revoked|scheme|API key|api key/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 401 });
  }

  if (/Developer access required|Only the developer|Administrator|not the owner/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 403 });
  }

  if (/not found|not found\.|does not exist|not installed/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 404 });
  }

  if (
    /already exists|Invalid|invalid|required|must |exceeds|not allowed|denied|quota|rate limit|expired|requires a purchase|not active|not available|not configured/i.test(
      message,
    )
  ) {
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ error: message }, { status: 500 });
}
