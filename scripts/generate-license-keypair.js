const crypto = require('crypto')

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')

console.log('PUBLIC_KEY_PEM_START')
console.log(publicKey.export({ type: 'spki', format: 'pem' }))
console.log('PUBLIC_KEY_PEM_END')

console.log('PRIVATE_KEY_PEM_START')
console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }))
console.log('PRIVATE_KEY_PEM_END')
