const express = require('express');
const { analyzeMarket } = require('../services/scannerService');

const router = express.Router();

router.post('/', async (request, response) => {
  try {
    const results = await analyzeMarket(request.body);
    response.json(results);
  } catch (error) {
    console.error('Analyze request failed', error);
    response.status(500).json({
      message: 'סריקת השוק נכשלה'
    });
  }
});

module.exports = router;