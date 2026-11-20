# Heeben booking feature

## Customer flow
1. Sign in with a customer account.
2. Open a garage and choose **Request a booking**.
3. Select an offered service, saved/new vehicle, date, available slot, visit/pickup option and contact number.
4. Submit the request. Heeben displays a booking reference and stores the request.
5. Track status, garage response, contact details and the saved starting-price estimate under **Bookings**. Customers can cancel open requests and review completed work.

## Garage-owner flow
1. Sign in with a garage-owner account.
2. Open **My garage**.
3. Review new booking requests, customer contact details, selected vehicle/service, requested slot, notes and starting-price estimate.
4. Accept or decline requests; mark confirmed work completed. Add an optional note to the customer.

## Important pricing note
The amount displayed is the garage's listed starting price captured when the booking is created. It is not a final quote or online payment. The garage should confirm the final amount after inspecting the vehicle. Payment remains directly with the garage in this MVP.

## Backend safeguards
- Customer and owner role checks.
- Booking only at active garages that list the selected service.
- Date validation (today through 30 days ahead).
- Slot capacity checked inside a SQLite immediate transaction to reduce double booking.
- Customer can only view/cancel/review their own bookings.
- Garage owner can only manage bookings for garages they own.
- Existing databases automatically receive the `estimated_price` column; existing records are backfilled from current garage service prices where possible.

## Extended vehicle, quotation and inspection workflow
- Booking form explicitly captures vehicle type (Car, Two-wheeler, Electric vehicle, Commercial vehicle) as well as make/model. Saved vehicles prefill their type; new vehicles can be entered during booking.
- Garage owners can send a quotation after accepting a booking, including amount, work/parts details and an optional vehicle health report.
- Customers can approve or decline a pending quotation from My bookings. Quote decision is stored against the booking.
- Existing service history (completed/past bookings), customer reviews, saved vehicles and pickup-request option remain available.
- Database migrations add vehicle_type, quote_amount, quote_note, quote_status and health_report without dropping existing booking records.
