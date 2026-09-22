"""A thin client for the intervals.icu REST API.

Ported from reference/sync.py. Auth is HTTP Basic with the literal username "API_KEY" and
the athlete's API key as the password. Athlete ids carry a leading "i" (i123456).

Endpoints used:
    GET /athlete/{id}/activities?oldest=YYYY-MM-DD&newest=YYYY-MM-DD
    GET /athlete/{id}/wellness?oldest=YYYY-MM-DD&newest=YYYY-MM-DD
    GET /activity/{id}/streams?types=time,distance,latlng,heartrate,altitude
"""

from __future__ import annotations

from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

API_ROOT = "https://intervals.icu/api/v1"
STREAM_TYPES = "time,distance,latlng,heartrate,altitude"
USER_AGENT = "splitset-sync/0.1 (+https://github.com/conormidd-hub/Splitset)"


class IntervalsError(Exception):
    """Any non-auth failure talking to intervals.icu."""


class IntervalsAuthError(IntervalsError):
    """401/403: bad key, regenerated key, or an athlete id missing its leading 'i'."""


def normalise_athlete_id(athlete_id: str | int) -> str:
    s = str(athlete_id).strip()
    return s if s.startswith("i") else f"i{s}"


def session(api_key: str) -> requests.Session:
    s = requests.Session()
    s.auth = ("API_KEY", api_key)
    s.headers["Accept"] = "application/json"
    s.headers["User-Agent"] = USER_AGENT
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s


def check_auth(resp: requests.Response) -> None:
    if resp.status_code in (401, 403):
        raise IntervalsAuthError(
            f"{resp.status_code} from intervals.icu. Two usual causes: the athlete id needs a "
            "leading 'i' (i123456, not 123456), or the API key was regenerated on the settings page."
        )


class IntervalsClient:
    def __init__(self, athlete_id: str | int, api_key: str, timeout: int = 90,
                 sess: requests.Session | None = None):
        self.athlete_id = normalise_athlete_id(athlete_id)
        self.timeout = timeout
        self.sess = sess or session(api_key)

    # ---------------------------------------------------------------- helpers

    def _get(self, path: str, **params: Any) -> requests.Response:
        try:
            resp = self.sess.get(f"{API_ROOT}{path}", params=params or None, timeout=self.timeout)
        except requests.RequestException as e:
            raise IntervalsError(f"GET {path}: {e.__class__.__name__}: {e}") from e
        check_auth(resp)
        return resp

    @staticmethod
    def _json(resp: requests.Response, path: str) -> Any:
        if not resp.ok:
            raise IntervalsError(f"GET {path}: HTTP {resp.status_code}: {resp.text[:200]}")
        try:
            return resp.json()
        except ValueError as e:
            raise IntervalsError(f"GET {path}: response was not JSON") from e

    # ---------------------------------------------------------------- endpoints

    def fetch_activities(self, oldest: str, newest: str) -> list[dict[str, Any]]:
        path = f"/athlete/{self.athlete_id}/activities"
        data = self._json(self._get(path, oldest=oldest, newest=newest), path)
        if not isinstance(data, list):
            raise IntervalsError(f"GET {path}: expected a list, got {type(data).__name__}")
        return data

    def fetch_wellness(self, oldest: str, newest: str) -> list[dict[str, Any]]:
        path = f"/athlete/{self.athlete_id}/wellness"
        data = self._json(self._get(path, oldest=oldest, newest=newest), path)
        if not isinstance(data, list):
            raise IntervalsError(f"GET {path}: expected a list, got {type(data).__name__}")
        return data

    def fetch_streams(self, activity_id: str, types: str = STREAM_TYPES) -> list[dict[str, Any]] | None:
        """The activity's streams, or None when intervals.icu has none (404)."""
        path = f"/activity/{activity_id}/streams"
        resp = self._get(path, types=types)
        if resp.status_code == 404:
            return None
        data = self._json(resp, path)
        return data if isinstance(data, list) else None

    def close(self) -> None:
        self.sess.close()

    def __enter__(self) -> "IntervalsClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
