"""Process hardening for the gateway (SC-2147).

A same-uid process (e.g. a ``python`` the agent's terminal spawns) can read
``/proc/<pid>/environ`` of any same-uid process by default, which hands it every
secret in the gateway's environment (``CONFIRMAR_PAGO_JIRA_TOKEN`` measured live).
``prctl(PR_SET_DUMPABLE, 0)`` makes the kernel refuse those reads with EACCES for
same-uid non-privileged processes while the gateway itself keeps full access to
its own ``/proc`` entries.

Scope notes:
  * The flag does NOT propagate across ``execve``: spawned children stay dumpable.
  * ``kill(pid, 0)``, socket connects and PID-file liveness checks are unaffected.
  * Other Hermes processes reading the gateway's ``/proc/<pid>/stat`` for
    lock-holder forensics get EACCES and fail closed (holder treated as alive),
    the conservative direction.
"""

import ctypes
import sys

PR_SET_DUMPABLE = 4
PR_GET_DUMPABLE = 3


def make_process_non_dumpable() -> bool:
    """Set PR_SET_DUMPABLE=0 on the calling process. Returns True only when the
    kernel confirms the flag took effect; False (never raises) on non-Linux or on
    any prctl failure, so callers can run it best-effort at startup."""
    if sys.platform != "linux":
        return False
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
            return False
        return libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == 0
    except (OSError, AttributeError, TypeError):
        return False
