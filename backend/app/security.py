"""Credential storage helpers used by event and session authentication."""

import hashlib
import hmac
import secrets


PASSWORD_HASH_PREFIX = "pbkdf2_sha256$"
PASSWORD_HASH_ITERATIONS = 600_000
_PASSWORD_SALT_BYTES = 16
_PASSWORD_DIGEST_BYTES = 32
_MAX_ACCEPTED_ITERATIONS = 2_000_000

SESSION_HASH_PREFIX = "sha256$"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_PASSWORD_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS,
        dklen=_PASSWORD_DIGEST_BYTES,
    )
    return f"{PASSWORD_HASH_PREFIX}{PASSWORD_HASH_ITERATIONS}${salt.hex()}${digest.hex()}"


def is_password_hash(stored: str) -> bool:
    return isinstance(stored, str) and stored.startswith(PASSWORD_HASH_PREFIX)


def verify_password(password: str, stored: str) -> tuple[bool, bool]:
    """Return (matches, needs_rehash); legacy plaintext is upgraded on success."""
    if not stored:
        return False, False
    if not is_password_hash(stored):
        return hmac.compare_digest(stored.encode("utf-8"), password.encode("utf-8")), True

    try:
        scheme, iterations_text, salt_hex, digest_hex = stored.split("$")
        iterations = int(iterations_text)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        if (
            scheme != "pbkdf2_sha256"
            or iterations < 1
            or iterations > _MAX_ACCEPTED_ITERATIONS
            or len(salt) != _PASSWORD_SALT_BYTES
            or len(expected) != _PASSWORD_DIGEST_BYTES
        ):
            return False, False
    except (ValueError, TypeError):
        return False, False

    actual = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations,
        dklen=_PASSWORD_DIGEST_BYTES,
    )
    return hmac.compare_digest(actual, expected), iterations < PASSWORD_HASH_ITERATIONS


def hash_session_id(session_id: str) -> str:
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return f"{SESSION_HASH_PREFIX}{digest}"


def verify_session_id(session_id: str, stored: str) -> tuple[bool, bool]:
    """Return (matches, needs_upgrade), accepting plaintext tokens during migration."""
    if not stored:
        return False, False
    hashed = hmac.compare_digest(stored, hash_session_id(session_id))
    if hashed:
        return True, False
    legacy = hmac.compare_digest(stored, session_id)
    return legacy, legacy
