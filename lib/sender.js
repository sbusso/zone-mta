'use strict';

const config = require('config');
const log = require('npmlog');
const os = require('os');
const fetch = require('nodemailer-fetch');
const iptools = require('./iptools');
const bounces = require('./bounces');
const Headers = require('mailsplit').Headers;
const SMTPConnection = require('smtp-connection');
const net = require('net');
const PassThrough = require('stream').PassThrough;
const dkimSign = require('./dkim-sign');
const EventEmitter = require('events');

class Sender extends EventEmitter {

    constructor(clientId, connectionId, zone, sendCommand, srsRewriter) {
        super();

        this.clientId = clientId;
        this.connectionId = connectionId;
        this.timers = new Map();

        this.zone = zone;
        this.sendCommand = (cmd, callback) => {
            if (typeof cmd === 'string') {
                cmd = {
                    cmd
                };
            }
            let startTimer = Date.now();
            sendCommand(cmd, (err, data) => {
                this.updateTimer('Command:' + cmd.cmd, Date.now() - startTimer);
                return callback(err, data);
            });
        };
        this.srsRewriter = srsRewriter;
        this.closing = false;
        this.ref = {}; // object value for WeakMap references
        this.emptyChecks = 0;
        this.sendNext();
    }

    updateTimer(name, value) {
        if (!this.timers.has(name)) {
            this.timers.set(name, {
                totalsum: 0,
                totalcount: 0,
                sum: 0,
                count: 0,
                prevsum: 0,
                prevcount: 0,
                created: Date.now()
            });
        }
        let timerData = this.timers.get(name);
        timerData.totalsum += value;
        timerData.totalcount++;
        timerData.sum += value;
        timerData.count++;
    }

    getTimers() {
        this.timers.forEach((value, name) => {
            let diffsum = value.sum - value.prevsum;
            let diffcount = value.count - value.prevcount;

            let timediff = (Date.now() - value.created) / 1000;
            let sumspeed = Math.round((diffsum / timediff) * 1000) / 1000;
            let countspeed = Math.round((diffcount / timediff) * 1000) / 1000;

            log.verbose('TIMER/' + this.clientId + '/' + this.connectionId, '%s: total %s calls, sum %ss. totaldelta %s sumdelta %s', name, value.totalcount, value.totalsum / 1000, countspeed, sumspeed);
            this.timers.set(name, {
                totalsum: value.totalsum,
                totalcount: value.totalcount,
                sum: 0,
                count: 0,
                prevsum: value.sum,
                prevcount: value.count,
                created: Date.now()
            });
        });
    }

    close() {
        this.closing = true;
    }

    sendNext() {
        if (this.closing) {
            return;
        }

        let startTimer;

        this.sendCommand('GET', (err, delivery) => {
            if (err) {
                this.closing = true;
                this.emit('error', err);
                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                return;
            }

            if (!delivery || !delivery.id) {
                this.emptyChecks++;
                return setTimeout(() => this.sendNext(), Math.min(Math.pow(this.emptyChecks, 2), 1000) * 10);
            }
            this.emptyChecks = 0;

            delivery.headers = new Headers(delivery.headers);

            if (delivery.spam && delivery.spam.default) {

                // insert spam headers to the bottom of the header section
                let statusParts = [];

                // This is ougtgoing message so the recipient would have exactly 0 reasons to trust our
                // X-Spam-* headers, thus we use custom headers X-Zone-Spam-* and these are for debugging
                // purposes only

                if ('score' in delivery.spam.default) {
                    statusParts.push('score=' + delivery.spam.default.score);
                }

                if ('required_score' in delivery.spam.default) {
                    statusParts.push('required=' + delivery.spam.default.required_score);
                }

                if (Array.isArray(delivery.spam.tests) && delivery.spam.tests.length) {
                    statusParts.push('tests=[' + delivery.spam.tests.join(', ') + ']');
                }

                delivery.headers.add('X-Zone-Spam-Status', (delivery.spam.default.is_spam ? 'Yes' : 'No') + (statusParts.length ? ', ' + statusParts.join(', ') : ''), Infinity);
            }

            startTimer = Date.now();
            this.zone.speedometer(this.ref, () => { // check throttling speed
                this.updateTimer('Speedometer', Date.now() - startTimer);

                // Try to connect to the recipient MX
                startTimer = Date.now();
                this.getConnection(delivery, (err, connection) => {
                    this.updateTimer('getConnection', Date.now() - startTimer);
                    let recivedHeader;
                    if (err) {
                        startTimer = Date.now();

                        // ensure that we have a received header set
                        recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, os.hostname()));
                        delivery.headers.addFormatted('Received', recivedHeader, 0);

                        this.handleResponseError(delivery, connection, err, () => {
                            this.updateTimer('handleResponseError', Date.now() - startTimer);
                        });
                        return setImmediate(() => this.sendNext());
                    }

                    recivedHeader = Buffer.from(this.zone.generateReceivedHeader(delivery, connection.options.name));
                    delivery.headers.addFormatted('Received', recivedHeader, 0);

                    if (config.dkim.enabled) {
                        // tro to sign the message, this would prepend a DKIM-Signature header to the message
                        this.signMessage(delivery);
                    }

                    let messageHeaders = delivery.headers.build();
                    let messageSize = recivedHeader.length + messageHeaders.length + delivery.bodySize; // required for SIZE argument
                    let messageFetch = fetch('http://' + config.api.hostname + ':' + config.api.port + '/fetch/' + delivery.id + '?body=yes');
                    let messageStream = new PassThrough();

                    messageStream.write(messageHeaders);
                    messageFetch.pipe(messageStream);
                    messageFetch.on('error', err => messageStream.emit('error', err));

                    let envelopeFrom = delivery.from;
                    if (config.srs.enabled && envelopeFrom) {
                        let senderDomain = envelopeFrom.substr(envelopeFrom.lastIndexOf('@') + 1).toLowerCase();
                        if (!config.srs.excludeDomains.includes(senderDomain)) {
                            envelopeFrom = this.srsRewriter
                                .rewrite(envelopeFrom.substr(0, envelopeFrom.lastIndexOf('@')), senderDomain) +
                                '@' + config.srs.rewriteDomain;
                        }
                    }

                    // Do the actual delivery
                    startTimer = Date.now();
                    connection.send({
                        from: envelopeFrom,
                        to: [].concat(delivery.to || []),
                        size: messageSize
                    }, messageStream, (err, info) => {
                        this.updateTimer('Send', Date.now() - startTimer);
                        // kill this connection, we don't need it anymore
                        connection.close();

                        if (err) {
                            messageStream = null;
                            messageFetch = null;
                            startTimer = Date.now();
                            this.handleResponseError(delivery, connection, err, () => {
                                this.updateTimer('handleResponseError', Date.now() - startTimer);
                            });
                            return setImmediate(() => this.sendNext());
                        }

                        log.info('Sender/' + this.zone.name + '/' + process.pid, 'ACCEPTED %s.%s for <%s> by %s (%s)', delivery.id, delivery.seq, delivery.to, delivery.domain, this.formatSMTPResponse(info.response));

                        startTimer = Date.now();
                        this.releaseDelivery(delivery, err => {
                            this.updateTimer('releaseDelivery', Date.now() - startTimer);
                            if (err) {
                                log.error('Sender/' + this.zone.name + '/' + process.pid, 'Can\'t get message acknowledged');
                                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);

                                this.closing = true;
                                return this.emit('error', err);
                            }
                        });
                        return setImmediate(() => this.sendNext());
                    });
                });
            });
        });
    }


    handleResponseError(delivery, connection, err, callback) {
        let bounce;
        let deferredCount = delivery._deferred && delivery._deferred.count || 0;
        let smtpResponse = this.formatSMTPResponse(err.response || err.message);

        if ((bounce = bounces.check(err.response)).action !== 'reject' || deferredCount > 6) {
            let ttl = Math.min(Math.pow(5, deferredCount + 1), 1024) * 60 * 1000;
            log.info('Sender/' + this.zone.name + '/' + process.pid, 'DEFERRED[%s] %s.%s for <%s> by %s: %s (%s)', bounce.category, delivery.id, delivery.seq, delivery.to, delivery.domain, bounce.message, smtpResponse);
            return this.deferDelivery(delivery, ttl, err => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }
                return callback();
            });
        } else {
            log.info('Sender/' + this.zone.name + '/' + process.pid, 'REJECTED[%s] %s.%s for <%s> by %s: %s (%s)', bounce.category, delivery.id, delivery.seq, delivery.to, delivery.domain, bounce.message, smtpResponse);
            return this.releaseDelivery(delivery, err => {
                if (err) {
                    log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);

                    this.closing = true;
                    return this.emit('error', err);
                }

                let retries = 0;
                let body = {
                    id: delivery.id,
                    to: delivery.to,
                    seq: delivery.seq,
                    returnPath: delivery.from,
                    category: bounce.category,
                    time: Date.now(),
                    response: smtpResponse
                };
                if (delivery.fbl) {
                    body.fbl = delivery.fbl;
                }

                let notifyBounce = () => {

                    // send bounce information
                    let returned;
                    let stream = fetch(config.bounces.url, {
                        body
                    });

                    stream.on('readable', () => {
                        while (stream.read() !== null) {
                            // ignore
                        }
                    });

                    stream.on('error', err => {
                        if (returned) {
                            return;
                        }
                        returned = true;
                        log.error('Sender/' + this.zone.name + '/' + process.pid, 'Could not send bounce info');
                        log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                        if (retries++ <= 5) {
                            setTimeout(notifyBounce, Math.pow(retries, 2) * 1000).unref();
                        }
                    });

                    stream.on('end', () => {
                        if (returned) {
                            return;
                        }
                        returned = true;
                    });
                };

                if (config.bounces.url) {
                    setImmediate(notifyBounce);
                }

                if (config.bounces.enabled) {
                    setImmediate(() => this.sendBounceMessage(delivery, bounce, smtpResponse));
                }

                return callback();
            });
        }
    }

    getConnection(delivery, callback) {
        let domain = delivery.domain;

        let resolveMx = (domain, next) => {
            if (this.zone.host) {
                return next(null, [{
                    exchange: this.zone.host,
                    priority: 0
                }]);
            }
            iptools.resolveMx(domain, next);
        };

        resolveMx(domain, (err, exchanges) => {
            if (err) {
                return callback(err);
            }

            if (!exchanges) {
                // try again later (4xx code defers, 5xx rejects) just in case the recipients DNS is down
                err = err || new Error('Can\'t find an MX server for ' + domain);
                err.response = '450 Can\'t find an MX server for ' + domain;
                return callback(err);
            }

            let connection;
            let mxTry = 0;

            let tryConnectMX = () => {
                let err;
                if (mxTry >= exchanges.length) {
                    err = new Error('Can\'t connect to MX');
                    err.response = '450 Can\'t connect to any MX server for ' + domain;
                    return callback(err);
                }
                let exchange = exchanges[mxTry++];
                iptools.resolveIp(exchange.exchange, this.zone, (err, ipList) => {
                    if (err) {
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, 'Error resolving A/AAAA for %s. %s', exchange.exchange, err.message);
                        return tryConnectMX();
                    }
                    if (!ipList.length) {
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, 'Could not resolve A/AAAA for %s', exchange.exchange);
                        return tryConnectMX();
                    }

                    let ipTry = -1;
                    let tryConnectIP = retryConnection => {
                        if (!retryConnection && ipTry >= ipList.length - 1) {
                            return tryConnectMX();
                        }
                        let ip = retryConnection ? ipList[ipTry] : ipList[++ipTry];
                        let zoneAddress = this.zone.getAddress(delivery.id + '.' + delivery.seq, net.isIPv6(ip));
                        log.silly('Sender/' + this.zone.name + '/' + process.pid, 'Resolved MX for %s as %s[%s]. Using %s (%s[%s]) to connect', domain, exchange.exchange, ip, this.zone.name, zoneAddress.name, zoneAddress.address);

                        let options = {
                            servername: exchange.exchange,
                            host: ip,

                            port: this.zone.port,
                            localAddress: zoneAddress.address,
                            name: zoneAddress.name,

                            requireTLS: !this.zone.disableStarttls,
                            ignoreTLS: this.zone.disableStarttls,
                            opportunisticTLS: true,
                            secure: !!this.zone.secure,
                            authMethod: this.zone.authMethod,

                            tls: {
                                servername: exchange.exchange,
                                rejectUnauthorized: false
                            },

                            logger: ('logger' in this.zone ? this.zone.logger : config.log.mx) ? {
                                info: log.verbose.bind(log, 'Sender/' + this.zone.name + '/' + process.pid + '/SMTP'),
                                debug: log.silly.bind(log, 'Sender/' + this.zone.name + '/' + process.pid + '/SMTP'),
                                error: log.error.bind(log, 'Sender/' + this.zone.name + '/' + process.pid + '/SMTP')
                            } : false,
                            debug: ('logger' in this.zone ? this.zone.logger : config.log.mx)
                        };

                        connection = new SMTPConnection(options);
                        let returned = false;
                        let connected = false;

                        connection.once('error', err => {
                            connection.connected = false;
                            if (returned) {
                                return;
                            }
                            returned = true;
                            if (err.code === 'ETLS') {
                                // STARTTLS failed, try again, this time without encryption
                                log.info('Sender/' + this.zone.name + '/' + process.pid, 'Failed to connect to %s[%s] using STARTTLS, proceeding with plaintext', exchange.exchange, ip);
                                this.zone.disableStarttls = true;
                                return tryConnectIP(true);
                            }
                            if (!connected) {
                                // try next host
                                if (mxTry >= exchanges.length) {
                                    log.info('Sender/' + this.zone.name + '/' + process.pid, 'Failed to connect to %s[%s] for %s from %s (%s[%s])', exchange.exchange, ip, domain, this.zone.name, zoneAddress.name, zoneAddress.address);
                                }
                                return tryConnectIP();
                            }

                            log.error('Sender/' + this.zone.name + '/' + process.pid, 'Unexpected MX error');
                            log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                        });

                        connection.once('end', () => {
                            connection.connected = false;
                        });

                        connection.connect(() => {
                            if (returned) {
                                return;
                            }

                            let auth = next => {
                                if (this.zone.auth) {
                                    return connection.login(this.zone.auth, next);
                                }
                                next();
                            };

                            auth(err => {
                                if (returned) {
                                    return;
                                }

                                if (err) {
                                    connection.close();
                                    return callback(err);
                                }

                                connected = true;
                                connection.connected = true;

                                return callback(null, connection);
                            });
                        });
                    };

                    tryConnectIP();
                });
            };

            tryConnectMX();
        });
    }

    formatSMTPResponse(str) {
        let code = str.match(/^\d{3}[\s\-]+([\d\.]+\s*)?/);
        return ((code ? code[0] : '') + (code ? str.substr(code[0].length) : str).replace(/^\d{3}[\s\-]+([\d\.]+\s*)?/mg, ' ')).replace(/\s+/g, ' ').trim();
    }

    releaseDelivery(delivery, callback) {
        this.sendCommand({
            cmd: 'RELEASE',
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    deferDelivery(delivery, ttl, callback) {
        this.sendCommand({
            cmd: 'DEFER',
            id: delivery.id,
            seq: delivery.seq,
            _lock: delivery._lock,
            ttl
        }, (err, updated) => {
            if (err) {
                return callback(err);
            }
            callback(null, updated);
        });
    }

    signMessage(delivery) {
        if (!delivery.dkim) {
            return;
        }
        [].concat(delivery.dkim.keys || []).reverse().forEach(key => {
            let dkimHeader;
            dkimHeader = dkimSign.sign(delivery.headers, delivery.dkim.hashAlgo, delivery.dkim.bodyHash, key);
            if (dkimHeader) {
                delivery.headers.addFormatted('dkim-signature', dkimHeader);
            }
        });
    }

    sendBounceMessage(delivery, bounce, smtpResponse) {
        if (!delivery.from) {
            // nowhere to send the bounce to
            return;
        }

        if (delivery.headers.get('Received').length > 25) {
            // too many hops
            log.info('Bounce', 'Too many hops (%s)! Delivery loop detected for %s.%s %s, dropping message', delivery.headers.get('Received').length, delivery.seq, delivery.id, delivery.messageId);
            return;
        }

        this.sendCommand({
            cmd: 'BOUNCE',
            id: delivery.id,

            from: delivery.from,
            to: delivery.to,
            seq: delivery.seq,
            headers: delivery.headers.getList(),

            returnPath: delivery.from,
            category: bounce.category,
            time: Date.now(),
            response: smtpResponse
        }, err => {
            if (err) {
                this.close();
                this.emit('error', err);
                log.error('Sender/' + this.zone.name + '/' + process.pid, err.message);
                return;
            }
        });
    }
}

module.exports = Sender;
