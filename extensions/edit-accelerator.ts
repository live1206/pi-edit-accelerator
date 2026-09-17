import {
  createEditToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getExactEditInputKey,
  type PreparedExactEdit,
  tryExecuteExactEdit,
  tryPrepareExactEdit,
} from "../src/exact-edit.ts";
import { createEditAcceleratorStats, formatEditAcceleratorStats } from "../src/stats.ts";

export default function editAccelerator(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());
  const stats = createEditAcceleratorStats();
  const previewStates = new WeakMap<object, { argsKey: string; pending: boolean; fallback: boolean }>();
  let preparedPreview:
    | {
        inputKey: string;
        promise: Promise<PreparedExactEdit | undefined>;
        expiration?: ReturnType<typeof setTimeout>;
      }
    | undefined;
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
      if (context.argsComplete && !previewState.pending) {
        previewState.pending = true;
        const currentState = previewState;
        const input = args as EditToolInput;
        const inputKey = getExactEditInputKey(input, context.cwd);
        const preparation = tryPrepareExactEdit(input, context.cwd);
        clearPreparedPreview();
        if (inputKey) {
          const candidate: NonNullable<typeof preparedPreview> = { inputKey, promise: preparation };
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
      const matchingPreview = inputKey && preparedPreview?.inputKey === inputKey ? preparedPreview : undefined;
      if (matchingPreview) clearPreparedPreview();
      const prepared = await matchingPreview?.promise;
      const accelerated = matchingPreview
        ? prepared && (await tryExecuteExactEdit(input, signal, ctx, prepared))
        : await tryExecuteExactEdit(input, signal, ctx);
      if (accelerated) {
        if (prepared && accelerated.details === prepared.result.details) {
          stats.recordPreviewPlanReuse();
          if (prepared.positionalWrites) stats.recordPositionalWrite();
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

  pi.registerCommand("edit-accelerator-reset-stats", {
    description: "Reset aggregate edit accelerator counters",
    handler: async (_args, ctx) => {
      stats.reset();
      ctx.ui.notify("Edit accelerator statistics reset.", "info");
    },
  });
}
