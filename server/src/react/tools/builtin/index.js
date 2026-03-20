import { calculatorTool } from "./calculator.js";
import { echoTool } from "./echo.js";
import { timeTool } from "./time.js";

export function registerBuiltinTools(registry) {
  registry.register(calculatorTool);
  registry.register(timeTool);
  registry.register(echoTool);
  return registry;
}

