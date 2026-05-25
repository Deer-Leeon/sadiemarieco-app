const { toNextHandler } = require('../../../lib/adapt-vercel-handler');
const legacyHandler = require('../../../lib/legacy-handlers/cancel-booking');

module.exports = toNextHandler(legacyHandler, { methods: ['POST'] });
