import {
  createRepository,
} from "@/lib/integrations/github/client";

import {
  createVercelDeployment,
} from "@/lib/integrations/vercel/client";

import {
  createRenderService,
} from "@/lib/integrations/render/client";

export interface ProjectDeploymentInput {
  name: string;

  description?: string;

  visibility:
    | "private"
    | "public";

  owner?: string;

  github?: boolean;

  vercel?: boolean;

  render?: boolean;

  renderOwnerId?: string;

  repository?: string;

  branch?: string;
}

export interface DeploymentResult {
  github?: unknown;

  vercel?: unknown;

  render?: unknown;
}

export async function deployProject(
  input: ProjectDeploymentInput,
): Promise<DeploymentResult> {
  const result:
    DeploymentResult = {};

  let repository =
    input.repository;

  if (
    input.github &&
    !repository
  ) {
    const github =
      await createRepository({
        name:
          input.name,

        description:
          input.description,

        private:
          input.visibility ===
          "private",

        autoInit:
          true,
      });

    result.github =
      github;

    const githubData =
      github as {
        full_name?: string;
      };

    repository =
      githubData.full_name;
  }

  if (
    input.vercel
  ) {
    if (!repository) {
      throw new Error(
        "A GitHub repository is required for Vercel deployment.",
      );
    }

    result.vercel =
      await createVercelDeployment({
        name:
          input.name,

        gitRepository: {
          type:
            "github",

          repo:
            repository,

          ref:
            input.branch,
        },
      });
  }

  if (
    input.render
  ) {
    if (!repository) {
      throw new Error(
        "A GitHub repository is required for Render deployment.",
      );
    }

    if (!input.renderOwnerId) {
      throw new Error(
        "RENDER owner ID is required.",
      );
    }

    result.render =
      await createRenderService({
        name:
          input.name,

        ownerId:
          input.renderOwnerId,

        repo:
          `https://github.com/${repository}`,

        branch:
          input.branch,

        type:
          "web_service",
      });
  }

  return result;
}
