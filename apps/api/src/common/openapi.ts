import { z } from "zod";

/** A shared Zod schema as an OpenAPI 3.0 JSON schema for Swagger annotations. */
export const openApi = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" }) as object;
