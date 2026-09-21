import { constants } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export async function publishFileAtomically(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const sourceMode = (await stat(source)).mode;
    await chmod(temporary, sourceMode);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const [source, ...destinations] = process.argv.slice(2);
  if (!source || destinations.length === 0) {
    throw new Error("Usage: publish-native.ts <source> <destination> [destination ...]");
  }
  for (const destination of destinations) await publishFileAtomically(source, destination);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
