import { Writable } from 'node:stream';
import { get } from '@vercel/blob';
import { TextReader, ZipWriter } from '@zip.js/zip.js';

const columns = [
  'id', 'name', 'category', 'description', 'features', 'colors',
  'wholesale', 'mrp', 'currency', 'notes', 'submittedAt', 'updatedAt', 'imagePaths',
];

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function catalogRow(record) {
  const slug = record.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65);
  const folder = 'images/' + record.id + (slug ? '-' + slug : '');
  const images = record.images.map((image, index) => ({
    originalName: image.name,
    mime: image.mime,
    path: folder + '/' + String(index + 1).padStart(3, '0') + '.' + image.id.split('.').pop(),
  }));
  return {
    id: record.id, name: record.name, category: record.category,
    description: record.description, features: record.features, colors: record.colors,
    wholesale: record.wholesale, mrp: record.mrp, currency: 'INR', notes: record.notes,
    submittedAt: record.submittedAt, updatedAt: record.updatedAt ?? null, images,
  };
}

export async function streamCatalogZip(res, history) {
  const date = new Date().toISOString().slice(0, 10);
  const cancel = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) cancel.abort();
  });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="gadget-products-' + date + '.zip"');
  const archive = new ZipWriter(Writable.toWeb(res), { zip64: true, level: 0, useWebWorkers: false });
  const products = [];
  let cursor;

  function appendText(path, text) {
    return archive.add(path, new TextReader(text), { signal: cancel.signal });
  }

  await appendText('README.txt', 'Use products.json as the catalog for AI-assisted import. Each image path is relative to this ZIP.\nThe CSV contains the same catalog fields for spreadsheet review. Prices are in INR. Blank prices are unknown.\nThis export includes active submissions. Restore a product from Trash to include it in a new export.\n');
  do {
    cancel.signal.throwIfAborted();
    const page = await history(cursor);
    for (const record of page.records) {
      const product = catalogRow(record);
      products.push(product);
      for (const [index, image] of record.images.entries()) {
        const blob = await get(image.id, { access: 'private', abortSignal: cancel.signal });
        if (!blob?.stream) throw new Error('A product image is unavailable for export.');
        await archive.add(product.images[index].path, blob.stream, { signal: cancel.signal });
      }
    }
    cursor = page.next;
  } while (cursor);

  const rows = products.map(product => {
    const imagePaths = product.images.map(image => image.path).join(' | ');
    const row = { ...product, imagePaths };
    return columns.map(key => csvCell(row[key])).join(',');
  });
  await appendText('products.json', JSON.stringify(products, null, 2));
  await appendText('products.csv', '\uFEFF' + [columns.join(','), ...rows].join('\r\n') + '\r\n');
  await archive.close();
}
