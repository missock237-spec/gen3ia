import type { DocumentPlan } from "../types";
import { neutralizeCsvCell } from "./safe-cell";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function generateTextArtifact(
  plan: DocumentPlan,
): Buffer {
  switch (plan.format) {
    case "json":
      return Buffer.from(
        JSON.stringify(plan, null, 2),
        "utf8",
      );

    case "csv":
      return generateCsv(plan);

    case "txt":
      return generateTxt(plan);

    case "md":
      return generateMarkdown(plan);

    case "html":
      return generateHtml(plan);

    default:
      throw new Error(
        `Unsupported text format: ${plan.format}`,
      );
  }
}

function generateCsv(plan: DocumentPlan): Buffer {
  const table = plan.blocks.find(
    (block) => block.type === "table",
  );

  if (!table) {
    throw new Error(
      "CSV generation requires at least one table block.",
    );
  }

  const rows: string[][] = [];

  if (table.columns) {
    rows.push(table.columns);
  }

  rows.push(...(table.rows ?? []));

  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          // Injection de formules neutralisée (anti CSV-injection OWASP).
          const value = neutralizeCsvCell(String(cell ?? ""));
          return `"${value.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\n");

  return Buffer.from(`${csv}\n`, "utf8");
}

function generateTxt(plan: DocumentPlan): Buffer {
  const output: string[] = [];

  output.push(plan.title);
  output.push("");

  for (const block of plan.blocks) {
    if (block.type === "heading") {
      output.push(block.text ?? "");
      output.push("");
      continue;
    }

    if (block.type === "list") {
      for (const item of block.items ?? []) {
        output.push(`- ${item}`);
      }

      output.push("");
      continue;
    }

    if (block.type === "table") {
      if (block.columns) {
        output.push(block.columns.join(" | "));
      }

      for (const row of block.rows ?? []) {
        output.push(row.join(" | "));
      }

      output.push("");
      continue;
    }

    if (block.text) {
      output.push(block.text);
      output.push("");
    }
  }

  return Buffer.from(output.join("\n"), "utf8");
}

function generateMarkdown(plan: DocumentPlan): Buffer {
  const output: string[] = [];

  output.push(`# ${plan.title}`);
  output.push("");

  for (const block of plan.blocks) {
    switch (block.type) {
      case "heading":
        output.push(
          `${"#".repeat(block.level ?? 2)} ${block.text ?? ""}`,
        );
        output.push("");
        break;

      case "paragraph":
      case "quote":
      case "code":
        output.push(block.text ?? "");
        output.push("");
        break;

      case "list":
        for (const [index, item] of (
          block.items ?? []
        ).entries()) {
          output.push(
            block.ordered
              ? `${index + 1}. ${item}`
              : `- ${item}`,
          );
        }

        output.push("");
        break;

      case "table": {
        const columns = block.columns ?? [];

        if (columns.length) {
          output.push(`| ${columns.join(" | ")} |`);

          output.push(
            `| ${columns
              .map(() => "---")
              .join(" | ")} |`,
          );

          for (const row of block.rows ?? []) {
            output.push(`| ${row.join(" | ")} |`);
          }

          output.push("");
        }

        break;
      }

      default:
        break;
    }
  }

  return Buffer.from(output.join("\n"), "utf8");
}

function generateHtml(plan: DocumentPlan): Buffer {
  const body = plan.blocks
    .map((block) => {
      if (block.type === "heading") {
        const level = block.level ?? 2;

        return `<h${level}>${escapeHtml(
          block.text ?? "",
        )}</h${level}>`;
      }

      if (block.type === "paragraph") {
        return `<p>${escapeHtml(
          block.text ?? "",
        )}</p>`;
      }

      if (block.type === "quote") {
        return `<blockquote>${escapeHtml(
          block.text ?? "",
        )}</blockquote>`;
      }

      if (block.type === "code") {
        return `<pre><code>${escapeHtml(
          block.text ?? "",
        )}</code></pre>`;
      }

      if (block.type === "list") {
        const tag = block.ordered ? "ol" : "ul";

        return `<${tag}>${(
          block.items ?? []
        )
          .map(
            (item) =>
              `<li>${escapeHtml(item)}</li>`,
          )
          .join("")}</${tag}>`;
      }

      if (block.type === "table") {
        const header = (block.columns ?? [])
          .map(
            (column) =>
              `<th>${escapeHtml(column)}</th>`,
          )
          .join("");

        const rows = (block.rows ?? [])
          .map(
            (row) =>
              `<tr>${row
                .map(
                  (cell) =>
                    `<td>${escapeHtml(cell)}</td>`,
                )
                .join("")}</tr>`,
          )
          .join("");

        return `
          <table>
            <thead><tr>${header}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }

      return "";
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(plan.title)}</title>
<style>
body {
  font-family: Arial, sans-serif;
  max-width: 1000px;
  margin: 40px auto;
  padding: 0 20px;
  line-height: 1.6;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th, td {
  border: 1px solid #ccc;
  padding: 8px;
}
pre {
  overflow-x: auto;
}
</style>
</head>
<body>
<h1>${escapeHtml(plan.title)}</h1>
${body}
</body>
</html>`;

  return Buffer.from(html, "utf8");
}
