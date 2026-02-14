const crypto = require('crypto')

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

const [privateKeyPath, productCode, expiresAt, customer = 'Customer'] = process.argv.slice(2)
if (!privateKeyPath || !productCode || !expiresAt) {
  console.error('Usage: node scripts/generate-license-code.js <privateKeyPemPath> <productCode> <expiresAtISO> [customer]')
  process.exit(1)
}

const fs = require('fs')
const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8')

const payload = {
  licenseId: crypto.randomUUID(),
  productCode,
  expiresAt,
  customer,
  issuedAt: new Date().toISOString(),
  features: ['core']
}

const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
const signature = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem)
const code = `${payloadB64}.${toBase64Url(signature)}`

console.log(code)
