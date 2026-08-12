#!/usr/bin/env python3
"""Produce deterministic, byte-safe manifests for agent backup trees."""
from __future__ import annotations

import argparse
import hashlib
import os
import stat
import struct
import sys
from typing import BinaryIO


class ManifestError(Exception):
    pass


def _field(value: bytes) -> bytes:
    return struct.pack(">I", len(value)) + value


def _record(out: BinaryIO, kind: bytes, path: bytes, values: list[bytes]) -> None:
    body = b"NEXUS1\0" + _field(kind) + _field(path)
    body += b"".join(_field(v) for v in values)
    out.write(struct.pack(">Q", len(body)))
    out.write(body)


def _entry(path: str, rel: bytes, st: os.stat_result, out: BinaryIO,
           metadata_only: bool, groups: dict[tuple[int, int], bytes],
           hashes: dict[tuple[int, int], tuple[int, bytes]]) -> None:
    mode = str(stat.S_IMODE(st.st_mode)).encode()
    common = [mode, str(st.st_uid).encode(), str(st.st_gid).encode(),
              str(st.st_mtime_ns).encode()]
    if stat.S_ISDIR(st.st_mode):
        _record(out, b"d", rel, common)
    elif stat.S_ISLNK(st.st_mode):
        try:
            target = os.fsencode(os.readlink(path))
        except OSError as exc:
            raise ManifestError(f"cannot read symlink {path!r}: {exc}") from exc
        _record(out, b"l", rel, common + [target])
    elif stat.S_ISREG(st.st_mode):
        key = (st.st_dev, st.st_ino)
        rep = groups.setdefault(key, rel)
        size = str(st.st_size).encode()
        digest = b""
        if not metadata_only:
            if key not in hashes:
                try:
                    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
                    fd = os.open(path, flags)
                    try:
                        checked = os.fstat(fd)
                        if (checked.st_dev, checked.st_ino) != key or not stat.S_ISREG(checked.st_mode):
                            raise ManifestError(f"file changed while hashing: {path!r}")
                        h = hashlib.sha256()
                        while True:
                            chunk = os.read(fd, 1024 * 1024)
                            if not chunk:
                                break
                            h.update(chunk)
                        if os.fstat(fd).st_size != st.st_size:
                            raise ManifestError(f"file changed while hashing: {path!r}")
                        hashes[key] = (st.st_size, h.digest())
                    finally:
                        os.close(fd)
                except (OSError, ManifestError) as exc:
                    if isinstance(exc, ManifestError):
                        raise
                    raise ManifestError(f"cannot read file {path!r}: {exc}") from exc
            digest = hashes[key][1]
        _record(out, b"f", rel, common + [size, rep] + ([] if metadata_only else [digest]))
    else:
        raise ManifestError(
            f"unsupported agent backup entry (device/FIFO/socket): {path!r}")


def _walk(root: str) -> list[tuple[str, bytes, os.stat_result]]:
    entries: list[tuple[str, bytes, os.stat_result]] = []

    def visit(path: str, rel: bytes) -> None:
        try:
            st = os.lstat(path)
        except OSError as exc:
            raise ManifestError(f"cannot lstat {path!r}: {exc}") from exc
        entries.append((path, rel, st))
        if not stat.S_ISDIR(st.st_mode):
            return
        try:
            children = list(os.scandir(path))
        except OSError as exc:
            raise ManifestError(f"cannot traverse {path!r}: {exc}") from exc
        children.sort(key=lambda e: os.fsencode(e.name))
        for child in children:
            child_rel = rel + (b"/" if rel != b"." else b"") + os.fsencode(child.name)
            visit(child.path, child_rel)

    visit(root, b".")
    entries.sort(key=lambda item: item[1])
    return entries


def write_manifests(root: str, full_name: str, state_name: str, metadata_only: bool = False) -> None:
    if not os.path.lexists(root):
        # A missing agent root is represented explicitly; setup treats it as an empty backup.
        for name in (full_name, state_name):
            with open(name, "wb") as out:
                _record(out, b"a", b".", [])
        return
    if not os.path.isdir(root) or os.path.islink(root):
        raise ManifestError(f"agent root is not a physical directory: {root!r}")
    entries = _walk(root)
    groups: dict[tuple[int, int], bytes] = {}
    hashes: dict[tuple[int, int], tuple[int, bytes]] = {}
    try:
        with open(full_name, "wb") as full, open(state_name, "wb") as state:
            for path, rel, st in entries:
                _entry(path, rel, st, state, True, groups, hashes)
                _entry(path, rel, st, full, metadata_only, groups, hashes)
    except OSError as exc:
        raise ManifestError(f"cannot open manifest output: {exc}") from exc


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root")
    parser.add_argument("full_manifest")
    parser.add_argument("state_manifest")
    parser.add_argument("--metadata-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        write_manifests(args.root, args.full_manifest, args.state_manifest, args.metadata_only)
    except (ManifestError, OSError) as exc:
        print(f"backup manifest: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
