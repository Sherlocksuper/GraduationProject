import { createTool } from "../registry.js";

export const echoTool = createTool({
  name: "echo",
  description: "原样返回输入文本（用于调试工具链）",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"]
  },
  handler: async ({ text }) => {
    return { text: String(text) };
  }
});

