This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Local Terminal EPUB Reader

Open a local EPUB directly in the terminal without uploading, importing into the DB, loading env files, or starting translation:

```bash
npm run read:epub -- "C:\Programming\translator\test-novel\gzr.epub"
# or
npm run read -- --epub "C:\Programming\translator\test-novel\gzr.epub"
```

Useful commands:

```bash
npm run read:help
npm run books
npm run read:worker -- <bookId>
```

Reader keys:

- `n` / right arrow: next page.
- `p` / left arrow: previous page.
- `]` / `[`: next / previous chapter.
- `t`: table of contents; enter a chapter number to jump.
- `q`: quit.

Local EPUB mode stores automatic resume progress in `data/terminal-progress.json` using a local `epub:` progress key. It renders original text only. It also sizes EPUB pages to the current terminal viewport, including wrapped title/path/footer rows and CJK full-width characters, so normal pages should start at the top of the visible terminal window after each flip.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
