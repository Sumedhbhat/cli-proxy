import { direct } from "./recovery.ts";
direct(process.argv[2], process.argv.slice(3)).catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
