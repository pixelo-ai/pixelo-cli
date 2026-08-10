import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageMetadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const failures = [];
if (packageMetadata.name !== "@pixelo-ai/cli") failures.push("npm package name must remain @pixelo-ai/cli");
if (packageMetadata.pixelo?.clientId !== "pixelo-cli") failures.push("public device client id must remain pixelo-cli");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) failures.push("version must be valid SemVer");
if (packageMetadata.bin?.pixelo !== "./dist/pixelo.js") failures.push("pixelo binary must resolve to ./dist/pixelo.js");
if (!packageMetadata.files?.includes("dist")) failures.push("published files must include dist");
if (packageMetadata.repository?.url !== "git+https://github.com/pixelo-ai/pixelo-cli.git") {
  failures.push("repository URL must point to pixelo-ai/pixelo-cli");
}
if (packageMetadata.publishConfig?.access !== "public") failures.push("npm publication must be explicitly public");
if (packageMetadata.license !== "UNLICENSED") failures.push("CLI license must remain UNLICENSED unless the owner approves a license");
const releaseTag = process.env.GITHUB_REF_NAME;
if (releaseTag?.startsWith("v") && releaseTag !== `v${packageMetadata.version}`) {
  failures.push(`release tag ${releaseTag} does not match package version v${packageMetadata.version}`);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}
console.log(`CLI metadata is release-ready at ${packageMetadata.name}@${packageMetadata.version}.`);
