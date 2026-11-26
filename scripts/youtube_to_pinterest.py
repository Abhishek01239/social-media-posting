#!/usr/bin/env python3
"""Share new Galaxy Of Games AR YouTube uploads (Shorts + videos) to Pinterest and Facebook via Zernio.

Standard library only. Runs from .github/workflows/youtube-to-pinterest.yml.

For each upload in the channel's public RSS feed that is newer than MAX_AGE_HOURS:
- Pinterest: one pin with the YouTube thumbnail, the title and a link to the video.
- Facebook: one Page post with the caption and the YouTube link (Facebook shows the
  video preview card).
Duplicates are prevented with Zernio's externalId ("pin-<videoId>" / "fb-<videoId>"),
so no state file is needed. Either platform is skipped if it isn't connected.

Env:
  ZERNIO_PINTEREST_KEY   (required) API key of the Zernio account that has Pinterest connected
  YT_CHANNEL_ID          YouTube channel id (default: Galaxy Of Games AR)
  PINTEREST_BOARD_NAME   board to pin to, case-insensitive (default: MINECRAFT)
  PINTEREST_ACCOUNT_ID   optional; otherwise the first Pinterest account in that Zernio account
  FACEBOOK_ACCOUNT_ID    optional; otherwise the first Facebook account in that Zernio account
  PLATFORMS              comma list of targets (default: pinterest,facebook)
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
PIN_ACCOUNT = os.environ.get("PINTEREST_ACCOUNT_ID", "").strip()
FB_ACCOUNT = os.environ.get("FACEBOOK_ACCOUNT_ID", "").strip()
PLATFORMS = {x.strip() for x in os.environ.get("PLATFORMS", "pinterest,facebook").split(",") if x.strip()}
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


def fb_text(item, short, link):
    hashtags = [w for w in item["desc"].split() if w.startswith("#")][:5]
    kind = "New Short" if short else "New video"
    text = f"{kind}: {item['title']}\n\n▶️ Watch it here: {link}\n\n{' '.join(hashtags or ['#minecraft', '#gaming'])}"
    return text[:1500]


def find_accounts():
    """Return {platform: accountId} for the wanted platforms that are connected."""
    found = {}
    if "pinterest" in PLATFORMS and PIN_ACCOUNT:
        found["pinterest"] = PIN_ACCOUNT
    if "facebook" in PLATFORMS and FB_ACCOUNT:
        found["facebook"] = FB_ACCOUNT
    if PLATFORMS - set(found):
        status, data = zernio("GET", "/accounts")
        if status != 200:
            sys.exit(f"Zernio /accounts failed: HTTP {status} {data}")
        for a in data.get("accounts", []):
            plat = a.get("platform")
            if plat in PLATFORMS and plat not in found and a.get("isActive", True):
                found[plat] = a["_id"]
                print(f"{plat} account: {a.get('username') or a.get('displayName')} ({a['_id']})")
    for plat in sorted(PLATFORMS - set(found)):
        print(f"NOTE: no {plat} account in this Zernio account; skipping {plat}.")
    if not found:
        sys.exit("Neither Pinterest nor Facebook is connected in this Zernio account.")
    return found


def find_board(account_id):
    status, data = zernio("GET", f"/accounts/{account_id}/pinterest-boards")
    if status != 200:
        print(f"Could not list Pinterest boards: HTTP {status} {data}; skipping Pinterest.")
        return None
    boards = data.get("boards", [])
    match = [b for b in boards if b.get("name", "").strip().lower() == BOARD_NAME]
    if not match:
        names = ", ".join(b.get("name", "?") for b in boards) or "none"
        print(f"Board '{BOARD_NAME}' not found (boards Zernio can see: {names}); skipping Pinterest.")
        return None
    print(f"Board: {match[0]['name']} ({match[0]['id']})")
    return match[0]["id"]


def already_posted(ext_id):
    status, data = zernio("GET", f"/posts?externalId={ext_id}&limit=5&view=summary")
    if status != 200:
        # When in doubt, don't post: a duplicate is worse than a late post.
        print(f"  could not check duplicates for {ext_id} (HTTP {status}); skipping this run")
        return True
    live = [p for p in data.get("posts", []) if p.get("status") not in ("failed", "cancelled")]
    return bool(live)


def send(body, label):
    if DRY_RUN:
        print(f"  [dry run] {label}:")
        print(json.dumps(body, indent=2))
        return True
    status, data = zernio("POST", "/posts", body)
    if status >= 300:
        print(f"  {label} FAILED: HTTP {status} {json.dumps(data)[:400]}")
        return False
    plat = (data.get("post", {}).get("platforms") or [{}])[0]
    print(f"  {label} ok: {plat.get('status')} {plat.get('platformPostUrl') or ''}")
    time.sleep(5)
    return True


def main():
    if not KEY:
        sys.exit("ZERNIO_PINTEREST_KEY is not set (add it under Settings > Secrets and variables > Actions).")
    now = datetime.now(timezone.utc)
    items = [i for i in fetch_feed() if now - i["published"] <= MAX_AGE]
    items.sort(key=lambda i: i["published"])  # oldest first
    print(f"{len(items)} upload(s) in the last {MAX_AGE}")
    if not items:
        return
    accounts = find_accounts()
    board_id = find_board(accounts["pinterest"]) if "pinterest" in accounts else None
    if board_id is None:
        accounts.pop("pinterest", None)
    if not accounts:
        sys.exit("Nothing to post to.")
    done = 0
    for item in items:
        if done >= MAX_PINS:
            print("Reached MAX_PINS_PER_RUN; the rest will be shared next run.")
            break
        vid = item["id"]
        todo = [p for p in accounts if not already_posted(f"{'pin' if p == 'pinterest' else 'fb'}-{vid}")]
        if not todo:
            print(f"- skip {vid} (already shared)")
            continue
        short = is_short(vid)
        link = f"https://www.youtube.com/shorts/{vid}" if short else f"https://www.youtube.com/watch?v={vid}"
        print(f"- {'Short' if short else 'video'} {vid}: {item['title']}")
        if "pinterest" in todo:
            send({
                "content": pin_text(item, short),
                "mediaItems": [{"type": "image", "url": thumbnail(vid)}],
                "platforms": [{
                    "platform": "pinterest",
                    "accountId": accounts["pinterest"],
                    "platformSpecificData": {"title": item["title"][:100], "boardId": board_id, "link": link},
                }],
                "publishNow": True,
                "externalId": f"pin-{vid}",
            }, "Pinterest")
        if "facebook" in todo:
            send({
                "content": fb_text(item, short, link),
                "platforms": [{"platform": "facebook", "accountId": accounts["facebook"]}],
                "publishNow": True,
                "externalId": f"fb-{vid}",
            }, "Facebook")
        done += 1
    print(f"Done: {done} upload(s) shared.")


if __name__ == "__main__":
    main()
