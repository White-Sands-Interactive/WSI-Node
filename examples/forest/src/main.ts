import { AgentServer } from "@whitesands/agent-player";
import { createTestPlatform } from "@whitesands/agent-player/testing";
import { Forest } from "./forest.js";
import { Villager } from "./villager.js";

/**
 * Forest demo. Offline by default, using the testing entry's scripted platform.
 * Remote: PLATFORM_KEY=pk_... ADA_PLAYER_ID=<uuid> BEA_PLAYER_ID=<uuid> npm start -- --remote
 */
async function main(): Promise<void> {
  const useRemote = process.argv.includes("--remote");
  const world = new Forest();
  const ada = new Villager(world, "Ada", 0, 2);
  const bea = new Villager(world, "Bea", 4, 4);

  console.log("Before:");
  console.log(world.render());
  console.log(`Ada at (${ada.x},${ada.y}) wood=${ada.wood}`);

  const agents = useRemote
    ? new AgentServer({
        platformKey: required("PLATFORM_KEY"),
      })
    : new AgentServer({
        inline: createTestPlatform([
          { name: "move", arguments: { dx: 2, dy: 0 } },
          { name: "chop", arguments: {} },
          { name: "move", arguments: { dx: -1, dy: 0 } },
        ]),
      });

  const adaAgent = await agents.start(ada, {
    playerId: useRemote ? required("ADA_PLAYER_ID") : "3f6c2d1e-8b7a-4c5d-9e0f-1a2b3c4d5e6f",
    goal: "Stand on the tree and chop it",
  });
  const beaAgent = await agents.start(bea, {
    playerId: useRemote ? required("BEA_PLAYER_ID") : "6b1e2a30-0c1d-4e5f-8a9b-0c1d2e3f4a5b",
  });

  const moved = await adaAgent.turn();
  console.log(`\nAda ${moved.action}(${JSON.stringify(moved.args)})`);
  console.log(`Ada at (${ada.x},${ada.y}) tile=${world.get(ada.x, ada.y)} wood=${ada.wood}`);

  const chopped = await adaAgent.turn();
  console.log(`\nAda ${chopped.action}(${JSON.stringify(chopped.args)})`);
  console.log(world.render());
  console.log(`Ada at (${ada.x},${ada.y}) wood=${ada.wood} treesLeft=${world.treesLeft()}`);

  try {
    const beaTurn = await beaAgent.turn();
    console.log(`\nBea ${beaTurn.action}(${JSON.stringify(beaTurn.args)})`);
    console.log(`Bea at (${bea.x},${bea.y})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\nBea turn failed (model chose an illegal action): ${message}`);
    console.log(`Bea still at (${bea.x},${bea.y})`);
  }

  await adaAgent.stop();
  await beaAgent.stop();
  await agents.close();

  if (!useRemote && (moved.action !== "move" || chopped.action !== "chop")) {
    throw new Error("Scripted forest did not move then chop");
  }
  if (ada.x !== 2 || ada.y !== 2 || ada.wood !== 1 || world.treesLeft() !== 0) {
    throw new Error("Forest demo did not produce expected Ada state");
  }
  if (!useRemote && (bea.x !== 3 || bea.y !== 4)) {
    throw new Error("Forest demo did not produce expected Bea state");
  }
  console.log("\nOK — Ada moved and chopped; tile and wood changed.");
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
