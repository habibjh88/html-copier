// save-rendered-with-assets.js
/**
 * Puppeteer scraper that:
 * - Crawls pages under START_URL (same host + prefix)
 * - Saves fully rendered HTML for each page
 * - Finds assets (img, script, link[rel=stylesheet], source, video, audio, meta og:image, inline styles url(...))
 * - Downloads assets and saves them under OUTPUT_DIR preserving the path
 * - Rewrites URLs in saved HTML and in downloaded CSS files to local relative paths
 *
 * Usage:
 *   npm i puppeteer
 *   node save-rendered-with-assets.js
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// If Node < 18 and you don't have global fetch, try to require node-fetch:
let fetchImpl = global.fetch;
if (!fetchImpl) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fetchImpl = require("node-fetch");
  } catch (e) {
    console.error(
      "No global fetch and node-fetch not installed. Install node 18+ or run: npm i node-fetch"
    );
    process.exit(1);
  }
}

const START_URL = "https://themenectar.com/salient/signal/";
const START_HOSTNAME = new URL(START_URL).hostname;
const PATH_PREFIX = "/salient/"; // only crawl under this prefix
const OUTPUT_DIR = path.resolve(__dirname, "rendered-site");
const MAX_PAGES = 500;
const WAIT_AFTER_LOAD = 1000; // ms

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function urlToLocalPath(url) {
  // Keep the original pathname. If pathname ends with '/', use index (rare for assets).
  try {
    const u = new URL(url);
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith("/")) p += "index";
    // remove leading slash to make it relative inside OUTPUT_DIR
    if (p.startsWith("/")) p = p.slice(1);
    // If path has no extension, try to preserve query by encoding it (to avoid collisions)
    const ext = path.extname(p);
    if (!ext && u.search) {
      // add a safe suffix made from search params
      p = p + "_" + Buffer.from(u.search).toString("hex");
    }
    return path.join(OUTPUT_DIR, p);
  } catch (e) {
    return null;
  }
}

function makeRelativeForHtml(htmlFilePath, assetLocalPath) {
  const rel = path.relative(path.dirname(htmlFilePath), assetLocalPath);
  // Use POSIX-style separators for URLs
  return rel.split(path.sep).join("/");
}

async function downloadAndSave(url, assetLocalPath) {
  if (!url || !assetLocalPath) return false;
  try {
    // skip data: URIs
    if (url.startsWith("data:")) return false;

    // If file already exists, skip
    if (fs.existsSync(assetLocalPath)) return true;

    console.log("  Download asset:", url);
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok) {
      console.warn("   -> failed:", res.status, url);
      return false;
    }
    const buffer = await res.arrayBuffer();
    ensureDir(assetLocalPath);
    fs.writeFileSync(assetLocalPath, Buffer.from(buffer), "binary");
    return true;
  } catch (err) {
    console.warn("   -> error downloading", url, err.message);
    return false;
  }
}

(async () => {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  const toVisit = [START_URL];
  const visited = new Set();
  const assetsDownloaded = new Set();

  function normalize(url) {
    try {
      const u = new URL(url, START_URL);
      u.hash = "";
      // normalize trailing slashes for pages
      if (u.pathname.endsWith("/") && u.pathname !== "/") {
        u.pathname = u.pathname.replace(/\/+$/, "/");
      }
      return u.toString();
    } catch (_) {
      return null;
    }
  }

  while (toVisit.length && visited.size < MAX_PAGES) {
    const url = toVisit.shift();
    const nurl = normalize(url);
    if (!nurl || visited.has(nurl)) continue;
    console.log("\nVisiting:", nurl);

    try {
      await page.goto(nurl, { waitUntil: "networkidle2", timeout: 45000 });
      if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(WAIT_AFTER_LOAD);
      } else {
        await sleep(WAIT_AFTER_LOAD);
      }

      // get rendered html
      let html = await page.content();

      // Extract assets from the page context (use page.evaluate to get absolute URLs)
      const assets = await page.evaluate(() => {
        const abs = (u) => {
          try {
            return new URL(u, document.baseURI).toString();
          } catch (e) {
            return null;
          }
        };

        const urls = new Set();

        // common attributes
        const attrSelectors = [
          ['img', 'src'],
          ['script', 'src'],
          ['link[rel="stylesheet"]', 'href'],
          ['source', 'src'],
          ['video', 'src'],
          ['audio', 'src'],
          ['iframe', 'src'],
          ['a[rel="icon"], link[rel="icon"]', 'href'],
          ['meta[property="og:image"]', 'content'],
        ];
        attrSelectors.forEach(([sel, attr]) => {
          document.querySelectorAll(sel).forEach((el) => {
            const v = el.getAttribute(attr);
            if (v) {
              const a = abs(v);
              if (a) urls.add(a);
            }
          });
        });

        // background images in inline styles
        document.querySelectorAll("[style]").forEach((el) => {
          const s = el.getAttribute("style");
          const matches = s.matchAll(/url\((['"]?)(.*?)\1\)/g);
          for (const m of matches) {
            const a = abs(m[2]);
            if (a) urls.add(a);
          }
        });

        // CSS files: we should include their URLs so we can download and then scan them later
        document.querySelectorAll('link[rel="stylesheet"]').forEach((el) => {
          const v = el.getAttribute("href");
          if (v) {
            const a = abs(v);
            if (a) urls.add(a);
          }
        });

        return Array.from(urls);
      });

      // Also include resources observed by network responses? (optional)
      // For simplicity, use the extracted assets list.

      // Download each asset and rewrite references
      // Map of original URL -> local path (full path)
      const urlToLocal = {};

      for (const assetUrl of assets) {
        // Only download resources from same origin OR allow external hosts (we'll include same host only to be safe)
        try {
          const parsed = new URL(assetUrl);
          // allow same hostname or assets under same domain (you can relax this if you want external hosts)
          if (parsed.hostname !== START_HOSTNAME) {
            // skip external assets (fonts/CDNs) to keep output small; you can enable if you want
            // continue;
            // Optionally we can still download external assets: comment the continue above.
          }

          const localPath = urlToLocalPath(assetUrl);
          if (!localPath) continue;

          const already = assetsDownloaded.has(assetUrl);
          const ok = already || (await downloadAndSave(assetUrl, localPath));
          if (ok) {
            assetsDownloaded.add(assetUrl);
            urlToLocal[assetUrl] = localPath;
          }
        } catch (e) {
          // ignore invalid URLs
        }
      }

      // Rewrite asset URLs in HTML to relative local paths
      // For each original absolute asset URL, replace occurrences in html with relative path
      const pagePathname = new URL(nurl).pathname;
      let htmlFilePath = pagePathname;
      if (htmlFilePath.endsWith("/")) htmlFilePath += "index.html";
      if (htmlFilePath === "/") htmlFilePath = "/index.html";
      htmlFilePath = path.join(OUTPUT_DIR, decodeURIComponent(htmlFilePath.slice(1)));

      // replace occurrences
      for (const [origUrl, localFullPath] of Object.entries(urlToLocal)) {
        const rel = makeRelativeForHtml(htmlFilePath, localFullPath);
        // replace full occurrences of origUrl in HTML (also handle protocol-less variants)
        const escaped = origUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(escaped, "g");
        html = html.replace(re, rel);
        // also replace origin-less variants (//domain/...)
        const u = new URL(origUrl);
        const originLess = "//" + u.hostname + u.pathname + u.search;
        const re2 = new RegExp(originLess.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        html = html.replace(re2, rel);
      }

      // Save HTML
      ensureDir(htmlFilePath);
      fs.writeFileSync(htmlFilePath, html, "utf8");
      console.log(" Saved HTML:", htmlFilePath);

      // For CSS files we've downloaded, scan for url(...) references and download those targets too,
      // then rewrite URLs inside the CSS to local relative paths.
      const cssUrls = Object.keys(urlToLocal).filter((u) => u.match(/\.css($|\?)/i));
      for (const cssUrl of cssUrls) {
        const cssLocal = urlToLocal[cssUrl];
        try {
          let cssText = fs.readFileSync(cssLocal, "utf8");
          // find url(...) usages
          const matches = Array.from(cssText.matchAll(/url\((['"]?)(.*?)\1\)/g));
          for (const m of matches) {
            const ref = m[2];
            if (!ref) continue;
            try {
              const abs = new URL(ref, cssUrl).toString();
              if (assetsDownloaded.has(abs)) {
                const localFull = urlToLocal[abs];
                const relForCss = path.relative(path.dirname(cssLocal), localFull).split(path.sep).join("/");
                cssText = cssText.split(m[0]).join(`url("${relForCss}")`);
              } else {
                // try to download it now
                const localFull = urlToLocalPath(abs);
                if (localFull) {
                  const ok = await downloadAndSave(abs, localFull);
                  if (ok) {
                    assetsDownloaded.add(abs);
                    urlToLocal[abs] = localFull;
                    const relForCss = path.relative(path.dirname(cssLocal), localFull).split(path.sep).join("/");
                    cssText = cssText.split(m[0]).join(`url("${relForCss}")`);
                  }
                }
              }
            } catch (e) {
              // ignore bad urls
            }
          }
          fs.writeFileSync(cssLocal, cssText, "utf8");
        } catch (err) {
          // ignore css read errors
        }
      }

      visited.add(nurl);

      // enqueue same-site links under PATH_PREFIX
      const anchors = await page.$$eval("a[href]", (nodes) => nodes.map((n) => n.getAttribute("href")));
      for (let a of anchors) {
        try {
          const abs = new URL(a, nurl).toString();
          const absObj = new URL(abs);
          if (
            absObj.hostname === START_HOSTNAME &&
            absObj.pathname.startsWith(PATH_PREFIX) // restrict crawl
          ) {
            const norm = normalize(abs);
            if (norm && !visited.has(norm) && !toVisit.includes(norm)) toVisit.push(norm);
          }
        } catch (e) {}
      }
    } catch (err) {
      console.error(" Error visiting", nurl, "|", err.message);
      visited.add(nurl);
    }
  }

  await browser.close();
  console.log("\nDone. Pages saved:", visited.size);
  console.log("Assets downloaded:", assetsDownloaded.size);
  console.log("Output folder:", OUTPUT_DIR);
})();