const fs = require('fs');
const path = require('path');

const debug = require('debug');
const dotenv = require('dotenv');
const lodash = require('lodash');

// Load extra env file on demand
// e.g. `npm run dev production` -> `.env.production`
const extraEnv = process.env.EXTRA_ENV || lodash.last(process.argv);
const extraEnvPath = path.join(__dirname, `.env.${extraEnv}`);
if (fs.existsSync(extraEnvPath)) {
  dotenv.config({ path: extraEnvPath });
}

dotenv.config();
debug.enable(process.env.DEBUG);

const defaults = {
  NODE_ENV: 'development',
  API_KEY: '723839d669cbbe019cfce6a2c2e229371fc5b280',
  API_URL: 'https://api.opencollective.com',
  OC_APPLICATION: 'tools',
  OC_ENV: process.env.NODE_ENV || 'development',
};

for (const key in defaults) {
  if (process.env[key] === undefined) {
    process.env[key] = defaults[key];
  }
}
