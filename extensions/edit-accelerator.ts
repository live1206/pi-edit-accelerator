import {
  createEditToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { tryExecuteExactEdit } from "../src/exact-edit.ts";

export default function editAccelerator(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());

  pi.registerTool({
    ...builtInEdit,
    async execute(toolCallId, input: EditToolInput, signal, onUpdate, ctx: ExtensionContext) {
      const accelerated = await tryExecuteExactEdit(input, signal, ctx);
      if (accelerated !== undefined) return accelerated;
      return builtInEdit.execute(toolCallId, input, signal, onUpdate, ctx);
    },
  });
}
