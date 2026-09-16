#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

const OWNER = "3Fu";
const REPO = "nxn_resource";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const MAX_PREVIEW_BYTES = 95 * 1024 * 1024;
const TYPES = new Set(["ppt", "poster", "video", "document"]);
const PREVIEWS = new Set(["pdf", "image", "video", "document"]);
const URL_HOSTS = new Set(["3fu.github.io", "cdn.jsdelivr.net", "raw.githubusercontent.com", "github.com", "ghproxy.net", "gh-proxy.com"]);

function loadLocalEnv() {
  const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

loadLocalEnv();

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("Usage:\n  resource-center.mjs stage-initial --workspace DIR --website-root DIR\n  resource-center.mjs validate --workspace DIR\n  resource-center.mjs publish --workspace DIR\n  resource-center.mjs rollback --version VERSION\n");
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
    assert(TYPES.has(resource.type) && PREVIEWS.has(resource.previewKind), `Resource ${resource.id} type is invalid`);
    assert(/^[a-f0-9]{64}$/.test(resource.sha256), `Resource ${resource.id} sha256 is invalid`);
    assert(Number.isFinite(Date.parse(resource.updatedAt)), `Resource ${resource.id} updatedAt is invalid`);
    safeAssetKey(resource.assetKey, `${resource.id}.assetKey`);
    assert(!assetKeys.has(resource.assetKey), `Duplicate assetKey ${resource.assetKey}`);
    assetKeys.add(resource.assetKey);
    safeUrl(resource.url, `${resource.id}.url`);
    const downloadUrl = safeUrl(resource.downloadUrl, `${resource.id}.downloadUrl`);
    assert(downloadUrl.hostname === "github.com" && downloadUrl.pathname.includes(`/${OWNER}/${REPO}/releases/download/`), `${resource.id}.downloadUrl must be an official Release URL`);
    if (resource.coverUrl) safeUrl(resource.coverUrl, `${resource.id}.coverUrl`);
    if (resource.previewSections) for (const section of resource.previewSections) {
      safeString(section.title, `${resource.id}.previewSections.title`, 120);
      safeString(section.content, `${resource.id}.previewSections.content`, 1000);
    }
    const asset = join(workspace, "assets", resource.assetKey);
    assert(existsSync(asset), `Missing original asset ${resource.assetKey}`);
    assert(await sha256(asset) === resource.sha256, `SHA-256 mismatch for ${resource.assetKey}`);
    assets.push(asset);
    if (resource.previewKind !== "document") {
      const preview = previewFileFromUrl(workspace, resource.url);
      assert(preview && existsSync(preview), `Missing preview for ${resource.id}`);
      if (resource.previewKind === "video") assert((await stat(preview)).size < MAX_PREVIEW_BYTES, `Video preview for ${resource.id} must be smaller than 95 MiB`);
    }
    if (resource.coverUrl) {
      const cover = previewFileFromUrl(workspace, resource.coverUrl);
      assert(cover && existsSync(cover), `Missing cover for ${resource.id}`);
    }
  }
  safeAssetKey(catalog.bundle?.assetKey, "bundle.assetKey");
  assert(!assetKeys.has(catalog.bundle.assetKey), `bundle.assetKey conflicts with a resource assetKey`);
  safeString(catalog.bundle?.title, "bundle.title");
  safeUrl(catalog.bundle?.url, "bundle.url");
  process.stdout.write(`Validated ${catalog.resources.length} resources for ${catalog.catalogVersion}.\n`);
  return { catalog, assets };
}

async function ensureParent(file) {
  await mkdir(dirname(file), { recursive: true });
}

async function copy(source, destination) {
  await ensureParent(destination);
  await copyFile(source, destination);
}

async function stageInitial(workspace, websiteRoot) {
  await mkdir(join(workspace, "assets"), { recursive: true });
  await mkdir(join(workspace, "docs", "previews"), { recursive: true });
  const moduleUrl = pathToFileURL(join(websiteRoot, "src", "data", "workstationResourceCatalog.js")).href;
  const catalog = JSON.parse(JSON.stringify((await import(`${moduleUrl}?v=${Date.now()}`)).default));
  const localFiles = {
    "007.mp4": join(websiteRoot, "src", "assets", "007.mp4"),
  };
  for (const resource of catalog.resources) localFiles[resource.assetKey] ||= join(websiteRoot, "public", "workstation-resources", resource.assetKey);
  for (const resource of catalog.resources) await copy(localFiles[resource.assetKey], join(workspace, "assets", resource.assetKey));

  const previews = {
    "workstation-deck": join(websiteRoot, "public", "workstation-resources", "deck-20260714.pdf"),
    "operations-training": join(websiteRoot, "public", "workstation-resources", "operations-training-20260820.pdf"),
    "poster-h106": join(websiteRoot, "public", "workstation-resources", "poster-h106.png"),
    "poster-h106h2": join(websiteRoot, "public", "workstation-resources", "poster-h106h2.png"),
  };
  for (const resource of catalog.resources.filter((item) => previews[item.id])) await copy(previews[resource.id], previewFileFromUrl(workspace, resource.url));
  const video = catalog.resources.find((item) => item.id === "nxn-intro-video");
  if (video) {
    await copy(join(websiteRoot, "video-frame-10.jpg"), previewFileFromUrl(workspace, video.coverUrl));
    const videoPreview = previewFileFromUrl(workspace, video.url);
    await ensureParent(videoPreview);
    const ffmpeg = spawnSync("ffmpeg", ["-y", "-i", localFiles[video.assetKey], "-c:v", "libx264", "-preset", "medium", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", videoPreview], { stdio: "inherit" });
    assert(ffmpeg.status === 0, "ffmpeg is required and must successfully generate the video preview");
    assert((await stat(videoPreview)).size < MAX_PREVIEW_BYTES, "Generated video preview is at least 95 MiB; increase CRF and retry");
  }
  await ensureParent(join(workspace, "docs", "catalog.json"));
  await writeFile(join(workspace, "docs", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await validate(workspace);
  process.stdout.write(`Initial workspace staged at ${workspace}.\n`);
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

async function createBundle(workspace, catalog, assets) {
  const zip = new JSZip();
  for (const asset of assets) zip.file(basename(asset), await readFile(asset));
  const destination = join(workspace, "assets", catalog.bundle.assetKey);
  await writeFile(destination, await zip.generateAsync({ type: "nodebuffer", compression: "STORE", streamFiles: true }));
  catalog.bundle.sha256 = await sha256(destination);
  catalog.bundle.size = `${((await stat(destination)).size / 1024 / 1024).toFixed(1)} MB`;
  return destination;
}

function token() {
  const value = process.env.NXN_RESOURCE_GITHUB_TOKEN;
  assert(value, "NXN_RESOURCE_GITHUB_TOKEN is not configured");
  return value;
}

async function github(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const response = await fetch(path.startsWith("https:") ? path : `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...headers },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
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

async function getOrCreateDraft(tag) {
  const releases = await github("/releases?per_page=100");
  const matches = releases.filter((release) => release.tag_name === tag);
  assert(matches.length <= 1, `Multiple releases already exist for ${tag}; resolve them before publishing`);
  const existing = matches[0];
  if (existing) {
    assert(existing.draft, `Release ${tag} already exists and is not a draft`);
    return existing;
  }
  return github("/releases", { method: "POST", body: { tag_name: tag, target_commitish: "main", name: `NXN 资料中心 ${tag.replace("resources-", "")}`, draft: true, prerelease: false } });
}

async function uploadAsset(release, file) {
  const info = await stat(file);
  const existing = release.assets?.find((asset) => asset.name === basename(file));
  if (existing) {
    assert(existing.size === info.size, `Draft already has ${existing.name} with a different size; create a new catalog version`);
    process.stdout.write(`Skipped existing ${existing.name}.\n`);
    return;
  }
  const uploadUrl = release.upload_url.replace("{?name,label}", `?name=${encodeURIComponent(basename(file))}`);
  await github(uploadUrl, { method: "POST", body: await readFile(file), raw: true, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(info.size) } });
  process.stdout.write(`Uploaded ${basename(file)}.\n`);
}

async function publish(workspace) {
  const repo = await github("");
  assert(repo.full_name === `${OWNER}/${REPO}` && !repo.private && !repo.archived, `${OWNER}/${REPO} must be a writable public repository`);
  const { catalog, assets } = await validate(workspace);
  const previous = await currentCatalog();
  if (previous) {
    assert(previous.schemaVersion === 1 && typeof previous.catalogVersion === "string" && /^\d+(?:\.\d+)+$/.test(previous.catalogVersion), "Current catalog is invalid");
    assert(compareVersions(catalog.catalogVersion, previous.catalogVersion) > 0, `catalogVersion must be newer than ${previous.catalogVersion}`);
  }
  const tag = `resources-${catalog.catalogVersion}`;
  assert(catalog.resources.every((item) => new URL(item.downloadUrl).pathname.includes(`/releases/download/${tag}/`)), `Every downloadUrl must target ${tag}`);
  assert(new URL(catalog.bundle.url).pathname.includes(`/releases/download/${tag}/`), `bundle.url must target ${tag}`);
  const bundle = await createBundle(workspace, catalog, assets);
  await writeFile(join(workspace, "docs", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  const release = await getOrCreateDraft(tag);
  const currentTagAssets = assets.filter((asset) => catalog.resources.some((item) => item.assetKey === basename(asset) && new URL(item.downloadUrl).pathname.includes(`/releases/download/${tag}/`)));
  for (const asset of [...currentTagAssets, bundle]) await uploadAsset(release, asset);

  const previewRoot = join(workspace, "docs", "previews");
  await putFiles(workspace, await filesUnder(previewRoot), `Publish ${catalog.catalogVersion} previews`);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  await putContent(`docs/catalogs/${catalog.catalogVersion}.json`, serialized, `Archive resource catalog ${catalog.catalogVersion}`);
  await github(`/releases/${release.id}`, { method: "PATCH", body: { draft: false } });
  await putContent("docs/catalog.json", serialized, `Activate resource catalog ${catalog.catalogVersion}`);
  process.stdout.write(`Published ${tag}. Catalog: https://${OWNER.toLowerCase()}.github.io/${REPO}/catalog.json\n`);
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
  if (command === "stage-initial") await stageInitial(resolve(options.workspace || usage("--workspace is required")), resolve(options["website-root"] || process.cwd()));
  else if (command === "validate") await validate(resolve(options.workspace || usage("--workspace is required")));
  else if (command === "publish") await publish(resolve(options.workspace || usage("--workspace is required")));
  else if (command === "rollback") await rollback(options.version);
  else usage(command ? `Unknown command ${command}` : undefined);
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
