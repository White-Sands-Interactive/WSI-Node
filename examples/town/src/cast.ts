/**
 * The residents. Who they are is not here: each one's role and story is
 * written on its character in the White Sands web app. This file only knows
 * where a resident wakes up and what they look like. The character id comes
 * from TOWN_CAST_IDS, copied from the web app.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Look = { skin: string; shirt: string; hair: string };

export type Member = { id: string; name: string; home: string; startsAt: string; look: Look };

type CastFile = { name: string; home: string; startsAt: string; look: Look };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "cast.json");
}

/** TOWN_CAST_IDS is "Mia=<uuid>,Finn=<uuid>,...". Every resident in cast.json needs one. */
export function loadCast(spec = process.env.TOWN_CAST_IDS): Member[] {
  const members = JSON.parse(readFileSync(castPath(), "utf8")) as CastFile[];
  const ids = new Map<string, string>();
  if (!spec?.trim()) {
    const example = members.map((member) => `${member.name}=<uuid>`).join(",");
    throw new Error(`TOWN_CAST_IDS is required. Set ${example} from the characters in the web app.`);
  }
  for (const pair of spec.split(",")) {
    const [name, id] = pair.split("=").map((part) => part.trim());
    if (!name || !id) throw new Error(`TOWN_CAST_IDS: expected Name=<uuid>, got "${pair.trim()}"`);
    if (!ID.test(id)) throw new Error(`TOWN_CAST_IDS: ${name} is not a character id. Copy it from the web app.`);
    ids.set(name.toLowerCase(), id);
  }
  return members.map((member) => {
    const id = ids.get(member.name.toLowerCase());
    if (!id) throw new Error(`TOWN_CAST_IDS is missing ${member.name}. Copy the character id from the web app.`);
    return { ...member, id };
  });
}

export const cast: Member[] = loadCast();
