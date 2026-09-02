const prompt = require('prompt');
const { request } = require('graphql-request');
const { pRateLimit } = require('p-ratelimit');

const addSharedOptionsToProgram = (program) => {
  program.option('--run', 'Disables the dry mode.');
  program.option('--yubikey', 'To use a Yubikey for 2FA instead of TOTP.');
};

const get2FAHeadersFromPrompt = async (options) => {
  const tfaPrompt = await prompt.get({ name: 'code', description: options.yubikey ? 'Tap your YubiKey' : '2FA Code' });
  const twoFactorPrefix = options.yubikey ? 'yubikey_otp' : 'totp';
  return {
    'x-two-factor-authentication': `${twoFactorPrefix} ${tfaPrompt.code}`,
  };
};

const rateLimiter = pRateLimit({
  interval: 60 * 1000, // 1 minute
  rate: 60, // 60 calls per interval
});

const rateLimitedRequest = (endpoint, query, variables, headers) => {
  return rateLimiter(() => request(endpoint, query, variables, headers));
};

/**
 * Parse balance string like "$37.80" or "$1,175.13" to cents
 */
const parseBalanceToCents = (balanceStr) => {
  if (!balanceStr) return 0;
  const cleaned = balanceStr.replace(/[$,]/g, '');
  return Math.round(parseFloat(cleaned) * 100);
};

/**
 * Extract slug from Open Collective URL
 * e.g., "https://opencollective.com/actuallycolab" -> "actuallycolab"
 * e.g., "https://opencollective.com/ecosystem-funds/projects/oc-python-fund" -> "oc-python-fund"
 */
const extractSlugFromUrl = (url) => {
  if (!url) return null;
  const match = url.match(/opencollective\.com\/(?:.*\/)?([^/]+)\/?$/);
  return match ? match[1] : null;
};

module.exports = {
  addSharedOptionsToProgram,
  get2FAHeadersFromPrompt,
  rateLimitedRequest,
  parseBalanceToCents,
  extractSlugFromUrl,
};
