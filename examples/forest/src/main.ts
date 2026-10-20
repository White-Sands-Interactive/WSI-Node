import { AgentServer } from "@wsi/agent-player";
import { createInlinePlatform, createOpenAiModel, createScriptedModel } from "@wsi/agent-platform";
import { Forest } from "./forest.js";
import { Villager } from "./villager.js";

/**
 * Forest demo: Ada moves onto the tree, then chops it.
 * A second villager (Bea) starts on the same AgentServer.
 *
 * Default: scripted model (deterministic).
 * Real model: MODEL_API_KEY=... npm run start -- --real
 * Remote platform: PLATFORM_KEY=... PLATFORM_URL=ws://... npm run start -- --remote
 */
async function main(): Promise<void> {
  const useReal = process.argv.includes("--real");
  const useRemote = process.argv.includes("--remote");

  const world = new Forest();
  const ada = new Villager(world, "Ada", 0, 2);
  const bea = new Villager(world, "Bea", 4, 4);

  console.log("Before:");
  console.log(world.render());
  console.log(`Ada at (${ada.x},${ada.y}) wood=${ada.wood}`);

  let agents: AgentServer;

  if (useRemote) {
    const platformKey = process.env.PLATFORM_KEY;
    if (!platformKey) throw new Error("PLATFORM_KEY required for --remote");
    agents = new AgentServer({
      platformKey,
      platformUrl: process.env.PLATFORM_URL ?? "ws://127.0.0.1:8787",
    });
  } else {
    const model = useReal
      ? createOpenAiModel({
          apiKey: process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
          model: process.env.MODEL_NAME ?? "gpt-4o-mini",
          baseUrl: process.env.MODEL_BASE_URL,
        })
      : createScriptedModel([
          // Ada turn 1: move toward tree (2,2) from (0,2)
          { name: "move", arguments: { dx: 2, dy: 0 } },
          // Ada turn 2: chop
          { name: "chop", arguments: {} },
          // Bea turn: move left (no tree needed for proof of second session)
          { name: "move", arguments: { dx: -1, dy: 0 } },
        ]);

    if (useReal && !(process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY)) {
      throw new Error("MODEL_API_KEY required for --real");
    }

    agents = new AgentServer({
      platformKey: "inline",
      inline: createInlinePlatform({ model }),
    });
  }

  const adaAgent = await agents.start(ada);
  const beaAgent = await agents.start(bea);

  await adaAgent.turn();
  console.log("\nAfter Ada move:");
  console.log(`Ada at (${ada.x},${ada.y}) tile=${world.get(ada.x, ada.y)} wood=${ada.wood}`);

  await adaAgent.turn();
  console.log("\nAfter Ada chop:");
  console.log(world.render());
  console.log(`Ada at (${ada.x},${ada.y}) wood=${ada.wood} treesLeft=${world.treesLeft()}`);

  // Second session proof: Bea acts on the same AgentServer.
  // Real models may pick any legal move — only Ada's chop is asserted.
  try {
    await beaAgent.turn();
    console.log("\nAfter Bea turn:");
    console.log(`Bea at (${bea.x},${bea.y})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\nBea turn failed (model chose an illegal action): ${message}`);
    console.log(`Bea still at (${bea.x},${bea.y})`);
  }

  await adaAgent.stop();
  await beaAgent.stop();
  await agents.close();

  if (ada.x !== 2 || ada.y !== 2 || ada.wood !== 1 || world.treesLeft() !== 0) {
    throw new Error("Forest demo did not produce expected Ada state");
  }
  if (!useRemote && !useReal && (bea.x !== 3 || bea.y !== 4)) {
    throw new Error("Forest demo did not produce expected Bea state");
  }
  console.log("\nOK — Ada moved and chopped; tile and wood changed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
