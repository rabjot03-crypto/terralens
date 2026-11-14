# TerraLens — Turn Urban Images Into Climate Action

TerraLens analyzes a photo of an urban environment with an AI vision model, marks the climate problems it finds on the image, explains them, recommends fixes, draws diagrams, and exports a professional PDF report.

## Project files

```
terralens/
├── index.html        ← the whole website (design, annotations, diagrams, PDF export)
├── api/analyze.js    ← the server function that holds your API key and calls the AI
├── dev-server.mjs    ← runs the site on your Mac for testing (no installs needed)
├── package.json      ← project info
├── vercel.json       ← tells Vercel the AI call may take up to 60 seconds
├── .env.local        ← YOUR SECRET KEY (local only; never uploaded or committed)
├── .env.example      ← template showing the variable name
├── .gitignore / .vercelignore ← keep .env.local out of GitHub and Vercel uploads
```

**Your API key only lives on the server.** `index.html` never contains it. The browser sends the image to `/api/analyze`, the server adds the key, and only the findings come back. You can confirm this: open DevTools → Network, analyze an image and look at the request. No key appears anywhere.

### About your key (important)
Your key starts with `gsk_`, which makes it a **Groq** key (groq.com), not an **xAI Grok** key (those start with `xai-`). TerraLens detects the key type automatically:

| Key starts with | Provider used | Vision model tried first |
|---|---|---|
| `gsk_` | Groq (`api.groq.com`) | `qwen/qwen3.8-27b`, then fallbacks |
| `xai-` | xAI Grok (`api.x.ai`) | `grok-4.20-0309-non-reasoning`, then `grok-4` |

If you get an xAI key later (console.x.ai), put it in `XAI_API_KEY` and TerraLens will use Grok. To force a specific model, add `AI_MODEL=model-id` to your environment variables. The results page always shows which model actually produced the analysis.

---

## Part 1: Run it locally on your MacBook (VS Code)

1. **Install Node.js** (one time): go to https://nodejs.org, download the **LTS** version and install it. Then check it in Terminal: `node -v` should print v18 or higher.
2. **Create the project folder:** unzip `terralens.zip` into your Documents folder. You should now have `~/Documents/terralens`.
3. **Open it in VS Code:** File → Open Folder → choose `terralens`. (Files that start with a dot, like `.env.local`, are hidden in Finder, but VS Code shows them.)
4. **Check your key:** open `.env.local`. It should contain:
   ```
   XAI_API_KEY=gsk_...your key...
   ```
5. **Install dependencies:** none are needed. TerraLens uses only built-in Node features. (The PDF library loads in the browser from a CDN.)
6. **Start the server:** in VS Code, open Terminal → New Terminal and run:
   ```
   npm run dev
   ```
   You should see `TerraLens running at http://localhost:3000` and `API key loaded`.
7. **Open** http://localhost:3000 in Chrome or Safari.
   ⚠ Don't double-click `index.html`. Live analysis only works through the server.
8. **Test uploading:** drag a JPG/PNG/WEBP aerial or street photo onto the upload box (Google Earth screenshots work well). A preview and the file details appear.
9. **Test AI analysis:** click **Analyze Environment**. The scanning animation and progress steps run, which usually takes 10–40 seconds. When it finishes, the results dashboard opens with a "Live AI analysis · model via provider" badge.
10. **Test annotations:** check that the numbered markers sit on the right features. Click a marker to see its 9-part detail popup. Try the Original / Annotated / Highlighted / Compare toggle and the + / − zoom buttons.
11. **Test exports:** try Download PDF Report, Annotated PNG, Original image, Export JSON and Print report.

To stop the server, press `Ctrl + C` in the terminal.

**Quick health check:** http://localhost:3000/api/analyze should show `"configured": true`.

---

## Part 2: Publish on Vercel (public website)

### Option A: Vercel website + GitHub (recommended)
1. Create free accounts at https://github.com and https://vercel.com (you can sign up for Vercel with GitHub).
2. On GitHub, create a new repository named `terralens`, then upload all the project files **except `.env.local`**. (The `.gitignore` file excludes it automatically if you use Git or GitHub Desktop. If you drag-and-drop files on github.com, just don't drag `.env.local`.)
3. On Vercel: **Add New… → Project → Import** your `terralens` repository.
4. Framework Preset: **Other**. Leave Build Command and Output Directory empty.
5. Open **Environment Variables** and add:
   - Name: `XAI_API_KEY`
   - Value: your key
   - Environments: Production, Preview, Development
6. Click **Deploy**. Your site will be at a URL like `https://terralens.vercel.app`. If that name is taken, Vercel adds a suffix. You can change it under Settings → Domains.
7. Visit `https://YOUR-URL/api/analyze`. You should see `"configured": true`. Then run a real analysis on the live site.

### Option B: Vercel CLI from Terminal
```
npm install -g vercel
cd ~/Documents/terralens
vercel login
vercel                     # first deploy; answer the setup questions (defaults are fine)
vercel env add XAI_API_KEY # paste your key, select Production + Preview + Development
vercel --prod              # production deploy, which prints your public URL
```
`.vercelignore` makes sure `.env.local` is never uploaded.

**If you change the key later:** update it in Vercel → Project → Settings → Environment Variables, then redeploy (Deployments → ⋯ → Redeploy).

---

## Troubleshooting

| Message | Fix |
|---|---|
| "missing the XAI_API_KEY environment variable" | Add the variable (in `.env.local` locally, or in Vercel settings) and restart or redeploy. |
| "provider rejected the API key" | The key is wrong or was revoked. Create a new one at console.groq.com (or console.x.ai). |
| "No configured vision model is available" | The provider renamed its models. Check their docs for a current vision model and set `AI_MODEL`. |
| "rate limit was reached" | Wait a minute. Free tiers limit requests per minute. |
| "PDF library failed to load" | The browser couldn't reach cdn.jsdelivr.net. Check your internet connection. |
| Analysis times out | Try a smaller image. Vercel's free plan allows up to 60 s per request. |

## How it works (for your project write-up)
- **Frontend (`index.html`)**: checks the image's type, size and dimensions, shrinks it to a maximum of 1568 px (normalized coordinates stay identical), and sends it to the server. It draws the annotations as an SVG overlay positioned with normalized coordinates, so markers line up at any screen size. Diagrams are SVG generated from the findings. The PDF is built with real text and vector layout using pdf-lib, not a screenshot.
- **Backend (`api/analyze.js`)**: adds the secret key, asks the vision model for strict JSON, removes reasoning text and code fences, repairs small JSON errors, retries once if the reply can't be read, falls back to another model if one is unavailable, and validates every field: coordinates are clamped to 0–1, severities and categories are checked, broken findings are dropped. It also limits each visitor to 8 analyses per minute to protect your credits.
- **Honesty rules**: the prompt makes the AI label each finding "directly visible" or "inferred", forbids invented numbers (flood probabilities, temperatures, soil data), and requires a list of what must be verified. Dashed outlines on the image mark inferred findings.
- **Demo gallery**: three computer-drawn sample scenes with pre-written example findings. They are always labelled **DEMO** on screen, in the PDF and in the JSON, and are never shown as live AI output.
