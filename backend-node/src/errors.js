// Errors that the HTTP layer turns into a response.
export class HttpError extends Error {
  constructor(status, detail, headers = {}) {
    super(typeof detail === "string" ? detail : "Validation error");
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

export function fail(status, detail, headers) {
  throw new HttpError(status, detail, headers);
}
