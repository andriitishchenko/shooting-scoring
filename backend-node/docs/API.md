# API reference

This document describes the HTTP API and the WebSocket protocol of the
Node.js server. The browser pages in `frontend` use this API.

## Rules for all requests

- The base path is `/api`. The server sends and reads JSON in UTF-8.
- An event code has 1 to 16 characters: letters `A` to `Z` and digits.
  `POST /api/events/create` trims the code and changes it to uppercase.
  All other routes need an uppercase code. A lowercase code gets status `422`.
- A session is a token. Send the token in the header `X-Session-Id`.
- A path parameter that is a number must be a whole number of 1 or more.
  A lane number is from 1 to 999.
- The server ignores unknown fields in a request body.
- The default limit for a request body is 256 KiB. The limit for the
  participant import is 2 MiB.

## Answers and errors

A successful answer has status `200` and a JSON body.

An error answer has this body:

```json
{ "detail": "Event not found" }
```

For status `422`, `detail` is a list. Each item says which field is wrong:

```json
{ "detail": [{ "loc": ["body", "shots_count"], "msg": "Input should be a valid integer" }] }
```

| Status | Meaning |
| --- | --- |
| `400` | The body is not valid JSON. The event code exists. The CSV file is not valid. |
| `401` | The session is missing, not valid, or ended. |
| `403` | A rule of the competition does not allow the change. |
| `404` | The event, the participant, or the distance does not exist. |
| `405` | The path does not support this method. The header `Allow` lists the methods. |
| `409` | The lane was reset during the request. Try again. |
| `413` | The request body is too large. |
| `422` | A value is not valid. |
| `429` | A limit is reached. The header `Retry-After` gives the seconds to wait. |
| `500` | An error in the server. The server writes the details to the log. |
| `503` | The server is busy: too many password checks wait (`HASH_QUEUE`). The header `Retry-After` gives the seconds to wait. The failed attempt does not count against the account. |

The order of the checks is: path and body values (`422`), event (`404`),
session (`401`), rules (`403`).

## Sessions and roles

| Role | How to get a session | Allowed actions |
| --- | --- | --- |
| host | `POST /api/events/create` or `POST /api/sessions/{code}/host` | All changes in the event |
| lane | `POST /api/sessions/{code}/lane/{n}` | Add participants and write scores for lane `n` |
| viewer | `POST /api/sessions/{code}/viewer` | No route needs it. The viewer page uses it for live updates. |

- A login does not end the other sessions of the same role. A role or a lane
  keeps its 20 newest sessions. The viewer role keeps 5000.
- A session ends after 14 days (`SESSION_DAYS`). A login with a valid saved
  session renews it.
- A new host password ends the other host sessions. A new viewer password ends
  all viewer sessions. A lane reset ends all sessions of that lane.
- The server keeps only hashes of passwords and sessions.

## Health

### `GET /api/health`

```json
{ "status": "ok", "service": "shooting-scoring", "version": "4.0.0" }
```

## Events

### `POST /api/events/create`

Request: `{ "code": "ABC123", "shots_count": 30 }`. `shots_count` is from 1 to
300 and is 30 when missing.

Answer:

```json
{ "message": "Event created", "code": "ABC123", "host_password": "7F2K9QX1M4B8WZ3C", "session_id": "…" }
```

The host password appears only in this answer. The event gets one distance
named `Distance 1`. Status `400` means that the code exists. Status `429` means
that the address created too many events (`EVENT_CREATE_LIMIT`).

### `GET /api/events/{code}`

```json
{
  "code": "ABC123", "shots_count": 30, "status": "created",
  "created_at": "2026-10-18T09:00:00.000Z", "started_at": null, "finished_at": null
}
```

### `PATCH /api/events/{code}` (host)

Request: `{ "status": "started", "shots_count": 36 }`. Both fields are optional.
The status changes in one direction: `created`, `started`, `finished`. Another
change gets status `403`. When the event finishes, the active distance
finishes too. Answer: `{ "message": "Event updated" }`.

## Distances

A distance has the status `pending`, `active`, or `finished`.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/distances/{code}` | none | List of `{ id, title, shots_count, sort_order, status }` |
| `POST /api/distances/{code}` | host | Add a distance. Body: `{ "title", "shots_count" }` |
| `PATCH /api/distances/{code}/{id}` | host | Change `title`, `shots_count`, or `status` |
| `DELETE /api/distances/{code}/{id}` | host | Delete a pending distance |

Rules:

- A title has 1 to 60 characters after trimming.
- A change in a finished event gets status `403`.
- `status: "active"` needs a started event. It finishes the other active
  distance. A finished distance does not become active again.
- A started distance does not become `pending` again. Only an active distance
  can become `finished`.
- A request can change the title or the shot count of a pending distance only.
- The last distance and a distance that is not pending cannot be deleted.

## Participants

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/participants/{code}` | none | List. Optional query `lane_number`. |
| `POST /api/participants/{code}` | host, or the lane of the participant | Add a participant |
| `POST /api/participants/{code}/import` | host | Add participants from CSV |
| `PUT /api/participants/{code}/{id}` | host | Replace the data of a participant |
| `DELETE /api/participants/{code}/{id}` | host | Delete a participant and the results |

A participant has these fields:

| Field | Rule |
| --- | --- |
| `name` | Required. 1 to 120 characters after trimming. |
| `lane_number` | Required. A whole number from 1 to 999. |
| `shift` | Required. 1 to 4 characters. The server changes it to uppercase. |
| `gender`, `age_category`, `shooting_type`, `group_type` | Optional. The server cuts the text to 60 characters. An empty text becomes `null`. |
| `personal_number` | Optional. The server cuts the text to 32 characters. |

The list is sorted by lane, shift, and id.

Rules:

- Changes are possible only when the event status is `created`.
- A lane can add a participant to its own lane only. The host can turn this off
  with `client_allow_add_participant: false`. Then the lane gets status `403`.

### Import

Request: `{ "csv_content": "name,lane,shift\nAnna,1,A\n" }`. The text has at most
500 000 characters and 500 rows. The first row has the column names. The
columns `name`, `lane`, and `shift` are required. The columns `gender`,
`age_category`, `shooting_type`, `group`, and `personal_number` are optional. A
field in quotes can have commas, line breaks, and quotes (written twice).
An event can have at most 3000 participants. A request that goes over the limit
gets status `403`. The same limit applies to a lane that adds a participant.

```json
{ "added": 2, "failed": 1, "errors": ["Row 3: lane must be from 1 to 999, got '0'"] }
```

A row with an error does not stop the import. `errors` has at most 50 items.

## Results

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/results/{code}/leaderboard` | none | Scores in groups |
| `GET /api/results/{code}/state/{participant_id}` | none | All distances of one participant |
| `GET /api/results/{code}/detail/{participant_id}/{distance_id}` | none | Series of one distance |
| `PUT /api/results/{code}/participant/{participant_id}/distance/{distance_id}` | host, or the lane of the participant | Replace all shots of the distance |
| `POST /api/results/{code}` | host, or the lane of the participant | Add or change shots |
| `DELETE /api/results/{code}/{participant_id}` | host | Delete all results of a participant |

A shot is `{ "shot_number": 1, "score": 10, "is_x": true }`. `shot_number` is
from 1 to 300 and must not be above the size of the distance. `score` is from 0
to 10. `is_x` is `false` when missing. An X needs `score` 10.

### Replace

Body: `{ "shots": [ … ] }`, at most 300 shots, each `shot_number` one time. The
server deletes the shots that are not in the list. An empty list clears the
distance. Answer: `{ "message": "Results replaced", "count": 3 }`.

### Add or change

Body: a list of shots. Each shot also has `participant_id` and `distance_id`.
All shots must have the same participant and distance. The server does not
delete other shots. An empty list gets status `422`. Answer:
`{ "message": "Results saved", "count": 3 }`.

### Who can write

- The distance must be `active` or `finished`.
- While the event is `started`, a lane can write to `active` and `finished`
  distances of its own participants. `POST` needs a started event.
- After the event finishes, only the host can write. The host can also add
  shots with `POST` after the event finished.
- A lane cannot write to a participant of another lane (status `401`).

### State

```json
{
  "distances": [{
    "distance_id": 1, "title": "Distance 1", "shots_count": 30, "status": "active",
    "total_score": 19, "x_count": 1, "shots_taken": 1,
    "shots": [{ "shot": 1, "score": 10, "is_x": true }]
  }]
}
```

`total_score` is `null` when the distance has no shots. `shots_taken` is the
number of shots that are entered. `shots` is empty for a finished distance, but
`shots_taken` has the count.

### Detail

`total_score`, `x_count`, `ten_count`, `avg_score`, and a list `series`. A series
has 3 shots. The last series can have fewer. A shot without a score has
`score: null`.

### Leaderboard

An object. Each key is `{gender}_{shooting_type}`, for example `female_recurve`.
`unknown` replaces an empty gender or shooting type. A value is a list of
participants that have at least one shot:

```json
{
  "id": 1, "name": "Anna", "lane_shift": "1A", "gender": "female", "shooting_type": "recurve",
  "group_type": "unknown", "age_category": "unknown", "total_score": 19, "x_count": 1, "ten_count": 1,
  "avg_score": 9.5,
  "distance_scores": [{ "distance_id": 1, "title": "Distance 1", "score": 19, "shots_count": 30, "shots_taken": 2 }]
}
```

`distance_scores` has the distances that are not pending. Each group is in
ranking order: more points first, then more 10s (an X is a 10), then more X.
Participants that are equal in all three values keep the order of their `id`.
The browser pages give equal participants the same rank (1, 1, 3). The server
keeps the answer in memory until the data changes.

## Settings

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/properties/{code}` | host | Settings. Never a password. |
| `PATCH /api/properties/{code}` | host | Change settings |
| `GET /api/properties/{code}/public` | none | `{ "client_allow_add_participant": true, "lane_count": 28 }` |

`GET` answer:

```json
{ "host_password_configured": true, "viewer_password_configured": false, "client_allow_add_participant": true, "lane_count": 28 }
```

`PATCH` body (all fields are optional):

| Field | Rule |
| --- | --- |
| `host_password` | 12 to 64 characters. The host password cannot be empty. |
| `viewer_password` | 12 to 64 characters. An empty text removes the password and makes the leaderboard public. |
| `client_allow_add_participant` | `true` or `false` |
| `lane_count` | Integer from 1 to 999. The default is 28. |

## Logins

All login routes accept `{ "password": "…", "session_id": "…" }`. Both fields
are optional. A valid saved `session_id` gives the same session again and
renews it. Without it, the route checks the password.

### `POST /api/sessions/{code}/host`

Answer: `{ "ok": true, "session_id": "…" }`. A wrong password gets status `401`.

### `POST /api/sessions/{code}/viewer`

Answer: `{ "ok": true, "has_password": false, "session_id": "…" }`. A viewer needs
no password until the host sets one.

### `POST /api/sessions/{code}/lane/{lane_number}`

| Situation | Answer |
| --- | --- |
| The lane is new | `{ "status": "created", "session_id": "…", "password": "A1B2C3", "lane_number": 3 }` |
| A valid saved session of this lane | `{ "status": "ok", "session_id": "…", "lane_number": 3 }` |
| The lane exists and no password was sent | `{ "status": "password_required", "lane_number": 3 }` |
| The password is correct | `{ "status": "ok", "session_id": "…", "lane_number": 3 }` (a new session) |
| The password is wrong | Status `401`, `"Invalid lane password"` |

The password of a lane has 6 characters (letters and digits). The server
accepts it in any case. The password appears only in the `created` answer.

### Password reset request

A lane that has a password can lose it. The lane asks the host for a reset. The
host approves or denies. After an approval, the device that asked gets a new
password and a new session, like on the first entry to a lane. The server keeps
the requests in memory. A request, and a result that nobody collected, end after
15 minutes (`LANE_RESET_MINUTES`) and when the server restarts.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/sessions/{code}/lane/{n}/reset-request` | none | Ask for a reset |
| `POST /api/sessions/{code}/lane/{n}/reset-request/status` | request id | Ask for the result |
| `POST /api/sessions/{code}/lane/{n}/reset-request/approve` | host | Approve |
| `POST /api/sessions/{code}/lane/{n}/reset-request/deny` | host | Deny |

`reset-request` answers `{ "request_id": "…", "status": "pending" }`. The request
id is a secret of 256 bits. Only the device that asked has it. A new request for
the same lane replaces the old one. Status `409` means that the lane has no
password yet (open the lane instead). Each request counts like a failed login:
10 requests in 15 minutes for one lane and one address give status `429`.

`status` takes `{ "request_id": "…" }` and answers one of these:

| Answer | Meaning |
| --- | --- |
| `{ "status": "pending" }` | The host did not decide yet. |
| `{ "status": "approved", "session_id": "…", "password": "A1B2C3", "lane_number": 3 }` | The host approved. The answer comes one time. |
| `{ "status": "denied" }` | The host denied. The answer comes one time. |
| `{ "status": "expired" }` | The id is not known, the request ended, or the answer was already given. |

`approve` creates the new password and a session for the device that asked. It
ends all other sessions of the lane and closes their sockets. It sends
`lane_session_reset` and `refresh`. `deny` changes nothing for the lane and sends
`refresh`. Both answer status `404` when no request waits. A reset by the host
(`DELETE …/lane/{n}`) removes a request that waits.

### `GET /api/sessions/{code}/lanes` (host)

The lanes that have a password and the passwords:

```json
{
  "lanes": [1, 5],
  "passwords": { "1": "A1B2C3", "5": "Z9Y8X7" },
  "requests": { "5": "2026-10-18T10:15:00.000Z" }
}
```

The host page shows the password next to the lane. `requests` has the lanes that
ask for a reset, with the time of the request.

### `DELETE /api/sessions/{code}/lane/{lane_number}` (host)

Deletes the password and all sessions of the lane. The server sends the message
`lane_session_reset` and closes the sockets of the lane. The next login of this
lane gets a new password. Answer: `{ "message": "Session for lane 3 reset" }`.

### Limits for failed logins

- One account (host, viewer, or one lane) and one address can fail 10 times in
  15 minutes. Then the server answers `429` for 15 minutes.
  An account belongs to one event. The failures in one event do not lock the
  same account in another event.
- One address can fail `LOGIN_FAILURE_LIMIT` times (default 100) in 15 minutes
  for all accounts together.
- The server counts an attempt before it checks the password. A correct password
  removes the count.
- A login with a valid saved session is not limited.
- Behind a reverse proxy, set `TRUSTED_PROXIES`. Then the server uses the
  address from `X-Forwarded-For`.

## WebSocket

Connect to `/ws/{code}`. The first message from the client must be:

```json
{ "type": "authenticate", "session_id": "…" }
```

The server answers `{ "type": "authenticated", "role": "host" }`. The server
does not read other messages from the client. Limits: the first message has
at most 4096 bytes and must arrive in 10 seconds.

| Close code | Meaning |
| --- | --- |
| `1008` | The session is not valid, or the message is wrong. Do not connect again with this session. |
| `4002` | The first message did not arrive in 10 seconds. Connect again. |
| `1009` | The message is too large. |
| `1011` | An error in the server. Connect again later. |
| `1001` | The server stops. Connect again later. |
| `4001` | The session ended, for example after a lane reset or a password change. |

The server sends a ping every 30 seconds and closes a connection that does not
answer. The server answers `503` to a new connection when `MAX_SOCKETS` is
reached. All sockets count, also those that did not authenticate yet.

The server sends these messages to all sockets of the event, after the change
is saved:

| `type` | Fields | When |
| --- | --- | --- |
| `event_status` | `status` | A request changes the event status |
| `distance_update` | `distance_id`, `status` | A request changes the status of a distance |
| `refresh` | none | Distances, participants, settings, or the shot count change |
| `result_update` | `participant_id`, `total_score` | Results of a participant change |
| `lane_session_reset` | `lane_number` | The host resets a lane, or approves a reset request. This message comes before the close code `4001`. |
| `lane_reset_requested` | `lane_number` | A lane asks for a password reset |
