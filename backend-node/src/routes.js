import { Router } from "./http/router.js";
import { boolean, integer, list, oneOf, optional, optionalText, shape, text } from "./http/validate.js";
import { createEvent, getEvent, updateEvent } from "./domain/events.js";
import { createDistance, deleteDistance, listDistances, updateDistance } from "./domain/distances.js";
import {
  addParticipant,
  deleteParticipant,
  importParticipants,
  listParticipants,
  updateParticipant,
} from "./domain/participants.js";
import {
  deleteResults,
  distanceDetail,
  leaderboard,
  participantState,
  replaceResults,
  saveResults,
} from "./domain/results.js";
import { getProperties, getPublicProperties, updateProperties } from "./domain/properties.js";

// ── Schemas ──────────────────────────────────────────────────────────────────
const shotsCount = integer({ min: 1, max: 300 });
const EventCreate = shape({
  code: text({
    min: 1,
    max: 16,
    upper: true,
    pattern: /^[A-Z0-9]+$/,
    message: "Code must be 1-16 uppercase alphanumeric characters",
  }),
  shots_count: optional(shotsCount, 30),
});
const EventUpdate = shape({
  status: optional(oneOf("created", "started", "finished")),
  shots_count: optional(shotsCount),
});
const DistanceCreate = shape({ title: text({ min: 1, max: 60 }), shots_count: optional(shotsCount, 30) });
const DistanceUpdate = shape({
  title: optionalText(60),
  shots_count: optional(shotsCount),
  status: optional(oneOf("pending", "active", "finished")),
});
const Participant = shape({
  name: text({ min: 1, max: 120 }),
  lane_number: integer({ min: 1, max: 999 }),
  shift: text({ min: 1, max: 4, upper: true }),
  gender: optionalText(60),
  age_category: optionalText(60),
  shooting_type: optionalText(60),
  group_type: optionalText(60),
  personal_number: optionalText(32),
});
const Import = shape({ csv_content: text({ min: 1, max: 500_000, trim: false }) });
const Login = shape({
  password: optional(text({ max: 64, trim: false })),
  session_id: optional(text({ max: 128, trim: false })),
});

const shotFields = {
  shot_number: integer({ min: 1, max: 300 }),
  score: integer({ min: 0, max: 10 }),
  is_x: optional(boolean(), false),
};
const checkX = (shot, path, errors) => {
  if (shot.is_x && shot.score !== 10) errors.push({ loc: path, msg: "An X must have a score of 10" });
};
const Shot = shape(shotFields, checkX);
const ResultCreate = shape(
  { participant_id: integer({ min: 1 }), distance_id: integer({ min: 1 }), ...shotFields },
  checkX,
);
const Replace = shape({ shots: list(Shot, { max: 300 }) }, (value, path, errors) => {
  if (new Set(value.shots.map((shot) => shot.shot_number)).size !== value.shots.length)
    errors.push({ loc: path, msg: "Each shot may only appear once" });
});

const Empty = shape({});
const ResetStatus = shape({ request_id: text({ min: 1, max: 128, trim: false }) });

const hostPassword = text({ min: 12, max: 64 });
const viewerPassword = {
  parse: (value, path, errors) => (value === "" ? "" : text({ min: 12, max: 64 }).parse(value, path, errors)),
};
const Properties = shape({
  host_password: optional(hostPassword),
  viewer_password: optional(viewerPassword),
  client_allow_add_participant: optional(boolean()),
  lane_count: optional(integer({ min: 1, max: 999 })),
});

// The names of the path parameters that are numbers, and their limits.
export const numberParams = {
  participant_id: { min: 1 },
  distance_id: { min: 1 },
  lane_number: { min: 1, max: 999 },
};

// ── Routes ───────────────────────────────────────────────────────────────────
// A route has these options:
//   auth    "host": the request needs a host session. "optional": the handler
//           reads the session. "none": the route is public.
//   body    A schema for the JSON body.
//   limit   The largest body, in bytes. The default is the global limit.
//   query   The numbers in the query string, with their limits.
//   handler `async (context)`. The result is the JSON answer. A handler that
//           changes data does it in one synchronous transaction.
export function buildRoutes({ pool, hasher, sessions, resets, creations, config, version }) {
  const router = new Router();
  const add = (method, pattern, options) => router.add(method, pattern, { auth: "none", ...options });
  const host = (options) => ({ auth: "host", ...options });

  add("GET", "/api/health", { handler: () => ({ status: "ok", service: "shooting-scoring", version }) });

  // Events
  add("POST", "/api/events/create", {
    body: EventCreate,
    handler: async ({ body, address }) => {
      const release = creations.take(address, "Too many events created. Try again later.");
      try {
        return await createEvent({ pool, hasher, sessionDays: config.sessionDays }, body);
      } catch (error) {
        release();
        throw error;
      }
    },
  });
  add("GET", "/api/events/:code", { handler: ({ db }) => getEvent(db) });
  add("PATCH", "/api/events/:code", host({ body: EventUpdate, handler: ({ db, body }) => updateEvent(db, body) }));

  // Distances
  add("GET", "/api/distances/:code", { handler: ({ db }) => listDistances(db) });
  add("POST", "/api/distances/:code", host({ body: DistanceCreate, handler: ({ db, body }) => createDistance(db, body) }));
  add(
    "PATCH",
    "/api/distances/:code/:distance_id",
    host({ body: DistanceUpdate, handler: ({ db, params, body }) => updateDistance(db, params.distance_id, body) }),
  );
  add(
    "DELETE",
    "/api/distances/:code/:distance_id",
    host({ handler: ({ db, params }) => deleteDistance(db, params.distance_id) }),
  );

  // Participants
  add("GET", "/api/participants/:code", {
    query: { lane_number: { min: 1, max: 999 } },
    handler: ({ db, query }) => listParticipants(db, query.lane_number),
  });
  add("POST", "/api/participants/:code", {
    auth: "optional",
    body: Participant,
    handler: ({ db, auth, token, body }) => addParticipant(db, auth, token, body),
  });
  add(
    "POST",
    "/api/participants/:code/import",
    host({ body: Import, limit: config.importBodyBytes, handler: ({ db, body }) => importParticipants(db, body.csv_content) }),
  );
  add(
    "PUT",
    "/api/participants/:code/:participant_id",
    host({ body: Participant, handler: ({ db, params, body }) => updateParticipant(db, params.participant_id, body) }),
  );
  add(
    "DELETE",
    "/api/participants/:code/:participant_id",
    host({ handler: ({ db, params }) => deleteParticipant(db, params.participant_id) }),
  );

  // Results
  add("POST", "/api/results/:code", {
    auth: "optional",
    body: list(ResultCreate),
    handler: ({ db, auth, token, body }) => saveResults(db, auth, token, body),
  });
  add("GET", "/api/results/:code/leaderboard", { handler: ({ db }) => leaderboard(db) });
  add("GET", "/api/results/:code/state/:participant_id", {
    handler: ({ db, params }) => participantState(db, params.participant_id),
  });
  add("GET", "/api/results/:code/detail/:participant_id/:distance_id", {
    handler: ({ db, params }) => distanceDetail(db, params.participant_id, params.distance_id),
  });
  add("PUT", "/api/results/:code/participant/:participant_id/distance/:distance_id", {
    auth: "optional",
    body: Replace,
    handler: ({ db, auth, token, params, body }) =>
      replaceResults(db, auth, token, params.participant_id, params.distance_id, body.shots),
  });
  add(
    "DELETE",
    "/api/results/:code/:participant_id",
    host({ handler: ({ db, params }) => deleteResults(db, params.participant_id) }),
  );

  // Settings
  add("GET", "/api/properties/:code/public", { handler: ({ db }) => getPublicProperties(db) });
  add("GET", "/api/properties/:code", host({ handler: ({ db }) => getProperties(db) }));
  add(
    "PATCH",
    "/api/properties/:code",
    host({
      body: Properties,
      handler: async ({ db, auth, body }) => {
        const hashes = {};
        for (const role of ["host", "viewer"]) {
          const value = body[`${role}_password`];
          if (value) hashes[role] = await hasher.hash(value);
        }
        return updateProperties(db, sessions, body, hashes, auth.tokenHash);
      },
    }),
  );

  // Sessions
  add("POST", "/api/sessions/:code/host", {
    body: Login,
    emptyBody: {},
    handler: ({ db, body, address }) => sessions.login(db, "host", body, address),
  });
  add("POST", "/api/sessions/:code/viewer", {
    body: Login,
    emptyBody: {},
    handler: ({ db, body, address }) => sessions.login(db, "viewer", body, address),
  });
  add("POST", "/api/sessions/:code/lane/:lane_number", {
    body: Login,
    emptyBody: {},
    handler: ({ db, params, body, address }) => sessions.loginLane(db, params.lane_number, body, address),
  });
  add(
    "GET",
    "/api/sessions/:code/lanes",
    host({ handler: ({ db }) => ({ ...sessions.listLanes(db), requests: resets.pending(db) }) }),
  );
  add(
    "DELETE",
    "/api/sessions/:code/lane/:lane_number",
    host({
      handler: ({ db, params }) => {
        const answer = sessions.resetLane(db, params.lane_number);
        resets.clear(db.code, params.lane_number);
        return answer;
      },
    }),
  );

  // A lane that lost its password asks the host for a reset.
  add("POST", "/api/sessions/:code/lane/:lane_number/reset-request", {
    body: Empty,
    emptyBody: {},
    handler: ({ db, params, address }) => resets.request(db, params.lane_number, address),
  });
  add("POST", "/api/sessions/:code/lane/:lane_number/reset-request/status", {
    body: ResetStatus,
    handler: ({ db, params, body }) => resets.status(db, params.lane_number, body.request_id),
  });
  add(
    "POST",
    "/api/sessions/:code/lane/:lane_number/reset-request/approve",
    host({ handler: ({ db, params }) => resets.approve(db, params.lane_number) }),
  );
  add(
    "POST",
    "/api/sessions/:code/lane/:lane_number/reset-request/deny",
    host({ handler: ({ db, params }) => resets.deny(db, params.lane_number) }),
  );

  return router;
}
