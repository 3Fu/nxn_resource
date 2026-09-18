import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PROXY_ENV_NAMES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"];
const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"];
const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

function sleep(milliseconds) {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function envValue(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeProxy(value) {
  const raw = value.trim();
  assert(raw, "Proxy URL is empty");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  assert(PROXY_PROTOCOLS.has(url.protocol), `Unsupported proxy protocol: ${url.protocol}`);
  return url.href;
}

function noProxyMatches(urlValue, value) {
  if (!value) return false;
  const url = new URL(urlValue);
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawPattern of value.split(",")) {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "*") return true;

    let patternHost = pattern;
    let patternPort = null;
    if (pattern.startsWith("[")) {
      const closing = pattern.indexOf("]");
      assert(closing !== -1, `Invalid NO_PROXY entry: ${rawPattern}`);
      patternHost = pattern.slice(1, closing);
      const remainder = pattern.slice(closing + 1);
      if (remainder.startsWith(":")) patternPort = remainder.slice(1);
    } else {
      const separator = pattern.lastIndexOf(":");
      if (separator > -1 && /^\d+$/.test(pattern.slice(separator + 1))) {
        patternHost = pattern.slice(0, separator);
        patternPort = pattern.slice(separator + 1);
      }
    }
    if (patternPort && patternPort !== port) continue;
    patternHost = patternHost.replace(/^\./, "");
    if (hostname === patternHost || hostname.endsWith(`.${patternHost}`)) return true;
  }
  return false;
}

export function resolveProxyForUrl(urlValue, options = {}) {
  const url = new URL(urlValue);
  if (options.proxy) return normalizeProxy(options.proxy);
  if (options.proxyEnv === false) return null;
  const proxy = envValue(PROXY_ENV_NAMES);
  if (!proxy) return null;
  if (noProxyMatches(url, envValue(NO_PROXY_ENV_NAMES))) return null;
  return normalizeProxy(proxy);
}

export function describeProxy(proxy) {
  if (!proxy) return null;
  const url = new URL(proxy);
  url.username = "";
  url.password = "";
  return url.href;
}

function curlExecutable() {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

function runProcess(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [ "ignore", capture ? "pipe" : "ignore", "pipe" ],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`Proxy is configured, but ${command} is not available. Install curl or clear HTTPS_PROXY/ALL_PROXY.`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

async function downloadWithFetch(url, destination, { headers, stallTimeoutMs }) {
  const controller = new AbortController();
  let stallTimer = null;
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error(`No data received for ${Math.round(stallTimeoutMs / 1000)} seconds`)), stallTimeoutMs);
  };
  resetStallTimer();
  try {
  const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    assert(response.ok && response.body, `HTTP ${response.status}`);
    assert(new URL(response.url).protocol === "https:", "HTTPS request redirected to a non-HTTPS URL");
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        resetStallTimer();
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(destination, { flags: "wx", highWaterMark: 1 << 22 }),
    );
  } finally {
    clearTimeout(stallTimer);
  }
}

async function downloadWithCurl(url, destination, { headers, proxy, connectTimeoutMs, stallTimeoutMs }) {
  const args = [
    "--fail",
    "--location",
    "--proto", "=https",
    "--proto-redir", "=https",
    "--silent",
    "--show-error",
    "--connect-timeout", String(Math.max(1, Math.ceil(connectTimeoutMs / 1000))),
    "--speed-limit", "1024",
    "--speed-time", String(Math.max(5, Math.ceil(stallTimeoutMs / 1000))),
    "--proxy", proxy,
    "--output", destination,
  ];
  for (const [name, value] of Object.entries(headers || {})) {
    args.push("--header", `${name}: ${value}`);
  }
  args.push(url);
  const result = await runProcess(curlExecutable(), args);
  if (result.code !== 0) {
    const detail = result.stderr ? `: ${result.stderr}` : "";
    throw new Error(`curl download failed with exit code ${result.code}${detail}`);
  }
}

async function readWithCurl(url, { headers, proxy, connectTimeoutMs, stallTimeoutMs }) {
  const args = [
    "--fail",
    "--location",
    "--proto", "=https",
    "--proto-redir", "=https",
    "--silent",
    "--show-error",
    "--connect-timeout", String(Math.max(1, Math.ceil(connectTimeoutMs / 1000))),
    "--speed-limit", "1024",
    "--speed-time", String(Math.max(5, Math.ceil(stallTimeoutMs / 1000))),
    "--proxy", proxy,
  ];
  for (const [name, value] of Object.entries(headers || {})) {
    args.push("--header", `${name}: ${value}`);
  }
  args.push(url);
  const result = await runProcess(curlExecutable(), args, { capture: true });
  if (result.code !== 0) {
    const detail = result.stderr ? `: ${result.stderr}` : "";
    throw new Error(`curl request failed with exit code ${result.code}${detail}`);
  }
  return result.stdout.toString("utf8");
}

export async function downloadUrlToFile(urlValue, destination, options = {}) {
  const url = new URL(urlValue);
  const proxy = resolveProxyForUrl(url, options);
  const retries = options.retries ?? 3;
  const connectTimeoutMs = options.connectTimeoutMs ?? 20000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 60000;
  const headers = options.headers || {};
  let lastError = null;

  await mkdir(dirname(destination), { recursive: true });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    await rm(destination, { force: true });
    try {
      if (proxy) {
        await downloadWithCurl(url, destination, { headers, proxy, connectTimeoutMs, stallTimeoutMs });
      } else {
        await downloadWithFetch(url, destination, { headers, stallTimeoutMs });
      }
      return { attempts: attempt, proxyUsed: Boolean(proxy) };
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${url} failed after ${retries} attempt(s): ${detail}`);
}

export async function readRemoteText(urlValue, options = {}) {
  const url = new URL(urlValue);
  const proxy = resolveProxyForUrl(url, options);
  const retries = options.retries ?? 3;
  const connectTimeoutMs = options.connectTimeoutMs ?? 20000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 60000;
  const headers = options.headers || {};
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      if (proxy) return await readWithCurl(url, { headers, proxy, connectTimeoutMs, stallTimeoutMs });
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(Math.max(connectTimeoutMs, stallTimeoutMs)),
      });
      assert(response.ok, `HTTP ${response.status}`);
      assert(new URL(response.url).protocol === "https:", "HTTPS request redirected to a non-HTTPS URL");
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${url} failed after ${retries} attempt(s): ${detail}`);
}
