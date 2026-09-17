import {
  createEditToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { tryBuildExactPreview, tryExecuteExactEdit } from "../src/exact-edit.ts";
import { createEditAcceleratorStats, formatEditAcceleratorStats } from "../src/stats.ts";

export default function editAccelerator(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());
  const stats = createEditAcceleratorStats();
  const previewStates = new WeakMap<object, { argsKey: string; pending: boolean; fallback: boolean }>();

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
        void tryBuildExactPreview(args as EditToolInput, context.cwd).then((preview) => {
          if (previewStates.get(context.state) !== currentState) return;
          if (!preview) {
            currentState.fallback = true;
            builtInEdit.renderCall!(args, theme, context);
            context.invalidate();
            return;
          }
          builtInEdit.renderResult!(
            { content: [], details: preview },
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
      const accelerated = await tryExecuteExactEdit(input, signal, ctx);
      if (accelerated !== undefined) {
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
