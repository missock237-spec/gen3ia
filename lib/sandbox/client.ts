import crypto from "node:crypto";

import type {
  SandboxJob,
  SandboxResult
} from "./types";

function getConfig() {
  const url = process.env.SANDBOX_URL;
  const secret = process.env.SANDBOX_SHARED_SECRET;

  if (!url) {
    throw new Error("SANDBOX_URL is missing");
  }

  if (!secret) {
    throw new Error("SANDBOX_SHARED_SECRET is missing");
  }

  return { url: url.replace(/\/$/, ""), secret };
}

function sign(body: string, timestamp: string, secret: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export async function executeSandbox(
  job: SandboxJob
): Promise<SandboxResult> {
  const { url, secret } = getConfig();
  const body = JSON.stringify(job);
  const timestamp = String(Date.now());
  const requestId = crypto.randomUUID();
  const signature = sign(body, timestamp, secret);

  const response = await fetch(`${url}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gen3ia-timestamp": timestamp,
      "x-gen3ia-signature": signature,
      "x-gen3ia-request-id": requestId
    },
    body,
    signal: AbortSignal.timeout(job.limits.timeoutMs + 10_000)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sandbox error ${response.status}: ${text.slice(0, 2000)}`);
  }

  return response.json() as Promise<SandboxResult>;
}
