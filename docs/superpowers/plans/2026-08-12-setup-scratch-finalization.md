# Nexus Setup Scratch Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure ordinary setup success and failure finalize owned scratch files, report retained paths, and preserve recovery state.

**Architecture:** Centralize registered-file cleanup so registration is removed only after successful deletion, then finalize discovery and owned-temp cleanup while traps remain disabled but before state reset. Keep final backups, lock, and recovery paths outside owned-temp cleanup.

**Tech Stack:** Bash setup library and shell regression suite.

---

### Task 1: Make registered scratch cleanup retention-safe

**Files:**
- Modify: `scripts/lib/setup.sh`

- [ ] Add a helper that removes a registered setup file and unregisters it only when removal succeeds.
- [ ] Route snapshot and atomic-copy failure paths through that helper and leave failed removals registered.

### Task 2: Finalize ordinary setup before restoring traps

**Files:**
- Modify: `scripts/lib/setup.sh`

- [ ] Run discovery cleanup and owned-temp cleanup on both success and caught setup failure before mutex release and trap restoration.
- [ ] Report exact retained paths and force nonzero status when cleanup fails.
- [ ] Clear setup state only after finalization, preserving final backups/lock/recovery.

### Task 3: Verify setup lifecycle regressions

**Files:**
- Modify: `tests/faults.sh`
- Modify: `tests/run.sh`

- [ ] Add a fault that corrupts staged lock copy and makes exact copy-temp cleanup fail.
- [ ] Assert retained scratch reporting/nonzero failure and successful cleanup/no retained-temp line.
- [ ] Run syntax checks, targeted setup tests, full suite, and forbidden-pattern audit.
