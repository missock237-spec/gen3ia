import { describe, expect, it } from "vitest";
import { createZip } from "./create";
import { analyzeZip } from "./analyzer";

describe("secure ZIP pipeline", () => {
  it("creates an archive that can be analyzed safely", async () => {
    const archive = await createZip([
      { filename: "src/index.ts", data: Buffer.from("export const ok = true;", "utf8") },
      { filename: "README.md", data: Buffer.from("Gen3ia", "utf8") },
    ]);

    const result = await analyzeZip(archive);
    expect(result.safe).toBe(true);
    expect(result.fileCount).toBe(2);
    expect(result.files.map((file) => file.path)).toEqual(["src/index.ts", "README.md"]);
    expect(result.textFiles).toEqual(expect.arrayContaining([
      { path: "src/index.ts", content: "export const ok = true;" },
      { path: "README.md", content: "Gen3ia" },
    ]));
  });
});
