# Heeben feature upgrade — 23 November 2026

Based on the latest uploaded `Heeben_Production_Ready.zip`.

## Added
- Customer dashboard with vehicle, booking, completion and reward summaries.
- Vehicle passport/history view, based on matching saved vehicle model/registration labels in booking records.
- Reward ledger: 10 points per booking when its status changes to Completed; unique ledger key prevents duplicate credits for the same booking.
- Vehicle assistant with rule-based symptom categories and safety messaging.
- New API routes: `GET /api/dashboard`, `GET /api/vehicle-history`, `GET /api/rewards`, `POST /api/assistant`.

## Important limitations
- The vehicle assistant is rule-based, not connected to a hosted LLM. It gives general information only and does not diagnose faults.
- Reward points are an informational loyalty balance. No redemption, cash value, payment, or discount integration exists yet.
- Vehicle history associates older bookings by exact saved model/registration label. A future schema upgrade should add a vehicle_id foreign key to bookings for stronger matching.
- Customers should only use real account data after confirming persistent database storage is active. This project Blueprint uses `/data/heeben.db` on a persistent Render disk (Starter plan).

## Validation
- `python -m py_compile server.py`
- `node --check public/app.js`
- `python tests/smoke_test.py`

All checks passed on the packaged source.

## Heeben Rewards redemption upgrade (23 Nov 2026)
- Customers earn 10 points when a garage marks a booking Completed (existing idempotent credit remains).
- Added redeemable offers: 100 points = ₹50 off, 200 points = ₹120 off, 500 points = ₹350 off.
- Redeeming creates a unique, single-use voucher code and debits points from the customer's ledger.
- Customer dashboard shows available offers, voucher codes/status, and signed points activity.
- Garage owners can verify a voucher from the owner API; verification marks it Used and returns the discount amount. The garage must apply that discount to the service bill manually.
- The `reward_redemptions` table is created automatically by the server schema on startup. Existing reward balances are preserved.
- Automated smoke test covers earning, redeeming, voucher verification, and rejecting reuse of a voucher.


## About the Founder page (23 Nov 2026)
- Replaced the Price guide navigation item with About founder.
- Added a responsive founder page for Vaibhav Agarwal, Founder of Heeben, including the requested IIIT Bangalore AI & Data Science student description.
- Added the headline “Built on an idea. Driven by a vision.” and Heeben tagline “We Care Beyond the Drive.”
- Added mailto and telephone contact links.
- Removed the former Price guide view and its front-end renderer from the navigation flow.

- Added a doorstep service request mode to the booking flow. Customers can enter a service address; the request is explicitly subject to garage coverage and confirmation. This is a request workflow, not a promise of guaranteed doorstep dispatch.
- The online store remains a separate Heeben-branded website concept and is not embedded in this marketplace ZIP. A store URL/catalogue was not supplied, so no unverified external link was added.
