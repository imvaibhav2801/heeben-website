#!/usr/bin/env python3
"""Heeben MVP server — Python standard library only (no pip install needed).

Run:  python3 server.py            -> http://localhost:8000
Env:  PORT, HOST, HEEBEN_DB (sqlite path), HEEBEN_DEMO=1 to load sample garages/demo owner (off by default).
"""
import hashlib, hmac, json, math, os, re, secrets, sqlite3, sys, threading, time, smtplib, ssl
from datetime import date, datetime, timezone, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent.resolve()
PUBLIC = ROOT / "public"
DB_PATH = os.environ.get("HEEBEN_DB", str(ROOT / "data" / "heeben.db"))
DEMO = os.environ.get("HEEBEN_DEMO", "0") == "1"
SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER).strip()
SMTP_STARTTLS = os.environ.get("SMTP_STARTTLS", "1") == "1"
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "").strip()
SITE_URL = os.environ.get("SITE_URL", "https://heeben.com").rstrip("/")
SERVICE_GROUPS = {
    "General car servicing": ["General service", "Basic service", "Comprehensive service", "Engine oil & filter change", "Air filter replacement", "Coolant replacement", "Periodic inspection", "Routine servicing"],
    "Engine & transmission": ["Engine diagnostics & repair", "Clutch repair", "Gearbox / transmission repair", "Radiator & cooling system repair", "Exhaust system repair", "Mechanical repairs"],
    "Brakes & suspension": ["Brake repair", "Brake pad / shoe replacement", "Suspension & steering repair", "Bike brake service"],
    "Denting & painting": ["Denting & painting", "Scratch removal & paint touch-up", "Bumper repair / replacement", "Machine polishing", "Ceramic coating"],
    "Batteries": ["Battery check & replacement", "Tyres & batteries"],
    "Tyres & wheels": ["Tyre replacement", "Puncture repair", "Wheel alignment & balancing"],
    "AC & cooling": ["AC inspection & service", "AC gas refill", "AC repair"],
    "Electrical & EV services": ["Electrical diagnostics", "Wiring & lighting repair", "EV diagnostics & battery health check", "EV charger inspection", "Electrical & EV care"],
    "Cleaning & detailing": ["Exterior wash", "Interior deep cleaning", "Full car/bike detailing", "Cleaning & detailing"],
    "Glass & lights": ["Windshield / glass replacement", "Headlight / tail-light replacement"],
    "Inspection & diagnostics": ["Pre-purchase vehicle inspection", "Engine scanning / OBD diagnostics", "Full vehicle health inspection", "Pre-trip safety inspection"],
    "Two-wheeler services": ["Chain cleaning & lubrication", "Chain / sprocket replacement", "Scooter belt / CVT service", "Bike clutch & cable repair"],
}
SERVICES = [service for group in SERVICE_GROUPS.values() for service in group]
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
  status TEXT NOT NULL, garage_note TEXT DEFAULT '', estimated_price INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL,
  vehicle_type TEXT DEFAULT '', quote_amount INTEGER, quote_note TEXT DEFAULT '', quote_status TEXT DEFAULT 'Not sent', health_report TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_bookings_slot ON bookings(garage_id, date, time);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saved(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garage_id INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE, PRIMARY KEY(user_id, garage_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, name TEXT, email TEXT, message TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS reward_ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id INTEGER, points INTEGER NOT NULL, reason TEXT NOT NULL, created TEXT NOT NULL,
  UNIQUE(user_id, booking_id, reason));
CREATE TABLE IF NOT EXISTS reward_redemptions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE, points INTEGER NOT NULL, discount_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Issued',
  created TEXT NOT NULL, used TEXT DEFAULT '', garage_id INTEGER REFERENCES garages(id));
"""

def db():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA busy_timeout=10000")
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


def send_email(to_email, subject, body):
    """Best-effort email delivery. Core booking actions must work without SMTP."""
    if not (SMTP_HOST and SMTP_FROM and to_email):
        return False
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["From"] = SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=12, context=ssl.create_default_context()) as server:
                if SMTP_USER: server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=12) as server:
                server.ehlo()
                if SMTP_STARTTLS:
                    server.starttls(context=ssl.create_default_context()); server.ehlo()
                if SMTP_USER: server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        return True
    except Exception as exc:
        sys.stderr.write(f"EMAIL delivery failed ({type(exc).__name__})\n")
        return False


def queue_email(to_email, subject, body):
    if SMTP_HOST and SMTP_FROM and to_email:
        threading.Thread(target=send_email, args=(to_email, subject, body), daemon=True).start()


def notify_booking_owner(c, booking_id):
    row = c.execute("""SELECT b.*, g.name garage_name, g.area, u.email owner_email, cu.name customer_name
                       FROM bookings b JOIN garages g ON g.id=b.garage_id
                       JOIN users u ON u.id=g.owner_id JOIN users cu ON cu.id=b.user_id
                       WHERE b.id=?""", (booking_id,)).fetchone()
    if not row: return
    ref = f"HB-{datetime.strptime(row['created'][:10], '%Y-%m-%d').strftime('%y%m%d')}-{row['id']:06d}"
    queue_email(row['owner_email'], f"New Heeben booking request · {ref}",
        f"Hello,\n\nYou have a new booking request for {row['garage_name']}.\n"
        f"Customer: {row['customer_name']}\nService: {row['service']}\nVehicle: {row['vehicle_type']} · {row['vehicle']}\n"
        f"Requested date/time: {row['date']} · {row['time']}\nContact: {row['contact_phone']}\n"
        f"Booking reference: {ref}\n\nLog in to your Heeben garage dashboard to accept or decline this request: {SITE_URL}\n")


def notify_booking_customer(c, booking_id, event):
    row = c.execute("""SELECT b.*, g.name garage_name, u.email customer_email, u.name customer_name
                       FROM bookings b JOIN garages g ON g.id=b.garage_id
                       JOIN users u ON u.id=b.user_id WHERE b.id=?""", (booking_id,)).fetchone()
    if not row: return
    if event == "status":
        subject = f"Your Heeben booking is {row['status'].lower()}"
        detail = f"Your booking with {row['garage_name']} is now {row['status']}.\nGarage message: {row['garage_note'] or 'No additional message.'}"
    else:
        subject = f"A quotation is ready for your Heeben booking"
        detail = f"{row['garage_name']} has shared a quotation of INR {row['quote_amount']}.\nDetails: {row['quote_note'] or 'Please review the quotation in your account.'}\nVehicle health report: {row['health_report'] or 'Not provided.'}"
    queue_email(row['customer_email'], subject,
        f"Hello {row['customer_name']},\n\n{detail}\n\nReview your booking in Heeben: {SITE_URL}\n")

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
    d["booking_ref"] = f"HB-{datetime.strptime(b['created'][:10], '%Y-%m-%d').strftime('%y%m%d')}-{b['id']:06d}"
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
    current_time = datetime.now().strftime("%I:%M %p") if d == date.today() else None
    return dict(slots=[dict(time=t, available=(max(0, g["capacity"] - taken.get(t, 0)) > 0 and (current_time is None or datetime.strptime(t, "%I:%M %p").time() > datetime.strptime(current_time, "%I:%M %p").time()))) for t in SLOTS])

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

# --- customer dashboard, vehicle history and rewards ---
@route("GET", "/api/dashboard")
def customer_dashboard(x):
    u = x.role("customer")
    bookings = [booking_dict(x.c, b) for b in x.c.execute("SELECT * FROM bookings WHERE user_id=? ORDER BY date DESC,id DESC", (u["id"],))]
    vehicles = [dict(r) for r in x.c.execute("SELECT id,type,model,reg FROM vehicles WHERE user_id=? ORDER BY id DESC", (u["id"],))]
    points = x.c.execute("SELECT COALESCE(SUM(points),0) n FROM reward_ledger WHERE user_id=?", (u["id"],)).fetchone()["n"]
    return dict(vehicles=vehicles, bookings=bookings, points=points,
      upcoming=sum(1 for b in bookings if b["status"] in ("Requested","Confirmed") and b["date"] >= date.today().isoformat()),
      completed=sum(1 for b in bookings if b["status"] == "Completed"),
      reminders=[dict(r) for r in x.c.execute("SELECT id,text,date FROM reminders WHERE user_id=? ORDER BY date LIMIT 8", (u["id"],))])

@route("GET", "/api/vehicle-history")
def vehicle_history(x):
    u = x.role("customer")
    rows = [dict(r) for r in x.c.execute("SELECT id,type,model,reg FROM vehicles WHERE user_id=? ORDER BY id DESC", (u["id"],))]
    history = []
    for v in rows:
        # Existing bookings store a vehicle label; match exact model or registration where present.
        matches = x.c.execute("SELECT b.*,g.name garage_name,g.area FROM bookings b JOIN garages g ON g.id=b.garage_id WHERE b.user_id=? AND (LOWER(b.vehicle)=LOWER(?) OR (?<>'' AND UPPER(b.vehicle)=UPPER(?))) ORDER BY b.date DESC,b.id DESC", (u["id"], v["model"], v["reg"], v["reg"])).fetchall()
        history.append(dict(vehicle=v, records=[dict(id=b["id"],service=b["service"],date=b["date"],status=b["status"],garage_name=b["garage_name"],garage_area=b["area"],quote_amount=b["quote_amount"],quote_status=b["quote_status"],health_report=b["health_report"],estimated_price=b["estimated_price"]) for b in matches]))
    return dict(history=history)

REWARD_OFFERS = [dict(points=100, discount_amount=50, label="₹50 off", description="Redeem 100 Heeben points"),
                 dict(points=200, discount_amount=120, label="₹120 off", description="Redeem 200 Heeben points"),
                 dict(points=500, discount_amount=350, label="₹350 off", description="Redeem 500 Heeben points")]

@route("GET", "/api/rewards")
def rewards(x):
    u=x.role("customer")
    return dict(points=x.c.execute("SELECT COALESCE(SUM(points),0) n FROM reward_ledger WHERE user_id=?",(u["id"],)).fetchone()["n"],
      transactions=[dict(r) for r in x.c.execute("SELECT points,reason,created FROM reward_ledger WHERE user_id=? ORDER BY id DESC LIMIT 50",(u["id"],))],
      offers=REWARD_OFFERS,
      redemptions=[dict(code=r["code"],points=r["points"],discount_amount=r["discount_amount"],status=r["status"],created=r["created"],used=r["used"]) for r in x.c.execute("SELECT * FROM reward_redemptions WHERE user_id=? ORDER BY id DESC LIMIT 20",(u["id"],))],
      rules=["Earn 10 points when a booking is marked completed.","Redeem points for a service discount voucher at a participating Heeben garage.","Vouchers are single-use and must be shown to the garage before payment."])

@route("POST", "/api/rewards/redeem")
def redeem_reward(x):
    u=x.role("customer")
    try: points=int(x.body.get("points",0))
    except Exception: points=0
    offer=next((o for o in REWARD_OFFERS if o["points"]==points),None)
    need(offer, "Choose one of the available reward offers")
    x.c.execute("BEGIN IMMEDIATE")
    balance=x.c.execute("SELECT COALESCE(SUM(points),0) n FROM reward_ledger WHERE user_id=?",(u["id"],)).fetchone()["n"]
    need(balance>=points, "You do not have enough points for this reward", 400)
    code="HB"+secrets.token_hex(4).upper()
    stamp=now()
    x.c.execute("INSERT INTO reward_ledger(user_id,booking_id,points,reason,created) VALUES(?,NULL,?,?,?)",(u["id"],-points,"Redeemed for ₹%s service voucher" % offer["discount_amount"],stamp))
    x.c.execute("INSERT INTO reward_redemptions(user_id,code,points,discount_amount,status,created) VALUES(?,?,?,?, 'Issued',?)",(u["id"],code,points,offer["discount_amount"],stamp))
    return dict(ok=True,code=code,points=points,discount_amount=offer["discount_amount"],balance=balance-points)

@route("POST", "/api/owner/rewards/verify")
def verify_reward(x):
    u=x.role("owner")
    code=s(x.body.get("code"), 20, "Voucher code").upper()
    garage=x.c.execute("SELECT id FROM garages WHERE owner_id=? AND active=1 ORDER BY id LIMIT 1",(u["id"],)).fetchone()
    need(garage, "List and activate your garage before verifying vouchers")
    row=x.c.execute("SELECT * FROM reward_redemptions WHERE code=?",(code,)).fetchone()
    need(row, "Voucher code not found",404)
    need(row["status"]=="Issued", "This voucher has already been used",409)
    x.c.execute("UPDATE reward_redemptions SET status='Used',used=?,garage_id=? WHERE id=? AND status='Issued'",(now(),garage["id"],row["id"]))
    need(x.c.execute("SELECT changes()").fetchone()[0]==1, "This voucher has already been used",409)
    return dict(ok=True,discount_amount=row["discount_amount"],message="Voucher verified. Apply this discount to the customer's service bill.")

@route("POST", "/api/assistant")
def vehicle_assistant(x):
    x.role("customer")
    question=s(x.body.get("message"),700,"Question")
    q=question.lower()
    urgent=any(k in q for k in ["smoke","fire","burning smell","brake failure","brakes failed","steering failed","fuel leak","accident"])
    if urgent:
        answer="This may be safety-critical. Stop in a safe place, switch off the vehicle if appropriate, and do not continue driving/riding. Contact roadside assistance or emergency services and arrange a professional inspection."
        category="Safety first"
    elif any(k in q for k in ["battery","start","starting","crank","won't start","wont start"]):
        answer="Possible causes include a weak battery, loose terminals, starter motor or charging-system issue. Check only for obvious loose connections if safe; avoid repeated start attempts. A garage can test the battery and charging system."
        category="Starting / battery"
    elif any(k in q for k in ["noise","sound","click","squeak","grinding","vibration"]):
        answer="A new noise or vibration can come from brakes, tyres, suspension, chain/belt, bearings or engine components. Note when it happens (starting, braking, turning or accelerating). If it is loud, worsening or affects control, stop using the vehicle and get it inspected."
        category="Noise / vibration"
    elif any(k in q for k in ["overheat","temperature","hot","coolant"]):
        answer="Overheating can be caused by low coolant, a leak, radiator fan, thermostat or water-pump issue. Pull over safely and let the engine cool. Never open a hot radiator cap. Arrange an inspection before continuing."
        category="Overheating"
    elif any(k in q for k in ["oil","service","maintenance","change"]):
        answer="Maintenance depends on your vehicle and its manufacturer's schedule. Check the owner's manual and service history for the correct interval and specification. Heeben can help you find a garage for an oil change or routine inspection."
        category="Maintenance"
    else:
        answer="I can help with general vehicle-care guidance. Tell me the vehicle type/model, what you noticed, when it happens, and any warning lights. I can suggest possible areas to check and a suitable service category, but a mechanic must confirm the diagnosis."
        category="General guidance"
    return dict(category=category,answer=answer,disclaimer="Heeben Assistant provides general information, not a confirmed diagnosis. A qualified technician should inspect the vehicle.")

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
    price = x.c.execute("SELECT price FROM garage_services WHERE garage_id=? AND service=?", (g["id"], b.get("service"))).fetchone()
    need(price, "This garage does not offer that service")
    d = valid_date(b.get("date", "")); need(date.today() <= d <= date.today() + timedelta(days=30), "Choose a date within the next 30 days")
    need(b.get("time") in SLOTS, "Choose a time slot"); need(b.get("mode") in MODES, "Choose a service option")
    if d == date.today(): need(datetime.strptime(b["time"], "%I:%M %p").time() > datetime.now().time(), "That time has already passed. Choose another slot.")
    vehicle = s(b.get("vehicle"), 80, "Vehicle"); vehicle_type = b.get("vehicle_type", ""); need(vehicle_type in VEHICLES, "Choose your vehicle type"); notes = s(b.get("notes"), 400, "Notes", False)
    phone = s(b.get("phone"), 18, "Phone", False) or u["phone"]; need(not phone or PHONE_RE.match(phone), "Enter a valid phone number")
    need(x.c.execute("SELECT COUNT(*) FROM bookings WHERE user_id=? AND status IN('Requested','Confirmed') AND date>=?", (u["id"], date.today().isoformat())).fetchone()[0] < 15, "You have too many open bookings")
    x.c.execute("BEGIN IMMEDIATE")  # serialise slot check + insert
    n = x.c.execute("SELECT COUNT(*) FROM bookings WHERE garage_id=? AND date=? AND time=? AND status IN('Requested','Confirmed')", (g["id"], d.isoformat(), b["time"])).fetchone()[0]
    need(n < g["capacity"], "That time slot is full. Please choose another.", 409)
    cur = x.c.execute("""INSERT INTO bookings(user_id,garage_id,service,vehicle,date,time,mode,notes,contact_phone,status,estimated_price,created,updated,vehicle_type)
                         VALUES(?,?,?,?,?,?,?,?,?,'Requested',?,?,?,?)""", (u["id"], g["id"], b["service"], vehicle, d.isoformat(), b["time"], b["mode"], notes, phone, price["price"], now(), now(), vehicle_type))
    if phone and not u["phone"]: x.c.execute("UPDATE users SET phone=? WHERE id=?", (phone, u["id"]))
    notify_booking_owner(x.c, cur.lastrowid)
    return dict(id=cur.lastrowid, booking_ref=f"HB-{datetime.now().strftime('%y%m%d')}-{cur.lastrowid:06d}", estimated_price=price["price"])

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
    x.c.execute("UPDATE bookings SET status=?, garage_note=?, updated=? WHERE id=?", (st, s(x.body.get("note"), 300, "Note", False), now(), id))
    if st == "Completed":
        # Idempotent ledger entry: one reward credit per completed booking.
        x.c.execute("INSERT OR IGNORE INTO reward_ledger(user_id,booking_id,points,reason,created) VALUES(?,?,10,'Completed service',?)", (b["user_id"], int(id), now()))
    notify_booking_customer(x.c, int(id), "status")
    return dict(ok=True)

@route("POST", "/api/bookings/<id>/quote")
def send_quote(x, id):
    u = x.role("owner")
    b = x.c.execute("SELECT b.* FROM bookings b JOIN garages g ON g.id=b.garage_id WHERE b.id=? AND g.owner_id=?", (id, u["id"])).fetchone(); need(b, "Booking not found", 404)
    need(b["status"] in ("Confirmed", "Completed"), "Accept the booking before sending a quotation")
    try: amount = int(x.body.get("amount"))
    except Exception: amount = 0
    need(1 <= amount <= 1000000, "Enter a valid quotation amount")
    note = s(x.body.get("note"), 500, "Quotation details", False)
    report = s(x.body.get("health_report"), 1200, "Vehicle health report", False)
    x.c.execute("UPDATE bookings SET quote_amount=?,quote_note=?,quote_status='Pending customer approval',health_report=?,updated=? WHERE id=?", (amount, note, report, now(), id))
    notify_booking_customer(x.c, int(id), "quote")
    return dict(ok=True)

@route("POST", "/api/bookings/<id>/quote-response")
def quote_response(x, id):
    u = x.role("customer"); b = x.c.execute("SELECT * FROM bookings WHERE id=? AND user_id=?", (id, u["id"])).fetchone(); need(b, "Booking not found", 404)
    need(b["quote_status"] == "Pending customer approval", "There is no quotation awaiting approval")
    decision = x.body.get("decision"); need(decision in ("Approved", "Declined"), "Choose approve or decline")
    x.c.execute("UPDATE bookings SET quote_status=?,updated=? WHERE id=?", (decision, now(), id)); return dict(ok=True)

@route("POST", "/api/contact")
def contact(x):
    need(not rate_limited("contact:" + x.ip, 5, 3600), "Too many messages. Try again later.", 429)
    email = s(x.body.get("email"), 120, "Email"); need(EMAIL_RE.match(email), "Enter a valid email address")
    name = s(x.body.get("name"), 80, "Name")
    message = s(x.body.get("message"), 1500, "Message")
    x.c.execute("INSERT INTO messages(name,email,message,created) VALUES(?,?,?,?)", (name, email, message, now()))
    if CONTACT_EMAIL:
        queue_email(CONTACT_EMAIL, f"Heeben website message from {name}", f"From: {name} <{email}>\n\n{message}\n")
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
    # Backward-compatible migration for databases created before booking price snapshots.
    booking_cols = {r["name"] for r in c.execute("PRAGMA table_info(bookings)")}
    if "estimated_price" not in booking_cols:
        c.execute("ALTER TABLE bookings ADD COLUMN estimated_price INTEGER NOT NULL DEFAULT 0")
        c.execute("UPDATE bookings SET estimated_price=COALESCE((SELECT price FROM garage_services gs WHERE gs.garage_id=bookings.garage_id AND gs.service=bookings.service),0)")
    for col, definition in [("vehicle_type", "TEXT DEFAULT ''"), ("quote_amount", "INTEGER"), ("quote_note", "TEXT DEFAULT ''"), ("quote_status", "TEXT DEFAULT 'Not sent'"), ("health_report", "TEXT DEFAULT ''")]:
        if col not in booking_cols: c.execute(f"ALTER TABLE bookings ADD COLUMN {col} {definition}")
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
CSP = "default-src 'self'; script-src 'self' https://unpkg.com; img-src 'self' data: https://images.unsplash.com https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src https://fonts.gstatic.com; connect-src 'self' https://nominatim.openstreetmap.org https://overpass-api.de; frame-ancestors 'none'"

class Handler(BaseHTTPRequestHandler):
    server_version = "Heeben"
    def log_message(self, fmt, *a): sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

    def send(self, code, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff"); self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY"); self.send_header("Permissions-Policy", "geolocation=(self)")
        self.send_header("Content-Security-Policy", CSP)
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if ctype == "application/json": self.send_header("Cache-Control", "no-store")
        for k, v in (extra or []): self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)

    def cookie_hdr(self, tok, clear=False):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "").lower() == "https" else ""
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
                    try: n = int(self.headers.get("Content-Length") or 0)
                    except ValueError: raise ApiError(400, "Invalid Content-Length")
                    need(0 <= n <= MAX_BODY, "Request too large", 413)
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

    def static(self, head=False):
        p = urlparse(self.path).path
        if p == "/healthz":
            return self.send(200, b"ok", "text/plain; charset=utf-8", [("Cache-Control", "no-store")])
        f = (PUBLIC / ("index.html" if p == "/" else p.lstrip("/"))).resolve()
        try: f.relative_to(PUBLIC.resolve())
        except ValueError: f = PUBLIC / "index.html"
        if not f.is_file(): f = PUBLIC / "index.html"  # SPA fallback
        extra = [("Cache-Control", "no-cache")]
        data = f.read_bytes()
        if head:
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(f.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
        else:
            self.send(200, data, MIME.get(f.suffix, "application/octet-stream"), extra)

    def do_GET(self):
        if self.path.startswith("/api/"): self.handle_api("GET")
        else: self.static()
    def do_HEAD(self):
        if self.path.startswith("/api/"): self.handle_api("GET")
        else: self.static(head=True)
    def do_POST(self): self.handle_api("POST") if self.path.startswith("/api/") else self.send(405, dict(error="Method not allowed"))
    def do_PUT(self): self.handle_api("PUT") if self.path.startswith("/api/") else self.send(405, dict(error="Method not allowed"))
    def do_DELETE(self): self.handle_api("DELETE") if self.path.startswith("/api/") else self.send(405, dict(error="Method not allowed"))

if __name__ == "__main__":
    init_db()
    host, port = os.environ.get("HOST", "0.0.0.0"), int(os.environ.get("PORT", 8000))
    print(f"Heeben running on http://localhost:{port}")
    print("Demo listings are OFF. Set HEEBEN_DEMO=1 only for local demonstrations.")
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.allow_reuse_address = True
    try: server.serve_forever()
    except KeyboardInterrupt: print("\nShutting down Heeben...")
    finally: server.server_close()
