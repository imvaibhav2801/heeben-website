# Heeben — full marketplace prototype (local demo)

This version expands the Heeben front-end into an interactive marketplace prototype.

## Run locally on Mac
1. Download and unzip this folder.
2. Open the `heeben_full_marketplace_demo` folder in VS Code.
3. Open Terminal → New Terminal.
4. Run `python3 -m http.server 8000`.
5. Visit `http://localhost:8000`.

Stop the server with `Control + C`.

## Included in this prototype
- Responsive home, services, garage discovery, bookings and garage dashboard views.
- Customer sign-up/login demo.
- Vehicle type selection and saving vehicle details.
- Service category selection.
- Garage search and filters by service and vehicle.
- Demo booking flow with date, time, visit/pickup preference and payment choice.
- Booking history, cancellation, simulated partner acceptance/rejection.
- Local service reminders and customer reviews.
- Garage partner interest registration.
- Browser localStorage persistence so demo data stays in that browser.

## Important limitations
This is a **front-end demo**, not a production marketplace. Login is not secure authentication; data is stored only in the current browser using localStorage. Garage listings are fictional sample listings and must not be treated as real or verified. No actual bookings are sent to garages. Online payment is only a simulation: no money is collected. Pickup availability is not verified. There is no shared backend, database, server-side validation, email/SMS, maps, live location, or admin system yet.

## Next production steps
After reviewing the UI, we can build a backend (for example FastAPI), database, secure authentication, real garage onboarding, verified listings, booking APIs, payment gateway integration, notifications, and an admin console. Do not enter real passwords, payment details, or personal information in this demo.
