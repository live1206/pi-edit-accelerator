import { randomUUID } from "node:crypto";
import {
  createEditToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getExactEditInputKey,
  getExactEditPathKey,
  type PrefetchedExactEditFile,
  type PreparedExactEdit,
  tryExecuteExactEdit,
  tryPrefetchExactEditFile,
  tryPrepareExactEdit,
} from "../src/exact-edit.ts";
import { createEditAcceleratorStats, formatEditAcceleratorStats } from "../src/stats.ts";
import { exportEditAcceleratorStats } from "../src/stats-export.ts";

interface ExpiringPromise<T> {
  key: string;
  promise: Promise<T | undefined>;
  expiration?: ReturnType<typeof setTimeout>;
}

interface PrefetchPromise extends ExpiringPromise<PrefetchedExactEditFile> {
  start(): void;
  cancel(): void;
}

export default function editAccelerator(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());
  const stats = createEditAcceleratorStats();
  const processSessionId = randomUUID();
  let snapshotIntervalId = randomUUID();
  const previewStates = new WeakMap<object, { argsKey: string; pending: boolean; fallback: boolean }>();
  let prefetchedFile: PrefetchPromise | undefined;
  let preparedPreview: ExpiringPromise<PreparedExactEdit> | undefined;
  const clearPrefetchedFile = (): void => {
    if (prefetchedFile?.expiration) clearTimeout(prefetchedFile.expiration);
    prefetchedFile?.cancel();
    prefetchedFile = undefined;
  };
  const clearPreparedPreview = (): void => {
    if (preparedPreview?.expiration) clearTimeout(preparedPreview.expiration);
    preparedPreview = undefined;
  };

  pi.registerTool({
    ...builtInEdit,
    renderCall(args, theme, context) {
      const argsKey = JSON.stringify(args);
      let previewState = previewStates.get(context.state);
      if (!previewState || previewState.argsKey !== argsKey) {
        previewState = { argsKey, pending: false, fallback: false };
        previewStates.set(context.state, previewState);
      }
      if (previewState.fallback || !builtInEdit.renderCall) {
        return builtInEdit.renderCall!(args, theme, context);
      }

      const component = builtInEdit.renderCall(args, theme, { ...context, argsComplete: false });
      const input = args as EditToolInput;
      const pathKey =
        typeof input?.path === "string" && Array.isArray(input.edits)
          ? getExactEditPathKey(input.path, context.cwd)
          : undefined;
      if (pathKey && !previewState.pending && prefetchedFile?.key !== pathKey) {
        clearPrefetchedFile();
        let resolvePrefetch!: (value: PrefetchedExactEditFile | undefined) => void;
        let started = false;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const candidate: PrefetchPromise = {
          key: pathKey,
          promise: new Promise((resolve) => {
            resolvePrefetch = resolve;
          }),
          start() {
            if (started) return;
            started = true;
            if (debounce) clearTimeout(debounce);
            void tryPrefetchExactEditFile(input.path, context.cwd).then(resolvePrefetch);
          },
          cancel() {
            if (started) return;
            started = true;
            if (debounce) clearTimeout(debounce);
            resolvePrefetch(undefined);
          },
        };
        prefetchedFile = candidate;
        debounce = setTimeout(() => candidate.start(), 20);
        debounce.unref();
        candidate.expiration = setTimeout(() => {
          if (prefetchedFile === candidate) clearPrefetchedFile();
        }, 60_000);
        candidate.expiration.unref();
      }
      if (context.argsComplete && !previewState.pending) {
        previewState.pending = true;
        const currentState = previewState;
        const inputKey = getExactEditInputKey(input, context.cwd);
        const matchingPrefetch = pathKey && prefetchedFile?.key === pathKey ? prefetchedFile : undefined;
        if (matchingPrefetch) {
          matchingPrefetch.start();
          if (matchingPrefetch.expiration) clearTimeout(matchingPrefetch.expiration);
          prefetchedFile = undefined;
        }
        const preparation = matchingPrefetch
          ? matchingPrefetch.promise.then((prefetched) => tryPrepareExactEdit(input, context.cwd, prefetched))
          : tryPrepareExactEdit(input, context.cwd);
        clearPreparedPreview();
        if (inputKey) {
          const candidate: ExpiringPromise<PreparedExactEdit> = { key: inputKey, promise: preparation };
          preparedPreview = candidate;
          candidate.expiration = setTimeout(() => {
            if (preparedPreview === candidate) preparedPreview = undefined;
          }, 60_000);
          candidate.expiration.unref();
        }
        void preparation.then((prepared) => {
          if (previewStates.get(context.state) !== currentState) return;
          if (!prepared) {
            currentState.fallback = true;
            builtInEdit.renderCall!(args, theme, context);
            context.invalidate();
            return;
          }
          builtInEdit.renderResult!(
            { content: [], details: prepared.result.details },
            { expanded: false, isPartial: false },
            theme,
            {
              ...context,
              args,
              isError: false,
              lastComponent: undefined,
            } as unknown as Parameters<NonNullable<typeof builtInEdit.renderResult>>[3],
          );
          context.invalidate();
        });
      }
      return component;
    },
    async execute(toolCallId, input: EditToolInput, signal, onUpdate, ctx: ExtensionContext) {
      const inputKey = getExactEditInputKey(input, ctx.cwd);
      const matchingPreview = inputKey && preparedPreview?.key === inputKey ? preparedPreview : undefined;
      if (matchingPreview) clearPreparedPreview();
      const prepared = await matchingPreview?.promise;
      const recordEligibleFileSize = (bytes: number): void => stats.recordEligibleFileSize(bytes);
      const accelerated = matchingPreview
        ? prepared && (await tryExecuteExactEdit(input, signal, ctx, prepared, recordEligibleFileSize))
        : await tryExecuteExactEdit(input, signal, ctx, undefined, recordEligibleFileSize);
      if (accelerated) {
        if (prepared && accelerated.details === prepared.result.details) {
          stats.recordPreviewPlanReuse();
          if (prepared.prefetched) stats.recordPrefetchedFile();
          if (prepared.positionalWrites) stats.recordPositionalWrite();
          else if (prepared.suffixWrite) stats.recordSuffixWrite();
        }
        stats.recordAccelerated();
        return accelerated;
      }
      stats.recordFallback();
      return builtInEdit.execute(toolCallId, input, signal, onUpdate, ctx);
    },
  });

  pi.registerCommand("edit-accelerator-stats", {
    description: "Show aggregate edit accelerator fast-path and fallback counts",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatEditAcceleratorStats(stats.snapshot()), "info");
    },
  });

  pi.registerCommand("edit-accelerator-export-stats", {
    description: "Export privacy-safe edit accelerator statistics as JSON",
    handler: async (args, ctx) => {
      try {
        const outputPath = await exportEditAcceleratorStats(
          args,
          processSessionId,
          snapshotIntervalId,
          stats.snapshot(),
        );
        ctx.ui.notify(`Edit accelerator statistics exported to ${outputPath}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("edit-accelerator-reset-stats", {
    description: "Reset aggregate edit accelerator counters",
    handler: async (_args, ctx) => {
      stats.reset();
      snapshotIntervalId = randomUUID();
      ctx.ui.notify("Edit accelerator statistics reset.", "info");
    },
  });
}
