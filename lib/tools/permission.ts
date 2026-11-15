import type {
  ToolRisk,
} from "./types";

export interface PermissionPolicy {
  allowLowRisk: boolean;
  allowMediumRisk: boolean;
  allowHighRisk: boolean;
  allowCriticalRisk: boolean;

  requireApprovalForHighRisk: boolean;
  requireApprovalForCriticalRisk: boolean;
}

export const DEFAULT_PERMISSION_POLICY:
  PermissionPolicy = {
    allowLowRisk: true,

    allowMediumRisk: true,

    allowHighRisk: true,

    allowCriticalRisk: false,

    requireApprovalForHighRisk: true,

    requireApprovalForCriticalRisk: true,
  };

export interface PermissionDecision {
  allowed: boolean;

  requiresApproval: boolean;

  reason: string;
}

export function checkPermission(
  risk: ToolRisk,
  policy:
    PermissionPolicy =
    DEFAULT_PERMISSION_POLICY,
): PermissionDecision {
  switch (risk) {
    case "low":
      return {
        allowed:
          policy.allowLowRisk,

        requiresApproval: false,

        reason:
          "Low-risk action.",
      };

    case "medium":
      return {
        allowed:
          policy.allowMediumRisk,

        requiresApproval: false,

        reason:
          "Medium-risk action.",
      };

    case "high":
      return {
        allowed:
          policy.allowHighRisk,

        requiresApproval:
          policy.requireApprovalForHighRisk,

        reason:
          "High-risk action.",
      };

    case "critical":
      return {
        allowed:
          policy.allowCriticalRisk,

        requiresApproval:
          policy.requireApprovalForCriticalRisk,

        reason:
          "Critical-risk action.",
      };
  }
}
