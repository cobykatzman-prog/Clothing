'use strict';
// POST /api/generate  JSON {prompt, refs[], view} -> {fallback, image}
// Uses OpenAI images/generations (no refs) or images/edits with refs as extra input images.
const { handle, runGenerate } = require('./_lib');

module.exports = (req, res) => handle(req, res, { run: runGenerate, allowStatus: false });
module.exports.config = { maxDuration: 60 };
