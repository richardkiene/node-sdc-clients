// Copyright 2011 Joyent, Inc.  All rights reserved.

var assert = require('assert');
var crypto = require('crypto');
var querystring = require('querystring');

var LRU = require('lru-cache');
var restify = require('restify');
var sprintf = require('sprintf').sprintf;

var utils = require('./utils');


///--- Globals

var HttpCodes = restify.HttpCodes;
var RestCodes = restify.RestCodes;
var log = restify.log;
var newError = restify.newError;

var KEYS_FMT = '/customers/%s/keys';
var KEY_FMT = KEYS_FMT + '/%s';
var METADATA_FMT = '/customers/%s/metadata/%s/%s';



///--- Exported CAPI Client.

/**
 * Constructor
 *
 * Note that in options you can pass in any parameters that the restify
 * RestClient constructor takes (for example retry/backoff settings).
 *
 * @param {Object} options:
 *                  - username {String} admin name to CAPI.
 *                  - password {String} password to said admin.
 *                  - url {String} CAPI location.
 */
function CAPI(options) {
  if (!options) throw new TypeError('options required');
  if (!options.username) throw new TypeError('options.username required');
  if (!options.password) throw new TypeError('options.password required');
  if ((options.uri && options.url) ||
      !(options.uri || options.url))
    throw new TypeError('One of options.uri, options.url required');

  if (options.uri) options.url = options.uri;
  if (!options.headers) options.headers = {};
  options.headers.Authorization =
    utils.basicAuth(options.username, options.password);
  options.contentType = 'application/x-www-form-urlencoded';

  this.client = restify.createClient(options);

  // In-memory caches
  this.authCacheSize = 100; // 100 records
  this.authCacheExpiry = 60 * 1000; // 60s
  if (options.authCache) {
    this.authCacheSize = options.authCache.size;
    this.authCacheExpiry = options.authCache.expiry * 1000;
  }
  this.authCache = LRU(this.authCacheSize);

  this.accountCacheSize = 1000;
  this.accountCacheExpiry = 300 * 1000;
  if (options.accountCache) {
    this.accountCacheSize = options.accountCache.size;
    this.accountCacheExpiry = options.accountCache.expiry * 1000;
  }
  this.accountCache = LRU(this.accountCacheSize);
}


/**
 * Gets an account by 'friendly' username from CAPI.
 *
 * This method maintains an in-memory cache of loaded accounts, so keep that in
 * mind if you need the "real" data from CAPI.
 *
 * @param {String} login the friendly username string (e.g. 'mcavage').
 * @param {Function} callback of the form f(err, account);
 *
 */
CAPI.prototype.getAccount = function(username, callback) {
  if (!username) throw new TypeError('username is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  // Check the local cache first
  var cached = this._accountCacheGet(username);
  if (cached) {
    if (!cached.found) return callback(cached.message);
    return callback(null, cached.message);
  }
  // End Cache Check

  var self = this;
  var request = {
    path: '/customers?login=' + username
  };
  return this.client.get(request, function(err, obj, headers) {
    if (err) return callback(self._translateError(err));

    if (!obj || !obj[0]) {
      var e = newError({httpCode: HttpCodes.NotFound,
                        restCode: RestCodes.ResourceNotFound,
                        message: username + ' does not exist'});
      self._accountCachePut(username, e);
      return callback(e);
    }

    self._accountCachePut(username, obj[0]);
    return callback(null, obj[0]);
  });
};
CAPI.prototype.loadAccount = CAPI.prototype.getAccount;


/**
 * Authenticates a username/password combination.
 *
 * Note this API uses an internal caching mechanism, so password changes
 * will take up to 1m to be reflected.
 *
 * @param {String} username the globally unique username for a client.
 * @param {String} password the password for the associated username.
 * @param {Function} callback of the form f(err, customer).
 */
CAPI.prototype.authenticate = function(username, password, callback) {
  if (!username) throw new TypeError('username is required');
  if (!password) throw new TypeError('password is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  // Check the local cache first
  var cached = this._authCacheGet(username, password);
  if (cached) {
    if (cached.allowed)
      return callback(null, cached.message);

    return callback(cached.message);
  }
  // End Cache Check

  var self = this;
  return this._getSalt(username, password, function(err, salt) {
    if (err) return callback(err);

    var loginRequest = {
      path: '/login',
      body: {
        login: username,
        digest: salt.digest
      }
    };

    return self.client.post(loginRequest, function(err, obj, headers) {
      if (err || !obj || !obj.customer_id) {
        var e = newError({
          httpCode: 403,
          restCode: 'InvalidCredentials',
          message: 'The credentials provided are invalid',
          error: (err || new Error('no object'))
        });

        if (log.trace()) {
          log.trace('capi.authenticate(%s) error => %o', username, e);
        }

        return callback(e);
      }

      self._authCachePut(username, password, obj);
      return callback(undefined, obj);
    });
  });
};


/**
 * Create a key
 *
 * @param {String} customer Customer uuid.
 * @param {Object} key object of the form: {name: {String}, key: {PEM}}.
 * @param {Function} callback of the form f(err, key).
 */
CAPI.prototype.createKey = function(customer, key, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!key || typeof(key) !== 'object')
    throw new TypeError('key is required (object)');
  if (!key.name) throw new TypeError('key.name is required');
  if (!key.key) throw new TypeError('key.key is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var self = this;
  var request = {
    path: sprintf(KEYS_FMT, customer),
    body: key
  };
  return this.client.post(request, function(err, obj, headers) {
    if (err) return callback(self._translateError(err));
    return callback(null, obj);
  });
};


/**
 * Returns a listing of all SSH keys for an account.
 *
 * Note this is a deep list, so it will have all the keys.
 *
 * @param {String} customer the customer uuid.
 * @param {Function} callback of the form f(err, [{}, ...]).
 */
CAPI.prototype.listKeys = function(customer, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var request = {
    path: sprintf(KEYS_FMT, customer)
  };

  return this.client.get(request, callback);
};


/**
 * Retrieves an SSH key by name.
 *
 * There's no magic here, internally, this just does a list all keys,
 * and picks out the one you asked for.
 *
 * @param {String} customer the customer uuid.
 * @param {String} keyName the name of the ssh key
 * @param {Function} callback of the form f(err, key).
 */
CAPI.prototype.getKeyByName = function(customer, keyName, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!keyName) throw new TypeError('keyName is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var self = this;
  this.listKeys(customer, function(err, keys) {
    if (err) return callback(err);

    var key;
    if (keys) {
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].name === keyName) {
          key = keys[i];
          break;
        }
      }
    }

    if (!key) {
      return callback(newError({httpCode: 404,
                                restCode: RestCodes.ResourceNotFound,
                                message: keyName + ' does not exist'}));
    }

    return callback(null, key);
  });
};


/**
 * Deletes a key from CAPI by id.
 *
 * You will need to have previously looked up the ssh key in CAPI, or know
 * the numeric database id beforehand.
 *
 * @param {String} customer uuid.
 * @param {String} ssh key database id.
 * @param {Function} callback of the form f(err).
 */
CAPI.prototype.deleteKey = function(customer, keyId, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!keyId) throw new TypeError('keyId is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var request = {
    path: sprintf(KEY_FMT, customer, keyId),
    expect: 410
  };
  return this.client.del(request, callback);
};


/**
 * Writes a metadata value to CAPI.
 *
 * @param {String} customer the customer uuid.
 * @param {String} appKey the capi application key to scope meta data.
 * @param {String} key the capi metadata key you want.
 * @param {Object} data the object you want to write.
 * @param {Function} callback of the form f(err).
 */
CAPI.prototype.putMetadata = function(customer, appKey, key, data, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!appKey) throw new TypeError('appKey is required');
  if (!key) throw new TypeError('key is required');
  if (!data || typeof(data) !== 'object')
    throw new TypeError('data is required (object)');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var self = this;
  var request = {
    path: sprintf(METADATA_FMT, customer, appKey, key),
    body: data
  };

  this.client.put(request, function(err, obj, headers) {
    if (err) err = self._translateError(err);
    return callback(err);
  });
};
CAPI.prototype.setMetadata = CAPI.prototype.putMetadata;


/**
 * Retrieves a metadata value from CAPI.
 *
 * @param {String} customer the customer uuid.
 * @param {String} appKey the capi application key to scope meta data.
 * @param {String} key the capi metadata key you want.
 * @param {Function} callback of the form f(err, value).
 */
CAPI.prototype.getMetadata = function(customer, appKey, key, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!appKey) throw new TypeError('appKey is required');
  if (!key) throw new TypeError('key is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var self = this;
  var request = {
    path: sprintf(METADATA_FMT, customer, appKey, key)
  };
  this.client.get(request, function(err, obj, headers, res) {
    if (err) return callback(self._translateError(err));

    // Restify won't have parsed this out.
    if (headers['content-length'] > 0 &&
        headers['content-type'] === 'text/html') {
      if (res.body) {
        obj = querystring.parse(res.body);
      }
    }

    return callback(null, obj, headers);
  });
};


/**
 * Retrieves a metadata value from CAPI.
 *
 * @param {String} customer the customer uuid.
 * @param {String} appKey the capi application key to scope meta data.
 * @param {String} key the capi metadata key you want.
 * @param {Function} callback of the form f(err).
 */
CAPI.prototype.deleteMetadata = function(customer, appKey, key, callback) {
  if (!customer) throw new TypeError('customer is required');
  if (!appKey) throw new TypeError('appKey is required');
  if (!key) throw new TypeError('key is required');
  if (!callback || typeof(callback) !== 'function')
    throw new TypeError('callback is required (function)');

  var self = this;
  var request = {
    path: sprintf(METADATA_FMT, customer, appKey, key)
  };
  this.client.del(request, function(err, obj, headers) {
    if (err) err = self._translateError(err);
    return callback(err);
  });
};



///--- Start private helper functions

CAPI.prototype._getSalt = function(user, password, callback) {
  assert.ok(user);
  assert.ok(password);
  assert.ok(callback);

  return this.client.get({ path: '/login/' + user }, function(err, obj) {
    if (err) return callback(err);

    var hash = crypto.createHash('sha1');
    hash.update(sprintf('--%s--%s--', obj.salt, password));
    var msg = {
      salt: obj.salt,
      digest: hash.digest('hex')
    };
    return callback(null, msg);
  });
};


CAPI.prototype._accountCacheGet = function(username) {
  assert.ok(username);

  var cached = this.accountCache.get(username);
  if (cached) {
    if (((new Date()).getTime() - cached.ctime) <= this.accountCacheExpiry) {
      log.debug('CAPI._accountCacheGet(%s): cache hit => %o', username, cached);
      return cached;
    }
  }

  log.debug('CAPI._accountCacheGet(%s): cache miss.', username);
  return null;
};


CAPI.prototype._accountCachePut = function(username, message) {
  assert.ok(username);

  var obj = {
    found: ((message instanceof Error) ? false : true),
    message: message,
    ctime: new Date().getTime()
  };
  log.debug('CAPI._accountCachePut(%s): writing %o', username, obj);
  this.accountCache.set(username, obj);
  return obj;
};


CAPI.prototype._authCacheGet = function(username, password) {
  assert.ok(username);
  assert.ok(password);

  var cacheKey = username + ':' + password;
  var cached = this.authCache.get(cacheKey);
  if (cached) {
    if (((new Date()).getTime() - cached.ctime) <= this.authCacheExpiry) {
      log.debug('CAPI._authCacheGet(%s): cache hit => %o', username, cached);
      return cached;
    }
  }

  log.debug('CAPI._authCacheGet(%s): cache miss', username);
  return null;
};


CAPI.prototype._authCachePut = function(username, password, message) {
  assert.ok(username);
  assert.ok(password);

  var obj = null;
  var cacheKey = username + ':' + password;

  if (!(message !== null ? message.customer_id : null)) {
    obj = {
      allowed: false,
      ctime: new Date().getTime(),
      message: newError({
        httpCode: HttpCodes.Forbidden,
        restCode: RestCodes.InvalidCredentials,
        message: 'The credentials provided are invalid'
      })
    };
  } else {
    obj = {
      allowed: true,
      message: message,
      ctime: new Date().getTime()
    };
  }

  log.debug('CAPI._authCachePut(%s): writing %o', username, obj);
  this.authCache.set(cacheKey, obj);
  return obj;
};


CAPI.prototype._translateError = function(err) {
  assert.ok(err);

  function _getMessage() {
    var msg = null;
    if (err.details && err.details.object && err.details.object.errors) {
      if (err.details.object.errors[0]) {
        msg = err.details.object.errors[0];
      } else {
        msg = err.details.object.errors;
      }
    }
    return msg;
  }

  switch(err.httpCode) {
  case 400:
  case 409:
    err = newError({
      httpCode: HttpCodes.Conflict,
      restCode: RestCodes.InvalidArgument,
      message: _getMessage(),
      error: err
    });
    break;
  case 404:
    err = newError({
      httpCode: HttpCodes.NotFound,
      restCode: RestCodes.ResourceNotFound,
      message: _getMessage(),
      error: err
    });
    break;
  default:
    // noop?
  }
  return err;
};



module.exports = CAPI;