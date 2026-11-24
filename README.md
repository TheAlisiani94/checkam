# CheckAm — medicine pack checker

A free web app that helps people in Nigeria spot fake or tampered medicine.
Anyone can use it without an account. People who want alerts about fakes in
their state can sign up with a WhatsApp number or email.

## What it does

- **Scan** the GS1 DataMatrix (small square dot code) with the phone camera, a photo, or by typing the printed numbers.
- **Checks**: invented product numbers (GS1 check digit), expired packs, box expiry that doesn't match the code (relabelled stock), plain barcodes that can't prove anything, and **copied codes** (the same serial scanned by other phones, especially in other towns).
- **My checks**: history saved on the phone only.
- **Alerts**: packs other users flagged or reported in the last 14 days, plus tips.
- **Updates**: optional sign-up for alerts, with a "Stop updates" button.
- Works offline once opened (service worker) and can be added to the home screen like an app.

## Files

| File | What it is |
|---|---|
| `index.html` | Screens and styles |
| `app.js` | All app logic |
| `config.js` | Your backend URL and public key (empty = phone-only mode) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and "Add to home screen" |
| `supabase/schema.sql` | Database tables and the only functions the public app can call |

## 1. Put it online for free (about 10 minutes)

The app is plain files, so any static host works. The easiest:

**Netlify Drop**: go to app.netlify.com/drop, sign in, and drag this whole folder onto the page. You get a link like `checkam-xyz.netlify.app`. You can rename it in Site settings.

Alternatives: Cloudflare Pages or GitHub Pages (push the folder to a repository and turn on Pages).

The site must be served over **https** for the camera to work. All of these hosts do that automatically.

At this point the app already works: every check runs on the phone. Only the copy check, alerts and sign-ups need step 2.

## 2. Connect the free backend (Supabase)

1. Create a free account at supabase.com and make a new project (choose a region close to Nigeria, e.g. Europe West).
2. Open **SQL Editor → New query**, paste everything from `supabase/schema.sql`, and press **Run**.
3. Open **Project settings → API**. Copy the **Project URL** and the **anon public** key.
4. Paste them into `config.js`, then upload the folder again (drag it onto Netlify Drop for the same site, or push to GitHub).

The anon key is meant to be public. The database is locked so that the app can only call the functions in `schema.sql`. It cannot read the subscriber list or raw scans. You see everything in Supabase under **Table Editor**:

- `scans`: every check (town, state, product, batch, result; no names)
- `reports`: what people reported, with `reviewed` to tick off
- `subscribers`: people who signed up, and whether they are still `active`

## 3. Sending alerts to subscribers

Version 1 collects sign-ups. To start, send alerts by hand: filter `subscribers` by state in Supabase and send a WhatsApp broadcast or email. Later you can automate this, for example with the WhatsApp Business API or an email service, when a NAFDAC alert or a cluster of flagged scans appears.

## Testing before launch

- Open the site on an Android phone in Chrome. Allow the camera, then scan a few real medicine packs.
- Try the four sample packs on the home screen to see each kind of result.
- With two phones, scan the same pack on both, with a different town set on each. The second phone should warn that the serial was already scanned elsewhere.

## Honest limits

- A clean result means **no warning signs**, not proof the pack is genuine. A fake with a never-before-seen serial will pass until the app can check NAFDAC's own traceability records.
- The copy check gets stronger as more people use the app.
- Food and cosmetics mostly have plain barcodes, so only basic checks apply to them.

## Next steps

1. Load NAFDAC public alerts and recalls; match them by product and batch.
2. Ask NAFDAC's Traceability Office for access to verify serials, and GS1 Nigeria for product lookups.
3. Add Pidgin, Hausa, Yoruba and Igbo.
4. A USSD/SMS version for basic phones.
5. A simple admin page that maps flagged scans by market.
