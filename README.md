# Prisma SD-WAN Monitor

A dashboard for your Prisma SD-WAN tenants that runs on your own computer: site status, circuit health, devices, top
applications, alarms, an ION connectivity monitor and flow search. Switch between several tenants.

Not an official Palo Alto Networks product; provided as-is under the [MIT licence](LICENSE).

## Start

You need Python 3.10 or newer. Open a terminal in the Monitor's folder and run:

- **Windows:** `.\start.bat`
- **macOS / Linux:** `./start.command`

The first start takes about a minute. The Monitor then opens at http://127.0.0.1:5050.
To stop it, press Ctrl+C in the terminal.

What the start script does on your computer, all inside the Monitor's folder:

1. Checks for Python 3.10 or newer.
2. On the first run, creates a private Python environment in `.venv`. Nothing is installed system-wide.
3. Installs the packages in `requirements.txt` into `.venv` (Flask, Waitress, Requests, and Keyring on macOS / Linux),
   downloaded from PyPI. It does this again only when `requirements.txt` changes, for example after a `git pull`.
4. Runs `app.py`, which serves the Monitor on 127.0.0.1:5050 (only reachable from this computer) and opens it in
   your browser.

To remove the Monitor, delete your tenants in **Manage tenants** (on macOS / Linux that also removes their secrets from
the keychain), then delete its folder.

## Add a tenant

Click **Manage tenants**, enter the TSG ID, a name, and the client ID and secret of a service account (read-only is
enough), click **Test**, then **Save**.

## Where things are kept

Everything stays in the `data` folder next to `app.py`: your tenants, and caches that make pages open fast after a
restart. Client secrets are kept in the OS keychain (macOS Keychain), or encrypted for your Windows account. Nothing is
sent anywhere except to Palo Alto Networks.

To use another port or data folder, set `PORT` or `MANAGER_DATA_DIR` before starting.

**Upgrading from 1.x:** stop 1.x, update the folder (`git pull`, or unzip over it), start again. Your tenants and
secrets carry over.

## How it works

The Monitor has two parts, both on your computer.

**The server** (Python: Flask, served by Waitress on 127.0.0.1) does all the work with Prisma SASE:

- Keeps your tenants and their secrets, gets an OAuth2 token per tenant, and is the only part that talks to the API.
  Your browser never sees a client secret or token.
- Paces every API call (a rate limit, a cap on calls in flight per endpoint, slowing down after a 429, retries), and
  shares and caches results, so several tabs don't multiply the calls.
- Turns API responses into what each page shows: site status, problems and alarms, circuit statistics (p95, peaks,
  spikes), device health, app statistics, probe results, health, and flow records with policy and app names.
- Runs background jobs: refreshing the Overview, the 24 h of 1-minute circuit data for open sites, Top applications,
  Flow Search, and the ION Connectivity Monitor, which watches the IONs even when no page is looking.
- Saves what is slow to fetch again in the `data` folder, so pages open fast after a restart.
- Blocks requests that don't come from its own pages (Host and cross-site checks, a strict Content-Security-Policy).

**The client** (your browser: two pages built with Alpine.js, the Dashboard and Flow Search) shows the data:

- Asks the server for JSON and polls it while a page is open (the Overview, the open site, a running search). It
  never calls Prisma itself.
- Draws the pages: the Overview's cards and table, Site details' tables and bars, filters, sorting, paging, the
  period choice, HELP, and the light / dark theme.
- Works out what is only about display: cell colours and statuses from the server's figures, Flow Search's column
  filters, sorting and summaries, and CSV export.
- Keeps your view settings (sort, filters, collapsed sections, acknowledged app alarms) in the browser.
- Shows the ION Connectivity Monitor's alerts, pop-ups and sound as soon as the server reports an event.

## More

- Each section has a **HELP** button that explains where its data comes from.
