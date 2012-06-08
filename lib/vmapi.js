/*
 * Copyright (c) 2012, Joyent, Inc. All rights reserved.
 *
 * Client library for the SDC Networking API (VMAPI)
 */

var util = require('util');
var format = util.format;

var RestifyClient = require('./restifyclient');



// --- Exported Client


/**
 * Constructor
 *
 * See the RestifyClient constructor for details
 */
function VMAPI(options) {
  RestifyClient.call(this, options);
}

util.inherits(VMAPI, RestifyClient);


// --- Vm methods



/**
 * Lists all VMs
 *
 * @param {Object} params : Filter params.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.listVms = function (params, callback) {
  if (typeof (params) === 'function') {
    callback = params;
    params = {};
  }
  return this.get('/vms', params, callback);
};



/**
 * Gets a VM by UUID
 *
 * @param {Object} params : Filter params.
 * @param {String} params.uuid : the UUID of the VM.
 * @param {String} params.owner_uuid : Optional, the UUID of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.getVm = function (params, callback) {
  var query = {};

  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid;

  return this.get(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Creates a VM. Returns a Job Response Object
 *
 * @param {Object} params : attributes of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.createVm = function (params, callback) {
  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');

  return this.post('/vms', params, callback);
};



/**
 * Stops a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.stopVm = function (params, callback) {
  var query = { action: 'stop' };

  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid;

  return this.post(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Starts a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.startVm = function (params, callback) {
  var query = { action: 'start' };

  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid;

  return this.post(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Reboots a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.rebootVm = function (params, callback) {
  var query = { action: 'reboot' };

  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');
  if (params.owner_uuid)
    query.owner_uuid = params.owner_uuid;

  return this.post(format('/vms/%s', params.uuid), query, callback);
};



/**
 * Updates a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.updateVm = function (params, callback) {
  var uuid;

  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');

  params.action = 'update';
  uuid = params.uuid;
  delete params.uuid;

  return this.post(format('/vms/%s', uuid), params, callback);
};



/**
 * Destroys a VM. Returns a Job Response Object
 *
 * @param {String} uuid : the UUID of the VM.
 * @param {Function} callback : of the form f(err, res).
 */
VMAPI.prototype.deleteVm = function (params, callback) {
  if (!params || typeof (params) !== 'object')
    throw new TypeError('params is required (object)');
  if (!params.uuid)
    throw new TypeError('UUID is required');

  var path;

  if (params.owner_uuid)
    path = format('/vms/%s?owner_uuid=%s', params.uuid, params.owner_uuid);
  else
    path = format('/vms/%s', params.uuid);

  return this.del(path, callback);
};



module.exports = VMAPI;