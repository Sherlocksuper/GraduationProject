import { ReactOrchestrator } from "./orchestrator.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerBuiltinTools } from "./tools/builtin/index.js";

export function createDefaultOrchestrator({ llmClient } = {}) {
  const registry = registerBuiltinTools(new ToolRegistry());
  return new ReactOrchestrator({ toolRegistry: registry, llmClient });
}
