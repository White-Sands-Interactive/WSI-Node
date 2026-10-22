import { AgentServer } from "@whitesands/agent-player";
import { createTestPlatform } from "@whitesands/agent-player/testing";
import { Courier } from "./courier.js";

async function main(): Promise<void> {
  const nia = new Courier(0);
  const agents = new AgentServer({
    inline: createTestPlatform([
      { name: "walk", arguments: { dx: 3 } },
      { name: "deliver", arguments: {} },
    ]),
  });

  const agent = await agents.start(nia, { name: "Nia", goal: "Deliver the parcel to the door" });
  const walked = await agent.turn();
  const delivered = await agent.turn();
  console.log(walked.action, walked.args, "->", walked.result);
  console.log(delivered.action, "->", delivered.result);

  await agents.close();

  if (nia.x !== 3 || !nia.delivered) {
    throw new Error("Courier did not deliver the parcel");
  }
  if (walked.attempts !== 1 || delivered.action !== "deliver") {
    throw new Error("Unexpected turn results");
  }
  console.log("OK — parcel delivered.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
