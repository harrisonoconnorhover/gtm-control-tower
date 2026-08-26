# Morning Handoff

## Finished

- Added a dedicated static build for the existing browser-only public demo.
- Removed public operator and setup routes from the showcase; every workspace CTA now points to GitHub self-host instructions.
- Kept the full `/app`, `/setup`, Docker, SQLite, n8n, and connector implementation unchanged for self-hosters.
- Updated public metadata, README guidance, and the architecture decision record for the static-showroom boundary.
- Published the static site at `https://gtm-control-tower.pages.dev/`.

## Try It

- Open `https://gtm-control-tower.pages.dev/` and select **Run the 64-row cleanup**.
- Confirm the receipt ends at 56 canonical rows, 44 ready for CRM, and 12 held for review.
- Run `npm run preview:public` to inspect the public-only build locally.

## Checks

- `npm test`: 36/36 passed; secret scan and `git diff --check` passed.
- ESLint, the full Vinext production build, and the static public build passed.
- Desktop 1440 px and mobile 390 px browser checks passed with no horizontal overflow or console errors.
- The browser-only cleanup completed with the expected deterministic receipt.

## Decisions

- Cloudflare Pages hosts only the static showroom; it receives no uploads and stores no workspace data.
- The working operator product remains self-hosted through Docker in the same repository.
- The public build reuses the existing demo component instead of creating a second product codebase.

## Remaining

- Attach a custom domain when the preferred hostname is chosen.
- Retire or redirect the older `chatgpt.site` URL after the new Pages URL has circulated.

## Review First

- `components/public-demo.tsx`
- `vite.public.config.ts`
- `public-site/index.html`
