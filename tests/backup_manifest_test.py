#!/usr/bin/env python3
"""Direct regression fixtures for the backup manifest helper."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/lib/backup_manifest.py"


def manifests(root: pathlib.Path, stem: str):
    full, state = root.parent / (stem + ".full"), root.parent / (stem + ".state")
    subprocess.run(["python3", str(HELPER), str(root), str(full), str(state)], check=True)
    return full.read_bytes(), state.read_bytes()


def expect_different(src: pathlib.Path, rel: pathlib.Path, mutate):
    before = manifests(src, "before")
    mutate(src / rel)
    after = manifests(src, "after")
    assert before != after, rel


with tempfile.TemporaryDirectory() as temporary:
    base = pathlib.Path(temporary)
    src = base / "src"
    (src / "nested").mkdir(parents=True)
    (src / ".hidden").write_bytes(b"hidden")
    (src / "nested" / "payload").write_bytes(b"payload")
    os.link(src / "nested" / "payload", src / "hardlink")
    os.symlink(b"literal\n", src / "nested" / "line\nlink")
    bad_name = os.fsdecode(b"nonutf8_\xff")
    (src / bad_name).write_bytes(b"bytes")
    os.chmod(src / "nested" / "payload", 0o751)
    old_ns = time.time_ns() - 10_000_000
    os.utime(src / "nested" / "payload", ns=(old_ns, old_ns))

    copied = base / "copied"
    copied.mkdir()
    subprocess.run(["cp", "-a", str(src) + "/.", str(copied) + "/"], check=True)
    assert manifests(src, "source") == manifests(copied, "copied")

    expect_different(src, pathlib.Path("nested/payload"), lambda p: p.write_bytes(b"changed"))
    (src / "nested" / "payload").write_bytes(b"payload")
    expect_different(src, pathlib.Path("nested/payload"), lambda p: os.chmod(p, 0o640))
    os.chmod(src / "nested" / "payload", 0o751)
    expect_different(src, pathlib.Path("nested/payload"), lambda p: os.utime(p, ns=(old_ns + 1, old_ns + 1)))
    os.utime(src / "nested" / "payload", ns=(old_ns, old_ns))
    expect_different(src, pathlib.Path("nested/line\nlink"), lambda p: (p.unlink(), os.symlink(b"other\n", p)))
    (src / "nested" / "line\nlink").unlink()
    os.symlink(b"literal\n", src / "nested" / "line\nlink")
    topology_before = manifests(src, "topology-before")
    (src / "hardlink").unlink()
    (src / "hardlink").write_bytes(b"payload")
    assert topology_before != manifests(src, "topology-after")

    fifo = src / "unsupported-fifo"
    os.mkfifo(fifo)
    failed = subprocess.run(["python3", str(HELPER), str(src), str(base / "fifo.full"), str(base / "fifo.state")], capture_output=True)
    assert failed.returncode != 0 and b"unsupported" in failed.stderr
    failed = subprocess.run(["python3", str(HELPER), str(src / "missing-file"), str(base / "bad.full"), str(base / "bad.state")], capture_output=True)
    assert failed.returncode == 0  # absent roots intentionally become empty markers
    failed = subprocess.run(["python3", str(HELPER), str(src / "nested" / "payload"), str(base / "file.full"), str(base / "file.state")], capture_output=True)
    assert failed.returncode != 0 and b"physical directory" in failed.stderr

print("backup manifest fixtures: PASS")
