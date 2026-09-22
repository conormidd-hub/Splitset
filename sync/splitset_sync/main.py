"""splitset-sync command line.

    splitset-sync run [--user ID|EMAIL] [--full] [--oldest YYYY-MM-DD] [--max-streams N]
                      [--no-streams] [--dry-run] [--trigger cron|manual|local]
    splitset-sync connect --email E [--athlete-id i123456] [--api-key K] [--oldest YYYY-MM-DD]
    splitset-sync dump --email E [--oldest] [--newest] [--out DIR]
    splitset-sync link [--user ID|EMAIL] [--since YYYY-MM-DD | --days N]
    splitset-sync backfill-garmin --email E PATH [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import traceback
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from . import db
from .config import Settings, env
from .intervals_client import IntervalsAuthError, IntervalsClient, IntervalsError, normalise_athlete_id
from .garmin_export import backfill, find_root, parse_export
from .linking import link_plan_sessions, link_workouts
from .normalise import normalise_activity
from .streams import derive_details
from .wellness import normalise_wellness

log = logging.getLogger("splitset_sync")


class UserLog(logging.LoggerAdapter):
    def process(self, msg: str, kwargs: Any) -> tuple[str, Any]:
        return f"[{self.extra['user']}] {msg}", kwargs


def setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)


# ---------------------------------------------------------------- run

def sync_window(conn: Any, connection: dict[str, Any], args: argparse.Namespace,
                settings: Settings) -> tuple[str, str]:
    today = date.today()
    newest = (today + timedelta(days=1)).isoformat()
    if args.oldest:
        return args.oldest, newest
    latest = None if args.full else db.latest_activity_start(conn, connection["user_id"])
    if latest is None:
        return connection["oldest_date"].isoformat(), newest
    return (latest.date() - timedelta(days=settings.overlap_days)).isoformat(), newest


def run_user(conn: Any, connection: dict[str, Any], args: argparse.Namespace, settings: Settings) -> bool:
    uid = connection["user_id"]
    ulog = UserLog(log, {"user": connection.get("email") or str(uid)})
    dry = args.dry_run
    counts: dict[str, int] = {k: 0 for k in ("activities_fetched", "activities_upserted", "streams_fetched",
                                             "streams_pending", "wellness_days", "plan_links")}

    if not connection.get("api_key"):
        ulog.error("no API key in the vault for this connection; reconnect in the app")
        if not dry:
            db.record_error(conn, uid, "no API key stored")
            conn.commit()
        return False

    oldest, newest = sync_window(conn, connection, args, settings)
    ulog.info("window %s -> %s%s", oldest, newest, " (dry run)" if dry else "")

    run_id = None
    if not dry:
        run_id = db.start_sync_run(conn, uid, args.trigger, os.environ.get("GITHUB_RUN_ID"), oldest, newest)
        conn.commit()

    try:
        with IntervalsClient(connection["athlete_id"], connection["api_key"],
                             timeout=settings.request_timeout_s) as client:
            # ---- activities
            payloads = client.fetch_activities(oldest, newest)
            counts["activities_fetched"] = len(payloads)
            rows = [r for r in (normalise_activity(p, str(uid)) for p in payloads) if r]
            by_type: dict[str, int] = {}
            for r in rows:
                by_type[r["type"]] = by_type.get(r["type"], 0) + 1
            if not payloads:
                ulog.warning("intervals.icu returned no activities in the window; stored data left untouched")
            else:
                ulog.info("activities: %d fetched, %d usable (%s)", len(payloads), len(rows),
                          ", ".join(f"{t} {n}" for t, n in sorted(by_type.items())))
            if rows and not dry:
                counts["activities_upserted"] = db.upsert_activities(conn, rows)
                conn.commit()

            # ---- wellness
            wrecs = client.fetch_wellness(oldest, newest)
            wrows = [r for r in (normalise_wellness(w, str(uid)) for w in wrecs) if r]
            ulog.info("wellness: %d days returned, %d with data", len(wrecs), len(wrows))
            if wrows and not dry:
                counts["wellness_days"] = db.upsert_wellness(conn, wrows)
                conn.commit()

            # ---- streams -> activity_details
            if not args.no_streams:
                pending_total = db.count_pending_details(conn, uid)
                todo = db.activities_needing_details(conn, uid, args.max_streams)
                if not todo:
                    ulog.info("streams: cache is up to date")
                elif dry:
                    ulog.info("streams: would fetch %d of %d pending", len(todo), pending_total)
                else:
                    ulog.info("streams: fetching %d of %d pending", len(todo), pending_total)
                    for n, act_id in enumerate(todo, 1):
                        try:
                            streams = client.fetch_streams(act_id)
                        except IntervalsAuthError:
                            raise
                        except IntervalsError as e:
                            ulog.warning("  [%d/%d] %s: %s - will retry next sync", n, len(todo), act_id, e)
                            continue
                        rec = derive_details(streams, act_id, settings.sample_every_s)
                        db.upsert_details(conn, uid, rec)
                        counts["streams_fetched"] += 1
                        tag = "no streams" if not rec["has_streams"] else (
                            f"{len(rec['splits'] or [])} km"
                            + (", route" if rec["polyline"] else ", no route")
                            + (f", {len(rec['best_efforts'])} efforts" if rec["best_efforts"] else ""))
                        ulog.debug("  [%d/%d] %s: %s", n, len(todo), act_id, tag)
                        if n % 20 == 0:
                            conn.commit()
                        time.sleep(settings.stream_sleep_s)
                    conn.commit()
                counts["streams_pending"] = max(0, pending_total - counts["streams_fetched"])

        # ---- plan and workout links
        if not dry:
            since = date.fromisoformat(oldest)
            counts["plan_links"] = link_plan_sessions(conn, uid, since) + link_workouts(conn, uid, since)
            conn.commit()

        if not dry:
            db.record_success(conn, uid)
            db.finish_sync_run(conn, run_id, "ok", counts)
            conn.commit()
        ulog.info("done: activities %d/%d, wellness %d days, streams %d fetched/%d pending, links %d",
                  counts["activities_upserted"], counts["activities_fetched"], counts["wellness_days"],
                  counts["streams_fetched"], counts["streams_pending"], counts["plan_links"])
        return True

    except IntervalsAuthError as e:
        conn.rollback()
        ulog.error("auth failed: %s", e)
        if not dry:
            n = db.record_auth_failure(conn, uid, str(e), settings.max_auth_failures)
            db.finish_sync_run(conn, run_id, "auth_failed", counts, str(e))
            conn.commit()
            if n >= settings.max_auth_failures:
                ulog.error("connection marked auth_failed after %d consecutive failures", n)
        return False

    except Exception as e:  # noqa: BLE001 - one user's failure must not stop the others
        conn.rollback()
        ulog.exception("sync failed: %s", e)
        if not dry:
            db.record_error(conn, uid, f"{e.__class__.__name__}: {e}")
            db.finish_sync_run(conn, run_id, "error", counts, traceback.format_exc()[-2000:])
            conn.commit()
        return False


def cmd_run(args: argparse.Namespace) -> int:
    settings = Settings.load()
    if args.max_streams is None:
        args.max_streams = settings.default_max_streams
    with db.connect(settings.db_url) as conn:
        connections = db.active_connections(conn, args.user)
        if not connections:
            log.warning("no active intervals.icu connections%s", f" matching {args.user!r}" if args.user else "")
            return 0
        log.info("%d active connection(s)", len(connections))
        failed = 0
        for c in connections:
            if not run_user(conn, c, args, settings):
                failed += 1
    if failed:
        log.error("%d of %d connection(s) failed", failed, len(connections))
        return 1
    return 0


# ---------------------------------------------------------------- connect

def cmd_connect(args: argparse.Namespace) -> int:
    settings = Settings.load()
    athlete = args.athlete_id or env("INTERVALS_ATHLETE_ID")
    api_key = args.api_key or env("INTERVALS_API_KEY")
    if not athlete or not api_key:
        raise SystemExit("Need --athlete-id and --api-key (or INTERVALS_ATHLETE_ID / INTERVALS_API_KEY in .env).")
    oldest = date.fromisoformat(args.oldest) if args.oldest else None
    with db.connect(settings.db_url) as conn:
        uid = db.user_id_for_email(conn, args.email)
        if uid is None:
            raise SystemExit(f"No auth user with email {args.email}. Create it in the Supabase dashboard "
                             "(Authentication -> Users) first.")
        db.admin_connect(conn, uid, normalise_athlete_id(athlete), api_key, oldest)
        conn.commit()
    log.info("connected %s as %s (history from %s)", args.email, normalise_athlete_id(athlete),
             oldest or "the connection's oldest_date")
    return 0


# ---------------------------------------------------------------- dump

def cmd_dump(args: argparse.Namespace) -> int:
    """Save raw payloads for a user to inspect field names. Never commit the output."""
    settings = Settings.load()
    with db.connect(settings.db_url) as conn:
        conns = db.active_connections(conn, args.email)
    if not conns:
        raise SystemExit(f"No active connection for {args.email}")
    c = conns[0]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    newest = args.newest or (date.today() + timedelta(days=1)).isoformat()
    oldest = args.oldest or (date.today() - timedelta(days=14)).isoformat()
    with IntervalsClient(c["athlete_id"], c["api_key"]) as client:
        acts = client.fetch_activities(oldest, newest)
        (out / "activities_dump.json").write_text(json.dumps(acts, indent=1), encoding="utf-8")
        well = client.fetch_wellness(oldest, newest)
        (out / "wellness_dump.json").write_text(json.dumps(well, indent=1), encoding="utf-8")
        if acts:
            streams = client.fetch_streams(str(acts[-1]["id"]))
            (out / "streams_dump.json").write_text(json.dumps(streams, indent=1), encoding="utf-8")
    log.info("wrote %d activities, %d wellness days to %s (do not commit)", len(acts), len(well), out)
    return 0


def cmd_link(args: argparse.Namespace) -> int:
    """Run only the plan/workout linking, for every active connection or one user."""
    settings = Settings.load()
    since = date.fromisoformat(args.since) if args.since else date.today() - timedelta(days=args.days)
    with db.connect(settings.db_url) as conn:
        users = db.active_connections(conn, args.user)
        if not users:
            log.warning("no active connections%s", f" matching {args.user!r}" if args.user else "")
            return 0
        for c in users:
            uid = c["user_id"]
            plan = link_plan_sessions(conn, uid, since)
            work = link_workouts(conn, uid, since)
            conn.commit()
            log.info("[%s] linked %d plan session(s) and %d workout(s) since %s", c.get("email") or uid, plan, work, since)
    return 0


# ---------------------------------------------------------------- garmin export

def cmd_backfill_garmin(args: argparse.Namespace) -> int:
    settings = Settings.load()
    root = find_root(args.path)
    days = parse_export(root)
    if not days:
        log.warning("nothing usable found under %s", root)
        return 1
    first, last = next(iter(days)), next(reversed(days))
    per_col = {c: sum(1 for v in days.values() if v.get(c) is not None) for c in ("resting_hr", "hrv", "respiration", "vo2max")}
    log.info("parsed %d days (%s to %s): %s", len(days), first, last, ", ".join(f"{k} {n}" for k, n in per_col.items()))
    if args.dry_run:
        return 0
    with db.connect(settings.db_url) as conn:
        uid = db.user_id_for_email(conn, args.email)
        if uid is None:
            raise SystemExit(f"No auth user with email {args.email}")
        written, new = backfill(conn, uid, days)
        conn.commit()
    log.info("wellness: %d days written, %d were new; existing intervals.icu values kept", written, new)
    return 0


# ---------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="splitset-sync", description="intervals.icu -> Splitset Postgres")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="sync every active connection (default)")
    run.add_argument("--user", help="only this user id or email")
    run.add_argument("--full", action="store_true", help="re-fetch from the connection's oldest_date")
    run.add_argument("--oldest", help="override the window start, YYYY-MM-DD")
    run.add_argument("--max-streams", type=int, default=None, help="per-activity stream downloads per user per run")
    run.add_argument("--no-streams", action="store_true", help="skip stream downloads")
    run.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    run.add_argument("--trigger", default="local", choices=["cron", "manual", "local"])
    run.set_defaults(func=cmd_run)

    con = sub.add_parser("connect", help="store a user's intervals.icu credentials (operator path)")
    con.add_argument("--email", required=True)
    con.add_argument("--athlete-id")
    con.add_argument("--api-key")
    con.add_argument("--oldest", help="history start, YYYY-MM-DD")
    con.set_defaults(func=cmd_connect)

    dump = sub.add_parser("dump", help="save raw payloads for inspection")
    dump.add_argument("--email", required=True)
    dump.add_argument("--oldest")
    dump.add_argument("--newest")
    dump.add_argument("--out", default="dump")
    dump.set_defaults(func=cmd_dump)

    link = sub.add_parser("link", help="link plan sessions and app workouts to activities")
    link.add_argument("--user", help="only this user id or email")
    link.add_argument("--since", help="YYYY-MM-DD; default is --days ago")
    link.add_argument("--days", type=int, default=30)
    link.set_defaults(func=cmd_link)

    gar = sub.add_parser("backfill-garmin", help="fill wellness history from a Garmin account export")
    gar.add_argument("--email", required=True)
    gar.add_argument("path", help="the unzipped export's DI_CONNECT folder (or its parent)")
    gar.add_argument("--dry-run", action="store_true", help="parse and report, write nothing")
    gar.set_defaults(func=cmd_backfill_garmin)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    setup_logging(args.verbose)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
