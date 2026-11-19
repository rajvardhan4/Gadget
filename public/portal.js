import { uploadPresigned } from '@vercel/blob/client';

const byId = id => document.getElementById(id);
const fileInput = byId('files');
const form = byId('product-form');
const editAccessDialog = byId('edit-access-dialog');
const chosen = [];
const mimeByExt = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
};
let productId;
let pendingSave;
let busy = false;
let historyBusy = false;
let nextPage;
let editing;
let editorKey;
let editorAllowed = false;
let editorConnection;
let requestedEdit;

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
  const headers = {};
  if (action === 'edit-access' || action === 'update') headers['X-Portal-Edit-Key'] = editorKey;
  const options = { headers };
  if (body !== undefined) {
    options.method = 'POST';
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api/portal?' + params, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? 'The portal could not complete the request. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
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
    const image = element('img');
    image.src = item.url ?? '/api/portal?action=preview&id=' + encodeURIComponent(item.id);
    image.alt = '';
    image.addEventListener('error', () => image.replaceWith(icon));
    row.append(image);
    const size = item.file ? ' (' + (item.file.size / 1048576).toFixed(1) + ' MB)' : '';
    const name = element('span', item.name + size, 'file-name');
    row.append(name);
    if (item.file) {
      const remove = element('button', 'Remove');
      remove.type = 'button';
      remove.disabled = busy || Boolean(pendingSave);
      remove.setAttribute('aria-label', 'Remove ' + item.name);
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(item.url);
        chosen.splice(index, 1);
        renderFiles();
      });
      row.append(remove);
    }
    return row;
  }));
}

function addFiles(files) {
  if (busy || pendingSave) return;
  const errors = [];
  for (const file of files) {
    const mime = Object.values(mimeByExt).includes(file.type)
      ? file.type : mimeByExt[file.name.split('.').pop().toLowerCase()];
    if (!mime || !file.size || file.name.length > 255) {
      errors.push(file.name + ' could not be added. Choose a supported image with content and a filename up to 255 characters.');
      continue;
    }
    if (chosen.some(item => item.file?.name === file.name && item.file.size === file.size &&
      item.file.lastModified === file.lastModified)) continue;
    chosen.push({ file, mime, name: file.name, url: URL.createObjectURL(file) });
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

async function uploadImage(item, index) {
  const { file, mime } = item;
  const extension = Object.keys(mimeByExt).find(key => mimeByExt[key] === mime);
  const pathname = 'images/' + productId + '/' + crypto.randomUUID() + '.' + extension;
  const position = 'Uploading image ' + (index + 1) + ' of ' + chosen.length;
  message('submit-message', position + '...');
  const result = await uploadPresigned(pathname, file, {
    access: 'private',
    contentType: mime,
    handleUploadUrl: '/api/portal?action=upload',
    clientPayload: JSON.stringify({ mime }),
    multipart: file.size > 5 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => {
      message('submit-message', position + ' (' + Math.floor(percentage) + '%)...');
    },
  });
  item.id = result.pathname;
}

function lockForm() {
  for (const control of form.querySelectorAll('input, select, textarea')) {
    control.disabled = busy || Boolean(pendingSave);
  }
  byId('submit').disabled = busy;
  byId('submit').textContent = busy ? 'Saving...' : pendingSave ? 'Retry save' : editing ? 'Save changes' : 'Submit product';
  byId('cancel-edit').disabled = busy;
  byId('history-tab').disabled = busy || Boolean(editing);
  byId('form-tab').disabled = Boolean(editing);
  renderFiles();
}

function fillForm(fields) {
  form.reset();
  for (const [key, value] of Object.entries(fields)) {
    const input = form.elements.namedItem(key);
    if (input?.name) input.value = value ?? '';
  }
}

function setEditView(active) {
  byId('entry-title').textContent = active ? 'Edit submission' : 'Submit a product';
  byId('entry-description').textContent = active
    ? 'Update the product details or add more images, then save your changes.'
    : 'Send product details, prices and original images together.';
  byId('cancel-edit').hidden = !active;
}

function startEdit(record) {
  if (busy || editing) return;
  const draft = {
    fields: pendingSave ?? Object.fromEntries(new FormData(form)),
    files: chosen.splice(0), productId, pendingSave,
    submitMessage: byId('submit-message').textContent,
    submitError: byId('submit-message').classList.contains('error'),
    fileMessage: byId('file-message').textContent,
  };
  editing = { baseRevision: record.revision ?? null, draft };
  productId = record.id;
  pendingSave = undefined;
  chosen.push(...record.images.map(image => ({ ...image, uploaded: true })));
  fillForm(record);
  message('submit-message', '');
  message('file-message', '');
  notice('');
  setEditView(true);
  byId('history').hidden = true;
  byId('entry').hidden = false;
  lockForm();
  byId('entry-title').focus();
}

function clearFiles() {
  for (const item of chosen.splice(0)) {
    if (item.url) URL.revokeObjectURL(item.url);
  }
}

function restoreDraft() {
  const { draft } = editing;
  editing = undefined;
  clearFiles();
  chosen.push(...draft.files);
  productId = draft.productId;
  pendingSave = draft.pendingSave;
  fillForm(draft.fields);
  message('submit-message', draft.submitMessage, draft.submitError);
  message('file-message', draft.fileMessage, true);
  setEditView(false);
}

byId('cancel-edit').addEventListener('click', async () => {
  restoreDraft();
  lockForm();
  await openHistory();
  byId('history-title').focus();
});

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
      pendingSave = { ...fields, id: productId, images: chosen.map(item => ({ id: item.id, name: item.name })) };
      if (editing) Object.assign(pendingSave, { baseRevision: editing.baseRevision, revision: crypto.randomUUID() });
    }
    message('submit-message', 'Saving product details...');
    const saved = await api(editing ? 'update' : 'save', pendingSave);
    if (editing) {
      restoreDraft();
      notice('Changes saved for ' + saved.name + '.');
    } else {
      clearFiles();
      form.reset();
      productId = undefined;
      pendingSave = undefined;
      message('submit-message', '');
      message('file-message', '');
      notice(saved.name + ' was saved.');
    }
    await openHistory(saved);
    byId('history-title').focus();
  } catch (error) {
    if (error.status === 400) pendingSave = undefined;
    message('submit-message', error.message, true);
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
  const actions = element('div', '', 'record-actions');
  const edit = element('button', 'Edit submission', 'primary');
  edit.addEventListener('click', async () => {
    await editorConnection;
    if (editorAllowed) {
      startEdit(record);
    } else if (!editAccessDialog.open) {
      requestedEdit = record;
      editAccessDialog.showModal();
    }
  });
  actions.append(edit);
  const download = element('button', 'Download product data', 'secondary');
  download.addEventListener('click', () => {
    downloadFile(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
      'product-' + record.id + '.json');
  });
  details.addEventListener('toggle', () => {
    if (!details.open || images.childElementCount) return;
    for (const image of record.images) {
      const item = element('li');
      const link = element('a');
      link.href = '/api/portal?action=download&id=' + encodeURIComponent(image.id);
      link.setAttribute('aria-label', 'Download ' + image.name);
      const preview = element('img');
      preview.alt = '';
      preview.loading = 'lazy';
      preview.src = '/api/portal?action=preview&id=' + encodeURIComponent(image.id);
      preview.addEventListener('error', () => preview.remove());
      link.append(preview, document.createTextNode(image.name));
      item.append(link);
      images.append(item);
    }
  });
  actions.append(download);
  details.append(fields, images, actions);
  return details;
}

async function loadHistory(append = false, saved) {
  if (historyBusy) return;
  historyBusy = true;
  byId('more').hidden = true;
  message('history-message', 'Loading submissions...');
  if (!append) {
    nextPage = undefined;
    const savedRow = saved && renderRecord(saved);
    if (savedRow) savedRow.open = true;
    byId('records').replaceChildren(...(savedRow ? [savedRow] : []));
  }
  try {
    const data = await api('history', undefined, nextPage ? { page: nextPage } : {});
    const records = data.records.filter(record => record.id !== saved?.id);
    byId('records').append(...records.map(renderRecord));
    nextPage = data.next;
    message('history-message', byId('records').childElementCount ? '' : 'No products submitted yet.');
  } catch (error) {
    message('history-message', error.message, true);
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

function keyFromHash(hash) {
  return new URLSearchParams(hash.slice(1)).get('edit');
}

async function authorizeEditor(key) {
  editorKey = key;
  editorAllowed = false;
  await api('edit-access');
  editorAllowed = true;
  sessionStorage.setItem('portal-edit-key', key);
}

async function connectEditor() {
  const key = keyFromHash(location.hash);
  const savedKey = key ?? sessionStorage.getItem('portal-edit-key');
  if (key) history.replaceState(null, '', location.pathname + location.search);
  if (!savedKey) return;
  try {
    await authorizeEditor(savedKey);
    if (key && !editing) await openHistory();
  } catch (error) {
    if (error.status === 403) sessionStorage.removeItem('portal-edit-key');
    notice(error.message);
  }
}

byId('edit-access-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('unlock-edit');
  if (button.disabled) return;
  const link = new URL(byId('edit-link').value);
  const key = link.origin === location.origin && keyFromHash(link.hash);
  if (!key) {
    message('edit-access-message', 'Paste the full private edit link for this portal.', true);
    return;
  }
  button.disabled = true;
  const record = requestedEdit;
  message('edit-access-message', '');
  try {
    await authorizeEditor(key);
    if (editAccessDialog.open && requestedEdit === record) {
      editAccessDialog.close();
      startEdit(record);
    }
  } catch (error) {
    if (editAccessDialog.open) message('edit-access-message', error.message, true);
  } finally {
    button.disabled = false;
  }
});

byId('cancel-edit-access').addEventListener('click', () => editAccessDialog.close());
editAccessDialog.addEventListener('close', () => {
  requestedEdit = undefined;
  byId('edit-access-form').reset();
  message('edit-access-message', '');
});

editorConnection = connectEditor();
window.addEventListener('hashchange', () => {
  editorConnection = connectEditor();
});
