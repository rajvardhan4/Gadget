# Gadgets Factory Direct Product Portal

A password-free client portal for product details and original images. The client can browse submissions, download originals, and export individual products as JSON. The portal uses Vercel Blob to store images and product records.

## Deploy

1. Import the repository into Vercel, using the repository root.
2. In the project Storage tab, create or connect a dedicated private Blob store using the default environment variable prefix. The connection provides BLOB_STORE_ID and uses the deployment's Vercel OIDC identity. A static BLOB_READ_WRITE_TOKEN is also supported for environments without that identity.
3. Deploy again if the store was attached after the first deployment. Confirm Submission history loads, then submit a test product with multiple images and check the original downloads.

Images and product JSON are stored under images/ and products/ in the linked Blob store. Find them in Vercel under the project's Storage tab. Anyone with access to the portal can submit and read the shared history.

## Editing submissions

Set `PORTAL_EDIT_KEY_HASH` to the SHA-256 hex digest of a random 32-byte base64url key. Share the portal URL with `#edit=<key>` privately. Opening it grants edit access to that browser for seven days. The normal portal link then also works in that browser. Under Submission history, choose a product and click Edit submission. Saving updates the existing entry and keeps previously saved images attached.

## Local development

Run npm ci, then npm run dev. Use a separate test Blob store for development and provide local Vercel OIDC credentials or a test store's BLOB_READ_WRITE_TOKEN in .env.

## Uploads

Images upload directly from the browser to private Blob storage. Vercel supplies multipart uploads for larger images. Vercel Blob limits and account quotas apply. A submission appears in history after all its images and the product record are saved. If the form is abandoned mid-upload, some files may already be in storage.
