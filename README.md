# Reverse Engineer Everything: Free Courses Directory

AI-readable directory of free courses in coding, reverse engineering and low-level programming.

- Data: `courses.mjs` (hand-curated, every URL checked live; metadata only)
- Build: `node build.mjs` produces `dist/` (homepage with topic filter, `/courses/<id>/`, `/ai/`, `/llms.txt`, `/courses.json`, `sitemap.xml`, `robots.txt`, schema.org Course JSON-LD). Zero dependencies.
- Deploy: Vercel (config in `vercel.json`). Set `SITE_URL` env var if using a custom domain.
