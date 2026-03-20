import { createTool } from "../registry.js";

export const timeTool = createTool({
  name: "time",
  description: "获取当前时间（ISO 格式）",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    return { now: new Date().toISOString() };
  }
});

