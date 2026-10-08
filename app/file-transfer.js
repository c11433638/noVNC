/*
 * noVNC: authenticated file uploads and downloads
 * Licensed under MPL 2.0 (see LICENSE.txt)
 */
import _ from './localization.js';

const ERRORS = {
    'authentication_required': 'Enter your VNC password to access files.',
    'invalid_password': 'Incorrect VNC password.',
    'too_many_attempts': 'Too many attempts. Try again in a minute.',
    'invalid_path': 'This file or folder is not accessible.',
    'not_found': 'The file or folder no longer exists.',
    'file_too_large': 'The file exceeds the upload size limit.',
    'not_enough_space': 'There is not enough free space on the remote computer.',
    'incomplete_upload': 'Upload incomplete. Please try again.',
    'invalid_offset': 'Upload interrupted. Please try again.',
    'upload_expired': 'Upload expired. Please try again.',
    'too_many_uploads': 'Too many uploads. Please try again later.',
};

function sizeLabel(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
        bytes /= 1024;
        unit++;
    }
    return `${unit ? bytes.toFixed(1) : bytes} ${units[unit]}`;
}

class TransferError extends Error {
    constructor(code) {
        super(_(ERRORS[code] || 'File transfer failed. Please try again.'));
        this.code = code;
    }
}

export default class FileTransfer {
    constructor(getPassword) {
        this._getPassword = getPassword;
        this._base = new URL('api/files/', window.location.href);
        this._path = '';
        this._busy = false;
        this._cancelled = false;
        this._xhr = null;
        this._maxFileSize = 10 * 1024 ** 3;
        this._revision = 0;
        this._autoPassword = true;

        this._element('auth').addEventListener('submit', e => this._login(e));
        this._element('refresh').addEventListener('click', () => this.refresh());
        this._element('up').addEventListener('click', () => {
            const parent = this._path.split('/');
            parent.pop();
            this.refresh(parent.join('/'));
        });
        this._element('input').addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            e.target.value = '';
            this._upload(files);
        });
        this._element('cancel').addEventListener('click', () => {
            this._cancelled = true;
            this._xhr?.abort();
        });
    }

    _element(name) {
        return document.getElementById('noVNC_files_' + name);
    }

    _url(endpoint, params = {}) {
        const url = new URL(endpoint, this._base);
        url.search = new URLSearchParams(params).toString();
        return url;
    }

    async _request(endpoint, params = {}, data = undefined) {
        const response = await fetch(this._url(endpoint, params), {
            method: data === undefined ? 'GET' : 'POST',
            headers: { 'X-NoVNC-Transfer': '1', 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data),
            credentials: 'same-origin',
            cache: 'no-store',
        });
        let result;
        try {
            result = await response.json();
        } catch (err) {
            throw new TransferError('unavailable');
        }
        if (!response.ok) throw new TransferError(result.error);
        return result;
    }

    _message(message, error = false) {
        this._element('status').textContent = message;
        this._element('status').classList.toggle('noVNC_files_error', error);
    }

    _showAuth(error) {
        this._element('auth').classList.remove('noVNC_hidden');
        this._element('browser').classList.add('noVNC_hidden');
        this._element('password').focus();
        this._message(error.message, true);
    }

    async _list(path) {
        try {
            return await this._request('list', { path });
        } catch (err) {
            if (err.code !== 'authentication_required' || !this._autoPassword) throw err;
            const password = this._getPassword();
            if (password === undefined || password === null) throw err;
            this._autoPassword = false;
            await this._request('session', {}, { password });
            return await this._request('list', { path });
        }
    }

    async _login(e) {
        e.preventDefault();
        const input = this._element('password');
        const password = input.value;
        input.value = '';
        this._element('login').disabled = true;
        try {
            await this._request('session', {}, { password });
            await this.refresh();
        } catch (err) {
            this._showAuth(err);
        } finally {
            this._element('login').disabled = false;
        }
    }

    async refresh(path = this._path) {
        if (this._busy) return;
        const revision = ++this._revision;
        this._message(_('Loading files…'));
        try {
            const data = await this._list(path);
            if (revision !== this._revision) return;
            this._render(data);
            this._message('');
        } catch (err) {
            if (revision !== this._revision) return;
            if (err.code === 'authentication_required' || err.code === 'invalid_password') {
                this._showAuth(err);
            } else {
                this._message(err.message, true);
            }
        }
    }

    _render(data) {
        this._path = data.path;
        this._maxFileSize = data.maxFileSize;
        this._element('auth').classList.add('noVNC_hidden');
        this._element('browser').classList.remove('noVNC_hidden');
        this._element('root').textContent = data.root;
        this._element('path').textContent = '/' + this._path;
        this._element('up').disabled = !this._path;
        this._element('limit').textContent = _('Maximum file size:') + ' ' + sizeLabel(data.maxFileSize);
        const list = this._element('list');
        list.replaceChildren();
        if (data.entries.length === 0) {
            const empty = document.createElement('li');
            empty.textContent = _('This folder is empty.');
            list.appendChild(empty);
        }
        for (const entry of data.entries) {
            const row = document.createElement('li');
            const name = document.createElement('span');
            name.className = 'noVNC_files_name';
            name.textContent = (entry.directory ? '📁 ' : '') + entry.name;
            name.title = entry.name;
            row.appendChild(name);
            const action = document.createElement('button');
            action.type = 'button';
            action.textContent = _(entry.directory ? 'Open folder' : 'Download');
            const path = this._path ? this._path + '/' + entry.name : entry.name;
            action.addEventListener('click', () => {
                if (entry.directory) this.refresh(path);
                else this._download(path, entry.name);
            });
            if (!entry.directory) {
                const size = document.createElement('span');
                size.className = 'noVNC_files_size';
                size.textContent = sizeLabel(entry.size);
                row.appendChild(size);
            }
            row.appendChild(action);
            list.appendChild(row);
        }
    }

    async _download(path, name) {
        try {
            // Validate the session before navigating, avoiding a downloaded error page.
            await this._list(this._path);
            const link = document.createElement('a');
            link.href = this._url('download', { path });
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (err) {
            if (err.code === 'authentication_required') this._showAuth(err);
            else this._message(err.message, true);
        }
    }

    _setBusy(busy) {
        this._busy = busy;
        this._element('input').disabled = busy;
        this._element('refresh').disabled = busy;
        this._element('up').disabled = busy || !this._path;
        for (const button of this._element('list').querySelectorAll('button')) {
            button.disabled = busy;
        }
        this._element('progress_area').classList.toggle('noVNC_hidden', !busy);
    }

    _sendChunk(id, blob, offset, progress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            this._xhr = xhr;
            xhr.open('PUT', this._url('upload', { id, offset }));
            xhr.setRequestHeader('X-NoVNC-Transfer', '1');
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.timeout = 120000;
            xhr.upload.onprogress = e => progress(e.loaded);
            xhr.onload = () => {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300) resolve(data);
                    else reject(new TransferError(data.error));
                } catch (err) {
                    reject(new TransferError('unavailable'));
                }
            };
            xhr.onerror = () => reject(new TransferError('unavailable'));
            xhr.ontimeout = () => reject(new TransferError('incomplete_upload'));
            xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
            xhr.send(blob);
        });
    }

    async _uploadChunk(id, blob, offset, progress) {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (this._cancelled) throw new DOMException('', 'AbortError');
            try {
                return await this._sendChunk(id, blob, offset, progress);
            } catch (err) {
                if (this._cancelled ||
                    !['unavailable', 'incomplete_upload', 'invalid_offset'].includes(err.code)) {
                    throw err;
                }
                // A lost response can follow a successful write. Check the server
                // offset before retrying, so no bytes are duplicated or skipped.
                const status = await this._request('upload', { id });
                if (status.offset === offset + blob.size) return status;
                if (status.offset !== offset) throw new TransferError('invalid_offset');
                if (attempt === 2) throw err;
                await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
            } finally {
                this._xhr = null;
            }
        }
    }

    async _upload(files) {
        if (!files.length || this._busy) return;
        const total = files.reduce((sum, file) => sum + file.size, 0);
        let completed = 0;
        let count = 0;
        let id = null;
        this._cancelled = false;
        ++this._revision;
        this._setBusy(true);
        this._element('progress').value = 0;
        const renamed = [];
        let message;
        let error = false;
        try {
            // Opening the panel is not required to retain a session across refreshes.
            await this._list(this._path);
            for (const file of files) {
                if (this._cancelled) throw new DOMException('', 'AbortError');
                if (file.size > this._maxFileSize) throw new TransferError('file_too_large');
                this._message(_('Uploading:') + ' ' + file.name + ` (${count + 1}/${files.length})`);
                const upload = await this._request('upload', {},
                                                   { name: file.name, path: this._path, size: file.size });
                id = upload.id;
                let offset = 0;
                const update = (loaded) => {
                    const amount = completed + offset + loaded;
                    const percent = total ? Math.min(100, Math.round(amount / total * 100)) : 0;
                    this._element('progress').value = percent;
                    this._element('progress_text').textContent = `${percent}% · ${sizeLabel(amount)} / ${sizeLabel(total)}`;
                };
                update(0);
                while (offset < file.size) {
                    if (this._cancelled) throw new DOMException('', 'AbortError');
                    const chunk = file.slice(offset, offset + upload.chunkSize);
                    const result = await this._uploadChunk(id, chunk, offset, update);
                    offset = result.offset;
                    update(0);
                }
                if (this._cancelled) throw new DOMException('', 'AbortError');
                const result = await this._request('complete', { id }, {});
                if (result.name !== file.name) renamed.push(result.name);
                id = null;
                completed += file.size;
                count++;
            }
            message = _('Upload complete.') + ` (${count})`;
            if (renamed.length) message += ' ' + _('Saved with a new name:') + ' ' + renamed.join(', ');
        } catch (err) {
            message = this._cancelled ? _('Upload cancelled.') : err.message;
            if (count) message += ' ' + _('Files already uploaded:') + ' ' + count;
            error = !this._cancelled;
            if (id) {
                try {
                    await this._request('cancel', { id }, {});
                } catch (err) { /* Interrupted transfers expire automatically. */ }
            }
        } finally {
            this._xhr = null;
            this._setBusy(false);
            await this.refresh();
            this._message(message, error);
        }
    }
}
