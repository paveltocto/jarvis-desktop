import { type FunctionDeclaration, type Schema, Type } from "@google/genai";
import type { JsonSchema, ToolDeclaration } from "../tools/types";

const TYPES: Record<JsonSchema["type"], Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

/** Converts the registry's JSON Schema subset to the Gemini `Schema` type. */
export function toGeminiSchema(schema: JsonSchema): Schema {
  const result: Schema = { type: TYPES[schema.type] };
  if (schema.description) result.description = schema.description;
  switch (schema.type) {
    case "string":
      if (schema.enum) result.enum = [...schema.enum];
      break;
    case "array":
      result.items = toGeminiSchema(schema.items);
      break;
    case "object":
      result.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
      );
      if (schema.required?.length) result.required = [...schema.required];
      break;
    default:
      break;
  }
  return result;
}

export function toFunctionDeclarations(tools: ToolDeclaration[]): FunctionDeclaration[] {
  return tools.map((tool) => {
    const declaration: FunctionDeclaration = { name: tool.name, description: tool.description };
    // Gemini rejects an OBJECT schema without properties; omit parameters instead.
    if (Object.keys(tool.parameters.properties).length > 0) {
      declaration.parameters = toGeminiSchema(tool.parameters);
    }
    return declaration;
  });
}
