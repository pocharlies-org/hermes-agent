"""Runtime smoke tests for the PM install-state lock ownership repair (DGX-1963).

Build the real image and verify the actual runtime behavior:

  1. A root-owned install-state lock under installs/<key>/ — the DEPL-21362
     crash-loop shape (uid-0 writer on the shared $HERMES_HOME, then the
     supervised startup as uid 10000 dying in _claim_recovery_lock) — is
     chowned to hermes on boot.
  2. A non-allowlisted file inside installs/ is NOT touched (targeted
     allowlist, same contract as the top-level state-file sweep).
"""
from __future__ import annotations

from tests.docker.conftest import (
    docker_exec,
    docker_exec_sh,
    restart_container,
    start_container,
)


KEY = "0123456789abcdef"
# Mirrors the allowlist in stage2-hook.sh (the startup-blocking names).
ALLOWLISTED_FILES = (".recovery.lock", ".install.lock", ".repair-incomplete", "facts.json")


def _owners(container_name: str) -> str:
    return docker_exec_sh(
        container_name,
        " ".join(f"stat -c %U /opt/data/installs/{KEY}/{f}" for f in ALLOWLISTED_FILES),
        timeout=5,
    ).stdout.split()


def test_root_owned_install_locks_repaired_on_boot(
    built_image: str, container_name: str,
) -> None:
    """Root-owned install-state lock files must be chowned to hermes on boot."""
    start_container(built_image, container_name)

    docker_exec(
        container_name, "mkdir", "-p", f"/opt/data/installs/{KEY}",
        user="root", timeout=5,
    )
    for f in ALLOWLISTED_FILES:
        docker_exec(
            container_name, "touch", f"/opt/data/installs/{KEY}/{f}",
            user="root", timeout=5,
        )
    assert all(owner == "root" for owner in _owners(container_name))

    restart_container(container_name)

    owners = _owners(container_name)
    assert all(owner == "hermes" for owner in owners), (
        f"expected hermes-owned after restart, got: {owners}"
    )


def test_non_allowlisted_file_in_installs_not_touched(
    built_image: str, container_name: str,
) -> None:
    """A root-owned file deeper under installs/ (a venv generation) must NOT
    be chowned — the repair is the targeted allowlist, not a blanket sweep."""
    start_container(built_image, container_name)

    marker = f"/opt/data/installs/{KEY}/environments/gen1/venv_marker"
    docker_exec(
        container_name, "mkdir", "-p", f"/opt/data/installs/{KEY}/environments/gen1",
        user="root", timeout=5,
    )
    docker_exec(container_name, "touch", marker, user="root", timeout=5)

    restart_container(container_name)

    r = docker_exec_sh(container_name, f"stat -c %U {marker}", timeout=5)
    assert r.stdout.strip() == "root", (
        f"non-allowlisted file inside installs/ was chowned by stage2: {r.stdout.strip()}"
    )
