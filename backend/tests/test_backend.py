"""API regression tests for scoring, session boundaries, and event lifecycle."""

import asyncio
import os
import sqlite3
import stat
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings, settings
from app.database import DatabaseManager
from app.main import app
from app.websocket_manager import ConnectionManager


@pytest.fixture(scope="session")
def client(tmp_path_factory):
    settings.DATABASE_DIR = str(tmp_path_factory.mktemp("shooting-events"))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def event(client):
    code = "T" + uuid.uuid4().hex[:9].upper()
    response = client.post("/api/events/create", json={"code": code, "shots_count": 3})
    assert response.status_code == 200
    created = response.json()
    host_headers = {"X-Session-Id": created["session_id"]}

    participants = []
    for lane in (1, 2):
        response = client.post(
            f"/api/participants/{code}",
            headers=host_headers,
            json={"name": f"Archer {lane}", "lane_number": lane, "shift": "A"},
        )
        assert response.status_code == 200
        participants.append(response.json()["id"])

    lane_sessions = {}
    for lane in (1, 2):
        response = client.post(f"/api/sessions/{code}/lane/{lane}", json={})
        assert response.status_code == 200
        lane_sessions[lane] = {"X-Session-Id": response.json()["session_id"]}

    return {
        "code": code,
        "host": host_headers,
        "participants": participants,
        "lanes": lane_sessions,
        "distance": client.get(f"/api/distances/{code}").json()[0]["id"],
    }


def start_distance(client, event):
    code = event["code"]
    assert client.patch(
        f"/api/events/{code}", headers=event["host"], json={"status": "started"}
    ).status_code == 200
    response = client.patch(
        f"/api/distances/{code}/{event['distance']}",
        headers=event["host"],
        json={"status": "active"},
    )
    assert response.status_code == 200


def score(participant_id, distance_id, shot_number, value=10, is_x=False):
    return {
        "participant_id": participant_id,
        "distance_id": distance_id,
        "shot_number": shot_number,
        "score": value,
        "is_x": is_x,
    }


def test_health_frontend_and_invalid_event_code_return_valid_responses(client):
    assert client.get("/api/health").status_code == 200
    assert client.get("/").status_code == 200
    assert client.get("/api/events/not-a-valid-code").status_code == 422


def test_security_headers_and_cors_default_are_restrictive(client):
    response = client.get("/api/health", headers={"Origin": "https://untrusted.example"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_wildcard_cors_configuration_is_rejected():
    with pytest.raises(ValueError, match="wildcard CORS is disabled"):
        Settings(ALLOWED_ORIGINS=["*"])


def test_credentials_are_hashed_in_database_and_never_returned_by_properties(client):
    code = "S" + uuid.uuid4().hex[:9].upper()
    created = client.post("/api/events/create", json={"code": code, "shots_count": 3})
    assert created.status_code == 200
    payload = created.json()
    assert len(payload["host_password"]) == 16

    db = DatabaseManager(code)
    with sqlite3.connect(db.db_path) as conn:
        host_password = conn.execute(
            "SELECT value FROM properties WHERE key='host_password'"
        ).fetchone()[0]
        session_id, session_password = conn.execute(
            "SELECT session_id, password FROM sessions WHERE role='host'"
        ).fetchone()
    assert host_password.startswith("pbkdf2_sha256$")
    assert host_password != payload["host_password"]
    assert session_id.startswith("sha256$")
    assert session_id != payload["session_id"]
    assert session_password == host_password

    settings_response = client.get(
        f"/api/properties/{code}", headers={"X-Session-Id": payload["session_id"]}
    )
    assert settings_response.status_code == 200
    assert settings_response.json()["host_password_configured"] is True
    assert "host_password" not in settings_response.json()
    assert "viewer_password" not in settings_response.json()


def test_existing_database_directory_and_database_file_are_restricted(client):
    code = "P" + uuid.uuid4().hex[:9].upper()
    os.chmod(settings.DATABASE_DIR, 0o755)

    db = DatabaseManager(code)
    assert stat.S_IMODE(os.stat(settings.DATABASE_DIR).st_mode) == 0o700
    asyncio.run(db.init_db())
    assert stat.S_IMODE(os.stat(db.db_path).st_mode) == 0o600


def test_simultaneous_event_creation_claims_the_code_once(client):
    code = "C" + uuid.uuid4().hex[:9].upper()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                client.post,
                "/api/events/create",
                json={"code": code, "shots_count": 3},
            )
            for _ in range(2)
        ]
        responses = [future.result() for future in futures]

    assert sorted(response.status_code for response in responses) == [200, 400]
    successful = next(response.json() for response in responses if response.status_code == 200)
    login = client.post(
        f"/api/sessions/{code}/host", json={"password": successful["host_password"]}
    )
    assert login.status_code == 200


def test_failed_event_initialization_releases_its_code(client, monkeypatch):
    from app.routers import events as events_router

    code = "F" + uuid.uuid4().hex[:9].upper()
    original_hash_password = events_router.hash_password

    def fail_hash(_password):
        raise RuntimeError("simulated credential hashing failure")

    monkeypatch.setattr(events_router, "hash_password", fail_hash)
    with pytest.raises(RuntimeError, match="simulated credential hashing failure"):
        client.post("/api/events/create", json={"code": code, "shots_count": 3})

    assert not DatabaseManager(code).exists()
    monkeypatch.setattr(events_router, "hash_password", original_hash_password)
    retry = client.post("/api/events/create", json={"code": code, "shots_count": 3})
    assert retry.status_code == 200


def test_legacy_passwords_and_session_tokens_migrate_on_login(client):
    code = "L" + uuid.uuid4().hex[:9].upper()
    created = client.post("/api/events/create", json={"code": code, "shots_count": 3})
    assert created.status_code == 200
    payload = created.json()
    legacy_password = "старый-admin-пароль🔑"
    db = DatabaseManager(code)
    with sqlite3.connect(db.db_path) as conn:
        conn.execute(
            "UPDATE properties SET value=? WHERE key='host_password'", (legacy_password,)
        )
        conn.execute(
            "UPDATE sessions SET session_id=?, password=? WHERE role='host'",
            (payload["session_id"], legacy_password),
        )

    login = client.post(f"/api/sessions/{code}/host", json={"password": legacy_password})
    assert login.status_code == 200
    with sqlite3.connect(db.db_path) as conn:
        migrated_password = conn.execute(
            "SELECT value FROM properties WHERE key='host_password'"
        ).fetchone()[0]
        migrated_session = conn.execute(
            "SELECT session_id, password FROM sessions WHERE role='host'"
        ).fetchone()
    assert migrated_password.startswith("pbkdf2_sha256$")
    assert migrated_password != legacy_password
    assert migrated_session[0].startswith("sha256$")
    assert migrated_session[1] == migrated_password


def test_viewer_passwords_are_hashed_and_host_password_cannot_be_disabled(client, event):
    code = event["code"]
    password = "viewer-password-12"
    update = client.patch(
        f"/api/properties/{code}",
        headers=event["host"],
        json={"viewer_password": password},
    )
    assert update.status_code == 200

    properties = client.get(f"/api/properties/{code}", headers=event["host"])
    assert properties.status_code == 200
    assert properties.json()["viewer_password_configured"] is True
    assert "viewer_password" not in properties.json()

    db = DatabaseManager(code)
    with sqlite3.connect(db.db_path) as conn:
        viewer_password = conn.execute(
            "SELECT value FROM properties WHERE key='viewer_password'"
        ).fetchone()[0]
    assert viewer_password.startswith("pbkdf2_sha256$")
    login = client.post(f"/api/sessions/{code}/viewer", json={"password": password})
    assert login.status_code == 200
    assert login.json()["has_password"] is True

    disable_host = client.patch(
        f"/api/properties/{code}", headers=event["host"], json={"host_password": ""}
    )
    assert disable_host.status_code == 422


def test_lane_passwords_and_session_tokens_are_hashed_and_lane_range_is_validated(client, event):
    code = event["code"]
    invalid_lane = client.post(f"/api/sessions/{code}/lane/0", json={})
    assert invalid_lane.status_code == 422

    created = client.post(f"/api/sessions/{code}/lane/3", json={})
    assert created.status_code == 200
    credentials = created.json()
    assert len(credentials["password"]) == 12

    db = DatabaseManager(code)
    with sqlite3.connect(db.db_path) as conn:
        stored = conn.execute(
            "SELECT session_id, password FROM sessions WHERE role='client' AND identifier='3'"
        ).fetchone()
    assert stored[0].startswith("sha256$")
    assert stored[1].startswith("pbkdf2_sha256$")
    assert credentials["session_id"] != stored[0]
    assert credentials["password"] != stored[1]

    authenticated = client.post(
        f"/api/sessions/{code}/lane/3", json={"password": credentials["password"]}
    )
    assert authenticated.status_code == 200
    assert authenticated.json()["status"] == "ok"
    assert authenticated.json()["session_id"] != credentials["session_id"]


def test_login_attempts_are_throttled_and_valid_saved_sessions_still_work(client, event, monkeypatch):
    from app.routers import sessions as sessions_router

    monkeypatch.setattr(sessions_router, "_LOGIN_MAX_FAILURES", 2)
    code = event["code"]
    for _ in range(2):
        failure = client.post(f"/api/sessions/{code}/host", json={"password": "wrong"})
        assert failure.status_code == 401

    throttled = client.post(f"/api/sessions/{code}/host", json={"password": "wrong"})
    assert throttled.status_code == 429
    assert int(throttled.headers["retry-after"]) > 0

    # A previously authenticated browser session does not need password login.
    saved_session = client.post(
        f"/api/sessions/{code}/host",
        json={"session_id": event["host"]["X-Session-Id"]},
    )
    assert saved_session.status_code == 200


def test_host_endpoints_require_a_valid_session(client, event):
    code = event["code"]
    assert client.patch(f"/api/events/{code}", json={"status": "started"}).status_code == 401
    assert client.get(f"/api/properties/{code}").status_code == 401
    assert client.get(f"/api/sessions/{code}/lanes").status_code == 401


def test_empty_result_batch_is_rejected(client, event):
    response = client.post(f"/api/results/{event['code']}", json=[])
    assert response.status_code == 422
    assert response.json()["detail"] == "At least one result is required"


def test_lane_cannot_write_for_another_lane_or_bypass_auth_with_a_missing_id(client, event):
    start_distance(client, event)
    code, distance_id = event["code"], event["distance"]
    own_pid, other_pid = event["participants"]
    lane_one = event["lanes"][1]

    response = client.post(
        f"/api/results/{code}",
        headers=lane_one,
        json=[score(other_pid, distance_id, 1)],
    )
    assert response.status_code == 401

    response = client.post(
        f"/api/results/{code}",
        headers={"X-Session-Id": "invalid"},
        json=[score(999999, distance_id, 1), score(other_pid, distance_id, 2, 9)],
    )
    assert response.status_code in (401, 404, 422)

    response = client.post(
        f"/api/results/{code}",
        headers=lane_one,
        json=[score(own_pid, distance_id, 1), score(other_pid, distance_id, 2, 9)],
    )
    assert response.status_code == 422
    state = client.get(f"/api/results/{code}/state/{other_pid}").json()
    assert state["distances"][0]["total_score"] is None


def test_shot_limits_and_x_values_are_validated(client, event):
    start_distance(client, event)
    code, pid, did = event["code"], event["participants"][0], event["distance"]
    lane = event["lanes"][1]

    response = client.post(f"/api/results/{code}", headers=lane, json=[score(pid, did, 4)])
    assert response.status_code == 422
    response = client.post(f"/api/results/{code}", headers=lane, json=[score(pid, did, 1, 8, True)])
    assert response.status_code == 422


def test_replacing_shots_persists_deletions_and_allows_clearing_the_series(client, event):
    start_distance(client, event)
    code, pid, did = event["code"], event["participants"][0], event["distance"]
    lane = event["lanes"][1]
    endpoint = f"/api/results/{code}/participant/{pid}/distance/{did}"

    complete = {"shots": [
        {"shot_number": 1, "score": 10},
        {"shot_number": 2, "score": 9},
        {"shot_number": 3, "score": 8},
    ]}
    assert client.put(endpoint, headers=lane, json=complete).status_code == 200

    response = client.put(endpoint, json={"shots": complete["shots"][:2]})
    assert response.status_code == 401
    response = client.put(endpoint, headers=lane, json={"shots": complete["shots"][:2]})
    assert response.status_code == 200
    state = client.get(f"/api/results/{code}/state/{pid}").json()["distances"][0]
    assert state["total_score"] == 19
    assert [shot["shot"] for shot in state["shots"]] == [1, 2]

    response = client.put(endpoint, headers=lane, json={"shots": []})
    assert response.status_code == 200
    state = client.get(f"/api/results/{code}/state/{pid}").json()["distances"][0]
    assert state["total_score"] is None
    assert state["shots"] == []


def test_lane_replacement_is_limited_to_its_participant_and_started_distances(client, event):
    code = event["code"]
    pending = client.post(
        f"/api/distances/{code}",
        headers=event["host"],
        json={"title": "Later distance", "shots_count": 3},
    )
    assert pending.status_code == 200
    pending_distance_id = pending.json()["id"]
    start_distance(client, event)

    lane_one = event["lanes"][1]
    own_participant, other_participant = event["participants"]
    other_lane_response = client.put(
        f"/api/results/{code}/participant/{other_participant}/distance/{event['distance']}",
        headers=lane_one,
        json={"shots": [{"shot_number": 1, "score": 9}]},
    )
    pending_distance_response = client.put(
        f"/api/results/{code}/participant/{own_participant}/distance/{pending_distance_id}",
        headers=lane_one,
        json={"shots": [{"shot_number": 1, "score": 9}]},
    )

    assert other_lane_response.status_code == 401
    assert pending_distance_response.status_code == 403
    for participant_id in (own_participant, other_participant):
        state = client.get(f"/api/results/{code}/state/{participant_id}").json()
        assert all(distance["total_score"] is None for distance in state["distances"])


def test_leaderboard_returns_scored_participants(client, event):
    start_distance(client, event)
    code, pid, did = event["code"], event["participants"][0], event["distance"]
    assert client.post(
        f"/api/results/{code}",
        headers=event["lanes"][1],
        json=[score(pid, did, 1, 9)],
    ).status_code == 200

    response = client.get(f"/api/results/{code}/leaderboard")
    assert response.status_code == 200
    entries = [entry for group in response.json().values() for entry in group]
    assert any(entry["id"] == pid and entry["total_score"] == 9 for entry in entries)


def test_participant_state_rejects_unknown_participant(client, event):
    response = client.get(f"/api/results/{event['code']}/state/999999")
    assert response.status_code == 404


def test_admin_can_correct_scores_in_detail_api_after_event_finishes(client, event):
    start_distance(client, event)
    code, pid, did = event["code"], event["participants"][0], event["distance"]
    assert client.post(
        f"/api/results/{code}",
        headers=event["lanes"][1],
        json=[score(pid, did, 1)],
    ).status_code == 200
    assert client.patch(
        f"/api/events/{code}", headers=event["host"], json={"status": "finished"}
    ).status_code == 200

    endpoint = f"/api/results/{code}/participant/{pid}/distance/{did}"
    assert client.put(endpoint, headers=event["lanes"][1], json={"shots": []}).status_code == 403
    corrected = [{"shot_number": 1, "score": 9}]
    assert client.put(endpoint, headers=event["host"], json={"shots": corrected}).status_code == 200
    detail = client.get(f"/api/results/{code}/detail/{pid}/{did}").json()
    assert detail["total_score"] == 9
    assert client.patch(
        f"/api/events/{code}", headers=event["host"], json={"status": "started"}
    ).status_code == 403


def test_host_can_post_a_missed_result_after_event_finishes(client, event):
    start_distance(client, event)
    code, participant_id, distance_id = (
        event["code"], event["participants"][0], event["distance"]
    )
    assert client.patch(
        f"/api/events/{code}", headers=event["host"], json={"status": "finished"}
    ).status_code == 200

    host_response = client.post(
        f"/api/results/{code}",
        headers=event["host"],
        json=[score(participant_id, distance_id, 1, 8)],
    )
    lane_response = client.post(
        f"/api/results/{code}",
        headers=event["lanes"][1],
        json=[score(participant_id, distance_id, 2, 7)],
    )

    assert host_response.status_code == 200
    assert lane_response.status_code == 403
    state = client.get(f"/api/results/{code}/state/{participant_id}").json()
    assert state["distances"][0]["total_score"] == 8


def test_participants_cannot_be_changed_after_event_starts(client, event):
    start_distance(client, event)
    code = event["code"]
    response = client.post(
        f"/api/participants/{code}",
        headers=event["lanes"][1],
        json={"name": "Late entry", "lane_number": 1, "shift": "B"},
    )
    assert response.status_code == 403
    response = client.delete(
        f"/api/participants/{code}/{event['participants'][0]}", headers=event["host"]
    )
    assert response.status_code == 403


def test_distance_state_cannot_be_rewound(client, event):
    start_distance(client, event)
    code, did = event["code"], event["distance"]
    assert client.patch(
        f"/api/distances/{code}/{did}", headers=event["host"], json={"status": "finished"}
    ).status_code == 200
    response = client.patch(
        f"/api/distances/{code}/{did}", headers=event["host"], json={"status": "pending"}
    )
    assert response.status_code == 403


def test_pending_distances_cannot_be_changed_after_event_finishes(client, event):
    code = event["code"]
    added = client.post(
        f"/api/distances/{code}",
        headers=event["host"],
        json={"title": "Final distance", "shots_count": 3},
    )
    assert added.status_code == 200
    pending_distance_id = added.json()["id"]

    start_distance(client, event)
    assert client.patch(
        f"/api/events/{code}", headers=event["host"], json={"status": "finished"}
    ).status_code == 200

    update = client.patch(
        f"/api/distances/{code}/{pending_distance_id}",
        headers=event["host"],
        json={"title": "Changed after finish"},
    )
    assert update.status_code == 403
    delete = client.delete(
        f"/api/distances/{code}/{pending_distance_id}", headers=event["host"]
    )
    assert delete.status_code == 403


def test_websocket_authentication_and_server_owned_notifications(client, event):
    code = event["code"]
    with client.websocket_connect(f"/ws/{code}") as socket:
        socket.send_json({"type": "authenticate", "session_id": "forged"})
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()

    with client.websocket_connect(f"/ws/{code}") as socket:
        socket.send_json({
            "type": "authenticate",
            "session_id": event["host"]["X-Session-Id"],
        })
        assert socket.receive_json() == {"type": "authenticated", "role": "host"}
        response = client.patch(
            f"/api/events/{code}", headers=event["host"], json={"status": "started"}
        )
        assert response.status_code == 200
        assert socket.receive_json() == {"type": "event_status", "status": "started"}


def test_result_mutations_broadcast_current_participant_total(client, event):
    start_distance(client, event)
    code, participant_id, distance_id = (
        event["code"], event["participants"][0], event["distance"]
    )
    endpoint = f"/api/results/{code}/participant/{participant_id}/distance/{distance_id}"

    with client.websocket_connect(f"/ws/{code}") as socket:
        socket.send_json({
            "type": "authenticate",
            "session_id": event["host"]["X-Session-Id"],
        })
        assert socket.receive_json() == {"type": "authenticated", "role": "host"}

        saved = client.post(
            f"/api/results/{code}",
            headers=event["lanes"][1],
            json=[score(participant_id, distance_id, 1, 10)],
        )
        assert saved.status_code == 200
        assert socket.receive_json() == {
            "type": "result_update", "participant_id": participant_id, "total_score": 10
        }

        replaced = client.put(
            endpoint,
            headers=event["host"],
            json={"shots": [{"shot_number": 1, "score": 9}]},
        )
        assert replaced.status_code == 200
        assert socket.receive_json() == {
            "type": "result_update", "participant_id": participant_id, "total_score": 9
        }

        deleted = client.delete(
            f"/api/results/{code}/{participant_id}", headers=event["host"]
        )
        assert deleted.status_code == 200
        assert socket.receive_json() == {
            "type": "result_update", "participant_id": participant_id, "total_score": 0
        }


def test_notifications_reach_connections_on_separate_workers(event):
    class Socket:
        def __init__(self):
            self.messages = []

        async def send_json(self, message):
            self.messages.append(message)

    async def exercise():
        code = event["code"]
        first_worker, second_worker = ConnectionManager(), ConnectionManager()
        first_socket, second_socket = Socket(), Socket()
        await first_worker.connect(first_socket, code)
        await second_worker.connect(second_socket, code)

        payload = {"type": "refresh"}
        await first_worker.broadcast(code, payload)
        for _ in range(30):
            if first_socket.messages and second_socket.messages:
                break
            await asyncio.sleep(0.05)

        assert first_socket.messages == [payload]
        assert second_socket.messages == [payload]
        first_worker.disconnect(first_socket, code)
        second_worker.disconnect(second_socket, code)
        await asyncio.sleep(0)

    asyncio.run(exercise())


def test_simultaneous_connections_in_one_worker_all_receive_updates(event):
    class Socket:
        def __init__(self):
            self.messages = []

        async def send_json(self, message):
            self.messages.append(message)

    async def exercise():
        code = event["code"]
        worker = ConnectionManager()
        sockets = [Socket(), Socket(), Socket()]
        await asyncio.gather(*(worker.connect(socket, code) for socket in sockets))
        payload = {"type": "refresh"}
        await worker.broadcast(code, payload)
        for _ in range(30):
            if all(socket.messages for socket in sockets):
                break
            await asyncio.sleep(0.05)

        assert [socket.messages for socket in sockets] == [[payload]] * len(sockets)
        for socket in sockets:
            worker.disconnect(socket, code)
        await asyncio.sleep(0)

    asyncio.run(exercise())


def test_event_codes_are_isolated(client, event):
    other_code = "T" + uuid.uuid4().hex[:9].upper()
    assert client.get(f"/api/events/{event['code']}").status_code == 200
    assert client.get(f"/api/events/{other_code}").status_code == 404
