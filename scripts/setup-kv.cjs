#!/usr/bin/env node
// Auto-provision the GC_META KV namespace and write its id back to
// wrangler.json, so `bun run deploy` works on a fresh clone with no manual
// Cloudflare dashboard steps. Mirrors the setup-kv flow of sublink-worker.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const WORKER_NAME = "pov559-gallery";
const KV_BINDING = "GC_META";
const KV_NAMESPACE_NAME = `${WORKER_NAME}-${KV_BINDING}`;
const SUPPORTED_TITLES = [KV_NAMESPACE_NAME, KV_BINDING];
const WRANGLER_CONFIG_PATH = path.join(__dirname, "..", "wrangler.json");
const SEED_PATH = path.join(__dirname, "..", "kv-bulk.json");

function runWranglerCommand(command) {
  try {
    return execSync(`npx wrangler ${command}`, { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    console.error(`Command failed: npx wrangler ${command}`);
    if (error.stdout) console.log("stdout:", error.stdout.toString());
    if (error.stderr) console.error("stderr:", error.stderr.toString());
    process.exit(1);
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(WRANGLER_CONFIG_PATH, "utf8"));
  } catch (error) {
    console.error("Cannot read wrangler.json:", error.message);
    process.exit(1);
  }
}

function getConfiguredId() {
  const config = readConfig();
  const entry = (config.kv_namespaces || []).find((ns) => ns.binding === KV_BINDING);
  const id = entry && entry.id;
  return id && id !== "REPLACE_WITH_KV_ID" ? id : null;
}

function findNamespace() {
  console.log(`Checking for KV namespace ${SUPPORTED_TITLES.map((t) => `"${t}"`).join(" / ")}...`);
  let output;
  try {
    output = runWranglerCommand("kv namespace list");
  } catch (error) {
    console.error("Cannot list KV namespaces, aborting.");
    process.exit(1);
  }
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  let namespaces;
  try {
    namespaces = JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Cannot parse KV namespace list:", error.message);
    return null;
  }
  for (const title of SUPPORTED_TITLES) {
    const found = namespaces.find((ns) => ns.title === title);
    if (found) {
      console.log(`Found namespace "${title}" (${found.id}).`);
      return found;
    }
  }
  const configuredId = getConfiguredId();
  if (configuredId && namespaces.some((ns) => ns.id === configuredId)) {
    console.log(`Found configured id ${configuredId} in account, reusing it.`);
    return { id: configuredId };
  }
  return null;
}

function createNamespace() {
  console.log(`Creating KV namespace "${KV_BINDING}"...`);
  let output;
  try {
    output = execSync(`npx wrangler kv namespace create "${KV_BINDING}"`, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const combined =
      (error.stderr ? error.stderr.toString() : "") + (error.stdout ? error.stdout.toString() : "");
    if (combined.includes("code: 10014") || combined.includes("already exists")) {
      const configuredId = getConfiguredId();
      if (configuredId) {
        console.log(`Namespace already exists, reusing configured id ${configuredId}.`);
        return { id: configuredId };
      }
      console.error("Namespace exists but wrangler.json has no usable id. Check the Cloudflare dashboard.");
      process.exit(1);
    }
    console.error("Cannot create KV namespace:", error.message);
    console.log(combined);
    process.exit(1);
  }
  const idMatch = output.match(/id\s*=\s*"([^"]+)"/);
  if (!idMatch) {
    console.error("Cannot extract KV namespace id from output:", output);
    process.exit(1);
  }
  return { id: idMatch[1] };
}

function updateWranglerConfig(id) {
  const config = readConfig();
  config.kv_namespaces = config.kv_namespaces || [];
  const entry = config.kv_namespaces.find((ns) => ns.binding === KV_BINDING);
  if (entry) {
    entry.id = id;
  } else {
    config.kv_namespaces.push({ binding: KV_BINDING, id });
  }
  fs.writeFileSync(WRANGLER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log("wrangler.json updated.");
}

function seedNamespace(id) {
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  } catch (error) {
    console.log("No kv-bulk.json seed file, skipping.");
    return;
  }
  if (!Array.isArray(seed) || seed.length === 0) {
    console.log("Seed file is empty, skipping.");
    return;
  }
  console.log(`Uploading ${seed.length} seed entries...`);
  try {
    execSync(`npx wrangler kv bulk put "${SEED_PATH}" --namespace-id "${id}" --remote`, {
      encoding: "utf8",
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Seed upload failed (deploy continues, gallery falls back to upstream):", error.message);
  }
}

function main() {
  console.log("Setting up KV namespace...");
  let namespace = findNamespace();
  if (!namespace) {
    namespace = createNamespace();
    console.log(`KV namespace ready, id: ${namespace.id}`);
  }
  updateWranglerConfig(namespace.id);
  seedNamespace(namespace.id);
  console.log("Done.");
}

main();
