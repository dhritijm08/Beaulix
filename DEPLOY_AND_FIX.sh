#!/bin/bash
# Beaulix - Deploy fix script
# Run this from the Beaulix/ project root directory
set -e

echo "=== Step 1: Verify lint is clean ==="
cd functions
npm install
npx eslint index.js
echo "✓ Lint passed"
cd ..

echo ""
echo "=== Step 2: Deploy functions and hosting ==="
firebase deploy
echo "✓ Deploy complete"

echo ""
echo "=== Step 3: Verify CORS on getGpuUrl ==="
echo "Testing OPTIONS preflight..."
RESPONSE=$(curl -si -X OPTIONS \
  "https://us-central1-beaulix-model.cloudfunctions.net/getGpuUrl" \
  -H "Origin: https://beaulix-model.web.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,authorization" 2>&1)

echo "$RESPONSE" | grep -E "HTTP|Access-Control"

if echo "$RESPONSE" | grep -q "Access-Control-Allow-Origin"; then
  echo "✓ CORS is working!"
else
  echo ""
  echo "✗ CORS headers missing - Cloud Run IAM needs fixing."
  echo "Running IAM fix..."
  gcloud run services add-iam-policy-binding getgpuurl \
    --region=us-central1 \
    --member="allUsers" \
    --role="roles/run.invoker"
  echo "✓ IAM fixed. Refresh the page."
fi
