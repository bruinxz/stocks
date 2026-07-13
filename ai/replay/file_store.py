"""Atomic durable single-host ReplayJobStore.

The store uses an explicit JSON state file plus a separate advisory lock file.
Writes use fsync + atomic replace; compare-and-swap transitions happen while
holding the inter-process lock.  No provider, HTTP, or database side effect is
performed.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import secrets
import stat
from typing import Iterator, Optional
import weakref

from ai.replay.service import ReplayConflictError, ReplayService, ReplayServiceError
from ai.replay.types import ReplayJob, ReplayPins


class ReplayJobStoreConfigurationError(ValueError):
    pass


class ReplayJobStoreCorruptError(RuntimeError):
    pass


class AtomicFileReplayJobStore:
    VERSION = 1

    def __init__(self, path: str | Path):
        self._path = Path(path)
        if not self._path.is_absolute():
            raise ReplayJobStoreConfigurationError(
                "replay job store path must be absolute"
            )
        if self._path.name in {"", ".", ".."}:
            raise ReplayJobStoreConfigurationError(
                "replay job store filename is invalid"
            )
        self._name = self._path.name
        self._lock_name = self._name + ".lock"
        self._parent_fd, self._parent_identity = self._open_secure_parent(
            self._path.parent
        )
        self._finalizer = weakref.finalize(self, os.close, self._parent_fd)
        try:
            self._validate_existing_file(self._name, "replay job store")
            self._validate_existing_file(self._lock_name, "replay job lock")
            if not self._exists(self._name):
                with self._locked():
                    if not self._exists(self._name):
                        self._write(
                            {"version": self.VERSION, "jobs": {}, "keys": {}}
                        )
        except Exception:
            self.close()
            raise

    def create_or_get(self, job: ReplayJob) -> tuple[ReplayJob, bool]:
        self._validate_proposed(job)
        with self._locked():
            state = self._read()
            existing_id = state["keys"].get(job.idempotency_key)
            if existing_id is not None:
                return self._decode(state["jobs"][existing_id]), False
            if job.job_id in state["jobs"]:
                raise ReplayConflictError("replay job_id already exists")
            state["jobs"][job.job_id] = self._encode(job)
            state["keys"][job.idempotency_key] = job.job_id
            self._write(state)
            return job, True

    def get(self, job_id: str) -> Optional[ReplayJob]:
        with self._locked():
            raw = self._read()["jobs"].get(job_id)
            return self._decode(raw) if raw is not None else None

    def transition(
        self, job_id: str, expected_status: str, updated: ReplayJob
    ) -> ReplayJob:
        self._validate_proposed(updated)
        with self._locked():
            state = self._read()
            raw = state["jobs"].get(job_id)
            if raw is None:
                raise ReplayConflictError("replay job does not exist")
            current = self._decode(raw)
            if current.status != expected_status:
                raise ReplayConflictError(
                    "compare-and-swap transition failed"
                )
            if (
                updated.job_id != current.job_id
                or updated.idempotency_key != current.idempotency_key
                or updated.pins != current.pins
                or updated.created_at != current.created_at
            ):
                raise ReplayConflictError(
                    "transition changed immutable replay job fields"
                )
            state["jobs"][job_id] = self._encode(updated)
            self._write(state)
            return updated

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self._verify_parent()
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(
                self._lock_name,
                flags,
                0o600,
                dir_fd=self._parent_fd,
            )
        except OSError as error:
            raise ReplayJobStoreConfigurationError(
                "replay job lock is not a safe regular file"
            ) from error
        try:
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
            ):
                raise ReplayJobStoreConfigurationError(
                    "replay job lock must be a 0600 regular file"
                )
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read(self) -> dict:
        self._verify_parent()
        try:
            descriptor = os.open(
                self._name,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=self._parent_fd,
            )
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
            ):
                raise ReplayJobStoreCorruptError(
                    "replay job store must be a 0600 regular file"
                )
            with os.fdopen(
                descriptor, "r", encoding="utf-8", closefd=False
            ) as handle:
                raw = json.load(
                    handle,
                    object_pairs_hook=self._strict_object,
                    parse_constant=self._reject_constant,
                )
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ReplayJobStoreCorruptError(
                "replay job store is unreadable"
            ) from error
        finally:
            if "descriptor" in locals() and descriptor >= 0:
                os.close(descriptor)
        if (
            not isinstance(raw, dict)
            or set(raw) != {"version", "jobs", "keys"}
            or isinstance(raw.get("version"), bool)
            or raw.get("version") != self.VERSION
            or not isinstance(raw.get("jobs"), dict)
            or not isinstance(raw.get("keys"), dict)
        ):
            raise ReplayJobStoreCorruptError(
                "replay job store has invalid structure"
            )
        for key, job_id in raw["keys"].items():
            if (
                not isinstance(key, str)
                or not isinstance(job_id, str)
                or job_id not in raw["jobs"]
            ):
                raise ReplayJobStoreCorruptError(
                    "replay job idempotency index is corrupt"
                )
        decoded_jobs = {}
        for job_id, record in raw["jobs"].items():
            if not isinstance(job_id, str):
                raise ReplayJobStoreCorruptError(
                    "replay job index contains a non-string key"
                )
            job = self._decode(record)
            if job.job_id != job_id:
                raise ReplayJobStoreCorruptError(
                    "replay job identity index is corrupt"
                )
            decoded_jobs[job_id] = job
        if len(set(raw["keys"].values())) != len(raw["keys"]):
            raise ReplayJobStoreCorruptError(
                "replay job idempotency index is not one-to-one"
            )
        if set(raw["keys"].values()) != set(decoded_jobs):
            raise ReplayJobStoreCorruptError(
                "replay job idempotency index is incomplete"
            )
        for key, job_id in raw["keys"].items():
            if decoded_jobs[job_id].idempotency_key != key:
                raise ReplayJobStoreCorruptError(
                    "replay job idempotency index does not match record"
                )
        return raw

    @staticmethod
    def _strict_object(pairs) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ReplayJobStoreCorruptError(
                    "replay job store contains duplicate object keys"
                )
            result[key] = value
        return result

    @staticmethod
    def _reject_constant(_value: str):
        raise ReplayJobStoreCorruptError(
            "replay job store contains a non-finite number"
        )

    def _write(self, state: dict) -> None:
        self._verify_parent()
        payload = json.dumps(
            state,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        temp_name = "." + self._name + "." + secrets.token_hex(16) + ".tmp"
        descriptor = os.open(
            temp_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=self._parent_fd,
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            descriptor = -1
            os.replace(
                temp_name,
                self._name,
                src_dir_fd=self._parent_fd,
                dst_dir_fd=self._parent_fd,
            )
            os.fsync(self._parent_fd)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temp_name, dir_fd=self._parent_fd)
            except FileNotFoundError:
                pass

    def _validate_existing_file(self, name: str, label: str) -> None:
        try:
            metadata = os.stat(
                name,
                dir_fd=self._parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise ReplayJobStoreConfigurationError(
                f"{label} must be a 0600 regular file"
            )

    def _exists(self, name: str) -> bool:
        try:
            os.stat(
                name,
                dir_fd=self._parent_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return False
        return True

    @staticmethod
    def _open_secure_parent(parent: Path) -> tuple[int, tuple[int, int]]:
        no_follow = getattr(os, "O_NOFOLLOW", 0)
        directory_flag = getattr(os, "O_DIRECTORY", 0)
        if not no_follow or not directory_flag:
            raise ReplayJobStoreConfigurationError(
                "secure directory descriptors are unsupported"
            )
        parts = parent.parts
        if not parts or parts[0] != parent.anchor or ".." in parts:
            raise ReplayJobStoreConfigurationError(
                "replay job store parent path is invalid"
            )
        descriptor = os.open(
            parent.anchor,
            os.O_RDONLY | directory_flag | no_follow,
        )
        try:
            for component in parts[1:]:
                if component in {"", ".", ".."}:
                    raise ReplayJobStoreConfigurationError(
                        "replay job store parent path is invalid"
                    )
                try:
                    child = os.open(
                        component,
                        os.O_RDONLY | directory_flag | no_follow,
                        dir_fd=descriptor,
                    )
                except OSError as error:
                    raise ReplayJobStoreConfigurationError(
                        "replay job store parent must contain no symlinks"
                    ) from error
                os.close(descriptor)
                descriptor = child
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) & 0o022
            ):
                raise ReplayJobStoreConfigurationError(
                    "replay job store parent ownership or mode is unsafe"
                )
            return descriptor, (metadata.st_dev, metadata.st_ino)
        except Exception:
            os.close(descriptor)
            raise

    def _verify_parent(self) -> None:
        if not self._finalizer.alive:
            raise ReplayJobStoreConfigurationError(
                "replay job store is closed"
            )
        metadata = os.fstat(self._parent_fd)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino) != self._parent_identity
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) & 0o022
        ):
            raise ReplayJobStoreConfigurationError(
                "replay job store parent authentication failed"
            )

    def close(self) -> None:
        if hasattr(self, "_finalizer") and self._finalizer.alive:
            self._finalizer()

    @staticmethod
    def _encode(job: ReplayJob) -> dict:
        return asdict(job)

    @staticmethod
    def _decode(raw: object) -> ReplayJob:
        if not isinstance(raw, dict) or not isinstance(raw.get("pins"), dict):
            raise ReplayJobStoreCorruptError(
                "replay job record is corrupt"
            )
        try:
            pins = ReplayPins(**raw["pins"])
            job = ReplayJob(
                **{
                    **raw,
                    "pins": pins,
                }
            )
            ReplayService._validate_job(job)
            return job
        except (TypeError, ValueError, ReplayServiceError) as error:
            raise ReplayJobStoreCorruptError(
                "replay job record is corrupt"
            ) from error

    @staticmethod
    def _validate_proposed(job: ReplayJob) -> None:
        try:
            ReplayService._validate_job(job)
        except ReplayServiceError as error:
            raise ReplayConflictError(
                "replay job store rejected invalid proposed state"
            ) from error
