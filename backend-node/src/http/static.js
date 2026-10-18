import fs from "node:fs";
import path from "node:path";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { fail } from "../errors.js";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/vnd.microsoft.icon",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;
const MAX_CACHED = 2 * 1024 * 1024;

// Serve files from folders. A mount has a URL prefix, a folder, and an optional
// set of allowed file names. The server keeps the small files in memory and
// checks the file again at most once in `recheckMs`, so a changed file is read
// again. A request for a file that was checked a short time ago uses no system call.
export function createStatic(mounts, { recheckMs = 1000 } = {}) {
  const ordered = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
  const cache = new Map(); // file -> { etag, data, ... }
  const known = new Map(); // pathname -> { file, stat, checked }
  const roots = new Map();

  const rootOf = (dir) => {
    if (!roots.has(dir)) roots.set(dir, fs.realpathSync(dir));
    return roots.get(dir);
  };

  function locate(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    for (const mount of ordered) {
      if (!decoded.startsWith(mount.prefix)) continue;
      const relative = path.posix.normalize("/" + decoded.slice(mount.prefix.length));
      if (relative.split("/").includes("..")) return null;
      let file = path.join(mount.dir, relative);
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
        const real = fs.realpathSync(file);
        const root = rootOf(mount.dir);
        if (real !== root && !real.startsWith(root + path.sep)) return null;
        if (mount.files && !mount.files.has(path.basename(real))) return null;
        const stat = fs.statSync(real);
        return stat.isFile() ? { file: real, stat } : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function compressed(entry, encoding) {
    if (!entry[encoding]) {
      entry[encoding] = encoding === "br"
        ? brotli(entry.data, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
        : gzipAsync(entry.data);
    }
    return entry[encoding];
  }

  // Return true when the request was answered. Return false when no file fits.
  return async function serve(req, res, pathname) {
    if (!["GET", "HEAD"].includes(req.method)) fail(405, "Method Not Allowed", { Allow: "GET, HEAD" });
    let found = known.get(pathname);
    if (!found || Date.now() - found.checked >= recheckMs) {
      found = locate(pathname);
      if (!found) {
        known.delete(pathname);
        return false;
      }
      found.checked = Date.now();
      if (known.size >= 500) known.clear();
      known.set(pathname, found);
    }
    const { file, stat } = found;
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = { "Content-Type": type, ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" };
    const tag = req.headers["if-none-match"];
    if (tag && (tag.trim() === "*" || tag.split(",").some((value) => value.trim() === etag))) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      res.end();
      return true;
    }
    if (stat.size > MAX_CACHED) {
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      if (req.method === "HEAD") res.end();
      else await pipeline(fs.createReadStream(file), res);
      return true;
    }
    let entry = cache.get(file);
    if (!entry || entry.etag !== etag) {
      entry = { etag, data: fs.readFileSync(file) };
      cache.set(file, entry);
    }
    let body = entry.data;
    if (COMPRESSIBLE.test(type) && body.length >= 1024) {
      const accepted = String(req.headers["accept-encoding"] ?? "");
      const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
      if (encoding) {
        body = await compressed(entry, encoding === "br" ? "br" : "gzip");
        headers["Content-Encoding"] = encoding;
      }
    }
    res.writeHead(200, { ...headers, "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}
