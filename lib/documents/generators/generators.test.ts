import { describe, expect, it } from "vitest";
import { generateDocument } from "./index";
import type { DocumentPlan } from "../types";

describe("Document Generators Integration", () => {
  const samplePlan: DocumentPlan = {
    title: "Test Document Report",
    format: "pdf",
    blocks: [
      { type: "heading", level: 1, text: "Section 1: Overview" },
      { type: "paragraph", text: "This is a sample document for testing generators." },
      { type: "list", ordered: false, items: ["Item A", "Item B", "Item C"] },
      {
        type: "table",
        columns: ["Header 1", "Header 2"],
        rows: [
          ["Cell 1", "Cell 2"],
          ["Cell 3", "Cell 4"],
        ],
      },
    ],
  };

  it("should generate PDF document buffer", async () => {
    const buffer = await generateDocument({ ...samplePlan, format: "pdf" });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.toString("utf8", 0, 5)).toContain("%PDF-");
  });

  it("should generate DOCX document buffer", async () => {
    const buffer = await generateDocument({ ...samplePlan, format: "docx" });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("should generate XLSX document buffer", async () => {
    const buffer = await generateDocument({ ...samplePlan, format: "xlsx" });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("should generate PPTX document buffer", async () => {
    const buffer = await generateDocument({ ...samplePlan, format: "pptx" });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("should generate TXT, MD, CSV, JSON, HTML document buffers", async () => {
    const formats: Array<"txt" | "md" | "csv" | "json" | "html"> = ["txt", "md", "csv", "json", "html"];
    for (const fmt of formats) {
      const buffer = await generateDocument({ ...samplePlan, format: fmt });
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    }
  });

  it("should throw for ZIP in generateDocument", async () => {
    await expect(
      generateDocument({ ...samplePlan, format: "zip" }),
    ).rejects.toThrow("ZIP must be created through the ZIP engine.");
  });
});
