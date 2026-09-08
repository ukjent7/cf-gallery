#!/usr/bin/env node
// Provision the GC_META KV namespace, record its id in wrangler.json, and
// reconcile the seed file into it.
//
// Why the seed step is careful about writes: free-tier KV allows 1,000 writes
// per day and bulk puts are billed against the same quota as runtime writes.
// The previous version ran `kv bulk put` on every deploy, which (a) rewrote
// ~114 keys per deploy and (b) overwrote fresher runtime values with the stale
// seed timestamp. Now: list keys (reads are free, 100k/day), and only upload
// keys that are actually absent.
//
// Flags:
//   --no-seed    provision/configure only, touch no data
//   --force-seed overwrite every seed entry (deliberate, costs the writes)
//
// Mirrors the setup-kv flow of sublink-worker.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WORKER_NAME = "pov559-gallery";
const KV_BINDING = "GC_META";
const KV_NAMESPACE_NAME = `${WORKER_NAME}-${KV_BINDING}`;
const SUPPORTED_TITLES = [KV_NAMESPACE_NAME, KV_BINDING];
const WRANGLER_CONFIG_PATH = path.join(__dirname, "..", "wrangler.json");
const SEED_PATH = path.join(__dirname, "..", "kv-bulk.json");
// Seeded hits carry crawl data; 30 days matches META_TTL_S in src/index.js so a
// seeded entry expires on the same schedule as a runtime one.
const SEED_TTL_S = 2592000;

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

function parseJsonArray(output) {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
}

function findNamespace() {
  console.log(`Checking for KV namespace ${SUPPORTED_TITLES.map((t) => `"${t}"`).join(" / ")}...`);
  const output = runWranglerCommand("kv namespace list");
  const namespaces = parseJsonArray(output);
  if (namespaces) {
    for (const title of SUPPORTED_TITLES) {
      const found = namespaces.find((ns) => ns.title === title);
      if (found) {
        console.log(`Found namespace "${title}" (${found.id}).`);
        return found;
      }
    }
  }
  const configuredId = getConfiguredId();
  if (configuredId && namespaces && namespaces.some((ns) => ns.id === configuredId)) {
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
  // Newer wrangler prints JSON ("id": "..."), older prints TOML (id = "...").
  const idMatch = output.match(/"?\bid\b"?\s*[:=]\s*"([^"]+)"/);
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
    if (entry.id === id) {
      console.log("wrangler.json already correct, left untouched.");
      return;
    }
    entry.id = id;
  } else {
    config.kv_namespaces.push({ binding: KV_BINDING, id });
  }
  fs.writeFileSync(WRANGLER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log("wrangler.json updated.");
}

function readSeed() {
  if (!fs.existsSync(SEED_PATH)) {
    console.log("No kv-bulk.json seed file, skipping seed.");
    return null;
  }
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  } catch (error) {
    console.error("kv-bulk.json is not valid JSON, skipping seed:", error.message);
    return null;
  }
  if (!Array.isArray(seed) || seed.length === 0) {
    console.log("Seed file is empty, skipping.");
    return null;
  }
  // Refuse to upload entries the worker would ignore. This is the exact bug
  // that made the whole seed pipeline a no-op for a while.
  const bad = seed.filter((e) => {
    try {
      return typeof JSON.parse(e.value).hit !== "boolean";
    } catch (error) {
      return true;
    }
  });
  if (bad.length) {
    console.error(`REFUSING to upload: ${bad.length}/${seed.length} seed entries lack a boolean "hit".`);
    console.error("Regenerate with: python scripts/make-kv-bulk.py");
    process.exit(1);
  }
  return seed;
}

function listRemoteKeys(id) {
  let cursor = "";
  const keys = new Set();
  for (let page = 0; page < 50; page++) {
    const flag = cursor ? ` --cursor "${cursor}"` : "";
    let output;
    try {
      output = execSync(
        `npx wrangler kv key list --namespace-id "${id}" --remote --json${flag}`,
        { encoding: "utf8", stdio: "pipe" }
      );
    } catch (error) {
      // Older wrangler has no --json here; fall back to seeding everything.
      console.log("Cannot list keys as JSON; will re-check individually.");
      return null;
    }
    const jsonStart = output.indexOf("{");
    if (jsonStart < 0) return null;
    let payload;
    try {
      payload = JSON.parse(output.slice(jsonStart));
    } catch (error) {
      return null;
    }
    (payload.keys || []).forEach((k) => keys.add(k.key || k.name));
    cursor = payload.cursor || "";
    if (!cursor) return keys;
  }
  return keys;
}

function seedNamespace(id, force) {
  const seed = readSeed();
  if (!seed) return;

  let missing = seed;
  if (!force) {
    const existing = listRemoteKeys(id);
    if (existing) {
      missing = seed.filter((e) => !existing.has(e.key));
      console.log(`Seed has ${seed.length} entries, ${existing.size} keys present, ${missing.length} missing.`);
    } else {
      // Cheap spot check: if a representative key already resolves, assume the
      // namespace was seeded and skip rather than rewriting all of it.
      const probe = seed[Math.floor(seed.length / 2)];
      try {
        execSync(
          `npx wrangler kv key get "${probe.key}" --namespace-id "${id}" --remote --text`,
          { encoding: "utf8", stdio: "pipe" }
        );
        console.log("Namespace already contains seed data, skipping upload. Use --force-seed to overwrite.");
        return;
      } catch (error) {
        console.log("Probe key absent; uploading the full seed.");
      }
    }
  }

  if (!missing.length) {
    console.log("Nothing to seed, 0 writes used.");
    return;
  }

  const tmp = path.join(os.tmpdir(), `kv-seed-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(missing));
  console.log(`Uploading ${missing.length} seed entries (${force ? "overwrite" : "missing only"})...`);
  try {
    execSync(
      `npx wrangler kv bulk put "${tmp}" --namespace-id "${id}" --remote --ttl ${SEED_TTL_S}`,
      { encoding: "utf8", stdio: "inherit" }
    );
    console.log(`Seeded ${missing.length} entries.`);
  } catch (error) {
    // Not fatal: the gallery degrades to fetching upstream.
    console.error("Seed upload failed (deploy continues):", error.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) {}
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--no-seed")) {
    console.log("Setting up KV namespace (seed skipped by --no-seed)...");
  } else {
    console.log("Setting up KV namespace...");
  }
  let namespace = findNamespace();
  if (!namespace) {
    namespace = createNamespace();
    console.log(`KV namespace ready, id: ${namespace.id}`);
  }
  updateWranglerConfig(namespace.id);
  if (!argv.includes("--no-seed")) seedNamespace(namespace.id, argv.includes("--force-seed"));
  console.log("Done.");
}

main();
