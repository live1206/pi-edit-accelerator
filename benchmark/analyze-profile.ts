import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber?: number };
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

interface Timing {
  functionName: string;
  url: string;
  selfTimeMs: number;
  inclusiveTimeMs: number;
  samples: number;
}

function parseArgs(args: string[]): { profile: string; output?: string } {
  const profile = args[0];
  if (!profile) throw new Error("Usage: analyze-profile.ts <profile> [--output <json>]");
  if (args.length === 1) return { profile: resolve(profile) };
  if (args.length === 3 && args[1] === "--output" && args[2]) {
    return { profile: resolve(profile), output: resolve(args[2]) };
  }
  throw new Error("Usage: analyze-profile.ts <profile> [--output <json>]");
}

const options = parseArgs(process.argv.slice(2));
const profile = JSON.parse(await readFile(options.profile, "utf8")) as CpuProfile;
const samples = profile.samples ?? [];
const deltas = profile.timeDeltas ?? [];
if (samples.length !== deltas.length) throw new Error("Profile samples and time deltas differ");
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
const timings = new Map<string, Timing>();
const getTiming = (node: ProfileNode): Timing => {
  const functionName = node.callFrame.functionName || "(anonymous)";
  const url = node.callFrame.url || "(native)";
  const key = `${functionName}\0${url}`;
  const existing = timings.get(key);
  if (existing) return existing;
  const timing = { functionName, url, selfTimeMs: 0, inclusiveTimeMs: 0, samples: 0 };
  timings.set(key, timing);
  return timing;
};
for (let index = 0; index < samples.length; index++) {
  const node = nodes.get(samples[index]!);
  if (!node) continue;
  const elapsed = deltas[index]! / 1_000;
  const self = getTiming(node);
  self.selfTimeMs += elapsed;
  self.samples++;
  const seen = new Set<string>();
  let current: ProfileNode | undefined = node;
  while (current) {
    const timing = getTiming(current);
    const key = `${timing.functionName}\0${timing.url}`;
    if (!seen.has(key)) {
      timing.inclusiveTimeMs += elapsed;
      seen.add(key);
    }
    const parentId = parents.get(current.id);
    current = parentId === undefined ? undefined : nodes.get(parentId);
  }
}
const ranked = [...timings.values()].sort((left, right) => right.selfTimeMs - left.selfTimeMs);
const report = {
  schemaVersion: 1,
  profile: options.profile,
  samples: samples.length,
  sampledTimeMs: deltas.reduce((total, value) => total + value, 0) / 1_000,
  topSelfTime: ranked.slice(0, 50),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, json);
} else process.stdout.write(json);
