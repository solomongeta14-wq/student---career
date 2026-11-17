# FirstStep

A graduate-to-employer careers marketplace built with Node.js, SQLite, and a
responsive browser UI. It uses Node's built-in modules and does not require
third-party packages.

## Run locally

1. Install Node.js 22.13 or newer.
2. From this folder, run `npm start`.
3. Open `http://127.0.0.1:3000`.

The SQLite database is created at `data/firststep.sqlite` on first run. Set
`DATABASE_PATH` to use a different database file, or `PORT` to change the
default port.

Create separate graduate and employer accounts from **Sign in → Create an
account** to try both sides of the marketplace. Employer accounts need a
company or institution name.

## Included workflows

- Graduate and employer account registration, sign-in, and sign-out.
- Persistent graduate profiles, job search/filtering, saved roles, applications,
  and event RSVPs.
- Employer job posting and applicant review/status updates.
- Seeded example opportunities and career events for a useful first launch.

This is a local MVP: production deployment still needs HTTPS, backups, email
verification/password recovery, operational monitoring, and a privacy policy.
