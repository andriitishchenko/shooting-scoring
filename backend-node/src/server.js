import { createApp } from "./app.js";
import { listenUrls } from "./config.js";

const app = createApp();
try {
  const port = await app.listen();
  console.log(`Shooting Scoring System v${app.version}`);
  for (const url of listenUrls(app.config.host, port)) console.log(`  ${url}`);
  console.log(`  Data: ${app.config.dataDir}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  await app.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const event of ["uncaughtException", "unhandledRejection"])
  process.on(event, (error) => {
    console.error(`${event}:`, error);
    stop(event).finally(() => process.exit(1));
  });
