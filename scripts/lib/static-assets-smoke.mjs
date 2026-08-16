import { createHash } from "node:crypto";
import { readFile as defaultReadFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const STATIC_ASSET_REQUEST_TIMEOUT_MS = 15_000;
export const STATIC_ASSET_SMOKE_TIMEOUT_MS = 90_000;
export const STATIC_INDEX_MAX_BYTES = 1024 * 1024;
export const STATIC_BUILD_MANIFEST_MAX_BYTES = 64 * 1024;
export const STATIC_ASSET_MAX_BYTES = 32 * 1024 * 1024;
export const STATIC_ASSET_MAX_COUNT = 64;
export const STATIC_ASSET_MAX_ORIGINS = 2;

const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PRODUCTION_ASSET_PATH_PATTERN = /^\/assets\/[A-Za-z0-9._/-]+$/;
const STATIC_REFERENCE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
const MAX_RETURNED_IDENTIFIER_LENGTH = 512;
const JAVASCRIPT_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/x-javascript",
  "text/javascript"
]);
const CSS_REFERENCE_KINDS = Object.freeze({
  ".css": "css",
  ".gif": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".svg": "image",
  ".webp": "image",
  ".woff": "font",
  ".woff2": "font"
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function bytesFrom(value, label) {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} did not produce bytes`);
}

function boundedUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function normalizedContentType(headers) {
  return headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

function assertExpectedContentType(actual, expected, label) {
  const accepted = expected instanceof Set ? expected : new Set([expected]);
  if (!accepted.has(actual)) {
    throw new Error(`${label} returned content type ${actual || "<missing>"}`);
  }
}

function canonicalOrigin(configuredUrl) {
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("static asset smoke origin must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "static asset smoke origin must be a bare HTTPS origin without credentials, path, query, or fragment"
    );
  }
  if (url.origin.length > MAX_RETURNED_IDENTIFIER_LENGTH) {
    throw new Error("static asset smoke origin is too long");
  }
  return url.origin;
}

function assertExpectedIdentity(sourceRevision, clientBuildDigest) {
  if (!SOURCE_REVISION_PATTERN.test(sourceRevision ?? "")) {
    throw new Error("expected sourceRevision must be an exact lowercase 40-character SHA");
  }
  if (!SHA256_PATTERN.test(clientBuildDigest ?? "")) {
    throw new Error("expected clientBuildDigest must be an exact lowercase SHA-256");
  }
}

function parseAttributes(tag, label) {
  const attributes = new Map();
  const body = tag
    .replace(/^<\s*[A-Za-z][A-Za-z0-9:-]*/, "")
    .replace(/\/?\s*>$/, "");
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const name = match[1].toLowerCase();
    if (attributes.has(name)) {
      throw new Error(`${label} contains duplicate ${name} attributes`);
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function productionAssetPath(rawValue, origin, label, expectedExtension) {
  if (
    !rawValue ||
    rawValue.length > MAX_RETURNED_IDENTIFIER_LENGTH ||
    /[\\\x00-\x1f\x7f]/.test(rawValue)
  ) {
    throw new Error(`${label} has an invalid asset URL`);
  }
  if (rawValue.includes("%")) {
    throw new Error(`${label} asset URL must not contain encoded path segments`);
  }
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawValue)) {
    throw new Error(`${label} asset URL contains path traversal`);
  }
  let url;
  try {
    url = new URL(rawValue, `${origin}/`);
  } catch {
    throw new Error(`${label} has an invalid asset URL`);
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} asset URL must be same-origin without credentials, query, or fragment`);
  }
  if (!PRODUCTION_ASSET_PATH_PATTERN.test(url.pathname)) {
    throw new Error(`${label} must reference a production asset under /assets/`);
  }
  const segments = url.pathname.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} asset URL contains path traversal`);
  }
  if (segments.some((segment) => segment === "")) {
    throw new Error(`${label} asset URL contains an empty path segment`);
  }
  if (!url.pathname.toLowerCase().endsWith(expectedExtension)) {
    throw new Error(`${label} must reference a ${expectedExtension} asset`);
  }
  return url.pathname;
}

function staticReferencePath(rawValue, origin, label, extensions) {
  if (
    !rawValue ||
    rawValue.length > MAX_RETURNED_IDENTIFIER_LENGTH ||
    /[\\\x00-\x1f\x7f%]/.test(rawValue) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawValue)
  ) {
    throw new Error(`${label} has an invalid static URL`);
  }
  let url;
  try {
    url = new URL(rawValue, `${origin}/`);
  } catch {
    throw new Error(`${label} has an invalid static URL`);
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !STATIC_REFERENCE_PATH_PATTERN.test(url.pathname) ||
    url.pathname.split("/").some((segment) => segment === "." || segment === "..") ||
    !extensions.some((extension) => url.pathname.toLowerCase().endsWith(extension))
  ) {
    throw new Error(`${label} must reference a bounded same-origin static file`);
  }
  return url.pathname;
}

export function extractProductionAssetPaths(indexHtml, configuredUrl) {
  const origin = canonicalOrigin(configuredUrl);
  const assets = [];
  const seen = new Set();
  const add = (path, kind) => {
    if (seen.has(path)) {
      throw new Error(`local index contains duplicate production asset ${path}`);
    }
    seen.add(path);
    assets.push({ path, kind });
  };

  for (const match of indexHtml.matchAll(/<script\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0], "script tag");
    if (!attributes.has("src")) continue;
    add(
      productionAssetPath(attributes.get("src"), origin, "script src", ".js"),
      "javascript"
    );
  }
  for (const match of indexHtml.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0], "link tag");
    const relations = (attributes.get("rel") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (relations.includes("stylesheet")) {
      if (!attributes.has("href")) throw new Error("stylesheet link is missing href");
      add(
        productionAssetPath(attributes.get("href"), origin, "stylesheet href", ".css"),
        "css"
      );
      continue;
    }
    if (relations.includes("icon") || relations.includes("apple-touch-icon")) {
      if (!attributes.has("href")) throw new Error("icon link is missing href");
      add(
        staticReferencePath(attributes.get("href"), origin, "icon href", [
          ".svg",
          ".png",
          ".ico"
        ]),
        "image"
      );
      continue;
    }
    if (relations.includes("modulepreload")) {
      if (!attributes.has("href")) throw new Error("modulepreload link is missing href");
      add(
        productionAssetPath(attributes.get("href"), origin, "modulepreload href", ".js"),
        "javascript"
      );
      continue;
    }
    if (relations.includes("manifest")) {
      if (!attributes.has("href")) throw new Error("manifest link is missing href");
      add(
        staticReferencePath(attributes.get("href"), origin, "manifest href", [
          ".webmanifest",
          ".json"
        ]),
        "manifest"
      );
    }
  }

  if (!assets.some(({ kind }) => kind === "javascript")) {
    throw new Error("local index contains no production JavaScript asset");
  }
  if (!assets.some(({ kind }) => kind === "css")) {
    throw new Error("local index contains no production CSS asset");
  }
  if (assets.length > STATIC_ASSET_MAX_COUNT) {
    throw new Error(`local index exceeds the ${STATIC_ASSET_MAX_COUNT}-asset smoke limit`);
  }
  return assets.sort(({ path: left }, { path: right }) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function extractCssReferencePaths(
  cssText,
  stylesheetPath,
  configuredUrl
) {
  const origin = canonicalOrigin(configuredUrl);
  if (
    typeof cssText !== "string" ||
    cssText.length > STATIC_ASSET_MAX_BYTES ||
    !PRODUCTION_ASSET_PATH_PATTERN.test(stylesheetPath ?? "") ||
    !stylesheetPath.toLowerCase().endsWith(".css")
  ) {
    throw new Error("CSS reference extraction requires one bounded production stylesheet");
  }
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  if (withoutComments.includes("/*") || withoutComments.includes("*/")) {
    throw new Error("production CSS contains an unterminated comment");
  }
  const references = new Map();
  for (const match of withoutComments.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'"\s][^)]*?))\s*\)/gi
  )) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw.startsWith("data:") || raw.startsWith("#")) continue;
    if (
      !raw ||
      raw.length > MAX_RETURNED_IDENTIFIER_LENGTH ||
      /[\\\x00-\x1f\x7f%]/.test(raw) ||
      /(?:^|\/)\.\.(?:\/|$)/.test(raw)
    ) {
      throw new Error("production CSS contains an invalid asset URL");
    }
    let url;
    try {
      url = new URL(raw, `${origin}${stylesheetPath}`);
    } catch {
      throw new Error("production CSS contains an invalid asset URL");
    }
    const extension = Object.keys(CSS_REFERENCE_KINDS).find((candidate) =>
      url.pathname.toLowerCase().endsWith(candidate)
    );
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !PRODUCTION_ASSET_PATH_PATTERN.test(url.pathname) ||
      !extension
    ) {
      throw new Error("production CSS must reference a bounded same-origin asset");
    }
    const kind = CSS_REFERENCE_KINDS[extension];
    const previous = references.get(url.pathname);
    if (previous && previous !== kind) {
      throw new Error("production CSS reference kind is ambiguous");
    }
    references.set(url.pathname, kind);
  }
  return [...references]
    .map(([path, kind]) => ({ path, kind }))
    .sort(({ path: left }, { path: right }) => left.localeCompare(right));
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
]);

function isIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_$\u0080-\uFFFF]/u.test(character);
}

function isIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(character);
}

function javascriptTokens(source, label) {
  const tokens = [];

  const scanCode = (start, stopAtTemplateBrace, output) => {
    let index = start;
    let braceDepth = 0;
    let canStartRegex = true;

    const push = (token) => {
      output.push(token);
      if (token.type === "identifier") {
        canStartRegex = REGEX_PREFIX_KEYWORDS.has(token.value);
      } else if (
        token.type === "string" ||
        token.type === "template" ||
        token.type === "number" ||
        token.type === "regex"
      ) {
        canStartRegex = false;
      } else {
        canStartRegex = ![")", "]", "}", ".", "?.", "++", "--"].includes(
          token.value
        );
      }
    };

    while (index < source.length) {
      const character = source[index];
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (index === 0 && source.startsWith("#!", index)) {
        const newline = source.indexOf("\n", index + 2);
        index = newline === -1 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith("//", index)) {
        const newline = source.indexOf("\n", index + 2);
        index = newline === -1 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2);
        if (end === -1) throw new Error(`${label} contains an unterminated comment`);
        index = end + 2;
        continue;
      }
      if (character === "'" || character === '"') {
        const quote = character;
        const contentStart = index + 1;
        let escaped = false;
        index += 1;
        while (index < source.length && source[index] !== quote) {
          if (source[index] === "\\") {
            escaped = true;
            index += 2;
            continue;
          }
          if (source[index] === "\n" || source[index] === "\r") {
            throw new Error(`${label} contains an unterminated string literal`);
          }
          index += 1;
        }
        if (index >= source.length) {
          throw new Error(`${label} contains an unterminated string literal`);
        }
        push({
          type: "string",
          value: escaped ? null : source.slice(contentStart, index),
          escaped
        });
        index += 1;
        continue;
      }
      if (character === "`") {
        const nested = [];
        const contentStart = index + 1;
        let escaped = false;
        let substituted = false;
        index += 1;
        while (index < source.length && source[index] !== "`") {
          if (source[index] === "\\") {
            escaped = true;
            index += 2;
            continue;
          }
          if (source.startsWith("${", index)) {
            substituted = true;
            index = scanCode(index + 2, true, nested);
            continue;
          }
          index += 1;
        }
        if (index >= source.length) {
          throw new Error(`${label} contains an unterminated template literal`);
        }
        push({
          type: "template",
          value: escaped || substituted ? null : source.slice(contentStart, index),
          escaped,
          substituted
        });
        output.push(...nested);
        index += 1;
        continue;
      }
      if (character === "}" && stopAtTemplateBrace && braceDepth === 0) {
        return index + 1;
      }
      if (character === "{") {
        braceDepth += 1;
        push({ type: "punctuator", value: character });
        index += 1;
        continue;
      }
      if (character === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
        push({ type: "punctuator", value: character });
        index += 1;
        continue;
      }
      if (isIdentifierStart(character)) {
        const tokenStart = index;
        index += 1;
        while (isIdentifierPart(source[index])) index += 1;
        push({ type: "identifier", value: source.slice(tokenStart, index) });
        continue;
      }
      if (/[0-9]/u.test(character)) {
        const tokenStart = index;
        index += 1;
        while (/[A-Za-z0-9_.$]/u.test(source[index] ?? "")) index += 1;
        push({ type: "number", value: source.slice(tokenStart, index) });
        continue;
      }
      if (character === "/" && canStartRegex && source[index + 1] !== "=") {
        index += 1;
        let inCharacterClass = false;
        let terminated = false;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index] === "\n" || source[index] === "\r") break;
          if (source[index] === "[") inCharacterClass = true;
          if (source[index] === "]") inCharacterClass = false;
          if (source[index] === "/" && !inCharacterClass) {
            terminated = true;
            index += 1;
            while (isIdentifierPart(source[index])) index += 1;
            break;
          }
          index += 1;
        }
        if (!terminated) throw new Error(`${label} contains an unterminated regular expression`);
        push({ type: "regex", value: null });
        continue;
      }

      const punctuator = [
        ">>>=", "**=", "&&=", "||=", "??=", "===", "!==", ">>>", "<<=", ">>=",
        "=>", "==", "!=", "<=", ">=", "++", "--", "&&", "||", "??", "?.", "**",
        "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "..."
      ].find((candidate) => source.startsWith(candidate, index)) ?? character;
      push({ type: "punctuator", value: punctuator });
      index += punctuator.length;
    }

    if (stopAtTemplateBrace) {
      throw new Error(`${label} contains an unterminated template expression`);
    }
    return index;
  };

  scanCode(0, false, tokens);
  return tokens;
}

function javascriptImportPath(rawValue, importerPath, origin) {
  if (
    !rawValue ||
    rawValue.length > MAX_RETURNED_IDENTIFIER_LENGTH ||
    /[\\\x00-\x1f\x7f%]/.test(rawValue) ||
    /(?:^|\/)\.\.(?:\/|$)/.test(rawValue) ||
    !(
      rawValue.startsWith("./") ||
      rawValue.startsWith("/") ||
      rawValue.startsWith(`${origin}/`)
    )
  ) {
    throw new Error("production JavaScript contains an invalid module specifier");
  }
  let url;
  try {
    url = new URL(rawValue, `${origin}${importerPath}`);
  } catch {
    throw new Error("production JavaScript contains an invalid module specifier");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !PRODUCTION_ASSET_PATH_PATTERN.test(url.pathname) ||
    !url.pathname.toLowerCase().endsWith(".js") ||
    url.pathname
      .slice(1)
      .split("/")
      .some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new Error(
      "production JavaScript imports must reference bounded same-origin .js files under /assets/"
    );
  }
  return url.pathname;
}

function exactJavascriptSpecifier(token, label) {
  if (!token || (token.type !== "string" && token.type !== "template")) {
    throw new Error(`${label} must use one literal module specifier`);
  }
  if (token.value === null || token.escaped || token.substituted) {
    throw new Error(`${label} contains an escaped or substituted module specifier`);
  }
  return token.value;
}

function findStaticModuleSpecifier(tokens, start, label) {
  let braceDepth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punctuator" && token.value === "{") {
      braceDepth += 1;
      continue;
    }
    if (token.type === "punctuator" && token.value === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) break;
      continue;
    }
    if (braceDepth === 0 && token.type === "punctuator" && token.value === ";") {
      break;
    }
    if (braceDepth === 0 && token.type === "identifier" && token.value === "from") {
      return exactJavascriptSpecifier(tokens[index + 1], label);
    }
  }
  throw new Error(`${label} has an ambiguous or missing module specifier`);
}

export function extractJavascriptImportPaths(
  javascriptText,
  javascriptPath,
  configuredUrl
) {
  const origin = canonicalOrigin(configuredUrl);
  if (
    typeof javascriptText !== "string" ||
    javascriptText.length > STATIC_ASSET_MAX_BYTES ||
    !PRODUCTION_ASSET_PATH_PATTERN.test(javascriptPath ?? "") ||
    !javascriptPath.toLowerCase().endsWith(".js")
  ) {
    throw new Error("JavaScript import extraction requires one bounded production module");
  }
  const tokens = javascriptTokens(javascriptText, `local JavaScript asset ${javascriptPath}`);
  const imports = new Set();
  const add = (rawValue) => {
    imports.add(javascriptImportPath(rawValue, javascriptPath, origin));
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier" || token.value !== "import") {
      if (token.type !== "identifier" || token.value !== "export") continue;
      const next = tokens[index + 1];
      if (next?.type === "punctuator" && next.value === "*") {
        add(findStaticModuleSpecifier(tokens, index + 2, "JavaScript re-export"));
      } else if (next?.type === "punctuator" && next.value === "{") {
        let depth = 0;
        let cursor = index + 1;
        for (; cursor < tokens.length; cursor += 1) {
          if (tokens[cursor].type !== "punctuator") continue;
          if (tokens[cursor].value === "{") depth += 1;
          if (tokens[cursor].value === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const from = tokens[cursor + 1];
        if (from?.type === "identifier" && from.value === "from") {
          add(exactJavascriptSpecifier(tokens[cursor + 2], "JavaScript re-export"));
        }
      }
      continue;
    }

    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (previous?.type === "punctuator" && [".", "?."].includes(previous.value)) {
      continue;
    }
    if (next?.type === "punctuator" && next.value === ".") {
      if (tokens[index + 2]?.type !== "identifier" || tokens[index + 2].value !== "meta") {
        throw new Error("production JavaScript contains an unsupported import meta-property");
      }
      continue;
    }
    if (next?.type === "punctuator" && next.value === "(") {
      const rawValue = exactJavascriptSpecifier(
        tokens[index + 2],
        "dynamic JavaScript import"
      );
      if (tokens[index + 3]?.type !== "punctuator" || tokens[index + 3].value !== ")") {
        throw new Error("dynamic JavaScript import must contain exactly one literal argument");
      }
      add(rawValue);
      continue;
    }
    if (next?.type === "string") {
      add(exactJavascriptSpecifier(next, "static JavaScript import"));
      continue;
    }
    add(findStaticModuleSpecifier(tokens, index + 1, "static JavaScript import"));
  }

  return [...imports]
    .map((path) => ({ path, kind: "javascript" }))
    .sort(({ path: left }, { path: right }) => left.localeCompare(right));
}

function localAssetFile(clientDirectory, pathname) {
  const path = resolve(clientDirectory, `.${pathname}`);
  const relation = relative(clientDirectory, path);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error("production asset path escapes the local client directory");
  }
  return path;
}

function cacheBustedUrl(origin, pathname, clientBuildDigest) {
  const url = new URL(pathname, `${origin}/`);
  url.searchParams.set("surf-build", clientBuildDigest);
  return url;
}

function cancelResponseBody(response) {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Response cleanup must not replace the bounded smoke result.
  }
}

async function fetchBody({
  fetcher,
  url,
  expectedContentType,
  label,
  maximumBytes,
  deadlineMs,
  requestTimeoutMs,
  overallTimeoutMs,
  now,
  schedule,
  cancel
}) {
  const remainingMs = deadlineMs - now();
  if (remainingMs <= 0) {
    throw timeoutError("static asset smoke", overallTimeoutMs);
  }
  const boundedTimeoutMs = Math.min(requestTimeoutMs, remainingMs);
  const controller = new AbortController();
  const failure = timeoutError(label, boundedTimeoutMs);
  let timer;
  let response;
  const timeout = new Promise((_, reject) => {
    timer = schedule(() => {
      controller.abort(failure);
      cancelResponseBody(response);
      reject(failure);
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        response = await fetcher(url, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: expectedContentType instanceof Set
              ? [...expectedContentType].join(", ")
              : expectedContentType,
            "Cache-Control": "no-cache, no-store, max-age=0"
          }
        });
        if (response.url) {
          const responseUrl = new URL(response.url);
          if (responseUrl.origin !== url.origin || responseUrl.pathname !== url.pathname) {
            cancelResponseBody(response);
            throw new Error(`${label} resolved to an unexpected origin or path`);
          }
        }
        if (!response.ok) {
          cancelResponseBody(response);
          throw new Error(`${label} returned HTTP ${response.status}`);
        }
        const contentType = normalizedContentType(response.headers);
        assertExpectedContentType(contentType, expectedContentType, label);
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null) {
          const declaredBytes = Number(contentLength);
          if (!Number.isInteger(declaredBytes) || declaredBytes < 0) {
            cancelResponseBody(response);
            throw new Error(`${label} returned an invalid Content-Length`);
          }
          if (declaredBytes > maximumBytes) {
            cancelResponseBody(response);
            throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
          }
        }
        if (!response.body || typeof response.body.getReader !== "function") {
          throw new Error(`${label} returned no readable body`);
        }
        const reader = response.body.getReader();
        const chunks = [];
        let byteLength = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) {
              throw new Error(`${label} returned non-byte body data`);
            }
            byteLength += value.byteLength;
            if (byteLength > maximumBytes) {
              await reader.cancel().catch(() => {});
              throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks, byteLength);
        return { bytes, contentType };
      })(),
      timeout
    ]);
  } finally {
    if (timer !== undefined) cancel(timer);
  }
}

function exactBuildManifest(bytes, sourceRevision, clientBuildDigest) {
  let value;
  try {
    value = JSON.parse(boundedUtf8(bytes, "remote build manifest"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("remote build manifest is not valid JSON");
    }
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("remote build manifest must be an object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "clientBuildDigest" ||
    keys[1] !== "sourceRevision"
  ) {
    throw new Error("remote build manifest must contain exactly sourceRevision and clientBuildDigest");
  }
  if (value.sourceRevision !== sourceRevision) {
    throw new Error("remote build manifest sourceRevision is stale or unexpected");
  }
  if (value.clientBuildDigest !== clientBuildDigest) {
    throw new Error("remote build manifest clientBuildDigest is stale or unexpected");
  }
}

function assertOptions(options) {
  if (
    typeof options.fetcher !== "function" ||
    typeof options.readFile !== "function" ||
    typeof options.now !== "function" ||
    typeof options.schedule !== "function" ||
    typeof options.cancel !== "function" ||
    !Number.isSafeInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs <= 0 ||
    options.requestTimeoutMs > STATIC_ASSET_REQUEST_TIMEOUT_MS ||
    !Number.isSafeInteger(options.overallTimeoutMs) ||
    options.overallTimeoutMs <= 0 ||
    options.overallTimeoutMs > STATIC_ASSET_SMOKE_TIMEOUT_MS
  ) {
    throw new Error("static asset smoke requires injected I/O and timeouts within hard limits");
  }
}

export async function smokeStaticAssets(
  configuredUrl,
  {
    clientDirectory,
    sourceRevision,
    clientBuildDigest,
    fetcher = globalThis.fetch,
    readFile = defaultReadFile,
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
    requestTimeoutMs = STATIC_ASSET_REQUEST_TIMEOUT_MS,
    overallTimeoutMs = STATIC_ASSET_SMOKE_TIMEOUT_MS
  } = {}
) {
  const origin = canonicalOrigin(configuredUrl);
  assertExpectedIdentity(sourceRevision, clientBuildDigest);
  if (!isAbsolute(clientDirectory ?? "")) {
    throw new Error("clientDirectory must be an absolute path");
  }
  const dependencies = {
    fetcher,
    readFile,
    now,
    schedule,
    cancel,
    requestTimeoutMs,
    overallTimeoutMs
  };
  assertOptions(dependencies);
  const startedAtMs = now();
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("static asset smoke clock must return a finite timestamp");
  }
  const deadlineMs = startedAtMs + overallTimeoutMs;
  const overallFailure = timeoutError("static asset smoke", overallTimeoutMs);
  let overallExpired = false;
  let overallTimer;
  const overallTimeout = new Promise((_, reject) => {
    overallTimer = schedule(() => {
      overallExpired = true;
      reject(overallFailure);
    }, overallTimeoutMs);
  });
  const assertWithinOverallDeadline = () => {
    const currentTimeMs = now();
    if (
      overallExpired ||
      !Number.isFinite(currentTimeMs) ||
      currentTimeMs >= deadlineMs
    ) {
      throw overallFailure;
    }
  };

  const operation = (async () => {
    assertWithinOverallDeadline();

    const localIndex = bytesFrom(
      await readFile(resolve(clientDirectory, "index.html")),
      "local client index"
    );
    assertWithinOverallDeadline();
    if (localIndex.byteLength > STATIC_INDEX_MAX_BYTES) {
      throw new Error(`local client index exceeds the ${STATIC_INDEX_MAX_BYTES}-byte limit`);
    }
    const indexHtml = boundedUtf8(localIndex, "local client index");
    const assets = extractProductionAssetPaths(indexHtml, origin);
    const queuedAssets = new Map(assets.map((asset) => [asset.path, asset]));
    const localAssets = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      assertWithinOverallDeadline();
      const bytes = bytesFrom(
        await readFile(localAssetFile(clientDirectory, asset.path)),
        `local asset ${asset.path}`
      );
      assertWithinOverallDeadline();
      if (bytes.byteLength > STATIC_ASSET_MAX_BYTES) {
        throw new Error(`local asset ${asset.path} exceeds the ${STATIC_ASSET_MAX_BYTES}-byte limit`);
      }
      localAssets.push({ ...asset, sha256: sha256(bytes) });
      if (asset.kind === "css") {
        const css = boundedUtf8(bytes, `local CSS asset ${asset.path}`);
        for (const reference of extractCssReferencePaths(css, asset.path, origin)) {
          const existing = queuedAssets.get(reference.path);
          if (existing && existing.kind !== reference.kind) {
            throw new Error(`production asset ${reference.path} has conflicting kinds`);
          }
          if (!existing) {
            queuedAssets.set(reference.path, reference);
            assets.push(reference);
            if (assets.length > STATIC_ASSET_MAX_COUNT) {
              throw new Error(
                `local build exceeds the ${STATIC_ASSET_MAX_COUNT}-asset smoke limit`
              );
            }
          }
        }
      }
      if (asset.kind === "javascript") {
        const javascript = boundedUtf8(bytes, `local JavaScript asset ${asset.path}`);
        for (const reference of extractJavascriptImportPaths(
          javascript,
          asset.path,
          origin
        )) {
          const existing = queuedAssets.get(reference.path);
          if (existing && existing.kind !== reference.kind) {
            throw new Error(`production asset ${reference.path} has conflicting kinds`);
          }
          if (!existing) {
            queuedAssets.set(reference.path, reference);
            assets.push(reference);
            if (assets.length > STATIC_ASSET_MAX_COUNT) {
              throw new Error(
                `local build exceeds the ${STATIC_ASSET_MAX_COUNT}-asset smoke limit`
              );
            }
          }
        }
      }
    }

    const remoteIndex = await fetchBody({
      ...dependencies,
      url: cacheBustedUrl(origin, "/", clientBuildDigest),
      expectedContentType: "text/html",
      label: "remote client index",
      maximumBytes: STATIC_INDEX_MAX_BYTES,
      deadlineMs
    });
    assertWithinOverallDeadline();
    const localIndexSha256 = sha256(localIndex);
    if (sha256(remoteIndex.bytes) !== localIndexSha256) {
      throw new Error("remote client index does not match the expected build");
    }

    const remoteBuildManifest = await fetchBody({
      ...dependencies,
      url: cacheBustedUrl(origin, "/build.json", clientBuildDigest),
      expectedContentType: "application/json",
      label: "remote build manifest",
      maximumBytes: STATIC_BUILD_MANIFEST_MAX_BYTES,
      deadlineMs
    });
    assertWithinOverallDeadline();
    exactBuildManifest(remoteBuildManifest.bytes, sourceRevision, clientBuildDigest);

    const assetResults = [];
    for (const asset of localAssets) {
      assertWithinOverallDeadline();
      const expectedContentType = asset.kind === "css"
        ? "text/css"
        : asset.kind === "javascript"
          ? JAVASCRIPT_CONTENT_TYPES
          : asset.kind === "manifest"
            ? new Set(["application/manifest+json", "application/json"])
              : asset.kind === "font"
                ? asset.path.endsWith(".woff2")
                  ? "font/woff2"
                  : "font/woff"
              : asset.path.endsWith(".svg")
              ? "image/svg+xml"
              : asset.path.endsWith(".png")
                ? "image/png"
                : asset.path.endsWith(".webp")
                  ? "image/webp"
                  : asset.path.endsWith(".gif")
                    ? "image/gif"
                    : asset.path.endsWith(".jpg") || asset.path.endsWith(".jpeg")
                      ? "image/jpeg"
                      : "image/x-icon";
      const remote = await fetchBody({
        ...dependencies,
        url: cacheBustedUrl(origin, asset.path, clientBuildDigest),
        expectedContentType,
        label: `remote asset ${asset.path}`,
        maximumBytes: STATIC_ASSET_MAX_BYTES,
        deadlineMs
      });
      assertWithinOverallDeadline();
      const remoteSha256 = sha256(remote.bytes);
      if (remoteSha256 !== asset.sha256) {
        throw new Error(`remote asset ${asset.path} does not match the expected build`);
      }
      assetResults.push({
        path: asset.path,
        kind: asset.kind,
        sha256: asset.sha256
      });
    }

    assertWithinOverallDeadline();
    return {
      status: "ok",
      origin,
      sourceRevision,
      clientBuildDigest,
      indexSha256: localIndexSha256,
      buildManifestSha256: sha256(remoteBuildManifest.bytes),
      assets: assetResults
    };
  })();

  try {
    return await Promise.race([operation, overallTimeout]);
  } finally {
    if (overallTimer !== undefined) cancel(overallTimer);
  }
}

export async function smokeStaticAssetsAcrossOrigins(configuredUrls, options) {
  if (!Array.isArray(configuredUrls) || configuredUrls.length === 0) {
    throw new Error("static asset smoke requires at least one origin");
  }
  if (configuredUrls.length > STATIC_ASSET_MAX_ORIGINS) {
    throw new Error(
      `static asset smoke supports at most ${STATIC_ASSET_MAX_ORIGINS} origins`
    );
  }
  const origins = configuredUrls.map(canonicalOrigin);
  if (new Set(origins).size !== origins.length) {
    throw new Error("static asset smoke origins must be unique");
  }
  const results = await Promise.all(
    origins.map((origin) => smokeStaticAssets(origin, options))
  );
  return {
    status: "ok",
    sourceRevision: options.sourceRevision,
    clientBuildDigest: options.clientBuildDigest,
    origins: results
  };
}
