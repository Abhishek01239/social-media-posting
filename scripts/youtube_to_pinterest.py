#!/usr/bin/env python3
"""Pin new Galaxy Of Games AR YouTube uploads (Shorts + videos) to Pinterest via Zernio.

Standard library only. Runs from .github/workflows/youtube-to-pinterest.yml.

For each upload in the channel's public RSS feed that is newer than MAX_AGE_HOURS
and not pinned yet, it creates one Pinterest pin: the YouTube thumbnail, the video
title, and a link back to the video. Duplicates are prevented with Zernio's
externalId ("yt-<videoId>"), so no state file is needed.

Env:
  ZERNIO_PINTEREST_KEY   (required) API key of the Zernio account that has Pinterest connected
  YT_CHANNEL_ID          YouTube channel id (default: Galaxy Of Games AR)
  PINTEREST_BOARD_NAME   board to pin to, case-insensitive (default: MINECRAFT)
  PINTEREST_ACCOUNT_ID   optional; otherwise the first Pinterest account in that Zernio account
  MAX_AGE_HOURS          only pin uploads newer than this (default: 72)
  MAX_PINS_PER_RUN       safety cap per run (default: 4)
  DRY_RUN=1              print what would be pinned, post nothing
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

API = "https://zernio.com/api/v1"
KEY = os.environ.get("ZERNIO_PINTEREST_KEY", "").strip()
CHANNEL_ID = os.environ.get("YT_CHANNEL_ID", "UCppjXBahPLC3G_5ZcP6t0RA")
BOARD_NAME = os.environ.get("PINTEREST_BOARD_NAME", "MINECRAFT").strip().lower()
ACCOUNT_ID = os.environ.get("PINTEREST_ACCOUNT_ID", "").strip()
MAX_AGE = timedelta(hours=float(os.environ.get("MAX_AGE_HOURS", "72")))
MAX_PINS = int(os.environ.get("MAX_PINS_PER_RUN", "4"))
DRY_RUN = os.environ.get("DRY_RUN", "") == "1"
UA = {"User-Agent": "Mozilla/5.0 (youtube-to-pinterest bot)"}

NS = {
    "a": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


def http(method, url, body=None, headers=None, follow=True):
    h = dict(UA)
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def zernio(method, path, body=None):
    status, raw = http(method, API + path, body, {"Authorization": f"Bearer {KEY}"})
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        data = {"raw": raw[:300].decode(errors="replace")}
    return status, data


def fetch_feed():
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}"
    status, raw = http("GET", url)
    if status != 200:
        sys.exit(f"YouTube feed returned HTTP {status}")
    root = ET.fromstring(raw)
    items = []
    for e in root.findall("a:entry", NS):
        vid = e.findtext("yt:videoId", namespaces=NS)
        title = (e.findtext("a:title", namespaces=NS) or "").strip()
        published = datetime.fromisoformat(e.findtext("a:published", namespaces=NS).replace("Z", "+00:00"))
        desc = (e.findtext("media:group/media:description", namespaces=NS) or "").strip()
        items.append({"id": vid, "title": title, "published": published, "desc": desc})
    return items


def is_short(vid):
    # /shorts/<id> answers 200 for a Short and redirects to /watch for a normal video.
    status, _ = http("HEAD", f"https://www.youtube.com/shorts/{vid}", follow=False)
    return status == 200


def thumbnail(vid):
    for name in ("maxresdefault", "sddefault", "hqdefault"):
        url = f"https://i.ytimg.com/vi/{vid}/{name}.jpg"
        status, raw = http("GET", url)
        # YouTube serves a tiny placeholder (~1 KB) when a size doesn't exist.
        if status == 200 and len(raw) > 5000:
            return url
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"


def pin_text(item, short):
    hashtags = [w for w in item["desc"].split() if w.startswith("#")][:5]
    first = ""
    for line in item["desc"].splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            first = line
            break
    kind = "Watch the full Short on YouTube!" if short else "Watch the full video on YouTube!"
    text = f"{first}\n\n{kind}\n\n{' '.join(hashtags or ['#minecraft', '#gaming'])}".strip()
    return text[:480]


def pick_account_and_board():
    global ACCOUNT_ID
    if not ACCOUNT_ID:
        status, data = zernio("GET", "/accounts")
        if status != 200:
            sys.exit(f"Zernio /accounts failed: HTTP {status} {data}")
        accts = [a for a in data.get("accounts", []) if a.get("platform") == "pinterest"]
        if not accts:
            sys.exit("No Pinterest account is connected in this Zernio account.")
        ACCOUNT_ID = accts[0]["_id"]
        print(f"Pinterest account: {accts[0].get('username')} ({ACCOUNT_ID})")
    status, data = zernio("GET", f"/accounts/{ACCOUNT_ID}/pinterest-boards")
    if status != 200:
        sys.exit(f"Could not list Pinterest boards: HTTP {status} {data}")
    boards = data.get("boards", [])
    match = [b for b in boards if b.get("name", "").strip().lower() == BOARD_NAME]
    if not match:
        names = ", ".join(b.get("name", "?") for b in boards) or "none"
        sys.exit(f"Board '{BOARD_NAME}' not found. Boards Zernio can see: {names}")
    print(f"Board: {match[0]['name']} ({match[0]['id']})")
    return match[0]["id"]


def already_pinned(vid):
    status, data = zernio("GET", f"/posts?externalId=yt-{vid}&limit=5&view=summary")
    if status != 200:
        # When in doubt, don't post: a duplicate pin is worse than a late one.
        print(f"  could not check duplicates for {vid} (HTTP {status}); skipping this run")
        return True
    live = [p for p in data.get("posts", []) if p.get("status") not in ("failed", "cancelled")]
    return bool(live)


def main():
    if not KEY:
        sys.exit("ZERNIO_PINTEREST_KEY is not set (add it under Settings > Secrets and variables > Actions).")
    now = datetime.now(timezone.utc)
    items = [i for i in fetch_feed() if now - i["published"] <= MAX_AGE]
    items.sort(key=lambda i: i["published"])  # oldest first
    print(f"{len(items)} upload(s) in the last {MAX_AGE}")
    if not items:
        return
    board_id = pick_account_and_board()
    pinned = 0
    for item in items:
        if pinned >= MAX_PINS:
            print("Reached MAX_PINS_PER_RUN; the rest will be pinned next run.")
            break
        vid = item["id"]
        if already_pinned(vid):
            print(f"- skip {vid} (already pinned)")
            continue
        short = is_short(vid)
        link = f"https://www.youtube.com/shorts/{vid}" if short else f"https://www.youtube.com/watch?v={vid}"
        body = {
            "content": pin_text(item, short),
            "mediaItems": [{"type": "image", "url": thumbnail(vid)}],
            "platforms": [{
                "platform": "pinterest",
                "accountId": ACCOUNT_ID,
                "platformSpecificData": {"title": item["title"][:100], "boardId": board_id, "link": link},
            }],
            "publishNow": True,
            "externalId": f"yt-{vid}",
        }
        print(f"- pin {'Short' if short else 'video'} {vid}: {item['title']}")
        if DRY_RUN:
            print(json.dumps(body, indent=2))
            continue
        status, data = zernio("POST", "/posts", body)
        if status >= 300:
            print(f"  FAILED: HTTP {status} {json.dumps(data)[:400]}")
            continue
        plat = (data.get("post", {}).get("platforms") or [{}])[0]
        print(f"  ok: {plat.get('status')} {plat.get('platformPostUrl') or ''}")
        pinned += 1
        time.sleep(5)
    print(f"Done: {pinned} pin(s) created.")


if __name__ == "__main__":
    main()
