#!/usr/bin/env python3
"""Heeben MVP server — Python standard library only (no pip install needed).

Run:  python3 server.py            -> http://localhost:8000
Env:  PORT, HOST, HEEBEN_DB (sqlite path), HEEBEN_DEMO=0 to skip sample garages/demo owner.
"""
import hashlib, hmac, json, math, os, re, secrets, sqlite3, sys, threading, time
from datetime import date, datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent.resolve()
PUBLIC = ROOT / "public"
DB_PATH = os.environ.get("HEEBEN_DB", str(ROOT / "data" / "heeben.db"))
DEMO = os.environ.get("HEEBEN_DEMO", "1") != "0"
SERVICES = ["Cleaning & detailing", "Routine servicing", "Mechanical repairs", "Tyres & batteries", "Electrical & EV care"]
VEHICLES = ["Car", "Two-wheeler", "Electric vehicle", "Commercial vehicle"]
SLOTS = ["09:00 AM", "11:00 AM", "02:00 PM", "04:00 PM"]
MODES = ["Visit garage", "Pickup requested (subject to availability)"]
SESSION_DAYS = 30
MAX_BODY = 64 * 1024

SCHEMA = """
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('customer','owner')),
  phone TEXT DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS garages(id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, area TEXT NOT NULL, phone TEXT NOT NULL, description TEXT DEFAULT '', lat REAL, lng REAL,
  vehicles TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 2, is_sample INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS garage_services(garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  service TEXT NOT NULL, price INTEGER NOT NULL, PRIMARY KEY(garage_id, service));
CREATE TABLE IF NOT EXISTS vehicles(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, model TEXT NOT NULL, reg TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE, service TEXT NOT NULL, vehicle TEXT NOT NULL,
  date TEXT NOT NULL, time TEXT NOT NULL, mode TEXT NOT NULL, notes TEXT DEFAULT '', contact_phone TEXT DEFAULT '',
  status TEXT NOT NULL, garage_note TEXT DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_bookings_slot ON bookings(garage_id, date, time);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saved(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE, PRIMARY KEY(user_id, garage_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, name TEXT, email TEXT, message TEXT, created TEXT);
"""

def db():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c

def now(): return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# ---------- security helpers ----------
def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 240_000).hex()
    return h, salt

def check_pw(pw, h, salt):
    return hmac.compare_digest(hash_pw(pw, salt)[0], h)

_attempts, _lock = {}, threading.Lock()
def rate_limited(key, limit=8, window=300):
    t = time.time()
    with _lock:
        a = [x for x in _attempts.get(key, []) if t - x < window]
        a.append(t); _attempts[key] = a
        return len(a) > limit

class ApiError(Exception):
    def __init__(self, status, msg): self.status, self.msg = status, msg

def need(cond, msg, status=400):
    if not cond: raise ApiError(status, msg)

def s(v, maxlen, field, required=True):
    v = (v or "").strip() if isinstance(v, str) else ""
    need(v or not required, f"{field} is required")
    need(len(v) <= maxlen, f"{field} is too long (max {maxlen})")
    return v

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^[0-9+()\-\s]{7,18}$")

def valid_date(d):
    try: dt = datetime.strptime(d, "%Y-%m-%d").date()
    except Exception: raise ApiError(400, "Invalid date")
    return dt

# ---------- serialisers ----------
def garage_dict(c, g, uid=None, full=False):
    svc = [dict(service=r["service"], price=r["price"]) for r in c.execute("SELECT service,price FROM garage_services WHERE garage_id=? ORDER BY price", (g["id"],))]
    rv = c.execute("SELECT COUNT(*) n, AVG(rating) a FROM reviews WHERE garage_id=?", (g["id"],)).fetchone()
    d = dict(id=g["id"], name=g["name"], area=g["area"], phone=g["phone"], description=g["description"], lat=g["lat"], lng=g["lng"],
             vehicles=g["vehicles"].split(","), capacity=g["capacity"], is_sample=bool(g["is_sample"]), services=svc,
             rating=round(rv["a"], 1) if rv["a"] else None, review_count=rv["n"], min_price=min([x["price"] for x in svc], default=None),
             saved=bool(uid and c.execute("SELECT 1 FROM saved WHERE user_id=? AND garage_id=?", (uid, g["id"])).fetchone()))
    if full:
        d["reviews"] = [dict(r) for r in c.execute("""SELECT r.rating, r.text, r.created, u.name FROM reviews r JOIN users u ON u.id=r.user_id
                        WHERE r.garage_id=? ORDER BY r.id DESC LIMIT 30""", (g["id"],))]
        for r in d["reviews"]: r["name"] = r["name"].split()[0]
    return d

def haversine(lat1, lng1, lat2, lng2):
    r = math.radians
    a = math.sin(r(lat2-lat1)/2)**2 + math.cos(r(lat1))*math.cos(r(lat2))*math.sin(r(lng2-lng1)/2)**2
    return 6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def booking_dict(c, b, for_owner=False):
    d = dict(b)
    g = c.execute("SELECT name, area, phone FROM garages WHERE id=?", (b["garage_id"],)).fetchone()
    d["garage_name"], d["garage_area"], d["garage_phone"] = g["name"], g["area"], g["phone"]
    r = c.execute("SELECT rating, text FROM reviews WHERE booking_id=?", (b["id"],)).fetchone()
    d["review"] = dict(r) if r else None
    if for_owner:
        u = c.execute("SELECT name, email, phone FROM users WHERE id=?", (b["user_id"],)).fetchone()
        d["customer"] = dict(name=u["name"], email=u["email"], phone=b["contact_phone"] or u["phone"])
    return d

def user_dict(u): return dict(id=u["id"], name=u["name"], email=u["email"], role=u["role"], phone=u["phone"])

# ---------- handlers: each takes (ctx) and returns JSON-able ----------
class Ctx:
    def __init__(self, c, user, body, query, ip): self.c, self.user, self.body, self.q, self.ip = c, user, body, query, ip
    def auth(self):
        need(self.user, "Please log in to continue", 401); return self.user
    def role(self, r):
        self.auth(); need(self.user["role"] == r, f"This action is for {'garage owners' if r=='owner' else 'customers'} only", 403); return self.user

ROUTES = []
def route(method, pattern):
    rx = re.compile("^" + re.sub(r"<(\w+)>", r"(?P<\1>\\d+)", pattern) + "$")
    def deco(fn): ROUTES.append((method, rx, fn)); return fn
    return deco

def new_session(c, uid):
    tok = secrets.token_urlsafe(32)
    c.execute("INSERT INTO sessions VALUES(?,?,?)", (tok, uid, time.time() + SESSION_DAYS * 86400))
    return tok

@route("POST", "/api/signup")
def signup(x):
    b = x.body
    need(not rate_limited("signup:" + x.ip, 10, 3600), "Too many sign-ups from this network. Try later.", 429)
    name, email = s(b.get("name"), 80, "Name"), s(b.get("email"), 120, "Email").lower()
    need(EMAIL_RE.match(email), "Enter a valid email address")
    pw = b.get("password") or ""
    need(isinstance(pw, str) and 8 <= len(pw) <= 100, "Password must be at least 8 characters")
    role = b.get("role", "customer"); need(role in ("customer", "owner"), "Invalid account type")
    need(not x.c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone(), "An account with this email already exists", 409)
    h, salt = hash_pw(pw)
    cur = x.c.execute("INSERT INTO users(name,email,pw_hash,salt,role,created) VALUES(?,?,?,?,?,?)", (name, email, h, salt, role, now()))
    u = x.c.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(user=user_dict(u)), new_session(x.c, u["id"])

@route("POST", "/api/login")
def login(x):
    email = s(x.body.get("email"), 120, "Email").lower(); pw = x.body.get("password") or ""
    need(not rate_limited("login:" + x.ip + email), "Too many attempts. Wait a few minutes and try again.", 429)
    u = x.c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    need(u and isinstance(pw, str) and check_pw(pw, u["pw_hash"], u["salt"]), "Incorrect email or password", 401)
    return dict(user=user_dict(u)), new_session(x.c, u["id"])

@route("POST", "/api/logout")
def logout(x): return dict(ok=True), "LOGOUT"

@route("GET", "/api/me")
def me(x): return dict(user=user_dict(x.user) if x.user else None)

@route("PUT", "/api/me")
def update_me(x):
    u = x.auth(); b = x.body
    name = s(b.get("name"), 80, "Name"); phone = s(b.get("phone"), 18, "Phone", False)
    need(not phone or PHONE_RE.match(phone), "Enter a valid phone number")
    x.c.execute("UPDATE users SET name=?, phone=? WHERE id=?", (name, phone, u["id"]))
    return dict(user=user_dict(x.c.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()))

@route("POST", "/api/me/password")
def change_pw(x):
    u = x.auth(); b = x.body
    need(check_pw(b.get("current") or "", u["pw_hash"], u["salt"]), "Current password is incorrect", 403)
    new = b.get("new") or ""; need(8 <= len(new) <= 100, "New password must be at least 8 characters")
    h, salt = hash_pw(new)
    x.c.execute("UPDATE users SET pw_hash=?, salt=? WHERE id=?", (h, salt, u["id"]))
    return dict(ok=True)

@route("GET", "/api/meta")
def meta(x): return dict(services=SERVICES, vehicles=VEHICLES, slots=SLOTS, modes=MODES)

# --- garages ---
@route("GET", "/api/garages")
def list_garages(x):
    q = x.q.get("q", [""])[0].strip().lower(); svc = x.q.get("service", [""])[0]; veh = x.q.get("vehicle", [""])[0]
    sort = x.q.get("sort", ["recommended"])[0]
    uid = x.user["id"] if x.user else None
    try: lat, lng = float(x.q["lat"][0]), float(x.q["lng"][0])
    except Exception: lat = lng = None
    if lat is not None and not (-90 <= lat <= 90 and -180 <= lng <= 180): lat = lng = None
    try: radius = float(x.q.get("radius", [""])[0]) if lat is not None else None
    except Exception: radius = None
    out = []
    for g in x.c.execute("SELECT * FROM garages WHERE active=1"):
        if q and q not in (g["name"] + " " + g["area"] + " " + g["description"]).lower(): continue
        if veh and veh not in g["vehicles"].split(","): continue
        d = garage_dict(x.c, g, uid)
        if svc and svc not in [i["service"] for i in d["services"]]: continue
        d["distance_km"] = round(haversine(lat, lng, g["lat"], g["lng"]), 1) if lat is not None and g["lat"] is not None else None
        if radius and (d["distance_km"] is None or d["distance_km"] > radius): continue
        out.append(d)
    if sort == "rating": out.sort(key=lambda d: (-(d["rating"] or 0), -d["review_count"]))
    elif sort == "price": out.sort(key=lambda d: d["min_price"] if d["min_price"] is not None else 10**9)
    elif sort == "distance" or (sort == "recommended" and lat is not None):
        out.sort(key=lambda d: d["distance_km"] if d["distance_km"] is not None else 10**6)
    else: out.sort(key=lambda d: (-(d["rating"] or 0), -d["review_count"], d["name"]))
    return dict(garages=out)

@route("GET", "/api/garages/<id>")
def get_garage(x, id):
    g = x.c.execute("SELECT * FROM garages WHERE id=? AND active=1", (id,)).fetchone()
    need(g, "Garage not found", 404)
    return dict(garage=garage_dict(x.c, g, x.user["id"] if x.user else None, full=True))

@route("GET", "/api/garages/<id>/slots")
def slots(x, id):
    g = x.c.execute("SELECT capacity FROM garages WHERE id=? AND active=1", (id,)).fetchone(); need(g, "Garage not found", 404)
    d = valid_date(x.q.get("date", [""])[0]); need(d >= date.today(), "Pick today or a future date")
    taken = {r["time"]: r["n"] for r in x.c.execute("SELECT time, COUNT(*) n FROM bookings WHERE garage_id=? AND date=? AND status IN('Requested','Confirmed') GROUP BY time", (id, d.isoformat()))}
    return dict(slots=[dict(time=t, available=max(0, g["capacity"] - taken.get(t, 0)) > 0) for t in SLOTS])

def parse_garage(b):
    name, area = s(b.get("name"), 80, "Garage name"), s(b.get("area"), 120, "Area / city")
    phone = s(b.get("phone"), 18, "Contact number"); need(PHONE_RE.match(phone), "Enter a valid contact number")
    desc = s(b.get("description"), 500, "Description", False)
    veh = [v for v in (b.get("vehicles") or []) if v in VEHICLES]; need(veh, "Select at least one vehicle type")
    svcs = {}
    for it in b.get("services") or []:
        if it.get("service") in SERVICES:
            try: p = int(it.get("price"))
            except Exception: raise ApiError(400, "Prices must be whole numbers")
            need(0 < p <= 1_000_000, "Enter a valid starting price"); svcs[it["service"]] = p
    need(svcs, "Add at least one service with a starting price")
    try: lat, lng = (float(b["lat"]), float(b["lng"])) if b.get("lat") not in (None, "") else (None, None)
    except Exception: raise ApiError(400, "Invalid coordinates")
    if lat is not None: need(-90 <= lat <= 90 and -180 <= lng <= 180, "Invalid coordinates")
    try: cap = int(b.get("capacity", 2))
    except Exception: cap = 2
    need(1 <= cap <= 20, "Capacity per slot must be between 1 and 20")
    return name, area, phone, desc, lat, lng, ",".join(veh), cap, svcs

def save_services(c, gid, svcs):
    c.execute("DELETE FROM garage_services WHERE garage_id=?", (gid,))
    c.executemany("INSERT INTO garage_services VALUES(?,?,?)", [(gid, k, v) for k, v in svcs.items()])

@route("POST", "/api/garages")
def create_garage(x):
    u = x.role("owner"); name, area, phone, desc, lat, lng, veh, cap, svcs = parse_garage(x.body)
    need(x.c.execute("SELECT COUNT(*) FROM garages WHERE owner_id=?", (u["id"],)).fetchone()[0] < 10, "Garage limit reached")
    cur = x.c.execute("INSERT INTO garages(owner_id,name,area,phone,description,lat,lng,vehicles,capacity,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (u["id"], name, area, phone, desc, lat, lng, veh, cap, now()))
    save_services(x.c, cur.lastrowid, svcs)
    return dict(id=cur.lastrowid)

def own_garage(x, id):
    u = x.role("owner"); g = x.c.execute("SELECT * FROM garages WHERE id=? AND owner_id=?", (id, u["id"])).fetchone()
    need(g, "Garage not found", 404); return g

@route("PUT", "/api/garages/<id>")
def update_garage(x, id):
    own_garage(x, id); name, area, phone, desc, lat, lng, veh, cap, svcs = parse_garage(x.body)
    x.c.execute("UPDATE garages SET name=?,area=?,phone=?,description=?,lat=?,lng=?,vehicles=?,capacity=? WHERE id=?", (name, area, phone, desc, lat, lng, veh, cap, id))
    save_services(x.c, int(id), svcs); return dict(ok=True)

@route("POST", "/api/garages/<id>/active")
def toggle_garage(x, id):
    g = own_garage(x, id); x.c.execute("UPDATE garages SET active=? WHERE id=?", (0 if g["active"] else 1, id)); return dict(active=not g["active"])

@route("GET", "/api/owner/garages")
def my_garages(x):
    u = x.role("owner")
    return dict(garages=[dict(garage_dict(x.c, g), active=bool(g["active"])) for g in x.c.execute("SELECT * FROM garages WHERE owner_id=? ORDER BY id DESC", (u["id"],))])

# --- vehicles / reminders / saved ---
@route("GET", "/api/vehicles")
def vehicles(x): return dict(vehicles=[dict(r) for r in x.c.execute("SELECT id,type,model,reg FROM vehicles WHERE user_id=?", (x.auth()["id"],))])

@route("POST", "/api/vehicles")
def add_vehicle(x):
    u = x.auth(); t = x.body.get("type"); need(t in VEHICLES, "Choose a vehicle type")
    need(x.c.execute("SELECT COUNT(*) FROM vehicles WHERE user_id=?", (u["id"],)).fetchone()[0] < 20, "Vehicle limit reached")
    x.c.execute("INSERT INTO vehicles(user_id,type,model,reg) VALUES(?,?,?,?)", (u["id"], t, s(x.body.get("model"), 60, "Vehicle model"), s(x.body.get("reg"), 20, "Registration", False).upper()))
    return dict(ok=True)

@route("DELETE", "/api/vehicles/<id>")
def del_vehicle(x, id): x.c.execute("DELETE FROM vehicles WHERE id=? AND user_id=?", (id, x.auth()["id"])); return dict(ok=True)

@route("GET", "/api/reminders")
def reminders(x): return dict(reminders=[dict(r) for r in x.c.execute("SELECT id,text,date FROM reminders WHERE user_id=? ORDER BY date", (x.auth()["id"],))])

@route("POST", "/api/reminders")
def add_reminder(x):
    u = x.auth(); valid_date(x.body.get("date", ""))
    need(x.c.execute("SELECT COUNT(*) FROM reminders WHERE user_id=?", (u["id"],)).fetchone()[0] < 100, "Reminder limit reached")
    x.c.execute("INSERT INTO reminders(user_id,text,date) VALUES(?,?,?)", (u["id"], s(x.body.get("text"), 100, "Reminder"), x.body["date"])); return dict(ok=True)

@route("DELETE", "/api/reminders/<id>")
def del_reminder(x, id): x.c.execute("DELETE FROM reminders WHERE id=? AND user_id=?", (id, x.auth()["id"])); return dict(ok=True)

@route("GET", "/api/saved")
def saved(x):
    u = x.auth()
    return dict(garages=[garage_dict(x.c, g, u["id"]) for g in x.c.execute("SELECT g.* FROM garages g JOIN saved s ON s.garage_id=g.id WHERE s.user_id=? AND g.active=1", (u["id"],))])

@route("POST", "/api/garages/<id>/save")
def save_garage(x, id):
    u = x.auth(); need(x.c.execute("SELECT 1 FROM garages WHERE id=?", (id,)).fetchone(), "Garage not found", 404)
    if x.c.execute("SELECT 1 FROM saved WHERE user_id=? AND garage_id=?", (u["id"], id)).fetchone():
        x.c.execute("DELETE FROM saved WHERE user_id=? AND garage_id=?", (u["id"], id)); return dict(saved=False)
    x.c.execute("INSERT INTO saved VALUES(?,?)", (u["id"], id)); return dict(saved=True)

# --- bookings ---
@route("POST", "/api/bookings")
def create_booking(x):
    u = x.role("customer"); b = x.body
    g = x.c.execute("SELECT * FROM garages WHERE id=? AND active=1", (b.get("garage_id"),)).fetchone(); need(g, "Garage not found", 404)
    price = x.c.execute("SELECT 1 FROM garage_services WHERE garage_id=? AND service=?", (g["id"], b.get("service"))).fetchone()
    need(price, "This garage does not offer that service")
    d = valid_date(b.get("date", "")); need(d >= date.today(), "Pick today or a future date")
    need(b.get("time") in SLOTS, "Choose a time slot"); need(b.get("mode") in MODES, "Choose a service option")
    vehicle = s(b.get("vehicle"), 80, "Vehicle"); notes = s(b.get("notes"), 400, "Notes", False)
    phone = s(b.get("phone"), 18, "Phone", False) or u["phone"]; need(not phone or PHONE_RE.match(phone), "Enter a valid phone number")
    need(x.c.execute("SELECT COUNT(*) FROM bookings WHERE user_id=? AND status IN('Requested','Confirmed') AND date>=?", (u["id"], date.today().isoformat())).fetchone()[0] < 15, "You have too many open bookings")
    x.c.execute("BEGIN IMMEDIATE")  # serialise slot check + insert
    n = x.c.execute("SELECT COUNT(*) FROM bookings WHERE garage_id=? AND date=? AND time=? AND status IN('Requested','Confirmed')", (g["id"], d.isoformat(), b["time"])).fetchone()[0]
    need(n < g["capacity"], "That time slot is full. Please choose another.", 409)
    cur = x.c.execute("""INSERT INTO bookings(user_id,garage_id,service,vehicle,date,time,mode,notes,contact_phone,status,created,updated)
                         VALUES(?,?,?,?,?,?,?,?,?,'Requested',?,?)""", (u["id"], g["id"], b["service"], vehicle, d.isoformat(), b["time"], b["mode"], notes, phone, now(), now()))
    if phone and not u["phone"]: x.c.execute("UPDATE users SET phone=? WHERE id=?", (phone, u["id"]))
    return dict(id=cur.lastrowid)

@route("GET", "/api/bookings")
def my_bookings(x):
    u = x.role("customer")
    return dict(bookings=[booking_dict(x.c, b) for b in x.c.execute("SELECT * FROM bookings WHERE user_id=? ORDER BY date DESC, id DESC", (u["id"],))])

@route("POST", "/api/bookings/<id>/cancel")
def cancel_booking(x, id):
    u = x.role("customer"); b = x.c.execute("SELECT * FROM bookings WHERE id=? AND user_id=?", (id, u["id"])).fetchone(); need(b, "Booking not found", 404)
    need(b["status"] in ("Requested", "Confirmed"), "This booking can no longer be cancelled")
    x.c.execute("UPDATE bookings SET status='Cancelled', updated=? WHERE id=?", (now(), id)); return dict(ok=True)

@route("POST", "/api/bookings/<id>/review")
def review(x, id):
    u = x.role("customer"); b = x.c.execute("SELECT * FROM bookings WHERE id=? AND user_id=?", (id, u["id"])).fetchone(); need(b, "Booking not found", 404)
    need(b["status"] == "Completed", "You can review a booking after the garage marks it completed")
    need(not x.c.execute("SELECT 1 FROM reviews WHERE booking_id=?", (id,)).fetchone(), "You already reviewed this booking", 409)
    try: r = int(x.body.get("rating"))
    except Exception: r = 0
    need(1 <= r <= 5, "Choose a rating from 1 to 5")
    x.c.execute("INSERT INTO reviews(booking_id,garage_id,user_id,rating,text,created) VALUES(?,?,?,?,?,?)", (id, b["garage_id"], u["id"], r, s(x.body.get("text"), 500, "Feedback", False), now()))
    return dict(ok=True)

@route("GET", "/api/owner/bookings")
def owner_bookings(x):
    u = x.role("owner")
    rows = x.c.execute("SELECT b.* FROM bookings b JOIN garages g ON g.id=b.garage_id WHERE g.owner_id=? ORDER BY b.date DESC, b.id DESC", (u["id"],))
    return dict(bookings=[booking_dict(x.c, b, True) for b in rows])

TRANSITIONS = {"Requested": {"Confirmed", "Rejected"}, "Confirmed": {"Completed", "Rejected"}}
@route("POST", "/api/bookings/<id>/status")
def set_status(x, id):
    u = x.role("owner")
    b = x.c.execute("SELECT b.* FROM bookings b JOIN garages g ON g.id=b.garage_id WHERE b.id=? AND g.owner_id=?", (id, u["id"])).fetchone(); need(b, "Booking not found", 404)
    st = x.body.get("status"); need(st in TRANSITIONS.get(b["status"], ()), f"Cannot change a {b['status']} booking to {st}")
    x.c.execute("UPDATE bookings SET status=?, garage_note=?, updated=? WHERE id=?", (st, s(x.body.get("note"), 300, "Note", False), now(), id)); return dict(ok=True)

@route("POST", "/api/contact")
def contact(x):
    need(not rate_limited("contact:" + x.ip, 5, 3600), "Too many messages. Try again later.", 429)
    email = s(x.body.get("email"), 120, "Email"); need(EMAIL_RE.match(email), "Enter a valid email address")
    x.c.execute("INSERT INTO messages(name,email,message,created) VALUES(?,?,?,?)", (s(x.body.get("name"), 80, "Name"), email, s(x.body.get("message"), 1500, "Message"), now()))
    return dict(ok=True)

# ---------- seed ----------
SAMPLE = [
 ("Northside Auto Care", "Indiranagar, Bengaluru", 12.9784, 77.6408, "Car,Two-wheeler", {"Routine servicing": 2800, "Mechanical repairs": 1500, "Tyres & batteries": 3400}, "Friendly neighbourhood workshop for scheduled servicing and repairs."),
 ("The Detail Studio", "Koramangala, Bengaluru", 12.9352, 77.6245, "Car,Two-wheeler", {"Cleaning & detailing": 1500}, "Interior and exterior detailing, polishing and ceramic coating."),
 ("Volt Vehicle Works", "HSR Layout, Bengaluru", 12.9116, 77.6389, "Electric vehicle,Car", {"Electrical & EV care": 799, "Routine servicing": 3500}, "EV diagnostics, battery health checks and charging support."),
 ("City Bike Clinic", "Jayanagar, Bengaluru", 12.9250, 77.5838, "Two-wheeler", {"Mechanical repairs": 299, "Routine servicing": 349, "Tyres & batteries": 399}, "Two-wheeler specialists. Quick turnaround on routine jobs."),
 ("Prime Motor Hub", "Whitefield, Bengaluru", 12.9698, 77.7500, "Car,Commercial vehicle", {"Routine servicing": 3200, "Mechanical repairs": 1500, "Cleaning & detailing": 1500}, "Multi-brand service centre for cars and light commercial vehicles."),
 ("Green Route EV Care", "Bellandur, Bengaluru", 12.9304, 77.6784, "Electric vehicle,Two-wheeler", {"Electrical & EV care": 599, "Tyres & batteries": 699}, "Electric scooter and car care, with battery and charger checks."),
]
DEMO_OWNER = ("owner@heeben.demo", "heeben-demo-1")

def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    c = db(); c.executescript(SCHEMA)
    if DEMO and not c.execute("SELECT 1 FROM garages").fetchone():
        h, salt = hash_pw(DEMO_OWNER[1])
        uid = c.execute("INSERT OR IGNORE INTO users(name,email,pw_hash,salt,role,created) VALUES('Demo Garage Owner',?,?,?,'owner',?)", (DEMO_OWNER[0], h, salt, now())).lastrowid
        uid = uid or c.execute("SELECT id FROM users WHERE email=?", (DEMO_OWNER[0],)).fetchone()[0]
        for n, a, la, ln, v, sv, d in SAMPLE:
            gid = c.execute("INSERT INTO garages(owner_id,name,area,phone,description,lat,lng,vehicles,capacity,is_sample,created) VALUES(?,?,?,?,?,?,?,?,2,1,?)", (uid, n, a, "+91 80000 00000", d, la, ln, v, now())).lastrowid
            save_services(c, gid, sv)
        print(f"Demo data loaded. Demo garage-owner login: {DEMO_OWNER[0]} / {DEMO_OWNER[1]}  (set HEEBEN_DEMO=0 for production)")
    c.execute("DELETE FROM sessions WHERE expires<?", (time.time(),)); c.commit(); c.close()

# ---------- HTTP ----------
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".txt": "text/plain"}
CSP = "default-src 'self'; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://nominatim.openstreetmap.org; frame-ancestors 'none'"

class Handler(BaseHTTPRequestHandler):
    server_version = "Heeben"
    def log_message(self, fmt, *a): sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

    def send(self, code, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff"); self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", CSP)
        if ctype == "application/json": self.send_header("Cache-Control", "no-store")
        for k, v in (extra or []): self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)

    def cookie_hdr(self, tok, clear=False):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return ("Set-Cookie", f"hb_session={'' if clear else tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if clear else SESSION_DAYS*86400}{secure}")

    def handle_api(self, method):
        u = urlparse(self.path); c = db()
        try:
            for m, rx, fn in ROUTES:
                mt = rx.match(u.path) if m == method else None
                if not mt: continue
                body = {}
                if method in ("POST", "PUT"):
                    need((self.headers.get("Content-Type") or "").startswith("application/json"), "Content-Type must be application/json", 415)
                    n = int(self.headers.get("Content-Length") or 0); need(n <= MAX_BODY, "Request too large", 413)
                    try: body = json.loads(self.rfile.read(n) or b"{}")
                    except Exception: raise ApiError(400, "Invalid JSON")
                    need(isinstance(body, dict), "Invalid JSON")
                tok = None
                ck = SimpleCookie(self.headers.get("Cookie") or "")
                user = None
                if "hb_session" in ck:
                    tok = ck["hb_session"].value
                    user = c.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?", (tok, time.time())).fetchone()
                ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
                res = fn(Ctx(c, user, body, parse_qs(u.query), ip), **mt.groupdict())
                extra = []
                if isinstance(res, tuple):
                    res, t = res
                    if t == "LOGOUT":
                        if tok: c.execute("DELETE FROM sessions WHERE token=?", (tok,))
                        extra.append(self.cookie_hdr("", True))
                    else: extra.append(self.cookie_hdr(t))
                c.commit(); return self.send(200, res, extra=extra)
            raise ApiError(404, "Not found")
        except ApiError as e:
            c.rollback(); self.send(e.status, dict(error=e.msg))
        except Exception as e:
            c.rollback(); sys.stderr.write(f"ERROR {type(e).__name__}: {e}\n"); self.send(500, dict(error="Something went wrong. Please try again."))
        finally: c.close()

    def static(self):
        p = urlparse(self.path).path
        f = (PUBLIC / ("index.html" if p == "/" else p.lstrip("/"))).resolve()
        if not str(f).startswith(str(PUBLIC)) or not f.is_file(): f = PUBLIC / "index.html"  # SPA fallback
        extra = [("Cache-Control", "no-cache")]
        self.send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"), extra)

    def do_GET(self):
        if self.path.startswith("/api/"): self.handle_api("GET")
        else: self.static()
    def do_HEAD(self): self.do_GET()
    def do_POST(self): self.handle_api("POST") if self.path.startswith("/api/") else self.send(405, dict(error="Method not allowed"))
    def do_PUT(self): self.handle_api("PUT") if self.path.startswith("/api/") else self.send(405, dict(error="Method not allowed"))
    def do_DELETE(self): self.handle_api("DELETE") if self.path.startswith("/api/") else self.send(405, dict(error="Method not allowed"))

if __name__ == "__main__":
    init_db()
    host, port = os.environ.get("HOST", "0.0.0.0"), int(os.environ.get("PORT", 8000))
    print(f"Heeben running on http://localhost:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
