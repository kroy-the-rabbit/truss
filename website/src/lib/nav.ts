/** Docs sidebar navigation — edit this to add/reorder/rename sections */
export const docsNav = [
  {
    section: 'Getting Started',
    items: [
      { title: 'Installation',  slug: 'installation' },
      { title: 'Quickstart',   slug: 'quickstart'   },
    ],
  },
  {
    section: 'Reference',
    items: [
      { title: 'Concepts',     slug: 'concepts'     },
      { title: 'Keyboard Shortcuts', slug: 'shortcuts' },
      { title: 'Security',     slug: 'security'     },
    ],
  },
  {
    section: 'Community',
    items: [
      { title: 'Contributing', slug: 'contributing' },
      { title: 'Operations',   slug: 'operations'   },
    ],
  },
];

export const siteNav = [
  { title: 'Features',     href: '/#features'   },
  { title: 'How it Works', href: '/#how-it-works' },
  { title: 'Docs',         href: '/docs/installation' },
  { title: 'GitHub',       href: 'https://github.com/kroy-the-rabbit/truss', external: true },
];
