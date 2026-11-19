import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const drive = 'https://www.googleapis.com/drive/v3';
const upload = 'https://www.googleapis.com/upload/drive/v3';
const chunkSize = 2 * 1024 * 1024;
const maxImage = 50 * 1024 * 1024;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif']);
const idPattern = /^[\w-]{8,180}$/;
let cachedToken;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireValue(condition, message, status = 400) {
  if (!condition) throw new RequestError(status, message);
}

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function verify(token, kind) {
  if (typeof token !== 'string') return;
  const [payload, signature] = token.split('.');
  if (!signature) return;
  const expected = createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  if (!equal(signature, expected)) return;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (data.kind === kind && data.expires > Date.now()) return data;
}

async function accessToken() {
  if (cachedToken?.expires > Date.now()) return cachedToken.value;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) throw new RequestError(502, 'Google Drive authorization failed. Please contact the portal owner.');
  const token = await response.json();
  cachedToken = { value: token.access_token, expires: Date.now() + (token.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function google(url, options = {}, allowed = []) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + await accessToken(), ...options.headers },
  });
  if (!response.ok && !allowed.includes(response.status)) {
    console.error('Drive request failed', new URL(url).pathname, response.status);
    throw new RequestError(502, 'Google Drive could not complete the request. Please try again.');
  }
  return response;
}

function fileUrl(id, params) {
  return drive + '/files/' + id + '?' + new URLSearchParams({ supportsAllDrives: 'true', ...params });
}

async function newId() {
  const result = await google(drive + '/files/generateIds?count=1&space=drive');
  return (await result.json()).ids[0];
}

function properties(kind, product) {
  return { portal: 'gadget-v1', kind, product };
}

async function lookup(id) {
  const response = await google(fileUrl(id, {
    fields: 'id,name,mimeType,size,parents,trashed,appProperties,thumbnailLink',
  }), {}, [404]);
  return response.ok ? response.json() : null;
}

function owned(file, kind, product) {
  return file && !file.trashed && file.parents?.includes(process.env.GOOGLE_DRIVE_FOLDER_ID) &&
    file.appProperties?.portal === 'gadget-v1' && file.appProperties.kind === kind &&
    (product === undefined || file.appProperties.product === product);
}

function descriptor(id, name, mimeType, kind, product) {
  return {
    id, name, mimeType,
    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    appProperties: properties(kind, product),
  };
}

function inputText(value, label, limit, required = false) {
  requireValue(typeof value === 'string' && value.trim().length <= limit, 'Check ' + label + '.');
  const cleaned = value.trim();
  requireValue(!required || cleaned, label + ' is required.');
  return cleaned;
}

async function readProduct(id) {
  return (await google(fileUrl(id, { alt: 'media' }))).json();
}

async function history(pageToken) {
  const folder = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const params = new URLSearchParams({
    q: "'" + folder + "' in parents and trashed = false and appProperties has { key='portal' and value='gadget-v1' } and appProperties has { key='kind' and value='product' }",
    fields: 'nextPageToken,files(id)', orderBy: 'createdTime desc', pageSize: '12',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const result = await (await google(drive + '/files?' + params)).json();
  return {
    records: await Promise.all(result.files.map(file => readProduct(file.id))),
    next: result.nextPageToken,
  };
}

async function startImage(body) {
  requireValue(idPattern.test(body.product) && typeof body.product === 'string', 'Invalid submission.');
  const name = inputText(body.name, 'Image filename', 255, true);
  const { mime, size } = body;
  requireValue(imageTypes.has(mime) && Number.isSafeInteger(size) && size > 0 && size <= maxImage,
    'Choose a supported image up to 50 MB.');
  const id = body.id ?? await newId();
  requireValue(typeof id === 'string' && idPattern.test(id), 'Invalid image ID.');
  if (body.id) {
    const existing = await lookup(id);
    if (owned(existing, 'image', body.product) && Number(existing.size) === size && existing.mimeType === mime) {
      return { id, done: true };
    }
    requireValue(!existing, 'Image ID is already in use.', 409);
  }
  const response = await google(upload + '/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify(descriptor(id, name, mime, 'image', body.product)),
  });
  const url = response.headers.get('location');
  requireValue(url && new URL(url).origin === 'https://www.googleapis.com', 'Drive did not start the upload.', 502);
  return { id, ticket: sign({ kind: 'upload', url, size, mime, expires: Date.now() + 86400000 }) };
}

async function imageChunk(body) {
  const ticket = verify(body.ticket, 'upload');
  requireValue(ticket, 'The upload session expired. Retry the submission.', 409);
  const { offset, data } = body;
  requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset < ticket.size && offset % chunkSize === 0 &&
    typeof data === 'string' && data.length <= Math.ceil(chunkSize / 3) * 4, 'Invalid upload chunk.');
  const bytes = Buffer.from(data, 'base64');
  requireValue(bytes.length === Math.min(chunkSize, ticket.size - offset), 'Upload chunk was incomplete.');
  const response = await google(ticket.url, {
    method: 'PUT', redirect: 'manual',
    headers: {
      'Content-Type': ticket.mime,
      'Content-Range': 'bytes ' + offset + '-' + (offset + bytes.length - 1) + '/' + ticket.size,
    },
    body: bytes,
  }, [308]);
  if (response.status === 308) {
    const match = /bytes=0-(\d+)/.exec(response.headers.get('range') ?? '');
    return { offset: match ? Number(match[1]) + 1 : 0 };
  }
  return { offset: ticket.size };
}

async function saveProduct(body) {
  const { id, images } = body;
  requireValue(typeof id === 'string' && idPattern.test(id), 'Invalid submission ID.');
  const existing = await lookup(id);
  if (owned(existing, 'product', id)) return readProduct(id);
  requireValue(!existing, 'Submission ID is already in use.', 409);

  const record = { id, submittedAt: new Date().toISOString() };
  for (const [key, label, max, required] of [
    ['name', 'Product name', 180, true], ['category', 'Category', 120, true],
    ['colors', 'Color options', 500], ['wholesale', 'B2B wholesale price', 32],
    ['mrp', 'Retail MRP', 32], ['description', 'Description', 8000],
    ['features', 'Key features', 8000], ['notes', 'Notes', 4000],
  ]) {
    record[key] = inputText(body[key] ?? '', label, max, required);
  }
  for (const key of ['wholesale', 'mrp']) {
    requireValue(!record[key] || /^\d{1,10}(\.\d{1,2})?$/.test(record[key]), 'Enter a valid INR price.');
  }

  requireValue(Array.isArray(images) && images.length && new Set(images).size === images.length &&
    images.every(image => typeof image === 'string' && idPattern.test(image)), 'Attach at least one image.');
  record.images = [];
  for (let offset = 0; offset < images.length; offset += 8) {
    const batch = await Promise.all(images.slice(offset, offset + 8).map(lookup));
    for (const file of batch) {
      requireValue(owned(file, 'image', id) && imageTypes.has(file.mimeType) && Number(file.size) > 0,
        'An image is missing from Drive. Retry the submission.');
      record.images.push({ id: file.id, name: file.name, mime: file.mimeType,
        driveUrl: 'https://drive.google.com/file/d/' + file.id + '/view' });
    }
  }

  const boundary = randomUUID();
  const metadata = descriptor(id, record.name + ' (' + id + ').json', 'application/json', 'product', id);
  const response = await google(upload + '/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
    body: [
      '--' + boundary, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
      '--' + boundary, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(record),
      '--' + boundary + '--', '',
    ].join('\r\n'),
  }, [409]);
  if (response.status === 409) {
    requireValue(owned(await lookup(id), 'product', id), 'Please retry the submission.', 409);
    return readProduct(id);
  }
  return record;
}

async function imagePreview(id, res) {
  requireValue(idPattern.test(id), 'Invalid image ID.');
  const file = await lookup(id);
  requireValue(owned(file, 'image') && file.thumbnailLink, 'Preview unavailable.', 404);
  const thumbnail = new URL(file.thumbnailLink);
  requireValue(thumbnail.protocol === 'https:' && thumbnail.hostname.endsWith('.googleusercontent.com'),
    'Preview unavailable.', 404);
  const response = await google(thumbnail, { redirect: 'error' }, [403, 404]);
  const mime = response.headers.get('content-type')?.split(';')[0];
  requireValue(response.ok && imageTypes.has(mime), 'Preview unavailable.', 404);
  res.setHeader('Content-Type', mime);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function imageDownload(id, offset, res) {
  requireValue(idPattern.test(id) && Number.isSafeInteger(offset) && offset >= 0 &&
    offset % chunkSize === 0, 'Invalid image request.');
  const file = await lookup(id);
  requireValue(owned(file, 'image') && imageTypes.has(file.mimeType), 'Image unavailable.', 404);
  const size = Number(file.size);
  requireValue(offset < size && size <= maxImage, 'Invalid image range.');
  const end = Math.min(offset + chunkSize, size) - 1;
  const response = await google(fileUrl(id, { alt: 'media' }), {
    headers: { Range: 'bytes=' + offset + '-' + end },
  });
  requireValue(response.status === 206 || (offset === 0 && size <= chunkSize),
    'Drive could not download the image.', 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  requireValue(bytes.length === end - offset + 1, 'Drive returned an incomplete image.', 502);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Image-Size', String(size));
  res.end(bytes);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const { PORTAL_PASSWORD, SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
      GOOGLE_DRIVE_FOLDER_ID } = process.env;
    requireValue(PORTAL_PASSWORD?.length >= 16 && SESSION_SECRET?.length >= 32 && GOOGLE_CLIENT_ID &&
      GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN && idPattern.test(GOOGLE_DRIVE_FOLDER_ID ?? ''),
      'The portal owner needs to finish setup.', 503);
    const url = new URL(req.url, 'http://localhost');
    const action = url.searchParams.get('action');
    const session = /(?:^|;\s*)gadget_portal=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.method === 'POST') {
      requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Use JSON requests.', 415);
      requireValue(!req.headers.origin || new URL(req.headers.origin).host === req.headers.host,
        'Request origin is invalid.', 403);
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
      if (action === 'login') {
        requireValue(typeof body.password === 'string' && equal(body.password, PORTAL_PASSWORD),
          'That access password is incorrect.', 401);
        const token = sign({ kind: 'session', expires: Date.now() + 7 * 86400000 });
        res.setHeader('Set-Cookie', 'gadget_portal=' + token +
          '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800' + (process.env.VERCEL ? '; Secure' : ''));
        return res.json({ ok: true });
      }
      if (action === 'logout') {
        res.setHeader('Set-Cookie', 'gadget_portal=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
          (process.env.VERCEL ? '; Secure' : ''));
        return res.json({ ok: true });
      }
      requireValue(verify(session, 'session'), 'Please sign in to continue.', 401);
      if (action === 'new') return res.json({ id: await newId() });
      if (action === 'start-image') return res.json(await startImage(body));
      if (action === 'image-chunk') return res.json(await imageChunk(body));
      if (action === 'save') return res.json(await saveProduct(body));
    }
    if (req.method === 'GET') {
      requireValue(verify(session, 'session'), 'Please sign in to continue.', 401);
      if (action === 'session') return res.json({ ok: true });
      if (action === 'history') return res.json(await history(url.searchParams.get('page')));
      if (action === 'preview') return await imagePreview(url.searchParams.get('id') ?? '', res);
      if (action === 'download') {
        return await imageDownload(url.searchParams.get('id') ?? '', Number(url.searchParams.get('offset')), res);
      }
    }
    throw new RequestError(404, 'This action is unavailable.');
  } catch (error) {
    if (!(error instanceof RequestError)) console.error('Portal error', error.name);
    return res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Something went wrong. Please try again.' });
  }
}
