import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { protectRoute } from "@/lib/security/route-guard";
import { generateForUser } from "@/lib/billing/ai-execution";
import { createActionApproval } from "@/lib/agents/action-approvals";
import { getAdsTools } from "@/lib/integrations/composio/ads";
import { errorStatus } from "@/lib/security/http-errors";

const Schema = z.object({
  objective: z.string().min(10).max(4000),
  provider: z.enum(["google_ads", "meta_ads", "tiktok_ads"]),
  accountId: z.string().min(1).max(200),
  destinationUrl: z.string().url(),
  audience: z.string().max(2000).optional(),
  budgetMinor: z.number().int().positive().max(100000000).optional(),
});

const ProposalSchema = z.object({
  name: z.string().min(1).max(200),
  primaryText: z.string().min(1).max(5000),
  headline: z.string().min(1).max(500),
  callToAction: z.string().min(1).max(100),
  riskNotes: z.array(z.string().max(1000)).max(20),
  toolSlug: z.string().min(3).max(200),
  toolArguments: z.record(z.string(), z.unknown()),
});

function compactAdsTools(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).map((tool) => {
    const item = tool as Record<string, unknown>;
    return {
      slug: typeof item.slug === "string" ? item.slug : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      description: typeof item.description === "string" ? item.description.slice(0, 1200) : undefined,
      inputParameters: item.inputParameters,
    };
  });
}

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  try {
    const input = Schema.parse(await request.json());
    const executionId = randomUUID();
    const availableTools = compactAdsTools(await getAdsTools(guard.context.userId, input.provider));
    if (availableTools.length === 0) throw new Error(`No ${input.provider} Composio tools are available for this account.`);

    const generated = await generateForUser({
      userId: guard.context.userId,
      executionId,
      complexity: 1.35,
      request: {
        task: "agent",
        maxTokens: 4096,
        requiresStructuredOutput: true,
        messages: [
          {
            role: "system",
            content: "You are Gen3ia Ads Agent. Create compliant advertising copy and one executable campaign/ad action proposal. Never invent product claims, prices, guarantees, targeting eligibility or platform approval. Do not publish anything. Select exactly one toolSlug from AVAILABLE_TOOLS and construct toolArguments using its schema. The action will require human approval before execution. Return strict JSON with name, primaryText, headline, callToAction, riskNotes, toolSlug and toolArguments.",
          },
          {
            role: "user",
            content: JSON.stringify({ request: input, availableTools }),
          },
        ],
      },
    });

    const parsed = ProposalSchema.parse(JSON.parse(generated.response.text));
    const selected = availableTools.find((tool) => tool.slug === parsed.toolSlug);
    if (!selected) throw new Error("The generated Ads action selected an unavailable Composio tool.");

    const approval = await createActionApproval({
      ownerId: guard.context.userId,
      executionId,
      role: "content",
      toolSlug: "ads.publish",
      arguments: {
        provider: input.provider,
        accountId: input.accountId,
        destinationUrl: input.destinationUrl,
        name: parsed.name,
        primaryText: parsed.primaryText,
        headline: parsed.headline,
        callToAction: parsed.callToAction,
        dailyBudgetMinor: input.budgetMinor ?? 1000,
        toolSlug: parsed.toolSlug,
        arguments: parsed.toolArguments,
      },
      reason: `Publication Ads demandée par l'agent pour: ${input.objective}`,
    });

    return NextResponse.json({ executionId, proposal: parsed, approvalId: approval.id, requiresHumanApproval: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Ad generation failed" }, { status: errorStatus(error, 400) });
  }
}
