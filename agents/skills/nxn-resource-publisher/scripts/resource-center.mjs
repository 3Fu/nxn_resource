#!/usr/bin/env node
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const OWNER = "3Fu";
const REPO = "nxn_resource";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const CATALOG_URL = `https://${OWNER.toLowerCase()}.github.io/${REPO}/catalog.json`;
const MAX_PREVIEW_BYTES = 95 * 1024 * 1024;
// 资源类型与预览类型不再使用固定枚举，新增素材种类不需要改这里。
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// 预览托管在 Pages（docs/previews）的两类：PPT 用 PDF，图片用浏览器兼容图片。
const PAGE_PREVIEW_KINDS = new Set(["pdf", "image"]);
// 直接引用 Release 原件的两类：video 在线播放，download 只给下载入口。
const RELEASE_PREVIEW_KINDS = new Set(["video", "download"]);
const URL_HOSTS = new Set([
  "3fu.github.io",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "ghproxy.net",
  "gh-proxy.com",
]);

function loadLocalEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const envFile of [join(here, "..", ".env"), join(here, "..", "..", ".env")]) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith("#")) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}

loadLocalEnv();

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("Usage:\n  resource-center.mjs validate --workspace DIR\n  resource-center.mjs verify-remote --workspace DIR [--catalog-url URL] [--assets true]\n  resource-center.mjs release --workspace DIR [--allow-same-version true]\n  resource-center.mjs publish --workspace DIR [--root DIR] [--allow-same-version true]\n  resource-center.mjs rollback --version VERSION\n\nrelease uploads changed originals plus the bundle and publishes the Release, leaving git to the caller.\npublish runs release first, then commits previews and the catalog through the GitHub API. With --root it mirrors the final catalog, manifest, previews, and git-distributed originals back into the source repository.\nverify-remote compares the workspace catalog with the public Pages catalog and can probe published Release assets.\n");
  process.exit(message ? 2 : 0);
}

function argsOf(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || !rest[index + 1]) usage(`Invalid option ${rest[index] || ""}`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeString(value, name, max = 500, allowEmpty = false) {
  assert(typeof value === "string" && (allowEmpty || value.trim()) && value.length <= max, `${name} is invalid`);
  assert(!/[<>]/.test(value), `${name} contains HTML-like content`);
}

function safeUrl(value, name) {
  safeString(value, name, 2000);
  const url = new URL(value);
  assert(url.protocol === "https:" && URL_HOSTS.has(url.hostname.toLowerCase()), `${name} host is not allowed`);
  return url;
}

function safeAssetKey(value, name) {
  safeString(value, name, 200);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), `${name} must be a URL-safe filename`);
}

function safeDownloadName(value, name) {
  safeString(value, name, 500);
  assert(basename(value) === value && value !== "." && value !== "..", `${name} must not contain path separators`);
}

function releaseInfo(value, name) {
  const url = safeUrl(value, name);
  const prefix = `/${OWNER}/${REPO}/releases/download/`;
  assert(url.hostname === "github.com" && url.pathname.startsWith(prefix), `${name} must belong to ${OWNER}/${REPO}`);
  const match = url.pathname.slice(prefix.length).match(/^(resources-(\d+(?:\.\d+)+))\//);
  assert(match, `${name} must point to a resources-<version> Release in ${OWNER}/${REPO}`);
  return { url, tag: match[1], version: match[2] };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function previewFileFromUrl(workspace, urlValue) {
  const url = safeUrl(urlValue, "preview URL");
  if (url.hostname !== "3fu.github.io") return null;
  assert(url.pathname.startsWith(`/${REPO}/`), `Preview URL must be under /${REPO}/`);
  const pathParts = decodeURIComponent(url.pathname.slice(REPO.length + 2)).split("/");
  assert(!pathParts.some((part) => !part || part === "." || part === ".."), "Preview URL path is unsafe");
  return join(workspace, "docs", ...pathParts);
}

async function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

async function fetchRemoteCatalog(catalogUrl, expectedVersion) {
  const url = safeUrl(catalogUrl, "catalog URL");
  let lastVersion = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    url.searchParams.set("published", `${Date.now()}-${attempt}`);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      assert(response.ok, `Unable to read remote catalog: HTTP ${response.status}`);
      const catalog = JSON.parse(await response.text());
      lastVersion = catalog?.catalogVersion || null;
      if (lastVersion === expectedVersion) return catalog;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 8) await sleep(3000);
  }
  if (lastError) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Remote catalog check failed for ${url.origin}${url.pathname}: ${detail}`);
  }
  throw new Error(`Remote catalog is still ${lastVersion || "unknown"}; expected ${expectedVersion}`);
}

async function probePublicUrl(urlValue, name, { range = false } = {}) {
  const url = safeUrl(urlValue, name);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          ...(range ? { Range: "bytes=0-0" } : {}),
          "Cache-Control": "no-cache",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      try {
        assert(response.ok, `${name} is unavailable: HTTP ${response.status}`);
        return;
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${name} check failed for ${url.href}: ${detail}`);
}

async function loadCatalog(workspace) {
  const file = join(workspace, "docs", "catalog.json");
  const catalog = JSON.parse(await readFile(file, "utf8"));
  return { file, catalog };
}

async function validate(workspace) {
  const { catalog } = await loadCatalog(workspace);
  assert(catalog?.schemaVersion === 1, "schemaVersion must be 1");
  safeString(catalog.catalogVersion, "catalogVersion", 64);
  assert(/^\d+(?:\.\d+)+$/.test(catalog.catalogVersion), "catalogVersion must be numeric and dot-separated");
  assert(Number.isFinite(Date.parse(catalog.updatedAt)), "updatedAt must be ISO-8601");
  assert(Array.isArray(catalog.sources) && catalog.sources.length > 0, "sources must not be empty");
  assert(Array.isArray(catalog.resources) && catalog.resources.length > 0, "resources must not be empty");

  const sourceIds = new Set();
  for (const source of catalog.sources) {
    safeString(source.id, "source.id", 64);
    safeString(source.label, "source.label", 64);
    assert(!sourceIds.has(source.id), `Duplicate source ${source.id}`);
    sourceIds.add(source.id);
    assert(typeof source.enabled === "boolean" && Number.isFinite(source.order), `Source ${source.id} is invalid`);
    if (source.prefix) safeUrl(source.prefix, `source ${source.id} prefix`);
  }
  assert(catalog.sources.some((source) => source.id === "github" && source.enabled && source.prefix === ""), "An enabled github source with empty prefix is required");

  const ids = new Set();
  const assetKeys = new Set();
  const assets = [];
  for (const resource of catalog.resources) {
    for (const field of ["id", "type", "typeLabel", "title", "description", "format", "size", "url", "downloadUrl", "downloadName", "downloadLabel", "previewKind", "sha256", "assetKey", "updatedAt"]) safeString(resource[field], `${resource.id || "resource"}.${field}`, field.endsWith("Url") || field === "url" ? 2000 : 500);
    assert(/^[a-z0-9][a-z0-9-]*$/.test(resource.id) && !ids.has(resource.id), `Resource ID ${resource.id} is invalid or duplicated`);
    ids.add(resource.id);
    assert(KIND_PATTERN.test(resource.type), `Resource ${resource.id} type is invalid`);
    assert(KIND_PATTERN.test(resource.previewKind), `Resource ${resource.id} previewKind is invalid`);
    assert(/^[a-f0-9]{64}$/.test(resource.sha256), `Resource ${resource.id} sha256 is invalid`);
    assert(Number.isFinite(Date.parse(resource.updatedAt)), `Resource ${resource.id} updatedAt is invalid`);
    safeAssetKey(resource.assetKey, `${resource.id}.assetKey`);
    safeDownloadName(resource.downloadName, `${resource.id}.downloadName`);
    assert(!assetKeys.has(resource.assetKey), `Duplicate assetKey ${resource.assetKey}`);
    assetKeys.add(resource.assetKey);
    safeUrl(resource.url, `${resource.id}.url`);
    const download = releaseInfo(resource.downloadUrl, `${resource.id}.downloadUrl`);
    assert(download.url.hostname === "github.com", `${resource.id}.downloadUrl must be an official GitHub URL`);
    assert(compareVersions(download.version, catalog.catalogVersion) <= 0, `${resource.id}.downloadUrl must not target a future catalog version`);
    assert(download.url.pathname.endsWith(`/${resource.assetKey}`), `${resource.id}.downloadUrl must end with ${resource.assetKey}`);
    if (resource.coverUrl) safeUrl(resource.coverUrl, `${resource.id}.coverUrl`);
    if (resource.previewSections) for (const section of resource.previewSections) {
      safeString(section.title, `${resource.id}.previewSections.title`, 120);
      safeString(section.content, `${resource.id}.previewSections.content`, 1000);
    }
    const asset = join(workspace, "assets", resource.assetKey);
    assert(existsSync(asset), `Missing original asset ${resource.assetKey}`);
    assert(await sha256(asset) === resource.sha256, `SHA-256 mismatch for ${resource.assetKey}`);
    assets.push(asset);
    if (PAGE_PREVIEW_KINDS.has(resource.previewKind)) {
      const preview = previewFileFromUrl(workspace, resource.url);
      assert(preview && existsSync(preview), `Missing preview for ${resource.id}`);
      assert((await stat(preview)).size < MAX_PREVIEW_BYTES, `Preview for ${resource.id} must be smaller than 95 MiB`);
    } else if (RELEASE_PREVIEW_KINDS.has(resource.previewKind)) {
      const streaming = safeUrl(resource.url, `${resource.id}.url`);
      assert(streaming.hostname === "github.com" && streaming.pathname.endsWith(`/${resource.assetKey}`), `${resource.id}.url must stream the same Release asset as downloadUrl`);
    }
    if (resource.coverUrl) {
      const cover = previewFileFromUrl(workspace, resource.coverUrl);
      assert(cover && existsSync(cover), `Missing cover for ${resource.id}`);
    }
  }
  safeAssetKey(catalog.bundle?.assetKey, "bundle.assetKey");
  assert(!assetKeys.has(catalog.bundle.assetKey), `bundle.assetKey conflicts with a resource assetKey`);
  safeString(catalog.bundle?.title, "bundle.title");
  const bundle = releaseInfo(catalog.bundle?.url, "bundle.url");
  assert(bundle.tag === `resources-${catalog.catalogVersion}`, "bundle.url must target the current catalog version");
  assert(bundle.url.pathname.endsWith(`/${catalog.bundle.assetKey}`), "bundle.url must end with bundle.assetKey");
  process.stdout.write(`Validated ${catalog.resources.length} resources for ${catalog.catalogVersion}.\n`);
  return { catalog, assets };
}

async function ensureParent(file) {
  await mkdir(dirname(file), { recursive: true });
}

async function copy(source, destination) {
  if (resolve(source) === resolve(destination)) return;
  try {
    const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destination)]);
    if (sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino) return;
  } catch {
    // A missing destination is handled by copyFile below.
  }
  await ensureParent(destination);
  await copyFile(source, destination);
}

async function verifyRemote(workspace, { catalogUrl, assets = false } = {}) {
  const { catalog } = await loadCatalog(workspace);
  const remote = await fetchRemoteCatalog(catalogUrl || CATALOG_URL, catalog.catalogVersion);
  assert(isDeepStrictEqual(remote, catalog), "Remote catalog does not match the prepared workspace catalog");
  process.stdout.write(`Remote catalog matches ${catalog.catalogVersion} with ${catalog.resources.length} resources.\n`);

  if (assets) {
    const releaseUrls = new Map(catalog.resources.map((resource) => [resource.downloadUrl, `${resource.id}.downloadUrl`]));
    releaseUrls.set(catalog.bundle.url, "bundle.url");
    for (const [url, name] of releaseUrls) await probePublicUrl(url, name, { range: true });

    const previewUrls = new Map();
    for (const resource of catalog.resources) {
      if (resource.url !== resource.downloadUrl) previewUrls.set(resource.url, `${resource.id}.preview`);
      if (resource.coverUrl) previewUrls.set(resource.coverUrl, `${resource.id}.coverUrl`);
    }
    for (const [url, name] of previewUrls) await probePublicUrl(url, name);

    process.stdout.write(`Verified ${releaseUrls.size} published Release assets by range request.\n`);
    process.stdout.write(`Verified ${previewUrls.size} public preview assets.\n`);
  }
}

async function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else output.push(path);
  }
  return output;
}

/* ---------- 流式 ZIP（STORE，无第三方依赖，内存占用恒定） ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(chunk, seed) {
  let value = seed;
  for (let index = 0; index < chunk.length; index += 1) value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ value >>> 8;
  return value >>> 0;
}

async function crc32OfFile(file) {
  let value = 0xffffffff;
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 22 })) value = crc32(chunk, value);
  return (value ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

async function createBundle(workspace, catalog, assets, displayNames) {
  const destination = join(workspace, "assets", catalog.bundle.assetKey);
  const stamp = dosStamp(new Date(catalog.updatedAt));
  const out = createWriteStream(destination);
  const central = [];
  let offset = 0;
  const push = async (chunk) => {
    offset += chunk.length;
    if (!out.write(chunk)) await once(out, "drain");
  };
  try {
    for (const asset of assets) {
      const key = basename(asset);
      const name = Buffer.from(displayNames.get(key) || key, "utf8");
      const size = (await stat(asset)).size;
      const crc = await crc32OfFile(asset);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const entryOffset = offset;
      await push(local);
      await push(name);
      for await (const chunk of createReadStream(asset, { highWaterMark: 1 << 22 })) await push(chunk);
      central.push({ name, crc, size, offset: entryOffset });
      process.stdout.write(`Bundled ${key}.\n`);
    }
    assert(offset < 0xffffffff, "Bundle exceeds the classic ZIP limit; a new layout is required");
    const centralOffset = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);
      await push(header);
      await push(entry.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await push(end);
  } finally {
    await new Promise((done, fail) => {
      out.on("error", fail);
      out.end(done);
    });
  }
  catalog.bundle.sha256 = await sha256(destination);
  catalog.bundle.size = `${((await stat(destination)).size / 1024 / 1024).toFixed(1)} MB`;
  return destination;
}

function token() {
  const value = process.env.NXN_RESOURCE_GITHUB_TOKEN;
  assert(value, "NXN_RESOURCE_GITHUB_TOKEN is not configured");
  return value;
}

async function github(path, { method = "GET", body, headers = {}, raw = false, stream = false } = {}) {
  const response = await fetch(path.startsWith("https:") ? path : `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...headers },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    ...(stream ? { duplex: "half" } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function putContent(repoPath, content, message) {
  let sha;
  try { sha = (await github(`/contents/${repoPath}?ref=main`)).sha; } catch (error) { if (!error.message.includes("(404)")) throw error; }
  await github(`/contents/${repoPath}`, { method: "PUT", body: { message, content: Buffer.from(content).toString("base64"), branch: "main", ...(sha ? { sha } : {}) } });
}

async function putFiles(workspace, files, message) {
  if (!files.length) return;
  const reference = await github("/git/ref/heads/main");
  const parent = await github(`/git/commits/${reference.object.sha}`);
  const tree = [];
  for (const file of files) {
    const blob = await github("/git/blobs", {
      method: "POST",
      body: { content: (await readFile(file)).toString("base64"), encoding: "base64" },
    });
    tree.push({ path: relative(workspace, file).split(sep).join("/"), mode: "100644", type: "blob", sha: blob.sha });
  }
  const nextTree = await github("/git/trees", { method: "POST", body: { base_tree: parent.tree.sha, tree } });
  const commit = await github("/git/commits", {
    method: "POST",
    body: { message, tree: nextTree.sha, parents: [reference.object.sha] },
  });
  await github("/git/refs/heads/main", { method: "PATCH", body: { sha: commit.sha, force: false } });
}

async function currentCatalog() {
  try {
    const file = await github("/contents/docs/catalog.json?ref=main");
    return JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"));
  } catch (error) {
    if (error.message.includes("(404)")) return null;
    throw error;
  }
}

async function getOrCreateRelease(tag, { allowPublished = false } = {}) {
  const releases = await github("/releases?per_page=100");
  const matches = releases.filter((release) => release.tag_name === tag);
  assert(matches.length <= 1, `Multiple releases already exist for ${tag}; resolve them before publishing`);
  const existing = matches[0];
  if (existing) {
    assert(existing.draft || allowPublished, `Release ${tag} already exists and is not a draft`);
    return existing;
  }
  return github("/releases", { method: "POST", body: { tag_name: tag, target_commitish: "main", name: `NXN 资料中心 ${tag.replace("resources-", "")}`, draft: true, prerelease: false } });
}

async function uploadAsset(release, file) {
  const info = await stat(file);
  const existing = release.assets?.find((asset) => asset.name === basename(file));
  if (existing) {
    assert(existing.size === info.size, `Draft already has ${existing.name} with a different size; create a new catalog version`);
    if (existing.digest) {
      const expected = `sha256:${await sha256(file)}`;
      assert(existing.digest.toLowerCase() === expected, `Release already has ${existing.name} with a different SHA-256; create a new catalog version`);
    }
    process.stdout.write(`Skipped existing ${existing.name}${existing.digest ? " (SHA-256 verified)" : ""}.\n`);
    return;
  }
  const uploadUrl = release.upload_url.replace("{?name,label}", `?name=${encodeURIComponent(basename(file))}`);
  process.stdout.write(`Uploading ${basename(file)} (${(info.size / 1024 / 1024).toFixed(1)} MB)...\n`);
  await github(uploadUrl, {
    method: "POST",
    body: Readable.toWeb(createReadStream(file, { highWaterMark: 1 << 22 })),
    raw: true,
    stream: true,
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(info.size) },
  });
  process.stdout.write(`Uploaded ${basename(file)}.\n`);
}

async function publishRelease(workspace, { finalize = true, dryRun = false, allowSameVersion = false } = {}) {
  const { catalog, assets } = await validate(workspace);
  const tag = `resources-${catalog.catalogVersion}`;
  assert(new URL(catalog.bundle.url).pathname.includes(`/releases/download/${tag}/`), `bundle.url must target ${tag}`);
  const displayNames = new Map(catalog.resources.map((item) => [item.assetKey, item.downloadName]));
  const bundle = await createBundle(workspace, catalog, assets, displayNames);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const workspaceCatalog = join(workspace, "docs", "catalog.json");
  const workspaceArchive = join(workspace, "docs", "catalogs", `${catalog.catalogVersion}.json`);
  await ensureParent(workspaceCatalog);
  await writeFile(workspaceCatalog, serialized, "utf8");
  await ensureParent(workspaceArchive);
  await writeFile(workspaceArchive, serialized, "utf8");
  if (dryRun) {
    process.stdout.write(`Dry run: ${basename(bundle)} is ready (${catalog.bundle.size}, sha256 ${catalog.bundle.sha256}); release ${tag} was not created.\n`);
    return { catalog, release: null, bundle };
  }
  const repo = await github("");
  assert(repo.full_name === `${OWNER}/${REPO}` && !repo.private && !repo.archived, `${OWNER}/${REPO} must be a writable public repository`);
  const previous = await currentCatalog();
  let allowPublished = !previous;
  if (previous) {
    assert(previous.schemaVersion === 1 && typeof previous.catalogVersion === "string" && /^\d+(?:\.\d+)+$/.test(previous.catalogVersion), "Current catalog is invalid");
    const comparison = compareVersions(catalog.catalogVersion, previous.catalogVersion);
    assert(comparison >= 0, `catalogVersion must not be older than ${previous.catalogVersion}`);
    if (comparison === 0) assert(allowSameVersion, `${catalog.catalogVersion} is already published; bump the version, or pass --allow-same-version true to finish its Release`);
    allowPublished = comparison > 0 || allowSameVersion;
  }

  const release = await getOrCreateRelease(tag, { allowPublished });
  const currentTagAssetKeys = new Set(
    catalog.resources
      .filter((item) => releaseInfo(item.downloadUrl, `${item.id}.downloadUrl`).tag === tag)
      .map((item) => item.assetKey),
  );
  const currentTagAssets = assets.filter((asset) => currentTagAssetKeys.has(basename(asset)));
  for (const asset of [...currentTagAssets, bundle]) await uploadAsset(release, asset);
  if (finalize) {
    await github(`/releases/${release.id}`, { method: "PATCH", body: { draft: false } });
    process.stdout.write(`Release ${tag} published with ${currentTagAssets.length + 1} assets: https://github.com/${OWNER}/${REPO}/releases/tag/${tag}\n`);
  } else if (!release.draft) {
    process.stdout.write(`Release ${tag} is already published; verified ${currentTagAssets.length + 1} assets.\n`);
  } else {
    process.stdout.write(`Draft ${tag} staged with ${currentTagAssets.length + 1} assets; commit, push and then finalize the Release.\n`);
  }
  return { catalog, release, bundle };
}

async function mirrorPublishedWorkspace(workspace, root) {
  const manifestFile = join(workspace, "doc", "manifest.json");
  assert(existsSync(manifestFile), `Missing ${manifestFile}; use resource-sync.mjs prepare before publishing with --root`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert(manifest?.schemaVersion === 1 && Array.isArray(manifest.assets), "Workspace doc/manifest.json is invalid");
  const { catalog } = await loadCatalog(workspace);
  assert(manifest.catalogVersion === catalog.catalogVersion, "Workspace manifest and catalog versions differ");
  assert(resolve(root) !== resolve(workspace), "--root must be the source repository, not the release workspace");

  await copy(join(workspace, "docs", "catalog.json"), join(root, "docs", "catalog.json"));
  await copy(join(workspace, "docs", "catalogs", `${manifest.catalogVersion}.json`), join(root, "docs", "catalogs", `${manifest.catalogVersion}.json`));
  for (const file of await filesUnder(join(workspace, "docs", "previews"))) {
    await copy(file, join(root, "docs", "previews", relative(join(workspace, "docs", "previews"), file)));
  }
  for (const asset of manifest.assets.filter((entry) => entry.distribution === "git")) {
    safeAssetKey(asset.assetKey, "manifest assetKey");
    safeDownloadName(asset.originalName, "manifest originalName");
    const source = join(workspace, "assets", asset.assetKey);
    assert(existsSync(source), `Missing workspace asset ${asset.assetKey}`);
    await copy(source, join(root, "doc", asset.originalName));
  }
  await copy(manifestFile, join(root, "doc", "manifest.json"));
  process.stdout.write(`Synchronized published artifacts into ${root}.\n`);
}

async function publish(workspace, { root = null, allowSameVersion = false } = {}) {
  const { catalog, release } = await publishRelease(workspace, { finalize: false, allowSameVersion });
  const previewRoot = join(workspace, "docs", "previews");
  await putFiles(workspace, await filesUnder(previewRoot), `Publish ${catalog.catalogVersion} previews`);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  await putContent(`docs/catalogs/${catalog.catalogVersion}.json`, serialized, `Archive resource catalog ${catalog.catalogVersion}`);
  await github(`/releases/${release.id}`, { method: "PATCH", body: { draft: false } });
  await putContent("docs/catalog.json", serialized, `Activate resource catalog ${catalog.catalogVersion}`);
  if (root) await mirrorPublishedWorkspace(workspace, resolve(root));
  process.stdout.write(`Published resources-${catalog.catalogVersion}. Catalog: https://${OWNER.toLowerCase()}.github.io/${REPO}/catalog.json\n`);
}

async function rollback(version) {
  assert(/^\d+(?:\.\d+)+$/.test(version || ""), "A valid --version is required");
  const historical = await github(`/contents/docs/catalogs/${version}.json?ref=main`);
  const content = Buffer.from(historical.content.replace(/\s/g, ""), "base64").toString("utf8");
  const catalog = JSON.parse(content);
  assert(catalog.catalogVersion === version && catalog.schemaVersion === 1, "Historical catalog is invalid");
  await putContent("docs/catalog.json", `${JSON.stringify(catalog, null, 2)}\n`, `Roll back resource catalog to ${version}`);
  process.stdout.write(`Rolled back current catalog to ${version}; historical Releases were preserved.\n`);
}

const { command, options } = argsOf(process.argv.slice(2));
try {
  if (command === "validate") await validate(resolve(options.workspace || usage("--workspace is required")));
  else if (command === "verify-remote") await verifyRemote(resolve(options.workspace || usage("--workspace is required")), { catalogUrl: options["catalog-url"], assets: options.assets === "true" });
  else if (command === "release") await publishRelease(resolve(options.workspace || usage("--workspace is required")), { dryRun: options["dry-run"] === "true", allowSameVersion: options["allow-same-version"] === "true" });
  else if (command === "publish") await publish(resolve(options.workspace || usage("--workspace is required")), { root: options.root || null, allowSameVersion: options["allow-same-version"] === "true" });
  else if (command === "rollback") await rollback(options.version);
  else usage(command ? `Unknown command ${command}` : undefined);
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
