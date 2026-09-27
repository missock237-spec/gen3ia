import fs from "node:fs/promises";
import archiver from "archiver";

export async function buildWorkspaceZip(
  workspaceRoot: string,
  outputPath: string
): Promise<void> {
  const output =
    await fs.open(
      outputPath,
      "w"
    );

  const stream =
    output.createWriteStream();

  const archive =
    archiver("zip", {
      zlib: {
        level: 6,
      },
    });

  return new Promise(
    (resolve, reject) => {
      stream.on(
        "close",
        async () => {
          await output.close();
          resolve();
        }
      );

      archive.on(
        "error",
        async (error) => {
          await output.close();
          reject(error);
        }
      );

      archive.pipe(stream);

      archive.directory(
        workspaceRoot,
        false
      );

      archive.finalize();
    }
  );
}
