const Controller = require('./base');
const core = require('../stores/core');

function isStream(value) {
  return typeof value.read === 'function';
}

class Storage extends Controller {
  constructor (server, request, response, username, path) {
    super(server, request, response);
    this._username = username;
    this._path = path;

    if (this.request.headers.authorization) {
      this._token = decodeURIComponent(this.request.headers.authorization).split(/\s+/)[1];
    } else {
      this._token = this.params.access_token || this.params.oauth_token;
    }

    this._headers = {
      'Access-Control-Allow-Origin': this.request.headers.origin || '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag',
      'Cache-Control': 'no-cache'
    };
  }

  options () {
    this._headers['Access-Control-Allow-Methods'] = 'OPTIONS, GET, HEAD, PUT, DELETE';
    this._headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Length, Content-Type, If-Match, If-None-Match, Origin, X-Requested-With';
    this.response.writeHead(200, this._headers);
    this.response.end();
  }

  async get (head = false) {
    const version = this.getVersion();
    if (await this.checkToken('r')) {
      try {
        var { item, versionMatch } = await this.server._store.get(this._username, this._path, version, head);
      } catch (e) {
        console.error('Your storage backend does not behave correctly => ', e.message);
        this.response.writeHead(500, this._headers);
        this.response.write(e.message);
        return this.response.end();
      }
      const status = item ? 200 : 404;

      // directory listing
      if (item && item.items) {
        this._headers['Content-Type'] = 'application/ld+json';
        item.value = !head && Buffer.from(JSON.stringify({
          '@context': 'http://remotestorage.io/spec/folder-description',
          items: item.items
        }, true, 2));
      } else if (item) {
        this._headers['Content-Type'] = item['Content-Type'] || 'text/plain';
      }

      this.setVersion(item && item.ETag);
      if (versionMatch) {
        delete this._headers['Content-Type'];
        this.response.writeHead(304, this._headers);
        return this.response.end();
      }

      if (item && item.value && isStream(item.value)) {
        if (item && item['Content-Length']) this._headers['Content-Length'] = item['Content-Length'];
        this.response.writeHead(status, this._headers);
        item.value.pipe(this.response)
        return;
      }

      if (item && item.value && !head) this._headers['Content-Length'] = item.value.length;
      this.response.writeHead(status, this._headers);
      if (item && !head) {
        this.response.write(item.value, 'utf8');
      }
      this.response.end();
    }
  }

  async put () {
    const value = this.request.buffer;
    const type = this.request.headers['content-type'] || '';
    const range = this.request.headers['content-range'] || false;
    if (range) {
      this.unauthorized(400, 'Content-Range in PUT');
      return false;
    }
    const version = this.getVersion();
    let status, error, created, modified, conflict, isDir;
    if (await this.checkToken('w')) {
      try {
        ({ created, modified, conflict, isDir } = await this.server._store.put(this._username, this._path, type, value, version));
        status = conflict ? 412
          : isDir ? 409
            : created ? 201
              : 200;
      } catch (e) {
        console.error('Your storage backend does not behave correctly => ', e.message);
        error = e;
        status = 500;
      }
      this.setVersion(modified);
      if (error) this._headers['Content-Length'] = Buffer.from(error.message).length;
      this.response.writeHead(status, this._headers);
      this.response.end(error ? error.message : '');
    }
  }

  async delete () {
    const version = this.getVersion();

    if (!await this.checkToken('w')) return;
    let status;
    let error, deleted, modified, conflict;
    try {
      ({ deleted, modified, conflict } = await this.server._store.delete(this._username, this._path, version));
      status = deleted ? 200
        : conflict ? 412
          : 404;
    } catch (e) {
      console.error('Your storage backend does not behave correctly => ', e.message);
      error = e;
      status = 500;
    }

    this.setVersion(modified);
    if (error) this._headers['Content-Length'] = Buffer.from(error.message).length;
    this.response.writeHead(status, this._headers);
    this.response.end(error ? error.message : '');
  }

  async checkToken (permission) {
    if (this.server._forceSSL && !this.request.secure) {
      this.server._store.revokeAccess(this._username, this._token);
      this.unauthorized(400, 'invalid_request');
      return false;
    }

    const category = this._path.replace(/^\/public\//, '/');
    const parents = core.parents(category, true);
    const isdir = /\/$/.test(this._path);
    const isPublic = /^\/public\//.test(this._path);

    if (permission === 'r' && isPublic && !isdir) {
      return true;
    }

    let permissions;
    try {
      permissions = await this.server._store.permissions(this._username, this._token);
      if (!permissions) {
        this.unauthorized(401, 'invalid_token');
        return false;
      }
    } catch (e) {
      console.error(e);
      console.error('Bad store.permissions implementation?');
      this.unauthorized(400, 'bad_store_implementation');
      return false;
    }

    let dir;

    // TO REVIEW, read the spec about this
    for (var i = 0, n = parents.length; i < n; i++) {
      dir = permissions[parents[i]];
      if (!dir || dir.indexOf(permission) < 0) continue;

      if (permission === 'w' && isdir) {
        this.response.writeHead(400, this._headers);
        this.response.end();
        return false;
      } else {
        return true;
      }
    }
    this.unauthorized(403, 'insufficient_scope');
    return false;
  }

  getVersion () {
    const headers = this.request.headers;
    const ifMatch = headers['if-match'];
    const ifNone = headers['if-none-match'];
    return ifMatch || ifNone || null;
  }

  setVersion (timestamp) {
    if (!timestamp) return;
    this._headers['ETag'] = '"' + timestamp.toString() + '"';
  }

  unauthorized (status, error) {
    const realm = this.getHost();
    this._headers['WWW-Authenticate'] = `Bearer realm="${realm}" error="${error}"`;
    this.response.writeHead(status, this._headers);
    this.response.end();
  }
}

Storage.VALID_PATH = core.VALID_PATH;
Storage.VALID_NAME = core.VALID_NAME;
module.exports = Storage;
