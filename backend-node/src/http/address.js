// The address of the client. The server trusts `X-Forwarded-For` only when the
// request comes from a proxy in `trusted`.
export function clientAddress(req, trusted) {
  const clean = (value) => value.replace(/^::ffff:/, "");
  const peer = clean(req.socket.remoteAddress || "unknown");
  if (!trusted.includes(peer)) return peer.slice(0, 64);
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => clean(value.trim()))
    .filter(Boolean);
  const client = forwarded.findLast((value) => !trusted.includes(value)) ?? forwarded[0];
  return (client ?? peer).slice(0, 64);
}
