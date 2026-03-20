export class ToolAgent {
  constructor({ toolRegistry }) {
    this.toolRegistry = toolRegistry;
  }

  validateInput(schema, input) {
    if (!schema || schema.type !== "object") return;
    const obj = input && typeof input === "object" ? input : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const k of required) {
      if (!(k in obj)) throw new Error(`missing required field: ${k}`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) throw new Error(`unexpected field: ${k}`);
      }
    }
  }

  async runSteps(steps) {
    const observations = [];
    for (const step of steps || []) {
      if (step?.type !== "tool") continue;
      const tool = this.toolRegistry.get(step.toolName);
      if (!tool) {
        observations.push({
          type: "tool_error",
          toolName: step.toolName,
          input: step.input,
          error: "tool_not_found"
        });
        continue;
      }
      try {
        this.validateInput(tool.inputSchema, step.input || {});
        const output = await tool.handler(step.input || {});
        observations.push({ type: "tool_ok", toolName: tool.name, input: step.input, output });
      } catch (e) {
        observations.push({
          type: "tool_error",
          toolName: tool.name,
          input: step.input,
          error: e?.message || "tool_failed"
        });
      }
    }
    return observations;
  }
}
