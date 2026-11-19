const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  throw new Error('Set the three GOOGLE_* OAuth credentials before running this command.');
}

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
  }),
});
if (!response.ok) throw new Error('Google OAuth failed (HTTP ' + response.status + ').');
const { access_token: token } = await response.json();

const folder = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Gadget Product Submissions', mimeType: 'application/vnd.google-apps.folder' }),
});
if (!folder.ok) throw new Error('Google Drive folder creation failed (HTTP ' + folder.status + ').');
const { id, webViewLink } = await folder.json();
console.log('GOOGLE_DRIVE_FOLDER_ID=' + id);
console.log(webViewLink ?? 'https://drive.google.com/drive/folders/' + id);
