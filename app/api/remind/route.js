const { toNextHandler } = require('../../../lib/adapt-vercel-handler');
const legacyHandler = require('../../../lib/legacy-handlers/remind');

module.exports = toNextHandler(legacyHandler, {
  methods: ['POST'],
  rawBody: true,
});
