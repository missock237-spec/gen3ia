const RENDER_API =
  "https://api.render.com/v1";

function getApiKey() {
  const key =
    process.env.RENDER_API_KEY;

  if (!key) {
    throw new Error(
      "RENDER_API_KEY is not configured.",
    );
  }

  return key;
}

async function renderFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response =
    await fetch(
      `${RENDER_API}${path}`,
      {
        ...init,

        headers: {
          Authorization:
            `Bearer ${getApiKey()}`,

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
      `Render API ${response.status}: ${body}`,
    );
  }

  return response.json() as Promise<T>;
}

export async function createRenderService(
  params: {
    name: string;
    ownerId: string;
    repo: string;
    branch?: string;
    type?:
      | "web_service"
      | "static_site"
      | "private_service"
      | "background_worker";
  },
) {
  return renderFetch(
    "/services",
    {
      method: "POST",

      body: JSON.stringify({
        name:
          params.name,

        ownerId:
          params.ownerId,

        type:
          params.type ??
          "web_service",

        repo:
          params.repo,

        branch:
          params.branch,

        autoDeploy:
          "yes",
      }),
    },
  );
}

export async function deployRenderService(
  serviceId: string,
) {
  return renderFetch(
    `/services/${encodeURIComponent(
      serviceId,
    )}/deploys`,
    {
      method: "POST",

      body: JSON.stringify({
        clearCache:
          "do_not_clear",
      }),
    },
  );
}
