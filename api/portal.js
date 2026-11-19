import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { BlobNotFoundError, BlobPreconditionFailedError, get, getDownloadUrl, head, issueSignedToken, list, presignUrl, put } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';

const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']);
const categories = new Set([
  'Protection and Screen Accessories',
  'Smart Wearables & Accessories',
  'Audio & Lifestyle Electronics',
  'Gaming & Utility Mobile Tools',
  'Power and Fast Charging Tech',
]);
const recordPrefix = 'products/';
const privateAccess = { access: 'private' };
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const revisionPattern = new RegExp('^' + uuid + '$');
const productPattern = new RegExp('^\\d{13}-' + uuid + '$');
const imagePattern = new RegExp('^images/(\\d{13}-' + uuid + ')/' + uuid + '\\.(jpg|jpeg|png|webp|gif|avif|heic|heif)$');

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message, status = 400) {
  if (!condition) throw new RequestError(status, message);
}

function inputText(value, label, limit, required = false) {
  requireValue(typeof value === 'string' && value.trim().length <= limit, 'Check ' + label + '.');
  const cleaned = value.trim();
  requireValue(!required || cleaned, label + ' is required.');
  return cleaned;
}

function recordPath(id) {
  return recordPrefix + id + '.json';
}

async function readRecordBlob(pathname) {
  const response = await get(pathname, { ...privateAccess, useCache: false });
  return response ? { record: await new Response(response.stream).json(), etag: response.blob.etag } : null;
}

async function readRecord(pathname) {
  return (await readRecordBlob(pathname))?.record ?? null;
}

function requireEditor(key) {
  const hash = process.env.PORTAL_EDIT_KEY_HASH ?? '';
  const authorized = typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key) &&
    /^[a-f0-9]{64}$/.test(hash) &&
    timingSafeEqual(createHash('sha256').update(key).digest(), Buffer.from(hash, 'hex'));
  requireValue(authorized, 'Open the private edit link once in this browser to edit submissions.', 403);
}

function editorCookie(req) {
  return /(?:^|;\s*)portal_editor=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
}

async function history(cursor) {
  const result = await list({ prefix: recordPrefix, limit: 12, cursor });
  const records = await Promise.all(result.blobs.map(blob => readRecord(blob.pathname)));
  return { records: records.filter(Boolean), next: result.hasMore ? result.cursor : undefined };
}

async function uploadTicket(req, body) {
  requireValue(body?.type === 'blob.generate-presigned-url', 'Invalid upload request.');
  return handleUploadPresigned({
    body,
    request: req,
    async getSignedToken(pathname, clientPayload) {
      requireValue(typeof pathname === 'string' && imagePattern.test(pathname), 'Invalid image path.');
      let mime;
      try {
        mime = JSON.parse(clientPayload)?.mime;
      } catch {
        throw new RequestError(400, 'Invalid image type.');
      }
      requireValue(imageTypes.has(mime), 'Choose a supported image.');
      const validUntil = Date.now() + 60 * 60 * 1000;
      return {
        token: await issueSignedToken({ pathname, operations: ['put'], allowedContentTypes: [mime], validUntil }),
        urlOptions: { allowedContentTypes: [mime], validUntil, allowOverwrite: false, addRandomSuffix: false },
      };
    },
  });
}

async function saveProduct(body, editing = false) {
  const { id, images } = body;
  requireValue(typeof id === 'string' && productPattern.test(id), 'Invalid submission ID.');
  const pathname = recordPath(id);
  const current = await readRecordBlob(pathname);
  const existing = current?.record;
  if (editing) {
    requireValue(existing, 'This submission could not be found.', 404);
    requireValue(typeof body.revision === 'string' && revisionPattern.test(body.revision), 'Invalid edit revision.');
    if (existing.revision === body.revision) return existing;
    requireValue((existing.revision ?? null) === body.baseRevision, 'This submission was updated. Go back and reopen it to edit the latest version.', 409);
  } else if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const record = { id, submittedAt: existing?.submittedAt ?? now };
  if (editing) Object.assign(record, { updatedAt: now, revision: body.revision });
  for (const [key, label, max, required] of [
    ['name', 'Product name', 180, true], ['category', 'Category', 120, true],
    ['colors', 'Color options', 500], ['wholesale', 'B2B wholesale price', 32],
    ['mrp', 'Retail MRP', 32], ['description', 'Description', 8000],
    ['features', 'Key features', 8000], ['notes', 'Notes', 4000],
  ]) {
    record[key] = inputText(body[key] ?? existing?.[key] ?? '', label, max, required);
  }
  requireValue(categories.has(record.category), 'Choose a category from the dropdown.');
  for (const key of ['wholesale', 'mrp']) {
    requireValue(!record[key] || /^\d{1,10}(\.\d{1,2})?$/.test(record[key]), 'Enter a valid INR price.');
  }

  requireValue(Array.isArray(images) && images.length, 'Attach at least one image.');
  const paths = new Set();
  const verified = images.map(image => {
    requireValue(typeof image?.id === 'string' && imagePattern.exec(image.id)?.[1] === id &&
      !paths.has(image.id), 'Invalid or duplicate image.');
    paths.add(image.id);
    return { id: image.id, name: inputText(image.name, 'Image filename', 255, true) };
  });
  const previousImages = new Map(existing?.images.map(image => [image.id, image]));
  requireValue([...previousImages.keys()].every(path => paths.has(path)), 'Keep the images already saved with this submission.');
  record.images = [];
  for (let offset = 0; offset < verified.length; offset += 8) {
    const batch = await Promise.all(verified.slice(offset, offset + 8).map(async image => {
      if (previousImages.has(image.id)) return previousImages.get(image.id);
      let file;
      try {
        file = await head(image.id);
      } catch (error) {
        if (!(error instanceof BlobNotFoundError)) throw error;
      }
      requireValue(file?.size > 0 && imageTypes.has(file.contentType),
        'An image is missing from storage. Please retry.');
      return { ...image, mime: file.contentType };
    }));
    record.images.push(...batch);
  }

  try {
    await put(pathname, JSON.stringify(record), {
      ...privateAccess, contentType: 'application/json', allowOverwrite: editing, addRandomSuffix: false,
      ...(editing ? { ifMatch: current.etag } : {}),
    });
  } catch (error) {
    const committed = await readRecord(pathname);
    if (committed && (!editing || committed.revision === body.revision)) return committed;
    if (editing && error instanceof BlobPreconditionFailedError) {
      throw new RequestError(409, 'This submission was updated. Go back and reopen it to edit the latest version.');
    }
    throw error;
  }
  return record;
}

async function imageRedirect(pathname, download, res) {
  const match = imagePattern.exec(pathname);
  requireValue(match, 'Invalid image path.');
  const record = await readRecord(recordPath(match[1]));
  requireValue(record?.images.some(image => image.id === pathname), 'Image unavailable.', 404);
  const validUntil = Date.now() + 5 * 60 * 1000;
  const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(token, { pathname, operation: 'get', ...privateAccess, validUntil });
  res.status(302);
  res.setHeader('Location', download ? getDownloadUrl(presignedUrl) : presignedUrl);
  res.end();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    requireValue(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN,
      'The portal owner needs to connect storage.', 503);
    const url = new URL(req.url, 'http://localhost');
    const action = url.searchParams.get('action');
    if (req.method === 'POST') {
      requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Use JSON requests.', 415);
      requireValue(!req.headers.origin || new URL(req.headers.origin).host === req.headers.host,
        'Request origin is invalid.', 403);
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
      if (action === 'new') {
        return res.json({ id: String(9999999999999 - Date.now()) + '-' + randomUUID() });
      }
      if (action === 'upload') return res.json(await uploadTicket(req, body));
      if (action === 'save') return res.json(await saveProduct(body));
      if (action === 'edit-access') {
        requireEditor(body.key);
        const secure = process.env.VERCEL ? '; Secure' : '';
        res.setHeader('Set-Cookie', 'portal_editor=' + body.key +
          '; HttpOnly; SameSite=Strict; Path=/api/portal; Max-Age=604800' + secure);
        return res.json({ allowed: true });
      }
      if (action === 'update') {
        requireEditor(editorCookie(req));
        return res.json(await saveProduct(body, true));
      }
    }
    if (req.method === 'GET') {
      if (action === 'history') return res.json(await history(url.searchParams.get('page') ?? undefined));
      if (action === 'edit-access') {
        requireEditor(editorCookie(req));
        return res.json({ allowed: true });
      }
      if (action === 'preview' || action === 'download') {
        return await imageRedirect(url.searchParams.get('id') ?? '', action === 'download', res);
      }
    }
    throw new RequestError(404, 'This action is unavailable.');
  } catch (error) {
    if (!(error instanceof RequestError)) console.error('Portal storage error', error.name);
    return res.status(error.status ?? 502).json({
      error: error.status ? error.message : 'Storage could not complete the request. Please try again.',
    });
  }
}
