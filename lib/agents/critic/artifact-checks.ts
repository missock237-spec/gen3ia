import {
  getArtifactById,
} from "@/lib/documents/repository";

export interface ArtifactCheckResult {
  passed: boolean;

  issues: string[];

  artifactId?: string;
}

export async function checkArtifact(
  userId: string,
  artifactId: string,
  expectedFormat?: string,
): Promise<ArtifactCheckResult> {
  const issues: string[] = [];

  try {
    const artifact =
      await getArtifactById(
        userId,
        artifactId,
      );

    if (
      !artifact
    ) {
      issues.push(
        "Artifact does not exist.",
      );

      return {
        passed: false,
        issues,
      };
    }

    if (
      artifact.sizeBytes <= 0
    ) {
      issues.push(
        "Artifact is empty.",
      );
    }

    if (
      expectedFormat &&
      artifact.format !==
        expectedFormat
    ) {
      issues.push(
        `Expected ${expectedFormat}, received ${artifact.format}.`,
      );
    }

    if (
      !artifact.storagePath
    ) {
      issues.push(
        "Artifact has no storage path.",
      );
    }

    // Note: validation results are enforced at artifact creation time
    // (engine.ts throws on invalid artifacts) and are not persisted.
    return {
      passed:
        issues.length === 0,

      issues,

      artifactId,
    };
  } catch (error) {
    return {
      passed: false,

      issues: [
        error instanceof Error
          ? error.message
          : "Artifact validation failed.",
      ],

      artifactId,
    };
  }
        }
