import type { ToolDescriptor } from "./protocol.js";

export type ReflectedMethod = {
  name: string;
  paramNames: string[];
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

export type ReflectedPlayer = {
  see: ReflectedMethod;
  actions: ReflectedMethod[];
  tools: ToolDescriptor[];
};

const SKIP = new Set(["constructor"]);

/** Parse parameter names from a function's source. */
export function getParamNames(fn: Function): string[] {
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

function wrapMethod(instance: object, name: string): ReflectedMethod {
  const fn = (instance as Record<string, unknown>)[name];
  if (typeof fn !== "function") {
    throw new Error(`Expected method ${name}`);
  }
  const paramNames = getParamNames(fn);
  return {
    name,
    paramNames,
    async invoke(args: Record<string, unknown>) {
      const ordered = paramNames.map((p) => args[p]);
      return await Promise.resolve(fn.apply(instance, ordered));
    },
  };
}

function methodToTool(method: ReflectedMethod, description: string): ToolDescriptor {
  const properties: ToolDescriptor["inputSchema"]["properties"] = {};
  for (const name of method.paramNames) {
    properties[name] = { type: "string", description: `Argument ${name}` };
  }
  // Prefer number when name suggests it — still accept JSON numbers via coercion at call time.
  for (const name of method.paramNames) {
    if (/^(n|count|amount|x|y|dx|dy|index|id)$/i.test(name) || /Id$|Count$|Amount$/.test(name)) {
      properties[name] = { type: "number", description: `Argument ${name}` };
    }
  }
  return {
    name: method.name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required: [...method.paramNames],
    },
  };
}

/**
 * Publish tools from a player instance.
 * - `see` is the state tool (required).
 * - Every other public method is an action tool.
 * - Names starting with `_` and the constructor are skipped.
 */
export function reflectPlayer(instance: object): ReflectedPlayer {
  const names = collectMethodNames(instance);
  if (!names.includes("see")) {
    throw new Error('Player must implement a public see() method');
  }

  const see = wrapMethod(instance, "see");
  const actions = names.filter((n) => n !== "see").map((n) => wrapMethod(instance, n));

  const tools: ToolDescriptor[] = [
    methodToTool(see, "Read the current game view for this player. Prefer wait, which returns this after the game grants a turn."),
    ...actions.map((a) => methodToTool(a, `Action: ${a.name}`)),
    {
      name: "wait",
      description:
        "Block until the game calls turn() for this session, then return the current see() view.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  return { see, actions, tools };
}
