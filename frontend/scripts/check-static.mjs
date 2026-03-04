import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "all";
const allowedModes = new Set(["inline", "sw", "all"]);
if (!allowedModes.has(mode)) {
  throw new Error(`Unknown mode: ${mode}`);
}

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const frontendDir = join(scriptDir, "..");

function checkInlineScripts() {
  const html = readFileSync(join(frontendDir, "index.html"), "utf8");
  const re = /<script>([\s\S]*?)<\/script>/g;
  let match;
  let count = 0;
  while ((match = re.exec(html)) !== null) {
    count += 1;
    // Parse-only validation for inline frontend scripts.
    new Function(match[1]);
  }
  process.stdout.write(`validated inline scripts: ${count}\n`);
}

function checkServiceWorker() {
  const sw = readFileSync(join(frontendDir, "sw.js"), "utf8");
  // Parse-only validation for service worker script.
  new Function(sw);
  process.stdout.write("validated sw.js\n");
}

if (mode === "inline" || mode === "all") {
  checkInlineScripts();
}

if (mode === "sw" || mode === "all") {
  checkServiceWorker();
}
