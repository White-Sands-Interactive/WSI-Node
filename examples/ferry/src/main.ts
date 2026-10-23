import { AgentServer, TurnFailedError } from "@whitesands/agent-player";
import { createTestPlatform } from "@whitesands/agent-player/testing";
import { Ferryman, render } from "./ferry.js";

/**
 * River-crossing demo. Offline by default, replaying one solution.
 * Remote: PLATFORM_KEY=pk_... npm start -- --remote
 *
 * Each turn the model chooses who rides. Taking the wrong passenger leaves
 * the wolf with the goat, or the goat with the cabbage, and the trip is refused.
 */
const SOLUTION = [
  "goat",
  "none",
  "cabbage",
  "goat",
  "wolf",
  "none",
  "goat",
] as const;

const GOAL =
  "Get the wolf, the goat, and the cabbage onto the far bank. Never leave the wolf alone with the goat, or the goat alone with the cabbage.";

async function main(): Promise<void> {
  const useRemote = process.argv.includes("--remote");
  const ferry = new Ferryman();
  console.log(render(ferry));

  const agents = useRemote
    ? new AgentServer({
        platformKey: required("PLATFORM_KEY"),
        ...(process.env.PLATFORM_URL ? { platformUrl: process.env.PLATFORM_URL } : {}),
      })
    : new AgentServer({
        inline: createTestPlatform(
          SOLUTION.map((passenger) => ({ name: "cross", arguments: { passenger } })),
        ),
      });

  const agent = await agents.start(ferry, { name: "Ferryman", goal: GOAL });
  const limit = useRemote ? 12 : SOLUTION.length;

  for (let turn = 1; turn <= limit && !ferry.see().solved; turn += 1) {
    try {
      const result = await agent.turn();
      console.log(`\n${turn}. ${result.action}(${JSON.stringify(result.args)}) attempts=${result.attempts}`);
      console.log(render(ferry));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = error instanceof TurnFailedError;
      console.log(`\n${turn}. turn failed${failed ? ` after ${error.attempts.length} attempt(s)` : ""}: ${message}`);
      console.log(render(ferry));
      break;
    }
  }

  await agent.stop();
  await agents.close();

  if (!ferry.see().solved) {
    throw new Error("The wolf, goat, and cabbage did not all reach the far bank");
  }
  console.log("\nOK — everyone is on the far bank.");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for --remote`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
