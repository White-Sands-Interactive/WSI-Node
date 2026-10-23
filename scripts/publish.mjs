import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const current = pkg.version;

let published = "";
try {
  published = execSync(`npm view ${pkg.name} version`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch (error) {
  const detail = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  if (!detail.includes("E404") && !detail.includes("404")) {
    throw error;
  }
}

if (published === current) {
  console.log(`${pkg.name}@${current} is already on npm`);
  process.exit(0);
}

console.log(`publishing ${pkg.name}@${current}`);
execSync("npm publish --access public", { stdio: "inherit" });
