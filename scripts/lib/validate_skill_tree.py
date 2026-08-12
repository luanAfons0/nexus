#!/usr/bin/env python3
"""Validate a skill tree before dereferencing its symlinks."""
import os
import sys

def within(path, root):
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False

def main():
    if len(sys.argv) != 2:
        return 2
    target = sys.argv[1]
    skill_file = os.path.join(target, "SKILL.md")
    if not os.path.isdir(target) or os.path.islink(target):
        print(f"skill source is not a physical directory: {target}", file=sys.stderr)
        return 1
    if not os.path.isfile(skill_file) or os.path.islink(skill_file):
        print(f"skill source must contain a physical SKILL.md: {target}", file=sys.stderr)
        return 1
    root = os.path.realpath(target)
    def walk(directory, active):
        real_directory = os.path.realpath(directory)
        if real_directory in active:
            print(f"skill source has cyclic symlinked directory: {directory}", file=sys.stderr)
            return False
        active.add(real_directory)
        try:
            try:
                entries = list(os.scandir(directory))
            except OSError:
                print(f"skill source cannot be traversed: {directory}", file=sys.stderr)
                return False
            for item in entries:
                entry = item.path
                if item.is_symlink():
                    resolved = os.path.realpath(entry)
                    if not os.path.exists(entry):
                        print(f"skill source has broken or cyclic symlink: {entry}", file=sys.stderr)
                        return False
                    if not within(resolved, root):
                        print(f"skill source symlink escapes skill tree: {entry} -> {resolved}", file=sys.stderr)
                        return False
                    if os.path.isdir(entry) and not walk(resolved, active):
                        return False
                elif item.is_dir(follow_symlinks=False) and not walk(entry, active):
                    return False
        finally:
            active.remove(real_directory)
        return True

    if not walk(target, set()):
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
