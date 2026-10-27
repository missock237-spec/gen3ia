const GITHUB_API =
  "https://api.github.com";

function getToken(): string {
  const token =
    process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured.",
    );
  }

  return token;
}

async function githubFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response =
    await fetch(
      `${GITHUB_API}${path}`,
      {
        ...init,

        // Timeout (audit 2026-10-28) : l'API GitHub qui pend ne retient
        // pas la requête de l'utilisateur. Un signal appelant est respecté.
        signal: init?.signal ?? AbortSignal.timeout(20_000),

        headers: {
          Accept:
            "application/vnd.github+json",

          Authorization:
            `Bearer ${getToken()}`,

          "X-GitHub-Api-Version":
            "2026-03-10",

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
      `GitHub API ${response.status}: ${body}`,
    );
  }

  return response.json() as Promise<T>;
}

export async function createRepository(
  params: {
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  },
) {
  return githubFetch(
    "/user/repos",
    {
      method: "POST",

      body: JSON.stringify({
        name:
          params.name,

        description:
          params.description ??
          "",

        private:
          params.private ??
          true,

        auto_init:
          params.autoInit ??
          true,
      }),
    },
  );
}

export async function getRepository(
  owner: string,
  repo: string,
) {
  return githubFetch(
    `/repos/${encodeURIComponent(
      owner,
    )}/${encodeURIComponent(repo)}`,
  );
}

export async function createOrUpdateFile(
  params: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
    sha?: string;
  },
) {
  return githubFetch(
    `/repos/${encodeURIComponent(
      params.owner,
    )}/${encodeURIComponent(
      params.repo,
    )}/contents/${params.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "PUT",

      body: JSON.stringify({
        message:
          params.message,

        content:
          Buffer.from(
            params.content,
            "utf8",
          ).toString("base64"),

        branch:
          params.branch,

        ...(params.sha
          ? {
              sha:
                params.sha,
            }
          : {}),
      }),
    },
  );
}
