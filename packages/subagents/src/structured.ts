/**
 * Structured subagent results: when `delegate_task` gets an `outputSchema`,
 * each subagent must finish with one JSON value matching it, which the parent
 * reads as data instead of prose to interpret. The idea follows oh-my-pi's
 * `task` tool.
 *
 * The schema check covers the JSON Schema subset tool schemas use: `type`
 * (one or a list), `enum`, `const`, `properties`, `required`,
 * `additionalProperties: false`, `items`, `minItems` and `maxItems`. Other
 * keywords are accepted and not checked.
 */

export type JsonSchema = Record<string, unknown>;

/** The ask appended to a subagent's prompt when its result must match `schema`. */
export function structuredInstruction(schema: JsonSchema): string {
  return [
    "Your final reply is read by a program, not a person.",
    "When you finish, reply with exactly one JSON value that matches this JSON Schema, with no prose and no Markdown fences:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

/** The ask sent back to a subagent whose reply did not fit. */
export function structuredRetry(problem: string): string {
  return `Your reply was not usable: ${problem}. Reply again with only the JSON value that matches the schema.`;
}

/** The JSON value in `text`, which may be wrapped in one Markdown code fence. */
export function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let body = text.trim();
  if (body.startsWith("```") && body.endsWith("```") && body.length >= 6) {
    const firstLineEnd = body.indexOf("\n");
    body = firstLineEnd < 0 ? "" : body.slice(firstLineEnd + 1, body.length - 3).trim();
  }
  if (body === "") return { ok: false, error: "the reply was empty" };
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch (error) {
    return { ok: false, error: `the reply was not valid JSON (${(error as Error).message})` };
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function fitsType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

const isSchema = (value: unknown): value is JsonSchema => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why `value` does not match `schema`, or undefined when it does. `path` names the place, `$` being the root. */
export function schemaProblem(schema: JsonSchema, value: unknown, path = "$"): string | undefined {
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];
  if (types.length > 0 && !types.some((type) => fitsType(value, type))) {
    return `${path} should be ${types.join(" or ")}, not ${typeOf(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${path} should be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return `${path} should be ${JSON.stringify(schema.const)}`;
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = isSchema(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && record[key] === undefined) return `${path}.${key} is missing`;
    }
    for (const [key, item] of Object.entries(record)) {
      const property = properties[key];
      if (isSchema(property)) {
        const problem = schemaProblem(property, item, `${path}.${key}`);
        if (problem !== undefined) return problem;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} should have at least ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} should have at most ${schema.maxItems} items`;
    if (isSchema(schema.items)) {
      for (const [index, item] of value.entries()) {
        const problem = schemaProblem(schema.items, item, `${path}[${index}]`);
        if (problem !== undefined) return problem;
      }
    }
  }
  return undefined;
}

/** Parse `text` and check it against `schema`: the value, or why it does not fit. */
export function readStructuredAnswer(text: string, schema: JsonSchema): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = parseJsonAnswer(text);
  if (!parsed.ok) return parsed;
  const problem = schemaProblem(schema, parsed.value);
  return problem === undefined ? parsed : { ok: false, error: `it did not match the schema: ${problem}` };
}
