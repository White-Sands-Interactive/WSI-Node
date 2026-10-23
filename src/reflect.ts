import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema, ToolDescriptor } from "./protocol.js";

export type ActionSpec = {
  description: string;
  args?: ZodRawShape;
};

export type AgentMetadata = {
  description?: string;
  actions?: Record<string, ActionSpec>;
};

export type PlayerTool = {
  name: string;
  description: string;
  paramNames: string[];
  argsSchema?: z.ZodObject<ZodRawShape>;
  descriptor: ToolDescriptor;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

export type ReflectedPlayer = {
  /** Class-level description, when the player declared `static agent`. */
  description?: string;
  see: PlayerTool;
  actions: PlayerTool[];
  tools: ToolDescriptor[];
};

const SKIP = new Set(["constructor"]);

export const SEE_DESCRIPTION = "Read the current game view for this player. Prefer wait, which returns this after the game grants a turn.";
export const WAIT_DESCRIPTION = "Block until the game calls turn() for this session, then return the current see() view.";

/** Parse parameter names from a function's source. Used only when no arg schema is declared. */
export function getParamNames(fn: (...args: never[]) => unknown): string[] {
  const src = fn.toString().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const header =
    src.match(/(?:async\s+)?(?:function\s*)?(?:\w*)\s*\(([^)]*)\)/) ??
    src.match(/^(?:async\s*)?\(?([^)=]*)\)?\s*=>/);
  if (!header) return [];
  const raw = header[1]?.trim() ?? "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const cleaned = part.replace(/\s*=\s*[^,]+$/, "").trim();
      const name = cleaned.split(/[:\s]/)[0]?.replace(/^\.\.\./, "") ?? "";
      return name;
    })
    .filter((name) => name.length > 0 && name !== "this");
}

function collectMethodNames(instance: object): string[] {
  const names = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (SKIP.has(name) || name.startsWith("_")) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== "function") continue;
      names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names].sort();
}

function readMetadata(instance: object): AgentMetadata | undefined {
  const ctor = instance.constructor as { agent?: AgentMetadata };
  return ctor.agent;
}

function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const json = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as JsonSchema;
  delete json.$schema;
  return json;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function buildTool(
  instance: object,
  name: string,
  description: string,
  spec?: ActionSpec,
): PlayerTool {
  const fn = (instance as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`Expected method ${name}`);
  }
  const paramNames = spec?.args ? Object.keys(spec.args) : getParamNames(fn as (...args: never[]) => unknown);
  const shape: ZodRawShape = spec?.args ?? Object.fromEntries(paramNames.map((param) => [param, z.any()]));
  const argsSchema = paramNames.length > 0 || spec?.args ? z.object(shape) : undefined;
  const inputSchema: JsonSchema = spec?.args && argsSchema
    ? toJsonSchema(argsSchema)
    : {
        type: "object",
        properties: Object.fromEntries(paramNames.map((param) => [param, {}])),
        ...(paramNames.length > 0 ? { required: paramNames } : {}),
      };

  return {
    name,
    description,
    paramNames,
    ...(argsSchema ? { argsSchema } : {}),
    descriptor: { name, description, inputSchema },
    async invoke(args: Record<string, unknown>) {
      let parsed: Record<string, unknown> = args ?? {};
      if (argsSchema) {
        const result = argsSchema.safeParse(args ?? {});
        if (!result.success) {
          throw new Error(formatZodError(result.error));
        }
        parsed = result.data as Record<string, unknown>;
      }
      const ordered = paramNames.map((param) => parsed[param]);
      return await Promise.resolve((fn as (...params: unknown[]) => unknown).apply(instance, ordered));
    },
  };
}

/**
 * Publish tools from a player instance.
 * - `see` is the state tool (required).
 * - Every other public method is an action tool.
 * - Names starting with `_` and the constructor are skipped.
 * - `static agent` supplies descriptions and zod argument schemas. Undeclared methods stay tools,
 *   with unconstrained JSON arguments (no type guessed from the parameter name).
 */
export function reflectPlayer(instance: object): ReflectedPlayer {
  const names = collectMethodNames(instance);
  if (!names.includes("see")) {
    throw new Error("Player must implement a public see() method");
  }

  const metadata = readMetadata(instance);
  const declared = metadata?.actions ?? {};
  const className = instance.constructor?.name || "Player";
  for (const name of Object.keys(declared)) {
    if (!names.includes(name) || name === "see") {
      throw new Error(`Declared action "${name}" is not a public method on ${className}`);
    }
  }

  const see = buildTool(instance, "see", SEE_DESCRIPTION);
  const actionNames = names.filter((name) => name !== "see");
  const actions = actionNames.map((name) => {
    const spec = declared[name];
    const description = spec?.description ?? `Action: ${name}`;
    return buildTool(instance, name, description, spec);
  });

  const wait: ToolDescriptor = {
    name: "wait",
    description: WAIT_DESCRIPTION,
    inputSchema: { type: "object", properties: {} },
  };

  return {
    ...(metadata?.description ? { description: metadata.description } : {}),
    see,
    actions,
    tools: [see.descriptor, ...actions.map((action) => action.descriptor), wait],
  };
}
