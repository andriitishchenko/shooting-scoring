const METHODS = "GET, POST, PUT, PATCH, DELETE";
const HEADERS = "Content-Type, X-Session-Id";

// Answer a CORS preflight request. Return true when the request is complete.
// The server allows only the origins in the list. The browser app uses the same origin.
export function cors(req, res, origins) {
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = origins.includes(origin);
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
    if (!allowed) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Origin not allowed");
      return true;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": METHODS,
      "Access-Control-Allow-Headers": HEADERS,
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return true;
  }
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  return false;
}
