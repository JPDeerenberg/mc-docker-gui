'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { readContainerFile, writeContainerFile } = require('../services/docker');

// Read file
router.get('/:id/file', auth, async (req, res) => {
  const { path: fp } = req.query;
  if (!fp) {
    return res.status(400).json({ error: 'path required' });
  }
  try {
    const content = await readContainerFile(req.params.id, fp);
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write file
router.put('/:id/file', auth, async (req, res) => {
  const { path: fp, content } = req.body;
  if (!fp || content === undefined) {
    return res.status(400).json({ error: 'path and content required' });
  }
  try {
    await writeContainerFile(req.params.id, fp, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
