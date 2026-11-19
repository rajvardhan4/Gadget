const byId = id => document.getElementById(id);
const fileInput = byId('files');
const form = byId('product-form');
const chosen = [];
const chunkSize = 2 * 1024 * 1024;
const mimeByExt = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
};
let productId;
let pendingSave;
let busy = false;
let historyBusy = false;
let nextPage;

function message(id, text, error = false) {
  const element = byId(id);
  element.textContent = text;
  element.classList.toggle('error', error);
}

function notice(text) {
  message('notice', text);
  byId('notice').hidden = !text;
}

async function api(action, body, query = {}) {
  const params = new URLSearchParams({ action, ...query });
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch('/api/portal?' + params, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'The portal could not complete the request. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function setAccess(signedIn) {
  byId('boot').hidden = true;
  byId('access').hidden = signedIn;
  byId('portal').hidden = !signedIn;
  byId('logout').hidden = !signedIn;
}

function setTab(history) {
  byId('history').hidden = !history;
  byId('entry').hidden = history;
  byId(history ? 'history-tab' : 'form-tab').setAttribute('aria-current', 'page');
  byId(history ? 'form-tab' : 'history-tab').removeAttribute('aria-current');
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderFiles() {
  byId('file-list').replaceChildren(...chosen.map((item, index) => {
    const row = element('li');
    const icon = element('span', 'IMG', 'file-icon');
    if (item.url) {
      const image = element('img');
      image.src = item.url;
      image.alt = '';
      image.addEventListener('error', () => image.replaceWith(icon));
      row.append(image);
    } else {
      row.append(icon);
    }
    const size = (item.file.size / 1048576).toFixed(1) + ' MB';
    const name = element('span', item.file.name + ' (' + size + ')', 'file-name');
    const remove = element('button', 'Remove');
    remove.type = 'button';
    remove.disabled = busy || Boolean(pendingSave);
    remove.setAttribute('aria-label', 'Remove ' + item.file.name);
    remove.addEventListener('click', () => {
      if (item.url) URL.revokeObjectURL(item.url);
      chosen.splice(index, 1);
      renderFiles();
    });
    row.append(name, remove);
    return row;
  }));
}

function addFiles(files) {
  if (busy || pendingSave) return;
  const errors = [];
  for (const file of files) {
    const mime = Object.values(mimeByExt).includes(file.type)
      ? file.type : mimeByExt[file.name.split('.').pop().toLowerCase()];
    if (!mime || !file.size || file.size > 50 * 1048576 || file.name.length > 255) {
      errors.push(file.name + ' could not be added. Choose a supported image up to 50 MB with a shorter filename.');
      continue;
    }
    if (chosen.some(item => item.file.name === file.name && item.file.size === file.size &&
      item.file.lastModified === file.lastModified)) continue;
    chosen.push({ file, mime, url: URL.createObjectURL(file) });
  }
  renderFiles();
  message('file-message', errors.join('\n'), true);
}

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});
const drop = byId('drop');
for (const event of ['dragover', 'dragleave', 'drop']) {
  drop.addEventListener(event, e => {
    e.preventDefault();
    drop.classList.toggle('active', event === 'dragover' && !busy);
    if (event === 'drop') addFiles(e.dataTransfer.files);
  });
}

function encodeChunk(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read an image. Please retry.'));
    reader.readAsDataURL(blob);
  });
}

async function uploadImage(item, index) {
  const { file, mime } = item;
  const start = await api('start-image', { product: productId, name: file.name, mime, size: file.size, id: item.id });
  item.id = start.id;
  if (start.done) return;
  for (let offset = 0; offset < file.size;) {
    const progress = Math.floor(offset / file.size * 100);
    message('submit-message', 'Uploading image ' + (index + 1) + ' of ' + chosen.length + ' (' + progress + '%)...');
    const data = await encodeChunk(file.slice(offset, offset + chunkSize));
    const result = await api('image-chunk', { ticket: start.ticket, offset, data });
    if (result.offset !== Math.min(offset + chunkSize, file.size)) {
      throw new Error('Drive did not receive the full chunk. Retry this submission.');
    }
    offset = result.offset;
  }
}

function lockForm() {
  for (const control of form.querySelectorAll('input, textarea')) {
    control.disabled = busy || Boolean(pendingSave);
  }
  byId('submit').disabled = busy;
  byId('submit').textContent = busy ? 'Saving...' : pendingSave ? 'Retry save' : 'Submit product';
  byId('logout').disabled = busy;
  byId('history-tab').disabled = busy;
  renderFiles();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  if (!chosen.length) {
    message('file-message', 'Add at least one product image.', true);
    fileInput.focus();
    return;
  }
  const fields = pendingSave ?? Object.fromEntries(new FormData(form));
  if (!fields.name.trim() || !fields.category.trim()) {
    message('submit-message', 'Enter a product name and category.', true);
    return;
  }
  notice('');
  busy = true;
  lockForm();
  message('submit-message', 'Preparing submission...');
  try {
    if (!pendingSave) {
      productId ??= (await api('new', {})).id;
      for (const [index, item] of chosen.entries()) {
        if (!item.uploaded) {
          await uploadImage(item, index);
          item.uploaded = true;
        }
      }
      pendingSave = { ...fields, id: productId, images: chosen.map(item => item.id) };
    }
    message('submit-message', 'Saving product details to Drive...');
    const saved = await api('save', pendingSave);
    chosen.splice(0).forEach(item => URL.revokeObjectURL(item.url));
    form.reset();
    productId = undefined;
    pendingSave = undefined;
    message('submit-message', '');
    message('file-message', '');
    notice(saved.name + ' was saved to Google Drive.');
    await openHistory(saved);
  } catch (error) {
    if (error.status === 400) pendingSave = undefined;
    message('submit-message', error.message, true);
    if (error.status === 401) setAccess(false);
  } finally {
    busy = false;
    lockForm();
  }
});

const fieldLabels = {
  category: 'Category', colors: 'Color options', wholesale: 'B2B wholesale (INR)',
  mrp: 'Retail MRP (INR)', description: 'Description', features: 'Key features', notes: 'Notes',
};

function downloadFile(blob, name) {
  const uri = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = uri;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(uri), 1000);
}

async function downloadImage(image) {
  const chunks = [];
  let size;
  for (let offset = 0; size === undefined || offset < size;) {
    const params = new URLSearchParams({ action: 'download', id: image.id, offset });
    const response = await fetch('/api/portal?' + params);
    if (!response.ok) throw new Error('Could not download the image. Please try again.');
    size = Number(response.headers.get('X-Image-Size'));
    const chunk = await response.blob();
    if (!size || !chunk.size) throw new Error('The image download was incomplete.');
    chunks.push(chunk);
    offset += chunk.size;
  }
  downloadFile(new Blob(chunks, { type: image.mime }), image.name);
}

function renderRecord(record) {
  const details = element('details', '', 'card record');
  const summary = element('summary');
  summary.append(element('strong', record.name), element('span',
    new Date(record.submittedAt).toLocaleString() + ' · ' + record.images.length + ' image(s) · ' + record.category,
    'record-meta'));
  details.append(summary);
  const fields = element('dl');
  for (const [key, label] of Object.entries(fieldLabels)) {
    if (record[key]) fields.append(element('dt', label), element('dd', record[key]));
  }
  const images = element('ul', '', 'gallery');
  const downloadStatus = element('p', '', 'message');
  downloadStatus.setAttribute('role', 'status');
  const download = element('button', 'Download product data', 'secondary');
  download.addEventListener('click', () => {
    downloadFile(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
      'product-' + record.id + '.json');
  });
  details.addEventListener('toggle', () => {
    if (!details.open || images.childElementCount) return;
    for (const image of record.images) {
      const item = element('li');
      const button = element('button');
      button.setAttribute('aria-label', 'Download ' + image.name);
      button.addEventListener('click', async () => {
        button.disabled = true;
        downloadStatus.textContent = 'Downloading ' + image.name + '...';
        try {
          await downloadImage(image);
          downloadStatus.textContent = '';
        } catch (error) {
          downloadStatus.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      const preview = element('img');
      preview.alt = '';
      preview.loading = 'lazy';
      preview.src = '/api/portal?action=preview&id=' + encodeURIComponent(image.id);
      preview.addEventListener('error', () => preview.remove());
      button.append(preview, document.createTextNode(image.name));
      item.append(button);
      images.append(item);
    }
  });
  details.append(fields, images, downloadStatus, download);
  return details;
}

async function loadHistory(append = false, saved) {
  if (historyBusy) return;
  historyBusy = true;
  byId('more').hidden = true;
  message('history-message', 'Loading submissions...');
  if (!append) {
    nextPage = undefined;
    byId('records').replaceChildren(...(saved ? [renderRecord(saved)] : []));
  }
  try {
    const data = await api('history', undefined, nextPage ? { page: nextPage } : {});
    const records = data.records.filter(record => record.id !== saved?.id);
    byId('records').append(...records.map(renderRecord));
    nextPage = data.next;
    message('history-message', byId('records').childElementCount ? '' : 'No products submitted yet.');
  } catch (error) {
    message('history-message', error.message, true);
    if (error.status === 401) setAccess(false);
    byId('more').textContent = 'Retry history';
    byId('more').hidden = false;
    return;
  } finally {
    historyBusy = false;
  }
  byId('more').textContent = 'Load more';
  byId('more').hidden = !nextPage;
}

async function openHistory(saved) {
  setTab(true);
  await loadHistory(false, saved);
}

byId('form-tab').addEventListener('click', () => {
  setTab(false);
  notice('');
});
byId('history-tab').addEventListener('click', () => openHistory());
byId('more').addEventListener('click', () => loadHistory(Boolean(nextPage)));

byId('login').addEventListener('submit', async event => {
  event.preventDefault();
  const login = event.currentTarget;
  const button = login.querySelector('button');
  button.disabled = true;
  message('login-message', 'Signing in...');
  try {
    await api('login', Object.fromEntries(new FormData(login)));
    login.reset();
    message('login-message', '');
    setAccess(true);
  } catch (error) {
    message('login-message', error.message, true);
  } finally {
    button.disabled = false;
  }
});

byId('logout').addEventListener('click', async () => {
  try {
    await api('logout', {});
    location.reload();
  } catch (error) {
    notice(error.message);
  }
});

try {
  await api('session');
  setAccess(true);
} catch (error) {
  setAccess(false);
  if (error.status !== 401) message('login-message', error.message, true);
}
