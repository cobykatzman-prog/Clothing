'use strict';
// POST /api/edit      JSON {image, mask|null, prompt, refs[], view, ops} (data URLs) -> {fallback, variations[]}
// GET  /api/edit?status=1  -> {available, provider}
// Env: OPENAI_API_KEY (required for AI), OPENAI_IMAGE_QUALITY (low|medium|high, default medium).
// REPLICATE_API_TOKEN: TODO - alternative provider not implemented (reported as unavailable).
const { handle, runEdit } = require('./_lib');

module.exports = (req, res) => handle(req, res, { run: runEdit, allowStatus: true });
module.exports.config = { maxDuration: 60 };
