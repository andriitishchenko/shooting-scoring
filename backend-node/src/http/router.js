import { fail } from "../errors.js";

// Routes by method and path. A path has segments like `/api/events/:code`.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, options) {
    const segments = pattern.split("/").filter(Boolean);
    this.routes.push({ method, segments, pattern, ...options });
  }

  // Return `{ route, params }`. Status 405 when the path exists for other methods.
  match(method, pathname) {
    const parts = pathname.split("/").filter(Boolean);
    let methods = [];
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let fits = true;
      for (let index = 0; index < parts.length && fits; index++) {
        const expected = route.segments[index];
        if (expected.startsWith(":")) params[expected.slice(1)] = parts[index];
        else fits = expected === parts[index];
      }
      if (!fits) continue;
      if (route.method === method) return { route, params };
      methods.push(route.method);
    }
    if (methods.length) fail(405, "Method Not Allowed", { Allow: [...new Set(methods)].join(", ") });
    return null;
  }
}
