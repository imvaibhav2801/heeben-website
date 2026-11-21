"""End-to-end smoke test for Heeben's public customer/garage booking flow.
Run from project root: python3 tests/smoke_test.py
"""
import http.cookiejar
import importlib.util
import json
import tempfile
import threading
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("heeben_server", ROOT / "server.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def client(base):
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(opener, base, path, method="GET", payload=None):
    raw = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(base + path, data=raw, method=method,
        headers={"Content-Type": "application/json"} if raw is not None else {})
    try:
        with opener.open(request) as response:
            data = response.read()
            try: data = json.loads(data)
            except Exception: data = data.decode()
            return response.status, data
    except urllib.error.HTTPError as error:
        try: data = json.loads(error.read())
        except Exception: data = error.read().decode()
        return error.code, data


def main():
    with tempfile.TemporaryDirectory() as temp:
        app.DB_PATH = str(Path(temp) / "heeben-test.db")
        app.DEMO = False
        app.init_db()
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        anonymous, owner, customer = client(base), client(base), client(base)
        try:
            assert call(anonymous, base, "/healthz")[1] == "ok"
            assert call(owner, base, "/api/signup", "POST", {
                "name": "Garage Owner", "email": "owner@example.test",
                "password": "StrongPass123", "role": "owner"})[0] == 200
            assert call(customer, base, "/api/signup", "POST", {
                "name": "Customer", "email": "customer@example.test",
                "password": "StrongPass123", "role": "customer"})[0] == 200
            status, garage = call(owner, base, "/api/garages", "POST", {
                "name": "Test Garage", "area": "Koramangala, Bengaluru",
                "phone": "+919876543210", "description": "Test workshop",
                "vehicles": ["Car", "Two-wheeler"], "capacity": 2,
                "services": [{"service": "Routine servicing", "price": 1200}]})
            assert status == 200, garage
            booking_date = (date.today() + timedelta(days=1)).isoformat()
            status, booking = call(customer, base, "/api/bookings", "POST", {
                "garage_id": garage["id"], "service": "Routine servicing",
                "vehicle": "Honda City", "vehicle_type": "Car", "date": booking_date,
                "time": "11:00 AM", "mode": "Visit garage", "notes": "Smoke test",
                "phone": "+919876543210"})
            assert status == 200, booking
            status, owner_bookings = call(owner, base, "/api/owner/bookings")
            assert status == 200 and len(owner_bookings["bookings"]) == 1
            status, result = call(owner, base, f"/api/bookings/{booking['id']}/status", "POST",
                                  {"status": "Confirmed", "note": "Confirmed"})
            assert status == 200, result
            status, customer_bookings = call(customer, base, "/api/bookings")
            assert status == 200 and customer_bookings["bookings"][0]["status"] == "Confirmed"
            status, result = call(owner, base, f"/api/bookings/{booking['id']}/quote", "POST",
                                  {"amount": 1500, "note": "Oil and filter included", "health_report": "All good"})
            assert status == 200, result
            status, customer_bookings = call(customer, base, "/api/bookings")
            assert status == 200 and customer_bookings["bookings"][0]["quote_amount"] == 1500
            status, result = call(customer, base, f"/api/bookings/{booking['id']}/quote-response", "POST", {"decision": "Approved"})
            assert status == 200, result
            status, result = call(owner, base, f"/api/bookings/{booking['id']}/status", "POST",
                                  {"status": "Completed", "note": "Work completed"})
            assert status == 200, result
            status, result = call(customer, base, f"/api/bookings/{booking['id']}/review", "POST",
                                  {"rating": 5, "text": "Great service"})
            assert status == 200, result
            status, page = call(anonymous, base, "/")
            assert status == 200 and "Heeben" in page
            print("PASS: health check, site page, customer/owner signup, garage listing, booking request, owner acceptance and customer booking history.")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
