const { toNextHandler } = require('../../../lib/adapt-vercel-handler');
const legacyHandler = require('../../../lib/legacy-handlers/booking');

module.exports = toNextHandler(legacyHandler, { methods: ['GET'] });
