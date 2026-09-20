import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageDirectory = resolve("native/npm/linux-x64-gnu");
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const rootManifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const binaryPath = resolve(packageDirectory, manifest.main);
const nativeAvailable = process.platform === "linux" && process.arch === "x64" && existsSync(binaryPath);

describe("native platform package", () => {
  it("matches the main package version and declares its target", () => {
    expect(manifest.name).toBe("@live1206/pi-edit-accelerator-linux-x64-gnu");
    expect(manifest.version).toBe(rootManifest.version);
    expect(manifest.os).toEqual(["linux"]);
    expect(manifest.cpu).toEqual(["x64"]);
    expect(manifest.libc).toEqual(["glibc"]);
    expect(manifest.files).toContain(manifest.main);
  });

  it.skipIf(!nativeAvailable)("loads the packaged binary", () => {
    const require = createRequire(import.meta.url);
    const binding = require(packageDirectory) as {
      planAsciiEdits(content: Buffer, edits: Array<{ oldText: string; newText: string }>): unknown;
    };
    expect(binding.planAsciiEdits(Buffer.from("before\n"), [{ oldText: "before", newText: "after!" }]))
      .toBeDefined();
  });
});
