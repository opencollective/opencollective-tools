const prompt = require('prompt');

const addSharedOptionsToProgram = (program) => {
  program.option('--run', 'Disables the dry mode.');
  program.option('--yubikey', 'To use a Yubikey for 2FA instead of TOPT.');
};

const get2FAHeadersFromPrompt = async (options) => {
  const tfaPrompt = await prompt.get({ name: 'code', description: options.yubikey ? 'Tap your YubiKey' : '2FA Code' });
  const twoFactorPrefix = options.yubikey ? 'yubikey_otp' : 'totp';
  return {
    'x-two-factor-authentication': `${twoFactorPrefix} ${tfaPrompt.code}`,
  };
};

module.exports = {
  addSharedOptionsToProgram,
  get2FAHeadersFromPrompt,
};
