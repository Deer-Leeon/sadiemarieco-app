# Sadie Marie Beauty Studio

A production-ready static website for **Sadie Marie — Luxury Beauty Studio**, an editorial-magazine-inspired marketing site for a luxury beauty studio based in Lehi, Utah. Built with semantic HTML, modern CSS (Grid, Flexbox, custom properties), and vanilla JavaScript — no build step required.

## Features

- Magazine-cover hero section with editorial typography
- Services and pricing in a multi-column newspaper layout
- About section with overlapping image and quote treatment
- Portfolio collage with hover interactions
- Studio policies in a clean three-column grid
- Contact form and FAQ accordion
- Fully responsive across mobile, tablet, and desktop
- Smooth scroll-reveal animations powered by `IntersectionObserver`

## Project Structure

```
.
├── index.html              # The site
├── css/
│   └── styles.css          # All styles (including responsive @media queries)
├── js/
│   └── main.js             # Nav scroll, reveal animations, FAQ accordion
├── assets/
│   └── images/             # All site images live here
├── .gitignore
└── README.md
```

## Image Assets

Place your images in `assets/images/` using these exact filenames (lowercase, no spaces — important because Vercel runs on case-sensitive Linux):

| File                                  | Used in section      | Suggested source                 |
| ------------------------------------- | -------------------- | -------------------------------- |
| `assets/images/hero1.jpg`             | Hero                 | Your "Hero Picture" photo        |
| `assets/images/mckenna1.jpeg`         | About                | Your "McKenna" photo             |
| `assets/images/addy1.jpeg`            | Portfolio (Classic Lashes) | Your "Addy" photo          |
| `assets/images/glow-facial.jpg`       | Portfolio (Glow Facial)     | Replace with your own photo |
| `assets/images/brow-lamination.jpg`   | Portfolio (Brow Lamination) | Replace with your own photo |
| `assets/images/volume-set.jpg`        | Portfolio (Volume Set)      | Replace with your own photo |
| `assets/images/skin-treatment.jpg`    | Portfolio (Skin Treatment)  | Replace with your own photo |

> **Tip:** Optimize images to ~1600px on the longest edge and compress them (e.g., with [Squoosh](https://squoosh.app/)) for fast load times.

### Important: convert iPhone photos to sRGB before adding them

Photos straight from an iPhone are saved with an embedded **Display P3** color profile. Safari color-manages this correctly, but Chrome and most other browsers render P3 images inconsistently — typically washed out or over-exposed. To keep colors identical across every browser and device, convert any new photo to standard **sRGB** before committing it.

This repo ships with a small Python helper (`scripts/convert_to_srgb.py`) that uses Pillow's ICC color-management to do the conversion safely. macOS's built-in `sips --matchTo` can silently corrupt some iPhone JPEGs into all-black images, so we avoid it.

**One-time setup** (creates a local virtual environment for the script):

```bash
python3 -m venv .venv
.venv/bin/pip install Pillow
```

**Convert any photos you add to `assets/images/`:**

```bash
.venv/bin/python scripts/convert_to_srgb.py
```

The script will process every `.jpg`/`.jpeg` in `assets/images/`, detect its source profile, convert the pixel data to sRGB, and re-save at JPEG quality 90 with the sRGB profile embedded. Verify any individual file with:

```bash
sips -g profile assets/images/your-photo.jpeg
# Should print:  profile: sRGB IEC61966-2.1
```

## Run Locally

Because this is a pure static site, you have a few easy options.

### Option 1 — Open the file directly
Double-click `index.html` to open it in your browser. Works for most things, but some browsers restrict certain features when files load over the `file://` protocol.

### Option 2 — Local server (recommended)
A local web server gives you a clean `http://` URL and avoids any `file://` quirks.

**Using Python (already installed on macOS):**

```bash
python3 -m http.server 8001
```

Then open <http://localhost:8001> in your browser.

**Using Node.js:**

```bash
npx serve .
```

**Using VS Code:**
Install the *Live Server* extension, right-click `index.html`, and choose **Open with Live Server**.

## Deploy to Vercel

This site is configured to deploy on [Vercel](https://vercel.com/) with zero configuration — no build step, no framework detection.

### 1. Push the repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Sadie Marie Beauty Studio website"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### 2. Import the repo into Vercel

1. Go to <https://vercel.com/new>.
2. Click **Import Git Repository** and select this repo.
3. When asked for the **Framework Preset**, choose **Other** (Vercel will detect it as a static site automatically).
4. Leave **Build Command**, **Output Directory**, and **Install Command** blank.
5. Click **Deploy**.

Vercel will give you a live URL (e.g. `sadie-marie.vercel.app`) within seconds. Every push to `main` automatically deploys; pushes to other branches create preview URLs.

### 3. Add a custom domain (optional)

In your Vercel project dashboard, go to **Settings → Domains** and follow the prompts to add a domain like `sadiemarie.co`. Vercel walks you through the DNS records you'll need to set at your registrar.

### Alternative: Deploy from the CLI

```bash
npm i -g vercel
vercel        # Preview deploy
vercel --prod # Production deploy
```

## Browser Support

Tested in the latest versions of Chrome, Safari, Firefox, and Edge. Uses modern CSS (custom properties, Grid, `clamp()`) and a graceful fallback in `js/main.js` for browsers without `IntersectionObserver`.

## Customizing

- **Colors and typography:** Edit the CSS custom properties at the top of `css/styles.css` (`:root { ... }`).
- **Content:** Edit `index.html` directly — services, policies, FAQ, contact info, etc.
- **Behavior:** Tweak nav scroll threshold, reveal threshold, or accordion behavior in `js/main.js`.

## License

© Sadie Marie Beauty Studio. All rights reserved.
