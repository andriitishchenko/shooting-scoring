import { HttpError } from "../errors.js";

// Read the JSON body of a request. The limit protects the memory of the server.
// Return `undefined` for an empty body.
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, "Request body too large", { Connection: "close" });
    if (Number(req.headers["content-length"]) > limit) return reject(tooLarge());
    const chunks = [];
    let size = 0;
    let done = false;
    const stop = (error) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) stop(tooLarge());
      else chunks.push(chunk);
    });
    req.on("error", stop);
    req.on("end", () => {
      if (done) return;
      done = true;
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "The request body is not valid JSON"));
      }
    });
  });
}
