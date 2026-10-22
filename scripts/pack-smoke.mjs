import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const player = path.join(root, "packages/agent-player");
const dir = await mkdtemp(path.join(tmpdir(), "wsi-pack-"));

const smoke = `
import { AgentServer } from "@whitesands/agent-player";
import { createTestPlatform } from "@whitesands/agent-player/testing";

class Pawn {
  x = 0;
  see() { return { x: this.x }; }
  move(dx) { this.x += dx; return { x: this.x }; }
}

const pawn = new Pawn();
const agents = new AgentServer({
  inline: createTestPlatform([{ name: "move", arguments: { dx: 2 } }]),
});
const agent = await agents.start(pawn);
const result = await agent.turn();
if (result.action !== "move" || pawn.x !== 2) {
  throw new Error("packed SDK did not run a turn");
}
await agents.close();
console.log("pack smoke ok");
`;

try {
  const packed = execSync("npm pack --json", { cwd: player, encoding: "utf8" });
  const filename = JSON.parse(packed).at(-1).filename;
  const tarball = path.join(player, filename);
  execSync("npm init -y", { cwd: dir, stdio: "ignore" });
  execSync(`npm install ${JSON.stringify(tarball)}`, { cwd: dir, stdio: "inherit" });
  const scriptPath = path.join(dir, "smoke.mjs");
  await writeFile(scriptPath, smoke);
  execSync(`node ${JSON.stringify(scriptPath)}`, { cwd: dir, stdio: "inherit" });
} finally {
  await rm(dir, { recursive: true, force: true });
  execSync("rm -f *.tgz", { cwd: player, stdio: "ignore" });
}
