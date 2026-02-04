// test-serial.js
const { SerialPort } = require('serialport')

async function test() {
  try {
    console.log('Testing serialport...')
    const ports = await SerialPort.list()
    console.log('Found ports:', ports.map(p => p.path))
  } catch (error) {
    console.error('Error:', error.message)
  }
}

test()