'use strict';

const serverless = require('serverless-http');
const { createApp } = require('./app');

const app = createApp();
module.exports.handler = serverless(app, { basePath: '/v1' });
