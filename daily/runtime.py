#!/usr/bin/env python3
"""Private, deterministic runtime for Daily Worklog.

The command line interface is intentionally the narrow public seam.  The
browser and agent skills call this module through ``scripts/dailyctl`` rather
than reaching into the database.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import html
import http.cookies
import http.server
import json
import os
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse
from zoneinfo import ZoneInfo


APP = "daily-worklog"
LOCAL_TZ = ZoneInfo("America/Sao_Paulo")
UTC = dt.timezone.utc
VALID_STATES = {"Done", "In progress", "Blocked"}
ALLOWED_LINK_HOSTS = {"github.com", "www.github.com", "linear.app", "linear.new"}
SECRET_PATTERNS = (
    (re.compile(r"(?i)(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*[^\s,;]+"), r"\1=[REDACTED]"),
    (re.compile(r"\b(?:ghp|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_-]{8,}\b"), "[REDACTED]"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._-]{8,}"), "Bearer [REDACTED]"),
)


class DailyError(Exception):
    """A user-facing, non-traceback runtime error."""


def utc_now() -> dt.datetime:
    return dt.datetime.now(UTC)


def parse_rfc3339(value: str | None, *, required: bool = False) -> dt.datetime:
    if not value:
        if required:
            raise DailyError("timestamp must be RFC 3339 and include a UTC offset")
        return utc_now()
    if not re.search(r"(?:Z|[+-]\d\d:\d\d)$", value):
        raise DailyError("timestamp must be RFC 3339 and include a UTC offset")
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError as exc:
        raise DailyError("invalid RFC 3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DailyError("timestamp must include a UTC offset")
    return parsed.astimezone(UTC)


def iso(value: dt.datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z") if value else None


def local(value: str | dt.datetime) -> dt.datetime:
    parsed = parse_rfc3339(value, required=isinstance(value, str)) if isinstance(value, str) else value
    return parsed.astimezone(LOCAL_TZ)


def sanitize(text: Any, limit: int = 4000) -> str:
    value = str(text or "")
    for pattern, replacement in SECRET_PATTERNS:
        value = pattern.sub(replacement, value)
    return value[:limit]


def safe_link(value: str) -> str | None:
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_LINK_HOSTS:
        return None
    return urllib.parse.urlunparse(("https", parsed.hostname, parsed.path, "", parsed.query, ""))


def json_load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def write_private(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(value, encoding="utf-8")
    os.chmod(path, 0o600)


def next_weekday(day: dt.date, exceptions: dict[str, Any] | None = None) -> dt.date:
    exceptions = exceptions or {}
    current = day
    while True:
        if current.weekday() < 5 and not exceptions.get(current.isoformat(), {}).get("non_working", False):
            return current
        current += dt.timedelta(days=1)


def previous_weekday(day: dt.date, exceptions: dict[str, Any] | None = None) -> dt.date:
    exceptions = exceptions or {}
    current = day
    while True:
        if current.weekday() < 5 and not exceptions.get(current.isoformat(), {}).get("non_working", False):
            return current
        current -= dt.timedelta(days=1)


class Store:
    def __init__(self) -> None:
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        state_home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
        self.data_dir = data_home / APP
        self.config_dir = config_home / APP
        self.state_dir = state_home / APP
        self.db_path = self.data_dir / "daily.sqlite3"
        self.config_path = self.config_dir / "config.json"
        self.health_path = self.state_dir / "health.json"
        self.backup_dir = self.data_dir / "backups"

    def configured(self) -> bool:
        return self.db_path.exists() and self.config_path.exists()

    def connect(self) -> sqlite3.Connection:
        if not self.db_path.exists():
            raise DailyError("Daily Worklog is not set up; run dailyctl setup")
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def config(self) -> dict[str, Any]:
        return json_load(self.config_path, {})

    def save_config(self, config: dict[str, Any]) -> None:
        write_private(self.config_path, json.dumps(config, indent=2, sort_keys=True) + "\n")

    def health(self) -> dict[str, Any]:
        return json_load(self.health_path, {"capture_enabled": self.configured(), "warnings": []})

    def save_health(self, health: dict[str, Any]) -> None:
        write_private(self.health_path, json.dumps(health, indent=2, sort_keys=True) + "\n")

    def warning(self, message: str) -> None:
        health = self.health()
        warnings = [sanitize(message, 300)]
        warnings.extend(item for item in health.get("warnings", []) if item not in warnings)
        health["warnings"] = warnings[:20]
        self.save_health(health)

    def migrate(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.data_dir, 0o700)
        if self.db_path.exists():
            os.chmod(self.db_path, 0o600)
        connection = sqlite3.connect(self.db_path)
        try:
            current = connection.execute("PRAGMA user_version").fetchone()[0]
            if current >= 2:
                return
            statements = [
                """
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE reporting_periods (
                    id INTEGER PRIMARY KEY, meeting_date TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
                    archived_at TEXT
                );
                CREATE TABLE work_sessions (
                    id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES reporting_periods(id),
                    session_date TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL,
                    ended_at TEXT, UNIQUE(period_id, session_date, kind)
                );
                CREATE TABLE candidates (
                    id INTEGER PRIMARY KEY, identity TEXT NOT NULL UNIQUE, agent TEXT NOT NULL,
                    session_id TEXT NOT NULL, turn_id TEXT NOT NULL, parent_turn_id TEXT,
                    project_root TEXT NOT NULL, completion_utc TEXT NOT NULL, period_id INTEGER,
                    text TEXT NOT NULL, evidence TEXT, references_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL DEFAULT 'pending', disposition TEXT, created_at TEXT NOT NULL
                );
                CREATE TABLE source_evidence (
                    id INTEGER PRIMARY KEY, candidate_id INTEGER REFERENCES candidates(id),
                    entry_id INTEGER, text TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
                );
                CREATE TABLE work_entries (
                    id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES reporting_periods(id),
                    candidate_id INTEGER REFERENCES candidates(id), text TEXT NOT NULL,
                    state TEXT NOT NULL, event_time_utc TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
                    unreviewed INTEGER NOT NULL DEFAULT 1, manual INTEGER NOT NULL DEFAULT 0,
                    curated_json TEXT NOT NULL DEFAULT '{}', dismissed_at TEXT
                );
                CREATE TABLE external_references (
                    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES work_entries(id),
                    kind TEXT NOT NULL, identifier TEXT NOT NULL, url TEXT, title TEXT,
                    status TEXT, target_branch TEXT, repository TEXT, source_branch TEXT,
                    commit_sha TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
                    UNIQUE(entry_id, kind, identifier)
                );
                CREATE TABLE calendar_exceptions (
                    day TEXT PRIMARY KEY, non_working INTEGER NOT NULL DEFAULT 0,
                    meeting_date TEXT
                );
                CREATE TABLE integration_cache (
                    kind TEXT NOT NULL, identifier TEXT NOT NULL, payload TEXT NOT NULL,
                    fetched_at TEXT NOT NULL, PRIMARY KEY(kind, identifier)
                );
                CREATE TABLE health_events (
                    id INTEGER PRIMARY KEY, level TEXT NOT NULL, message TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE migration_state (
                    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
                );
                CREATE INDEX candidates_status_idx ON candidates(status);
                CREATE INDEX entries_period_idx ON work_entries(period_id);
                """,
            ]
            if os.environ.get("DAILY_WORKLOG_FAIL_MIGRATION"):
                raise sqlite3.DatabaseError("migration failed by test configuration")
            backup = None
            if self.db_path.exists() and self.db_path.stat().st_size:
                backup = self.backup_dir / f"pre-migration-{dt.datetime.now().strftime('%Y%m%d%H%M%S')}.sqlite3"
                self.backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copy2(self.db_path, backup)
                os.chmod(backup, 0o600)
            with connection:
                if current == 0:
                    connection.executescript(statements[0])
                elif current == 1:
                    for column, definition in (
                        ("repository", "TEXT"),
                        ("source_branch", "TEXT"),
                        ("commit_sha", "TEXT"),
                        ("metadata_json", "TEXT NOT NULL DEFAULT '{}'"),
                    ):
                        connection.execute(f"ALTER TABLE external_references ADD COLUMN {column} {definition}")
                connection.execute("INSERT OR IGNORE INTO migration_state VALUES (2, ?)", (iso(utc_now()),))
                connection.execute("PRAGMA user_version = 2")
            os.chmod(self.db_path, 0o600)
        except Exception as exc:
            connection.rollback()
            self.save_health({"capture_enabled": False, "warnings": ["schema migration failed; restore the retained backup before capture"]})
            raise DailyError(f"schema migration failed: {sanitize(exc, 200)}") from exc
        finally:
            connection.close()


class Runtime:
    def __init__(self, store: Store | None = None) -> None:
        self.store = store or Store()

    def _exceptions(self, connection: sqlite3.Connection) -> dict[str, Any]:
        return {
            row["day"]: {"non_working": bool(row["non_working"]), "meeting_date": row["meeting_date"]}
            for row in connection.execute("SELECT * FROM calendar_exceptions")
        }

    def meeting_date_for(self, moment: dt.datetime, connection: sqlite3.Connection) -> str:
        current = moment.astimezone(LOCAL_TZ)
        exceptions = self._exceptions(connection)
        day = current.date()
        exception = exceptions.get(day.isoformat(), {})
        if exception.get("meeting_date"):
            return exception["meeting_date"]
        # Team Daily is the morning boundary.  Afternoon work belongs to the
        # next working meeting; morning work belongs to today's meeting.
        if current.weekday() < 5 and not exception.get("non_working") and 8 <= current.hour < 12:
            return day.isoformat()
        if current.weekday() < 5 and current.hour >= 12:
            return next_weekday(day + dt.timedelta(days=1), exceptions).isoformat()
        return next_weekday(day, exceptions).isoformat()

    def session_for(self, moment: dt.datetime, connection: sqlite3.Connection) -> tuple[str, str] | None:
        current = moment.astimezone(LOCAL_TZ)
        exceptions = self._exceptions(connection)
        if current.weekday() >= 5 or exceptions.get(current.date().isoformat(), {}).get("non_working"):
            return None
        if 13 <= current.hour < 18:
            return (next_weekday(current.date() + dt.timedelta(days=1), exceptions).isoformat(), "afternoon")
        if 8 <= current.hour < 12:
            return (current.date().isoformat(), "morning")
        return None

    def _period(self, connection: sqlite3.Connection, meeting_date: str, create: bool = True) -> sqlite3.Row | None:
        row = connection.execute("SELECT * FROM reporting_periods WHERE meeting_date = ?", (meeting_date,)).fetchone()
        if not row and create:
            connection.execute(
                "INSERT INTO reporting_periods(meeting_date, created_at) VALUES (?, ?)",
                (meeting_date, iso(utc_now())),
            )
            row = connection.execute("SELECT * FROM reporting_periods WHERE meeting_date = ?", (meeting_date,)).fetchone()
        return row

    def _period_dict(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return dict(row)

    def setup(self, at: str | None, project: str | None, port: int = 8765) -> dict[str, Any]:
        if self.store.configured():
            return {"status": "noop", "message": "Daily Worklog is already set up"}
        moment = parse_rfc3339(at, required=bool(at))
        if not 1024 <= port <= 65535:
            raise DailyError("port must be between 1024 and 65535")
        root = Path(project or os.getcwd()).expanduser().resolve()
        if not project:
            try:
                detected = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False)
                if detected.returncode == 0 and detected.stdout.strip():
                    root = Path(detected.stdout.strip()).resolve()
            except OSError:
                pass
        if not root.exists() or not root.is_dir():
            raise DailyError("tracked project must be an existing directory")
        self.store.config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.store.config_dir, 0o700)
        os.chmod(self.store.state_dir, 0o700)
        self.store.migrate()
        connection = self.store.connect()
        try:
            meeting_date = self.meeting_date_for(moment, connection)
            period = self._period(connection, meeting_date)
            session = self.session_for(moment, connection)
            if session:
                session_date, kind = session
                if kind == "afternoon":
                    session_date = moment.astimezone(LOCAL_TZ).date().isoformat()
                connection.execute(
                    "INSERT OR IGNORE INTO work_sessions(period_id, session_date, kind, started_at) VALUES (?, ?, ?, ?)",
                    (period["id"], session_date, kind, iso(moment)),
                )
            self.store.save_config({"timezone": "America/Sao_Paulo", "port": port, "tracked_projects": [str(root)], "source_evidence_enabled": True, "setup_at": iso(moment)})
            self.store.save_health({"capture_enabled": True, "last_successful_capture": None, "warnings": []})
            connection.commit()
        finally:
            connection.close()
        self._install_launcher()
        self._merge_hooks()
        return {"status": "changed", "reporting_period": {"meeting_date": meeting_date}, "tracked_projects": [str(root)], "verification": {"claude_capture": "ready", "codex_capture": "ready", "capture_history_imported": False}, "orca": self._orca_templates()}

    def _install_launcher(self) -> None:
        bin_home = Path(os.environ.get("XDG_BIN_HOME", Path.home() / ".local/bin"))
        bin_home.mkdir(parents=True, exist_ok=True, mode=0o700)
        launcher = bin_home / "dailyctl"
        source = Path(__file__).resolve().parents[1] / "scripts" / "dailyctl"
        launcher.write_text(f"#!/bin/sh\nexec python3 {source!s} \"$@\"\n", encoding="utf-8")
        os.chmod(launcher, 0o700)

    def _hook_paths(self) -> tuple[Path, Path]:
        if os.environ.get("DAILY_WORKLOG_TEST_MODE") or os.environ.get("NEXUS_TEST_MODE"):
            return (self.store.config_dir / "claude-hooks.json", self.store.config_dir / "codex-hooks.json")
        return (Path(os.environ.get("DAILY_CLAUDE_HOOKS", Path.home() / ".claude/settings.json")), Path(os.environ.get("DAILY_CODEX_HOOKS", Path.home() / ".codex/hooks.json")))

    def _merge_hooks(self) -> None:
        for path in self._hook_paths():
            original = json_load(path, {})
            if not isinstance(original, dict):
                continue
            hooks = original.setdefault("hooks", [])
            marker = {"id": "daily-worklog", "command": "dailyctl capture", "event": "completed_turn"}
            if isinstance(hooks, list) and not any(isinstance(item, dict) and item.get("id") == "daily-worklog" for item in hooks):
                hooks.append(marker)
                write_private(path, json.dumps(original, indent=2) + "\n")

    def _orca_templates(self) -> dict[str, str]:
        return {action: f"dailyctl {action} --at '{{timestamp with offset}}'" for action in ("start", "stop", "continue")}

    def lifecycle(self, action: str, at: str | None) -> dict[str, Any]:
        moment = parse_rfc3339(at, required=True)
        connection = self.store.connect()
        try:
            session = self.session_for(moment, connection)
            if action == "start":
                current = connection.execute("SELECT * FROM reporting_periods WHERE status = 'active' ORDER BY id DESC LIMIT 1").fetchone()
                if current and moment.astimezone(LOCAL_TZ).date().isoformat() >= current["meeting_date"]:
                    # At the meeting boundary the current report is the one just presented.
                    connection.execute("UPDATE reporting_periods SET status = 'archived', archived_at = ? WHERE id = ?", (iso(moment), current["id"]))
                    new_date = self.meeting_date_for(moment + dt.timedelta(hours=2), connection)
                    period = self._period(connection, new_date)
                    connection.commit()
                    return {"status": "changed", "archived_meeting_date": current["meeting_date"], "reporting_period": {"meeting_date": period["meeting_date"]}}
                if current:
                    return {"status": "noop", "reporting_period": {"meeting_date": current["meeting_date"]}}
                meeting = self.meeting_date_for(moment, connection)
                period = self._period(connection, meeting)
                connection.commit()
                return {"status": "changed", "reporting_period": {"meeting_date": period["meeting_date"]}}
            current = connection.execute("SELECT * FROM reporting_periods WHERE status = 'active' ORDER BY id DESC LIMIT 1").fetchone()
            if not current:
                current = self._period(connection, self.meeting_date_for(moment, connection))
            if action == "stop":
                row = connection.execute("SELECT * FROM work_sessions WHERE period_id = ? AND kind = 'afternoon' AND ended_at IS NULL ORDER BY id DESC LIMIT 1", (current["id"],)).fetchone()
                if not row:
                    connection.commit()
                    return {"status": "noop", "reporting_period": {"meeting_date": current["meeting_date"]}}
                nominal = dt.datetime.fromisoformat(row["session_date"] + "T18:00:00-03:00").astimezone(UTC)
                connection.execute("UPDATE work_sessions SET ended_at = ? WHERE id = ?", (iso(min(moment, nominal)), row["id"]))
            else:
                target_date = session[0] if session and session[1] == "morning" else current["meeting_date"]
                row = connection.execute("SELECT * FROM work_sessions WHERE period_id = ? AND kind = 'morning' AND ended_at IS NULL", (current["id"],)).fetchone()
                if row:
                    connection.commit()
                    return {"status": "noop", "reporting_period": {"meeting_date": current["meeting_date"]}}
                connection.execute("INSERT OR IGNORE INTO work_sessions(period_id, session_date, kind, started_at) VALUES (?, ?, 'morning', ?)", (current["id"], target_date, iso(moment)))
            connection.commit()
            return {"status": "changed", "reporting_period": {"meeting_date": current["meeting_date"]}, "session": action}
        finally:
            connection.close()

    def _active_period(self, connection: sqlite3.Connection) -> sqlite3.Row | None:
        return connection.execute("SELECT * FROM reporting_periods WHERE status = 'active' ORDER BY id DESC LIMIT 1").fetchone()

    def _eligible_period(self, moment: dt.datetime, connection: sqlite3.Connection) -> int | None:
        session = self.session_for(moment, connection)
        if not session:
            return None
        period = connection.execute("SELECT * FROM reporting_periods WHERE meeting_date = ? AND status = 'active'", (session[0],)).fetchone()
        if not period:
            return None
        open_session = connection.execute("SELECT 1 FROM work_sessions WHERE period_id = ? AND kind = ? AND ended_at IS NULL", (period["id"], session[1])).fetchone()
        return period["id"] if open_session else None

    def _github_parts(self, value: Any) -> tuple[str | None, str | None]:
        """Return repository and PR number from an allowlisted GitHub value."""
        text = str(value or "")
        parsed = urlparse(text)
        if parsed.hostname not in {"github.com", "www.github.com"}:
            return None, None
        parts = [item for item in parsed.path.split("/") if item]
        if len(parts) >= 4 and parts[2] == "pull" and parts[0] and parts[1] and parts[3].isdigit():
            return f"{parts[0]}/{parts[1]}", parts[3]
        return None, None

    def _pull_request_identifier(self, identifier: Any, repository: Any = None, url: Any = None) -> tuple[str, str | None, str | None]:
        repo = sanitize(repository, 200).strip() or None
        number = sanitize(identifier, 100).strip()
        url_repo, url_number = self._github_parts(url)
        if not url_repo and not url_number:
            url_repo, url_number = self._github_parts(number)
        if url_repo and url_number:
            repo, number = url_repo, url_number
        if "#" in number and not number.startswith("#"):
            possible_repo, possible_number = number.rsplit("#", 1)
            if possible_number.isdigit():
                repo, number = possible_repo, possible_number
        if number.startswith("#") and number[1:].isdigit():
            number = number[1:]
        canonical = f"{repo}#{number}" if repo and number.isdigit() else number
        return canonical, repo, number if number else None

    def _references(self, values: Iterable[str], prs: Iterable[str]) -> list[dict[str, Any]]:
        references: list[dict[str, Any]] = []
        for identifier in values:
            if isinstance(identifier, dict):
                text = sanitize(identifier.get("identifier"), 100)
            else:
                text = sanitize(identifier, 100)
            if text:
                references.append({"kind": "linear", "identifier": text})
        for value in prs:
            raw_url = value.get("url") if isinstance(value, dict) else value
            url = safe_link(str(raw_url or ""))
            repository = value.get("repository") if isinstance(value, dict) else None
            identifier = value.get("identifier") if isinstance(value, dict) else None
            if url:
                repository, number = self._github_parts(url)
                identifier = number
            if identifier:
                canonical, repository, _ = self._pull_request_identifier(identifier, repository, url)
                references.append({
                    "kind": "pull_request", "identifier": canonical, "url": url,
                    "repository": repository,
                    "source_branch": sanitize(value.get("source_branch") or value.get("head_branch"), 200) if isinstance(value, dict) else None,
                    "commit_sha": sanitize(value.get("commit_sha") or value.get("head_sha"), 200) if isinstance(value, dict) else None,
                })
        return references

    def _insert_references(self, connection: sqlite3.Connection, entry_id: int, references: list[dict[str, Any]]) -> None:
        for reference in references:
            kind = reference.get("kind")
            identifier = sanitize(reference.get("identifier"), 200).strip()
            if kind not in {"linear", "pull_request"} or not identifier:
                continue
            url = safe_link(str(reference.get("url") or "")) if reference.get("url") else None
            repository = None
            if kind == "pull_request":
                identifier, repository, _ = self._pull_request_identifier(identifier, reference.get("repository"), url)
            elif not url:
                url = f"https://linear.app/issue/{urllib.parse.quote(identifier)}"
            metadata = reference.get("metadata") or {}
            if not isinstance(metadata, dict):
                metadata = {}
            connection.execute(
                "INSERT OR IGNORE INTO external_references(entry_id, kind, identifier, url, repository, source_branch, commit_sha, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (entry_id, kind, identifier, url, repository or sanitize(reference.get("repository"), 200) or None,
                 sanitize(reference.get("source_branch"), 200) or None,
                 sanitize(reference.get("commit_sha"), 200) or None,
                 json.dumps(metadata, ensure_ascii=False)),
            )

    def note(self, text: str, state: str, at: str | None, linear: list[str], prs: list[str]) -> dict[str, Any]:
        if state not in VALID_STATES:
            raise DailyError("state must be Done, In progress, or Blocked")
        moment = parse_rfc3339(at, required=bool(at))
        clean = sanitize(text, 500)
        if not clean:
            raise DailyError("manual entry text cannot be empty")
        connection = self.store.connect()
        try:
            period = self._active_period(connection)
            if not period:
                period = self._period(connection, self.meeting_date_for(moment, connection))
            now = iso(utc_now())
            cursor = connection.execute(
                "INSERT INTO work_entries(period_id, text, state, event_time_utc, created_at, updated_at, manual, unreviewed) VALUES (?, ?, ?, ?, ?, ?, 1, 0)",
                (period["id"], clean, state, iso(moment), now, now),
            )
            references = self._references(linear, prs)
            self._insert_references(connection, cursor.lastrowid, references)
            connection.commit()
            return {"status": "changed", "entry": self.entry_dict(connection, cursor.lastrowid)}
        finally:
            connection.close()

    def entry_dict(self, connection: sqlite3.Connection, entry_id: int, include_evidence: bool = True) -> dict[str, Any]:
        row = connection.execute("SELECT e.*, p.meeting_date FROM work_entries e JOIN reporting_periods p ON p.id=e.period_id WHERE e.id = ?", (entry_id,)).fetchone()
        if not row:
            raise DailyError("work entry not found")
        result = dict(row)
        result["references"] = []
        for item in connection.execute("SELECT kind, identifier, url, title, status, target_branch, repository, source_branch, commit_sha, metadata_json FROM external_references WHERE entry_id = ? ORDER BY id", (entry_id,)):
            reference = dict(item)
            reference["url"] = safe_link(reference.get("url", "")) if reference.get("url") else None
            metadata = json.loads(reference.pop("metadata_json") or "{}")
            if isinstance(metadata, dict) and metadata.get("pull_requests"):
                reference["linked_pull_requests"] = metadata["pull_requests"]
            result["references"].append(reference)
        result["curated_fields"] = json.loads(result.pop("curated_json") or "{}")
        if include_evidence:
            result["source_evidence"] = [dict(item) for item in connection.execute("SELECT id, candidate_id, text, disabled, created_at, expires_at FROM source_evidence WHERE entry_id = ? AND disabled = 0", (entry_id,))]
        return result

    def report(self, meeting_date: str | None = None, present: bool = False) -> dict[str, Any]:
        connection = self.store.connect()
        try:
            period = connection.execute("SELECT * FROM reporting_periods WHERE meeting_date = ?", (meeting_date,)).fetchone() if meeting_date else self._active_period(connection)
            if not period:
                return {"reporting_period": None, "entries": [], "inbox": []}
            entries = [self.entry_dict(connection, row["id"], include_evidence=not present) for row in connection.execute("SELECT id FROM work_entries WHERE period_id = ? AND hidden = 0 ORDER BY event_time_utc, id", (period["id"],))]
            for index, entry in enumerate(entries):
                instant = parse_rfc3339(entry["event_time_utc"], required=True).astimezone(LOCAL_TZ)
                entry["display_time"] = instant.strftime("%H:%M")
                entry["display_date"] = instant.date().isoformat()
                if present:
                    entries[index] = {key: entry[key] for key in ("id", "text", "state", "event_time_utc", "display_time", "display_date", "meeting_date", "references")}
            result: dict[str, Any] = {"reporting_period": self._period_dict(period), "entries": entries}
            if present:
                result["summary"] = self._summary(entries)
                result["sessions"] = [dict(row) for row in connection.execute("SELECT * FROM work_sessions WHERE period_id = ? ORDER BY session_date, kind", (period["id"],))]
            else:
                result["inbox"] = [dict(row) for row in connection.execute("SELECT id, agent, completion_utc, text, status, disposition FROM candidates WHERE status IN ('inbox', 'pending') AND (period_id IS NULL OR status = 'inbox') ORDER BY completion_utc")]
                result["health"] = self.store.health()
            return result
        finally:
            connection.close()

    def _summary(self, entries: list[dict[str, Any]]) -> dict[str, int]:
        return {"outcomes": len(entries), "issues": len({r["identifier"] for e in entries for r in e.get("references", []) if r["kind"] == "linear"}), "pull_requests": len({r["identifier"] for e in entries for r in e.get("references", []) if r["kind"] == "pull_request"})}

    def capture(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Ingest only the allowlisted completed-turn projection.

        This function is deliberately fail-open: malformed hook data becomes a
        sanitized health warning and a successful process exit for the agent.
        """
        try:
            if not self.store.configured():
                return {"status": "discarded", "reason": "not_setup"}
            if payload.get("kind", "completed_turn") != "completed_turn":
                return {"status": "noop", "reason": "supporting_activity"}
            agent = sanitize(payload.get("agent"), 30).lower()
            if agent not in {"claude", "codex"}:
                raise DailyError("unsupported agent")
            session_id = sanitize(payload.get("session_id"), 200)
            turn_id = sanitize(payload.get("turn_id"), 200)
            if not session_id or not turn_id:
                raise DailyError("missing hook identity")
            moment = parse_rfc3339(payload.get("completion_time"), required=True)
            root = Path(str(payload.get("project_root", ""))).expanduser().resolve()
            config = self.store.config()
            tracked = [Path(item).expanduser().resolve() for item in config.get("tracked_projects", [])]
            if not any(root == item or item in root.parents for item in tracked):
                return {"status": "discarded", "reason": "unknown_project"}
            connection = self.store.connect()
            try:
                identity = hashlib.sha256(f"{agent}\0{session_id}\0{turn_id}".encode()).hexdigest()
                if connection.execute("SELECT 1 FROM candidates WHERE identity = ?", (identity,)).fetchone():
                    return {"status": "noop", "reason": "duplicate"}
                parent_turn_id = sanitize(payload.get("parent_turn_id"), 200) or None
                if parent_turn_id:
                    parent = connection.execute("SELECT id FROM candidates WHERE turn_id = ?", (parent_turn_id,)).fetchone()
                    if not parent:
                        return {"status": "noop", "reason": "orphan_supporting_activity"}
                    supporting_text = sanitize(payload.get("final_response", ""), 4000)
                    if supporting_text:
                        connection.execute("INSERT INTO source_evidence(candidate_id, text, created_at, expires_at) VALUES (?, ?, ?, ?)", (parent["id"], supporting_text, iso(moment), iso(moment + dt.timedelta(days=30))))
                    connection.commit()
                    return {"status": "noop", "reason": "folded_into_parent", "parent_candidate_id": parent["id"]}
                text = sanitize(payload.get("final_response", ""), 2000)
                references = self._references(payload.get("linear", []) or [], payload.get("pull_requests", []) or [])
                period_id = self._eligible_period(moment, connection)
                evidence = sanitize(payload.get("final_response", ""), 4000) if self.store.config().get("source_evidence_enabled", True) and not payload.get("disable_evidence") else None
                cursor = connection.execute(
                    """INSERT INTO candidates(identity, agent, session_id, turn_id, parent_turn_id,
                       project_root, completion_utc, period_id, text, evidence, references_json, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (identity, agent, session_id, turn_id, parent_turn_id, str(root), iso(moment), period_id, text, evidence, json.dumps(references), iso(utc_now())),
                )
                candidate_id = cursor.lastrowid
                if evidence:
                    created = moment
                    expires = created + dt.timedelta(days=30)
                    connection.execute("INSERT INTO source_evidence(candidate_id, text, created_at, expires_at) VALUES (?, ?, ?, ?)", (candidate_id, evidence, iso(created), iso(expires)))
                connection.commit()
                health = self.store.health()
                health["capture_enabled"] = True
                health["last_successful_capture"] = iso(moment)
                health["last_successful_agent"] = agent
                health["warnings"] = [item for item in health.get("warnings", []) if "capture" not in item.lower()]
                self.store.save_health(health)
                return {"status": "changed", "candidate_id": candidate_id, "assigned": bool(period_id), "inbox": not bool(period_id)}
            finally:
                connection.close()
        except Exception as exc:
            self.store.warning(f"capture failed: {sanitize(exc, 160)}")
            return {"status": "discarded", "reason": "capture_failure"}

    def curate_export(self) -> dict[str, Any]:
        connection = self.store.connect()
        try:
            candidates = []
            for row in connection.execute("SELECT id, agent, completion_utc, project_root, text, period_id, references_json, status FROM candidates WHERE status = 'pending' ORDER BY completion_utc, id"):
                item = dict(row)
                item["references"] = json.loads(item.pop("references_json") or "[]")
                item["text"] = sanitize(item["text"], 2000)
                item["reportable_hint"] = self._is_reportable(item["text"])
                candidates.append(item)
            return {"version": 1, "candidates": candidates}
        finally:
            connection.close()

    def _is_reportable(self, text: str) -> bool:
        lower = text.lower().strip()
        if not lower or len(lower) < 12:
            return False
        excluded = ("hello", "hi!", "hi ", "what can i", "how can i help", "i can help", "planning to", "i will plan")
        if lower.startswith(excluded):
            return False
        meaningful = ("implemented", "fixed", "created", "added", "updated", "removed", "reviewed", "investigated", "deployed", "decided", "blocked", "resolved", "built", "changed", "configured", "documented", "tested")
        return any(word in lower for word in meaningful)

    def _normalise_state(self, value: Any) -> str:
        aliases = {"done": "Done", "complete": "Done", "completed": "Done", "in progress": "In progress", "in_progress": "In progress", "blocked": "Blocked"}
        result = aliases.get(str(value).strip().lower())
        if result not in VALID_STATES:
            raise DailyError("proposal state must be Done, In progress, or Blocked")
        return result

    def curate_commit(self, payload: dict[str, Any]) -> dict[str, Any]:
        proposals = payload.get("proposals")
        if not isinstance(proposals, list):
            raise DailyError("curation payload must contain a proposals list")
        connection = self.store.connect()
        try:
            validated: list[tuple[sqlite3.Row, dict[str, Any]]] = []
            seen: set[int] = set()
            for proposal in proposals:
                if not isinstance(proposal, dict):
                    raise DailyError("each curation proposal must be an object")
                try:
                    candidate_id = int(proposal["candidate_id"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise DailyError("each proposal needs a numeric candidate_id") from exc
                if candidate_id in seen:
                    raise DailyError("duplicate candidate_id in curation payload")
                seen.add(candidate_id)
                candidate = connection.execute("SELECT * FROM candidates WHERE id = ? AND status = 'pending'", (candidate_id,)).fetchone()
                if not candidate:
                    raise DailyError(f"candidate {candidate_id} is not pending")
                uncertain = bool(proposal.get("uncertain", False))
                text = sanitize(proposal.get("text", ""), 500).strip()
                state = self._normalise_state(proposal.get("state")) if not uncertain else "In progress"
                if not uncertain and (not text or not self._is_reportable(text)):
                    uncertain = True
                validated.append((candidate, {"text": text, "state": state, "uncertain": uncertain, "references": proposal.get("references") or json.loads(candidate["references_json"] or "[]"), "time": proposal.get("time")}))
            # No write happens before every proposal above has validated.
            now = iso(utc_now())
            changed = 0
            for candidate, proposal in validated:
                if proposal["uncertain"] or candidate["period_id"] is None:
                    connection.execute("UPDATE candidates SET status = 'inbox', disposition = ? WHERE id = ?", ("uncertain" if proposal["uncertain"] else "outside_session", candidate["id"]))
                    continue
                when = parse_rfc3339(proposal["time"], required=True) if proposal.get("time") else parse_rfc3339(candidate["completion_utc"], required=True)
                entry_id = self._entry_for_identity(connection, candidate, proposal, when, now)
                for source in connection.execute("SELECT id FROM source_evidence WHERE candidate_id = ?", (candidate["id"],)):
                    connection.execute("UPDATE source_evidence SET entry_id = ? WHERE id = ?", (entry_id, source["id"]))
                connection.execute("UPDATE candidates SET status = 'curated' WHERE id = ?", (candidate["id"],))
                changed += 1
            connection.commit()
            return {"status": "changed" if changed else "noop", "entries_created": changed}
        except Exception:
            connection.rollback()
            self.store.warning("curation proposal rejected; pending evidence was preserved")
            raise
        finally:
            connection.close()

    def _entry_for_identity(self, connection: sqlite3.Connection, candidate: sqlite3.Row, proposal: dict[str, Any], when: dt.datetime, now: str) -> int:
        refs = proposal.get("references") or []
        identities = {(item.get("kind"), str(item.get("identifier"))) for item in refs if isinstance(item, dict) and item.get("kind") in {"linear", "pull_request"}}
        existing_id = None
        if identities:
            for row in connection.execute("SELECT DISTINCT e.id, r.kind, r.identifier FROM work_entries e JOIN external_references r ON r.entry_id=e.id WHERE e.period_id = ?", (candidate["period_id"],)):
                if (row["kind"], row["identifier"]) in identities:
                    existing_id = row["id"]
                    break
        if existing_id:
            connection.execute("UPDATE work_entries SET updated_at = ? WHERE id = ?", (now, existing_id))
            self._insert_references(connection, existing_id, refs)
            return existing_id
        cursor = connection.execute(
            "INSERT INTO work_entries(period_id, candidate_id, text, state, event_time_utc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (candidate["period_id"], candidate["id"], proposal["text"], proposal["state"], iso(when), now, now),
        )
        self._insert_references(connection, cursor.lastrowid, refs)
        return cursor.lastrowid

    def triage(self, action: str, candidate_id: int, period_date: str | None = None) -> dict[str, Any]:
        connection = self.store.connect()
        try:
            row = connection.execute("SELECT * FROM candidates WHERE id = ?", (candidate_id,)).fetchone()
            if not row:
                raise DailyError("candidate not found")
            if action == "dismiss":
                connection.execute("UPDATE candidates SET status='dismissed', disposition='dismissed' WHERE id=?", (candidate_id,))
            elif action == "restore":
                connection.execute("UPDATE candidates SET status='inbox', disposition='restored' WHERE id=?", (candidate_id,))
            elif action == "attach":
                if not period_date:
                    raise DailyError("attach needs --meeting-date")
                period = self._period(connection, period_date)
                connection.execute("UPDATE candidates SET period_id=?, status='pending', disposition='attached' WHERE id=?", (period["id"], candidate_id))
            else:
                raise DailyError("unknown inbox action")
            connection.commit()
            return {"status": "changed", "candidate_id": candidate_id, "action": action}
        finally:
            connection.close()

    def merge_entries(self, target_id: int, source_ids: list[int]) -> dict[str, Any]:
        if target_id in source_ids or not source_ids:
            raise DailyError("merge needs a target and at least one different source entry")
        connection = self.store.connect()
        try:
            target = connection.execute("SELECT id FROM work_entries WHERE id = ?", (target_id,)).fetchone()
            if not target or any(not connection.execute("SELECT 1 FROM work_entries WHERE id = ?", (item,)).fetchone() for item in source_ids):
                raise DailyError("merge entry not found")
            for source_id in source_ids:
                connection.execute("UPDATE source_evidence SET entry_id = ? WHERE entry_id = ?", (target_id, source_id))
                connection.execute("UPDATE external_references SET entry_id = ? WHERE entry_id = ?", (target_id, source_id))
                connection.execute("DELETE FROM work_entries WHERE id = ?", (source_id,))
            connection.commit()
            return {"status": "changed", "target_id": target_id, "merged_ids": source_ids}
        finally:
            connection.close()

    def enrich(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Apply metadata returned by read-only GitHub/Linear adapters.

        The adapters deliberately stop at this contract: ``github`` contains
        PR records returned by read-only ``gh`` queries and ``linear`` contains
        issue records returned by a read-only GraphQL query.  The runtime only
        writes its own SQLite cache and report references.  This keeps capture
        and presentation independent from credentials, network availability,
        and the implementation of either external client.

        A GitHub record may be selected by an explicit PR identifier, or by a
        repository plus branch/commit evidence.  Linear records can carry
        related PR records; those are attached to the same Work Entry.
        """
        if not isinstance(payload, dict):
            raise DailyError("enrichment input must be a JSON object")
        references = payload.get("references", [])
        if not isinstance(references, list):
            references = []
        github = payload.get("github") or {}
        linear = payload.get("linear") or {}
        if isinstance(github, list):
            github = {"status": "ok", "pull_requests": github}
        if isinstance(linear, list):
            linear = {"status": "ok", "issues": linear}
        if not isinstance(github, dict):
            github = {"status": "invalid"}
        if not isinstance(linear, dict):
            linear = {"status": "invalid"}
        github_has_records = bool(github.get("pull_requests") or github.get("prs"))
        if github.get("query") or (not github_has_records and any(github.get(key) for key in ("repository", "repo", "branch", "commit", "number", "pull_request"))):
            try:
                from .integrations import GitHubReadOnlyAdapter
                github = {**github, "status": "ok", "pull_requests": GitHubReadOnlyAdapter().resolve(github.get("query") or github)}
            except Exception as exc:
                github = {**github, "status": "error", "message": sanitize(exc, 240)}
        linear_has_records = bool(linear.get("issues") or linear.get("references"))
        if linear.get("query") or (not linear_has_records and any(linear.get(key) for key in ("identifier", "key"))):
            try:
                from .integrations import LinearReadOnlyAdapter
                linear = {**linear, "status": "ok", "issues": LinearReadOnlyAdapter().resolve(linear.get("query") or linear)}
            except Exception as exc:
                linear = {**linear, "status": "error", "message": sanitize(exc, 240)}

        connection = self.store.connect()
        diagnostics: list[dict[str, str]] = []
        cache_hits = 0
        stale_cache = False
        changed = 0
        now = utc_now()
        ttl = payload.get("cache_ttl_seconds", 86400)
        try:
            def add_diagnostic(provider: str, code: str, message: Any) -> None:
                diagnostic = {"provider": sanitize(provider, 30), "code": sanitize(code, 60), "message": sanitize(message, 240)}
                if diagnostic not in diagnostics:
                    diagnostics.append(diagnostic)

            def status_for(provider: str, data: dict[str, Any]) -> str:
                value = str(data.get("status", "ok")).strip().lower().replace("-", "_").replace(" ", "_")
                aliases = {"success": "ok", "available": "ok", "authenticated": "ok", "unauthorized": "expired_auth", "auth_expired": "expired_auth", "offline_mode": "offline", "rate_limit": "rate_limited"}
                value = aliases.get(value, value)
                if value not in {"ok", "offline", "expired_auth", "rate_limited", "missing", "invalid", "error"}:
                    value = "error"
                if value != "ok":
                    add_diagnostic(provider, value, data.get("message") or f"{provider} enrichment unavailable")
                return value

            github_status = status_for("github", github)
            linear_status = status_for("linear", linear)
            if payload.get("offline"):
                if github_status == "ok":
                    github_status = "offline"
                    add_diagnostic("github", "offline", "GitHub access is offline")
                if linear_status == "ok":
                    linear_status = "offline"
                    add_diagnostic("linear", "offline", "Linear access is offline")

            def cache_keys(kind: str, identifier: str, item: dict[str, Any] | None = None) -> list[str]:
                keys = [identifier]
                if kind == "pull_request":
                    canonical, _repo, number = self._pull_request_identifier(identifier, (item or {}).get("repository"), (item or {}).get("url"))
                    keys = [canonical]
                    if number:
                        keys.append(number)
                return list(dict.fromkeys(keys))

            def cached(kind: str, identifier: str, item: dict[str, Any] | None = None) -> dict[str, Any] | None:
                nonlocal cache_hits, stale_cache
                for key in cache_keys(kind, identifier, item):
                    row = connection.execute("SELECT payload, fetched_at FROM integration_cache WHERE kind = ? AND identifier = ?", (kind, key)).fetchone()
                    if not row:
                        continue
                    try:
                        value = json.loads(row["payload"])
                    except json.JSONDecodeError:
                        continue
                    cache_hits += 1
                    try:
                        age = max(0.0, (now - parse_rfc3339(row["fetched_at"], required=True)).total_seconds())
                        is_stale = float(ttl) >= 0 and age >= float(ttl)
                    except (TypeError, ValueError, DailyError):
                        is_stale = True
                    if is_stale:
                        stale_cache = True
                    return value if isinstance(value, dict) else None
                return None

            def cache(kind: str, identifier: str, value: dict[str, Any]) -> None:
                if not value:
                    return
                cache_key = identifier
                if kind == "pull_request":
                    cache_key, _repo, _number = self._pull_request_identifier(identifier, value.get("repository"), value.get("url"))
                connection.execute(
                    "INSERT INTO integration_cache(kind, identifier, payload, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, identifier) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at",
                    (kind, cache_key, json.dumps(value, ensure_ascii=False), iso(now)),
                )

            def pr_record(raw: Any) -> dict[str, Any] | None:
                if not isinstance(raw, dict):
                    return None
                url = safe_link(str(raw.get("url") or raw.get("html_url") or ""))
                number = raw.get("number", raw.get("identifier", raw.get("id")))
                repository = raw.get("repository") or raw.get("repo") or raw.get("full_name")
                if isinstance(repository, dict):
                    repository = repository.get("nameWithOwner") or repository.get("full_name")
                if not repository:
                    head_repository = raw.get("headRepository")
                    if isinstance(head_repository, dict):
                        repository = head_repository.get("nameWithOwner") or head_repository.get("full_name") or head_repository.get("name")
                    repository = repository or raw.get("headRepositoryOwner")
                canonical, repository, _number = self._pull_request_identifier(number, repository, url)
                if not _number or not repository:
                    return None
                base_data = raw.get("base") if isinstance(raw.get("base"), dict) else {}
                head_data = raw.get("head") if isinstance(raw.get("head"), dict) else {}
                base = raw.get("base_branch") or raw.get("target_branch") or raw.get("baseRefName") or base_data.get("ref")
                head = raw.get("head_branch") or raw.get("source_branch") or raw.get("headRefName") or head_data.get("ref")
                sha = raw.get("head_sha") or raw.get("commit_sha") or raw.get("headRefOid") or head_data.get("sha")
                state = raw.get("status") or raw.get("state")
                return {
                    "kind": "pull_request", "identifier": canonical, "repository": repository,
                    "url": url, "title": sanitize(raw.get("title"), 300) or None,
                    "status": sanitize(state, 100) or None, "target_branch": sanitize(base, 200) or None,
                    "source_branch": sanitize(head, 200) or None, "commit_sha": sanitize(sha, 200) or None,
                }

            def requested_pr_matches(record: dict[str, Any], requested: dict[str, Any]) -> bool:
                if requested.get("kind") != "pull_request":
                    return False
                wanted, wanted_repo, wanted_number = self._pull_request_identifier(requested.get("identifier"), requested.get("repository"), requested.get("url"))
                if wanted and wanted == record["identifier"]:
                    return True
                if wanted_number and wanted_number == record["identifier"].rsplit("#", 1)[-1] and wanted_repo == record.get("repository"):
                    return True
                repo = sanitize(requested.get("repository"), 200) or wanted_repo
                branch = sanitize(requested.get("branch") or requested.get("head_branch") or requested.get("source_branch"), 200)
                commit = sanitize(requested.get("commit") or requested.get("commit_sha") or requested.get("head_sha"), 200)
                return bool(repo and repo == record.get("repository") and ((branch and branch == record.get("source_branch")) or (commit and commit == record.get("commit_sha"))))

            def reference_rows(kind: str, identifier: str, repository: str | None = None) -> list[sqlite3.Row]:
                values = cache_keys(kind, identifier, {"repository": repository})
                placeholders = ",".join("?" for _ in values)
                query = f"SELECT * FROM external_references WHERE kind = ? AND identifier IN ({placeholders})"
                return list(connection.execute(query, [kind, *values]))

            def apply_reference(item: dict[str, Any], target_ids: list[int] | None = None, allow_new: bool = True) -> int:
                nonlocal changed
                kind = item.get("kind")
                identifier = sanitize(item.get("identifier"), 200).strip()
                if kind == "pull_request":
                    identifier, repository, _ = self._pull_request_identifier(identifier, item.get("repository"), item.get("url"))
                else:
                    repository = None
                if kind not in {"linear", "pull_request"} or not identifier:
                    return 0
                rows = reference_rows(kind, identifier, repository)
                if not rows and target_ids:
                    rows = []
                ids = [row["id"] for row in rows]
                for entry_id in target_ids or []:
                    if not any(row["entry_id"] == entry_id for row in rows):
                        if not allow_new:
                            continue
                        self._insert_references(connection, entry_id, [item])
                        rows = reference_rows(kind, identifier, repository)
                        changed += 1
                title = sanitize(item.get("title"), 300) or None
                status = sanitize(item.get("status"), 100) or None
                url = safe_link(str(item.get("url") or "")) if item.get("url") else None
                target = sanitize(item.get("target_branch"), 200) or None
                source = sanitize(item.get("source_branch"), 200) or None
                commit_sha = sanitize(item.get("commit_sha"), 200) or None
                metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
                for row in rows:
                    connection.execute(
                        "UPDATE external_references SET title=COALESCE(?, title), status=COALESCE(?, status), target_branch=COALESCE(?, target_branch), url=COALESCE(?, url), repository=COALESCE(?, repository), source_branch=COALESCE(?, source_branch), commit_sha=COALESCE(?, commit_sha), metadata_json=CASE WHEN ? = '{}' THEN metadata_json ELSE ? END WHERE id = ?",
                        (title, status, target, url, repository, source, commit_sha, json.dumps(metadata), json.dumps(metadata, ensure_ascii=False), row["id"]),
                    )
                    changed += 1
                return len(rows)

            requested = [item for item in references if isinstance(item, dict)]
            for item in requested:
                if any(item.get(field) for field in ("title", "status", "target_branch", "url", "repository", "source_branch", "commit_sha")):
                    apply_reference(item)
                    if not payload.get("offline"):
                        identifier = sanitize(item.get("identifier"), 200).strip()
                        if item.get("kind") in {"linear", "pull_request"} and identifier:
                            cache(item["kind"], identifier, {key: item.get(key) for key in ("kind", "identifier", "repository", "url", "title", "status", "target_branch", "source_branch", "commit_sha") if item.get(key)})
            github_records = github.get("pull_requests") or github.get("prs") or []
            github_evidence = {
                "kind": "pull_request", "repository": github.get("repository") or github.get("repo"),
                "branch": github.get("branch") or github.get("head_branch") or github.get("source_branch"),
                "commit": github.get("commit") or github.get("commit_sha") or github.get("head_sha"),
            }
            matching_requests = requested + ([github_evidence] if any(github_evidence.values()) else [])
            if github_status == "ok":
                for raw in github_records if isinstance(github_records, list) else []:
                    record = pr_record(raw)
                    if not record:
                        add_diagnostic("github", "missing_metadata", "GitHub returned a pull request without a repository or number")
                        continue
                    matches = [item for item in matching_requests if requested_pr_matches(record, item)]
                    target_ids = [int(item["entry_id"]) for item in matches if item.get("entry_id")]
                    for item in matches:
                        wanted, wanted_repo, _wanted_number = self._pull_request_identifier(item.get("identifier"), item.get("repository"), item.get("url"))
                        if wanted:
                            for row in reference_rows("pull_request", wanted, wanted_repo):
                                if row["entry_id"] not in target_ids:
                                    target_ids.append(row["entry_id"])
                        if item is github_evidence:
                            for row in connection.execute("SELECT * FROM external_references WHERE kind='pull_request'"):
                                same_repo = not item.get("repository") or row["repository"] == item.get("repository")
                                same_branch = not item.get("branch") or item["branch"] == row["source_branch"]
                                same_commit = not item.get("commit") or item["commit"] == row["commit_sha"]
                                if same_repo and same_branch and same_commit and row["entry_id"] not in target_ids:
                                    target_ids.append(row["entry_id"])
                    for row in reference_rows("pull_request", record["identifier"], record.get("repository")):
                        if row["entry_id"] not in target_ids:
                            target_ids.append(row["entry_id"])
                    cache("pull_request", record["identifier"], record)
                    if not target_ids:
                        continue
                    apply_reference(record, target_ids)
            elif github_status in {"offline", "expired_auth", "rate_limited", "error", "missing"}:
                for item in requested:
                    if item.get("kind") != "pull_request":
                        continue
                    identifier, _repo, _number = self._pull_request_identifier(item.get("identifier"), item.get("repository"), item.get("url"))
                    value = cached("pull_request", identifier, item)
                    if value:
                        apply_reference(value)
                for row in connection.execute("SELECT payload, fetched_at FROM integration_cache WHERE kind='pull_request'"):
                    try:
                        value = json.loads(row["payload"])
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(value, dict):
                        continue
                    record = pr_record(value)
                    if not record or not any(requested_pr_matches(record, item) for item in matching_requests):
                        continue
                    cache_hits += 1
                    try:
                        stale_cache = stale_cache or max(0.0, (now - parse_rfc3339(row["fetched_at"], required=True)).total_seconds()) >= float(ttl)
                    except (TypeError, ValueError, DailyError):
                        stale_cache = True
                    target_ids = [ref["entry_id"] for ref in reference_rows("pull_request", record["identifier"], record.get("repository"))]
                    apply_reference(record, target_ids)

            linear_records = linear.get("issues") or linear.get("references") or []
            github_fixture_records = []
            for raw_github in github_records if isinstance(github_records, list) else []:
                normalized_github = pr_record(raw_github)
                if normalized_github:
                    github_fixture_records.append(normalized_github)
            if linear_status == "ok":
                if isinstance(linear_records, dict):
                    linear_records = [linear_records]
                for raw in linear_records if isinstance(linear_records, list) else []:
                    if not isinstance(raw, dict):
                        add_diagnostic("linear", "missing_metadata", "Linear returned an invalid issue record")
                        continue
                    identifier = sanitize(raw.get("identifier") or raw.get("key") or raw.get("id"), 200).strip()
                    if not identifier:
                        add_diagnostic("linear", "missing_metadata", "Linear issue metadata has no identifier")
                        continue
                    issue = {"kind": "linear", "identifier": identifier, "url": safe_link(str(raw.get("url") or raw.get("web_url") or "")) or None,
                             "title": sanitize(raw.get("title") or raw.get("name"), 300) or None,
                             "status": sanitize(raw.get("status") or (raw.get("state") or {}).get("name") if isinstance(raw.get("state"), dict) else raw.get("status"), 100) or None}
                    explicit = [item for item in requested if item.get("kind") == "linear" and sanitize(item.get("identifier"), 200).strip() == identifier]
                    target_ids = [int(item["entry_id"]) for item in explicit if item.get("entry_id")]
                    for row in connection.execute("SELECT * FROM external_references WHERE kind='linear' AND identifier=?", (identifier,)):
                        if row["entry_id"] not in target_ids:
                            target_ids.append(row["entry_id"])
                    apply_reference(issue, target_ids)
                    linked = raw.get("pull_requests") or raw.get("related_pull_requests") or raw.get("links") or []
                    if isinstance(linked, dict):
                        linked = [linked]
                    linked_summaries = []
                    for linked_raw in linked if isinstance(linked, list) else []:
                        record = pr_record(linked_raw)
                        if not record:
                            add_diagnostic("linear", "missing_metadata", "Linear linked pull request is missing a repository or number")
                            continue
                        if not record.get("status") or not record.get("target_branch"):
                            for candidate in github_fixture_records:
                                if candidate["identifier"] == record["identifier"]:
                                    record = {**record, **{key: value for key, value in candidate.items() if value}}
                                    break
                        if not payload.get("offline") and (not record.get("status") or not record.get("target_branch")):
                            try:
                                from .integrations import GitHubReadOnlyAdapter
                                number = record["identifier"].rsplit("#", 1)[-1]
                                resolved = GitHubReadOnlyAdapter().resolve({"repository": record["repository"], "number": number})
                                if resolved:
                                    resolved_record = pr_record(resolved[0])
                                    if resolved_record:
                                        record = {**record, **{key: value for key, value in resolved_record.items() if value}}
                            except Exception as exc:
                                add_diagnostic("github", "linked_pull_request_unavailable", sanitize(exc, 240))
                        linked_summaries.append({key: record[key] for key in ("identifier", "repository", "url", "title", "status", "target_branch", "source_branch", "commit_sha") if record.get(key)})
                        if target_ids:
                            apply_reference(record, target_ids)
                        cache("pull_request", record["identifier"], record)
                    if linked_summaries:
                        issue["metadata"] = {"pull_requests": linked_summaries}
                        for row in connection.execute("SELECT id FROM external_references WHERE kind='linear' AND identifier=?", (identifier,)):
                            connection.execute("UPDATE external_references SET metadata_json=? WHERE id=?", (json.dumps({"pull_requests": linked_summaries}, ensure_ascii=False), row["id"]))
                    cache("linear", identifier, issue)
            elif linear_status in {"offline", "expired_auth", "rate_limited", "error", "missing"}:
                for item in requested:
                    if item.get("kind") != "linear":
                        continue
                    identifier = sanitize(item.get("identifier"), 200).strip()
                    value = cached("linear", identifier, item)
                    if value:
                        apply_reference(value)
                        linked = (value.get("metadata") or {}).get("pull_requests", []) if isinstance(value.get("metadata"), dict) else []
                        target_ids = [row["entry_id"] for row in connection.execute("SELECT entry_id FROM external_references WHERE kind='linear' AND identifier=?", (identifier,))]
                        for linked_item in linked if isinstance(linked, list) else []:
                            if isinstance(linked_item, dict):
                                apply_reference({"kind": "pull_request", **linked_item}, target_ids)

            if stale_cache:
                add_diagnostic("integrations", "stale_cache", "cached integration metadata is being used")
            if diagnostics:
                health = self.store.health()
                existing = health.get("integration_diagnostics", [])
                if not isinstance(existing, list):
                    existing = []
                health["integration_diagnostics"] = (diagnostics + [item for item in existing if item not in diagnostics])[:20]
                self.store.save_health(health)
            connection.commit()
            return {"status": "changed" if changed else "noop", "references_enriched": changed,
                    "cache_hits": cache_hits, "diagnostics": diagnostics, "read_only": True, "external_writes": 0}
        except Exception as exc:
            connection.rollback()
            add_diagnostic("integrations", "adapter_failure", sanitize(exc, 240))
            health = self.store.health()
            existing = health.get("integration_diagnostics", [])
            health["integration_diagnostics"] = ([diagnostics[-1]] if diagnostics else [{"provider": "integrations", "code": "adapter_failure", "message": sanitize(exc, 240)}]) + (existing if isinstance(existing, list) else [])
            self.store.save_health(health)
            return {"status": "noop", "references_enriched": 0, "cache_hits": cache_hits,
                    "diagnostics": diagnostics or [{"provider": "integrations", "code": "adapter_failure", "message": sanitize(exc, 240)}],
                    "read_only": True, "external_writes": 0}
        finally:
            connection.close()

    def edit_entry(self, entry_id: int, text: str | None, state: str | None, at: str | None, hidden: bool | None = None) -> dict[str, Any]:
        connection = self.store.connect()
        try:
            row = connection.execute("SELECT * FROM work_entries WHERE id = ?", (entry_id,)).fetchone()
            if not row:
                raise DailyError("work entry not found")
            values: dict[str, Any] = {}
            if text is not None:
                values["text"] = sanitize(text, 500)
            if state is not None:
                values["state"] = self._normalise_state(state)
            if at is not None:
                values["event_time_utc"] = iso(parse_rfc3339(at, required=True))
            if hidden is not None:
                values["hidden"] = int(hidden)
            if not values:
                return {"status": "noop", "entry": self.entry_dict(connection, entry_id)}
            fields = list(values)
            values["updated_at"] = iso(utc_now())
            fields.append("updated_at")
            values["curated_json"] = json.dumps({**json.loads(row["curated_json"] or "{}"), **{field: True for field in fields if field != "updated_at"}})
            fields.append("curated_json")
            assignments = ", ".join(f"{field} = ?" for field in fields)
            connection.execute(f"UPDATE work_entries SET {assignments} WHERE id = ?", [values[field] for field in fields] + [entry_id])
            connection.commit()
            return {"status": "changed", "entry": self.entry_dict(connection, entry_id)}
        finally:
            connection.close()

    def source_evidence(self, action: str, evidence_id: int) -> dict[str, Any]:
        connection = self.store.connect()
        try:
            row = connection.execute("SELECT * FROM source_evidence WHERE id = ?", (evidence_id,)).fetchone()
            if not row:
                raise DailyError("source evidence not found")
            if action == "delete":
                connection.execute("DELETE FROM source_evidence WHERE id = ?", (evidence_id,))
            elif action == "disable":
                connection.execute("UPDATE source_evidence SET disabled = 1 WHERE id = ?", (evidence_id,))
                config = self.store.config()
                config["source_evidence_enabled"] = False
                self.store.save_config(config)
            else:
                raise DailyError("unknown evidence action")
            connection.commit()
            return {"status": "changed", "evidence_id": evidence_id, "action": action}
        finally:
            connection.close()

    def project(self, action: str, path: str | None = None) -> dict[str, Any]:
        config = self.store.config()
        projects = [str(Path(item).expanduser().resolve()) for item in config.get("tracked_projects", [])]
        if action in {"add", "remove"}:
            if not path:
                raise DailyError("project path is required")
            resolved = str(Path(path).expanduser().resolve())
            if action == "add" and resolved not in projects:
                projects.append(resolved)
            elif action == "remove":
                projects = [item for item in projects if item != resolved]
            else:
                return {"status": "noop", "tracked_projects": projects}
            config["tracked_projects"] = projects
            self.store.save_config(config)
            return {"status": "changed", "tracked_projects": projects}
        if action == "list":
            return {"status": "noop", "tracked_projects": projects}
        raise DailyError("project action must be add, remove, or list")

    def calendar_exception(self, day: str, non_working: bool, meeting_date: str | None) -> dict[str, Any]:
        try:
            dt.date.fromisoformat(day)
            if meeting_date:
                dt.date.fromisoformat(meeting_date)
        except ValueError as exc:
            raise DailyError("calendar dates must use YYYY-MM-DD") from exc
        connection = self.store.connect()
        try:
            connection.execute("INSERT INTO calendar_exceptions(day, non_working, meeting_date) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET non_working=excluded.non_working, meeting_date=excluded.meeting_date", (day, int(non_working), meeting_date))
            connection.commit()
            return {"status": "changed", "day": day, "non_working": non_working, "meeting_date": meeting_date}
        finally:
            connection.close()

    def retention(self, at: str | None = None) -> dict[str, Any]:
        moment = parse_rfc3339(at, required=bool(at))
        connection = self.store.connect()
        try:
            evidence_cutoff = iso(moment - dt.timedelta(days=30))
            inbox_cutoff = iso(moment - dt.timedelta(days=7))
            evidence_count = connection.execute("DELETE FROM source_evidence WHERE expires_at <= ?", (evidence_cutoff,)).rowcount
            dismissed_count = connection.execute("DELETE FROM candidates WHERE status = 'dismissed' AND created_at <= ?", (inbox_cutoff,)).rowcount
            connection.commit()
            return {"status": "changed" if evidence_count or dismissed_count else "noop", "source_evidence_deleted": evidence_count, "dismissed_inbox_deleted": dismissed_count}
        finally:
            connection.close()

    def export_state(self, output: str | None = None) -> dict[str, Any]:
        connection = self.store.connect()
        try:
            payload = {"format": "daily-worklog-json", "version": 1, "config": self.store.config(), "reporting_periods": [dict(row) for row in connection.execute("SELECT * FROM reporting_periods")], "work_sessions": [dict(row) for row in connection.execute("SELECT * FROM work_sessions")], "candidates": [dict(row) for row in connection.execute("SELECT * FROM candidates")], "work_entries": [dict(row) for row in connection.execute("SELECT * FROM work_entries")], "external_references": [dict(row) for row in connection.execute("SELECT * FROM external_references")], "integration_cache": [dict(row) for row in connection.execute("SELECT * FROM integration_cache")], "calendar_exceptions": [dict(row) for row in connection.execute("SELECT * FROM calendar_exceptions")], "source_evidence": [dict(row) for row in connection.execute("SELECT * FROM source_evidence")], "exported_at": iso(utc_now())}
        finally:
            connection.close()
        if output:
            write_private(Path(output).expanduser(), json.dumps(payload, indent=2) + "\n")
        return payload

    def import_state(self, source: str, replace: bool, confirm: bool) -> dict[str, Any]:
        if replace and not confirm:
            raise DailyError("replacement import requires --confirm")
        payload = json_load(Path(source).expanduser(), None)
        if not isinstance(payload, dict) or payload.get("format") != "daily-worklog-json" or payload.get("version") != 1:
            raise DailyError("invalid Daily Worklog export")
        required = ("reporting_periods", "work_sessions", "candidates", "work_entries", "external_references", "calendar_exceptions", "source_evidence")
        if any(not isinstance(payload.get(key), list) for key in required):
            raise DailyError("invalid Daily Worklog export collections")
        if replace:
            self.backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            backup = self.backup_dir / f"before-import-{dt.datetime.now().strftime('%Y%m%d%H%M%S')}.sqlite3"
            shutil.copy2(self.store.db_path, backup)
            os.chmod(backup, 0o600)
        connection = self.store.connect()
        try:
            if replace:
                for table in ("external_references", "integration_cache", "source_evidence", "work_entries", "candidates", "work_sessions", "reporting_periods", "calendar_exceptions"):
                    connection.execute(f"DELETE FROM {table}")
            # Validate all referenced IDs and values before transaction commit.
            for period in payload["reporting_periods"]:
                if period.get("status") not in {"active", "archived"}:
                    raise DailyError("invalid reporting period status")
                connection.execute("INSERT OR REPLACE INTO reporting_periods(id, meeting_date, status, created_at, archived_at) VALUES (?, ?, ?, ?, ?)", tuple(period.get(key) for key in ("id", "meeting_date", "status", "created_at", "archived_at")))
            for session in payload["work_sessions"]:
                connection.execute("INSERT OR REPLACE INTO work_sessions(id, period_id, session_date, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)", tuple(session.get(key) for key in ("id", "period_id", "session_date", "kind", "started_at", "ended_at")))
            for candidate in payload["candidates"]:
                connection.execute("INSERT OR REPLACE INTO candidates(id, identity, agent, session_id, turn_id, parent_turn_id, project_root, completion_utc, period_id, text, evidence, references_json, status, disposition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(candidate.get(key) for key in ("id", "identity", "agent", "session_id", "turn_id", "parent_turn_id", "project_root", "completion_utc", "period_id", "text", "evidence", "references_json", "status", "disposition", "created_at")))
            for entry in payload["work_entries"]:
                connection.execute("INSERT OR REPLACE INTO work_entries(id, period_id, candidate_id, text, state, event_time_utc, created_at, updated_at, hidden, unreviewed, manual, curated_json, dismissed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tuple(entry.get(key) for key in ("id", "period_id", "candidate_id", "text", "state", "event_time_utc", "created_at", "updated_at", "hidden", "unreviewed", "manual", "curated_json", "dismissed_at")))
            for reference in payload["external_references"]:
                reference_values = tuple(reference.get(key) for key in ("id", "entry_id", "kind", "identifier", "url", "title", "status", "target_branch", "repository", "source_branch", "commit_sha")) + (reference.get("metadata_json") or "{}",)
                connection.execute("INSERT OR REPLACE INTO external_references(id, entry_id, kind, identifier, url, title, status, target_branch, repository, source_branch, commit_sha, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", reference_values)
            for cache in payload.get("integration_cache", []):
                connection.execute("INSERT OR REPLACE INTO integration_cache(kind, identifier, payload, fetched_at) VALUES (?, ?, ?, ?)", tuple(cache.get(key) for key in ("kind", "identifier", "payload", "fetched_at")))
            for exception in payload["calendar_exceptions"]:
                connection.execute("INSERT OR REPLACE INTO calendar_exceptions(day, non_working, meeting_date) VALUES (?, ?, ?)", tuple(exception.get(key) for key in ("day", "non_working", "meeting_date")))
            for evidence in payload["source_evidence"]:
                connection.execute("INSERT OR REPLACE INTO source_evidence(id, candidate_id, entry_id, text, disabled, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", tuple(evidence.get(key) for key in ("id", "candidate_id", "entry_id", "text", "disabled", "created_at", "expires_at")))
            connection.commit()
            return {"status": "changed", "replacement": replace, "reports": len(payload["reporting_periods"])}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def uninstall(self, confirm: bool) -> dict[str, Any]:
        if not confirm:
            raise DailyError("uninstall requires --confirm; reports are preserved")
        for path in self._hook_paths():
            original = json_load(path, None)
            if not isinstance(original, dict) or not isinstance(original.get("hooks"), list):
                continue
            original["hooks"] = [item for item in original["hooks"] if not (isinstance(item, dict) and (item.get("id") == "daily-worklog" or "dailyctl capture" in str(item.get("command", ""))))]
            write_private(path, json.dumps(original, indent=2) + "\n")
        launcher = Path(os.environ.get("XDG_BIN_HOME", Path.home() / ".local/bin")) / "dailyctl"
        launcher.unlink(missing_ok=True)
        health = self.store.health()
        health["capture_enabled"] = False
        self.store.save_health(health)
        return {"status": "changed", "reports_preserved": self.store.db_path.exists(), "launcher_removed": True}

    def delete_report(self, meeting_date: str, confirm: bool) -> dict[str, Any]:
        if not confirm:
            raise DailyError("report deletion requires --confirm")
        connection = self.store.connect()
        try:
            period = connection.execute("SELECT id FROM reporting_periods WHERE meeting_date = ?", (meeting_date,)).fetchone()
            if not period:
                return {"status": "noop", "meeting_date": meeting_date}
            entry_ids = [row["id"] for row in connection.execute("SELECT id FROM work_entries WHERE period_id = ?", (period["id"],))]
            for entry_id in entry_ids:
                connection.execute("DELETE FROM source_evidence WHERE entry_id = ?", (entry_id,))
                connection.execute("DELETE FROM external_references WHERE entry_id = ?", (entry_id,))
            connection.execute("DELETE FROM work_entries WHERE period_id = ?", (period["id"],))
            connection.execute("UPDATE candidates SET period_id = NULL WHERE period_id = ?", (period["id"],))
            connection.execute("DELETE FROM work_sessions WHERE period_id = ?", (period["id"],))
            connection.execute("DELETE FROM reporting_periods WHERE id = ?", (period["id"],))
            connection.commit()
            return {"status": "changed", "meeting_date": meeting_date, "entries_deleted": len(entry_ids)}
        finally:
            connection.close()

    def markdown(self, meeting_date: str | None = None) -> str:
        data = self.report(meeting_date, present=True)
        groups = {state: [entry for entry in data["entries"] if entry["state"] == state] for state in ("Done", "In progress", "Blocked")}
        lines = [f"# Daily Worklog — {data['reporting_period']['meeting_date'] if data.get('reporting_period') else 'No report'}", ""]
        for state in groups:
            lines.extend([f"## {state}", ""])
            for entry in groups[state]:
                suffix = ""
                links = [ref.get("url") or ref.get("identifier") for ref in entry.get("references", [])]
                if links:
                    suffix = " — " + ", ".join(links)
                lines.append(f"- {entry['text']}{suffix}")
            if not groups[state]:
                lines.append("- None")
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"


class BoardHandler(http.server.BaseHTTPRequestHandler):
    server_version = "DailyWorklog/1"

    @property
    def runtime(self) -> Runtime:
        return self.server.runtime  # type: ignore[attr-defined]

    def log_message(self, *_args: Any) -> None:
        return

    def _security(self) -> None:
        self.send_header("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

    def _json(self, value: Any, status: int = 200, cookie: str | None = None) -> None:
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self._security()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _html(self, body: str, status: int = 200) -> None:
        content = body.encode()
        self.send_response(status)
        self._security()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _host_ok(self) -> bool:
        return self.headers.get("Host", "").split(":", 1)[0] in {"127.0.0.1", "localhost", "::1"}

    def _session(self) -> dict[str, str] | None:
        cookies = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        value = cookies.get("daily_session")
        return self.server.sessions.get(value.value) if value else None  # type: ignore[attr-defined]

    def _mutation_allowed(self, body: dict[str, Any]) -> bool:
        if not self._host_ok() or self.client_address[0] not in {"127.0.0.1", "::1"}:
            return False
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
            return False
        origin = self.headers.get("Origin")
        referer = self.headers.get("Referer")
        expected = f"http://127.0.0.1:{self.server.server_port}"  # type: ignore[attr-defined]
        if origin and origin != expected:
            return False
        if referer and not referer.startswith(expected + "/"):
            return False
        session = self._session()
        supplied_csrf = body.get("csrf") or self.headers.get("X-CSRF-Token", "")
        return bool(session and secrets.compare_digest(str(supplied_csrf), session["csrf"]))

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 100_000:
            raise DailyError("request body too large")
        try:
            value = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise DailyError("request body must be JSON") from exc
        if not isinstance(value, dict):
            raise DailyError("request body must be a JSON object")
        return value

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if not self._host_ok():
            self._json({"error": "unexpected host"}, 400)
            return
        if parsed.path == "/bootstrap":
            query = urllib.parse.parse_qs(parsed.query)
            token = query.get("token", [""])[0]
            if not secrets.compare_digest(token, self.server.bootstrap_token):  # type: ignore[attr-defined]
                self._json({"error": "invalid or already used bootstrap token"}, 403)
                return
            self.server.bootstrap_token = secrets.token_urlsafe(32)  # type: ignore[attr-defined]
            info_path = server_info_path(self.runtime.store)
            info = json_load(info_path, {})
            if isinstance(info, dict):
                info["token"] = self.server.bootstrap_token  # type: ignore[attr-defined]
                write_private(info_path, json.dumps(info) + "\n")
            session_id = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(24)
            self.server.sessions[session_id] = {"csrf": csrf, "created": str(time.time())}  # type: ignore[attr-defined]
            cookie = f"daily_session={session_id}; HttpOnly; SameSite=Strict; Path=/"
            self._json({"status": "changed", "csrf": csrf, "mode": "prepare"}, cookie=cookie)
            return
        session = self._session()
        if parsed.path.startswith("/api/") and not session:
            self._json({"error": "authentication required"}, 401)
            return
        if parsed.path == "/api/present":
            self._json(self.runtime.report(urllib.parse.parse_qs(parsed.query).get("meeting_date", [None])[0], present=True))
        elif parsed.path == "/present":
            self._json(self.runtime.report(urllib.parse.parse_qs(parsed.query).get("meeting_date", [None])[0], present=True))
        elif parsed.path == "/api/prepare":
            self._json(self.runtime.report(urllib.parse.parse_qs(parsed.query).get("meeting_date", [None])[0], present=False))
        elif parsed.path == "/api/copy":
            value = self.runtime.markdown(urllib.parse.parse_qs(parsed.query).get("meeting_date", [None])[0])
            self._json({"markdown": value})
        elif parsed.path == "/api/health":
            self._json(self.runtime.store.health())
        elif parsed.path == "/api/reports":
            connection = self.runtime.store.connect()
            try:
                self._json({"reports": [dict(row) for row in connection.execute("SELECT meeting_date, status, archived_at FROM reporting_periods ORDER BY meeting_date DESC")]})
            finally:
                connection.close()
        elif parsed.path == "/style.css":
            self._css()
        elif parsed.path == "/":
            report = self.runtime.report(present=True)
            cards = ""
            for item in report.get("entries", []):
                links = "".join(f"<a href='{html.escape(ref['url'], quote=True)}' rel='noreferrer noopener'>{html.escape(ref.get('title') or ref['identifier'])}</a>" for ref in item.get("references", []) if ref.get("url"))
                cards += f"<article class='entry {html.escape(item['state'].lower().replace(' ', '-'))}'><span>{html.escape(item['state'])}</span><time>{html.escape(item.get('display_time', ''))}</time><p>{html.escape(item['text'])}</p><div class='refs'>{links}</div></article>"
            sessions = "".join(f"<span class='session'>{html.escape(item['session_date'])} · {html.escape(item['kind'])}</span>" for item in report.get("sessions", []))
            summary = report.get("summary", {})
            self._html(f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width'><link rel='stylesheet' href='/style.css'><title>Daily Worklog</title></head><body><main><header><p class='eyebrow'>DISPATCH BOARD · WORK TRAIL</p><h1>Daily Worklog</h1><p>Meeting date: {html.escape(str(report.get('reporting_period', {}).get('meeting_date', '')))}</p><div class='summary'><span>{summary.get('outcomes', 0)} outcomes</span><span>{summary.get('issues', 0)} issues</span><span>{summary.get('pull_requests', 0)} pull requests</span></div></header><section aria-label='Work sessions' class='rail'>{sessions}<span class='pause'>overnight pause</span></section><section aria-label='Outcomes' class='cards'>{cards}</section></main></body></html>")
        else:
            self._json({"error": "not found"}, 404)

    def _css(self) -> None:
        body = b"""*{box-sizing:border-box}body{margin:0;background:#f5f1e8;color:#202b2d;font:16px system-ui,sans-serif}main{max-width:980px;margin:auto;padding:48px 24px}.eyebrow,time,.summary,.session,.pause{font:12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.eyebrow{color:#a45132}h1{font:clamp(2.5rem,8vw,5.5rem);line-height:.9;margin:.2em 0}header{border-bottom:1px solid #b9b3a7;padding-bottom:24px}.summary{display:flex;gap:24px;margin-top:26px}.rail{display:flex;align-items:center;gap:12px;padding:24px 0;color:#667174}.pause{border-left:1px dashed #a45132;padding-left:16px;color:#a45132}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.entry{background:#fffdf8;border:1px solid #d9d1c3;border-left:5px solid #31745b;padding:18px;min-height:130px;box-shadow:0 5px 0 #e5ddd0}.entry.in-progress{border-left-color:#b27a29}.entry.blocked{border-left-color:#a45132}.entry span{font:12px ui-monospace,monospace;text-transform:uppercase}.entry time{float:right;color:#667174}.entry p{font-size:18px;line-height:1.3}.refs a{color:#145f75;margin-right:10px}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}"""
        self.send_response(200)
        self._security()
        self.send_header("Content-Type", "text/css; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        try:
            body = self._body()
            if not self._mutation_allowed(body):
                self._json({"error": "request rejected"}, 403)
                return
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/entry":
                result = self.runtime.note(body.get("text", ""), body.get("state", "Done"), body.get("at"), body.get("linear", []), body.get("pull_requests", []))
            elif path.startswith("/api/entry/"):
                result = self.runtime.edit_entry(int(path.rsplit("/", 1)[1]), body.get("text"), body.get("state"), body.get("at"), body.get("hidden"))
            elif path == "/api/shutdown":
                result = {"status": "changed"}
                threading.Thread(target=self.server.shutdown, daemon=True).start()  # type: ignore[attr-defined]
            else:
                self._json({"error": "not found"}, 404)
                return
            self._json(result)
        except (DailyError, ValueError) as exc:
            self._json({"error": str(exc)}, 400)


class BoardServer(http.server.ThreadingHTTPServer):
    # Reuse a recently closed Daily Worklog socket; an active foreign listener
    # is still rejected by bind and reported as a collision.
    allow_reuse_address = True

    def __init__(self, runtime: Runtime, port: int, bootstrap_token: str | None = None) -> None:
        super().__init__(("127.0.0.1", port), BoardHandler)
        self.runtime = runtime
        self.bootstrap_token = bootstrap_token or secrets.token_urlsafe(32)
        self.sessions: dict[str, dict[str, str]] = {}


def serve(runtime: Runtime, port: int, token: str | None = None) -> None:
    try:
        server = BoardServer(runtime, port, token)
    except OSError as exc:
        raise DailyError(f"could not bind Daily Worklog to loopback port {port}: {exc}") from exc
    signal.signal(signal.SIGTERM, lambda *_args: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    finally:
        server.server_close()


def server_info_path(store: Store) -> Path:
    return store.state_dir / "server.json"


def process_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        return False


def port_is_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.15)
        return client.connect_ex(("127.0.0.1", port)) == 0


def emit(value: Any, machine: bool) -> None:
    if machine:
        print(json.dumps(value, ensure_ascii=False, sort_keys=True))
    elif isinstance(value, dict):
        print(value.get("message") or value.get("status") or json.dumps(value, ensure_ascii=False, indent=2))
    else:
        print(value)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dailyctl", description="Private Daily Worklog runtime")
    p.add_argument("--json", action="store_true", dest="machine")
    sub = p.add_subparsers(dest="command")
    setup = sub.add_parser("setup"); setup.add_argument("--at"); setup.add_argument("--project"); setup.add_argument("--port", type=int, default=8765)
    for action in ("start", "stop", "continue"):
        command = sub.add_parser(action); command.add_argument("--at", required=True)
    note = sub.add_parser("note"); note.add_argument("text"); note.add_argument("--state", default="Done"); note.add_argument("--at"); note.add_argument("--linear", action="append", default=[]); note.add_argument("--pr", "--pull-request", dest="prs", action="append", default=[])
    capture = sub.add_parser("capture"); capture.add_argument("--input", action="store_true", help=argparse.SUPPRESS)
    sub.add_parser("curate-export")
    sub.add_parser("report").add_argument("--meeting-date")
    sub.add_parser("reports")
    sub.add_parser("present").add_argument("--meeting-date")
    commit = sub.add_parser("curate-commit"); commit.add_argument("--input", action="store_true", help=argparse.SUPPRESS)
    project = sub.add_parser("project"); project.add_argument("action", choices=("add", "remove", "list")); project.add_argument("path", nargs="?")
    calendar = sub.add_parser("calendar-exception"); calendar.add_argument("day"); calendar.add_argument("--non-working", action="store_true"); calendar.add_argument("--meeting-date")
    triage = sub.add_parser("inbox"); triage.add_argument("action", choices=("attach", "dismiss", "restore")); triage.add_argument("candidate_id", type=int); triage.add_argument("--meeting-date")
    merge = sub.add_parser("merge"); merge.add_argument("target_id", type=int); merge.add_argument("source_ids", nargs="+", type=int)
    enrich = sub.add_parser("enrich"); enrich.add_argument("--input", action="store_true", help=argparse.SUPPRESS)
    edit = sub.add_parser("edit"); edit.add_argument("entry_id", type=int); edit.add_argument("--text"); edit.add_argument("--state"); edit.add_argument("--at"); edit.add_argument("--hide", action="store_true"); edit.add_argument("--restore", action="store_true")
    evidence = sub.add_parser("evidence"); evidence.add_argument("action", choices=("delete", "disable")); evidence.add_argument("evidence_id", type=int)
    retention = sub.add_parser("retention"); retention.add_argument("--at")
    export = sub.add_parser("export"); export.add_argument("--output")
    imp = sub.add_parser("import"); imp.add_argument("source"); imp.add_argument("--replace", action="store_true"); imp.add_argument("--confirm", action="store_true")
    uninstall = sub.add_parser("uninstall"); uninstall.add_argument("--confirm", action="store_true")
    delete_report = sub.add_parser("delete-report"); delete_report.add_argument("meeting_date"); delete_report.add_argument("--confirm", action="store_true")
    sub.add_parser("copy").add_argument("--meeting-date")
    sub.add_parser("view")
    serve_cmd = sub.add_parser("serve", help=argparse.SUPPRESS); serve_cmd.add_argument("--port", type=int); serve_cmd.add_argument("--token")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    command = args.command or "view"
    runtime = Runtime()
    try:
        if command == "setup":
            result = runtime.setup(args.at, args.project, args.port)
        elif command in {"start", "stop", "continue"}:
            result = runtime.lifecycle(command, args.at)
        elif command == "note":
            result = runtime.note(args.text, args.state, args.at, args.linear, args.prs)
        elif command == "capture":
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as exc:
                runtime.store.warning("capture received malformed JSON")
                result = {"status": "discarded", "reason": "invalid_json"}
            else:
                result = runtime.capture(payload)
        elif command == "curate-export":
            result = runtime.curate_export()
        elif command == "curate-commit":
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as exc:
                raise DailyError("curation input must be JSON") from exc
            result = runtime.curate_commit(payload)
        elif command == "report":
            result = runtime.report(args.meeting_date)
        elif command == "reports":
            connection = runtime.store.connect()
            try:
                result = {"status": "noop", "reports": [dict(row) for row in connection.execute("SELECT meeting_date, status, archived_at FROM reporting_periods ORDER BY meeting_date DESC")]}
            finally:
                connection.close()
        elif command == "present":
            result = runtime.report(args.meeting_date, present=True)
        elif command == "copy":
            result = {"status": "changed", "markdown": runtime.markdown(args.meeting_date)}
        elif command == "project":
            result = runtime.project(args.action, args.path)
        elif command == "calendar-exception":
            result = runtime.calendar_exception(args.day, args.non_working, args.meeting_date)
        elif command == "inbox":
            result = runtime.triage(args.action, args.candidate_id, args.meeting_date)
        elif command == "merge":
            result = runtime.merge_entries(args.target_id, args.source_ids)
        elif command == "enrich":
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as exc:
                raise DailyError("enrichment input must be JSON") from exc
            result = runtime.enrich(payload)
        elif command == "edit":
            hidden = True if args.hide else False if args.restore else None
            result = runtime.edit_entry(args.entry_id, args.text, args.state, args.at, hidden)
        elif command == "evidence":
            result = runtime.source_evidence(args.action, args.evidence_id)
        elif command == "retention":
            result = runtime.retention(args.at)
        elif command == "export":
            result = runtime.export_state(args.output)
        elif command == "import":
            result = runtime.import_state(args.source, args.replace, args.confirm)
        elif command == "uninstall":
            result = runtime.uninstall(args.confirm)
        elif command == "delete-report":
            result = runtime.delete_report(args.meeting_date, args.confirm)
        elif command == "serve":
            port = args.port or int(runtime.store.config().get("port", 8765))
            serve(runtime, port, args.token)
            return 0
        elif command == "view":
            config = runtime.store.config()
            port = int(config.get("port", 8765))
            info_path = server_info_path(runtime.store)
            info = json_load(info_path, {})
            if info.get("pid") and process_alive(info.get("pid")) and port_is_open(port):
                token = info.get("token")
                if not token:
                    raise DailyError("existing Daily Worklog server has no bootstrap token")
                result = {"status": "noop", "url": f"http://127.0.0.1:{port}/bootstrap?token={urllib.parse.quote(token)}", "mode": "prepare"}
                emit(result, args.machine)
                return 0
            if port_is_open(port):
                raise DailyError(f"Daily Worklog port {port} is already in use")
            token = secrets.token_urlsafe(32)
            runtime.store.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            command_path = Path(__file__).resolve().parents[1] / "scripts" / "dailyctl"
            process = subprocess.Popen([sys.executable, str(command_path), "serve", "--port", str(port), "--token", token], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
            write_private(info_path, json.dumps({"pid": process.pid, "port": port, "token": token, "started_at": iso(utc_now())}) + "\n")
            for _ in range(50):
                if port_is_open(port):
                    break
                if process.poll() is not None:
                    raise DailyError(f"Daily Worklog server exited while starting (code {process.returncode})")
                time.sleep(0.02)
            else:
                raise DailyError(f"Daily Worklog server did not open loopback port {port}")
            url = f"http://127.0.0.1:{port}/bootstrap?token={urllib.parse.quote(token)}"
            result = {"status": "changed", "url": url, "mode": "prepare", "pid": process.pid}
        else:
            raise DailyError(f"unknown command: {command}")
        emit(result, args.machine)
        return 0
    except DailyError as exc:
        emit({"status": "error", "error": str(exc)}, args.machine)
        return 2
    except (OSError, sqlite3.Error) as exc:
        emit({"status": "error", "error": sanitize(exc, 240)}, args.machine)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
