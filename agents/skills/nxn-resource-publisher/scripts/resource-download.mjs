#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { downloadUrlToFile, readRemoteText } from "./resource-network.mjs";

const OWNER = "3Fu";
const REPO = "nxn_resource";
const DEFAULT_CATALOG_URL = `https://${OWNER.toLowerCase()}.github.io/${REPO}/catalog.json`;
const RELEASE_PREFIX = `https://github.com/${OWNER}/${REPO}/releases/download/`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BOOLEAN_OPTIONS = new Set(["all", "force", "help", "include-bundle", "json", "proxy-env"]);

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage:\n"
    + "  resource-download.mjs --output DIR [--catalog-url URL | --catalog FILE]\n"
    + "                        [--ids ID[,ID...] | --types TYPE[,TYPE...]] [--all]\n"
    + "                        [--force] [--concurrency N] [--include-bundle] [--json]\n"
    + "                        [--proxy URL] [--proxy-env true|false]\n"
    + "                        [--retries N] [--connect-timeout SECONDS] [--stall-timeout SECONDS]\n"
    + "  resource-download.mjs --output DIR --manifest FILE_OR_URL [filters]\n\n"
    + "Downloads Release originals with their original filenames, verifies SHA-256, and writes atomically.\n"
    + "When no source is supplied, the public NXN catalog is used. HTTPS_PROXY, ALL_PROXY, and NO_PROXY\n"
    + "are detected automatically; proxied transfers use system curl.\n",
  );
  process.exit(message ? 2 : 0);
}

function parseBoolean(value, name) {
  if (value === undefined) return true;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) usage(`Invalid argument ${token}`);
    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    if (BOOLEAN_OPTIONS.has(name)) {
      let booleanValue = inlineValue;
      if (booleanValue === undefined && ["true", "false"].includes(values[index + 1])) {
        booleanValue = values[index + 1];
        index += 1;
      }
      options[name] = parseBoolean(booleanValue, `--${name}`);
      continue;
    }
    const value = inlineValue ?? values[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`Missing value for --${name}`);
    options[name] = value;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function csv(value) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed >= min && parsed <= max, `${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function safeString(value, name, max = 500) {
  assert(typeof value === "string" && value.trim() && value.length <= max, `${name} is invalid`);
  assert(!/[<>]/.test(value), `${name} contains HTML-like content`);
  return value.trim();
}

function safeOriginalName(value, resourceId) {
  const name = safeString(value, `${resourceId}.originalName`, 240);
  assert(basename(name) === name && name !== "." && name !== "..", `${resourceId}.originalName must be a basename`);
  assert(!/[\\/\0]/.test(name), `${resourceId}.originalName contains a path separator`);
  if (process.platform === "win32") {
    assert(!/[<>:"|?*]/.test(name), `${resourceId}.originalName contains a Windows-invalid character`);
    const stem = name.split(".", 1)[0].toUpperCase();
    assert(!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem), `${resourceId}.originalName is a reserved Windows filename`);
    assert(!/[ .]$/.test(name), `${resourceId}.originalName cannot end with a space or dot on Windows`);
  }
  return name;
}

function safeReleaseUrl(value, resourceId) {
  const raw = safeString(value, `${resourceId}.downloadUrl`, 2000);
  const url = new URL(raw);
  assert(url.protocol === "https:", `${resourceId}.downloadUrl must use HTTPS`);
  assert(url.hostname.toLowerCase() === "github.com", `${resourceId}.downloadUrl must use github.com`);
  assert(url.href.startsWith(RELEASE_PREFIX), `${resourceId}.downloadUrl must belong to ${OWNER}/${REPO} Releases`);
  return url.href;
}

function normaliseRecord(record, sourceKind) {
  const id = safeString(record.id, `${sourceKind}.id`, 64);
  assert(/^[a-z0-9][a-z0-9-]*$/.test(id), `${id}.id is invalid`);
  const type = safeString(record.type, `${id}.type`, 64);
  const title = safeString(record.title || record.originalName || record.downloadName || id, `${id}.title`, 500);
  const originalName = safeOriginalName(record.originalName || record.downloadName, id);
  const assetKey = safeString(record.assetKey, `${id}.assetKey`, 200);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetKey), `${id}.assetKey is invalid`);
  const sha256 = safeString(record.sha256, `${id}.sha256`, 64).toLowerCase();
  assert(SHA256_PATTERN.test(sha256), `${id}.sha256 is invalid`);
  return {
    id,
    type,
    title,
    originalName,
    assetKey,
    sha256,
    bytes: Number.isSafeInteger(record.bytes) && record.bytes >= 0 ? record.bytes : null,
    downloadUrl: safeReleaseUrl(record.downloadUrl, id),
  };
}

function recordsFromDocument(document, sourceKind) {
  const records = Array.isArray(document?.resources)
    ? document.resources.map((record) => normaliseRecord({
      ...record,
      originalName: record.downloadName,
    }, "catalog"))
    : Array.isArray(document?.assets)
      ? document.assets.map((record) => normaliseRecord(record, "manifest"))
      : null;
  assert(records, `${sourceKind} must contain resources[] or assets[]`);
  const ids = new Set();
  const assetKeys = new Set();
  for (const record of records) {
    assert(!ids.has(record.id), `Duplicate resource ID: ${record.id}`);
    assert(!assetKeys.has(record.assetKey), `Duplicate assetKey: ${record.assetKey}`);
    ids.add(record.id);
    assetKeys.add(record.assetKey);
  }
  return records;
}

function bundleRecordFromCatalog(document, sourceKind) {
  if (!Array.isArray(document?.resources)) return null;
  const bundle = document.bundle;
  assert(bundle, `${sourceKind} does not contain bundle metadata`);
  return normaliseRecord({
    ...bundle,
    id: "bundle",
    type: "bundle",
    title: bundle.title || bundle.assetKey,
    originalName: bundle.assetKey,
    sha256: bundle.sha256,
    downloadUrl: bundle.url,
  }, "catalog");
}

async function readDocument(value, options) {
  if (/^https:\/\//i.test(value)) {
    const text = await readRemoteText(value, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "nxn-resource-downloader" },
      proxy: options.proxy,
      proxyEnv: options["proxy-env"],
      retries: options.retries,
      connectTimeoutMs: options.connectTimeoutMs,
      stallTimeoutMs: options.stallTimeoutMs,
    });
    return JSON.parse(text);
  }
  assert(!/^http:\/\//i.test(value), "Only HTTPS document URLs are supported");
  return JSON.parse(await readFile(resolve(value), "utf8"));
}

async function sha256File(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(file, { highWaterMark: 1 << 22 })
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

async function downloadToTemporaryFile(record, temporaryFile, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      await downloadUrlToFile(record.downloadUrl, temporaryFile, {
        headers: { Accept: "application/octet-stream", "User-Agent": "nxn-resource-downloader" },
        proxy: options.proxy,
        proxyEnv: options["proxy-env"],
        retries: 1,
        connectTimeoutMs: options.connectTimeoutMs,
        stallTimeoutMs: options.stallTimeoutMs,
      });
      const bytes = (await stat(temporaryFile)).size;
      const actualSha256 = await sha256File(temporaryFile);
      if (record.bytes !== null) assert(bytes === record.bytes, `size mismatch: expected ${record.bytes}, got ${bytes}`);
      assert(actualSha256 === record.sha256, `SHA-256 mismatch: expected ${record.sha256}, got ${actualSha256}`);
      return { bytes, sha256: actualSha256 };
    } catch (error) {
      lastError = error;
      await rm(temporaryFile, { force: true });
      if (attempt < options.retries) await sleep(1000 * attempt);
    }
  }
  throw new Error(`failed after ${options.retries} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function replaceFile(source, destination) {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
  }
  await rm(destination, { force: true });
  await rename(source, destination);
}

async function downloadRecord(record, options) {
  const destination = join(options.output, record.originalName);
  const existing = await stat(destination).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`${record.id} output path is a directory: ${destination}`);
  if (existing?.isFile() && !options.force) {
    const actualSha256 = await sha256File(destination);
    if (actualSha256 === record.sha256) {
      return { ...record, path: destination, status: "skipped", bytes: (await stat(destination)).size };
    }
  }

  const temporaryFile = join(
    dirname(destination),
    `.nxn-${process.pid}-${randomBytes(6).toString("hex")}.part`,
  );
  try {
    const downloaded = await downloadToTemporaryFile(record, temporaryFile, options);
    await replaceFile(temporaryFile, destination);
    return {
      ...record,
      path: destination,
      status: "downloaded",
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
    };
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

function selectRecords(records, options) {
  const ids = csv(options.ids);
  const types = csv(options.types);
  assert(!(ids.length && types.length), "--ids and --types cannot be used together");
  assert(!(options.all && (ids.length || types.length)), "--all cannot be combined with --ids or --types");
  const selected = ids.length
    ? records.filter((record) => ids.includes(record.id))
    : types.length
      ? records.filter((record) => types.includes(record.type))
      : records;
  if (ids.length) {
    const found = new Set(selected.map((record) => record.id));
    const missing = ids.filter((id) => !found.has(id));
    assert(missing.length === 0, `Unknown resource IDs: ${missing.join(", ")}`);
  }
  assert(selected.length > 0, "No resources matched the requested filters");

  const seenNames = new Set();
  for (const record of selected) {
    const key = process.platform === "win32" ? record.originalName.toLowerCase() : record.originalName;
    assert(!seenNames.has(key), `Multiple selected resources use output filename ${record.originalName}`);
    seenNames.add(key);
  }
  return selected;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  const sourceCount = [options.catalog, options["catalog-url"], options.manifest, options["manifest-url"]].filter(Boolean).length;
  assert(sourceCount <= 1, "Use only one catalog or manifest source");
  assert(options.output, "--output is required");
  const concurrency = options.concurrency === undefined ? 3 : Number(options.concurrency);
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16, "--concurrency must be an integer from 1 to 16");
  options.retries = positiveInteger(options.retries === undefined ? 3 : options.retries, "--retries", { min: 1, max: 10 });
  options.connectTimeoutMs = positiveInteger(
    options["connect-timeout"] === undefined ? 20 : options["connect-timeout"],
    "--connect-timeout",
    { min: 1, max: 300 },
  ) * 1000;
  options.stallTimeoutMs = positiveInteger(
    options["stall-timeout"] === undefined ? 60 : options["stall-timeout"],
    "--stall-timeout",
    { min: 10, max: 3600 },
  ) * 1000;

  const sourceValue = options.catalog
    || options["catalog-url"]
    || options.manifest
    || options["manifest-url"]
    || DEFAULT_CATALOG_URL;
  const document = await readDocument(sourceValue, options);
  let records = recordsFromDocument(document, sourceValue);
  if (options["include-bundle"]) {
    const bundle = bundleRecordFromCatalog(document, sourceValue);
    assert(bundle, "--include-bundle requires a catalog source");
    records = [bundle, ...records];
  }
  const selected = selectRecords(records, options);
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });

  const results = new Array(selected.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      const record = selected[index];
      try {
        results[index] = await downloadRecord(record, { ...options, output });
        if (!options.json) process.stderr.write(`[${index + 1}/${selected.length}] ${results[index].status} ${record.originalName}\n`);
      } catch (error) {
        results[index] = {
          ...record,
          path: join(output, record.originalName),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        if (!options.json) process.stderr.write(`[${index + 1}/${selected.length}] failed ${record.originalName}: ${results[index].error}\n`);
      }
    }
  });
  await Promise.all(workers);

  const summary = {
    total: results.length,
    downloaded: results.filter((result) => result.status === "downloaded").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
  const report = {
    schemaVersion: 1,
    catalogVersion: document.catalogVersion || null,
    source: sourceValue,
    outputDirectory: output,
    summary,
    resources: results,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`Downloaded ${summary.downloaded}, skipped ${summary.skipped}, failed ${summary.failed}; output: ${output}\n`);
  if (summary.failed) process.exitCode = 1;
}

try {
  await run();
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
