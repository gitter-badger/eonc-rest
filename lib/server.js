/*!
 * eonc
 * Copyright(c) 2017 Panates Ltd.
 * MIT Licensed
 */

/**
 * This module is maintained from 'connect' project - https://github.com/senchalabs/connect
 */

/**
 * External module dependencies.
 */

const EventEmitter = require('events').EventEmitter;
const http = require('http');
const path = require('path');
const finalhandler = require('finalhandler');
const parseUrl = require('parseurl');
const debug = require('debug')('eonc:server');

/**
 * Internal module dependencies.
 */

const Endpoint = require('./endpoint');
const helpers = require('./helpers');


/**
 * Module variables.
 * @private
 */

const env = process.env.NODE_ENV || 'development';

/* istanbul ignore next */
const defer = typeof setImmediate === 'function'
    ? setImmediate
    : function (fn) {
        process.nextTick(fn.bind.apply(fn, arguments))
    };

/**
 * Create a new connect server.
 *
 * @return {function}
 * @public
 */

function createServer() {

    function Server(req, res, next) {
        Server.handle(req, res, next);
    }

    Object.assign(Server, proto);
    Object.assign(Server, EventEmitter.prototype);
    Server.route = '/';
    Server.stack = [];
    return Server;
}

let proto = {

    /**
     * Utilize the given middleware/endpoint `handle` to the given `route`,
     * defaulting to _/_. This "route" is the mount-point for the
     * middleware/endpoint, when given a value other than _/_ the middleware/endpoint
     * is only effective when that segment is present in the request's
     * pathname.
     *
     * For example if we were to mount a function at _/admin_, it would
     * be invoked on _/admin_, and _/admin/settings_, however it would
     * not be invoked for _/_, or _/posts_.
     *
     * @param {String|Function|Server} route, callback or server
     * @param {Function|Server|Endpoint} fn callback, server, or endpoint
     * @return {Server} for chaining
     * @public
     */

    use: function use(route, fn) {

        // Register handlers
        let lhandle = fn;
        let lpath = route;
        let fullRoute = this.fullRoute ? this.fullRoute + route : route;

        // default route to '/'
        if (typeof route !== 'string') {
            lhandle = route;
            lpath = '/';
        }


        // wrap vanilla http.Servers
        if (lhandle instanceof http.Server) {
            lhandle = lhandle.listeners('request')[0];
            lhandle.fullRoute = fullRoute;
        } else

        // wrap Endpoint
        if (lhandle instanceof Endpoint) {
            lhandle.route = lpath;
            lhandle.fullRoute = fullRoute;
            lhandle.name = path.basename(route);
            lhandle.owner = this;
        } else

        // wrap sub-apps
        if (typeof lhandle.handle === 'function') {
            let server = lhandle;
            server.route = lpath;
            server.fullRoute = fullRoute;
            lhandle.owner = this;
            lhandle = function (req, res, next) {
                server.handle(req, res, next);
            };
        }

        // strip trailing slash
        if (lpath[lpath.length - 1] === '/') {
            lpath = lpath.slice(0, -1);
        }

        // define the middleware
        debug('use %s at > %s', lhandle instanceof Endpoint ? 'Endpoint (' + lhandle.name + ')' : 'Handler', fullRoute || '/');
        this.stack.push({route: lpath, handle: lhandle});

        return this;
    },

    /**
     * Handle server requests, punting them down
     * the middleware stack.
     *
     * @private
     */

    handle: function handle(req, res, out) {
        let index = 0;
        let protohost = getProtohost(req.url) || '';
        let removed = '';
        let slashAdded = false;
        let stack = this.stack;

        // final function handler
        let done = out || finalhandler(req, res, {
                env: env,
                onerror: logerror
            });

        // store the original URL
        req.originalUrl = req.originalUrl || req.url;

        function next(err) {
            if (slashAdded) {
                req.url = req.url.substr(1);
                slashAdded = false;
            }

            if (removed.length !== 0) {
                req.url = protohost + removed + req.url.substr(protohost.length);
                removed = '';
            }

            // next callback
            let layer = stack[index++];

            // all done
            if (!layer) {
                defer(done, err);
                return;
            }

            // route data
            let path = parseUrl(req).pathname || '/';
            let route = layer.route;

            // skip this layer if the route doesn't match
            if (path.toLowerCase().substr(0, route.length) !== route.toLowerCase()) {
                return next(err);
            }

            // skip if route match does not border "/", ".", or end
            let c = path[route.length];
            if (c !== undefined && '/' !== c && '.' !== c) {
                return next(err);
            }

            // trim off the part of the url that matches the route
            if (route.length !== 0 && route !== '/') {
                removed = route;
                req.url = protohost + req.url.substr(protohost.length + removed.length);

                // ensure leading slash
                if (!protohost && req.url[0] !== '/') {
                    req.url = '/' + req.url;
                    slashAdded = true;
                }
            }

            // call the layer handle
            call(layer.handle, route, err, req, res, next);
        }

        next();
    },

    /**
     * Listen for connections.
     *
     * This method takes the same arguments
     * as node's `http.Server#listen()`.
     *
     * HTTP and HTTPS:
     *
     * If you run your application both as HTTP
     * and HTTPS you may wrap them individually,
     * since your Connect "server" is really just
     * a JavaScript `Function`.
     *
     *      var connect = require('connect')
     *        , http = require('http')
     *        , https = require('https');
     *
     *      var app = connect();
     *
     *      http.createServer(app).listen(80);
     *      https.createServer(options, app).listen(443);
     *
     * @return {http.Server}
     * @public
     */

    listen: function listen() {
        let server = http.createServer(this);
        return server.listen.apply(server, arguments);
    }


};

/**
 * Invoke a route handle.
 * @private
 */

function call(handle, route, err, req, res, next) {
    let arity = handle.length || (handle instanceof Endpoint ? 1 : undefined);
    let error = err;
    let hasError = Boolean(err);

    debug('I: %s(%s) %s > %s', req.method, handle.name || '<anonymous>', route, req.originalUrl);

    try {
        if (hasError && arity === 4) {
            // error-handling middleware
            handle(err, req, res, next);
            return;
        } else if (!hasError && arity < 4) {

            if (handle instanceof Endpoint) {
                handle.handle(req, res, next);
            } else {
                // request-handling middleware
                handle(req, res, next);
            }
            return;
        }
    } catch (e) {
        // replace the error
        error = e;
    }

    // continue
    next(error);
}

/**
 * Log error using console.error.
 *
 * @param {Error} err
 * @private
 */

function logerror(err) {
    if (env !== 'test') console.error(err.stack || err.toString());
}

/**
 * Get get protocol + host for a URL.
 *
 * @param {string} url
 * @private
 */

function getProtohost(url) {
    if (url.length === 0 || url[0] === '/') {
        return undefined;
    }

    let searchIndex = url.indexOf('?');
    let pathLength = searchIndex !== -1
        ? searchIndex
        : url.length;
    let fqdnIndex = url.substr(0, pathLength).indexOf('://');

    return fqdnIndex !== -1
        ? url.substr(0, url.indexOf('/', 3 + fqdnIndex))
        : undefined;
}


/**
 * Module exports.
 * @public
 */

exports = module.exports = createServer;
