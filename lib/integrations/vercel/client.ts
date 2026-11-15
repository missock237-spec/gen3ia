const VERCEL_API =
  "https://api.vercel.com";

function getToken() {
  const token =
    process.env.VERCEL_TOKEN;

  if (!token) {
    throw new Error(
      "VERCEL_TOKEN is not configured.",
    );
  }

  return token;
}

async function vercelFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response =
    await fetch(
      `${VERCEL_API}${path}`,
      {
        ...init,

        headers: {
          Authorization:
            `Bearer ${getToken()}`,

          "Content-Type":
            "application/json",

          ...init?.headers,
        },
      },
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Vercel API ${response.status}: ${body}`,
    );
  }

  return response.json() as Promise<T>;
}

export async function createVercelDeployment(
  params: {
    name: string;
    gitRepository: {
      type:
        | "github"
        | "gitlab"
        | "bitbucket";
      repo: string;
      ref?: string;
    };
    projectId?: string;
  },
) {
  const body: Record<
    string,
    unknown
  > = {
    name:
      params.name,

    gitSource: {
      type:
        params.gitRepository.type,

      repo:
        params.gitRepository.repo,

      ...(params.gitRepository.ref
        ? {
            ref:
              params.gitRepository.ref,
          }
        : {}),
    },
  };

  if (params.projectId) {
    body.project =
      params.projectId;
  }

  return vercelFetch(
    "/v13/deployments",
    {
      method: "POST",

      body:
        JSON.stringify(body),
    },
  );
}
