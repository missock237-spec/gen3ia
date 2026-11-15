export class ArtifactAccessDeniedError extends Error {
  constructor() {
    super("Artifact access denied");
    this.name = "ArtifactAccessDeniedError";
  }
}

export interface OwnedArtifact {
  ownerId: string;
}

export function assertArtifactOwner(
  artifact: OwnedArtifact,
  userId: string,
): void {
  if (artifact.ownerId !== userId) {
    throw new ArtifactAccessDeniedError();
  }
}
