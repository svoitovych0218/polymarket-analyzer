import { initDb } from "./db/schema";
import { pollGammaMarkets } from "./api/gamma";

async function main(): Promise<void> {
  initDb();
  console.log("Database initialised.");

  const changed = await pollGammaMarkets();
  console.log(`Changed markets: ${changed.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
