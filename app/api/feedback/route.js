const { toNextHandler } = require('../../../lib/adapt-vercel-handler');
const legacyHandler = require('../../../lib/legacy-handlers/feedback');

module.exports = toNextHandler(legacyHandler, {
  methods: ['POST'],
  rawBody: true,
});
