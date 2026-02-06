// collect-complete-message.js
const { SerialPort } = require('serialport');

const port = new SerialPort({
  path: '/dev/ttyUSB0',
  baudRate: 1200,    // Use 1200 baud based on your test
  dataBits: 7,
  stopBits: 1,
  parity: 'none'
});

console.log('🔄 Collecting complete message byte-by-byte\n');
console.log('Press PRINT button multiple times');
console.log('I will collect bytes until message is complete\n');

let byteBuffer = [];
let lastByteTime = Date.now();
const FRAME_TIMEOUT = 100; // ms between bytes to consider frame complete

port.on('open', () => {
  console.log('✅ Connected at 1200 baud, 7N1');
  console.log('Start pressing PRINT button...\n');
});

port.on('data', (data) => {
  const bytes = Array.from(data);
  const now = Date.now();
  
  // If too much time passed since last byte, start new frame
  if (now - lastByteTime > FRAME_TIMEOUT && byteBuffer.length > 0) {
    processFrame(byteBuffer);
    byteBuffer = [];
  }
  
  // Add new bytes to buffer
  byteBuffer.push(...bytes);
  lastByteTime = now;
  
  // Also process if buffer gets too large
  if (byteBuffer.length > 20) {
    processFrame(byteBuffer);
    byteBuffer = [];
  }
});

function processFrame(bytes) {
  if (bytes.length === 0) return;
  
  console.log('\n' + '='.repeat(60));
  console.log(`📦 FRAME: ${bytes.length} bytes`);
  console.log('Hex:', bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));
  console.log('Dec:', bytes.join(' '));
  
  // Try ASCII interpretation
  const ascii = bytes.map(b => 
    (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.'
  ).join('');
  console.log('ASCII:', ascii);
  
  // Analyze the frame
  analyzeFrame(bytes);
  
  console.log('='.repeat(60));
}

function analyzeFrame(bytes) {
  console.log('\n🔍 ANALYSIS:');
  
  // Check for common patterns
  
  // 1. Look for STX (0x02) and ETX (0x03) markers
  const stxIndex = bytes.indexOf(0x02);
  const etxIndex = bytes.indexOf(0x03);
  
  if (stxIndex !== -1) {
    console.log(`• STX at position ${stxIndex} (start of message)`);
  }
  if (etxIndex !== -1) {
    console.log(`• ETX at position ${etxIndex} (end of message)`);
  }
  
  // 2. Look for 0x4B pattern (your common byte)
  const kbPositions = [];
  bytes.forEach((b, i) => {
    if (b === 0x4B) kbPositions.push(i);
  });
  if (kbPositions.length > 0) {
    console.log(`• 0x4B found at positions: ${kbPositions.join(', ')}`);
  }
  
  // 3. Look for weight data
  // Weight is likely in bytes after 0x4B
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x4B && i + 1 < bytes.length) {
      const weightByte = bytes[i + 1];
      console.log(`• Possible weight byte after 0x4B: ${weightByte} (0x${weightByte.toString(16)})`);
      
      // Try different interpretations
      console.log('  Possible weights:');
      console.log(`    Direct: ${weightByte} kg`);
      console.log(`    /10: ${(weightByte/10).toFixed(1)} kg`);
      console.log(`    /2: ${(weightByte/2).toFixed(1)} kg`);
      console.log(`    -38: ${weightByte - 38} kg`);
      console.log(`    -64: ${weightByte - 64} kg`);
    }
  }
  
  // 4. Look for BCD encoding
  if (bytes.length >= 4) {
    let bcdDigits = '';
    bytes.forEach(byte => {
      const high = (byte >> 4) & 0x0F;
      const low = byte & 0x0F;
      if (high <= 9) bcdDigits += high;
      if (low <= 9) bcdDigits += low;
    });
    
    if (bcdDigits.length >= 4) {
      console.log(`• BCD digits found: ${bcdDigits}`);
      console.log(`  As weight: ${parseInt(bcdDigits)/1000} kg (assuming 3 decimal)`);
    }
  }
  
  // 5. Check for status bits
  if (bytes.length > 0) {
    const firstByte = bytes[0];
    console.log(`• First byte ${firstByte} (0x${firstByte.toString(16)}) binary: ${firstByte.toString(2).padStart(8, '0')}`);
    console.log(`  Bit 7 (0x80): ${(firstByte & 0x80) ? '1' : '0'} ${(firstByte & 0x80) ? '(Negative?)' : '(Positive?)'}`);
    console.log(`  Bit 6 (0x40): ${(firstByte & 0x40) ? '1' : '0'} ${(firstByte & 0x40) ? '(Overload?)' : ''}`);
    console.log(`  Bit 5 (0x20): ${(firstByte & 0x20) ? '1' : '0'} ${(firstByte & 0x20) ? '(Unstable?)' : '(Stable?)'}`);
    console.log(`  Bit 4 (0x10): ${(firstByte & 0x10) ? '1' : '0'} ${(firstByte & 0x10) ? '(Decimal?)' : ''}`);
  }
}

// Also process buffer every 500ms in case of incomplete frames
setInterval(() => {
  if (byteBuffer.length > 0) {
    processFrame(byteBuffer);
    byteBuffer = [];
  }
}, 500);

port.on('error', console.error);

process.on('SIGINT', () => {
  console.log('\nExiting...');
  port.close();
  process.exit();
});