#!/usr/bin/env python3
"""Airdrop / TGE announcements for the web app banner.

Edits the PRIVATE announcements.json (repo root, gitignored) and seals it to public/announcements.enc.json (ENCRYPTED with
BOBBY_VIEW_PASSPHRASE, same envelope as balances/briefing/positions). Publish with `tools/publish.sh all` (or `announcements`).

  python3 tools/announce.py add --project extended --title "Airdrop registration open" --text "Sign the eligibility message" \
      --severity action --url https://... [--deadline 2026-10-30T18:00] [--claim-url https://...] [--expires ...] [--id ...]
  python3 tools/announce.py list [--all] [--json]
  python3 tools/announce.py expire [--keep-days 7]      # drop items expired / past deadline for more than N days
  python3 tools/announce.py remove --id ID
  python3 tools/announce.py seal [--out PATH]           # write the encrypted file (publish.sh does this)

Times: ISO 8601; without an offset they are read as Europe/Berlin time, stored as UTC (…Z).
Dedupe: same --id, or same project + title (case-insensitive), updates the existing item (createdAt kept; a
deadline / claim url / expiry not given again is kept).
Only https links are accepted (official sources only). No secrets or addresses belong in here.
"""
import argparse, hashlib, json, os, re, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
PROJECTS = ("extended", "variational", "txflow", "arcus", "risex", "qfex", "entropy", "metric")
SEVERITIES = ("action", "info")
BERLIN = ZoneInfo("Europe/Berlin")
ADDR = re.compile(r"0x[0-9a-fA-F]{40}")


def default_file():
    return Path(os.environ.get("ANNOUNCE_FILE") or ROOT / "announcements.json")


def now_utc():
    t = os.environ.get("ANNOUNCE_NOW")  # tests
    return datetime.fromtimestamp(float(t), timezone.utc) if t else datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(s):
    if s is None or s == "":
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        s += "T23:59"  # a bare date = end of that day, Berlin
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BERLIN)
    return iso(dt)


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def https(u, what):
    if u is None:
        return None
    if not re.match(r"^https://[^\s/]+\.[^\s/]+", u):
        raise SystemExit(f"{what} must be an https:// link to the official source: {u!r}")
    return u


def load(path):
    path = Path(path)
    if not path.exists():
        return []
    d = json.loads(path.read_text() or "[]")
    items = d.get("items", []) if isinstance(d, dict) else d
    if not isinstance(items, list):
        raise SystemExit(f"{path}: expected a list of items")
    return items


def save(path, items):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def make_id(project, title):
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]
    return f"{project}-{slug}-{hashlib.sha256((project + '|' + title.lower().strip()).encode()).hexdigest()[:6]}"


def add(items, project, title, text, severity, url, deadline=None, claim_url=None, expires=None, id_=None, now=None):
    """Pure (tested). Returns (items, item, 'added'|'updated')."""
    project = project.lower().strip()
    if project not in PROJECTS:
        raise SystemExit(f"unknown project {project!r} (one of: {', '.join(PROJECTS)})")
    if severity not in SEVERITIES:
        raise SystemExit("severity must be action or info")
    title, text = title.strip(), (text or "").strip()
    if not title:
        raise SystemExit("title is required")
    for f in (title, text):
        if ADDR.search(f):
            raise SystemExit("refusing: announcements must not contain wallet addresses")
    item = {"id": id_ or make_id(project, title), "project": project, "title": title, "text": text, "severity": severity,
            "url": https(url, "--url")}
    if deadline:
        item["deadline"] = parse_time(deadline)
    if claim_url:
        item["claimUrl"] = https(claim_url, "--claim-url")
    if expires:
        item["expiresAt"] = parse_time(expires)
    key = (project, title.lower())
    for i, old in enumerate(items):
        if old.get("id") == item["id"] or (old.get("project"), str(old.get("title", "")).lower()) == key:
            item["id"] = old["id"]
            for k in ("deadline", "claimUrl", "expiresAt"):  # optional fields not given again are kept
                if k not in item and old.get(k):
                    item[k] = old[k]
            item["createdAt"] = old.get("createdAt") or iso(now or now_utc())
            item["updatedAt"] = iso(now or now_utc())
            items = items[:i] + [item] + items[i + 1:]
            return items, item, "updated"
    item["createdAt"] = iso(now or now_utc())
    return items + [item], item, "added"


def state(it, now):
    exp, dl = ts(it.get("expiresAt")), ts(it.get("deadline"))
    if exp and exp <= now:
        return "expired", exp
    if it.get("severity") == "action" and dl and dl <= now:
        return "deadline passed", dl
    return "active", None


def expire(items, now, keep_days=7):
    """Pure (tested). Drops items expired / past their deadline for more than keep_days."""
    keep, gone = [], []
    for it in items:
        st, since = state(it, now)
        (gone if st != "active" and since <= now - timedelta(days=keep_days) else keep).append(it)
    return keep, gone


def seal(items, out, now=None):
    import vaultpy
    vaultpy.passphrase()  # refuse early: nothing is written without encryption
    out = Path(out)
    try:  # unchanged items: keep the existing ciphertext (no needless commit on every publish)
        if out.exists() and vaultpy.read_sealed(out).get("items") == items:
            return out
    except Exception:
        pass
    doc = {"v": 1, "generated": int((now or now_utc()).timestamp()), "items": items}
    p = vaultpy.write_sealed(out, doc)  # refuses without BOBBY_VIEW_PASSPHRASE or a non-.enc.json name
    dist = ROOT / "dist"
    if dist.is_dir() and Path(out).resolve() == (ROOT / "public" / "announcements.enc.json").resolve():
        (dist / p.name).write_text(p.read_text())
    return p


def berlin(s):
    return ts(s).astimezone(BERLIN).strftime("%a %d %b %H:%M") + " Berlin" if s else "—"


def main(argv=None):
    ap = argparse.ArgumentParser(description="airdrop / TGE announcements for the web app banner")
    ap.add_argument("--file", default=None, help="announcements.json (default: repo root, or $ANNOUNCE_FILE)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--project", required=True, choices=PROJECTS)
    a.add_argument("--title", required=True)
    a.add_argument("--text", default="")
    a.add_argument("--severity", required=True, choices=SEVERITIES)
    a.add_argument("--url", required=True, help="official source (https)")
    a.add_argument("--deadline")
    a.add_argument("--claim-url")
    a.add_argument("--expires")
    a.add_argument("--id")
    l = sub.add_parser("list")
    l.add_argument("--all", action="store_true", help="include expired / past-deadline items")
    l.add_argument("--json", action="store_true")
    e = sub.add_parser("expire")
    e.add_argument("--keep-days", type=float, default=7)
    r = sub.add_parser("remove")
    r.add_argument("--id", required=True)
    s = sub.add_parser("seal")
    s.add_argument("--out", default=str(ROOT / "public" / "announcements.enc.json"))
    a_ = ap.parse_args(argv)
    path = Path(a_.file) if a_.file else default_file()
    items, now = load(path), now_utc()
    if a_.cmd == "add":
        items, it, how = add(items, a_.project, a_.title, a_.text, a_.severity, a_.url, a_.deadline, a_.claim_url, a_.expires, a_.id, now)
        save(path, items)
        print(f"{how}: {it['id']}")
    elif a_.cmd == "list":
        rows = [it for it in items if a_.all or state(it, now)[0] == "active"]
        if a_.json:
            print(json.dumps(rows, indent=2, ensure_ascii=False))
        else:
            for it in rows:
                print(f"[{it.get('severity')}] {it.get('id')} · {it.get('project')} · {it.get('title')}"
                      + (f" · deadline {berlin(it.get('deadline'))}" if it.get("deadline") else "") + f" · {state(it, now)[0]}")
            print(f"{len(rows)} item(s)" + ("" if a_.all else " active"))
    elif a_.cmd == "expire":
        keep, gone = expire(items, now, a_.keep_days)
        save(path, keep)
        print(f"expired {len(gone)}: {', '.join(i['id'] for i in gone) or '-'}; {len(keep)} left")
    elif a_.cmd == "remove":
        keep = [i for i in items if i.get("id") != a_.id]
        if len(keep) == len(items):
            raise SystemExit(f"no item with id {a_.id!r}")
        save(path, keep)
        print(f"removed: {a_.id}")
    elif a_.cmd == "seal":
        p = seal(items, a_.out, now)
        print(f"announcements: {len(items)} item(s) -> {p} (encrypted)")


if __name__ == "__main__":
    main()
