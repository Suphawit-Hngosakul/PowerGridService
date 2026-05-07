'use strict';

require('dotenv').config();
const { createApp } = require('./app');

const port = Number(process.env.API_PORT || 3000);
createApp().listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
