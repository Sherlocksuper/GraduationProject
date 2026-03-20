export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool?.name) throw new Error("tool.name is required");
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }
}

export function createTool({ name, description, inputSchema, handler }) {
  if (!name) throw new Error("name is required");
  if (!handler) throw new Error("handler is required");
  return { name, description: description || "", inputSchema: inputSchema || {}, handler };
}

