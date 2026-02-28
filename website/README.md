# Truss Website

Marketing and documentation site for [Truss](https://truss.kroy.io) — built with [Astro](https://astro.build), [Tailwind CSS](https://tailwindcss.com), and [MDX](https://mdxjs.com).

## Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Framework | Astro 4 | Static-first, zero JS by default, native MDX |
| Styling | Tailwind CSS 3 + `@tailwindcss/typography` | Utility-first, easy dark mode, prose styles |
| Content | MDX + Astro Content Collections | Type-safe frontmatter, author-friendly markdown |
| Deploy | GitHub Pages via Actions | Native Pages API, free, custom domain |

## Local Development

```bash
cd website
npm ci
npm run dev       # http://localhost:4321
npm run build     # production build → dist/
npm run preview   # preview the production build locally
```

## Content Organization

```
src/
├── content/
│   └── docs/           ← All documentation pages (MDX)
│       ├── installation.mdx
│       ├── quickstart.mdx
│       ├── concepts.mdx
│       ├── shortcuts.mdx
│       ├── security.mdx
│       ├── contributing.mdx
│       └── operations.mdx
├── lib/
│   └── nav.ts          ← Sidebar sections + top-nav links (edit to add/reorder)
├── layouts/
│   ├── BaseLayout.astro   ← HTML shell, <head>, header/footer
│   └── DocsLayout.astro   ← Sidebar + prose wrapper + prev/next
├── components/
│   ├── Header.astro
│   ├── Footer.astro
│   ├── DocsSidebar.astro
│   └── Callout.astro      ← <Callout type="note|warning|tip">
└── pages/
    ├── index.astro         ← Home (hero, features, how-it-works, CTA)
    ├── 404.astro
    └── docs/
        ├── index.astro     ← Redirects to /docs/installation
        └── [...slug].astro ← Dynamic doc pages from content collection
```

## How to Update Navigation

**Sidebar order / sections:** edit `src/lib/nav.ts` → `docsNav` array.

**Top header nav:** edit `src/lib/nav.ts` → `siteNav` array.

## How to Add a Doc Page

1. Create `src/content/docs/my-page.mdx` with frontmatter:

```mdx
---
title: My Page
description: A short description for SEO.
order: 8
---

Content here…
```

2. Add an entry to the `docsNav` in `src/lib/nav.ts`:

```ts
{ title: 'My Page', slug: 'my-page' }
```

The page is live at `/docs/my-page`.

## GitHub Pages Deploy

The workflow at `.github/workflows/website.yml`:

- Triggers on push to `main` when files under `website/` change
- Builds with `npm run build` (output to `website/dist/`)
- Deploys via the official `actions/deploy-pages` action
- Custom domain `truss.kroy.io` is set by `public/CNAME`

**One-time GitHub setup (already done if the repo is configured):**

1. Repo → Settings → Pages → Source: **GitHub Actions**
2. No other configuration needed — the workflow handles everything

## Dark Mode

Dark mode is system-preference by default. A toggle button in the header persists the choice in `localStorage`. The theme is applied before first paint (inline script in `<head>`) to avoid flash.
