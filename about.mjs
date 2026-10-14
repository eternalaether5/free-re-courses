export function about({page,courses,tags,today,SITE,BRAND,e}) {
  const providers = new Set(courses.map(c=>c.provider)).size;
  const faq = [
    ["What is Low Level Library?", `${BRAND} is a free, hand-curated directory of ${courses.length} free online courses in coding, reverse engineering and low-level programming, plus a Beginner Shelf that ranks 10 programming languages for absolute beginners. It is curated by The Low Level Librarian.`],
    ["Are the courses free?", `Yes. Every listed course is free to access. A few platforms (for example Coursera) offer paid certificates, but the listed course material can be used for free.`],
    ["Does Low Level Library host course content?", `No. It records only metadata (title, provider, link, topic tags, level, format, license note and source) and links to the official provider.`],
    ["How are courses verified?", `Each course URL was checked to load successfully (HTTP 200) on ${today}. Entries come from official course pages, public catalogs and GitHub repositories.`],
    ["Can I reuse the data?", `The dataset is published at ${SITE}/courses.json. Course materials stay under their providers' own licenses, which are noted on each course page.`],
    ["How do I contact Low Level Library?", `Email hello@lowlevellibrary.com to suggest a course or report a broken link.`],
  ];
  const ld = [
    {"@context":"https://schema.org","@type":"Organization",name:BRAND,url:SITE,email:"hello@lowlevellibrary.com",description:`Free directory of ${courses.length} coding, reverse engineering and low-level programming courses.`},
    {"@context":"https://schema.org","@type":"WebSite",name:BRAND,url:SITE,publisher:{"@type":"Organization",name:BRAND}},
    {"@context":"https://schema.org","@type":"FAQPage",mainEntity:faq.map(([q,a])=>({"@type":"Question",name:q,acceptedAnswer:{"@type":"Answer",text:a}}))},
  ].map(x=>`<script type="application/ld+json">${JSON.stringify(x)}</script>`).join("");
  const body = `<h1>About ${BRAND}</h1>
<p><strong>${BRAND}</strong> is a free directory of <strong>${courses.length} free online courses</strong> from ${providers} providers, covering coding, reverse engineering and low-level programming. It is curated by The Low Level Librarian. Last updated: ${today}.</p>
<h2>What it covers</h2>
<ul><li><a href="/">Course directory</a>: ${courses.length} courses across ${tags.length} topic tags, including reverse engineering, assembly, C, binary exploitation, malware analysis and OS internals. Each course has its own page.</li>
<li><a href="/beginner-languages/">Beginner Shelf</a>: an editorial ranking of 10 programming languages for absolute beginners, informed by the Stack Overflow 2025 Developer Survey, the TIOBE Index and GitHub Octoverse 2025.</li>
<li><a href="/ai/">For AI assistants</a>: structured FAQ answers, plus <a href="/llms.txt">llms.txt</a> and <a href="/courses.json">courses.json</a>.</li></ul>
<h2>How courses are chosen and verified</h2>
<ul><li>A course is included only if it is free to access and focused on coding, reverse engineering or low-level topics.</li><li>Entries are hand-curated from official course pages, public catalogs and GitHub repositories. Nothing is invented.</li><li>Every URL was checked to load (HTTP 200) on ${today}.</li><li>No site is scraped in breach of its terms of service.</li></ul>
<h2>Sources and licensing</h2>
<p>${BRAND} reproduces only metadata and links; course content stays with its provider. Each course page includes a license note: for example MIT OpenCourseWare and Harvard CS50 materials are CC BY-NC-SA 4.0, and GitHub courses carry their repository license. When a provider's license is unclear, the entry is marked link-only.</p>
<h2>Frequently asked questions</h2>${faq.map(([q,a])=>`<h3>${e(q)}</h3><p>${e(a)}</p>`).join("")}
<h2>Contact</h2><p><a href="mailto:hello@lowlevellibrary.com">hello@lowlevellibrary.com</a></p>`;
  return page(`About ${BRAND}: Free Low-Level & Reverse Engineering Course Directory`, body, `${BRAND} is a free, hand-curated directory of ${courses.length} free coding, reverse engineering and low-level programming courses. How courses are chosen and verified, sources, licensing and contact.`, ld, "/about/", [["About","/about/"]]);
}
