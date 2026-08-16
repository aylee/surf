import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  STATIC_INDEX_MAX_BYTES,
  extractCssReferencePaths,
  extractJavascriptImportPaths,
  extractProductionAssetPaths,
  smokeStaticAssets,
  smokeStaticAssetsAcrossOrigins
} from "../lib/static-assets-smoke.mjs";

const ORIGIN = "https://surf.example";
const WORKERS_DEV_ORIGIN = "https://surf-release.workers.dev";
const SOURCE_REVISION = "a".repeat(40);
const CLIENT_BUILD_DIGEST = "b".repeat(64);
const JAVASCRIPT_PATH = "/assets/index-abc123.js";
const CSS_PATH = "/assets/index-def456.css";
const FAVICON_PATH = "/favicon.svg";
const FONT_PATH = "/assets/surf-font.woff2";
const LAZY_JAVASCRIPT_PATH = "/assets/ForecastGraph-lazy789.js";
const SHARED_JAVASCRIPT_PATH = "/assets/chart-shared-ghi012.js";
const JAVASCRIPT = "console.log(\"expected build\");\n";
const CSS = `@font-face { font-family: Surf; src: url("./surf-font.woff2") format("woff2"); }\n:root { color: #123456; }\n`;
const FONT = Buffer.from("expected-font-bytes");
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg"/>\n';
const GRAPH_JAVASCRIPT = [
  "const importDecoy = \"import('https://evil.example/not-code.js')\";",
  "const importPattern = /import\\([\"']not-code/;",
  "// import('./comment-decoy.js')",
  `const loadForecastGraph = () => import(\`./${LAZY_JAVASCRIPT_PATH.split("/").at(-1)}\`);`,
  "export { loadForecastGraph };",
  ""
].join("\n");
const LAZY_JAVASCRIPT = [
  `import { loadForecastGraph } from \"./${JAVASCRIPT_PATH.split("/").at(-1)}\";`,
  `export { chartScale } from \"./${SHARED_JAVASCRIPT_PATH.split("/").at(-1)}\";`,
  "export const renderForecastGraph = () => loadForecastGraph;",
  ""
].join("\n");
const SHARED_JAVASCRIPT = "export const chartScale = 1;\n";
const WEB_ANALYTICS_SCRIPT_VERSION = "1".repeat(45);
const WEB_ANALYTICS_INTEGRITY = Buffer.alloc(64, 1).toString("base64");
const WEB_ANALYTICS_CONFIGURATION = Object.freeze({
  version: "2024.11.0",
  token: "2".repeat(32),
  r: 1
});

function indexHtml({ javascript = JAVASCRIPT_PATH, css = CSS_PATH, extra = "" } = {}) {
  return [
    "<!doctype html>",
    '<html><head><meta charset="UTF-8">',
    `<link rel="icon" href="${FAVICON_PATH}">`,
    `<link rel="stylesheet" crossorigin href="${css}">`,
    "</head><body>",
    `<script type="module" crossorigin src="${javascript}"></script>`,
    extra,
    "</body></html>\n"
  ].join("");
}

function buildManifest(overrides = {}) {
  return JSON.stringify({
    sourceRevision: SOURCE_REVISION,
    clientBuildDigest: CLIENT_BUILD_DIGEST,
    ...overrides
  });
}

function webAnalyticsScript({
  scheme = "https",
  host = "static.cloudflareinsights.com",
  path = `beacon.min.js/v${WEB_ANALYTICS_SCRIPT_VERSION}`,
  integrity = `sha512-${WEB_ANALYTICS_INTEGRITY}`,
  configuration = JSON.stringify(WEB_ANALYTICS_CONFIGURATION)
} = {}) {
  return `<script type="module" src="${scheme}://${host}/${path}" integrity="${integrity}" data-cf-beacon='${configuration}' crossorigin="anonymous"></script>`;
}

function injectWebAnalytics(index, script = webAnalyticsScript()) {
  return index.replace("</body>", `${script}\n</body>`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "surf-static-assets-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const clientDirectory = join(root, "dist", "client");
  await mkdir(join(clientDirectory, "assets"), { recursive: true });
  const index = indexHtml();
  await Promise.all([
    writeFile(join(clientDirectory, "index.html"), index),
    writeFile(join(clientDirectory, JAVASCRIPT_PATH), JAVASCRIPT),
    writeFile(join(clientDirectory, CSS_PATH), CSS),
    writeFile(join(clientDirectory, FONT_PATH), FONT),
    writeFile(join(clientDirectory, FAVICON_PATH), FAVICON)
  ]);
  return { clientDirectory, index };
}

async function installJavascriptGraph(clientDirectory) {
  await Promise.all([
    writeFile(join(clientDirectory, JAVASCRIPT_PATH), GRAPH_JAVASCRIPT),
    writeFile(join(clientDirectory, LAZY_JAVASCRIPT_PATH), LAZY_JAVASCRIPT),
    writeFile(join(clientDirectory, SHARED_JAVASCRIPT_PATH), SHARED_JAVASCRIPT)
  ]);
}

function javascriptGraphRoutes(overrides = {}) {
  return {
    [JAVASCRIPT_PATH]: {
      body: GRAPH_JAVASCRIPT,
      contentType: "application/javascript; charset=utf-8"
    },
    [LAZY_JAVASCRIPT_PATH]: {
      body: LAZY_JAVASCRIPT,
      contentType: "application/javascript; charset=utf-8"
    },
    [SHARED_JAVASCRIPT_PATH]: {
      body: SHARED_JAVASCRIPT,
      contentType: "application/javascript; charset=utf-8"
    },
    ...overrides
  };
}

function routeTable(index, overrides = {}) {
  return {
    "/": { body: index, contentType: "text/html; charset=utf-8" },
    "/build.json": { body: buildManifest(), contentType: "application/json" },
    [JAVASCRIPT_PATH]: {
      body: JAVASCRIPT,
      contentType: "application/javascript; charset=utf-8"
    },
    [CSS_PATH]: { body: CSS, contentType: "text/css; charset=utf-8" },
    [FONT_PATH]: { body: FONT, contentType: "font/woff2" },
    [FAVICON_PATH]: { body: FAVICON, contentType: "image/svg+xml" },
    ...overrides
  };
}

function fakeFetcher(index, { overrides = {}, requests = [] } = {}) {
  const routes = routeTable(index, overrides);
  return async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    const route = routes[url.pathname];
    if (!route) {
      return new Response("missing", {
        status: 404,
        headers: { "content-type": "text/plain" }
      });
    }
    const headers = new Headers(route.headers);
    if (route.contentType !== null && !headers.has("content-type")) {
      headers.set("content-type", route.contentType);
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers
    });
  };
}

function smokeOptions(clientDirectory, fetcher, overrides = {}) {
  return {
    clientDirectory,
    sourceRevision: SOURCE_REVISION,
    clientBuildDigest: CLIENT_BUILD_DIGEST,
    fetcher,
    ...overrides
  };
}

test("static asset smoke proves the exact local index, manifest, JavaScript, and CSS", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const requests = [];
  const result = await smokeStaticAssets(
    ORIGIN,
    smokeOptions(clientDirectory, fakeFetcher(index, { requests }))
  );

  assert.deepEqual(result, {
    status: "ok",
    origin: ORIGIN,
    sourceRevision: SOURCE_REVISION,
    clientBuildDigest: CLIENT_BUILD_DIGEST,
    indexSha256: sha256(index),
    buildManifestSha256: sha256(buildManifest()),
    assets: [
      { path: JAVASCRIPT_PATH, kind: "javascript", sha256: sha256(JAVASCRIPT) },
      { path: CSS_PATH, kind: "css", sha256: sha256(CSS) },
      { path: FAVICON_PATH, kind: "image", sha256: sha256(FAVICON) },
      { path: FONT_PATH, kind: "font", sha256: sha256(FONT) }
    ]
  });
  assert.equal(JSON.stringify(result).includes(JAVASCRIPT), false);
  assert.equal(JSON.stringify(result).includes(CSS), false);

  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    ["/", "/build.json", JAVASCRIPT_PATH, CSS_PATH, FAVICON_PATH, FONT_PATH]
  );
  for (const { url, init } of requests) {
    assert.equal(url.origin, ORIGIN);
    assert.deepEqual([...url.searchParams], [["surf-build", CLIENT_BUILD_DIGEST]]);
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["Cache-Control"], "no-cache, no-store, max-age=0");
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("the exact canonical Cloudflare Web Analytics insertion preserves index and asset proof", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const requests = [];
  const result = await smokeStaticAssets(
    ORIGIN,
    smokeOptions(
      clientDirectory,
      fakeFetcher(index, {
        requests,
        overrides: {
          "/": {
            body: injectWebAnalytics(index),
            contentType: "text/html; charset=utf-8"
          }
        }
      })
    )
  );

  assert.equal(result.indexSha256, sha256(index));
  assert.deepEqual(
    result.assets.map(({ path, sha256: digest }) => ({ path, digest })),
    [
      { path: JAVASCRIPT_PATH, digest: sha256(JAVASCRIPT) },
      { path: CSS_PATH, digest: sha256(CSS) },
      { path: FAVICON_PATH, digest: sha256(FAVICON) },
      { path: FONT_PATH, digest: sha256(FONT) }
    ]
  );
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    ["/", "/build.json", JAVASCRIPT_PATH, CSS_PATH, FAVICON_PATH, FONT_PATH]
  );
});

test("noncanonical or nonexclusive Web Analytics transformations fail closed", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const canonical = webAnalyticsScript();
  const cases = [
    {
      name: "wrong insertion location",
      remoteIndex: index.replace("</head>", `${canonical}\n</head>`)
    },
    {
      name: "duplicate marker",
      remoteIndex: injectWebAnalytics(index, `${canonical}\n${canonical}`)
    },
    {
      name: "reordered attributes",
      remoteIndex: injectWebAnalytics(
        index,
        canonical.replace(
          '<script type="module" src=',
          '<script src='
        ).replace(
          `/${WEB_ANALYTICS_SCRIPT_VERSION}" integrity=`,
          `/${WEB_ANALYTICS_SCRIPT_VERSION}" type="module" integrity=`
        )
      )
    },
    {
      name: "extra attribute",
      remoteIndex: injectWebAnalytics(index, canonical.replace("<script ", "<script defer "))
    },
    {
      name: "non-HTTPS URL",
      remoteIndex: injectWebAnalytics(index, webAnalyticsScript({ scheme: "http" }))
    },
    {
      name: "wrong host",
      remoteIndex: injectWebAnalytics(index, webAnalyticsScript({ host: "analytics.example" }))
    },
    {
      name: "wrong path",
      remoteIndex: injectWebAnalytics(
        index,
        webAnalyticsScript({ path: `other.min.js/v${WEB_ANALYTICS_SCRIPT_VERSION}` })
      )
    },
    {
      name: "bad SRI",
      remoteIndex: injectWebAnalytics(index, webAnalyticsScript({ integrity: "sha256-invalid" }))
    },
    {
      name: "absent SRI",
      remoteIndex: injectWebAnalytics(
        index,
        canonical.replace(` integrity="sha512-${WEB_ANALYTICS_INTEGRITY}"`, "")
      )
    },
    {
      name: "noncanonical configuration JSON",
      remoteIndex: injectWebAnalytics(
        index,
        webAnalyticsScript({
          configuration: JSON.stringify(WEB_ANALYTICS_CONFIGURATION, null, 0).replace(
            '"version":',
            '"version": '
          )
        })
      )
    },
    {
      name: "extra configuration field",
      remoteIndex: injectWebAnalytics(
        index,
        webAnalyticsScript({
          configuration: JSON.stringify({ ...WEB_ANALYTICS_CONFIGURATION, extra: true })
        })
      )
    },
    {
      name: "arbitrary surrounding byte drift",
      remoteIndex: injectWebAnalytics(index, canonical).replace(
        "</html>",
        "<!-- unexpected -->\n</html>"
      )
    }
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      await assert.rejects(
        () =>
          smokeStaticAssets(
            ORIGIN,
            smokeOptions(
              clientDirectory,
              fakeFetcher(index, {
                overrides: {
                  "/": { body: candidate.remoteIndex, contentType: "text/html" }
                }
              })
            )
          ),
        (error) => error.message === "remote client index does not match the expected build"
      );
    });
  }
});

test("one verifier invocation composes across custom and workers.dev origins", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const requests = [];
  const result = await smokeStaticAssetsAcrossOrigins(
    [ORIGIN, WORKERS_DEV_ORIGIN],
    smokeOptions(clientDirectory, fakeFetcher(index, { requests }))
  );

  assert.deepEqual(
    result.origins.map(({ origin }) => origin),
    [ORIGIN, WORKERS_DEV_ORIGIN]
  );
  assert.equal(result.sourceRevision, SOURCE_REVISION);
  assert.equal(result.clientBuildDigest, CLIENT_BUILD_DIGEST);
  for (const origin of [ORIGIN, WORKERS_DEV_ORIGIN]) {
    assert.deepEqual(
      requests.filter(({ url }) => url.origin === origin).map(({ url }) => url.pathname),
      ["/", "/build.json", JAVASCRIPT_PATH, CSS_PATH, FAVICON_PATH, FONT_PATH]
    );
  }
});

test("the smoke traverses Vite-style lazy chunks, static imports, re-exports, and cycles", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  await installJavascriptGraph(clientDirectory);
  const requests = [];
  const result = await smokeStaticAssets(
    ORIGIN,
    smokeOptions(
      clientDirectory,
      fakeFetcher(index, { overrides: javascriptGraphRoutes(), requests })
    )
  );

  assert.deepEqual(
    result.assets.map(({ path }) => path),
    [
      JAVASCRIPT_PATH,
      CSS_PATH,
      FAVICON_PATH,
      LAZY_JAVASCRIPT_PATH,
      FONT_PATH,
      SHARED_JAVASCRIPT_PATH
    ]
  );
  assert.deepEqual(
    result.assets
      .filter(({ kind }) => kind === "javascript")
      .map(({ path, sha256: digest }) => ({ path, digest })),
    [
      { path: JAVASCRIPT_PATH, digest: sha256(GRAPH_JAVASCRIPT) },
      { path: LAZY_JAVASCRIPT_PATH, digest: sha256(LAZY_JAVASCRIPT) },
      { path: SHARED_JAVASCRIPT_PATH, digest: sha256(SHARED_JAVASCRIPT) }
    ]
  );
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    [
      "/",
      "/build.json",
      JAVASCRIPT_PATH,
      CSS_PATH,
      FAVICON_PATH,
      LAZY_JAVASCRIPT_PATH,
      FONT_PATH,
      SHARED_JAVASCRIPT_PATH
    ]
  );
});

test("literal import extraction ignores strings, comments, and regular expressions", () => {
  assert.deepEqual(
    extractJavascriptImportPaths(GRAPH_JAVASCRIPT, JAVASCRIPT_PATH, ORIGIN),
    [{ path: LAZY_JAVASCRIPT_PATH, kind: "javascript" }]
  );
  assert.deepEqual(
    extractJavascriptImportPaths(LAZY_JAVASCRIPT, LAZY_JAVASCRIPT_PATH, ORIGIN),
    [
      { path: SHARED_JAVASCRIPT_PATH, kind: "javascript" },
      { path: JAVASCRIPT_PATH, kind: "javascript" }
    ]
  );
});

test("unsafe or ambiguous JavaScript imports fail closed", () => {
  const invalidModules = [
    "const load = (target) => import(target);",
    "const load = (name) => import(`./chunk-${name}.js`);",
    "const load = () => import('https://evil.example/chunk.js');",
    "const load = () => import('../outside.js');",
    "const load = () => import('./chunk.js?stale=1');",
    "const load = () => import('./chunk%2ejs');",
    "const load = () => import('./chunk.js', { with: { type: 'javascript' } });",
    "import 'react';",
    "import 'chunk.js';",
    String.raw`const load = () => import('./chunk\x2ejs');`
  ];
  for (const javascript of invalidModules) {
    assert.throws(() =>
      extractJavascriptImportPaths(javascript, JAVASCRIPT_PATH, ORIGIN)
    );
  }
});

test("stale and missing reachable lazy chunks are rejected", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  await installJavascriptGraph(clientDirectory);

  await assert.rejects(
    () =>
      smokeStaticAssets(
        ORIGIN,
        smokeOptions(
          clientDirectory,
          fakeFetcher(index, {
            overrides: javascriptGraphRoutes({
              [LAZY_JAVASCRIPT_PATH]: {
                body: "export const stale = true;\n",
                contentType: "application/javascript"
              }
            })
          })
        )
      ),
    /ForecastGraph-lazy789\.js does not match the expected build/
  );

  await assert.rejects(
    () =>
      smokeStaticAssets(
        ORIGIN,
        smokeOptions(
          clientDirectory,
          fakeFetcher(index, {
            overrides: javascriptGraphRoutes({
              [SHARED_JAVASCRIPT_PATH]: {
                body: "missing",
                status: 404,
                contentType: "text/plain"
              }
            })
          })
        )
      ),
    /chart-shared-ghi012\.js returned HTTP 404/
  );
});

test("CSS references are bounded, same-origin, and traversal-safe", () => {
  assert.deepEqual(
    extractCssReferencePaths(CSS, CSS_PATH, ORIGIN),
    [{ path: FONT_PATH, kind: "font" }]
  );
  assert.deepEqual(
    extractCssReferencePaths(
      ".x{background:url(data:image/png;base64,AAAA)}",
      CSS_PATH,
      ORIGIN
    ),
    []
  );
  for (const css of [
    ".x{src:url(https://evil.example/font.woff2)}",
    ".x{src:url(../font.woff2)}",
    ".x{src:url(/outside/font.woff2)}",
    ".x{src:url(/assets/font.woff2?stale=1)}"
  ]) {
    assert.throws(() => extractCssReferencePaths(css, CSS_PATH, ORIGIN));
  }
});

test("asset extraction accepts only bounded same-origin production JS and CSS", () => {
  assert.deepEqual(
    extractProductionAssetPaths(
      indexHtml({
        javascript: `${ORIGIN}${JAVASCRIPT_PATH}`,
        css: `${ORIGIN}${CSS_PATH}`
      }),
      ORIGIN
    ),
    [
      { path: JAVASCRIPT_PATH, kind: "javascript" },
      { path: CSS_PATH, kind: "css" },
      { path: FAVICON_PATH, kind: "image" }
    ]
  );

  const invalidIndexes = [
    indexHtml({ javascript: `https://evil.example${JAVASCRIPT_PATH}` }),
    indexHtml({ javascript: `//evil.example${JAVASCRIPT_PATH}` }),
    indexHtml({ javascript: "/assets/chunks/../index.js" }),
    indexHtml({ javascript: "/assets/%2e%2e/index.js" }),
    indexHtml({ javascript: "/assets//index.js" }),
    indexHtml({ javascript: "/outside/index.js" }),
    indexHtml({ javascript: `${JAVASCRIPT_PATH}?stale=1` }),
    indexHtml({ javascript: `${JAVASCRIPT_PATH}#mixed` }),
    indexHtml({ javascript: "/assets/index.css" }),
    indexHtml({ css: "/assets/index.js" }),
    indexHtml({ extra: `<script src="${JAVASCRIPT_PATH}"></script>` }),
    indexHtml({ extra: `<link rel="stylesheet" href="${CSS_PATH}">` }),
    indexHtml().replace(`<script type="module" crossorigin src="${JAVASCRIPT_PATH}"></script>`, ""),
    indexHtml().replace(`<link rel="stylesheet" crossorigin href="${CSS_PATH}">`, ""),
    indexHtml({ javascript: `/assets/${"a".repeat(513)}.js` })
  ];
  for (const invalidIndex of invalidIndexes) {
    assert.throws(() => extractProductionAssetPaths(invalidIndex, ORIGIN));
  }
});

test("origins and expected identities are exact and fail closed", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const fetcher = fakeFetcher(index);
  for (const invalidOrigin of [
    "http://surf.example",
    "https://user:secret@surf.example",
    "https://surf.example/path",
    "https://surf.example?query=1",
    "https://surf.example#fragment"
  ]) {
    await assert.rejects(() =>
      smokeStaticAssets(invalidOrigin, smokeOptions(clientDirectory, fetcher))
    );
  }
  await assert.rejects(() =>
    smokeStaticAssets(
      ORIGIN,
      smokeOptions(clientDirectory, fetcher, { sourceRevision: "A".repeat(40) })
    )
  );
  await assert.rejects(() =>
    smokeStaticAssets(
      ORIGIN,
      smokeOptions(clientDirectory, fetcher, { clientBuildDigest: "b".repeat(63) })
    )
  );
  await assert.rejects(
    () =>
      smokeStaticAssetsAcrossOrigins(
        [ORIGIN, `${ORIGIN}/`],
        smokeOptions(clientDirectory, fetcher)
      ),
    /origins must be unique/
  );
  await assert.rejects(
    () =>
      smokeStaticAssetsAcrossOrigins(
        [ORIGIN, WORKERS_DEV_ORIGIN, "https://third.example"],
        smokeOptions(clientDirectory, fetcher)
      ),
    /at most 2 origins/
  );
  await assert.rejects(() =>
    smokeStaticAssets(
      ORIGIN,
      smokeOptions(clientDirectory, fetcher, { requestTimeoutMs: 15_001 })
    )
  );
  await assert.rejects(() =>
    smokeStaticAssets(
      ORIGIN,
      smokeOptions(clientDirectory, fetcher, { overallTimeoutMs: 90_001 })
    )
  );
});

test("stale, mixed, duplicate, and missing remote builds are rejected", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const cases = [
    {
      name: "stale index",
      overrides: { "/": { body: `${index}<!-- stale -->`, contentType: "text/html" } },
      message: /client index does not match/
    },
    {
      name: "stale revision",
      overrides: {
        "/build.json": {
          body: buildManifest({ sourceRevision: "c".repeat(40) }),
          contentType: "application/json"
        }
      },
      message: /sourceRevision is stale/
    },
    {
      name: "stale client digest",
      overrides: {
        "/build.json": {
          body: buildManifest({ clientBuildDigest: "d".repeat(64) }),
          contentType: "application/json"
        }
      },
      message: /clientBuildDigest is stale/
    },
    {
      name: "unexpected manifest field",
      overrides: {
        "/build.json": {
          body: JSON.stringify({
            sourceRevision: SOURCE_REVISION,
            clientBuildDigest: CLIENT_BUILD_DIGEST,
            duplicate: CLIENT_BUILD_DIGEST
          }),
          contentType: "application/json"
        }
      },
      message: /must contain exactly/
    },
    {
      name: "missing asset",
      overrides: { [JAVASCRIPT_PATH]: { body: "missing", status: 404, contentType: "text/plain" } },
      message: /returned HTTP 404/
    },
    {
      name: "mixed JavaScript asset",
      overrides: { [JAVASCRIPT_PATH]: { body: "console.log('other');", contentType: "application/javascript" } },
      message: /does not match the expected build/
    },
    {
      name: "mixed CSS asset",
      overrides: { [CSS_PATH]: { body: "body { color: red; }", contentType: "text/css" } },
      message: /does not match the expected build/
    },
    {
      name: "missing favicon",
      overrides: {
        [FAVICON_PATH]: { body: "missing", status: 404, contentType: "text/plain" }
      },
      message: /returned HTTP 404/
    }
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      await assert.rejects(
        () =>
          smokeStaticAssets(
            ORIGIN,
            smokeOptions(
              clientDirectory,
              fakeFetcher(index, { overrides: candidate.overrides })
            )
          ),
        candidate.message
      );
    });
  }
});

test("every remote body requires its exact production content type", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const cases = [
    ["index", "/", { body: index, contentType: "text/plain" }],
    ["manifest", "/build.json", { body: buildManifest(), contentType: "text/plain" }],
    ["JavaScript", JAVASCRIPT_PATH, { body: JAVASCRIPT, contentType: "text/css" }],
    ["CSS", CSS_PATH, { body: CSS, contentType: "application/javascript" }],
    ["font", FONT_PATH, { body: FONT, contentType: "application/octet-stream" }],
    ["favicon", FAVICON_PATH, { body: FAVICON, contentType: "text/plain" }]
  ];
  for (const [name, path, route] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () =>
          smokeStaticAssets(
            ORIGIN,
            smokeOptions(
              clientDirectory,
              fakeFetcher(index, { overrides: { [path]: route } })
            )
          ),
        /returned content type/
      );
    });
  }
});

test("declared oversized bodies are rejected before they are read", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  let bodyRead = false;
  const fetcher = async () => ({
    url: "",
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "text/html",
      "content-length": String(STATIC_INDEX_MAX_BYTES + 1)
    }),
    body: { cancel() {} },
    async arrayBuffer() {
      bodyRead = true;
      return Buffer.from(index);
    }
  });
  await assert.rejects(
    () => smokeStaticAssets(ORIGIN, smokeOptions(clientDirectory, fetcher)),
    /exceeds the .*byte limit/
  );
  assert.equal(bodyRead, false);
});

test("each fetch and body read is bounded by the per-request timeout", async (t) => {
  const { clientDirectory } = await fixture(t);
  let cancelled = false;
  const fetcher = async () => ({
    url: "",
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    body: {
      getReader() {
        return {
          read() {
            return new Promise(() => {});
          },
          cancel() {
            cancelled = true;
            return Promise.resolve();
          },
          releaseLock() {}
        };
      },
      cancel() {
        cancelled = true;
        return Promise.resolve();
      }
    }
  });
  await assert.rejects(
    () =>
      smokeStaticAssets(
        ORIGIN,
        smokeOptions(clientDirectory, fetcher, {
          requestTimeoutMs: 10,
          overallTimeoutMs: 100
        })
      ),
    (error) => error.name === "TimeoutError" && /remote client index timed out/.test(error.message)
  );
  assert.equal(cancelled, true);
});

test("the overall deadline prevents starting another remote body", async (t) => {
  const { clientDirectory, index } = await fixture(t);
  const timestamps = [0, 51];
  let fetched = false;
  await assert.rejects(
    () =>
      smokeStaticAssets(
        ORIGIN,
        smokeOptions(
          clientDirectory,
          async () => {
            fetched = true;
            return new Response(index, { headers: { "content-type": "text/html" } });
          },
          {
            now: () => timestamps.shift() ?? 51,
            overallTimeoutMs: 50
          }
        )
      ),
    (error) => error.name === "TimeoutError" && /static asset smoke timed out/.test(error.message)
  );
  assert.equal(fetched, false);
});

test("the overall timeout also bounds injected local reads", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      smokeStaticAssets(ORIGIN, {
        clientDirectory: "/absolute/dist/client",
        sourceRevision: SOURCE_REVISION,
        clientBuildDigest: CLIENT_BUILD_DIGEST,
        readFile() {
          return new Promise(() => {});
        },
        async fetcher() {
          fetched = true;
          throw new Error("fetch must not start after the overall timeout");
        },
        requestTimeoutMs: 100,
        overallTimeoutMs: 10
      }),
    (error) => error.name === "TimeoutError" && /static asset smoke timed out/.test(error.message)
  );
  assert.equal(fetched, false);
});
