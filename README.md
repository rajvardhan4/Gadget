# Gadgets Factory Direct Product Portal

A password-free product submission portal. Each submission saves the original images and a structured product JSON file in a private Google Drive folder. Clients can browse all submissions, download original images from the portal and export each product as JSON. JSON files contain the prices, colors, features, notes and Drive image links for manual or AI-assisted catalog entry.

## Connect your Google Drive

1. In your Google Cloud project, enable the Google Drive API and configure the OAuth consent screen. Use Internal for your Workspace organization, if applicable. For External, move the application to Production before issuing the refresh token for ongoing use. Google generally expires refresh tokens for External apps left in Testing after seven days.
2. Create a **Web application** OAuth client. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
3. In the [Google OAuth Playground](https://developers.google.com/oauthplayground/), open Settings and enable **Use your own OAuth credentials**. Enter the client ID and client secret. Enter the scope `https://www.googleapis.com/auth/drive.file`, authorize using the Google account that should own the submissions, and exchange the authorization code for tokens. Keep the refresh token.
4. Copy `.env.example` to `.env` locally and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`. Run `npm run setup:drive` from a network-enabled terminal with Node.js 24. It creates a dedicated Drive folder accessible to this OAuth application. Copy its printed ID into `GOOGLE_DRIVE_FOLDER_ID`. Run this once per Drive environment.

## Deploy on Vercel

1. Import the GitHub repository into Vercel and leave the root directory at the repository root. The included configuration serves the static frontend and Node.js API.
2. In Vercel Project Settings, add all four values from `.env.example` as environment variables, then deploy. Use separate credentials and Drive storage if you enable the portal on preview deployments shared with others.
3. Submit a test product with multiple images including one larger than 5 MB, and verify the files in Drive. Open Submission history and verify that the record and original downloads appear there. Then share the Vercel URL with the client.

Anyone who can open the deployed portal can submit products, view the shared history and download its files. The Drive folder itself can stay private. The OAuth account owns the files. Open the folder using the link printed by `npm run setup:drive` or go to `https://drive.google.com/drive/folders/<GOOGLE_DRIVE_FOLDER_ID>`.

## Local development

Run `npm run dev` and open the printed URL. Without Google credentials, the portal shows a setup status. The Google Drive integration requires network access.

## Upload behavior

JPEG, PNG, WebP, GIF, AVIF, HEIC and HEIF files are accepted up to 50 MB each. The form places no fixed limit on the number of images per submission. Original files stream through small requests to respect Vercel's request size limit. Drive quota and storage still apply. Browser support for previews varies by image format. Originals remain downloadable.

Keep the form open until it confirms that the product was saved. After an interrupted upload, retry in the same tab to reuse completed images. Drive receives images before the product record is committed. If a form is abandoned partway through, already uploaded images can remain in the Drive folder without a product JSON record. History displays committed product records only.
