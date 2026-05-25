const { toNextHandler } = require('../../../lib/adapt-vercel-handler');
const legacyHandler = require('../../../lib/legacy-handlers/webhook');

module.exports = toNextHandler(legacyHandler, { methods: ['POST'] });
