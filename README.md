# Low Level Library

Free, AI-readable directory of courses in coding, reverse engineering and low-level programming, curated by The Low Level Librarian. Live at https://lowlevellibrary.com

- Data: `courses.mjs` (hand-curated, every URL checked live; metadata only)
- Build: `node build.mjs` -> `dist/` (directory, `/courses/<id>/`, `/beginner-languages/`, `/ai/`, `/about/`, `/llms.txt`, `/courses.json`, `sitemap.xml`, `robots.txt`). Zero dependencies.
- Deploy: Vercel (`vercel.json`). `SITE_URL` defaults to https://lowlevellibrary.com.
