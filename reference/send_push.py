#!/usr/bin/env python3
"""Send the morning brief and today's session to every device that turned notifications on.

Runs in the build after coach.py. Devices subscribe from Settings on the site, which stores
them in Cloudflare KV; this signs a message with VAPID_PRIVATE_KEY (the private half of the
key in push.json) and hands it to each browser's push service.

    python send_push.py --dry-run    # show what would go out
    python send_push.py --test       # send a one-off "it works" notification

Two messages a day at most, one of each kind, tracked in data/push_state.json so a second
build on the same day doesn't notify twice. Nothing here ever fails the build.
"""

import argparse
import json
import os
import sys
import traceback
from datetime import date, timedelta

from coach import (RUN_TYPES, describe_session, kv_doc, load_plan, melbourne_now,  # same helpers
                   sessions_on, session_km)

STATE = os.path.join("data", "push_state.json")
COACH = os.path.join("data", "coach.json")


def load(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def today_lines(plan, gym, today):
    """What's on today, as a notification title and body."""
    sessions = sessions_on(plan, today.isoformat())
    if not sessions:
        return None
    runs = [s for s in sessions if s.get("type") in RUN_TYPES]
    head = runs[0] if runs else sessions[0]
    km = session_km(head)
    title = f"Today: {head.get('title')}" + (f" · {km:g} km" if km else "")
    body = describe_session(head, gym)
    body = body.split("; ", 1)[1] if "; " in body else body
    if len(sessions) > 1:
        body += f"\nAlso: " + ", ".join(s.get("title") for s in sessions if s is not head)
    return title, body[:300]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--test", action="store_true", help="send a one-off test notification")
    args = ap.parse_args()

    with open("push.json", encoding="utf-8-sig") as f:
        cfg = json.load(f)
    private = (os.environ.get("VAPID_PRIVATE_KEY") or "").strip()
    if not private and not args.dry_run:
        print("push: VAPID_PRIVATE_KEY isn't set - nothing sent")
        return

    subs_doc, why = kv_doc("push")
    subs = (subs_doc or {}).get("subs") or {}
    if not subs:
        print(f"push: no devices subscribed{f' ({why})' if why else ''}")
        return

    now = melbourne_now()
    today = now.date()
    state = load(STATE, {})
    gym = load("gym_programs.json", {})
    plan = load_plan(False) if not args.test else None

    messages = []
    if args.test:
        messages.append(("test", {"title": "Test notification",
                                  "body": "Sent from the build, so the whole chain works.", "tag": "test"}))
    else:
        brief = (load(COACH, {}).get("briefs") or {}).get(today.isoformat())
        if brief and state.get("brief") != today.isoformat():
            messages.append(("brief", {"title": "Morning brief", "body": brief["text"][:400],
                                       "tag": "brief", "url": "./#overview"}))
        if plan and state.get("today") != today.isoformat():
            line = today_lines(plan, gym, today)
            if line:
                messages.append(("today", {"title": line[0], "body": line[1],
                                           "tag": "today", "url": "./#plan"}))

    if not messages:
        print("push: nothing new to send")
        return

    if args.dry_run:
        for kind, m in messages:
            print(f"push [{kind}] -> {len(subs)} device(s)\n  {m['title']}\n  " + m["body"].replace("\n", "\n  "))
        return

    from pywebpush import WebPushException, webpush   # only needed when actually sending

    sent = dead = 0
    for kind, m in messages:
        ok = 0
        for sid, rec in subs.items():
            try:
                webpush(subscription_info=rec["sub"], data=json.dumps(m),
                        vapid_private_key=private, vapid_claims={"sub": cfg.get("subject", "mailto:nobody@example.com")},
                        timeout=20)
                ok += 1
            except WebPushException as e:
                code = getattr(e.response, "status_code", None)
                # 404/410 mean that browser dropped the subscription; the site re-adds it on the next visit
                print(f"push: device {sid} failed ({code or e})" + (" - gone" if code in (404, 410) else ""))
                dead += 1 if code in (404, 410) else 0
        print(f"push [{kind}]: {ok} of {len(subs)} device(s)")
        if ok:
            sent += 1
            state[kind] = today.isoformat()

    if sent:
        state["at"] = now.isoformat(timespec="minutes")
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=0, sort_keys=True)
    if dead:
        print(f"push: {dead} subscription(s) are gone; turn notifications on again on that device to replace them")


if __name__ == "__main__":
    try:
        main()
    except Exception:   # a missed notification is never worth failing the dashboard build
        print("push: skipped after an error:")
        traceback.print_exc(file=sys.stdout)
        sys.exit(0)
