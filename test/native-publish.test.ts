import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishFileAtomically } from "../benchmark/publish-native.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("native binary publication", () => {
  it("atomically replaces the destination without truncating its existing inode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-native-publish-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source.node");
    const destination = join(directory, "destination.node");
    const oldContent = Buffer.alloc(128 * 1024, 0x41);
    const newContent = Buffer.alloc(128 * 1024, 0x42);
    await writeFile(source, newContent);
    await writeFile(destination, oldContent);

    const oldHandle = await open(destination, "r");
    try {
      const oldInode = (await oldHandle.stat()).ino;
      await publishFileAtomically(source, destination);

      expect((await stat(destination)).ino).not.toBe(oldInode);
      expect(await readFile(destination)).toEqual(newContent);
      expect(await oldHandle.readFile()).toEqual(oldContent);
    } finally {
      await oldHandle.close();
    }
  });
});
