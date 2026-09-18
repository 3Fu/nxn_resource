#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, mkdirSync, renameSync, rmSync } from "node:fs";
import {
  copyFile,
  link as createLink,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadUrlToFile } from "./resource-network.mjs";

const OWNER = "3Fu";
const REPO = "nxn_resource";
const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".pptx", ".ppt", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".docx", ".doc"]);
const TYPE_LABELS = { ppt: "演示文稿", poster: "图片", video: "视频", document: "文档" };
const DEFAULT_LABELS = { ppt: "下载 PPTX", poster: "下载原图", video: "下载原视频", document: "下载原文件" };

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(scriptDirectory, "../../../..");
const metadataFile = join(skillDirectory, "references", "resource-metadata.json");
const workRoot = join(skillDirectory, ".work");

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage:\n"
    + "  resource-sync.mjs plan --input FILE_OR_DIRECTORY [--retire ID[,ID...]] [--version VERSION] [--root DIR]\n"
    + "  resource-sync.mjs prepare --input FILE_OR_DIRECTORY [--retire ID[,ID...]] [--version VERSION] [--workspace DIR] [--root DIR]\n"
    + "                              [--proxy URL] [--proxy-env true|false] [--retries N]\n"
    + "                              [--connect-timeout SECONDS] [--stall-timeout SECONDS]\n\n"
    + "plan inspects and validates the update without writing files.\n"
    + "prepare writes a candidate workspace for resource-center.mjs; --root defaults to this repository.\n"
    + "HTTPS_PROXY, ALL_PROXY, and NO_PROXY are detected automatically; proxied transfers use system curl.\n",
  );
  process.exit(message ? 2 : 0);
}

function argsOf(values) {
  const [command, ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) usage(`Invalid option ${rest[index] || ""}`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function retiredIdsOf(value) {
  if (!value) return [];
  const ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
  for (const id of ids) assert(/^[a-z0-9][a-z0-9-]*$/.test(id), `Invalid retire ID ${id}`);
  return ids;
}

function positiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed >= min && parsed <= max, `${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function booleanOption(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function isWithin(child, parent) {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeString(value, name, max = 500) {
  assert(typeof value === "string" && value.trim() && value.length <= max, `${name} is invalid`);
  assert(!/[<>]/.test(value), `${name} contains HTML-like content`);
  return value.trim();
}

function safeAssetKey(value, name) {
  safeString(value, name, 200);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), `${name} must be a URL-safe filename`);
  return value;
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

function localDateVersion(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join(".");
}

function nextCatalogVersion(currentVersion, requestedVersion) {
  if (requestedVersion) {
    assert(/^\d+(?:\.\d+)+$/.test(requestedVersion), "catalog version must be numeric and dot-separated");
    assert(!currentVersion || compareVersions(requestedVersion, currentVersion) > 0, `catalog version must be newer than ${currentVersion}`);
    return requestedVersion;
  }
  const dateVersion = localDateVersion();
  if (currentVersion?.startsWith(`${dateVersion}.`)) {
    const parts = currentVersion.split(".");
    return `${dateVersion}.${Number(parts.at(-1) || 0) + 1}`;
  }
  return `${dateVersion}.1`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function collectSupportedFiles(inputPath) {
  const source = resolve(inputPath);
  const info = await stat(source);
  if (info.isFile()) {
    assert(SUPPORTED_EXTENSIONS.has(extname(source).toLowerCase()), `Unsupported resource type: ${source}`);
    return [source];
  }
  assert(info.isDirectory(), `Input is neither a file nor a directory: ${source}`);

  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  await walk(source);
  assert(files.length > 0, `No supported resource files found under ${source}`);
  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function normalizeMetadataKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("zh-CN");
}

function metadataForName(metadata, name) {
  const direct = metadata.files[name];
  if (direct) return { name, value: direct };
  const normalized = normalizeMetadataKey(name);
  const match = Object.entries(metadata.files).find(([key]) => normalizeMetadataKey(key) === normalized);
  return match ? { name: match[0], value: match[1] } : null;
}

function metadataDiff(entry, existing) {
  const fields = ["type", "typeLabel", "title", "description", "format", "downloadLabel", "version", "previewKind"];
  const changed = fields.filter((field) => entry[field] !== undefined && entry[field] !== existing[field]);
  const existingSections = JSON.stringify(existing.previewSections || []);
  const nextSections = JSON.stringify(entry.previewSections || []);
  if (entry.previewSections !== undefined && existingSections !== nextSections) changed.push("previewSections");
  return changed;
}

function inferType(file) {
  const extension = extname(file).toLowerCase();
  if (extension === ".pptx" || extension === ".ppt") return "ppt";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return "poster";
  if ([".docx", ".doc", ".pdf"].includes(extension)) return "document";
  return "video";
}

function defaultAssetKey(file, id) {
  const extension = extname(file).toLowerCase();
  return `${id}${extension}`;
}

async function probeVideo(file) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-show_entries", "format=duration", "-of", "json", file],
    { encoding: "utf8" },
  );
  assert(result.status === 0, `ffprobe failed for ${basename(file)}: ${(result.stderr || "").trim()}`);
  const info = JSON.parse(result.stdout);
  const video = info.streams?.find((stream) => stream.codec_type === "video");
  assert(video?.codec_name, `No video stream found in ${basename(file)}`);
  return {
    codec: video.codec_name,
    duration: Number(info.format?.duration || 0),
  };
}

async function mirrorFile(source, destination) {
  if (resolve(source) === resolve(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  try {
    await createLink(source, destination);
  } catch {
    await copyFile(source, destination);
  }
}

async function mirrorDirectory(source, destination) {
  if (!(await stat(source).catch(() => null))?.isDirectory()) return;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) await mirrorDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) await mirrorFile(sourcePath, destinationPath);
  }
}

async function findNamedFile(root, name, { skip = [] } = {}) {
  if (!(await stat(root).catch(() => null))?.isDirectory()) return null;
  const normalized = normalizeMetadataKey(name);
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => right.name.localeCompare(left.name, "zh-CN"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (skip.some((skipped) => isWithin(path, skipped) || resolve(path) === resolve(skipped))) continue;
      if (entry.isFile() && normalizeMetadataKey(entry.name) === normalized) return path;
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return null;
}

async function downloadFile(url, destination, options) {
  await downloadUrlToFile(url, destination, {
    headers: { Accept: "application/octet-stream", "User-Agent": "nxn-resource-sync" },
    proxy: options.proxy,
    proxyEnv: booleanOption(options["proxy-env"], "--proxy-env", true),
    retries: positiveInteger(options.retries === undefined ? 3 : options.retries, "--retries", { min: 1, max: 10 }),
    connectTimeoutMs: positiveInteger(
      options["connect-timeout"] === undefined ? 20 : options["connect-timeout"],
      "--connect-timeout",
      { min: 1, max: 300 },
    ) * 1000,
    stallTimeoutMs: positiveInteger(
      options["stall-timeout"] === undefined ? 60 : options["stall-timeout"],
      "--stall-timeout",
      { min: 10, max: 3600 },
    ) * 1000,
  });
}

function previewFileFromUrl(root, value) {
  const url = new URL(value);
  if (url.hostname !== "3fu.github.io") return null;
  if (!url.pathname.startsWith(`/${REPO}/`)) throw new Error(`Preview URL must be under /${REPO}/`);
  const parts = decodeURIComponent(url.pathname.slice(REPO.length + 2)).split("/");
  assert(!parts.some((part) => !part || part === "." || part === ".."), "Preview URL path is unsafe");
  return join(root, "docs", ...parts);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function validateMetadata(metadata) {
  assert(metadata?.schemaVersion === 1 && metadata.files && typeof metadata.files === "object", "resource-metadata.json is invalid");
  if (!Array.isArray(metadata.order)) metadata.order = [];
  const ids = new Set();
  const assetKeys = new Set();
  for (const [name, entry] of Object.entries(metadata.files)) {
    safeString(name, "metadata filename");
    assert(/^[a-z0-9][a-z0-9-]*$/.test(entry.id || ""), `Metadata ${name} has an invalid id`);
    assert(!ids.has(entry.id), `Duplicate metadata id ${entry.id}`);
    ids.add(entry.id);
    assert(/^[a-z][a-z0-9-]{0,31}$/.test(entry.type || inferType(name)), `Metadata ${name} has an invalid type`);
    safeString(entry.title || basename(name, extname(name)), `Metadata ${name}.title`);
    safeString(entry.description, `Metadata ${name}.description`, 1000);
    const assetKey = safeAssetKey(entry.assetKey || defaultAssetKey(name, entry.id), `Metadata ${name}.assetKey`);
    assert(!assetKeys.has(assetKey), `Duplicate metadata assetKey ${assetKey}`);
    assetKeys.add(assetKey);
    if (entry.version) safeString(entry.version, `Metadata ${name}.version`, 64);
    if (entry.previewKind) assert(/^[a-z][a-z0-9-]{0,31}$/.test(entry.previewKind), `Metadata ${name}.previewKind is invalid`);
  }
}

async function loadContext(root) {
  const catalogFile = join(root, "docs", "catalog.json");
  const catalog = await readJson(catalogFile);
  assert(catalog?.schemaVersion === 1 && Array.isArray(catalog.resources) && catalog.resources.length > 0, "Current catalog is invalid");
  const metadata = await readJson(metadataFile);
  validateMetadata(metadata);
  return { catalog, catalogFile, metadata };
}

async function createPlan(inputPath, options) {
  const root = resolve(options.root || repositoryRoot);
  const { catalog, catalogFile, metadata } = await loadContext(root);
  const readmeFile = join(root, "doc", "README.md");
  const readme = await readFile(readmeFile, "utf8").catch(() => "");
  const retiredIds = new Set(retiredIdsOf(options.retire));
  const inputFiles = inputPath ? await collectSupportedFiles(inputPath) : [];
  assert(inputFiles.length > 0 || retiredIds.size > 0, "--input or --retire is required");
  const updates = [];
  const ids = new Set();
  const assetKeys = new Set();

  for (const source of inputFiles) {
    const name = basename(source);
    const match = metadataForName(metadata, name);
    assert(match, `Add metadata for "${name}" to ${metadataFile} before preparing the update.`);
    const entry = match.value;
    const id = safeString(entry.id, `Metadata ${name}.id`, 64);
    assert(!ids.has(id), `Input contains multiple files mapped to resource ${id}`);
    ids.add(id);
    const assetKey = safeAssetKey(entry.assetKey || defaultAssetKey(source, id), `Metadata ${name}.assetKey`);
    assert(!assetKeys.has(assetKey), `Input maps multiple resources to assetKey ${assetKey}`);
    assetKeys.add(assetKey);
    const fileInfo = await stat(source);
    const hash = await sha256(source);
    const existing = catalog.resources.find((resource) => resource.id === id) || null;
    const reasons = [];
    if (!existing) reasons.push("new");
    if (existing?.sha256 !== hash) reasons.push("content");
    if (existing && existing.assetKey !== assetKey) reasons.push("assetKey");
    if (existing && existing.downloadName !== name) reasons.push("downloadName");
    if (existing) reasons.push(...metadataDiff(entry, existing).map((field) => `metadata:${field}`));
    const changed = reasons.length > 0;
    const originalChanged = !existing || existing.sha256 !== hash || existing.assetKey !== assetKey;
    updates.push({
      source,
      name,
      metadataName: match.name,
      entry,
      id,
      assetKey,
      fileInfo,
      hash,
      existing,
      changed,
      originalChanged,
      reasons,
      distribution: "release",
      readmeMentioned: readme.includes(name),
    });
  }

  const catalogById = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  for (const id of retiredIds) {
    assert(catalogById.has(id), `Cannot retire unknown resource ${id}`);
    assert(!ids.has(id), `Resource ${id} cannot be updated and retired in the same plan`);
  }

  const version = nextCatalogVersion(catalog.catalogVersion, options.version);
  const order = [...metadata.order].filter((id) => !retiredIds.has(id));
  for (const resource of catalog.resources) if (!retiredIds.has(resource.id) && !order.includes(resource.id)) order.push(resource.id);
  for (const update of updates) if (!order.includes(update.id)) order.push(update.id);

  return {
    root,
    catalog,
    catalogFile,
    metadata,
    readmeFile,
    inputFiles,
    updates,
    version,
    order,
    added: updates.filter((update) => !update.existing),
    changed: updates.filter((update) => update.existing && update.changed),
    unchanged: updates.filter((update) => update.existing && !update.changed),
    retired: catalog.resources.filter((resource) => retiredIds.has(resource.id)),
    options,
  };
}

function printPlan(plan) {
  process.stdout.write(`Root: ${plan.root}\n`);
  process.stdout.write(`Input: ${plan.inputFiles.length} file(s)\n`);
  process.stdout.write(`Catalog: ${plan.catalog.catalogVersion} -> ${plan.version}\n`);
  for (const update of plan.added) process.stdout.write(`ADD ${update.id} <- ${update.name} [${update.distribution}]\n`);
  for (const update of plan.changed) process.stdout.write(`CHANGE ${update.id} <- ${update.name} [${update.reasons.join(",")}] [${update.distribution}]\n`);
  for (const update of plan.unchanged) process.stdout.write(`UNCHANGED ${update.id} <- ${update.name}\n`);
  for (const resource of plan.retired) process.stdout.write(`RETIRE ${resource.id} <- ${resource.downloadName}\n`);
  const readmeReviews = plan.updates.filter((update) => update.changed && (!update.readmeMentioned || update.originalChanged));
  for (const update of readmeReviews) process.stdout.write(`REVIEW doc/README.md for ${update.name}\n`);
  if (!plan.added.length && !plan.changed.length && !plan.retired.length) process.stdout.write("NOOP: no catalog changes detected.\n");
  const retiredIds = new Set(plan.retired.map((resource) => resource.id));
  const activeIds = new Set([...plan.catalog.resources.map((resource) => resource.id), ...plan.updates.map((update) => update.id)]);
  for (const id of retiredIds) activeIds.delete(id);
  process.stdout.write(`Active catalog resources after update: ${activeIds.size}\n`);
}

function exportPptPdf(source, destination) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(scriptDirectory, "export-ppt-pdf.ps1"), "-InputFile", source, "-OutputFile", destination],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;
  }

  const outputDirectory = dirname(destination);
  mkdirSync(outputDirectory, { recursive: true });
  const result = spawnSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outputDirectory, source], { encoding: "utf8" });
  assert(
    result.status === 0,
    `PPT preview export failed for ${basename(source)}. Install PowerPoint or LibreOffice. ${(result.stderr || "").trim()}`,
  );
  const generated = join(outputDirectory, `${basename(source, extname(source))}.pdf`);
  if (resolve(generated) !== resolve(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    try {
      renameSync(generated, destination);
    } catch {
      copyFileSync(generated, destination);
      rmSync(generated, { force: true });
    }
  }
}

function exportVideoCover(source, destination, duration) {
  mkdirSync(dirname(destination), { recursive: true });
  const seconds = Math.max(0, Math.min(10, Math.floor((duration || 2) / 10)));
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-ss", String(seconds), "-i", source, "-frames:v", "1", "-q:v", "2", destination],
    { encoding: "utf8" },
  );
  assert(result.status === 0, `Video cover generation failed for ${basename(source)}: ${(result.stderr || "").trim()}`);
}

async function inspectOrCreatePreview({ workspace, version, resourceSource, update, existing }) {
  const id = update?.id || existing.id;
  const type = update?.entry.type || existing?.type || inferType(resourceSource);
  const assetKey = update?.assetKey || existing.assetKey;
  const releaseBase = `https://github.com/${OWNER}/${REPO}/releases/download/resources-${version}`;
  const previewBase = `https://${OWNER.toLowerCase()}.github.io/${REPO}/previews/${id}/${version}`;
  const previewDirectory = join(workspace, "docs", "previews", id, version);
  let previewKind = update?.entry.previewKind || existing?.previewKind;
  const typeChanged = Boolean(existing && type !== existing.type);
  const previewKindChanged = Boolean(existing && update?.entry.previewKind && update.entry.previewKind !== existing.previewKind);
  const rebuildPreview = !existing || Boolean(update?.originalChanged) || typeChanged || previewKindChanged;
  const rebuildCover = !existing || Boolean(update?.originalChanged) || typeChanged;
  let duration = existing?.duration;
  let coverUrl = existing?.coverUrl;
  let previewUrl = existing?.url;
  let previewBytes = null;

  if (type === "video") {
    const probe = await probeVideo(resourceSource);
    duration = formatDuration(probe.duration) || existing?.duration;
    const requestedPreviewKind = update?.entry.previewKind;
    const browserPlayable = extname(resourceSource).toLowerCase() === ".mp4" && probe.codec === "h264";
    if (requestedPreviewKind) assert(["video", "download"].includes(requestedPreviewKind), `Video ${id} previewKind must be video or download`);
    if (requestedPreviewKind === "video") assert(browserPlayable, `Video ${id} is not an H.264 MP4 and cannot use previewKind=video`);
    if (requestedPreviewKind) previewKind = requestedPreviewKind;
    else if (rebuildPreview || !["video", "download"].includes(previewKind)) previewKind = browserPlayable ? "video" : "download";
    if (rebuildCover) {
      const cover = join(previewDirectory, `${id}.jpg`);
      exportVideoCover(resourceSource, cover, probe.duration);
      coverUrl = `${previewBase}/${id}.jpg`;
    }
  } else if (type === "ppt") {
    if (!previewKind || previewKind !== "pdf") previewKind = "pdf";
    if (rebuildPreview) {
      const preview = join(previewDirectory, `${id}.pdf`);
      exportPptPdf(resourceSource, preview);
      previewUrl = `${previewBase}/${id}.pdf`;
      previewBytes = (await stat(preview)).size;
    }
  } else if (type === "poster" || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(resourceSource).toLowerCase())) {
    if (!previewKind || previewKind !== "image") previewKind = "image";
    if (rebuildPreview) {
      const extension = extname(resourceSource).toLowerCase();
      const preview = join(previewDirectory, `${id}${extension}`);
      await mirrorFile(resourceSource, preview);
      previewUrl = `${previewBase}/${id}${extension}`;
      previewBytes = (await stat(preview)).size;
    }
  } else if (extname(resourceSource).toLowerCase() === ".pdf") {
    if (!previewKind || previewKind !== "pdf") previewKind = "pdf";
    if (rebuildPreview) {
      const preview = join(previewDirectory, `${id}.pdf`);
      await mirrorFile(resourceSource, preview);
      previewUrl = `${previewBase}/${id}.pdf`;
      previewBytes = (await stat(preview)).size;
    }
  } else {
    if (!previewKind || previewKind !== "download") previewKind = "download";
  }

  if (type !== "video") coverUrl = undefined;
  if (previewKind === "video" || previewKind === "download") {
    previewUrl = existing && !update?.originalChanged ? existing.url : `${releaseBase}/${assetKey}`;
  } else if (!previewUrl) {
    throw new Error(`Preview URL was not produced for ${id}`);
  } else {
    const preview = previewFileFromUrl(workspace, previewUrl);
    assert(preview, `Unsupported preview host for ${id}`);
    assert((await stat(preview).catch(() => null))?.isFile(), `Missing preview file for ${id}`);
    previewBytes = (await stat(preview)).size;
  }

  return {
    duration,
    coverUrl,
    previewKind,
    previewUrl,
    previewBytes,
    releaseBase,
  };
}

async function locateUnchangedSource({ workspace, resource, networkOptions }) {
  const inWork = await findNamedFile(workRoot, resource.assetKey, { skip: [workspace] });
  if (inWork && await sha256(inWork) === resource.sha256) return { source: inWork };

  const hydrated = join(workspace, "assets", resource.assetKey);
  await downloadFile(resource.downloadUrl, hydrated, networkOptions);
  assert(await sha256(hydrated) === resource.sha256, `Release SHA-256 mismatch for ${resource.id}`);
  return { source: hydrated, hydrated: true };
}

async function prepare(plan, options) {
  const workspace = resolve(options.workspace || join(workRoot, plan.version));
  assert(isWithin(workspace, workRoot), `Workspace must stay under ${workRoot}`);
  assert(resolve(workspace) !== resolve(workRoot), "Workspace cannot be the .work root");
  assert(plan.added.length > 0 || plan.changed.length > 0 || plan.retired.length > 0, "No catalog changes detected; nothing was prepared.");
  const missingReadme = plan.added.filter((update) => !update.readmeMentioned);
  assert(
    missingReadme.length === 0,
    `Add ${missingReadme.map((update) => `"${update.name}"`).join(", ")} to doc/README.md before preparing the update.`,
  );
  const updatedById = new Map(plan.updates.map((update) => [update.id, update]));
  const existingById = new Map(plan.catalog.resources.map((resource) => [resource.id, resource]));
  const retiredIds = new Set(plan.retired.map((resource) => resource.id));
  const orderIndex = new Map(plan.order.map((id, index) => [id, index]));
  const activeIds = [...new Set([...existingById.keys(), ...updatedById.keys()])].filter((id) => !retiredIds.has(id));
  activeIds.sort((left, right) => (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER));

  await rm(join(workspace, "assets"), { recursive: true, force: true });
  await rm(join(workspace, "docs"), { recursive: true, force: true });
  await mkdir(join(workspace, "assets"), { recursive: true });
  await mkdir(join(workspace, "docs", "previews"), { recursive: true });
  await mirrorDirectory(join(plan.root, "docs", "previews"), join(workspace, "docs", "previews"));

  const releaseBase = `https://github.com/${OWNER}/${REPO}/releases/download/resources-${plan.version}`;
  const now = new Date().toISOString();
  const resources = [];
  const manifestAssets = [];

  for (const id of activeIds) {
    const update = updatedById.get(id);
    const existing = existingById.get(id);
    let source;

    if (update) {
      source = update.source;
    } else {
      const located = await locateUnchangedSource({ workspace, resource: existing, networkOptions: plan.options });
      source = located.source;
    }

    const assetKey = update?.assetKey || existing.assetKey;
    const workspaceAsset = join(workspace, "assets", assetKey);
    await mirrorFile(source, workspaceAsset);

    const actualHash = await sha256(workspaceAsset);
    if (update) assert(actualHash === update.hash, `SHA-256 changed while staging ${update.name}`);
    else assert(actualHash === existing.sha256, `Current source hash differs for ${existing.id}; refresh ${existing.downloadName} before publishing`);

    const preview = await inspectOrCreatePreview({
      workspace,
      version: plan.version,
      resourceSource: source,
      update,
      existing,
    });
    const entry = update?.entry || metadataForName(plan.metadata, existing.downloadName)?.value || {};
    const type = entry.type || existing?.type || inferType(source);
    const typeLabel = entry.typeLabel || TYPE_LABELS[type] || type;
    const title = entry.title || existing?.title || basename(source, extname(source));
    const description = entry.description || existing?.description;
    assert(description, `Metadata description is required for ${id}`);
    const downloadLabel = entry.downloadLabel || existing?.downloadLabel || DEFAULT_LABELS[type] || "下载原文件";
    const format = entry.format || existing?.format || (type === "ppt" ? "PDF" : extname(source).slice(1).toUpperCase());
    const downloadName = update?.name || existing?.downloadName || basename(source);
    const sizeBytes = ["pdf", "image"].includes(preview.previewKind)
      ? preview.previewBytes ?? (await stat(source)).size
      : (await stat(workspaceAsset)).size;
    const downloadUrl = existing && (!update || !update.originalChanged)
      ? existing.downloadUrl
      : `${releaseBase}/${assetKey}`;

    const resource = {
      id,
      type,
      typeLabel,
      title,
      description,
      format,
      size: formatBytes(sizeBytes),
      url: preview.previewUrl,
      downloadUrl,
      downloadName,
      downloadLabel,
      previewKind: preview.previewKind,
      sha256: actualHash,
      assetKey,
      updatedAt: update?.changed || !existing ? now : existing.updatedAt,
    };
    if (entry.version || existing?.version) resource.version = entry.version || existing.version;
    if (preview.duration) resource.duration = preview.duration;
    if (preview.coverUrl) resource.coverUrl = preview.coverUrl;
    const previewSections = entry.previewSections || existing?.previewSections;
    if (previewSections) resource.previewSections = previewSections;
    resources.push(resource);

    manifestAssets.push({
      originalName: downloadName,
      assetKey,
      id,
      type,
      bytes: (await stat(workspaceAsset)).size,
      sha256: actualHash,
      distribution: "release",
      downloadUrl: resource.downloadUrl,
      previewUrl: resource.url,
    });
  }

  const bundleAssetKey = `NXN-workstation-resources-${plan.version}.zip`;
  const catalog = {
    schemaVersion: 1,
    catalogVersion: plan.version,
    updatedAt: now,
    sources: plan.catalog.sources,
    bundle: {
      assetKey: bundleAssetKey,
      title: plan.catalog.bundle?.title || "NXN 工作站完整资料包",
      size: "Pending release build",
      url: `${releaseBase}/${bundleAssetKey}`,
    },
    resources,
  };
  const serializedCatalog = `${JSON.stringify(catalog, null, 2)}\n`;
  const workspaceCatalog = join(workspace, "docs", "catalog.json");
  const workspaceArchive = join(workspace, "docs", "catalogs", `${plan.version}.json`);
  await mkdir(dirname(workspaceArchive), { recursive: true });
  await writeFile(workspaceCatalog, serializedCatalog, "utf8");
  await writeFile(workspaceArchive, serializedCatalog, "utf8");

  const manifest = {
    schemaVersion: 1,
    catalogVersion: plan.version,
    generatedAt: now,
    sourceDirectory: "release",
    assets: manifestAssets,
  };
  const workspaceManifest = join(workspace, "doc", "manifest.json");
  await mkdir(dirname(workspaceManifest), { recursive: true });
  await writeFile(workspaceManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  plan.metadata.order = plan.order;
  plan.metadata.note = "按原始文件名登记：新增或替换素材前由 Agent 补充/复用 id、标题和说明，再运行 resource-sync.mjs。";
  await writeFile(metadataFile, `${JSON.stringify(plan.metadata, null, 2)}\n`, "utf8");

  process.stdout.write(`Prepared ${resources.length} active resources for ${plan.version} at ${workspace}.\n`);
  process.stdout.write("The repository catalog and doc manifest are unchanged until publish succeeds.\n");
  process.stdout.write(`Next: validate --workspace "${workspace}", review, then publish --workspace "${workspace}" --root "${plan.root}".\n`);
  return { workspace, catalog };
}

const { command, options } = argsOf(process.argv.slice(2));
try {
  if (command === "plan") {
    printPlan(await createPlan(options.input, options));
  } else if (command === "prepare") {
    const plan = await createPlan(options.input, options);
    printPlan(plan);
    await prepare(plan, options);
  } else {
    usage(command ? `Unknown command ${command}` : undefined);
  }
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 1;
}
