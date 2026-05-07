'use strict';

require('dotenv').config();
const { detect } = require('./handler');
const { shutdown } = require('@powergrid/db');

detect()
  .then((res) => { console.log('[detect] done', res); return shutdown(); })
  .catch(async (err) => { console.error(err); await shutdown(); process.exit(1); });
