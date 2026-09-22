"""Settings for the sync job.

Values come from the environment first (GitHub Actions secrets), then from a `.env` file
found in the working directory or any parent (local runs). `.env` is gitignored.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def read_dotenv(path: str | os.PathLike[str] = ".env") -> dict[str, str]:
    """Parse KEY=value lines; comments and blanks ignored; surrounding quotes stripped."""
    out: dict[str, str] = {}
    p = Path(path)
    if not p.exists():
        return out
    with p.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("\"'")
    return out


def find_dotenv(start: Path | None = None) -> Path | None:
    """Walk up from `start` (default cwd) looking for a `.env`, stopping at the first hit."""
    here = (start or Path.cwd()).resolve()
    for d in (here, *here.parents):
        candidate = d / ".env"
        if candidate.exists():
            return candidate
    return None


_DOTENV_CACHE: dict[str, str] | None = None


def env(key: str, default: str | None = None) -> str | None:
    """Environment variable, else `.env` value, else default."""
    global _DOTENV_CACHE
    val = os.environ.get(key)
    if val not in (None, ""):
        return val
    if _DOTENV_CACHE is None:
        found = find_dotenv()
        _DOTENV_CACHE = read_dotenv(found) if found else {}
    return _DOTENV_CACHE.get(key, default)


@dataclass(frozen=True)
class Settings:
    db_url: str
    overlap_days: int = 7          # re-fetch this many days before the newest stored activity
    stream_sleep_s: float = 0.25   # pause between per-activity stream downloads
    max_auth_failures: int = 3     # consecutive 401/403s before a connection is marked auth_failed
    default_max_streams: int = 200
    request_timeout_s: int = 90
    sample_every_s: int = 10       # downsample step for activity_details.samples (0 disables)

    @classmethod
    def load(cls) -> "Settings":
        db_url = env("SUPABASE_DB_URL")
        if not db_url:
            raise SystemExit(
                "SUPABASE_DB_URL is not set.\n"
                "Put the Supabase session-pooler connection string in the environment or in a .env file "
                "(see .env.example at the repo root)."
            )
        return cls(
            db_url=db_url,
            overlap_days=int(env("SYNC_OVERLAP_DAYS", "7") or 7),
            stream_sleep_s=float(env("SYNC_STREAM_SLEEP_S", "0.25") or 0.25),
            max_auth_failures=int(env("SYNC_MAX_AUTH_FAILURES", "3") or 3),
            default_max_streams=int(env("SYNC_MAX_STREAMS", "200") or 200),
            sample_every_s=int(env("SYNC_SAMPLE_EVERY_S", "10") or 10),
        )
